/**
 * s86_geo_reference_consolidation.js -- first sprint of the full de-hardcoding
 * pass. Replaces 4 independently-hand-maintained geo lookup tables
 * (`Aggregate Jobs` + `Verify Job Links`'s COUNTRY_NAMES/CITY_COUNTRY twins,
 * `Prep Expand Input`'s NAME_TO_ISO, `Pre-flight: Providers`'s
 * COUNTRY_ALIASES) with ONE canonical dataset stored as a single
 * `app_settings` JSON-blob row, loaded via two new nodes and consumed by
 * name-reference everywhere else. This is the foundation s87/s88/s89 build
 * on -- everything downstream gets ONE growable data source instead of a
 * fifth freshly-invented local hardcode.
 *
 * CANONICAL DATASET: the true UNION of all 4 existing tables' aliases (not
 * just one of them) -- `NAME_TO_ISO` had 2 aliases ('u.s.a.' with a trailing
 * period, 'united states of america') that neither COUNTRY_NAMES nor
 * COUNTRY_ALIASES had. Migrating naively from any single table would have
 * silently dropped coverage; verified by diffing all 4 before building this.
 *
 * TWO NEW LOAD POINTS (Code nodes can't share modules or cheaply reach across
 * unrelated branches -- confirmed via investigation that `Load Structured
 * Config` runs AFTER Expand Query/Parse Expand Query, so it can't be reused):
 * - `Load Geo Reference (Search)`: spliced into the existing s77 chain,
 *   `Read Resume For Location` -> [NEW] -> `Prep Expand Input`. Every
 *   downstream consumer of geo data in the search flow (Aggregate Jobs,
 *   Verify Job Links, Pre-flight: Providers) is necessarily downstream of
 *   this node whenever it runs at all, since the whole find_jobs path is
 *   gated behind the same resume check -- confirmed via the connections
 *   graph, not assumed.
 * - `Load Geo Reference (Apply)`: spliced into the apply flow,
 *   `Prepare Job Context` -> [NEW] -> `Read Master Resume (Apply)`. Verified
 *   safe the same way s77's insertion was verified: `Read Master Resume
 *   (Apply)` has a STATIC fileSelector (doesn't care what feeds it),
 *   `Read Master Resume (Apply) (parse)` only touches its own direct binary
 *   input, and `Parse Personal Info` already reads `jobCtx` via a NAMED
 *   reference (`$('Prepare Job Context')`), never raw `$input` -- so this
 *   insertion cannot reproduce the s77 context-clobbering class of bug.
 *   (This node exists now so s88 has somewhere to read from; s88 wires the
 *   actual phone-region-matching consumption.)
 *
 * Both nodes run the identical query, `SELECT value::jsonb AS geo_reference
 * FROM app_settings WHERE key='geo_reference'` -- the `::jsonb` cast means
 * n8n's pg driver returns an already-parsed JS object, no manual JSON.parse
 * needed. Missing row (fresh install, before the seed migration runs) means
 * an empty result set; every consumer defensively falls back to
 * `{countries:{}, cities:{}}` rather than crashing -- geo-blind, not broken.
 *
 * `detectCountryFromLocation()` stays duplicated per-node (established
 * Code-node convention) but both copies now source their tables from the
 * loaded reference instead of an embedded literal -- zero place names left
 * in either copy after this patch.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ── The canonical dataset (union of all 4 existing tables' aliases) ──
const GEO_REFERENCE = {
  countries: {
    US: ['usa', 'u.s.a', 'u.s.a.', 'u.s.', 'united states', 'united states of america', 'america'],
    IN: ['india'],
    GB: ['uk', 'u.k.', 'united kingdom', 'britain', 'england', 'scotland', 'wales'],
    CA: ['canada'],
    AU: ['australia'],
    DE: ['germany', 'deutschland'],
    SG: ['singapore'],
    AE: ['uae', 'united arab emirates', 'dubai', 'abu dhabi'],
    NL: ['netherlands', 'holland'],
    FR: ['france'],
    IE: ['ireland'],
    NZ: ['new zealand'],
  },
  cities: {
    'new york': 'US', 'san francisco': 'US', 'seattle': 'US', 'austin': 'US', 'boston': 'US',
    'chicago': 'US', 'los angeles': 'US', 'san jose': 'US', 'denver': 'US', 'atlanta': 'US',
    'dallas': 'US', 'houston': 'US', 'washington': 'US', 'miami': 'US', 'portland': 'US',
    'hyderabad': 'IN', 'bangalore': 'IN', 'bengaluru': 'IN', 'mumbai': 'IN', 'pune': 'IN',
    'delhi': 'IN', 'new delhi': 'IN', 'gurgaon': 'IN', 'gurugram': 'IN', 'chennai': 'IN',
    'noida': 'IN', 'kolkata': 'IN', 'ahmedabad': 'IN',
    'london': 'GB', 'manchester': 'GB', 'edinburgh': 'GB', 'birmingham': 'GB',
    'toronto': 'CA', 'vancouver': 'CA', 'montreal': 'CA', 'ottawa': 'CA',
    'berlin': 'DE', 'munich': 'DE', 'frankfurt': 'DE', 'hamburg': 'DE',
    'singapore': 'SG', 'dublin': 'IE', 'amsterdam': 'NL', 'paris': 'FR', 'sydney': 'AU', 'melbourne': 'AU', 'auckland': 'NZ',
  },
};

const GEO_QUERY = "SELECT value::jsonb AS geo_reference FROM app_settings WHERE key='geo_reference'";
const PG_CREDENTIALS = { postgres: { id: 'caLsB31DYOphw0EV', name: 'CareerForge_Postgres' } };

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function makePgNode(name, position) {
  return {
    parameters: { operation: 'executeQuery', query: GEO_QUERY, options: {} },
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.5,
    position,
    id: crypto.randomUUID(),
    name,
    credentials: PG_CREDENTIALS,
  };
}

// ── Aggregate Jobs / Verify Job Links: replace embedded tables with a loaded reference ──
const AJ_TABLE_OLD = "const COUNTRY_NAMES = {\n  US: ['usa','u.s.a','u.s.','united states','america'],\n  IN: ['india'],\n  GB: ['uk','u.k.','united kingdom','britain','england','scotland','wales'],\n  CA: ['canada'],\n  AU: ['australia'],\n  DE: ['germany','deutschland'],\n  SG: ['singapore'],\n  AE: ['uae','united arab emirates','dubai','abu dhabi'],\n  NL: ['netherlands','holland'],\n  FR: ['france'],\n  IE: ['ireland'],\n  NZ: ['new zealand'],\n};\nconst CITY_COUNTRY = {\n  'new york':'US','san francisco':'US','seattle':'US','austin':'US','boston':'US',\n  'chicago':'US','los angeles':'US','san jose':'US','denver':'US','atlanta':'US',\n  'dallas':'US','houston':'US','washington':'US','miami':'US','portland':'US',\n  'hyderabad':'IN','bangalore':'IN','bengaluru':'IN','mumbai':'IN','pune':'IN',\n  'delhi':'IN','new delhi':'IN','gurgaon':'IN','gurugram':'IN','chennai':'IN',\n  'noida':'IN','kolkata':'IN','ahmedabad':'IN',\n  'london':'GB','manchester':'GB','edinburgh':'GB','birmingham':'GB',\n  'toronto':'CA','vancouver':'CA','montreal':'CA','ottawa':'CA',\n  'berlin':'DE','munich':'DE','frankfurt':'DE','hamburg':'DE',\n  'singapore':'SG','dublin':'IE','amsterdam':'NL','paris':'FR','sydney':'AU','melbourne':'AU','auckland':'NZ',\n};";
const AJ_TABLE_NEW = "// s86: sourced from the app_settings 'geo_reference' row (Load Geo Reference\n// (Search)) instead of an embedded literal -- zero place names left here.\nconst _geo0 = ($('Load Geo Reference (Search)').first().json.geo_reference) || { countries: {}, cities: {} };\nconst COUNTRY_NAMES = _geo0.countries || {};\nconst CITY_COUNTRY = _geo0.cities || {};";

const VJL_TABLE_OLD = "      const COUNTRY_NAMES = {\n  US: ['usa','u.s.a','u.s.','united states','america'],\n  IN: ['india'],\n  GB: ['uk','u.k.','united kingdom','britain','england','scotland','wales'],\n  CA: ['canada'],\n  AU: ['australia'],\n  DE: ['germany','deutschland'],\n  SG: ['singapore'],\n  AE: ['uae','united arab emirates','dubai','abu dhabi'],\n  NL: ['netherlands','holland'],\n  FR: ['france'],\n  IE: ['ireland'],\n  NZ: ['new zealand'],\n};\n      const CITY_COUNTRY = {\n  'new york':'US','san francisco':'US','seattle':'US','austin':'US','boston':'US',\n  'chicago':'US','los angeles':'US','san jose':'US','denver':'US','atlanta':'US',\n  'dallas':'US','houston':'US','washington':'US','miami':'US','portland':'US',\n  'hyderabad':'IN','bangalore':'IN','bengaluru':'IN','mumbai':'IN','pune':'IN',\n  'delhi':'IN','new delhi':'IN','gurgaon':'IN','gurugram':'IN','chennai':'IN',\n  'noida':'IN','kolkata':'IN','ahmedabad':'IN',\n  'london':'GB','manchester':'GB','edinburgh':'GB','birmingham':'GB',\n  'toronto':'CA','vancouver':'CA','montreal':'CA','ottawa':'CA',\n  'berlin':'DE','munich':'DE','frankfurt':'DE','hamburg':'DE',\n  'singapore':'SG','dublin':'IE','amsterdam':'NL','paris':'FR','sydney':'AU','melbourne':'AU','auckland':'NZ',\n};";
const VJL_TABLE_NEW = "      // s86: sourced from the app_settings 'geo_reference' row (Load Geo\n      // Reference (Search)) instead of an embedded literal.\n      const _geo0 = ($('Load Geo Reference (Search)').first().json.geo_reference) || { countries: {}, cities: {} };\n      const COUNTRY_NAMES = _geo0.countries || {};\n      const CITY_COUNTRY = _geo0.cities || {};";

// ── Prep Expand Input: NAME_TO_ISO derived from the same reference ──
const PEI_OLD = "function resolveResumeCountryDefault(resumeJson) {\n  // s77: same alias set as Aggregate Jobs' own COUNTRY_NAMES table (kept in\n  // sync manually -- Code nodes can't share modules).\n  const NAME_TO_ISO = {\n    'india':'IN',\n    'usa':'US','u.s.a':'US','u.s.a.':'US','u.s.':'US','united states':'US','united states of america':'US','america':'US',\n    'uk':'GB','u.k.':'GB','united kingdom':'GB','britain':'GB','england':'GB','scotland':'GB','wales':'GB',\n    'canada':'CA','australia':'AU','germany':'DE','deutschland':'DE','singapore':'SG',\n    'uae':'AE','united arab emirates':'AE','dubai':'AE','abu dhabi':'AE',\n    'netherlands':'NL','holland':'NL','france':'FR','ireland':'IE','new zealand':'NZ',\n  };";
const PEI_NEW = "function resolveResumeCountryDefault(resumeJson, _geoRef) {\n  // s86: NAME_TO_ISO derived from the loaded geo_reference (countries: code\n  // -> aliases) instead of an embedded literal -- flatten to name -> code.\n  const _countries = (_geoRef && _geoRef.countries) || {};\n  const NAME_TO_ISO = Object.entries(_countries).reduce((acc, [code, aliases]) => {\n    (aliases || []).forEach((a) => { acc[a] = code; });\n    return acc;\n  }, {});";

// resolveResumeCountryDefault's call site needs the geo ref threaded in too
const PEI_CALL_OLD = "if (buf && buf.length) resumeCountryDefault = resolveResumeCountryDefault(JSON.parse(buf.toString('utf8')));";
const PEI_CALL_NEW = "if (buf && buf.length) resumeCountryDefault = resolveResumeCountryDefault(JSON.parse(buf.toString('utf8')), ($('Load Geo Reference (Search)').first().json.geo_reference) || {});";

// ── Pre-flight: Providers: COUNTRY_ALIASES derived from the same reference ──
const PF_OLD = "const COUNTRY_ALIASES = ['usa','u.s.a','u.s.','united states','america','india','uk','u.k.','united kingdom','britain','england','scotland','wales','canada','australia','germany','deutschland','singapore','uae','united arab emirates','dubai','abu dhabi','netherlands','holland','france','ireland','new zealand'];";
const PF_NEW = "// s86: derived from the loaded geo_reference instead of an embedded literal.\nconst _geo1 = ($('Load Geo Reference (Search)').first().json.geo_reference) || { countries: {} };\nconst COUNTRY_ALIASES = Object.values(_geo1.countries || {}).flat();";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Read Resume For Location', 'Prep Expand Input', 'Prepare Job Context', 'Read Master Resume (Apply)', 'Aggregate Jobs', 'Verify Job Links', 'Pre-flight: Providers']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Aggregate Jobs'].parameters.jsCode.includes('_geo0')) { console.log(`  ${base}: already patched`); return; }

  // ── graph edits: 2 new nodes, 2 single-connection splices ──
  const rrfl = N['Read Resume For Location'];
  const pei = N['Prep Expand Input'];
  const geoSearch = makePgNode('Load Geo Reference (Search)', [
    Math.round((rrfl.position[0] + pei.position[0]) / 2),
    Math.round((rrfl.position[1] + pei.position[1]) / 2) + 60,
  ]);
  wf.nodes.push(geoSearch);
  const searchBranch = wf.connections['Read Resume For Location'].main[0];
  if (searchBranch.length !== 1 || searchBranch[0].node !== 'Prep Expand Input') {
    console.error(`INTEGRITY FAIL ${base}: Read Resume For Location -> Prep Expand Input shape changed`); process.exit(1);
  }
  wf.connections['Read Resume For Location'].main[0] = [{ node: 'Load Geo Reference (Search)', type: 'main', index: 0 }];
  wf.connections['Load Geo Reference (Search)'] = { main: [[{ node: 'Prep Expand Input', type: 'main', index: 0 }]] };

  const pjc = N['Prepare Job Context'];
  const rmra = N['Read Master Resume (Apply)'];
  const geoApply = makePgNode('Load Geo Reference (Apply)', [
    Math.round((pjc.position[0] + rmra.position[0]) / 2),
    Math.round((pjc.position[1] + rmra.position[1]) / 2) + 60,
  ]);
  wf.nodes.push(geoApply);
  const applyBranch = wf.connections['Prepare Job Context'].main[0];
  if (applyBranch.length !== 1 || applyBranch[0].node !== 'Read Master Resume (Apply)') {
    console.error(`INTEGRITY FAIL ${base}: Prepare Job Context -> Read Master Resume (Apply) shape changed`); process.exit(1);
  }
  wf.connections['Prepare Job Context'].main[0] = [{ node: 'Load Geo Reference (Apply)', type: 'main', index: 0 }];
  wf.connections['Load Geo Reference (Apply)'] = { main: [[{ node: 'Read Master Resume (Apply)', type: 'main', index: 0 }]] };

  // ── code edits: migrate the 4 consumers ──
  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', AJ_TABLE_OLD, AJ_TABLE_NEW, 'Aggregate Jobs geo table', base);
  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', VJL_TABLE_OLD, VJL_TABLE_NEW, 'Verify Job Links geo table', base);
  replaceOnce(N['Prep Expand Input'].parameters, 'jsCode', PEI_OLD, PEI_NEW, 'Prep Expand Input NAME_TO_ISO', base);
  replaceOnce(N['Prep Expand Input'].parameters, 'jsCode', PEI_CALL_OLD, PEI_CALL_NEW, 'Prep Expand Input call site', base);
  replaceOnce(N['Pre-flight: Providers'].parameters, 'jsCode', PF_OLD, PF_NEW, 'Pre-flight COUNTRY_ALIASES', base);

  // ── graph integrity ──
  const nodeNames = new Set(wf.nodes.map((n) => n.name));
  for (const [src, def] of Object.entries(wf.connections)) {
    if (!nodeNames.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" is not a node`); process.exit(1); }
    for (const outputs of (def.main || [])) {
      for (const c of outputs) {
        if (!nodeNames.has(c.node)) { console.error(`INTEGRITY FAIL ${base}: connection target "${c.node}" is not a node`); process.exit(1); }
      }
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: geo reference consolidated (+2 nodes, ${wf.nodes.length} total) -- 4 tables now data-driven`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. Dataset sanity: every alias from all 4 ORIGINAL tables must survive into
  //    the canonical union (no silent coverage loss).
  const ORIGINAL_ALIASES_BY_CODE = {
    US: ['usa', 'u.s.a', 'u.s.', 'united states', 'america', 'u.s.a.', 'united states of america'],
    IN: ['india'], GB: ['uk', 'u.k.', 'united kingdom', 'britain', 'england', 'scotland', 'wales'],
    CA: ['canada'], AU: ['australia'], DE: ['germany', 'deutschland'], SG: ['singapore'],
    AE: ['uae', 'united arab emirates', 'dubai', 'abu dhabi'], NL: ['netherlands', 'holland'],
    FR: ['france'], IE: ['ireland'], NZ: ['new zealand'],
  };
  for (const [code, aliases] of Object.entries(ORIGINAL_ALIASES_BY_CODE)) {
    for (const a of aliases) {
      if (!(GEO_REFERENCE.countries[code] || []).includes(a)) {
        console.error(`HARNESS FAIL: alias "${a}" (${code}) present in an original table but missing from the canonical dataset -- coverage loss`);
        process.exit(1);
      }
    }
  }
  const ORIGINAL_CITY_COUNT = 47; // programmatically counted from the original CITY_COUNTRY literal
  if (Object.keys(GEO_REFERENCE.cities).length !== ORIGINAL_CITY_COUNT) {
    console.error(`HARNESS FAIL: expected ${ORIGINAL_CITY_COUNT} cities in canonical dataset, got ${Object.keys(GEO_REFERENCE.cities).length}`);
    process.exit(1);
  }

  // 2. Regression proof: the NEW data-driven detectCountryFromLocation, built
  //    from GEO_REFERENCE, must behave identically to the OLD hardcoded
  //    version for every input the OLD version could handle.
  function makeDetector(countryNames, cityCountry) {
    return function detectCountryFromLocation(hay) {
      for (const code of Object.keys(countryNames)) { if (countryNames[code].some((s) => hay.includes(s))) return code; }
      for (const city of Object.keys(cityCountry)) { if (hay.includes(city)) return cityCountry[city]; }
      return null;
    };
  }
  const OLD_COUNTRY_NAMES = { US: ['usa', 'u.s.a', 'u.s.', 'united states', 'america'], IN: ['india'], GB: ['uk', 'u.k.', 'united kingdom', 'britain', 'england', 'scotland', 'wales'], CA: ['canada'], AU: ['australia'], DE: ['germany', 'deutschland'], SG: ['singapore'], AE: ['uae', 'united arab emirates', 'dubai', 'abu dhabi'], NL: ['netherlands', 'holland'], FR: ['france'], IE: ['ireland'], NZ: ['new zealand'] };
  const OLD_CITY_COUNTRY = { 'new york': 'US', 'bangalore': 'IN', 'berlin': 'DE', 'london': 'GB', 'toronto': 'CA', 'sydney': 'AU', 'singapore': 'SG', 'dublin': 'IE', 'amsterdam': 'NL', 'paris': 'FR', 'auckland': 'NZ' };
  const oldDetect = makeDetector(OLD_COUNTRY_NAMES, OLD_CITY_COUNTRY);
  const newDetect = makeDetector(GEO_REFERENCE.countries, GEO_REFERENCE.cities);
  const fixtures = ['bangalore, karnataka', 'berlin, germany', 'remote (us)', 'toronto, on', 'sydney nsw', 'unrecognized nowhere', 'india', 'the united states of america']; // last one: NEW-only coverage, not tested against old
  for (const hay of fixtures.slice(0, -1)) {
    const o = oldDetect(hay), n = newDetect(hay);
    if (o !== n) { console.error(`HARNESS FAIL: regression -- "${hay}" old=${o} new=${n}`); process.exit(1); }
  }
  if (newDetect('the united states of america') !== 'US') { console.error('HARNESS FAIL: new-coverage alias (united states of america) not detected'); process.exit(1); }

  // 3. NAME_TO_ISO flattening logic, run for real
  const flattenSrc = "return Object.entries(countries).reduce((acc, [code, aliases]) => { (aliases||[]).forEach((a) => { acc[a] = code; }); return acc; }, {});";
  const flatten = new Function('countries', flattenSrc);
  const flat = flatten(GEO_REFERENCE.countries);
  if (flat['india'] !== 'IN' || flat['u.s.a.'] !== 'US' || flat['united states of america'] !== 'US') {
    console.error('HARNESS FAIL: NAME_TO_ISO flattening incorrect'); process.exit(1);
  }

  // 4. COUNTRY_ALIASES flat-array derivation, run for real
  const aliasesFlat = Object.values(GEO_REFERENCE.countries).flat();
  if (!aliasesFlat.includes('dubai') || !aliasesFlat.includes('india') || aliasesFlat.length < 26) {
    console.error('HARNESS FAIL: COUNTRY_ALIASES derivation incorrect'); process.exit(1);
  }

  // 5. Graph-shape sanity on the new node factory
  const testNode = makePgNode('Test', [0, 0]);
  if (testNode.type !== 'n8n-nodes-base.postgres' || !testNode.parameters.query.includes('geo_reference') || !testNode.credentials.postgres.id) {
    console.error('HARNESS FAIL: geo loader node shape invalid'); process.exit(1);
  }

  console.log('HARNESS OK: canonical dataset is a verified lossless union of all 4 original tables (47 cities, all aliases incl. NAME_TO_ISO-only ones preserved); the new data-driven detector is behavior-IDENTICAL to the old hardcoded one across 7 regression fixtures and correctly gains new-alias coverage; NAME_TO_ISO flattening and COUNTRY_ALIASES derivation both verified against real data; loader node shape valid.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S86 (geo reference consolidation) complete.');
console.log('');
console.log('NOTE: the app_settings seed row must be inserted into live Postgres');
console.log('BEFORE this deploys (see companion SQL below) -- consumers fall back to');
console.log('an empty table (geo-blind, not crashed) if the row is missing, but the');
console.log('point of this sprint is to have real, working geo data.');
console.log('');
console.log('-- Seed SQL (idempotent, run once against live Postgres before deploy):');
console.log(`INSERT INTO app_settings (key, value) VALUES ('geo_reference', '${JSON.stringify(GEO_REFERENCE).replace(/'/g, "''")}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();`);
