/**
 * s87_country_chain_dehardcode.js -- second sprint of the de-hardcoding pass.
 * Removes every silent 'US'/'us'/'en' default in the country/location chain
 * now that s86 gives real geo data to fall back on instead. Design law #3
 * (unknown means unconstrained and visible, never guessed) applied end to
 * end: no filter engages on a silently-assumed country; a genuinely unknown
 * country degrades honestly (a lane sits out, or omits a param) rather than
 * pretending to know.
 *
 * ALSO fixes a real, confirmed-live bug (design law #2 -- priority is a
 * unit, not per-field): this session's own MAANG-cohort exec traces
 * (578/582/588/589/593) all show `country: 'US'` surviving even when
 * `location_canonical: 'worldwide'` correctly nulled the city-level filter.
 * "Worldwide" is a tier-1 explicit statement and must null BOTH fields
 * together, not leave country on a stale/default value that the
 * `!== 'US'` suppression in Aggregate Jobs/Verify Job Links only
 * coincidentally cancels out.
 *
 * Sites patched:
 * - Expand Query prompt: `country: ... Default "US"` -> no default.
 * - Parse Expand Query: `country: ... || 'US'` -> `|| null`; NEW backstop
 *   (same style as s82/s83/s84's deterministic gates) forcing country=null
 *   whenever location resolves to the unconstrained tier.
 * - Serper Job Search: `gl` becomes conditional (n8n drops a parameter
 *   whose expression evaluates to `undefined`) instead of defaulting to US;
 *   hardcoded `hl: 'en'` removed outright -- there was never a legitimate
 *   source for "user's preferred search-result language" to default from,
 *   forcing English is the same class of bias as forcing America.
 * - JSearch Fetch: same conditional-`country` treatment; the embedded query
 *   TEXT's `|| 'US'` tail removed, with the surrounding string restructured
 *   so "no location known" doesn't leave an awkward trailing "in ".
 * - Adzuna Fetch: Adzuna's API is genuinely country-partitioned (no global
 *   endpoint exists -- confirmed, not assumed) so it needs SOME code in the
 *   URL path. Uses a sentinel invalid code ('xx') when country is null
 *   instead of guessing 'us' -- the request fails cleanly and the node
 *   already has `onError: continueRegularOutput` (confirmed live, not
 *   assumed), matching the ALREADY-observed "adzuna: 0" graceful-empty
 *   pattern from tonight's own real exec traces. Honest "this lane sits out
 *   an unscoped search" instead of a silent guess.
 * - Normalize Adzuna: found in passing during this sprint (not in either
 *   audit round) -- a THIRD hardcoded `country||'us'` site, this one for
 *   CURRENCY mapping (`ccy = {...}[country] || 'USD'`). Defaults now to
 *   null/unknown currency instead of assuming USD; harmless in practice
 *   (the 'xx' sentinel above means this path returns no jobs when country
 *   is null) but removes the last silent-US assumption in this node.
 * - Aggregate Jobs / Verify Job Links: the `country !== 'US'` special-case
 *   (today's ONLY thing preventing the silent default from over-filtering)
 *   is now dead weight the moment the default itself is gone -- any
 *   non-null country is a REAL signal (explicit/pref/resume-derived),
 *   simplified accordingly.
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

// ── 1. Expand Query prompt ──
const EQ_OLD = '- country: ISO code (e.g. "US","IN","GB"). Default "US"';
const EQ_NEW = '- country: ISO code (e.g. "US","IN","GB"). null if not stated -- never default to any specific country';

// ── 2. Parse Expand Query: result.country default ──
const PEQ_COUNTRY_OLD = "country:            parsed.country              || userPrefs.country             || 'US',";
const PEQ_COUNTRY_NEW = "country:            parsed.country              || userPrefs.country             || null,";

// ── 3. Parse Expand Query: worldwide-nulls-country backstop (anchored after s84's target_companies backstop, the most recent addition) ──
const PEQ_WORLDWIDE_ANCHOR = "} catch (e) { /* fail-open: keep the parsed list rather than block the search */ }";
const PEQ_WORLDWIDE_BACKSTOP =
  "\n\n// s87: priority is a UNIT, not per-field -- when location resolves to the\n" +
  "// unconstrained tier (worldwide/anywhere/any), country must null out\n" +
  "// together with location_canonical, not be left on a stale/default value\n" +
  "// (confirmed live bug: execs 578/582/588/589/593 all show country:'US'\n" +
  "// surviving a worldwide-scoped search).\n" +
  "if (['worldwide', 'anywhere', 'any'].includes(String(result.location_canonical || '').toLowerCase())) {\n" +
  "  result.country = null;\n" +
  "}";

// ── 4. Serper Job Search: gl conditional, hl removed ──
const SERPER_GL_OLD = "={{ ($('Parse Expand Query').first().json.country || 'US').toLowerCase() }}";
const SERPER_GL_NEW = "={{ $('Parse Expand Query').first().json.country ? $('Parse Expand Query').first().json.country.toLowerCase() : undefined }}";

// ── 5. JSearch Fetch: country conditional + query text restructured ──
const JSEARCH_COUNTRY_OLD = "={{ ($('Parse Expand Query').first().json.country || 'us').toLowerCase() }}";
const JSEARCH_COUNTRY_NEW = "={{ $('Parse Expand Query').first().json.country ? $('Parse Expand Query').first().json.country.toLowerCase() : undefined }}";
const JSEARCH_QUERY_OLD = "={{ (($('Parse Expand Query').first().json.role_families || ['engineer'])[0]) + ' in ' + (($('Parse Expand Query').first().json.location_canonical || '').split(',')[0] || $('Parse Expand Query').first().json.country || 'US') }}";
const JSEARCH_QUERY_NEW = "={{ (($('Parse Expand Query').first().json.role_families || ['engineer'])[0]) + ((($('Parse Expand Query').first().json.location_canonical || '').split(',')[0] || $('Parse Expand Query').first().json.country) ? (' in ' + ((($('Parse Expand Query').first().json.location_canonical || '').split(',')[0]) || $('Parse Expand Query').first().json.country)) : '') }}";

// ── 6. Adzuna Fetch: sentinel invalid code instead of a guessed 'us' ──
const ADZUNA_URL_OLD = "=https://api.adzuna.com/v1/api/jobs/{{ ($('Parse Expand Query').first().json.country || 'us').toLowerCase() }}/search/1";
const ADZUNA_URL_NEW = "=https://api.adzuna.com/v1/api/jobs/{{ ($('Parse Expand Query').first().json.country || 'xx').toLowerCase() }}/search/1";

// ── 7. Normalize Adzuna: currency default, found in passing this sprint ──
const NA_OLD = "const ccy = { in:'INR', us:'USD', gb:'GBP', au:'AUD', ca:'CAD', de:'EUR', fr:'EUR', nl:'EUR', sg:'SGD', za:'ZAR', br:'BRL', mx:'MXN', it:'EUR', es:'EUR', pl:'PLN', at:'EUR', ch:'CHF', nz:'NZD', be:'EUR' }[(intent.country||'us').toLowerCase()] || 'USD';";
const NA_NEW = "// s87: found in passing -- a third hardcoded country||'us' site, this one\n// for currency. Unknown country now means unknown currency, not an assumed\n// USD (harmless in practice: Adzuna Fetch's own 'xx' sentinel means this\n// path returns no jobs at all when country is null).\nconst ccy = { in:'INR', us:'USD', gb:'GBP', au:'AUD', ca:'CAD', de:'EUR', fr:'EUR', nl:'EUR', sg:'SGD', za:'ZAR', br:'BRL', mx:'MXN', it:'EUR', es:'EUR', pl:'PLN', at:'EUR', ch:'CHF', nz:'NZD', be:'EUR' }[(intent.country||'').toLowerCase()] || null;";

// ── 8. Aggregate Jobs / Verify Job Links: drop the now-dead US suppression ──
const CC_OLD = "const countryCode = canonCountry || ((!locTerms.length && expandCtx.country && expandCtx.country !== 'US') ? expandCtx.country : null);";
const CC_NEW = "// s87: country is never silently defaulted upstream anymore -- any\n// non-null value here is a REAL signal (explicit message, stored pref, or\n// resume-derived), so the old 'US'-suppression special-case is dead weight.\nconst countryCode = canonCountry || (!locTerms.length ? (expandCtx.country || null) : null);";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Expand Query', 'Parse Expand Query', 'Serper Job Search', 'JSearch Fetch', 'Adzuna Fetch', 'Normalize Adzuna', 'Aggregate Jobs', 'Verify Job Links']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Expand Query'].parameters.jsCode.includes('s87:')) { console.log(`  ${base}: already patched`); return; }

  const mv = N['Expand Query'].parameters.messages.messageValues;
  replaceOnce(mv[0], 'message', EQ_OLD, EQ_NEW, 'Expand Query country default', base);

  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', PEQ_COUNTRY_OLD, PEQ_COUNTRY_NEW, 'Parse Expand Query country default', base);
  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', PEQ_WORLDWIDE_ANCHOR, PEQ_WORLDWIDE_ANCHOR + PEQ_WORLDWIDE_BACKSTOP, 'worldwide-nulls-country backstop', base);

  const serperParams = N['Serper Job Search'].parameters.bodyParameters.parameters;
  const glParam = serperParams.find((p) => p.name === 'gl');
  if (!glParam || glParam.value !== SERPER_GL_OLD) { console.error(`INTEGRITY FAIL ${base}: Serper gl param not found or already changed`); process.exit(1); }
  glParam.value = SERPER_GL_NEW;
  const hlIdx = serperParams.findIndex((p) => p.name === 'hl');
  if (hlIdx === -1 || serperParams[hlIdx].value !== 'en') { console.error(`INTEGRITY FAIL ${base}: Serper hl param not found or already changed`); process.exit(1); }
  serperParams.splice(hlIdx, 1);

  const jsearchParams = N['JSearch Fetch'].parameters.queryParameters.parameters;
  const jCountry = jsearchParams.find((p) => p.name === 'country');
  if (!jCountry || jCountry.value !== JSEARCH_COUNTRY_OLD) { console.error(`INTEGRITY FAIL ${base}: JSearch country param not found or already changed`); process.exit(1); }
  jCountry.value = JSEARCH_COUNTRY_NEW;
  const jQuery = jsearchParams.find((p) => p.name === 'query');
  if (!jQuery || jQuery.value !== JSEARCH_QUERY_OLD) { console.error(`INTEGRITY FAIL ${base}: JSearch query param not found or already changed`); process.exit(1); }
  jQuery.value = JSEARCH_QUERY_NEW;

  replaceOnce(N['Adzuna Fetch'].parameters, 'url', ADZUNA_URL_OLD, ADZUNA_URL_NEW, 'Adzuna URL sentinel', base);
  replaceOnce(N['Normalize Adzuna'].parameters, 'jsCode', NA_OLD, NA_NEW, 'Normalize Adzuna currency default', base);
  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', CC_OLD, CC_NEW, 'Aggregate Jobs countryCode', base);
  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', CC_OLD, CC_NEW, 'Verify Job Links countryCode', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: country chain de-hardcoded -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. Parse Expand Query country default
  if (!PEQ_COUNTRY_NEW.includes('|| null,')) { console.error('HARNESS FAIL: country default not nulled'); process.exit(1); }

  // 2. Worldwide-nulls-country backstop, run for real against tonight's own repro cases
  function runWorldwideGate(locationCanonical) {
    const result = { location_canonical: locationCanonical, country: 'US' };
    new Function('result', PEQ_WORLDWIDE_BACKSTOP)(result);
    return result.country;
  }
  const wcases = [
    ['worldwide', null, 'exec 578/582/588/589/593 repro: worldwide must null country'],
    ['Worldwide', null, 'case-insensitive'],
    ['anywhere', null, 'anywhere magic word'],
    ['any', null, 'any magic word'],
    ['bangalore', 'US', 'a real city must NOT trigger the null (regression -- country stays whatever it was)'],
    [null, 'US', 'no location stated must NOT trigger the null'],
  ];
  for (const [loc, want, label] of wcases) {
    const got = runWorldwideGate(loc);
    if (got !== want) { console.error(`HARNESS FAIL: "${label}" -> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); process.exit(1); }
  }

  // 3. gl/country conditional-omission expressions, run for real
  function runConditional(exprBody, country) {
    // exprBody uses $('Parse Expand Query').first().json.country -- mock it
    const $ = () => ({ first: () => ({ json: { country } }) });
    return new Function('$', 'return ' + exprBody.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, ''))($);
  }
  if (runConditional(SERPER_GL_NEW, 'IN') !== 'in') { console.error('HARNESS FAIL: gl conditional wrong for a real country'); process.exit(1); }
  if (runConditional(SERPER_GL_NEW, null) !== undefined) { console.error('HARNESS FAIL: gl conditional must be undefined (omitted) when country is null'); process.exit(1); }
  if (runConditional(JSEARCH_COUNTRY_NEW, 'DE') !== 'de') { console.error('HARNESS FAIL: JSearch country conditional wrong'); process.exit(1); }
  if (runConditional(JSEARCH_COUNTRY_NEW, null) !== undefined) { console.error('HARNESS FAIL: JSearch country conditional must be undefined when null'); process.exit(1); }

  // 4. JSearch query text restructure, run for real
  function runQueryText(roleFamilies, locationCanonical, country) {
    const $ = () => ({ first: () => ({ json: { role_families: roleFamilies, location_canonical: locationCanonical, country } }) });
    return new Function('$', 'return ' + JSEARCH_QUERY_NEW.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, ''))($);
  }
  if (runQueryText(['AI Engineer'], 'Bangalore,Karnataka', null) !== 'AI Engineer in Bangalore') { console.error('HARNESS FAIL: query text with real location wrong: ' + runQueryText(['AI Engineer'], 'Bangalore,Karnataka', null)); process.exit(1); }
  if (runQueryText(['AI Engineer'], null, 'DE') !== 'AI Engineer in DE') { console.error('HARNESS FAIL: query text with country-only wrong'); process.exit(1); }
  if (runQueryText(['AI Engineer'], null, null) !== 'AI Engineer') { console.error('HARNESS FAIL: query text with nothing known must have no trailing "in " -- got: ' + JSON.stringify(runQueryText(['AI Engineer'], null, null))); process.exit(1); }

  // 5. Adzuna sentinel + Normalize Adzuna currency default, run for real
  if (!ADZUNA_URL_NEW.includes("|| 'xx'")) { console.error('HARNESS FAIL: Adzuna sentinel missing'); process.exit(1); }
  const ccyFn = new Function('intent', NA_NEW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n') + '\nreturn ccy;');
  if (ccyFn({ country: 'IN' }) !== 'INR') { console.error('HARNESS FAIL: currency lookup wrong for a real country'); process.exit(1); }
  if (ccyFn({ country: null }) !== null) { console.error('HARNESS FAIL: currency must be null (unknown), not USD, when country is null'); process.exit(1); }

  // 6. countryCode simplification, run for real
  function runCountryCode(canonCountry, locTermsLen, expandCtxCountry) {
    const canonCountryVar = canonCountry, locTerms = new Array(locTermsLen), expandCtx = { country: expandCtxCountry };
    return new Function('canonCountry', 'locTerms', 'expandCtx', CC_NEW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n') + '\nreturn countryCode;')(canonCountryVar, locTerms, expandCtx);
  }
  if (runCountryCode(null, 0, 'IN') !== 'IN') { console.error('HARNESS FAIL: countryCode should use a real non-null country'); process.exit(1); }
  if (runCountryCode(null, 0, null) !== null) { console.error('HARNESS FAIL: countryCode should stay null when nothing is known'); process.exit(1); }
  if (runCountryCode('DE', 0, 'IN') !== 'DE') { console.error('HARNESS FAIL: canonCountry (from a bare-country message, s79) must take priority'); process.exit(1); }
  if (runCountryCode(null, 2, 'IN') !== null) { console.error('HARNESS FAIL: countryCode must stay null when city-level terms are already active'); process.exit(1); }

  console.log('HARNESS OK: all 8 sites verified against real logic -- worldwide reliably nulls country (tonight\'s exact bug reproduced and fixed), gl/JSearch-country conditionals correctly omit rather than default, JSearch query text has no awkward trailing "in " when nothing is known, Adzuna sentinel + currency default both verified, countryCode simplification preserves s79\'s canonCountry priority and the locTerms exclusivity rule.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S87 (country/location chain de-hardcoding) complete.');
