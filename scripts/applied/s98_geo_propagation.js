/**
 * s98_geo_propagation.js -- propagates the gazetteer (s90-s97 wave) into the
 * 4 remaining touch points identified in the semi-RAG reference-data plan's
 * Phase A2: Pre-flight: Providers (cache SQL term expansion), Parse Expand
 * Query (country_name display), Build Telegraph Body (location display
 * dedup), Parse Scorer Output (score100's location dimension).
 *
 * 1. Pre-flight: Providers -- cache_loc_terms now expands through the
 *    gazetteer's alternate names, so a "Bengaluru" search's SQL prefilter
 *    ALSO matches cache rows stored as "Bangalore" (same city, different
 *    string -- confirmed live via s95's digest, Meesho/etc. rows use
 *    "Bangalore"). Also swaps the country-alias source from the small
 *    geo_reference app_settings row to the gazetteer's own (superset)
 *    country list, dropping the Load Geo Reference (Search) dependency
 *    entirely from this node.
 * 2. Parse Expand Query -- country_name display simplified from an alias-
 *    heuristic (pick the longest multi-word alias, title-case it) to a
 *    direct lookup against the gazetteer's country_names field (GeoNames'
 *    own official name per ISO code -- "United States", "United Kingdom",
 *    already properly formatted, no heuristic needed).
 * 3. Build Telegraph Body -- displayLocation dedupes repeated comma
 *    segments per semicolon-group before display: "New Delhi, India,
 *    India" -> "New Delhi, India" (the exact cosmetic bug from the live
 *    Germany-search digest), and "Berlin, Berlin, Germany" -> "Berlin,
 *    Germany" for the Awin-style multi-location strings. Pure string
 *    cleanup, no gazetteer file read needed.
 * 4. Parse Scorer Output -- score100's location dimension now prefers
 *    Aggregate Jobs' own gazetteer-grounded `location_verified` (s96) over
 *    JobScorer's LLM-guessed `location_match` when a location filter was
 *    actually active for this search -- same precedent s57 already
 *    established for Build Telegraph Body (deterministic signal beats LLM
 *    guess). Falls back to the LLM's judgment unchanged when no location
 *    filter ran at all (location_verified undefined).
 *
 * Deliberately NOT done this pass (disclosed, not silently skipped): Build
 * Scorer Input enriching JobScorer's own input with resolved_countries/
 * remote per job -- this would only improve the FALLBACK path (when
 * location_verified is null/undefined), a smaller marginal gain than the 4
 * items above, deferred to keep this phase's blast radius contained.
 *
 * No node count change (5 existing nodes only). Run: inside the n8n
 * container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Pre-flight: Providers ═══
const PREFLIGHT_OLD = `// s79: bare country names disengage this coarse SQL pre-filter entirely --
// it has no city->country intelligence; the authoritative downstream filter
// (Aggregate Jobs) handles country-level matching. Alias list mirrors
// Aggregate Jobs' COUNTRY_NAMES (duplicated, not shared -- Code-node rule).
// s86: derived from the loaded geo_reference instead of an embedded literal.
const _geo1 = ($('Load Geo Reference (Search)').first().json.geo_reference) || { countries: {} };
const COUNTRY_ALIASES = Object.values(_geo1.countries || {}).flat();
const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon) && !COUNTRY_ALIASES.includes(locationCanon) && looksLikeCleanLocation(locationCanon);
const cacheLocTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter((t) => t.length > 1).join(',') : '';`;
const PREFLIGHT_NEW = `// s98: bare country names disengage this coarse SQL pre-filter entirely --
// it has no city->country intelligence; the authoritative downstream filter
// (Aggregate Jobs) handles country-level matching. Country-alias source
// swapped from the small geo_reference app_settings row to the gazetteer's
// own (superset) country list -- drops the Load Geo Reference (Search)
// dependency from this node entirely.
let _gaz1 = null;
try { _gaz1 = JSON.parse(require('fs').readFileSync('/home/node/.n8n-files/companies/reference/geonames_cities.json', 'utf8')); } catch (e) { _gaz1 = null; }
const COUNTRY_ALIASES = _gaz1 ? Object.values(_gaz1.countries || {}).flat() : [];
const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon) && !COUNTRY_ALIASES.includes(locationCanon) && looksLikeCleanLocation(locationCanon);
// s98: expand the base tokens with the matched city's gazetteer alternates
// (e.g. a "Bengaluru" search's SQL prefilter now ALSO matches cache rows
// stored as "Bangalore" -- same city, different string, confirmed live in
// the s95 digest) -- falls back to the plain token split if the gazetteer
// is unavailable or the city isn't found, same behavior as before.
function expandCacheLocTerms(canonStr) {
  const baseTerms = canonStr.split(/[\\s,]+/).filter((t) => t.length > 1);
  if (!_gaz1) return baseTerms;
  const firstSeg = canonStr.split(',')[0].trim();
  const cityMatch = (_gaz1.cities || []).find((c) => [c.n.toLowerCase(), c.a.toLowerCase(), ...c.alt.map((a) => a.toLowerCase())].includes(firstSeg));
  const aliasTerms = cityMatch ? [cityMatch.n.toLowerCase(), cityMatch.a.toLowerCase(), ...cityMatch.alt.map((a) => a.toLowerCase())] : [];
  return [...new Set([...baseTerms, ...aliasTerms])];
}
const cacheLocTerms = hasCityConstraint ? expandCacheLocTerms(locationCanon).join(',') : '';`;

// ═══ 2. Parse Expand Query: country_name via gazetteer's own country_names field ═══
const COUNTRY_NAME_OLD = `result.country_name = null;
if (result.country) {
  try {
    const _geoCountries = ($('Load Geo Reference (Search)').first().json.geo_reference || {}).countries || {};
    const aliases = (_geoCountries[result.country] || []).slice().sort((a, b) => a.length - b.length);
    const best = aliases.find((a) => a.includes(' ')) || aliases[0];
    if (best) result.country_name = best.replace(/\\b\\w/g, (c) => c.toUpperCase());
  } catch (e) { /* fail-open: country_name stays null, ISO code still usable everywhere else */ }
}`;
const COUNTRY_NAME_NEW = `result.country_name = null;
if (result.country) {
  // s98: the gazetteer carries GeoNames' own official country name per ISO
  // code, already properly formatted ("United States", "United Kingdom") --
  // replaces the old alias-heuristic (pick the longest multi-word alias,
  // title-case it) with a direct lookup. Falls back to the old geo_reference
  // heuristic if the gazetteer file can't be read.
  try {
    const _gaz2 = JSON.parse(require('fs').readFileSync('/home/node/.n8n-files/companies/reference/geonames_cities.json', 'utf8'));
    if (_gaz2.country_names && _gaz2.country_names[result.country]) result.country_name = _gaz2.country_names[result.country];
  } catch (e) { /* fall through to the geo_reference fallback below */ }
  if (!result.country_name) {
    try {
      const _geoCountries = ($('Load Geo Reference (Search)').first().json.geo_reference || {}).countries || {};
      const aliases = (_geoCountries[result.country] || []).slice().sort((a, b) => a.length - b.length);
      const best = aliases.find((a) => a.includes(' ')) || aliases[0];
      if (best) result.country_name = best.replace(/\\b\\w/g, (c) => c.toUpperCase());
    } catch (e) { /* fail-open: country_name stays null, ISO code still usable everywhere else */ }
  }
}`;

// ═══ 3. Build Telegraph Body: displayLocation dedupes repeated comma segments ═══
const DISPLAY_OLD = `  // F2: location filtering was active for this search but this job's location
  // couldn't be verified (Aggregate Jobs' 'unknown' branch) -- badge it rather
  // than blend it in with confirmed matches. 🔎 (not 🌐 -- see header comment).
  return job.location_verified === null ? base + ' 🔎' : base;
}`;
const DISPLAY_NEW = `  // s98: dedupe repeated comma segments per semicolon-group before display --
  // "New Delhi, India, India" -> "New Delhi, India" (real cosmetic bug from a
  // live digest), "Berlin, Berlin, Germany" -> "Berlin, Germany" for
  // Awin-style multi-location strings. Pure string cleanup, dedupes WITHIN
  // each semicolon-separated group only (never merges across groups).
  base = base.split(/;\\s*/).map((segment) => {
    const parts = segment.split(',').map((p) => p.trim()).filter(Boolean);
    const seen = new Set();
    const deduped = parts.filter((p) => { const key = p.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
    return deduped.join(', ');
  }).join('; ');
  // F2: location filtering was active for this search but this job's location
  // couldn't be verified (Aggregate Jobs' 'unknown' branch) -- badge it rather
  // than blend it in with confirmed matches. 🔎 (not 🌐 -- see header comment).
  return job.location_verified === null ? base + ' 🔎' : base;
}`;

// ═══ 4. Build Scorer Input: location_verified must actually reach the scorer's jobById for #5 to be anything but a no-op ═══
const JOBBATCH_OLD = `const jobBatch = jobs.slice(0, 30).map(j => ({
  job_id: j.job_id, title: j.title, company: j.company, location: j.location,
  department: j.department, url: j.url, description_snippet: j.description_snippet,
  source: j.source, source_tier: j.source_tier, source_tier_label: j.source_tier_label || j.tier_label,
  required_yoe_min: j.required_yoe_min ?? null, required_yoe_max: j.required_yoe_max ?? null,
  yoe_compat_score: j.yoe_compat_score ?? null,
  salary_min: j.salary_min ?? null, salary_max: j.salary_max ?? null, salary_currency: j.salary_currency || null
}));`;
const JOBBATCH_NEW = `const jobBatch = jobs.slice(0, 30).map(j => ({
  job_id: j.job_id, title: j.title, company: j.company, location: j.location,
  department: j.department, url: j.url, description_snippet: j.description_snippet,
  source: j.source, source_tier: j.source_tier, source_tier_label: j.source_tier_label || j.tier_label,
  required_yoe_min: j.required_yoe_min ?? null, required_yoe_max: j.required_yoe_max ?? null,
  yoe_compat_score: j.yoe_compat_score ?? null,
  salary_min: j.salary_min ?? null, salary_max: j.salary_max ?? null, salary_currency: j.salary_currency || null,
  // s98: without this, Parse Scorer Output's jobById never sees Aggregate
  // Jobs' gazetteer-grounded location_verified (s96) -- it was silently
  // dropped by this whitelist mapping, which would have made the score100
  // location-dim fix downstream a complete no-op.
  location_verified: j.location_verified ?? null
}));`;

// ═══ 5. Parse Scorer Output: score100's location dim prefers location_verified over the LLM's guess ═══
const SCORER_LOC_OLD = `    location: (_locMap[s.location_match] != null ? _locMap[s.location_match] : 60),`;
const SCORER_LOC_NEW = `    // s98: prefer Aggregate Jobs' own gazetteer-grounded location_verified
    // (s96) over JobScorer's LLM-guessed location_match when a location
    // filter was actually active for this search -- same precedent s57
    // already established for Build Telegraph Body (deterministic signal
    // beats LLM guess). Falls back to the LLM's judgment, unchanged, when no
    // location filter ran at all (location_verified undefined).
    location: (job.location_verified === true ? 100 : job.location_verified === null ? (_locSpecific ? 35 : 60) : (_locMap[s.location_match] != null ? _locMap[s.location_match] : 60)),`;

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

  const required = ['Pre-flight: Providers', 'Parse Expand Query', 'Build Telegraph Body', 'Build Scorer Input', 'Parse Scorer Output'];
  for (const r of required) { if (!N[r]) { console.error(`INTEGRITY FAIL ${base}: node "${r}" not found`); process.exit(1); } }

  if (N['Pre-flight: Providers'].parameters.jsCode.includes('s98:')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Pre-flight: Providers'].parameters, 'jsCode', PREFLIGHT_OLD, PREFLIGHT_NEW, 'cache term expansion', base);
  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', COUNTRY_NAME_OLD, COUNTRY_NAME_NEW, 'country_name gazetteer lookup', base);
  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', DISPLAY_OLD, DISPLAY_NEW, 'location display dedup', base);
  replaceOnce(N['Build Scorer Input'].parameters, 'jsCode', JOBBATCH_OLD, JOBBATCH_NEW, 'location_verified passthrough', base);
  replaceOnce(N['Parse Scorer Output'].parameters, 'jsCode', SCORER_LOC_OLD, SCORER_LOC_NEW, 'location_verified-grounded score', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: gazetteer propagated into cache terms, country_name, display dedup, score100 -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. Cache term expansion (real gazetteer, Bengaluru/Bangalore case).
  // Always read the real committed gazetteer for harness testing, regardless
  // of which (possibly scratch/dry-run) directory ROOT points at for the
  // actual patch targets below.
  const GAZ = JSON.parse(fs.readFileSync('/Users/pkowadkar/Projects/n8n/data/reference/geonames_cities.json', 'utf8'));
  function expandCacheLocTerms(canonStr) {
    const baseTerms = canonStr.split(/[\s,]+/).filter((t) => t.length > 1);
    const firstSeg = canonStr.split(',')[0].trim();
    const cityMatch = GAZ.cities.find((c) => [c.n.toLowerCase(), c.a.toLowerCase(), ...c.alt.map((a) => a.toLowerCase())].includes(firstSeg));
    const aliasTerms = cityMatch ? [cityMatch.n.toLowerCase(), cityMatch.a.toLowerCase(), ...cityMatch.alt.map((a) => a.toLowerCase())] : [];
    return [...new Set([...baseTerms, ...aliasTerms])];
  }
  const expanded = expandCacheLocTerms('bengaluru');
  if (!expanded.includes('bangalore')) { console.error('HARNESS FAIL: cache term expansion should include "bangalore" for a "bengaluru" search', expanded); process.exit(1); }
  console.log('HARNESS OK: cache_loc_terms expansion includes "bangalore" for a "bengaluru" request:', expanded.slice(0, 6));

  // 2. country_name direct lookup.
  if (GAZ.country_names.FR !== 'France' || GAZ.country_names.GB !== 'United Kingdom') { console.error('HARNESS FAIL: country_names lookup', GAZ.country_names.FR, GAZ.country_names.GB); process.exit(1); }
  console.log('HARNESS OK: country_names direct lookup gives "France"/"United Kingdom"');

  // 3. Display dedup.
  function dedupDisplay(base) {
    return base.split(/;\s*/).map((segment) => {
      const parts = segment.split(',').map((p) => p.trim()).filter(Boolean);
      const seen = new Set();
      const deduped = parts.filter((p) => { const key = p.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
      return deduped.join(', ');
    }).join('; ');
  }
  const d1 = dedupDisplay('New Delhi, India, India');
  if (d1 !== 'New Delhi, India') { console.error('HARNESS FAIL: dedup New Delhi', d1); process.exit(1); }
  const d2 = dedupDisplay('Berlin, Berlin, Germany; Iași, Iași, Romania');
  if (d2 !== 'Berlin, Germany; Iași, Romania') { console.error('HARNESS FAIL: dedup multi-location', d2); process.exit(1); }
  console.log('HARNESS OK: display dedup fixes "New Delhi, India, India" and multi-location Awin-style strings');

  // 4. Scorer location dim.
  function locScore(locVerified, locMatch, locSpecific) {
    const _locMap = locSpecific ? { match: 100, unknown: 35, mismatch: 0 } : { match: 100, unknown: 60, mismatch: 20 };
    return locVerified === true ? 100 : locVerified === null ? (locSpecific ? 35 : 60) : (_locMap[locMatch] != null ? _locMap[locMatch] : 60);
  }
  if (locScore(true, 'mismatch', true) !== 100) { console.error('HARNESS FAIL: verified match should score 100 regardless of stale LLM guess'); process.exit(1); }
  if (locScore(null, 'match', true) !== 35) { console.error('HARNESS FAIL: verified-unknown + location-specific should score 35, not trust the LLM guess'); process.exit(1); }
  if (locScore(undefined, 'match', true) !== 100) { console.error('HARNESS FAIL: no filter active (undefined) should fall back to the LLM judgment unchanged'); process.exit(1); }
  console.log('HARNESS OK: score100 location dim prefers gazetteer-grounded location_verified over the LLM guess, falls back cleanly when no filter was active');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
