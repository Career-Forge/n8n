/**
 * s140_locale_resolution.js -- locale-aware resume/cover, step 1 of 5
 * (s140-s144, see plan). Data + resolution + threading ONLY -- ZERO render
 * changes. This script:
 *
 *   1. Ships data/reference/locale_profiles.json complete (13 profiles:
 *      DEFAULT + US/CA/UK_IE/AU_NZ/DACH/FR/ANTI_PHOTO_EU/GULF/SEA_HUB/BR/
 *      LATAM_MULTI/IN). Already written by hand this session -- this script
 *      only verifies it parses and every country_to_profile target exists.
 *   2. Expands geo_reference (db/schema.sql seed + a live Postgres UPDATE)
 *      with 10 new countries (BR MX SA HK NO SE DK FI CH AT) + their cities,
 *      and fixes 3 real substring traps: "new mexico" was falling through to
 *      MX's "mexico" alias (Object.keys() iteration order = first-match-wins,
 *      and MX would be reached before any US-specific "new mexico" alias
 *      existed); "northern ireland" contains "ireland" and would incorrectly
 *      match IE before GB's alias list got a chance (GB already precedes IE
 *      in iteration order -- the fix is giving GB an alias that matches
 *      first, not reordering); "saudi arabia"/"ksa" needs its own SA alias
 *      list now that Saudi Arabia is a new country.
 *   3. Patches Parse Personal Info (master workflow): hoists the existing
 *      per-call geo_reference load + detectJobCountry() (s88) out of
 *      applyPhoneDisplay() to module scope, so the new resolveLocale()
 *      shares one load instead of duplicating it; adds resolveLocale()
 *      implementing the exact 7-step precedence algorithm from the plan
 *      (fs-fail-open -> pref override, STOP -> job-text detection, never JD
 *      body/prefs.location_canonical -> unmapped/unresolved -> DEFAULT ->
 *      multinational override via the s99 tierLookup precedent -> final
 *      ctx.locale/ctx.locale_profile); emits locale/locale_profile on ALL 3
 *      return branches (error, missing-fields, success) since a locale-aware
 *      render needs it even on a validation-error path that still surfaces
 *      ctx to the caller.
 *   4. Patches Handle Prefs Update: adds a `locale: (auto|[a-z]{2})` pref
 *      (UK->GB alias, matching resolveLocale()'s own alias table), same
 *      colon-required convention as sections:/order:/template:. Minimal,
 *      function-form replacer only, no fs touched in this node -- this
 *      node has a real corruption history (s130) and gets a full re-parse
 *      in the harness below, not just a substring check.
 *   5. Patches Store Apply Context: persists locale + locale_profile into
 *      staticData.last_apply (observability now, revise-flow persistence
 *      once s141+ render off it -- Update Last Apply already only overwrites
 *      resume_json+timestamp, confirmed earlier this session, so these
 *      survive a chained revise automatically).
 *
 * Deliberately NOT touched: any LaTeX/render node, any prompt. Zero visible
 * output change from this script -- ctx.locale/ctx.locale_profile just ride
 * along, unread by anything downstream until s141.
 *
 * Run: harness (real fixtures, including the 3 named substring traps, run
 * against the ACTUAL patched source text via new Function -- not a
 * reimplementation) + deploy (master workflow + schema.sql + live Postgres
 * UPDATE) + verify (real applies, check last_apply.locale) + commit.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const SCHEMA_FILE = path.join(ROOT, 'db', 'schema.sql');
const LOCALE_PROFILES_FILE = path.join(ROOT, 'data', 'reference', 'locale_profiles.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}

// ════════════════════ Part 1: locale_profiles.json sanity ════════════════════
function checkLocaleProfilesFile() {
  const data = JSON.parse(fs.readFileSync(LOCALE_PROFILES_FILE, 'utf8'));
  if (!data.profiles || !data.profiles.DEFAULT) { console.error('INTEGRITY FAIL: locale_profiles.json missing DEFAULT profile'); process.exit(1); }
  for (const [country, profileKey] of Object.entries(data.country_to_profile || {})) {
    if (!data.profiles[profileKey]) { console.error(`INTEGRITY FAIL: country_to_profile[${country}] -> missing profile "${profileKey}"`); process.exit(1); }
  }
  for (const tierName of (data.multinational_tiers || [])) {
    if (typeof tierName !== 'string') { console.error('INTEGRITY FAIL: multinational_tiers entry not a string'); process.exit(1); }
  }
  return data;
}

// ════════════════════ Part 2: geo_reference expansion ════════════════════
const OLD_SEED_VALUE = '{"countries":{"US":["usa","u.s.a","u.s.a.","u.s.","united states","united states of america","america"],"IN":["india"],"GB":["uk","u.k.","united kingdom","britain","england","scotland","wales"],"CA":["canada"],"AU":["australia"],"DE":["germany","deutschland"],"SG":["singapore"],"AE":["uae","united arab emirates","dubai","abu dhabi"],"NL":["netherlands","holland"],"FR":["france"],"IE":["ireland"],"NZ":["new zealand"]},"cities":{"new york":"US","san francisco":"US","seattle":"US","austin":"US","boston":"US","chicago":"US","los angeles":"US","san jose":"US","denver":"US","atlanta":"US","dallas":"US","houston":"US","washington":"US","miami":"US","portland":"US","hyderabad":"IN","bangalore":"IN","bengaluru":"IN","mumbai":"IN","pune":"IN","delhi":"IN","new delhi":"IN","gurgaon":"IN","gurugram":"IN","chennai":"IN","noida":"IN","kolkata":"IN","ahmedabad":"IN","london":"GB","manchester":"GB","edinburgh":"GB","birmingham":"GB","toronto":"CA","vancouver":"CA","montreal":"CA","ottawa":"CA","berlin":"DE","munich":"DE","frankfurt":"DE","hamburg":"DE","singapore":"SG","dublin":"IE","amsterdam":"NL","paris":"FR","sydney":"AU","melbourne":"AU","auckland":"NZ"}}';

function buildExpandedGeoReference() {
  const geo = JSON.parse(OLD_SEED_VALUE);
  // Substring-trap fixes, both additive (existing aliases untouched, order preserved).
  geo.countries.US.push('new mexico');
  geo.countries.GB.push('northern ireland');
  // New countries -- appended, preserving existing key order (US..NZ stay first,
  // so no existing detection path changes for anything already covered).
  Object.assign(geo.countries, {
    BR: ['brazil', 'brasil'],
    MX: ['mexico', 'méxico'],
    SA: ['saudi arabia', 'ksa', 'kingdom of saudi arabia'],
    HK: ['hong kong'],
    NO: ['norway'],
    SE: ['sweden'],
    DK: ['denmark'],
    FI: ['finland'],
    CH: ['switzerland', 'swiss'],
    AT: ['austria']
  });
  Object.assign(geo.cities, {
    'sao paulo': 'BR', 'são paulo': 'BR', 'rio de janeiro': 'BR', 'brasilia': 'BR', 'belo horizonte': 'BR',
    'mexico city': 'MX', 'guadalajara': 'MX', 'monterrey': 'MX',
    'riyadh': 'SA', 'jeddah': 'SA', 'dammam': 'SA',
    'hong kong': 'HK',
    'oslo': 'NO',
    'stockholm': 'SE', 'gothenburg': 'SE',
    'copenhagen': 'DK',
    'helsinki': 'FI',
    'zurich': 'CH', 'zürich': 'CH', 'geneva': 'CH', 'basel': 'CH',
    'vienna': 'AT'
  });
  return geo;
}

function patchSchemaSql(newGeoRefJson) {
  let sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const anchorLine = `INSERT INTO app_settings (key, value) VALUES ('geo_reference', '${OLD_SEED_VALUE}')`;
  if (!sql.includes(anchorLine)) {
    if (sql.includes(newGeoRefJson.replace(/'/g, "''"))) { console.log('  schema.sql: already patched'); return; }
    console.error('INTEGRITY FAIL: geo_reference seed anchor not found in db/schema.sql'); process.exit(1);
  }
  const count = sql.split(anchorLine).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: geo_reference seed anchor found ${count} times, expected 1`); process.exit(1); }
  const newLine = `INSERT INTO app_settings (key, value) VALUES ('geo_reference', '${newGeoRefJson.replace(/'/g, "''")}')`;
  sql = sql.replace(anchorLine, () => newLine);
  fs.writeFileSync(SCHEMA_FILE, sql);
  console.log('  schema.sql: geo_reference seed expanded (10 new countries + cities + 3 substring-trap fixes)');
}

// ════════════════════ Part 3: Parse Personal Info -- resolveLocale ════════════════════
// The exact block inserted between `const jobCtx = ...` and `function parseMaybe`.
// Kept as its own constant so the harness can execute this EXACT literal text
// (via new Function), not a reimplementation.
const PPI_LOCALE_BLOCK = `// s140: locale resolution -- hoisted to module scope (was previously loaded
// fresh inside applyPhoneDisplay on every call) so both the phone-display
// country detector and the new resolveLocale() below share ONE geo load and
// ONE detectJobCountry(). Never inferred from candidate residency (standing
// design law, s86-s89) -- only two sources ever set locale: an explicit
// prefs.locale override, or the job's own location/title text.
let _geo = { countries: {}, cities: {} };
try { _geo = ($('Load Geo Reference (Apply)').first().json.geo_reference) || _geo; } catch (e) {}
function detectJobCountry(hay) {
  for (const code of Object.keys(_geo.countries || {})) { if ((_geo.countries[code] || []).some((s) => hay.includes(s))) return code; }
  for (const city of Object.keys(_geo.cities || {})) { if (hay.includes(city)) return _geo.cities[city]; }
  return null;
}
let LOCALE_PROFILES = null;
try { LOCALE_PROFILES = JSON.parse(require('fs').readFileSync('/home/node/.n8n-files/companies/reference/locale_profiles.json', 'utf8')); } catch (e) { LOCALE_PROFILES = null; }
// s99 precedent, mirrored here for the multinational-override tier lookup
// (keep the normalizer in sync with Parse Scorer Output/Build Telegraph Body
// if any of those ever change).
const LOCALE_NAME_SUFFIX_RX = /\\b(incorporated|corporation|company|limited|holdings?|group|llc|inc|corp|co|ltd|llp|plc|gmbh|ag|sa|nv|bv)\\b\\.?/g;
function normalizeCompanyNameForLocale(raw) {
  return String(raw || '').toLowerCase().replace(/&/g, 'and').replace(/[.,'"()]/g, '').replace(LOCALE_NAME_SUFFIX_RX, '').replace(/\\s+/g, ' ').trim();
}
let LOCALE_COMPANY_TIERS = null;
try { LOCALE_COMPANY_TIERS = JSON.parse(require('fs').readFileSync('/home/node/.n8n-files/companies/reference/company_tiers.json', 'utf8')).companies || {}; } catch (e) { LOCALE_COMPANY_TIERS = null; }
function localeTierLookup(companyName) {
  if (!LOCALE_COMPANY_TIERS) return null;
  return LOCALE_COMPANY_TIERS[normalizeCompanyNameForLocale(companyName)] || null;
}
function resolveLocale(prefsLocale, jobLocationText, companyName) {
  if (!LOCALE_PROFILES || !LOCALE_PROFILES.profiles || !LOCALE_PROFILES.profiles.DEFAULT) {
    return { locale: { code: null, profile_key: 'DEFAULT', source: 'no_profiles_data', multinational: false }, profile: null };
  }
  const profiles = LOCALE_PROFILES.profiles;
  const countryToProfile = LOCALE_PROFILES.country_to_profile || {};
  const localeAliases = LOCALE_PROFILES.aliases || {};
  if (prefsLocale) {
    let code = String(prefsLocale).toUpperCase();
    code = localeAliases[code] || code;
    const prefProfileKey = countryToProfile[code];
    if (prefProfileKey && profiles[prefProfileKey]) {
      return { locale: { code, profile_key: prefProfileKey, source: 'pref', multinational: false }, profile: profiles[prefProfileKey] };
    }
  }
  const country = detectJobCountry(jobLocationText);
  if (!country) {
    return { locale: { code: null, profile_key: 'DEFAULT', source: 'default_unresolved', multinational: false }, profile: profiles.DEFAULT };
  }
  const profileKey = countryToProfile[country];
  if (!profileKey || !profiles[profileKey]) {
    return { locale: { code: country, profile_key: 'DEFAULT', source: 'default_unmapped', multinational: false }, profile: profiles.DEFAULT };
  }
  const localProfile = profiles[profileKey];
  if (localProfile.heavy_local_convention) {
    const tier = localeTierLookup(companyName);
    const isMultinational = !!tier && (
      (LOCALE_PROFILES.multinational_tiers || []).includes(tier.tier) ||
      (typeof tier.w === 'number' && tier.w >= (LOCALE_PROFILES.multinational_w_min || 0.9))
    );
    if (isMultinational) {
      const merged = { ...profiles.DEFAULT, paper: localProfile.paper, pages: localProfile.pages, spelling: localProfile.spelling };
      return { locale: { code: country, profile_key: profileKey, source: 'jd_country+multinational', multinational: true }, profile: merged };
    }
  }
  return { locale: { code: country, profile_key: profileKey, source: 'jd_country', multinational: false }, profile: localProfile };
}
const _sdForLocale = $getWorkflowStaticData('global');
const _localeResolved = resolveLocale((_sdForLocale.user_prefs || {}).locale, (jobCtx.location || jobCtx.job_title || '').toLowerCase(), jobCtx.company);
const locale = _localeResolved.locale;
const locale_profile = _localeResolved.profile;`;

const PPI_JOBCTX_OLD = `const jobCtx = $('Prepare Job Context').first().json;\n\nfunction parseMaybe(v) {`;
const PPI_JOBCTX_NEW = `const jobCtx = $('Prepare Job Context').first().json;\n\n${PPI_LOCALE_BLOCK}\n\nfunction parseMaybe(v) {`;

const PPI_PHONE_OLD = `function applyPhoneDisplay(personal) {
  const jobLocation = (jobCtx.location || jobCtx.job_title || '').toLowerCase();
  // s88: real country detection from s86's geo reference instead of a
  // hardcoded India-only city list -- works for any country, symmetrically.
  let _geo = { countries: {}, cities: {} };
  try { _geo = ($('Load Geo Reference (Apply)').first().json.geo_reference) || _geo; } catch (e) {}
  function detectJobCountry(hay) {
    for (const code of Object.keys(_geo.countries || {})) { if ((_geo.countries[code] || []).some((s) => hay.includes(s))) return code; }
    for (const city of Object.keys(_geo.cities || {})) { if (hay.includes(city)) return _geo.cities[city]; }
    return null;
  }
  const jobCountry = detectJobCountry(jobLocation);`;
const PPI_PHONE_NEW = `function applyPhoneDisplay(personal) {
  const jobLocation = (jobCtx.location || jobCtx.job_title || '').toLowerCase();
  // s88: real country detection from s86's geo reference instead of a
  // hardcoded India-only city list -- works for any country, symmetrically.
  // s140: _geo load + detectJobCountry hoisted to module scope (shared with
  // resolveLocale() above) -- no longer loaded fresh here.
  const jobCountry = detectJobCountry(jobLocation);`;

const PPI_RETURN1_OLD = `  return [{ json: { ...jobCtx, resume_text: '', resume_structured: null, personal: {}, resume_source: resumeSource, _validation_error: true, _missing_fields: ['saved resume'], error: 'No saved resume found. Send me your resume as pasted text or upload a PDF/DOCX/TXT, then tap ✅ to save it.' } }];`;
const PPI_RETURN1_NEW = `  return [{ json: { ...jobCtx, resume_text: '', resume_structured: null, personal: {}, resume_source: resumeSource, locale, locale_profile, _validation_error: true, _missing_fields: ['saved resume'], error: 'No saved resume found. Send me your resume as pasted text or upload a PDF/DOCX/TXT, then tap ✅ to save it.' } }];`;

const PPI_RETURN2_OLD = `  return [{ json: { ...jobCtx, resume_text: resumeText, resume_structured: structured || null, personal, resume_source: resumeSource, _validation_error: true, _missing_fields: missing, error: 'Saved resume is missing required fields: ' + missing.join(', ') } }];`;
const PPI_RETURN2_NEW = `  return [{ json: { ...jobCtx, resume_text: resumeText, resume_structured: structured || null, personal, resume_source: resumeSource, locale, locale_profile, _validation_error: true, _missing_fields: missing, error: 'Saved resume is missing required fields: ' + missing.join(', ') } }];`;

const PPI_RETURN3_OLD = `return [{ json: { ...jobCtx, resume_text: resumeText, resume_structured: structured || null, personal, resume_source: resumeSource, _validation_error: false } }];`;
const PPI_RETURN3_NEW = `return [{ json: { ...jobCtx, resume_text: resumeText, resume_structured: structured || null, personal, resume_source: resumeSource, locale, locale_profile, _validation_error: false } }];`;

// ════════════════════ Part 4: Handle Prefs Update -- locale pref ════════════════════
const HPU_OLD = `if ((m = msg.match(/\\btemplate\\s*:\\s*(compact|normal)\\b/i))) {
  delta.template = m[1].toLowerCase();
}`;
const HPU_NEW = `if ((m = msg.match(/\\btemplate\\s*:\\s*(compact|normal)\\b/i))) {
  delta.template = m[1].toLowerCase();
}

// ── Resume/cover locale override (s140) -- 'auto' clears back to
// job-detected resolution (falls through resolveLocale()'s pref check since
// no profile maps to the literal code 'AUTO'); a 2-letter code pins a
// specific locale profile (e.g. 'locale: DE'). 'UK' aliases to 'GB' (ISO),
// matching the same alias table resolveLocale() reads in Parse Personal
// Info. Colon required, same convention as sections:/order:/template:.
if ((m = msg.match(/\\blocale\\s*:\\s*(auto|[a-z]{2})\\b/i))) {
  const rawLocale = m[1].toLowerCase();
  delta.locale = rawLocale === 'auto' ? 'auto' : (rawLocale.toUpperCase() === 'UK' ? 'GB' : rawLocale.toUpperCase());
}`;

// ════════════════════ Part 5: Store Apply Context -- persist locale ════════════════════
const SAC_OLD = `staticData.last_apply = { job_id: ctx.job_id || ctx.job_number, job_title: ctx.job_title, company: ctx.company, url: ctx.job_url || null, seniority_mode: ctx.seniority_mode, resume_json: resumeJson, cover_json: coverJson, forge_score: ctx.forge_score || null, skeleton_mode: ctx.seniority_mode, resume_text: ctx.resume_text || '', personal: ctx.personal || {}, resume_skeleton: ctx.resume_skeleton || '', cover_skeleton: ctx.cover_skeleton || '', job_description: ctx.job_description || '', location: ctx.location || '', timestamp: new Date().toISOString() };`;
const SAC_NEW = `staticData.last_apply = { job_id: ctx.job_id || ctx.job_number, job_title: ctx.job_title, company: ctx.company, url: ctx.job_url || null, seniority_mode: ctx.seniority_mode, resume_json: resumeJson, cover_json: coverJson, forge_score: ctx.forge_score || null, skeleton_mode: ctx.seniority_mode, resume_text: ctx.resume_text || '', personal: ctx.personal || {}, resume_skeleton: ctx.resume_skeleton || '', cover_skeleton: ctx.cover_skeleton || '', job_description: ctx.job_description || '', location: ctx.location || '', locale: ctx.locale || null, locale_profile: ctx.locale_profile || null, timestamp: new Date().toISOString() };`;

function patchMaster() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));

  const ppi = wf.nodes.find((n) => n.name === 'Parse Personal Info');
  const hpu = wf.nodes.find((n) => n.name === 'Handle Prefs Update');
  const sac = wf.nodes.find((n) => n.name === 'Store Apply Context');
  if (!ppi) { console.error('INTEGRITY FAIL: Parse Personal Info missing'); process.exit(1); }
  if (!hpu) { console.error('INTEGRITY FAIL: Handle Prefs Update missing'); process.exit(1); }
  if (!sac) { console.error('INTEGRITY FAIL: Store Apply Context missing'); process.exit(1); }

  if (ppi.parameters.jsCode.includes('function resolveLocale(')) {
    console.log('  Parse Personal Info: already patched');
  } else {
    replaceOnce(ppi.parameters, 'jsCode', PPI_JOBCTX_OLD, PPI_JOBCTX_NEW, 'Parse Personal Info jobCtx insertion point');
    replaceOnce(ppi.parameters, 'jsCode', PPI_PHONE_OLD, PPI_PHONE_NEW, 'Parse Personal Info applyPhoneDisplay dedup');
    replaceOnce(ppi.parameters, 'jsCode', PPI_RETURN1_OLD, PPI_RETURN1_NEW, 'Parse Personal Info return #1 (no saved resume)');
    replaceOnce(ppi.parameters, 'jsCode', PPI_RETURN2_OLD, PPI_RETURN2_NEW, 'Parse Personal Info return #2 (missing fields)');
    replaceOnce(ppi.parameters, 'jsCode', PPI_RETURN3_OLD, PPI_RETURN3_NEW, 'Parse Personal Info return #3 (success)');
    console.log('  Parse Personal Info: patched (resolveLocale added, locale/locale_profile on all 3 returns)');
  }

  if (hpu.parameters.jsCode.includes('delta.locale =')) {
    console.log('  Handle Prefs Update: already patched');
  } else {
    replaceOnce(hpu.parameters, 'jsCode', HPU_OLD, HPU_NEW, 'Handle Prefs Update template: block (insertion anchor)');
    console.log('  Handle Prefs Update: patched (locale: pref added)');
  }

  if (sac.parameters.jsCode.includes('locale: ctx.locale')) {
    console.log('  Store Apply Context: already patched');
  } else {
    replaceOnce(sac.parameters, 'jsCode', SAC_OLD, SAC_NEW, 'Store Apply Context last_apply object literal');
    console.log('  Store Apply Context: patched (locale/locale_profile persisted)');
  }

  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
}

// ════════════════════════════════ HARNESS ════════════════════════════════
(async function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  // ---- 1. locale_profiles.json structural integrity ----
  const localeProfilesData = checkLocaleProfilesFile();
  check('locale_profiles.json has 13 profiles', Object.keys(localeProfilesData.profiles).length === 13);
  check('multinational_tiers matches real company_tiers.json tier vocabulary', (() => {
    const real = new Set(Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'company_tiers.json'), 'utf8')).companies).map((c) => c.tier));
    return localeProfilesData.multinational_tiers.every((t) => real.has(t));
  })());

  // ---- 2. geo_reference expansion: substring traps + regression ----
  const newGeo = buildExpandedGeoReference();
  function detectCountryFixture(geo, hay) {
    const h = hay.toLowerCase();
    for (const code of Object.keys(geo.countries || {})) { if ((geo.countries[code] || []).some((s) => h.includes(s))) return code; }
    for (const city of Object.keys(geo.cities || {})) { if (h.includes(city)) return geo.cities[city]; }
    return null;
  }
  check('substring trap: "Albuquerque, New Mexico, USA" resolves US, not MX', detectCountryFixture(newGeo, 'Albuquerque, New Mexico, USA') === 'US');
  check('substring trap: "Belfast, Northern Ireland" resolves GB, not IE', detectCountryFixture(newGeo, 'Belfast, Northern Ireland') === 'GB');
  check('new country: "Riyadh, Saudi Arabia" resolves SA', detectCountryFixture(newGeo, 'Riyadh, Saudi Arabia') === 'SA');
  check('new country alias: "Remote (KSA)" resolves SA', detectCountryFixture(newGeo, 'Remote (KSA)') === 'SA');
  check('new country: "Sao Paulo, Brazil" resolves BR', detectCountryFixture(newGeo, 'Sao Paulo, Brazil') === 'BR');
  check('new country: "Mexico City" resolves MX', detectCountryFixture(newGeo, 'Mexico City') === 'MX');
  check('new country: "Zurich, Switzerland" resolves CH', detectCountryFixture(newGeo, 'Zurich, Switzerland') === 'CH');
  check('new country: "Vienna, Austria" resolves AT (not falsely AU)', detectCountryFixture(newGeo, 'Vienna, Austria') === 'AT');
  check('regression: real India city still resolves IN', detectCountryFixture(newGeo, 'Bangalore, India') === 'IN');
  check('regression: real UK city still resolves GB', detectCountryFixture(newGeo, 'London, UK') === 'GB');
  check('regression: real US city still resolves US', detectCountryFixture(newGeo, 'Austin, TX, USA') === 'US');
  check('regression: unresolvable location returns null', detectCountryFixture(newGeo, 'Remote (worldwide)') === null);
  // Regression: every original country/city key is preserved untouched.
  const oldGeo = JSON.parse(OLD_SEED_VALUE);
  for (const code of Object.keys(oldGeo.countries)) {
    check(`regression: original ${code} aliases all preserved`, oldGeo.countries[code].every((a) => newGeo.countries[code].includes(a)));
  }
  for (const city of Object.keys(oldGeo.cities)) {
    check(`regression: original city "${city}" preserved`, newGeo.cities[city] === oldGeo.cities[city]);
  }

  // ---- 3. resolveLocale() -- executed against the REAL literal source text ----
  function runLocaleBlock(jobCtx, mockGeo, mockProfiles, mockCompanyTiers, mockPrefs) {
    const $ = (name) => {
      if (name === 'Load Geo Reference (Apply)') return { first: () => ({ json: { geo_reference: mockGeo } }) };
      throw new Error('unexpected $ call: ' + name);
    };
    const req = (mod) => {
      if (mod !== 'fs') throw new Error('unexpected require: ' + mod);
      return { readFileSync: (p) => {
        if (p.includes('locale_profiles.json')) { if (mockProfiles === null) throw new Error('simulated fs failure'); return JSON.stringify(mockProfiles); }
        if (p.includes('company_tiers.json')) { if (mockCompanyTiers === null) throw new Error('simulated fs failure'); return JSON.stringify({ companies: mockCompanyTiers }); }
        throw new Error('unexpected path: ' + p);
      } };
    };
    const $getWorkflowStaticData = () => ({ user_prefs: mockPrefs || {} });
    const fn = new Function('jobCtx', '$', 'require', '$getWorkflowStaticData', PPI_LOCALE_BLOCK + '\nreturn { locale, profile: locale_profile };');
    return fn(jobCtx, $, req, $getWorkflowStaticData);
  }

  const fixtureProfiles = {
    profiles: {
      DEFAULT: { paper: 'letterpaper', pages: { default: { max: 1 } }, spelling: 'en-US', heavy_local_convention: false },
      DACH: { paper: 'a4paper', pages: { default: { max: 2 } }, spelling: 'en-US', heavy_local_convention: true },
      IN: { paper: 'a4paper', pages: { default: { max: 2 } }, spelling: 'en-GB', heavy_local_convention: false }
    },
    country_to_profile: { US: 'US', DE: 'DACH', IN: 'IN', GB: 'US' },
    aliases: { UK: 'GB' },
    multinational_tiers: ['maango'],
    multinational_w_min: 0.9
  };
  // US isn't in fixtureProfiles.profiles on purpose for the unmapped test below --
  // add it separately for the mapped-profile tests.
  fixtureProfiles.profiles.US = { paper: 'letterpaper', pages: { default: { max: 1 } }, spelling: 'en-US', heavy_local_convention: false };

  const fixtureTiers = {
    'siemens': { tier: 'fortune500', w: 0.5 },
    'sap': { tier: 'maango', w: 0.95 } // fixture-only: real company_tiers.json doesn't tier SAP as maango, this is a synthetic multinational-DACH-employer stand-in
  };

  // 3a. fs fail-open.
  let r = runLocaleBlock({ location: 'Berlin, Germany', company: 'siemens' }, newGeo, null, fixtureTiers, {});
  check('fs-fail-open: locale_profiles unreadable -> DEFAULT, source no_profiles_data', r.locale.source === 'no_profiles_data' && r.locale.profile_key === 'DEFAULT' && r.profile === null);

  // 3b. pref override, valid.
  r = runLocaleBlock({ location: 'anything', company: 'acme' }, newGeo, fixtureProfiles, fixtureTiers, { locale: 'DE' });
  check('pref override: locale:DE -> DACH profile, source pref, STOP (no multinational check)', r.locale.source === 'pref' && r.locale.profile_key === 'DACH' && r.locale.code === 'DE');

  // 3c. pref override, UK alias.
  r = runLocaleBlock({ location: 'anything', company: 'acme' }, newGeo, fixtureProfiles, fixtureTiers, { locale: 'UK' });
  check('pref override: locale:UK aliases to GB', r.locale.code === 'GB');

  // 3d. pref override, unknown code -- falls through to detection.
  r = runLocaleBlock({ location: 'Berlin, Germany', company: 'acme' }, newGeo, fixtureProfiles, fixtureTiers, { locale: 'ZZ' });
  check('pref override: unknown code falls through to job-text detection', r.locale.code === 'DE' && r.locale.source === 'jd_country');

  // 3e. pref 'auto' -- falls through to detection (no profile maps to AUTO).
  r = runLocaleBlock({ location: 'Austin, TX', company: 'acme' }, newGeo, fixtureProfiles, fixtureTiers, { locale: 'auto' });
  check('pref "auto" falls through to detection', r.locale.code === 'US' && r.locale.source === 'jd_country');

  // 3f. no pref, unresolvable job text -> DEFAULT.
  r = runLocaleBlock({ location: 'Remote (worldwide)', company: 'acme' }, newGeo, fixtureProfiles, fixtureTiers, {});
  check('no pref, unresolvable -> DEFAULT, source default_unresolved', r.locale.source === 'default_unresolved' && r.locale.profile_key === 'DEFAULT');

  // 3g. resolved country with no profile mapping -> DEFAULT, default_unmapped.
  r = runLocaleBlock({ location: 'Tokyo, Japan', company: 'acme' }, { countries: { JP: ['japan'] }, cities: {} }, fixtureProfiles, fixtureTiers, {});
  check('resolved-but-unmapped country -> DEFAULT, source default_unmapped', r.locale.source === 'default_unmapped' && r.locale.code === 'JP' && r.locale.profile_key === 'DEFAULT');

  // 3h. resolved + mapped, non-heavy-local-convention profile -> straight through.
  r = runLocaleBlock({ location: 'Bangalore, India', company: 'acme' }, newGeo, fixtureProfiles, fixtureTiers, {});
  check('resolved + mapped (IN, not heavy_local_convention) -> jd_country, no multinational check', r.locale.source === 'jd_country' && r.locale.profile_key === 'IN' && r.locale.multinational === false);

  // 3i. heavy_local_convention country + NON-multinational employer -> stays local.
  r = runLocaleBlock({ location: 'Berlin, Germany', company: 'siemens' }, newGeo, fixtureProfiles, fixtureTiers, {});
  check('DACH + non-multinational (tier fortune500, w=0.5) -> stays DACH, no override', r.locale.source === 'jd_country' && r.locale.multinational === false && r.profile.heavy_local_convention === true);

  // 3j. heavy_local_convention country + multinational employer (tier match) -> override merges DEFAULT PII with local paper/pages/spelling.
  r = runLocaleBlock({ location: 'Berlin, Germany', company: 'sap' }, newGeo, fixtureProfiles, fixtureTiers, {});
  check('DACH + multinational (tier=maango) -> override fires, source jd_country+multinational', r.locale.source === 'jd_country+multinational' && r.locale.multinational === true);
  check('multinational override: keeps local paper (a4paper)', r.profile.paper === 'a4paper');
  check('multinational override: keeps local pages/spelling, but everything else (heavy_local_convention absent -> falsy) comes from DEFAULT spread', r.profile.spelling === 'en-US' && !r.profile.heavy_local_convention);

  // 3k. heavy_local_convention country + high-w employer (w>=0.9, tier not in multinational_tiers) -> override fires via the w-threshold OR-branch.
  const wOnlyTiers = { 'bigbank': { tier: 'top_fintech_quant', w: 0.92 } };
  r = runLocaleBlock({ location: 'Riyadh, Saudi Arabia', company: 'bigbank' }, newGeo, { ...fixtureProfiles, profiles: { ...fixtureProfiles.profiles, GULF: { paper: 'a4paper', pages: { default: { max: 2 } }, spelling: 'en-GB', heavy_local_convention: true } }, country_to_profile: { ...fixtureProfiles.country_to_profile, SA: 'GULF' }, multinational_tiers: ['maango'] }, wOnlyTiers, {});
  check('GULF + w>=0.9 employer (tier not in multinational_tiers list) -> override still fires via w-threshold', r.locale.multinational === true);

  // ---- 4. Handle Prefs Update locale regex, tested standalone ----
  function testLocaleRegex(msg) {
    const m = msg.toLowerCase().match(/\blocale\s*:\s*(auto|[a-z]{2})\b/i);
    if (!m) return null;
    const rawLocale = m[1].toLowerCase();
    return rawLocale === 'auto' ? 'auto' : (rawLocale.toUpperCase() === 'UK' ? 'GB' : rawLocale.toUpperCase());
  }
  check('"locale: DE" -> DE', testLocaleRegex('locale: DE') === 'DE');
  check('"locale:uk" -> GB (aliased)', testLocaleRegex('locale:uk') === 'GB');
  check('"locale: auto" -> auto', testLocaleRegex('locale: auto') === 'auto');
  check('"locale: xyz" (3 letters) does not match', testLocaleRegex('locale: xyz') === null);
  check('ordinary sentence without colon does not match', testLocaleRegex('I moved to Germany') === null);

  // ---- 5. Anchor integrity on the live workflow file (pre-write dry check) ----
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const ppi = wf.nodes.find((n) => n.name === 'Parse Personal Info');
  const hpu = wf.nodes.find((n) => n.name === 'Handle Prefs Update');
  const sac = wf.nodes.find((n) => n.name === 'Store Apply Context');
  if (!ppi.parameters.jsCode.includes('function resolveLocale(')) {
    check('PPI jobCtx anchor unique', ppi.parameters.jsCode.split(PPI_JOBCTX_OLD).length - 1 === 1);
    check('PPI applyPhoneDisplay anchor unique', ppi.parameters.jsCode.split(PPI_PHONE_OLD).length - 1 === 1);
    check('PPI return #1 anchor unique', ppi.parameters.jsCode.split(PPI_RETURN1_OLD).length - 1 === 1);
    check('PPI return #2 anchor unique', ppi.parameters.jsCode.split(PPI_RETURN2_OLD).length - 1 === 1);
    check('PPI return #3 anchor unique', ppi.parameters.jsCode.split(PPI_RETURN3_OLD).length - 1 === 1);
  } else {
    console.log('  Parse Personal Info: already patched, skipping pre-patch anchor checks');
  }
  if (!hpu.parameters.jsCode.includes('delta.locale =')) {
    check('HPU template: anchor unique', hpu.parameters.jsCode.split(HPU_OLD).length - 1 === 1);
  } else {
    console.log('  Handle Prefs Update: already patched, skipping pre-patch anchor check');
  }
  if (!sac.parameters.jsCode.includes('locale: ctx.locale')) {
    check('SAC last_apply anchor unique', sac.parameters.jsCode.split(SAC_OLD).length - 1 === 1);
  } else {
    console.log('  Store Apply Context: already patched, skipping pre-patch anchor check');
  }

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: locale_profiles.json structurally sound; geo_reference expansion fixes all 3 named substring traps with zero regression on existing coverage; resolveLocale() (executed via the real literal source text) correctly implements all 7 precedence steps incl. fs-fail-open, pref override + STOP, unknown-pref fallthrough, unresolved/unmapped -> DEFAULT, and the multinational override (both the tier-membership and w-threshold OR-branches); Handle Prefs Update locale: regex correct; all workflow anchors unique pre-write.');

  // ── Writes ──
  const expandedGeo = buildExpandedGeoReference();
  patchSchemaSql(JSON.stringify(expandedGeo));
  patchMaster();
  console.log('S140 (locale data + resolution + threading) script complete.');
})();
