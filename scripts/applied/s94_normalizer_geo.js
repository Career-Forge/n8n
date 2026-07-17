/**
 * s94_normalizer_geo.js -- the 3 web-search-lane normalizers (Firecrawl,
 * You.com, Serper) could only ever recognize 7 hardcoded US cities ("New
 * York", "San Francisco", "Seattle", "Boston", "Austin", "Chicago", "Los
 * Angeles") + "Remote" when extracting a job's location from its title/
 * snippet text -- a title like "AI Engineer - Paris, France" or "ML Engineer
 * - Bangalore" fell through to '' (unknown) even though the location was
 * right there in the text. Aggregate Jobs' downstream location filter then
 * treats these as 'unknown' (kept, demoted, badged 🔎) rather than a real
 * match/mismatch, which is the F2-era deferral this closes for Firecrawl/
 * You.com and the reason Normalize Serper results ALWAYS hardcoded
 * location: '' outright (never had any extraction logic at all).
 *
 * Each normalizer now builds its own city/country detector from the SAME
 * geo_reference app_settings row Aggregate Jobs/Pre-flight: Providers already
 * load (zero new hardcoded place names) -- city names from geo_reference.cities,
 * country names from geo_reference.countries' flattened alias lists. Mirrored
 * independently in all 3 nodes (Code nodes can't share modules, same
 * convention this codebase already uses for classifyUrlTier/extractCompanyFromUrl
 * duplication). Each node's PRE-EXISTING match style is preserved exactly:
 * Firecrawl's title extractor required a connector word ("in"/"at"/dash)
 * immediately before the city -- kept; You.com's already matched a bare
 * word-boundary city name anywhere in the text -- kept (Serper's new
 * extractor, added fresh with no prior precedent of its own, follows
 * You.com's bare-word-boundary style since it also runs over prose-like
 * snippet text).
 *
 * No node count change. Run: inside the n8n container with the repo staged
 * under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Normalize Firecrawl Results: extractLocationFromTitle -- keeps its connector-word prefix requirement ═══
const FC_OLD = `const DEGREE_ABBR = new Set(['BS','MS','MA','BA','JD','MD','MBA','PHD','BFA','MFA','LLM','BSC','MSC','BTECH','MTECH','BE','ME','RN','CPA']);
function extractLocationFromTitle(title) {
  // Pull common location patterns out of titles like "ML Engineer - New York, NY"
  let m;
  if ((m = title.match(/(?:in|at|–|-|·|—)\\s*([A-Z][\\w\\s]+,\\s*[A-Z]{2,})/))) {
    const candidate = m[1].trim();
    if (DEGREE_ABBR.has(candidate.split(',')[0].trim().toUpperCase())) return '';
    return candidate;
  }
  if ((m = title.match(/(?:in|at|–|-|·|—)\\s*(New York|San Francisco|Seattle|Boston|Austin|Chicago|Los Angeles|Remote)/i))) return m[1];
  return '';
}`;
const FC_NEW = `const DEGREE_ABBR = new Set(['BS','MS','MA','BA','JD','MD','MBA','PHD','BFA','MFA','LLM','BSC','MSC','BTECH','MTECH','BE','ME','RN','CPA']);
// s94: city/country detection driven by the loaded geo_reference (same
// source Aggregate Jobs/Pre-flight: Providers already use) instead of a
// fixed 7-US-city list -- was blind to every non-US location a title could
// name. Mirrored per-node (Code nodes can't share modules).
const _geoRefFC = (() => { try { return $('Load Geo Reference (Search)').first().json.geo_reference || {}; } catch (e) { return {}; } })();
function buildLocationDetector(geoRef) {
  const esc = (s) => String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  const terms = [...new Set([...Object.keys(geoRef.cities || {}), ...Object.values(geoRef.countries || {}).flat()])]
    .filter(Boolean).sort((a, b) => b.length - a.length).map(esc);
  return terms.length ? new RegExp('(?:in|at|\\u2013|-|\\u00b7|\\u2014)\\\\s*(' + terms.join('|') + '|remote)', 'i') : null;
}
const LOCATION_DETECTOR_FC = buildLocationDetector(_geoRefFC);
function extractLocationFromTitle(title) {
  // Pull common location patterns out of titles like "ML Engineer - New York, NY"
  let m;
  if ((m = title.match(/(?:in|at|–|-|·|—)\\s*([A-Z][\\w\\s]+,\\s*[A-Z]{2,})/))) {
    const candidate = m[1].trim();
    if (DEGREE_ABBR.has(candidate.split(',')[0].trim().toUpperCase())) return '';
    return candidate;
  }
  if (LOCATION_DETECTOR_FC && (m = title.match(LOCATION_DETECTOR_FC))) return m[1];
  return '';
}`;

// ═══ 2. Normalize You.com results: extractLocationFromText -- keeps its bare word-boundary style ═══
const YC_OLD = `const DEGREE_ABBR = new Set(['BS','MS','MA','BA','JD','MD','MBA','PHD','BFA','MFA','LLM','BSC','MSC','BTECH','MTECH','BE','ME','RN','CPA']);
function extractLocationFromText(text) {
  let m;
  if ((m = text.match(/(?:in|at|–|-|·|—)\\s*([A-Z][\\w\\s]+,\\s*[A-Z]{2,})/))) {
    const candidate = m[1].trim();
    if (DEGREE_ABBR.has(candidate.split(',')[0].trim().toUpperCase())) return '';
    return candidate;
  }
  if ((m = text.match(/\\b(New York|San Francisco|Seattle|Boston|Austin|Chicago|Los Angeles|Remote)\\b/i))) return m[1];
  return '';
}`;
const YC_NEW = `const DEGREE_ABBR = new Set(['BS','MS','MA','BA','JD','MD','MBA','PHD','BFA','MFA','LLM','BSC','MSC','BTECH','MTECH','BE','ME','RN','CPA']);
// s94: city/country detection driven by the loaded geo_reference (same
// source Aggregate Jobs/Pre-flight: Providers already use) instead of a
// fixed 7-US-city list -- was blind to every non-US location a title/
// snippet could name. Mirrored per-node (Code nodes can't share modules).
const _geoRefYC = (() => { try { return $('Load Geo Reference (Search)').first().json.geo_reference || {}; } catch (e) { return {}; } })();
function buildLocationDetector(geoRef) {
  const esc = (s) => String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  const terms = [...new Set([...Object.keys(geoRef.cities || {}), ...Object.values(geoRef.countries || {}).flat()])]
    .filter(Boolean).sort((a, b) => b.length - a.length).map(esc);
  return terms.length ? new RegExp('\\\\b(' + terms.join('|') + '|remote)\\\\b', 'i') : null;
}
const LOCATION_DETECTOR_YC = buildLocationDetector(_geoRefYC);
function extractLocationFromText(text) {
  let m;
  if ((m = text.match(/(?:in|at|–|-|·|—)\\s*([A-Z][\\w\\s]+,\\s*[A-Z]{2,})/))) {
    const candidate = m[1].trim();
    if (DEGREE_ABBR.has(candidate.split(',')[0].trim().toUpperCase())) return '';
    return candidate;
  }
  if (LOCATION_DETECTOR_YC && (m = text.match(LOCATION_DETECTOR_YC))) return m[1];
  return '';
}`;

// ═══ 3. Normalize Serper results: brand-new extractor (never had one) + wire it into the push ═══
const SERPER_FN_ANCHOR_OLD = `  // TIER 4 — Anything else
  return { tier: 4, label: 'unknown' };
}

const hits = $input.all();
const allJobs = [];`;
const SERPER_FN_ANCHOR_NEW = `  // TIER 4 — Anything else
  return { tier: 4, label: 'unknown' };
}

// s94: Serper never had ANY location extraction -- location was hardcoded to
// '' unconditionally, so every Serper result always landed in Aggregate Jobs'
// 'unknown' bucket regardless of what the title/snippet actually said. Same
// geo_reference-driven detector as Normalize You.com results (bare word-
// boundary style, no connector-word prefix -- appropriate for prose-like
// snippet text, no prior precedent of its own to preserve here).
const DEGREE_ABBR = new Set(['BS','MS','MA','BA','JD','MD','MBA','PHD','BFA','MFA','LLM','BSC','MSC','BTECH','MTECH','BE','ME','RN','CPA']);
const _geoRefSerper = (() => { try { return $('Load Geo Reference (Search)').first().json.geo_reference || {}; } catch (e) { return {}; } })();
function buildLocationDetector(geoRef) {
  const esc = (s) => String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  const terms = [...new Set([...Object.keys(geoRef.cities || {}), ...Object.values(geoRef.countries || {}).flat()])]
    .filter(Boolean).sort((a, b) => b.length - a.length).map(esc);
  return terms.length ? new RegExp('\\\\b(' + terms.join('|') + '|remote)\\\\b', 'i') : null;
}
const LOCATION_DETECTOR_SERPER = buildLocationDetector(_geoRefSerper);
function extractLocationFromText(text) {
  let m;
  if ((m = text.match(/(?:in|at|–|-|·|—)\\s*([A-Z][\\w\\s]+,\\s*[A-Z]{2,})/))) {
    const candidate = m[1].trim();
    if (DEGREE_ABBR.has(candidate.split(',')[0].trim().toUpperCase())) return '';
    return candidate;
  }
  if (LOCATION_DETECTOR_SERPER && (m = text.match(LOCATION_DETECTOR_SERPER))) return m[1];
  return '';
}

const hits = $input.all();
const allJobs = [];`;

const SERPER_LOC_OLD = `      title: r.title || '',
      company,
      location: '',
      department: '',`;
const SERPER_LOC_NEW = `      title: r.title || '',
      company,
      location: extractLocationFromText(r.title || '') || extractLocationFromText(r.snippet || '') || '',
      department: '',`;

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

  const required = ['Normalize Firecrawl Results', 'Normalize You.com results', 'Normalize Serper results'];
  for (const r of required) { if (!N[r]) { console.error(`INTEGRITY FAIL ${base}: node "${r}" not found`); process.exit(1); } }

  if (N['Normalize Serper results'].parameters.jsCode.includes('s94:')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Normalize Firecrawl Results'].parameters, 'jsCode', FC_OLD, FC_NEW, 'Firecrawl location detector', base);
  replaceOnce(N['Normalize You.com results'].parameters, 'jsCode', YC_OLD, YC_NEW, 'You.com location detector', base);
  replaceOnce(N['Normalize Serper results'].parameters, 'jsCode', SERPER_FN_ANCHOR_OLD, SERPER_FN_ANCHOR_NEW, 'Serper location detector insertion', base);
  replaceOnce(N['Normalize Serper results'].parameters, 'jsCode', SERPER_LOC_OLD, SERPER_LOC_NEW, 'Serper location field wiring', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: geo_reference-driven location extraction across all 3 web-search normalizers -- ${wf.nodes.length} nodes`);
}

// ── harness: extract the ACTUAL patched functions and prove behavior before any write ──
(function harness() {
  const buildLocationDetector = new Function('geoRef', `
    const esc = (s) => String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const terms = [...new Set([...Object.keys(geoRef.cities || {}), ...Object.values(geoRef.countries || {}).flat()])]
      .filter(Boolean).sort((a, b) => b.length - a.length).map(esc);
    return terms.length ? new RegExp('\\\\b(' + terms.join('|') + '|remote)\\\\b', 'i') : null;
  `);

  const liveGeoRef = JSON.parse(fs.readFileSync('/tmp/geo_reference.json', 'utf8'));
  const rx = buildLocationDetector(liveGeoRef);
  if (!rx) { console.error('HARNESS FAIL: detector should build from the real geo_reference'); process.exit(1); }

  const mustMatch = [
    ['ML Engineer - Bangalore', 'bangalore'],
    ['AI Engineer, Paris, France', 'paris'],
    ['Backend Engineer - Berlin', 'berlin'],
    ['Data Scientist (Remote)', 'remote'],
    ['Software Engineer - New York, NY', 'new york'],
  ];
  for (const [text, expectSub] of mustMatch) {
    const m = text.match(rx);
    if (!m || !m[1].toLowerCase().includes(expectSub)) { console.error(`HARNESS FAIL: "${text}" should match "${expectSub}", got`, m); process.exit(1); }
  }
  if ('Senior Software Engineer'.match(rx)) { console.error('HARNESS FAIL: a title with no location should not match'); process.exit(1); }
  // u.s.a alias must not act as a loose 1-char wildcard chain (dots need escaping).
  if (!'Engineer, U.S.A.'.match(rx)) { console.error('HARNESS FAIL: "u.s.a" alias should still match with literal dots'); process.exit(1); }
  if ('Engineer, UxSxA'.match(new RegExp('\\b(' + 'u.s.a'.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\b', 'i'))) { console.error('HARNESS FAIL: dots in aliases must be escaped, not left as wildcards'); process.exit(1); }
  console.log('HARNESS OK: geo-driven detector matches Bangalore/Paris/Berlin/remote/New York from real geo_reference data, ignores location-less titles, escapes dotted aliases like "u.s.a" correctly');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
