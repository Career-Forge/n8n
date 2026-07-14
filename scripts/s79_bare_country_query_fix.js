/**
 * s79_bare_country_query_fix.js -- closes the gap found while answering "will
 * it do a good job with different conditions/locations?" (2026-07-14): a bare
 * COUNTRY name typed as the query's location ("find jobs in Germany", "find
 * AI jobs in India") lands in location_canonical as a clean single word,
 * passes s75's sentence guard (correctly -- it isn't garbage), and gets
 * treated as a CITY substring term. Consequence: a real Germany job labeled
 * "Berlin" (no literal substring "germany") is dropped as a known mismatch --
 * the same failure shape as the MAANG incident, triggered by a legitimate
 * country name.
 *
 * The codebase already has the right machinery for countries:
 * `expandCtx.country` (ISO) -> checkLocationState's country branch ->
 * detectCountryFromLocation(), whose CITY_COUNTRY table already maps
 * bangalore/pune/berlin/etc. to their countries. Bare country names just
 * never ROUTED there. Two layers, same shape as s75:
 *
 * (1) PROMPT (Expand Query): a COUNTRY RULE between the s75 priority rule and
 *     the s77 third-tier rule -- a country named in the message goes to the
 *     `country` ISO field, location_canonical stays null (city/metro/state
 *     places only).
 *
 * (2) DETERMINISTIC BACKSTOP (the same 3 gate copies s75 hardened):
 *     - Aggregate Jobs + Verify Job Links: if location_canonical exactly
 *       matches a COUNTRY_NAMES alias (exact membership, so
 *       "new york, new york, united states" stays on the city path), derive
 *       countryCode from it and skip city-term matching. An explicitly typed
 *       "usa" DOES engage the US filter -- distinct from the pre-existing
 *       suppression of country==='US' as a silent schema default.
 *     - Pre-flight: Providers (SQL cache pre-filter): bare country names
 *       DISENGAGE the coarse ILIKE pre-filter entirely (it has no
 *       city->country intelligence; per the v9 A1 design the pre-filter may
 *       only shrink the cache lane when it's sure -- the authoritative
 *       downstream filter handles the country check).
 *
 * Run: node scripts/s79_bare_country_query_fix.js (host).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ── (1) Expand Query prompt: COUNTRY RULE ──
const EQ_OLD = '(not a sentence). THIRD TIER:';
const EQ_NEW = '(not a sentence). COUNTRY RULE: when the location the user names is a COUNTRY ("jobs in India", "roles in Germany", "USA jobs"), set country to that ISO code and output location_canonical as null -- location_canonical is ONLY for city/metro/state-level places, never a bare country name. THIRD TIER:';

// ── (2a) Aggregate Jobs ──
const AJ_GATE_OLD = "const hasCityConstraint = locationCanon && !['any','anywhere','worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);";
const AJ_GATE_NEW =
  "// s79: a bare COUNTRY name is not a city -- 'find jobs in Germany' must use\n" +
  "// the country-level matcher (which knows berlin->DE via CITY_COUNTRY), not\n" +
  "// city substring matching (which would drop every job labeled 'Berlin' for\n" +
  "// lacking the literal substring 'germany'). Exact alias membership, so\n" +
  "// 'new york, new york, united states' still takes the city path.\n" +
  "function countryFromCanonical(s) {\n" +
  "  for (const code of Object.keys(COUNTRY_NAMES)) { if (COUNTRY_NAMES[code].includes(s)) return code; }\n" +
  "  return null;\n" +
  "}\n" +
  "const canonCountry = locationCanon ? countryFromCanonical(locationCanon) : null;\n" +
  "const hasCityConstraint = locationCanon && !canonCountry && !['any','anywhere','worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);";
const AJ_CC_OLD = "const countryCode = (!locTerms.length && expandCtx.country && expandCtx.country !== 'US') ? expandCtx.country : null;";
const AJ_CC_NEW = "// s79: an explicitly TYPED country ('usa') engages the filter even for US --\n" +
  "// only the schema's silent country='US' default stays suppressed.\n" +
  "const countryCode = canonCountry || ((!locTerms.length && expandCtx.country && expandCtx.country !== 'US') ? expandCtx.country : null);";

// ── (2b) Verify Job Links (nested scope, arrow-style, spaced array) ──
const VJ_GATE_OLD = "const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);";
const VJ_GATE_NEW =
  "const countryFromCanonical = (s) => {\n" +
  "      for (const code of Object.keys(COUNTRY_NAMES)) { if (COUNTRY_NAMES[code].includes(s)) return code; }\n" +
  "      return null;\n" +
  "    };\n" +
  "    const canonCountry = locationCanon ? countryFromCanonical(locationCanon) : null;\n" +
  "    const hasCityConstraint = locationCanon && !canonCountry && !['any', 'anywhere', 'worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);";
const VJ_CC_OLD = "const countryCode = (!locTerms.length && expandCtx.country && expandCtx.country !== 'US') ? expandCtx.country : null;";
const VJ_CC_NEW = "const countryCode = canonCountry || ((!locTerms.length && expandCtx.country && expandCtx.country !== 'US') ? expandCtx.country : null);";

// ── (2c) Pre-flight: Providers (no country tables here -- flat alias list, disengage) ──
const PF_GATE_OLD = "const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);";
const PF_GATE_NEW =
  "// s79: bare country names disengage this coarse SQL pre-filter entirely --\n" +
  "// it has no city->country intelligence; the authoritative downstream filter\n" +
  "// (Aggregate Jobs) handles country-level matching. Alias list mirrors\n" +
  "// Aggregate Jobs' COUNTRY_NAMES (duplicated, not shared -- Code-node rule).\n" +
  "const COUNTRY_ALIASES = ['usa','u.s.a','u.s.','united states','america','india','uk','u.k.','united kingdom','britain','england','scotland','wales','canada','australia','germany','deutschland','singapore','uae','united arab emirates','dubai','abu dhabi','netherlands','holland','france','ireland','new zealand'];\n" +
  "const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon) && !COUNTRY_ALIASES.includes(locationCanon) && looksLikeCleanLocation(locationCanon);";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Expand Query', 'Aggregate Jobs', 'Verify Job Links', 'Pre-flight: Providers']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Aggregate Jobs'].parameters.jsCode.includes('countryFromCanonical')) { console.log(`  ${base}: already patched`); return; }

  const mv = N['Expand Query'].parameters.messages.messageValues;
  replaceOnce(mv[0], 'message', EQ_OLD, EQ_NEW, 'COUNTRY RULE', base);
  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', AJ_GATE_OLD, AJ_GATE_NEW, 'AJ gate', base);
  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', AJ_CC_OLD, AJ_CC_NEW, 'AJ countryCode', base);
  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', VJ_GATE_OLD, VJ_GATE_NEW, 'VJL gate', base);
  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', VJ_CC_OLD, VJ_CC_NEW, 'VJL countryCode', base);
  replaceOnce(N['Pre-flight: Providers'].parameters, 'jsCode', PF_GATE_OLD, PF_GATE_NEW, 'PF gate', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: bare-country routing fixed in prompt + all 3 gates -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // Real tables (verbatim from the live Aggregate Jobs node) so the end-to-end
  // check exercises the ACTUAL lookup data, not a synthetic stand-in.
  const COUNTRY_NAMES = { US: ['usa','u.s.a','u.s.','united states','america'], IN: ['india'], GB: ['uk','u.k.','united kingdom','britain','england','scotland','wales'], CA: ['canada'], AU: ['australia'], DE: ['germany','deutschland'], SG: ['singapore'], AE: ['uae','united arab emirates','dubai','abu dhabi'], NL: ['netherlands','holland'], FR: ['france'], IE: ['ireland'], NZ: ['new zealand'] };
  const CITY_COUNTRY = { 'bangalore':'IN', 'pune':'IN', 'berlin':'DE', 'new york':'US', 'london':'GB' };

  // Build the patched AJ gate as a runnable: returns {hasCityConstraint, locTerms, countryCode}
  const gateSrc =
    "function looksLikeCleanLocation(s) {\n" +
    "  const STOP = ['and','or','targeting','roles','role','the','for','based','remember'];\n" +
    "  const tokens = s.split(/[\\s,]+/).filter(Boolean);\n" +
    "  return tokens.length > 0 && tokens.length <= 8 && !tokens.some(t => STOP.includes(t.toLowerCase()));\n" +
    "}\n" +
    AJ_GATE_NEW + "\n" +
    "const locTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter(t => t.length > 1) : [];\n" +
    AJ_CC_NEW + "\n" +
    "return { hasCityConstraint: !!hasCityConstraint, locTerms, countryCode };";
  const runGate = new Function('locationCanon', 'expandCtx', 'COUNTRY_NAMES', gateSrc);

  const cases = [
    { loc: 'india', ctx: { country: 'IN' }, want: { city: false, cc: 'IN' }, label: 'bare India' },
    { loc: 'germany', ctx: { country: 'US' }, want: { city: false, cc: 'DE' }, label: 'bare Germany (ctx still silent US default)' },
    { loc: 'usa', ctx: { country: 'US' }, want: { city: false, cc: 'US' }, label: 'explicitly typed USA engages US filter' },
    { loc: 'united states', ctx: { country: 'US' }, want: { city: false, cc: 'US' }, label: 'multi-word country alias' },
    { loc: 'bangalore', ctx: { country: 'IN' }, want: { city: true, cc: null }, label: 'city stays on city path' },
    { loc: 'new york, new york, united states', ctx: { country: 'US' }, want: { city: true, cc: null }, label: 'city+country full string stays city path (exact-match semantics)' },
    { loc: 'worldwide', ctx: { country: 'US' }, want: { city: false, cc: null }, label: 'worldwide unaffected' },
    { loc: 'belagavi and targeting roles in bangalore', ctx: { country: 'US' }, want: { city: false, cc: null }, label: 's75 sentence guard still active' },
    { loc: '', ctx: { country: 'DE' }, want: { city: false, cc: 'DE' }, label: 'no location + explicit ctx country (s77 path) preserved' },
    { loc: '', ctx: { country: 'US' }, want: { city: false, cc: null }, label: 'silent US default still suppressed' },
  ];
  for (const c of cases) {
    const got = runGate(c.loc, c.ctx, COUNTRY_NAMES);
    if (got.hasCityConstraint !== c.want.city || got.countryCode !== c.want.cc) {
      console.error(`HARNESS FAIL: "${c.label}" -> ${JSON.stringify(got)}, wanted city=${c.want.city} cc=${JSON.stringify(c.want.cc)}`);
      process.exit(1);
    }
  }

  // End-to-end outcome check with the real checkLocationState + detect logic:
  // country filter IN must MATCH a job labeled only "Bangalore, Karnataka".
  const e2eSrc =
    "function detectCountryFromLocation(hay) {\n" +
    "  for (const code of Object.keys(COUNTRY_NAMES)) { if (COUNTRY_NAMES[code].some(s => hay.includes(s))) return code; }\n" +
    "  for (const city of Object.keys(CITY_COUNTRY)) { if (hay.includes(city)) return CITY_COUNTRY[city]; }\n" +
    "  return null;\n" +
    "}\n" +
    "function checkLocationState(job, locTerms, countryCode) {\n" +
    "  const hay = (job.location || '').toLowerCase().trim();\n" +
    "  if (!hay || hay === 'unknown') return 'unknown';\n" +
    "  if (locTerms && locTerms.length) return locTerms.some(t => hay.includes(t)) ? 'match' : 'mismatch';\n" +
    "  if (countryCode) {\n" +
    "    const detected = detectCountryFromLocation(hay);\n" +
    "    if (!detected) return 'unknown';\n" +
    "    return detected === countryCode ? 'match' : 'mismatch';\n" +
    "  }\n" +
    "  return 'unknown';\n" +
    "}\n" +
    "return checkLocationState(job, locTerms, countryCode);";
  const runCheck = new Function('job', 'locTerms', 'countryCode', 'COUNTRY_NAMES', 'CITY_COUNTRY', e2eSrc);

  const gIN = runGate('india', { country: 'IN' }, COUNTRY_NAMES);
  const e2e = [
    { job: { location: 'Bangalore, Karnataka' }, want: 'match', label: 'India query keeps Bangalore-labeled job (THE bug, fixed)' },
    { job: { location: 'Berlin, Germany' }, want: 'mismatch', label: 'India query drops Berlin job' },
    { job: { location: '' }, want: 'unknown', label: 'unknown location kept-but-demoted (three-state policy)' },
  ];
  for (const c of e2e) {
    const got = runCheck(c.job, gIN.locTerms, gIN.countryCode, COUNTRY_NAMES, CITY_COUNTRY);
    if (got !== c.want) { console.error(`HARNESS FAIL e2e: "${c.label}" -> ${got}, wanted ${c.want}`); process.exit(1); }
  }

  // OLD-code repro: pre-s79 gate treats 'india' as a city constraint (the bug).
  const oldGate = new Function('locationCanon',
    "function looksLikeCleanLocation(s) { const STOP = ['and','or','targeting','roles','role','the','for','based','remember']; const tokens = s.split(/[\\s,]+/).filter(Boolean); return tokens.length > 0 && tokens.length <= 8 && !tokens.some(t => STOP.includes(t.toLowerCase())); }\n" +
    "return !!(locationCanon && !['any','anywhere','worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon));");
  if (oldGate('india') !== true) { console.error('HARNESS FAIL: old gate does not reproduce the bug -- fixture unfaithful'); process.exit(1); }
  // And under the old behavior a Bangalore job would be DROPPED:
  const oldOutcome = runCheck({ location: 'Bangalore, Karnataka' }, ['india'], null, COUNTRY_NAMES, CITY_COUNTRY);
  if (oldOutcome !== 'mismatch') { console.error('HARNESS FAIL: old behavior repro expected mismatch, got ' + oldOutcome); process.exit(1); }

  // Pre-flight variant: bare country disengages, city engages.
  const pfSrc =
    "function looksLikeCleanLocation(s) { const STOP = ['and','or','targeting','roles','role','the','for','based','remember']; const tokens = s.split(/[\\s,]+/).filter(Boolean); return tokens.length > 0 && tokens.length <= 8 && !tokens.some(t => STOP.includes(t.toLowerCase())); }\n" +
    PF_GATE_NEW + "\nreturn !!hasCityConstraint;";
  const runPF = new Function('locationCanon', pfSrc);
  if (runPF('india') !== false) { console.error('HARNESS FAIL: PF must disengage on bare country'); process.exit(1); }
  if (runPF('bangalore') !== true) { console.error('HARNESS FAIL: PF must still engage on a city'); process.exit(1); }

  if (!EQ_NEW.includes('COUNTRY RULE')) { console.error('HARNESS FAIL: prompt rule missing'); process.exit(1); }

  console.log('HARNESS OK: bare countries (india/germany/usa/united states) route to the country matcher; an India query now MATCHES a job labeled only "Bangalore, Karnataka" (old code proven to drop it); cities, city+country strings, worldwide, the s75 sentence guard, the s77 ctx-country path, and the silent-US-default suppression are all byte-preserved in behavior; the SQL pre-filter disengages on countries and still engages on cities.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S79 (bare-country queries route to country-level matching, prompt + 3 deterministic gates) complete.');
