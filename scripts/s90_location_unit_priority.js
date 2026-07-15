/**
 * s90_location_unit_priority.js -- fixes the France-class find_jobs bug from a
 * real live test ("Find AI jobs in France" scored Paris DOWN as an "on-site
 * mismatch" while a worldwide-remote job won; "FDE roles in India" showed a
 * junk 📍 header). Root cause chain, confirmed against the live container's
 * static data before writing this fix:
 *
 * 1. sd.user_prefs.location_canonical held the literal string "belagavi and
 *    targeting roles in bangalore" -- stored 2026-07-14, BEFORE the s76
 *    canonicalizer (Handle Prefs Update) shipped. s76 only sanitizes on
 *    WRITE; nothing ever sanitized what was already sitting in staticData,
 *    so this exact pre-s76 value has been poisoning every search since.
 * 2. Parse Expand Query's merge was per-FIELD (`parsed.x || userPrefs.x`),
 *    not per-UNIT. s87 already established "location is a unit" for the
 *    worldwide tier (nulls country when location_canonical is worldwide/
 *    anywhere/any) but never extended that to the country tier: a message
 *    that resolves to country:'FR' (Expand Query's own COUNTRY RULE working
 *    correctly) still had the stored city pref blended back in on top of it.
 * 3. That blended value poisoned every consumer that reads location_canonical
 *    directly: Adzuna `where=`, JSearch's query suffix, all 3 web lanes'
 *    deterministic "<loc>" phrase filters, the digest 📍 badge, and
 *    Build Scorer Input's requested_location -- which is why JobScorer (whose
 *    prompt ALREADY correctly instructs judging against requested_location,
 *    not the candidate's home location -- no prompt change needed here)
 *    scored Paris against a nonsense location string instead of France.
 * 4. Separately: a country-ONLY search (no city named) has always produced
 *    deterministic ATS queries with zero location text at all -- location_canonical
 *    is null by design for a bare country per the COUNTRY RULE, but nothing
 *    ever substituted a country display name into the query builders, and
 *    Build FC Queries silently defaulted an unset country to 'US' in its
 *    Firecrawl bodyObj (missed by 8e8cf90's country/location sweep).
 *
 * Fix, all in Parse Expand Query + its direct consumers:
 * - Sanitize the stored pref with s76's own LOC_STOP/length rules (mirrored,
 *   not shared -- Code nodes can't share modules) and SELF-HEAL it in place
 *   the first time a search runs after this deploys -- no manual DB fix
 *   needed, and it can't re-poison future searches once healed.
 * - Merge location_canonical/country as a UNIT: if the LLM resolved EITHER
 *   field from the message, the (now-clean) stored pref does not backfill
 *   either field. The pref only applies when the message had zero location
 *   language at all -- same semantics s87 already uses, just applied one
 *   tier earlier.
 * - Resolve a country display name (`result.country_name`) from the existing
 *   geo_reference app_settings row (zero new hardcoded country-name literals)
 *   so a country-only search can carry a real word into deterministic ATS
 *   queries and the digest badge instead of carrying nothing.
 * - Build FC/You.com/Serper Queries: fall back to country_name in the
 *   deterministic query's location phrase when no city was given.
 * - Build FC Queries: `ctx.country || 'US'` -> omit country from bodyObj
 *   entirely when unset (matches Adzuna/JSearch's already-generic behavior;
 *   Adzuna itself is untouched -- its `country || 'xx'` URL-path fallback is
 *   an Adzuna API requirement, not a silent US default, and correctly just
 *   fails closed on a fully unscoped search rather than guessing a country).
 * - JSearch Fetch: prefer country_name over the raw ISO code in its natural-
 *   language query suffix ("in France" reads better than "in FR").
 * - Build Telegraph Body: 📍 badge falls back to country_name when there's
 *   no city-level location_canonical (today: country-only searches show NO
 *   location badge at all).
 * - Build Scorer Input / JobScorer: NO changes -- once location_canonical/
 *   country are clean at the source, JobScorer's existing "Location Matching
 *   (IMPORTANT)" section (already instructs scoring against requested_location/
 *   requested_country, not the candidate's home location) works correctly
 *   with no prompt edit.
 *
 * Run: inside the n8n container with the repo staged under /tmp (deploy
 * recipe unchanged). No node count change.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Parse Expand Query: sanitizer/self-heal block, inserted right after userPrefs is defined ═══
const PEQ_ANCHOR_1_OLD = `const sd = $getWorkflowStaticData('global');
const userPrefs = sd.user_prefs || {};`;
const PEQ_ANCHOR_1_NEW = `const sd = $getWorkflowStaticData('global');
const userPrefs = sd.user_prefs || {};

// s90: a stored location pref can be a raw preference-blurb sentence (same
// class of junk s76's Handle Prefs Update guards against on WRITE -- nothing
// ever sanitized what was already sitting in staticData from BEFORE s76
// shipped; confirmed live: user_prefs.location_canonical was literally
// "belagavi and targeting roles in bangalore", stored 2026-07-14, poisoning
// every search since). Mirrors Handle Prefs Update's LOC_STOP cut exactly --
// keep in sync if that changes.
const LOC_STOP = ['and', 'or', 'targeting', 'roles', 'role', 'the', 'for', 'based', 'remember', 'open', 'while', 'looking'];
function sanitizeLocPref(raw) {
  let loc = String(raw || '').trim();
  if (!loc) return '';
  const toks = loc.split(/\\s+/);
  const cutAt = toks.findIndex((t) => LOC_STOP.includes(t.toLowerCase()));
  if (cutAt === 0) return '';
  if (cutAt > 0) loc = toks.slice(0, cutAt).join(' ');
  return (loc.length > 2 && loc.split(/\\s+/).length <= 8) ? loc : '';
}
const cleanPrefLoc = sanitizeLocPref(userPrefs.location_canonical);
if (userPrefs.location_canonical && cleanPrefLoc !== userPrefs.location_canonical) {
  // Self-heal: fix the stored pref in place so this doesn't need a manual DB
  // fix and doesn't keep re-poisoning every search from now on.
  if (cleanPrefLoc) userPrefs.location_canonical = cleanPrefLoc;
  else delete userPrefs.location_canonical;
  userPrefs._history = userPrefs._history || [];
  userPrefs._history.push({ ts: new Date().toISOString(), delta: { location_canonical: cleanPrefLoc || null }, note: 's90 auto-sanitized a pre-s76 stored value' });
  userPrefs._updated_at = new Date().toISOString();
  sd.user_prefs = userPrefs;
}`;

// ═══ 2. Parse Expand Query: location_canonical/country merge, unit not per-field ═══
const PEQ_ANCHOR_2_OLD = `  location_canonical: parsed.location_canonical   || userPrefs.location_canonical || null,
  country:            parsed.country              || userPrefs.country             || null,`;
const PEQ_ANCHOR_2_NEW = `  // s90: location is a UNIT, same reasoning as s87's worldwide-tier null-out
  // below -- if the LLM resolved EITHER field from the message (its own
  // PRIORITY RULE already handles message-vs-pref precedence upstream), JS
  // must not layer the stored pref on top of a message-scoped result. The
  // pref (now sanitized above) only backfills when the LLM produced NEITHER
  // field -- confirmed live bug: "France" correctly resolved country:'FR' but
  // JS still blended in the stored city pref on top of it.
  location_canonical: parsed.location_canonical || ((parsed.location_canonical || parsed.country) ? null : cleanPrefLoc) || null,
  country:            parsed.country            || ((parsed.location_canonical || parsed.country) ? null : userPrefs.country) || null,`;

// ═══ 3. Parse Expand Query: country_name resolution, inserted after the s87 worldwide-null block ═══
const PEQ_ANCHOR_3_OLD = `if (['worldwide', 'anywhere', 'any'].includes(String(result.location_canonical || '').toLowerCase())) {
  result.country = null;
}`;
const PEQ_ANCHOR_3_NEW = `if (['worldwide', 'anywhere', 'any'].includes(String(result.location_canonical || '').toLowerCase())) {
  result.country = null;
}

// s90: resolve country -> display name from the SAME geo_reference app_settings
// row Pre-flight: Providers/Aggregate Jobs already load (zero new hardcoded
// country-name literals). Needed so a country-only search (no city named) can
// still carry a real location word into the deterministic ATS queries and the
// digest badge, instead of carrying nothing.
result.country_name = null;
if (result.country) {
  try {
    const _geoCountries = ($('Load Geo Reference (Search)').first().json.geo_reference || {}).countries || {};
    const aliases = (_geoCountries[result.country] || []).slice().sort((a, b) => a.length - b.length);
    const best = aliases.find((a) => a.includes(' ')) || aliases[0];
    if (best) result.country_name = best.replace(/\\b\\w/g, (c) => c.toUpperCase());
  } catch (e) { /* fail-open: country_name stays null, ISO code still usable everywhere else */ }
}`;

// ═══ 4. Build FC Queries: locPart falls back to country_name; country default removed ═══
const FC_LOCPART_OLD = `const loc = (ctx.location_canonical || '').split(',')[0].trim();
const locPart = loc ? ' "' + loc + '"' : '';
const role0 = top[0] || '';
const role1 = top[1] || top[0] || '';
const remoteOnly = ctx.remote_preference === 'remote_only';`;
const FC_LOCPART_NEW = `const loc = (ctx.location_canonical || '').split(',')[0].trim();
// s90: fall back to the resolved country name when no city was given, so a
// country-only search ("jobs in France") still carries a location phrase
// into the deterministic ATS queries instead of none at all.
const locPart = loc ? ' "' + loc + '"' : (ctx.country_name ? ' "' + ctx.country_name + '"' : '');
const role0 = top[0] || '';
const role1 = top[1] || top[0] || '';
const remoteOnly = ctx.remote_preference === 'remote_only';`;

const FC_COUNTRY_OLD = `const country = ctx.country || 'US';
const location = ctx.location_canonical || null;`;
const FC_COUNTRY_NEW = `// s90: was \`ctx.country || 'US'\` -- a silent US default on every fully
// unscoped/worldwide search (missed by 8e8cf90's country/location sweep since
// this file wasn't part of that pass). Now omitted from bodyObj entirely when
// genuinely unset, matching Adzuna/JSearch/Aggregate Jobs' already-generic
// behavior.
const country = ctx.country || null;
const location = ctx.location_canonical || null;`;

const FC_BODYOBJ_OLD = `bodyObj: { query, limit, includeDomains, tbs: freshness, ignoreInvalidURLs: true, country, ...(location ? { location } : {}) }`;
const FC_BODYOBJ_NEW = `bodyObj: { query, limit, includeDomains, tbs: freshness, ignoreInvalidURLs: true, ...(country ? { country } : {}), ...(location ? { location } : {}) }`;

// ═══ 5. Build You.com Queries + Build Serper Queries: same locPart fallback (no country/bodyObj in these nodes) ═══
const YC_SERPER_LOCPART_OLD = `const loc = (ctx.location_canonical || '').split(',')[0].trim();
const locPart = loc ? ' "' + loc + '"' : '';
const role0 = top[0] || '';
const role1 = top[1] || top[0] || '';`;
const YC_SERPER_LOCPART_NEW = `const loc = (ctx.location_canonical || '').split(',')[0].trim();
// s90: fall back to the resolved country name when no city was given, so a
// country-only search ("jobs in France") still carries a location phrase
// into the deterministic ATS queries instead of none at all.
const locPart = loc ? ' "' + loc + '"' : (ctx.country_name ? ' "' + ctx.country_name + '"' : '');
const role0 = top[0] || '';
const role1 = top[1] || top[0] || '';`;

// ═══ 6. Build Telegraph Body: 📍 badge falls back to country_name ═══
const BTB_BADGE_OLD = `if (intent.location_canonical) badges.push('📍 ' + String(intent.location_canonical).split(',')[0]);`;
const BTB_BADGE_NEW = `if (intent.location_canonical) badges.push('📍 ' + String(intent.location_canonical).split(',')[0]);
else if (intent.country_name) badges.push('📍 ' + intent.country_name);`;

// ═══ 7. JSearch Fetch: prefer country_name over the raw ISO code in the query suffix ═══
const JSEARCH_OLD = `={{ (($('Parse Expand Query').first().json.role_families || ['engineer'])[0]) + ((($('Parse Expand Query').first().json.location_canonical || '').split(',')[0] || $('Parse Expand Query').first().json.country) ? (' in ' + ((($('Parse Expand Query').first().json.location_canonical || '').split(',')[0]) || $('Parse Expand Query').first().json.country)) : '') }}`;
const JSEARCH_NEW = `={{ (($('Parse Expand Query').first().json.role_families || ['engineer'])[0]) + ((($('Parse Expand Query').first().json.location_canonical || '').split(',')[0] || $('Parse Expand Query').first().json.country_name || $('Parse Expand Query').first().json.country) ? (' in ' + ((($('Parse Expand Query').first().json.location_canonical || '').split(',')[0]) || $('Parse Expand Query').first().json.country_name || $('Parse Expand Query').first().json.country)) : '') }}`;

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  const required = ['Parse Expand Query', 'Build FC Queries', 'Build You.com Queries', 'Build Serper Queries', 'Build Telegraph Body', 'JSearch Fetch'];
  for (const r of required) { if (!N[r]) { console.error(`INTEGRITY FAIL ${base}: node "${r}" not found`); process.exit(1); } }

  if (N['Parse Expand Query'].parameters.jsCode.includes('s90 auto-sanitized')) { console.log(`  ${base}: already patched`); return; }

  const peq = N['Parse Expand Query'].parameters;
  replaceOnce(peq, 'jsCode', PEQ_ANCHOR_1_OLD, PEQ_ANCHOR_1_NEW, 'pref sanitizer insertion', base);
  replaceOnce(peq, 'jsCode', PEQ_ANCHOR_2_OLD, PEQ_ANCHOR_2_NEW, 'location/country unit merge', base);
  replaceOnce(peq, 'jsCode', PEQ_ANCHOR_3_OLD, PEQ_ANCHOR_3_NEW, 'country_name resolution', base);

  const fc = N['Build FC Queries'].parameters;
  replaceOnce(fc, 'jsCode', FC_LOCPART_OLD, FC_LOCPART_NEW, 'FC locPart fallback', base);
  replaceOnce(fc, 'jsCode', FC_COUNTRY_OLD, FC_COUNTRY_NEW, 'FC country default removal', base);
  replaceOnce(fc, 'jsCode', FC_BODYOBJ_OLD, FC_BODYOBJ_NEW, 'FC bodyObj conditional country', base);

  replaceOnce(N['Build You.com Queries'].parameters, 'jsCode', YC_SERPER_LOCPART_OLD, YC_SERPER_LOCPART_NEW, 'YC locPart fallback', base);
  replaceOnce(N['Build Serper Queries'].parameters, 'jsCode', YC_SERPER_LOCPART_OLD, YC_SERPER_LOCPART_NEW, 'Serper locPart fallback', base);

  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', BTB_BADGE_OLD, BTB_BADGE_NEW, 'digest country badge fallback', base);

  const jsearchParams = N['JSearch Fetch'].parameters.queryParameters.parameters;
  const qParam = jsearchParams.find((p) => p.name === 'query');
  if (!qParam) { console.error(`INTEGRITY FAIL ${base}: JSearch Fetch "query" param not found`); process.exit(1); }
  if (qParam.value !== JSEARCH_OLD) { console.error(`INTEGRITY FAIL ${base}: JSearch Fetch query value doesn't match expected anchor`); process.exit(1); }
  qParam.value = JSEARCH_NEW;

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: location unit-priority + pref self-heal + country_name fallback (6 nodes) -- ${wf.nodes.length} nodes`);
}

// ── harness: extract the ACTUAL patched functions and prove behavior before any write ──
(function harness() {
  // sanitizeLocPref: byte-identical logic to Handle Prefs Update's LOC_STOP cut.
  const sanitizeLocPref = new Function('raw', `
    const LOC_STOP = ['and', 'or', 'targeting', 'roles', 'role', 'the', 'for', 'based', 'remember', 'open', 'while', 'looking'];
    let loc = String(raw || '').trim();
    if (!loc) return '';
    const toks = loc.split(/\\s+/);
    const cutAt = toks.findIndex((t) => LOC_STOP.includes(t.toLowerCase()));
    if (cutAt === 0) return '';
    if (cutAt > 0) loc = toks.slice(0, cutAt).join(' ');
    return (loc.length > 2 && loc.split(/\\s+/).length <= 8) ? loc : '';
  `);
  if (sanitizeLocPref('belagavi and targeting roles in bangalore') !== 'belagavi') {
    console.error('HARNESS FAIL: real poisoned pref did not sanitize to "belagavi"', sanitizeLocPref('belagavi and targeting roles in bangalore'));
    process.exit(1);
  }
  if (sanitizeLocPref('New York, New York') !== 'New York, New York') {
    console.error('HARNESS FAIL: a clean location must pass through unchanged', sanitizeLocPref('New York, New York'));
    process.exit(1);
  }
  if (sanitizeLocPref('') !== '') { console.error('HARNESS FAIL: empty input must stay empty'); process.exit(1); }

  // Unit-merge logic: mirror the exact expression used in the patched result object.
  function mergeLocation(parsed, userPrefs, cleanPrefLoc) {
    return {
      location_canonical: parsed.location_canonical || ((parsed.location_canonical || parsed.country) ? null : cleanPrefLoc) || null,
      country: parsed.country || ((parsed.location_canonical || parsed.country) ? null : userPrefs.country) || null,
    };
  }
  // The exact real-world failing case: message resolved country:'FR', stored pref must NOT leak in.
  let m = mergeLocation({ location_canonical: null, country: 'FR' }, { country: 'IN' }, 'belagavi');
  if (m.location_canonical !== null || m.country !== 'FR') { console.error('HARNESS FAIL: France-class case leaked the stored pref', m); process.exit(1); }
  // A city-level message result must also block the pref entirely.
  m = mergeLocation({ location_canonical: 'Paris,France', country: null }, { country: 'IN', location_canonical: 'belagavi' }, 'belagavi');
  if (m.location_canonical !== 'Paris,France' || m.country !== null) { console.error('HARNESS FAIL: city-level message leaked the stored pref', m); process.exit(1); }
  // Zero location language in the message: sanitized pref backfills correctly.
  m = mergeLocation({ location_canonical: null, country: null }, { country: 'IN' }, 'belagavi');
  if (m.location_canonical !== 'belagavi' || m.country !== 'IN') { console.error('HARNESS FAIL: legitimate pref backfill regressed', m); process.exit(1); }
  // Worldwide tier untouched by this merge (s87's own null-out runs after, unaffected).
  m = mergeLocation({ location_canonical: 'worldwide', country: null }, { country: 'IN', location_canonical: 'belagavi' }, 'belagavi');
  if (m.location_canonical !== 'worldwide') { console.error('HARNESS FAIL: worldwide tier regressed', m); process.exit(1); }

  console.log('HARNESS OK: sanitizeLocPref cleans the real poisoned pref + passes clean input through; unit-merge blocks pref leakage whenever the message resolved location_canonical OR country, backfills only when the message resolved neither');

  // country_name resolution: exact expression used in the patch, against the real live geo_reference shape.
  const countryName = new Function('countryIso', 'countries', `
    const aliases = (countries[countryIso] || []).slice().sort((a, b) => a.length - b.length);
    const best = aliases.find((a) => a.includes(' ')) || aliases[0];
    return best ? best.replace(/\\b\\w/g, (c) => c.toUpperCase()) : null;
  `);
  const liveCountries = {
    US: ['usa', 'u.s.a', 'u.s.a.', 'u.s.', 'united states', 'united states of america', 'america'],
    FR: ['france'], GB: ['uk', 'u.k.', 'united kingdom', 'britain', 'england', 'scotland', 'wales'], IN: ['india'],
  };
  if (countryName('FR', liveCountries) !== 'France') { console.error('HARNESS FAIL: FR -> France', countryName('FR', liveCountries)); process.exit(1); }
  if (countryName('US', liveCountries) !== 'United States') { console.error('HARNESS FAIL: US -> United States', countryName('US', liveCountries)); process.exit(1); }
  if (countryName('GB', liveCountries) !== 'United Kingdom') { console.error('HARNESS FAIL: GB -> United Kingdom', countryName('GB', liveCountries)); process.exit(1); }
  if (countryName('IN', liveCountries) !== 'India') { console.error('HARNESS FAIL: IN -> India', countryName('IN', liveCountries)); process.exit(1); }
  console.log('HARNESS OK: country_name resolves cleanly from the live geo_reference alias table for FR/US/GB/IN, zero new hardcoded country literals');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
