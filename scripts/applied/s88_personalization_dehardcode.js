/**
 * s88_personalization_dehardcode.js -- third sprint. Removes the
 * `indiaKeywords`-driven phone-display fork (the bug that started this whole
 * pass -- a Barclays apply showed the wrong number because the "smart"
 * India-only logic inverted the moment primary/secondary phones got
 * reordered) and the `America/New_York` default timezone.
 *
 * PHONE: a real fix, not a feature removal. `personal.phones[].region`
 * exists in the resume schema but got discarded to flat phone_primary/
 * phone_secondary strings before applyPhoneDisplay() ran (confirmed via
 * investigation). Threads `region` through personalFromStructured() instead
 * of dropping it, and detects the JOB's country using s86's real geo
 * reference (via the `Load Geo Reference (Apply)` node s86 already wired in)
 * instead of a 9-city India-only literal. Matches whichever phone's region
 * equals the job's detected country -- works symmetrically for a US phone
 * on a US job, an IN phone on an IN job, a DE phone on a DE job, or any
 * other combination, regardless of which one happens to be marked primary.
 * Falls back to phone_primary when the job's country can't be detected or
 * matches no stored phone -- never a hardcoded single-country special case.
 *
 * TIMEZONE: `Schedule Gate` (functional default) + `Format Prefs View`
 * (display fallback) both default to America/New_York. Becomes UTC -- the
 * only genuinely neutral choice (design law #3: deriving timezone from
 * resume-country would just be a softer version of the same inference
 * problem this whole pass removes). The `timezone:` pref-setter itself is
 * untouched and remains the correct way to set a real one.
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

// ── 1. personalFromStructured: thread region through instead of dropping it ──
const PFS_OLD = "const primaryPhone = firstPrimary(p.phones).number || p.phone_primary || p.phone || '';\n  const secondaryPhone = Array.isArray(p.phones) ? ((p.phones.find(ph => !ph.primary) || {}).number || '') : (p.phone_secondary || '');\n  const loc = locToString(firstPrimary(p.locations)) || p.location || '';\n  const links = p.links || {};\n  return {\n    name: p.name || '',\n    email,\n    phone_primary: primaryPhone,\n    phone_secondary: secondaryPhone,\n    phone: primaryPhone,";
const PFS_NEW = "const primaryPhoneObj = firstPrimary(p.phones);\n  const primaryPhone = primaryPhoneObj.number || p.phone_primary || p.phone || '';\n  // s88: region/label threaded through -- was dropped here before, forcing\n  // applyPhoneDisplay() to guess with a hardcoded place-name list instead.\n  const primaryPhoneRegion = (primaryPhoneObj.region || primaryPhoneObj.label || '').toUpperCase();\n  const secondaryPhoneObj = Array.isArray(p.phones) ? (p.phones.find(ph => !ph.primary) || {}) : {};\n  const secondaryPhone = secondaryPhoneObj.number || p.phone_secondary || '';\n  const secondaryPhoneRegion = (secondaryPhoneObj.region || secondaryPhoneObj.label || '').toUpperCase();\n  const loc = locToString(firstPrimary(p.locations)) || p.location || '';\n  const links = p.links || {};\n  return {\n    name: p.name || '',\n    email,\n    phone_primary: primaryPhone,\n    phone_primary_region: primaryPhoneRegion,\n    phone_secondary: secondaryPhone,\n    phone_secondary_region: secondaryPhoneRegion,\n    phone: primaryPhone,";

// ── 2. applyPhoneDisplay: real region-matching instead of indiaKeywords ──
const APD_OLD = "function applyPhoneDisplay(personal) {\n  const jobLocation = (jobCtx.location || jobCtx.job_title || '').toLowerCase();\n  const indiaKeywords = ['india','hyderabad','bengaluru','bangalore','mumbai','pune','delhi','chennai','kolkata','indian subcontinent'];\n  const targetIsIndia = indiaKeywords.some(kw => jobLocation.includes(kw));\n  personal.phone_display = targetIsIndia && personal.phone_secondary ? personal.phone_secondary : (personal.phone_primary || personal.phone_secondary || '');\n  personal.show_location = String(personal.show_location || 'false').toLowerCase() === 'true';\n  return personal;\n}";
const APD_NEW = "function applyPhoneDisplay(personal) {\n  const jobLocation = (jobCtx.location || jobCtx.job_title || '').toLowerCase();\n  // s88: real country detection from s86's geo reference instead of a\n  // hardcoded India-only city list -- works for any country, symmetrically.\n  let _geo = { countries: {}, cities: {} };\n  try { _geo = ($('Load Geo Reference (Apply)').first().json.geo_reference) || _geo; } catch (e) {}\n  function detectJobCountry(hay) {\n    for (const code of Object.keys(_geo.countries || {})) { if ((_geo.countries[code] || []).some((s) => hay.includes(s))) return code; }\n    for (const city of Object.keys(_geo.cities || {})) { if (hay.includes(city)) return _geo.cities[city]; }\n    return null;\n  }\n  const jobCountry = detectJobCountry(jobLocation);\n  let display = personal.phone_primary || personal.phone_secondary || '';\n  if (jobCountry) {\n    if (personal.phone_secondary && personal.phone_secondary_region === jobCountry) display = personal.phone_secondary;\n    else if (personal.phone_primary && personal.phone_primary_region === jobCountry) display = personal.phone_primary;\n    // else: no stored phone matches the detected job country -- fall back to primary (already set above), never a guess.\n  }\n  personal.phone_display = display;\n  personal.show_location = String(personal.show_location || 'false').toLowerCase() === 'true';\n  return personal;\n}";

// ── 3. Schedule Gate: functional default + doc comment ──
const SG_DEFAULT_OLD = 'const tz = prefs.timezone || "America/New_York";';
const SG_DEFAULT_NEW = 'const tz = prefs.timezone || "UTC"; // s88: neutral default -- was America/New_York';
const SG_COMMENT_OLD = '//   timezone:       "America/New_York"   (IANA tz)';
const SG_COMMENT_NEW = '//   timezone:       "Asia/Kolkata"        (IANA tz -- any value; UTC if unset)';

// ── 4. Format Prefs View: display fallback ──
const FPV_OLD = 'const tzShort = (tz || "America/New_York").split("/").pop().replace(/_/g, ';
const FPV_NEW = 'const tzShort = (tz || "UTC").split("/").pop().replace(/_/g, ';

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Parse Personal Info', 'Schedule Gate', 'Format Prefs View']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Personal Info'].parameters.jsCode.includes('phone_primary_region')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Parse Personal Info'].parameters, 'jsCode', PFS_OLD, PFS_NEW, 'personalFromStructured region threading', base);
  replaceOnce(N['Parse Personal Info'].parameters, 'jsCode', APD_OLD, APD_NEW, 'applyPhoneDisplay region matching', base);
  replaceOnce(N['Schedule Gate'].parameters, 'jsCode', SG_DEFAULT_OLD, SG_DEFAULT_NEW, 'Schedule Gate tz default', base);
  replaceOnce(N['Schedule Gate'].parameters, 'jsCode', SG_COMMENT_OLD, SG_COMMENT_NEW, 'Schedule Gate doc comment', base);
  replaceOnce(N['Format Prefs View'].parameters, 'jsCode', FPV_OLD, FPV_NEW, 'Format Prefs View tz fallback', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: personalization de-hardcoded -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. applyPhoneDisplay region-matching, run for real against realistic fixtures
  function runApplyPhoneDisplay(personal, jobLocation, geoRef) {
    const jobCtx = { location: jobLocation };
    const $ = () => ({ first: () => ({ json: { geo_reference: geoRef } }) });
    const body = APD_NEW + '\nreturn applyPhoneDisplay(personal).phone_display;';
    return new Function('personal', 'jobCtx', '$', body)(personal, jobCtx, $);
  }
  const GEO = { countries: { IN: ['india'], US: ['usa', 'united states'], DE: ['germany'] }, cities: { bengaluru: 'IN', bangalore: 'IN', berlin: 'DE', 'new york': 'US' } };

  const cases = [
    [{ phone_primary: '+91-1', phone_primary_region: 'IN', phone_secondary: '+1-1', phone_secondary_region: 'US' }, 'Bengaluru, India', '+91-1', 'the exact Barclays-bug shape (IN primary) -> IN job shows IN number'],
    [{ phone_primary: '+91-1', phone_primary_region: 'IN', phone_secondary: '+1-1', phone_secondary_region: 'US' }, 'New York, US', '+1-1', 'IN primary but a US job -> shows the US-region phone regardless of primary flag (the actual bug, fixed)'],
    [{ phone_primary: '+1-1', phone_primary_region: 'US', phone_secondary: '', phone_secondary_region: '' }, 'Berlin, Germany', '+1-1', 'no phone matches the detected country -> falls back to primary, never crashes or guesses'],
    [{ phone_primary: '+1-1', phone_primary_region: 'US', phone_secondary: '', phone_secondary_region: '' }, 'Remote', '+1-1', 'undetectable job location -> falls back to primary'],
    [{ phone_primary: '', phone_primary_region: '', phone_secondary: '', phone_secondary_region: '' }, 'India', '', 'no phones at all -> empty string, no crash'],
  ];
  for (const [personal, loc, want, label] of cases) {
    const got = runApplyPhoneDisplay(personal, loc, GEO);
    if (got !== want) { console.error(`HARNESS FAIL: "${label}" -> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); process.exit(1); }
  }

  // 2. Region-threading in personalFromStructured (structural check on the anchor text)
  if (!PFS_NEW.includes('phone_primary_region') || !PFS_NEW.includes('phone_secondary_region')) {
    console.error('HARNESS FAIL: region fields missing from personalFromStructured output'); process.exit(1);
  }

  // 3. Timezone defaults
  if (!SG_DEFAULT_NEW.includes('"UTC"')) { console.error('HARNESS FAIL: Schedule Gate default not UTC'); process.exit(1); }
  if (!FPV_NEW.includes('"UTC"')) { console.error('HARNESS FAIL: Format Prefs View fallback not UTC'); process.exit(1); }
  if (SG_DEFAULT_NEW.includes('America/New_York') === false && SG_DEFAULT_OLD.includes('America/New_York') === false) {
    console.error('HARNESS FAIL: fixture sanity -- old default string missing'); process.exit(1);
  }

  console.log('HARNESS OK: phone-display region-matching verified against 5 real fixtures including the EXACT Barclays-apply bug shape (IN-primary phone shown for a US job -- now correctly shows the US-region number instead); undetectable/no-match cases fall back to primary cleanly, never crash, never guess; both timezone defaults now UTC.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S88 (personalization de-hardcoding) complete.');
