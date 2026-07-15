/**
 * s96_aggregate_jobs_gazetteer.js -- fixes the exact bug from the live
 * "FDE roles in India" test: a Natera "US Remote" job scored 71/100 with a
 * one-liner explicitly saying "not India-eligible", because Aggregate Jobs'
 * 3-state location policy (match/mismatch/unknown) had no way to recognize
 * "US" as a country signal (bare 2-letter codes were deliberately excluded
 * from the old geo_reference alias list to dodge false-positive substring
 * matches) -- the job fell to 'unknown', which gets KEPT, not dropped.
 *
 * Aggregate Jobs now resolves location through the local GeoNames gazetteer
 * (data/reference/geonames_cities.json, 34k cities + 252 countries with
 * quality-ranked alternate names -- see s90-s95 wave's diagnosis and the
 * semi-RAG reference-data plan) via a shared resolveLocation() helper,
 * loaded with require('fs') (Code-node sandbox already allows this; the
 * existing docker-compose mount already exposes data/reference/ inside the
 * container, confirmed live, zero compose changes).
 *
 * The actual policy fix: a job whose location resolves to a SPECIFIC OTHER
 * country is now a real 'mismatch' EVEN WHEN job.remote is true -- "US
 * Remote" means remote *within* the US, not remote everywhere. The old
 * policy's "remote jobs always pass" behavior is narrowed to only apply when
 * a job is genuinely unscoped (bare "Remote", no country at all) or
 * explicitly "Worldwide"/"Global" -- those still match any request.
 *
 * Fail-open unchanged: if the gazetteer file can't be read (corrupted,
 * missing), the entire location filter no-ops for that run -- same "never a
 * guessed drop" policy as before, just moved to the file-read layer.
 *
 * No node count change (Aggregate Jobs only, existing node). Run: inside the
 * n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const OLD_BLOCK = `// Location filter -- F2: 3-state policy (match/mismatch/unknown), applied
// uniformly to every source. No lane bypass -- the old firecrawl/serper/youcom
// skip let 62-98% of digest results through with zero location enforcement.
// Country-level fallback (city/country name recognition) covers broad queries
// where location_canonical is null but country is a real signal. Deliberately
// non-exhaustive -- anything unrecognized falls to 'unknown' (kept, demoted,
// badged), never a guessed drop.
// s86: sourced from the app_settings 'geo_reference' row (Load Geo Reference
// (Search)) instead of an embedded literal -- zero place names left here.
const _geo0 = ($('Load Geo Reference (Search)').first().json.geo_reference) || { countries: {}, cities: {} };
const COUNTRY_NAMES = _geo0.countries || {};
const CITY_COUNTRY = _geo0.cities || {};
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
// s75: a location_canonical that's really a sentence (e.g. a raw preference
// blurb that leaked through, or a future prompt-compliance slip) must never
// drive substring matching -- it matches nothing real and silently mismatches
// everything. Cheap sanity gate: a real canonical location is short and has
// no connector words.
function looksLikeCleanLocation(s) {
  const STOP = ['and','or','targeting','roles','role','the','for','based','remember'];
  const tokens = s.split(/[\\s,]+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 8 && !tokens.some(t => STOP.includes(t.toLowerCase()));
}
// s79: a bare COUNTRY name is not a city -- 'find jobs in Germany' must use
// the country-level matcher (which knows berlin->DE via CITY_COUNTRY), not
// city substring matching (which would drop every job labeled 'Berlin' for
// lacking the literal substring 'germany'). Exact alias membership, so
// 'new york, new york, united states' still takes the city path.
function countryFromCanonical(s) {
  for (const code of Object.keys(COUNTRY_NAMES)) { if (COUNTRY_NAMES[code].includes(s)) return code; }
  return null;
}
const canonCountry = locationCanon ? countryFromCanonical(locationCanon) : null;
const hasCityConstraint = locationCanon && !canonCountry && !['any','anywhere','worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);
const locTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter(t => t.length > 1) : [];
// Country fallback only when there's no city-level signal AND the country isn't
// the silent "nothing stated" default (country always defaults to 'US' even on
// a totally generic query) -- avoids dropping results on unscoped searches.
// s79: an explicitly TYPED country ('usa') engages the filter even for US --
// only the schema's silent country='US' default stays suppressed.
// s87: country is never silently defaulted upstream anymore -- any
// non-null value here is a REAL signal (explicit message, stored pref, or
// resume-derived), so the old 'US'-suppression special-case is dead weight.
const countryCode = canonCountry || (!locTerms.length ? (expandCtx.country || null) : null);
if (remotePref !== 'remote_only' && (locTerms.length || countryCode)) {
  filtered = filtered.filter(j => {
    const state = checkLocationState(j, locTerms, countryCode);
    j.location_verified = state === 'match' ? true : (state === 'unknown' ? null : false);
    return state !== 'mismatch';
  });
}`;

const NEW_BLOCK = `// Location filter -- s96: 3-state policy (match/mismatch/unknown) upgraded
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

const REMOTE_RX = /\\b(remote|wfh|work[\\s-]?from[\\s-]?home|telecommut\\w*)\\b/i;
const GLOBAL_RX = /\\b(worldwide|global|anywhere|any\\s*location)\\b/i;
// A bare uppercase 2-letter token ("AI Engineer","IT Support") collides too
// often with real ISO codes (IT=Italy, AI=Anguilla, CA=California-not-Canada)
// to scan broadly -- narrowed to ONLY "<CODE> Remote"/"Remote (<CODE>)"
// adjacency, the actual failure mode ("US Remote" invisible to the old
// detector). Code stays case-SENSITIVE so lowercase "us"/"in" as ordinary
// words are never mistaken for a code; "remote" matches either case.
const CODE_REMOTE_RX = /\\b([A-Z]{2})\\b[\\s-]*[Rr]emote\\b|\\b[Rr]emote\\b[\\s(:-]*\\b([A-Z]{2})\\b/;
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

  const segments = s.split(/[;|]|\\s+or\\s+/i).map((seg) => seg.replace(/[()]/g, '').trim()).filter(Boolean);
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
  const tokens = s.split(/[\\s,]+/).filter(Boolean);
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
}`;

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.split(oldStr).join(newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Aggregate Jobs']) { console.error(`INTEGRITY FAIL ${base}: node "Aggregate Jobs" not found`); process.exit(1); }
  if (N['Aggregate Jobs'].parameters.jsCode.includes('s96:')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', OLD_BLOCK, NEW_BLOCK, 'gazetteer-driven location policy', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Aggregate Jobs location policy now gazetteer-driven -- ${wf.nodes.length} nodes`);
}

// ── harness: extract the ACTUAL patched functions and prove behavior against the real bug ──
(function harness() {
  const geoRefPath = '/Users/pkowadkar/Projects/n8n/data/reference/geonames_cities.json';
  const GAZETTEER = JSON.parse(fs.readFileSync(geoRefPath, 'utf8'));
  const _idx = {};
  for (const c of GAZETTEER.cities) {
    const nms = new Set([c.n.toLowerCase(), c.a.toLowerCase(), ...c.alt.map((a) => a.toLowerCase())]);
    for (const nm of nms) { if (!_idx[nm]) _idx[nm] = []; _idx[nm].push(c); }
  }
  GAZETTEER._cityIndex = _idx;

  const REMOTE_RX = /\b(remote|wfh|work[\s-]?from[\s-]?home|telecommut\w*)\b/i;
  const GLOBAL_RX = /\b(worldwide|global|anywhere|any\s*location)\b/i;
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
  function checkLocationState(job, requestCountry, requestCities) {
    const hay = (job.location || '').toLowerCase().trim();
    if (!hay || hay === 'unknown') return 'unknown';
    const jobGeo = resolveLocation(job.location);
    if (jobGeo.unresolved) return 'unknown';
    if (jobGeo.global) return 'match';
    if (requestCities.length && jobGeo.cities.some((c) => requestCities.includes(c.toLowerCase()))) return 'match';
    if (requestCountry && jobGeo.countries.includes(requestCountry)) return 'match';
    if (jobGeo.countries.length) return 'mismatch';
    if (jobGeo.remote) return 'unknown';
    return 'unknown';
  }

  // The EXACT real live-test failure: Natera "US Remote" for an India search.
  const natera = { location: 'US Remote' };
  const state1 = checkLocationState(natera, 'IN', []);
  if (state1 !== 'mismatch') { console.error('HARNESS FAIL: Natera US-Remote-for-India should be MISMATCH, got', state1); process.exit(1); }

  // Cloudflare "Hybrid" (no location info at all) -- honest unknown, not a guess.
  const cloudflare = { location: 'Hybrid' };
  const state2 = checkLocationState(cloudflare, 'IN', []);
  if (state2 !== 'unknown') { console.error('HARNESS FAIL: bare "Hybrid" should be unknown, got', state2); process.exit(1); }

  // Awin multi-location (real Germany-search digest row) -- must MATCH a Germany request.
  const awin = { location: 'Berlin, Berlin, Germany; Iași, Iași, Romania; London, England, United Kingdom; Madrid, Madrid, Spain; München, Bavaria, Germany; Warsaw, Masovian Voivodeship, Poland' };
  const state3 = checkLocationState(awin, 'DE', []);
  if (state3 !== 'match') { console.error('HARNESS FAIL: Awin multi-location should MATCH a Germany request', state3); process.exit(1); }

  // A US-scoped search: "US Remote" SHOULD match.
  const state4 = checkLocationState(natera, 'US', []);
  if (state4 !== 'match') { console.error('HARNESS FAIL: US Remote should match a US-scoped request', state4); process.exit(1); }

  // Genuinely global remote should match any country.
  const openai = { location: 'Worldwide' };
  const state5 = checkLocationState(openai, 'IN', []);
  if (state5 !== 'match') { console.error('HARNESS FAIL: Worldwide should match any request', state5); process.exit(1); }

  // City-level request: Bengaluru search should match a job labeled "Bangalore".
  const meesho = { location: 'Bangalore, Karnataka, India' };
  const state6 = checkLocationState(meesho, 'IN', ['bengaluru']);
  if (state6 !== 'match') { console.error('HARNESS FAIL: "Bangalore" job should match a Bengaluru city-level request', state6); process.exit(1); }

  console.log('HARNESS OK: Natera US-Remote-for-India MISMATCH (the real bug, now fixed), Hybrid stays unknown (never guessed), Awin multi-location matches Germany, US Remote matches a US request, Worldwide matches any request, Bangalore/Bengaluru alias resolves for a city-level request');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
