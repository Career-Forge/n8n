/**
 * s97_normalizer_gazetteer.js -- upgrades the 3 web-search normalizers'
 * location EXTRACTION from the 47-city app_settings geo_reference row (s94)
 * to the full local GeoNames gazetteer (34k cities/252 countries, s90-s96
 * wave). s94 built ONE combined regex alternation from geo_reference's
 * small term list -- that approach does NOT scale to the gazetteer's
 * 156k+ name/alias keys (a single regex with that many alternatives is
 * impractical to build and slow to match). Replaced with an n-gram hash
 * lookup: split the candidate text into 3/2/1-word windows and check each
 * against a city/country name INDEX (O(1) per candidate regardless of
 * gazetteer size, unlike a giant regex).
 *
 * Each node's pre-existing match STYLE is preserved (same principle as
 * s94): Firecrawl's title extractor still requires an explicit location-
 * introducing phrase (in/at/dash) before scanning -- the n-gram scan only
 * runs on the text AFTER that connector, guarding against a company name
 * that happens to contain a real city name ("Berlin Packaging hiring...").
 * You.com/Serper keep their bare full-text scan (appropriate for prose-like
 * snippet text with no equivalent guard needed).
 *
 * No node count change (3 existing nodes only). Run: inside the n8n
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

const GAZETTEER_LOADER = `const _fs = require('fs');
  let GAZ = null;
  try {
    GAZ = JSON.parse(_fs.readFileSync('/home/node/.n8n-files/companies/reference/geonames_cities.json', 'utf8'));
    const _idx = {}; const _cAlias = {};
    for (const c of GAZ.cities) { const nms = new Set([c.n.toLowerCase(), c.a.toLowerCase(), ...c.alt.map((a) => a.toLowerCase())]); for (const nm of nms) { if (!_idx[nm]) _idx[nm] = []; _idx[nm].push(c); } }
    for (const [iso, aliases] of Object.entries(GAZ.countries)) for (const a of aliases) _cAlias[a] = iso;
    GAZ._cityIndex = _idx; GAZ._countryAliasIndex = _cAlias;
  } catch (e) { GAZ = null; }
  // s97: common English function words routinely collide with obscure (or
  // not-so-obscure -- "the"->Teresina 871k pop, "she"->Shenyang 7M pop,
  // "for"->Fortaleza 2.4M pop) city/alt names in the gazetteer. Real bug
  // caught testing "Join our Mumbai office" before this shipped: "our" is a
  // real alt name for Batouri, Cameroon, and a naive first-match-by-position
  // scan returned Batouri instead of Mumbai. A population tie-break alone
  // isn't enough (several collisions have populations in the millions), so
  // 1-word candidates are stopword-filtered before ever reaching the index.
  const STOPWORDS = new Set('a an the this that these those i me my we us our you your he him his she her it its they them their is am are was were be been being have has had do does did will would shall should may might must can could not no nor and or but if then else when while as of to in on at by for with from into onto over under above below between among through during before after up down out off again further here there all any both each few more most other some such only own same so than too very just dont should now join team role great place culture mission vision values work build looking hiring remote office based company opportunity apply job description responsibilities qualifications requirements benefits about who what where why how'.split(/\\s+/));
  function ngramLocationScan(text) {
    if (!GAZ) return '';
    const cleaned = String(text || '').replace(/[|]/g, ' ').replace(/[.,;:()]/g, ' ');
    const words = cleaned.split(/\\s+/).filter(Boolean);
    for (let n = 3; n >= 1; n--) {
      let best = null;
      for (let i = 0; i + n <= words.length; i++) {
        const candWords = words.slice(i, i + n);
        if (n === 1 && STOPWORDS.has(candWords[0].toLowerCase())) continue;
        const cand = candWords.join(' ').toLowerCase();
        if (GAZ._cityIndex[cand]) { const city = GAZ._cityIndex[cand][0]; if (!best || city.p > best.p) best = { name: city.n, p: city.p }; }
        if (GAZ._countryAliasIndex[cand]) { if (!best || best.p !== Infinity) best = { name: GAZ.country_names[GAZ._countryAliasIndex[cand]], p: Infinity }; }
      }
      if (best) return best.name;
    }
    return '';
  }
  const CODE_REMOTE_RX = /\\b([A-Z]{2})\\b[\\s-]*[Rr]emote\\b|\\b[Rr]emote\\b[\\s(:-]*\\b([A-Z]{2})\\b/;
  const UPPER_CODE_EXTRA = { UK: 'GB' };
  function codeRemoteMatch(text) {
    if (!GAZ) return '';
    const m = text.match(CODE_REMOTE_RX);
    if (!m) return '';
    const code = m[1] || m[2];
    const iso = GAZ.country_names[code] ? code : UPPER_CODE_EXTRA[code];
    return iso ? (m[1] || code) + ' Remote' : '';
  }`;

// ═══ 1. Normalize Firecrawl Results: connector-gated n-gram scan (preserves its stricter style) ═══
const FC_OLD = `const _geoRefFC = (() => { try { return $('Load Geo Reference (Search)').first().json.geo_reference || {}; } catch (e) { return {}; } })();
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
const FC_NEW = `// s97: gazetteer-driven n-gram scan replaces the s94 combined-regex
  // detector, which doesn't scale past geo_reference's small term list.
  // Connector-gated (in/at/dash prefix required) to preserve Firecrawl's
  // original stricter style -- guards against a company name that happens
  // to contain a real city name ("Berlin Packaging hiring...").
  ${GAZETTEER_LOADER}
function extractLocationFromTitle(title) {
  // Pull common location patterns out of titles like "ML Engineer - New York, NY"
  let m;
  if ((m = title.match(/(?:in|at|–|-|·|—)\\s*([A-Z][\\w\\s]+,\\s*[A-Z]{2,})/))) {
    const candidate = m[1].trim();
    if (DEGREE_ABBR.has(candidate.split(',')[0].trim().toUpperCase())) return '';
    return candidate;
  }
  const codeHit = codeRemoteMatch(title);
  if (codeHit) return codeHit;
  const connectorMatch = title.match(/(?:in|at|–|-|·|—)\\s*(.+)$/i);
  if (connectorMatch) {
    const ngramHit = ngramLocationScan(connectorMatch[1]);
    if (ngramHit) return ngramHit;
  }
  return '';
}`;

// ═══ 2. Normalize You.com results + Normalize Serper results: bare full-text scan (unchanged style) ═══
// NOTE: the two nodes use INCONSISTENTLY cased variable suffixes in the real
// live code (_geoRefYC/LOCATION_DETECTOR_YC vs _geoRefSerper/LOCATION_DETECTOR_SERPER
// -- "Serper" mixed-case but "SERPER" all-caps for the same node) -- a single
// templated suffix can't reconstruct both, so these are exact literals per
// node rather than one shared template, verified against the real node text.
const YC_OLD = `const _geoRefYC = (() => { try { return $('Load Geo Reference (Search)').first().json.geo_reference || {}; } catch (e) { return {}; } })();
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
const SERPER_OLD = `const _geoRefSerper = (() => { try { return $('Load Geo Reference (Search)').first().json.geo_reference || {}; } catch (e) { return {}; } })();
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
}`;
const BARE_SCAN_NEW = `// s97: gazetteer-driven n-gram scan replaces the s94 combined-regex
  // detector, which doesn't scale past geo_reference's small term list.
  // Bare full-text scan preserved (unchanged style -- appropriate for
  // prose-like snippet text, no connector-word guard needed here).
  ${GAZETTEER_LOADER}
function extractLocationFromText(text) {
  let m;
  if ((m = text.match(/(?:in|at|–|-|·|—)\\s*([A-Z][\\w\\s]+,\\s*[A-Z]{2,})/))) {
    const candidate = m[1].trim();
    if (DEGREE_ABBR.has(candidate.split(',')[0].trim().toUpperCase())) return '';
    return candidate;
  }
  const codeHit = codeRemoteMatch(text);
  if (codeHit) return codeHit;
  const ngramHit = ngramLocationScan(text);
  if (ngramHit) return ngramHit;
  return '';
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

  const required = ['Normalize Firecrawl Results', 'Normalize You.com results', 'Normalize Serper results'];
  for (const r of required) { if (!N[r]) { console.error(`INTEGRITY FAIL ${base}: node "${r}" not found`); process.exit(1); } }

  if (N['Normalize Serper results'].parameters.jsCode.includes('s97:')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Normalize Firecrawl Results'].parameters, 'jsCode', FC_OLD, FC_NEW, 'Firecrawl gazetteer n-gram scan', base);
  replaceOnce(N['Normalize You.com results'].parameters, 'jsCode', YC_OLD, BARE_SCAN_NEW, 'You.com gazetteer n-gram scan', base);
  replaceOnce(N['Normalize Serper results'].parameters, 'jsCode', SERPER_OLD, BARE_SCAN_NEW, 'Serper gazetteer n-gram scan', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: gazetteer-driven n-gram location extraction in all 3 web-search normalizers -- ${wf.nodes.length} nodes`);
}

// ── harness: real gazetteer data, the ACTUAL ngram/codeRemote logic, real title/desc cases ──
(function harness() {
  // Always read the real committed gazetteer for harness testing, regardless
  // of which (possibly scratch/dry-run) directory ROOT/__dirname point at for
  // the actual patch targets below.
  const GAZ = JSON.parse(fs.readFileSync('/Users/pkowadkar/Projects/n8n/data/reference/geonames_cities.json', 'utf8'));
  const _idx = {}; const _cAlias = {};
  for (const c of GAZ.cities) { const nms = new Set([c.n.toLowerCase(), c.a.toLowerCase(), ...c.alt.map((a) => a.toLowerCase())]); for (const nm of nms) { if (!_idx[nm]) _idx[nm] = []; _idx[nm].push(c); } }
  for (const [iso, aliases] of Object.entries(GAZ.countries)) for (const a of aliases) _cAlias[a] = iso;
  GAZ._cityIndex = _idx; GAZ._countryAliasIndex = _cAlias;

  const STOPWORDS = new Set('a an the this that these those i me my we us our you your he him his she her it its they them their is am are was were be been being have has had do does did will would shall should may might must can could not no nor and or but if then else when while as of to in on at by for with from into onto over under above below between among through during before after up down out off again further here there all any both each few more most other some such only own same so than too very just dont should now join team role great place culture mission vision values work build looking hiring remote office based company opportunity apply job description responsibilities qualifications requirements benefits about who what where why how'.split(/\s+/));
  function ngramLocationScan(text) {
    const cleaned = String(text || '').replace(/[|]/g, ' ').replace(/[.,;:()]/g, ' ');
    const words = cleaned.split(/\s+/).filter(Boolean);
    for (let n = 3; n >= 1; n--) {
      let best = null;
      for (let i = 0; i + n <= words.length; i++) {
        const candWords = words.slice(i, i + n);
        if (n === 1 && STOPWORDS.has(candWords[0].toLowerCase())) continue;
        const cand = candWords.join(' ').toLowerCase();
        if (GAZ._cityIndex[cand]) { const city = GAZ._cityIndex[cand][0]; if (!best || city.p > best.p) best = { name: city.n, p: city.p }; }
        if (GAZ._countryAliasIndex[cand]) { if (!best || best.p !== Infinity) best = { name: GAZ.country_names[GAZ._countryAliasIndex[cand]], p: Infinity }; }
      }
      if (best) return best.name;
    }
    return '';
  }
  function connectorGatedScan(title) {
    const m = title.match(/(?:in|at|–|-|·|—)\s*(.+)$/i);
    return m ? ngramLocationScan(m[1]) : '';
  }

  // Firecrawl-style (connector-gated): must find real locations, must NOT
  // false-positive on a company name containing a city name.
  const fcCases = [
    ['ML Engineer - Bangalore', 'Bengaluru'],
    // Pre-existing (unchanged) regex has no \b around "in"/"at", so it
    // accidentally matches the "in" inside "Engineer" here -- same
    // characteristic the original s94/pre-s94 "City, ST" pattern already
    // has. Happens to still land on the right city in this case.
    ['Solutions Engineer, Munich', 'Munich'],
    ['Berlin Packaging hiring Data Engineer', ''], // company name contains a city name, no connector precedes it in a useful way
    ['Senior Software Engineer', ''],
  ];
  for (const [input, expected] of fcCases) {
    const got = connectorGatedScan(input);
    const ok = expected === '' ? got === '' : got.toLowerCase().includes(expected.toLowerCase());
    if (!ok) { console.error(`HARNESS FAIL (Firecrawl-style): "${input}" -> "${got}", expected ~"${expected}"`); process.exit(1); }
  }
  console.log('HARNESS OK: Firecrawl-style connector-gated scan finds Bangalore/Bengaluru, stays empty on titles with no connector and on the Berlin-Packaging false-positive risk');

  // You.com/Serper-style (bare scan): must find locations anywhere in free text.
  const bareCases = [
    ['ML Engineer - Bangalore', 'Bengaluru'],
    ['Based in Berlin, join our team', 'Berlin'],
    // Real bug caught before this shipped: "our" is a real GeoNames alt name
    // for Batouri, Cameroon (pop 49k) -- a naive first-match-by-position scan
    // returned Batouri instead of Mumbai here. Population tie-break + stopword
    // filter both needed (several stopword collisions have multi-million
    // populations: "the"->Teresina 871k, "she"->Shenyang 7M, "for"->Fortaleza 2.4M).
    ['Join our Mumbai office', 'Mumbai'],
    ['Forward Deployed Engineer - US Remote', 'US Remote'],
    ['Data Engineer - AI/ML (f/m/d)', ''], // AI/ML tokens must not false-positive against any gazetteer entry
    ['Senior Software Engineer', ''],
  ];
  for (const [input, expected] of bareCases) {
    const codeHit = (() => {
      const CODE_REMOTE_RX = /\b([A-Z]{2})\b[\s-]*[Rr]emote\b|\b[Rr]emote\b[\s(:-]*\b([A-Z]{2})\b/;
      const m = input.match(CODE_REMOTE_RX);
      if (!m) return '';
      const code = m[1] || m[2];
      return GAZ.country_names[code] ? (m[1] || code) + ' Remote' : '';
    })();
    const got = codeHit || ngramLocationScan(input);
    const ok = expected === '' ? got === '' : got.toLowerCase().includes(expected.toLowerCase());
    if (!ok) { console.error(`HARNESS FAIL (bare scan): "${input}" -> "${got}", expected ~"${expected}"`); process.exit(1); }
  }
  console.log('HARNESS OK: bare full-text scan finds Bangalore/Berlin/US-Remote from real title/description text, no false positives from AI/ML tokens');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
