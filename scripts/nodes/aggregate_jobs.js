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

// Location filter -- s96: 3-state policy (match/mismatch/unknown) upgraded
// from the tiny hand-curated geo_reference row to the local GeoNames
// gazetteer (data/reference/geonames_cities.json, 34k cities/252 countries,
// quality-ranked alternate names -- Bengaluru/Bangalore, New York/NYC,
// München/Munich all resolve to the same place now). Real bug this fixes:
// "US Remote" was invisible to the old detector (bare "US" was never a
// recognized alias, deliberately, to dodge false-positive substring
// matches) -- it fell to 'unknown' and was KEPT+ranked for an India search
// instead of correctly mismatching. Fail-open unchanged: if the gazetteer
// file can't be read, the whole filter no-ops for this run (same "never a
// guessed drop" policy as before, just at the file-read layer now).
let GAZETTEER = null;
try {
  const _fs = require('fs');
  const _g = JSON.parse(_fs.readFileSync('/home/node/.n8n-files/companies/reference/geonames_cities.json', 'utf8'));
  const _idx = {};
  for (const c of _g.cities) {
    const nms = new Set([c.n.toLowerCase(), c.a.toLowerCase(), ...c.alt.map((a) => a.toLowerCase())]);
    for (const nm of nms) { if (!_idx[nm]) _idx[nm] = []; _idx[nm].push(c); }
  }
  _g._cityIndex = _idx;
  GAZETTEER = _g;
} catch (e) { GAZETTEER = null; }

const REMOTE_RX = /\b(remote|wfh|work[\s-]?from[\s-]?home|telecommut\w*)\b/i;
const GLOBAL_RX = /\b(worldwide|global|anywhere|any\s*location)\b/i;
// A bare uppercase 2-letter token ("AI Engineer","IT Support") collides too
// often with real ISO codes (IT=Italy, AI=Anguilla, CA=California-not-Canada)
// to scan broadly -- narrowed to ONLY "<CODE> Remote"/"Remote (<CODE>)"
// adjacency, the actual failure mode ("US Remote" invisible to the old
// detector). Code stays case-SENSITIVE so lowercase "us"/"in" as ordinary
// words are never mistaken for a code; "remote" matches either case.
const CODE_REMOTE_RX = /\b([A-Z]{2})\b[\s-]*[Rr]emote\b|\b[Rr]emote\b[\s(:-]*\b([A-Z]{2})\b/;
const UPPER_CODE_EXTRA = { UK: 'GB' };

function candidatesForPart(part) {
  const trimmed = part.trim();
  const out = [trimmed];
  const fragments = trimmed.split(/[-:–—]/).map((f) => f.trim()).filter(Boolean);
  if (fragments.length > 1) out.push(...fragments.reverse());
  return out;
}
function resolveLocation(rawStr) {
  const s = String(rawStr || '').trim();
  if (!s) return { countries: [], cities: [], remote: false, global: false, unresolved: true };
  const remote = REMOTE_RX.test(s);
  const global = GLOBAL_RX.test(s);
  const countriesFound = new Set();
  const citiesFound = new Set();
  let anyResolved = false;

  const codeMatch = s.match(CODE_REMOTE_RX);
  if (codeMatch) {
    const code = codeMatch[1] || codeMatch[2];
    const iso = GAZETTEER.country_names[code] ? code : UPPER_CODE_EXTRA[code];
    if (iso) { countriesFound.add(iso); anyResolved = true; }
  }

  const segments = s.split(/[;|]|\s+or\s+/i).map((seg) => seg.replace(/[()]/g, '').trim()).filter(Boolean);
  for (const segment of segments) {
    const parts = segment.split(',').map((p) => p.trim()).filter(Boolean);
    let matchedCountry = null;
    for (const part of parts) {
      const partLower = part.toLowerCase();
      for (const [iso, aliases] of Object.entries(GAZETTEER.countries)) {
        if (aliases.includes(partLower)) { matchedCountry = iso; break; }
      }
      if (matchedCountry) break;
    }
    if (matchedCountry) { countriesFound.add(matchedCountry); anyResolved = true; }

    let cityHit = false;
    for (const part of parts) {
      if (cityHit) break;
      for (const cand of candidatesForPart(part)) {
        const list = GAZETTEER._cityIndex[cand.toLowerCase()];
        if (!list || !list.length) continue;
        let city = list[0];
        if (matchedCountry) { const sameCountry = list.find((c) => c.cc === matchedCountry); if (sameCountry) city = sameCountry; }
        citiesFound.add(city.n);
        countriesFound.add(city.cc);
        anyResolved = true;
        cityHit = true;
        break;
      }
    }
  }
  return { countries: [...countriesFound], cities: [...citiesFound], remote, global, unresolved: !anyResolved && !remote && !global };
}

// s75: a location_canonical that's really a sentence (e.g. a raw preference
// blurb that leaked through, or a future prompt-compliance slip) must never
// drive matching -- it matches nothing real and silently mismatches
// everything. Cheap sanity gate: a real canonical location is short and has
// no connector words.
function looksLikeCleanLocation(s) {
  const STOP = ['and','or','targeting','roles','role','the','for','based','remember'];
  const tokens = s.split(/[\s,]+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 8 && !tokens.some(t => STOP.includes(t.toLowerCase()));
}

// Resolve the REQUEST side once, through the same gazetteer the job side uses.
let requestCities = [];
let requestCountry = expandCtx.country || null;
if (GAZETTEER && locationCanon && looksLikeCleanLocation(locationCanon) && !['worldwide', 'anywhere', 'any'].includes(locationCanon)) {
  const reqGeo = resolveLocation(locationCanon);
  if (reqGeo.cities.length) requestCities = reqGeo.cities.map((c) => c.toLowerCase());
  if (!requestCountry && reqGeo.countries.length) requestCountry = reqGeo.countries[0];
}

function checkLocationState(job) {
  const hay = (job.location || '').toLowerCase().trim();
  if (!hay || hay === 'unknown') return 'unknown';
  const jobGeo = resolveLocation(job.location);
  if (jobGeo.unresolved) return 'unknown';
  if (jobGeo.global) return 'match';
  if (requestCities.length && jobGeo.cities.some((c) => requestCities.includes(c.toLowerCase()))) return 'match';
  if (requestCountry && jobGeo.countries.includes(requestCountry)) return 'match';
  // s96: a job confidently resolved to OTHER countries is a real mismatch
  // EVEN WHEN job.remote is true -- "US Remote" means remote WITHIN the US,
  // not remote everywhere. This is the exact Natera live-test bug fix.
  if (jobGeo.countries.length) return 'mismatch';
  if (jobGeo.remote) return 'unknown'; // genuinely no country stated at all -- honestly ambiguous, not a guessed match
  return 'unknown';
}

if (GAZETTEER && remotePref !== 'remote_only' && (requestCities.length || requestCountry)) {
  filtered = filtered.filter((j) => {
    const state = checkLocationState(j);
    j.location_verified = state === 'match' ? true : (state === 'unknown' ? null : false);
    return state !== 'mismatch';
  });
}

// Recency filter (soft). s83: cache rows are liveness-verified by the poller
// (status='active' = seen live within the poll interval; Close Stale Jobs
// retires the dead) -- a posted-date cutoff there throws away verified-live
// jobs (exec 582 dropped a still-live 2024 Netflix posting). Cache rows are
// exempt unless the user explicitly asked for a time window. Web lanes
// unchanged: an old web hit really is likely dead.
const freshnessExplicit = expandCtx.freshness_explicit === true;
filtered = filtered.filter(j => {
  if (j.source === 'cache' && !freshnessExplicit) return true;
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
const tierCounts = { 1: 0, '1.5': 0, 2: 0, '2.5': 0, 3: 0 };
for (const j of filtered) {
  const t = j.source_tier;
  if (t === 1) tierCounts[1]++;
  else if (t === 1.5) tierCounts['1.5']++;
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
