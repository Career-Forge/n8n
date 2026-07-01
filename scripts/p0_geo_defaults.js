/**
 * p0_geo_defaults.js -- P0(B): remove silent US/default-country behavior.
 *
 *   - Build FC Queries (jsCode)   : omit bodyObj.country when ctx.country is null.
 *   - Normalize Adzuna (jsCode)   : no us/USD default; currency from actual country.
 *   - Serper Job Search (http)    : send `gl` ONLY when a country was parsed
 *                                   (switch body to jsonBody that conditionally adds gl).
 *   - Adzuna Fetch (http)         : URL uses the (already-gated) country with NO
 *                                   `|| 'us'` default -> never calls /jobs/us (P0.5 invariant).
 *
 * Splices the canonical scripts/nodes bodies (kept in sync) + rewrites the Serper body.
 * Idempotent. Backups (*.p0bak-<stamp>) + integrity check. Run: node scripts/p0_geo_defaults.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODES = path.join(__dirname, 'nodes');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
];

const JS_MAP = {
  'Build FC Queries': 'build_fc_queries.js',
  'Normalize Adzuna': 'normalize_adzuna.js',
};
const BODIES = {};
for (const [name, file] of Object.entries(JS_MAP)) {
  const body = fs.readFileSync(path.join(NODES, file), 'utf8');
  try { new Function('$input', '$', '$json', '$getWorkflowStaticData', '$env', body); }
  catch (e) { console.error('PARSE FAIL ' + file + ': ' + e.message); process.exit(1); }
  BODIES[name] = body;
}

// Serper body: build the request object and include `gl` only when country is set.
const SERPER_JSON_BODY =
  "={{ JSON.stringify(Object.assign(" +
  "{ q: $json.query, num: 10, hl: 'en', tbs: ($('Parse Expand Query').first().json.freshness || 'qdr:w') }, " +
  "($('Parse Expand Query').first().json.country ? { gl: String($('Parse Expand Query').first().json.country).toLowerCase() } : {})" +
  ")) }}";

// Adzuna URL: the lane is gated to run only when a country is set (IF: Adzuna Disabled?),
// so the URL uses that country directly -- NO `|| 'us'` default, never /jobs/us.
const ADZUNA_URL =
  "=https://api.adzuna.com/v1/api/jobs/{{ String($('Parse Expand Query').first().json.country).toLowerCase() }}/search/1";

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + path.relative(ROOT, file)); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.relative(ROOT, file);
  const done = [], missing = [];

  for (const [name, body] of Object.entries(BODIES)) {
    if (!N[name]) { missing.push(name); continue; }
    N[name].parameters = N[name].parameters || {};
    N[name].parameters.jsCode = body;
    done.push(name);
  }

  const serper = N['Serper Job Search'];
  if (serper) {
    const p = serper.parameters = serper.parameters || {};
    p.sendBody = true;
    p.specifyBody = 'json';
    p.jsonBody = SERPER_JSON_BODY;
    delete p.bodyParameters;          // drop the old keypair body (had the gl='US' default)
    done.push('Serper Job Search');
  } else missing.push('Serper Job Search');

  const adz = N['Adzuna Fetch'];
  if (adz) { adz.parameters = adz.parameters || {}; adz.parameters.url = ADZUNA_URL; done.push('Adzuna Fetch'); }
  else missing.push('Adzuna Fetch');

  // integrity: connection targets still exist
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections || {})) {
    if (!names.has(src)) { console.error('INTEGRITY FAIL: source missing ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) (branches || []).forEach((br) => (br || []).forEach((e) => {
      if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
    }));
  }

  fs.writeFileSync(file + '.p0bak-' + stamp(), fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': [' + done.join(', ') + ']' + (missing.length ? ' MISSING: ' + missing.join(', ') : ''));
}

TARGETS.forEach(patch);
console.log('p0_geo_defaults complete.');
