// Auto-generated from the live workflow node "Aggregate Jobs" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Aggregate Jobs v9 — composite-key dedup (S2d) + tier-aware ordering
// Changes vs v8:
//   - Dedup by canonical apply-URL OR lowercased company+title, so the SAME job
//     surfaced by different sources (RemoteOK url vs Adzuna url vs web) collapses to one.
//   - On a collision, KEEP the lower source_tier (structured/ATS preferred over web),
//     and backfill salary + location onto the kept job from the dropped duplicate.
//   - (v8 carried over) tier-aware sort, Tier 3+ dropped, tier_counts for display.

// Recruiting aggregators that post on real ATSes (so they classify Tier 1) but are
// not the employer — demote to Tier 3 so the existing tier filter drops them.
const AGGREGATORS = new Set(['jobgether','weekdayworks','weekday','cutshort','instahyre','crossover','turing','braintrust','toptal','uplers','remotebase','hirist','talentprise']);
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
    if (AGGREGATORS.has((job.company || '').toLowerCase())) { job.source_tier = 3; job.tier_label = 'aggregator'; }
    const ks = dedupKeys(job);
    let existing = null;
    for (const k of ks) { if (byKey.has(k)) { existing = byKey.get(k); break; } }
    if (!existing) { for (const k of ks) byKey.set(k, job); continue; }
    // collision: keep lower tier; backfill salary/location from the dropped dup
    const curTier = existing.source_tier || 99;
    const newTier = job.source_tier || 99;
    const keep = newTier < curTier ? job : existing;
    const drop = newTier < curTier ? existing : job;
    if (!keep.salary_min && drop.salary_min) { keep.salary_min = drop.salary_min; keep.salary_max = drop.salary_max; keep.salary_currency = drop.salary_currency; }
    if ((!keep.location || keep.location === 'unknown') && drop.location && drop.location !== 'unknown') keep.location = drop.location;
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

// WS3: cohort-scoped search -- keep only jobs whose company fuzzy-matches the
// LLM-named target list (normalize case/punct; substring match both ways so
// "JPMorgan Chase & Co." matches target "JPMorgan").
const targetCompanies = expandCtx.target_companies || [];
if (targetCompanies.length) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const targets = targetCompanies.map(norm).filter(Boolean);
  filtered = filtered.filter((j) => {
    const c = norm(j.company);
    if (!c) return false;
    return targets.some((t) => c.includes(t) || t.includes(c));
  });
}

// Drop Tier 3 aggregators and Tier 4 unknown pages from the main ranked results.
filtered = filtered.filter(j => (j.source_tier || 4) < 3);

// Role family filter -- F2: word-boundary matching for every term length.
// Terms >3 chars used to fall back to plain haystack.includes(term), so
// "AI Engineering Intern" matched role family "AI Engineer" via the substring
// "engineer" inside "engineering". Word-boundary regex everywhere now, same
// as excluded_roles already correctly did.
function escapeRegexTerm(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
if (roleFamilies.length > 0) {
  filtered = filtered.filter(j => {
    const haystack = (j.title + ' ' + (j.department || '')).toLowerCase();
    if (excludedRoles.some(excl => {
      const terms = excl.toLowerCase().split(/\s+/);
      return terms.every(t => new RegExp('\\b' + escapeRegexTerm(t) + '\\b').test(haystack));
    })) return false;
    return roleFamilies.some(variant => {
      const terms = variant.toLowerCase().split(/\s+/).filter(t => t.length > 1);
      return terms.every(term => new RegExp('\\b' + escapeRegexTerm(term) + '\\b').test(haystack));
    });
  });
}

// Location filter -- F2: 3-state policy (match/mismatch/unknown), applied
// uniformly to every source. No lane bypass -- the old firecrawl/serper/youcom
// skip let 62-98% of digest results through with zero location enforcement.
// Country-level fallback (city/country name recognition) covers broad queries
// where location_canonical is null but country is a real signal. Deliberately
// non-exhaustive -- anything unrecognized falls to 'unknown' (kept, demoted,
// badged), never a guessed drop.
const COUNTRY_NAMES = {
  US: ['usa','u.s.a','u.s.','united states','america'],
  IN: ['india'],
  GB: ['uk','u.k.','united kingdom','britain','england','scotland','wales'],
  CA: ['canada'],
  AU: ['australia'],
  DE: ['germany','deutschland'],
  SG: ['singapore'],
  AE: ['uae','united arab emirates','dubai','abu dhabi'],
  NL: ['netherlands','holland'],
  FR: ['france'],
  IE: ['ireland'],
  NZ: ['new zealand'],
};
const CITY_COUNTRY = {
  'new york':'US','san francisco':'US','seattle':'US','austin':'US','boston':'US',
  'chicago':'US','los angeles':'US','san jose':'US','denver':'US','atlanta':'US',
  'dallas':'US','houston':'US','washington':'US','miami':'US','portland':'US',
  'hyderabad':'IN','bangalore':'IN','bengaluru':'IN','mumbai':'IN','pune':'IN',
  'delhi':'IN','new delhi':'IN','gurgaon':'IN','gurugram':'IN','chennai':'IN',
  'noida':'IN','kolkata':'IN','ahmedabad':'IN',
  'london':'GB','manchester':'GB','edinburgh':'GB','birmingham':'GB',
  'toronto':'CA','vancouver':'CA','montreal':'CA','ottawa':'CA',
  'berlin':'DE','munich':'DE','frankfurt':'DE','hamburg':'DE',
  'singapore':'SG','dublin':'IE','amsterdam':'NL','paris':'FR','sydney':'AU','melbourne':'AU','auckland':'NZ',
};
function detectCountryFromLocation(hay) {
  for (const code of Object.keys(COUNTRY_NAMES)) { if (COUNTRY_NAMES[code].some(s => hay.includes(s))) return code; }
  for (const city of Object.keys(CITY_COUNTRY)) { if (hay.includes(city)) return CITY_COUNTRY[city]; }
  return null;
}
function checkLocationState(job, locTerms, countryCode) {
  const hay = (job.location || '').toLowerCase().trim();
  if (!hay || hay === 'unknown') return 'unknown';
  if (locTerms && locTerms.length) return locTerms.some(t => hay.includes(t)) ? 'match' : 'mismatch';
  if (countryCode) {
    const detected = detectCountryFromLocation(hay);
    if (!detected) return 'unknown';
    return detected === countryCode ? 'match' : 'mismatch';
  }
  return 'unknown';
}
const hasCityConstraint = locationCanon && !['any','anywhere','worldwide'].includes(locationCanon);
const locTerms = hasCityConstraint ? locationCanon.split(/[\s,]+/).filter(t => t.length > 1) : [];
// Country fallback only when there's no city-level signal AND the country isn't
// the silent "nothing stated" default (country always defaults to 'US' even on
// a totally generic query) -- avoids dropping results on unscoped searches.
const countryCode = (!locTerms.length && expandCtx.country && expandCtx.country !== 'US') ? expandCtx.country : null;
if (remotePref !== 'remote_only' && (locTerms.length || countryCode)) {
  filtered = filtered.filter(j => {
    const state = checkLocationState(j, locTerms, countryCode);
    j.location_verified = state === 'match' ? true : (state === 'unknown' ? null : false);
    return state !== 'mismatch';
  });
}

// Recency filter (soft)
filtered = filtered.filter(j => {
  if (!j.updated_at) return true;
  const t = new Date(j.updated_at).getTime();
  return isNaN(t) || t >= cutoff;
});

// Sort: verified-location first (only matters when location filtering was
// actually active -- location_verified is undefined on every job otherwise,
// making this a no-op), then tier, then recency within tier.
const _sortNewest = expandCtx.sort_by === 'newest';
filtered.sort((a, b) => {
  const locDiff = (a.location_verified === true ? 0 : 1) - (b.location_verified === true ? 0 : 1);
  if (locDiff !== 0) return locDiff;
  if (!_sortNewest) {
    const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);
    if (tierDiff !== 0) return tierDiff;
  }
  const ad = new Date(a.updated_at || 0).getTime() || 0;
  const bd = new Date(b.updated_at || 0).getTime() || 0;
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

const top = filtered.slice(0, 150);
return [{ json: {
  jobs: top, count: top.length, total_raw: allJobs.length,
  sources: sourceCounts, tier_counts: tierCounts,
  filter_applied: { role_families: roleFamilies, location: locationCanon || null, remote_preference: remotePref }
} }];
