/**
 * c1_company_ats.js — C1: company targeting + ATS/portal-only policy + country-alone geo gate.
 *
 * Inline-node edits (string-splice, s4-style):
 *   - Expand Query (prompt): add `companies` field; stop defaulting country to US
 *     (null unless a place/country is named); add company+bare-country examples.
 *   - Parse Expand Query (jsCode): country default -> null; emit `companies` +
 *     alias-expanded `company_rx` (POSIX/JS alternation) before saving the intent.
 *
 * Node-body edits (MAP-splice, s14/lN2-style):
 *   - Hybrid Cache Search (SQL): country gate fires on $4 alone (bare country),
 *     + $6 company gate (\y-bounded).
 *   - Aggregate Jobs (jsCode): isAtsDestination() hard gate (ATS/portal only) +
 *     company_rx web-lane filter.
 *
 * Hybrid Cache Search queryReplacement gains $6 (company_rx).
 * Idempotent. Backups (*.s1bak-<stamp>) + integrity check. Run: node scripts/c1_company_ats.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODES = path.join(__dirname, 'nodes');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ── node bodies (MAP-splice) ──
const MAP = {
  'Hybrid Cache Search': ['hybrid_cache_search.sql', 'query'],
  'Aggregate Jobs': ['aggregate_jobs.js', 'jsCode'],
};
const BODIES = {};
for (const [name, [file, field]] of Object.entries(MAP)) {
  const body = fs.readFileSync(path.join(NODES, file), 'utf8');
  if (field === 'jsCode') {
    try { new Function('$input', '$', '$json', '$getWorkflowStaticData', body); }
    catch (e) { console.error('PARSE FAIL ' + file + ': ' + e.message); process.exit(1); }
  }
  BODIES[name] = { body, field };
}

// ── queryReplacement: append $6 company_rx ──
const QREPL =
  "={{ [ ($json.embeddings && $json.embeddings[0] && $json.embeddings[0].length===1024) ? ('[' + $json.embeddings[0].join(',') + ']') : null, " +
  "(($('Pre-flight: Providers').first().json.role_families)||[]).join(' '), " +
  "($('Parse Expand Query').first().json.location_canonical || null), " +
  "($('Parse Expand Query').first().json.country || null), " +
  "($('Parse Expand Query').first().json.remote_preference || 'open'), " +
  "($('Parse Expand Query').first().json.company_rx || null) ] }}";

// ── inline prompt edits ──
const COUNTRY_OLD = '- country: ISO code (e.g. "US","IN","GB"). Default "US"';
const COUNTRY_NEW =
  '- country: ISO code (e.g. "US","IN","GB","NL","CA","DE"). Default null -- do NOT assume US. ' +
  'Set ONLY when a country/city/region is named or clearly implied. A BARE country ' +
  '("Netherlands","India","Germany") -> set country AND location_canonical to that country name.\n' +
  '- companies: array of specific employer names the user named (e.g. "jobs at Amazon"->["Amazon"]; ' +
  '"Amazon Netherlands"->["Amazon"] with location_canonical="Netherlands"; "roles at Google or Meta"->["Google","Meta"]). ' +
  'If a company is widely known by alternate names or has subsidiaries the user clearly means, you MAY include them ' +
  '(e.g. "Amazon"->["Amazon","AWS"]). [] if no employer is named. Extract ONLY real company names, never a place or role.';

// ── inline Parse edits ──
const PARSE_COUNTRY_DEFAULT_RX =
  /country:\s*parsed\.country\s*\|\|\s*userPrefs\.country\s*\|\|\s*['"][A-Z]{2}['"],/;
const PARSE_COUNTRY_NEW = "country:            parsed.country              || userPrefs.country             || null,";

const PARSE_COMPANY_BLOCK =
  "// C1: GENERIC company targeting -- NO hardcoded alias table. The LLM is the\n" +
  "// extractor (and may itself list alternate brand names / subsidiaries it knows);\n" +
  "// we just turn each name it returns into a normalized token regex. Multi-word\n" +
  "// names match flexibly (\"Goldman Sachs\" -> \"goldman.*sachs\"). \\y/\\b-bounded at use.\n" +
  "result.companies = Array.isArray(parsed.companies) ? parsed.companies.filter(Boolean) : [];\n" +
  "{\n" +
  "  const parts = result.companies\n" +
  "    .map(c => String(c).toLowerCase().replace(/[^a-z0-9 ]+/g,' ').trim().split(/\\s+/).filter(Boolean).join('.*'))\n" +
  "    .filter(Boolean);\n" +
  "  result.company_rx = parts.length ? Array.from(new Set(parts)).join('|') : null;\n" +
  "}\n";

function sj(s, a, b) { return s.split(a).join(b); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + file); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  let edits = 0;

  // 1) Expand Query prompt
  const eq = N['Expand Query'];
  if (eq) {
    const mv = eq.parameters.messages.messageValues[0];
    if (!mv.message.includes('- companies:')) {
      if (mv.message.includes(COUNTRY_OLD)) { mv.message = sj(mv.message, COUNTRY_OLD, COUNTRY_NEW); edits++; }
      else console.log('  WARN ' + base + ': Expand Query country anchor missing');
    }
  } else console.log('  WARN ' + base + ': Expand Query node missing');

  // 2) Parse Expand Query — country default + company block
  const peq = N['Parse Expand Query'];
  if (peq) {
    let code = peq.parameters.jsCode;
    if (PARSE_COUNTRY_DEFAULT_RX.test(code)) { code = code.replace(PARSE_COUNTRY_DEFAULT_RX, PARSE_COUNTRY_NEW); edits++; }
    if (!code.includes('result.company_rx')) {
      const before = code;
      code = sj(code, 'sd.last_search_intent = result;', PARSE_COMPANY_BLOCK + 'sd.last_search_intent = result;');
      if (code !== before) edits++; else console.log('  WARN ' + base + ': PEQ anchor missing');
    }
    peq.parameters.jsCode = code;
  } else console.log('  WARN ' + base + ': Parse Expand Query node missing');

  // 3) Node bodies (MAP-splice)
  const patched = [], missing = [];
  for (const [name, { body, field }] of Object.entries(BODIES)) {
    if (!N[name]) { missing.push(name); continue; }
    N[name].parameters = N[name].parameters || {};
    N[name].parameters[field] = body;
    patched.push(name);
  }

  // 4) queryReplacement ($6)
  let qr = 'n/a';
  const hcs = N['Hybrid Cache Search'];
  if (hcs) {
    hcs.parameters.options = hcs.parameters.options || {};
    hcs.parameters.options.queryReplacement = QREPL;
    qr = 'set ($3..$6)';
  }

  // integrity: every connection target still exists
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections || {})) {
    if (!names.has(src)) { console.error('INTEGRITY FAIL: source missing ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((br) => (br || []).forEach((e) => {
        if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file + '.s1bak-' + stamp(), fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': inline edits ' + edits + ', nodes [' + patched.join(', ') + '] queryReplacement ' + qr +
    (missing.length ? ' MISSING: ' + missing.join(', ') : ''));
}

TARGETS.forEach(patch);
console.log('C1 patch complete.');
