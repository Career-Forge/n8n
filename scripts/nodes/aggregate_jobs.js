// Aggregate Jobs v10 — composite-key dedup (S2d) + cache-first ordering (Phase 3).
// Changes vs v9:
//   - Dedup collision now prefers the CACHE copy on an equal-tier tie (source_priority),
//     and backfills rrf_score/source_priority from the dropped dup.
//   - Sort is cache-first: source_priority (cache=0) -> cache rrf_score -> tier -> recency,
//     so the cache's hybrid relevance survives instead of being flattened to tier+date.
//   - Recency uses posted_at when present (falls back to updated_at).

const sourceCounts = {};
const byKey = new Map(); // dedup key -> kept job (a job may be reachable by several keys)

function dedupKeys(job) {
  const ks = [];
  if (job.url) ks.push('u:' + job.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase());
  const ct = ((job.company || '') + '|' + (job.title || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  if (ct.replace(/\|/g, '').length > 4) ks.push('ct:' + ct);
  return ks;
}

for (const item of $input.all()) {
  const jobs = item.json.jobs || [];
  const source = item.json.source || 'unknown';
  sourceCounts[source] = (sourceCounts[source] || 0) + jobs.length;
  for (const job of jobs) {
    if (!job || !job.url) continue;
    const ks = dedupKeys(job);
    let existing = null;
    for (const k of ks) { if (byKey.has(k)) { existing = byKey.get(k); break; } }
    if (!existing) { for (const k of ks) byKey.set(k, job); continue; }
    // collision: keep lower tier; on an equal-tier tie keep the cache copy
    // (source_priority 0). Backfill salary/location/rrf from the dropped dup.
    const curTier = existing.source_tier || 99;
    const newTier = job.source_tier || 99;
    const curP = existing.source_priority ?? 1;
    const newP = job.source_priority ?? 1;
    const takeNew = newTier < curTier || (newTier === curTier && newP < curP);
    const keep = takeNew ? job : existing;
    const drop = takeNew ? existing : job;
    if (!keep.salary_min && drop.salary_min) { keep.salary_min = drop.salary_min; keep.salary_max = drop.salary_max; keep.salary_currency = drop.salary_currency; }
    if ((!keep.location || keep.location === 'unknown') && drop.location && drop.location !== 'unknown') keep.location = drop.location;
    if (!keep.rrf_score && drop.rrf_score) keep.rrf_score = drop.rrf_score;
    if (!keep.tier && drop.tier) keep.tier = drop.tier;
    if (keep.source_priority == null && drop.source_priority != null) keep.source_priority = drop.source_priority;
    for (const k of dedupKeys(existing)) byKey.set(k, keep);
    for (const k of ks) byKey.set(k, keep);
  }
}

const allJobs = Array.from(new Set(byKey.values()));

const expandCtx = $('Parse Expand Query').first().json;
const roleFamilies    = expandCtx.role_families    || [];
const excludedRoles   = expandCtx.excluded_roles   || [];
const locationCanon   = (expandCtx.location_canonical || '').trim().toLowerCase();
const remotePref      = expandCtx.remote_preference  || 'open';
const freshness       = expandCtx.freshness          || 'qdr:w';

const freshnessMs = { 'qdr:h': 3600000, 'qdr:d': 86400000, 'qdr:w': 604800000, 'qdr:m': 2592000000, 'qdr:y': 31536000000 }[freshness] || 604800000;
const cutoff = Date.now() - freshnessMs;

let filtered = allJobs;

// Drop Tier 3 aggregators and Tier 4 unknown pages from the main ranked results.
filtered = filtered.filter(j => (j.source_tier || 4) < 3);

// Drop intern/trainee/apprentice/hackathon roles regardless of source (web lanes
// bypass the cache prefilter, so the title guard must also run here).
filtered = filtered.filter(j => !/\b(intern(ship)?|trainee|apprentice|co-?op|hackathon)\b/i.test(j.title || ''));

// Drop WEB JUNK: aggregator listing pages ("300+ ML Engineer Jobs in Bengaluru"),
// pure job-board domains, and staffing/body-shop reposts. These come from the
// web-search lanes and are never real individual roles.
const AGG_HOST = /(^|\.)(bebee\.com|productbased\.in|ambitionbox\.com|jobsora\.|jooble\.|talent\.com|whatjobs\.|careerjet\.|jobrapido\.|neuvoo\.|trabajo\.|jobgether\.|expertia\.ai|hirist\.|cutshort\.|foundit\.|shine\.com|naukri\.com)/i;
const LISTING_TITLE = /(\d{2,}\+?\s+[\w\s/,&.+-]*\bjobs\b|\bjobs\s+in\s+[a-z]|\bjob\s+openings?\b)/i;
const STAFFING = /(smart[\s-]?working|wissen|collabera|diverse[\s-]?lynx|mindlance|nityo|sysmind|aptask|\bartech\b|teksystems|mastech|talent\s?500|jobgether|surely[\s-]?placed|kwan\s?ventures|staffing|consultancy\s+services|outsourc|manpower|randstad|kforce|infotech)/i;
filtered = filtered.filter(j => {
  let host = ''; try { host = new URL(j.url || '').hostname; } catch (e) {}
  if (AGG_HOST.test(host)) return false;
  if (LISTING_TITLE.test(j.title || '')) return false;
  const hay = ((j.company || '') + ' ' + (j.title || '') + ' ' + (j.url || '')).toLowerCase();
  if (STAFFING.test(hay)) return false;
  return true;
});

// Role family filter
if (roleFamilies.length > 0) {
  filtered = filtered.filter(j => {
    const haystack = (j.title + ' ' + (j.department || '')).toLowerCase();
    if (excludedRoles.some(excl => {
      const terms = excl.toLowerCase().split(/\s+/);
      return terms.every(t => new RegExp('\\b' + t + '\\b').test(haystack));
    })) return false;
    return roleFamilies.some(variant => {
      const terms = variant.toLowerCase().split(/\s+/).filter(t => t.length > 1);
      return terms.every(term => term.length <= 3
        ? new RegExp('\\b' + term + '\\b').test(haystack)
        : haystack.includes(term));
    });
  });
}

// Location filter (binds on ALL sources, incl. web; synonym + region aware).
// city/region synonyms + country roll-ups so "Bangalore" matches "Bengaluru,
// Karnataka, IND" and "India" matches Indian cities / ", IND".
const LOC_SYN = {
  'bangalore': ['bangalore','bengaluru','karnataka'],
  'bengaluru': ['bangalore','bengaluru','karnataka'],
  'new york':  ['new york','nyc','new york city','manhattan','brooklyn'],
  'nyc':       ['new york','nyc','new york city','manhattan','brooklyn'],
  'sf':        ['san francisco','bay area'],
  'san francisco': ['san francisco','bay area'],
  'bay area':  ['san francisco','bay area','san jose','palo alto','mountain view'],
  'hyderabad': ['hyderabad','telangana'],
  'mumbai':    ['mumbai','maharashtra'],
  'pune':      ['pune','maharashtra'],
  'delhi':     ['delhi','ncr','gurgaon','gurugram','noida'],
  'chennai':   ['chennai','tamil nadu'],
  'london':    ['london','united kingdom'],
  'india':     ['india',', ind','bengaluru','bangalore','hyderabad','mumbai','delhi','pune','chennai','noida','gurgaon','gurugram','karnataka','maharashtra','telangana','tamil nadu'],
};
function locTermsFor(canon) {
  const c = (canon || '').toLowerCase().trim();
  if (!c || ['any','anywhere','worldwide','global','remote'].includes(c)) return null;
  if (LOC_SYN[c]) return LOC_SYN[c];
  const city = c.split(',')[0].trim();
  if (LOC_SYN[city]) return LOC_SYN[city];
  return c.split(/[\s,]+/).filter(t => t.length > 2);
}
// country roll-up: a city implies its country, so a remote-in-country role still fits.
const LOC_COUNTRY = {
  'bangalore':'india','bengaluru':'india','hyderabad':'india','mumbai':'india','pune':'india','delhi':'india','chennai':'india','india':'india',
  'new york':'united states','nyc':'united states','sf':'united states','san francisco':'united states','bay area':'united states',
  'london':'united kingdom',
};
function countryFor(canon){ const c=(canon||'').toLowerCase().trim(); return LOC_COUNTRY[c] || LOC_COUNTRY[c.split(',')[0].trim()] || null; }
// "Remote" with no other place named = global/unqualified (fits any location search).
// "Remote - US" / "Remote, Ireland" names another place -> must match the request.
function isBareRemote(loc){
  return /\bremote\b/.test(loc) &&
    loc.replace(/\bremote\b/g,'').replace(/\b(work\s*from\s*home|wfh|anywhere|global|fully|hybrid|first|friendly|ok|only|optional|based)\b/g,'').replace(/[^a-z]/g,'').length === 0;
}
const wantLoc = (remotePref !== 'remote_only') ? locTermsFor(locationCanon) : null;
const wantCountry = wantLoc ? countryFor(locationCanon) : null;
if (wantLoc) {
  filtered = filtered.filter(j => {
    const loc = (j.location || '').toLowerCase();
    const lt = loc + ' ' + (j.title || '').toLowerCase();    // location + title (JD is too noisy for geo)
    if (wantLoc.some(t => lt.includes(t))) return true;                  // in the requested city/region
    if (wantCountry && lt.includes(wantCountry)) return true;            // remote/onsite in the requested country
    if (isBareRemote(loc)) return true;                                  // "Remote" with no other place named
    if (!loc.trim() && /\bremote\b/.test(lt)) return true;               // empty location + remote-in-title = global remote
    return false;                                                        // wrong place ("Remote - US") or no evidence -> drop
  });
}

// Recency filter (soft) — prefer posted_at, fall back to updated_at
filtered = filtered.filter(j => {
  const d = j.posted_at || j.updated_at;
  if (!d) return true;
  const t = new Date(d).getTime();
  return isNaN(t) || t >= cutoff;
});

// Cache-first sort: cache (source_priority 0) leads, ordered by its hybrid rrf
// relevance; then tier; then recency. Web fills the tail.
filtered.sort((a, b) => {
  const pa = a.source_priority ?? 1, pb = b.source_priority ?? 1;
  if (pa !== pb) return pa - pb;
  if (pa === 0) {
    const ra = a.rrf_score || 0, rb = b.rrf_score || 0;
    if (rb !== ra) return rb - ra;
  }
  const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);
  if (tierDiff !== 0) return tierDiff;
  const ad = new Date(a.posted_at || a.updated_at || 0).getTime() || 0;
  const bd = new Date(b.posted_at || b.updated_at || 0).getTime() || 0;
  return bd - ad;
});

// Tier composition for downstream display
const tierCounts = { 1: 0, 2: 0, '2.5': 0, 3: 0 };
for (const j of filtered) {
  const t = j.source_tier;
  if (t === 1) tierCounts[1]++;
  else if (t === 2) tierCounts[2]++;
  else if (t === 2.5) tierCounts['2.5']++;
  else if (t === 3) tierCounts[3]++;
}

const top = filtered.slice(0, 50);
return [{ json: {
  jobs: top, count: top.length, total_raw: allJobs.length,
  sources: sourceCounts, tier_counts: tierCounts,
  filter_applied: { role_families: roleFamilies, location: locationCanon || null, remote_preference: remotePref }
} }];
