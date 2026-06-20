/**
 * s12_freshness.js — Sprint 3: real posting dates + no "Invalid Date".
 *  - 5 normalize lanes -> parsePostedDate() normalizes each source date to ISO ('' if unknown)
 *  - Build Telegraph Body -> display guard against Invalid Date (and carries S11 cleanCompany)
 * Writes all 3 masters. Run: node scripts/s12_freshness.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const NODE = (f) => fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8');
const CODE_NODES = {
  'Normalize RemoteOK': NODE('normalize_remoteok.js'),
  'Normalize Adzuna': NODE('normalize_adzuna.js'),
  'Normalize Serper results': NODE('normalize_serper.js'),
  'Normalize Firecrawl Results': NODE('normalize_firecrawl.js'),
  'Normalize You.com results': NODE('normalize_youcom.js'),
  'Build Telegraph Body': NODE('build_telegraph_body.js'),
};

for (const [name, code] of Object.entries(CODE_NODES)) {
  try { new Function('$input', '$', '$getWorkflowStaticData', code); } catch (e) { console.error('PARSE FAIL ' + name + ': ' + e.message); process.exit(1); }
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + file); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  const touched = [];
  for (const [name, code] of Object.entries(CODE_NODES)) {
    if (!N[name]) { console.log('  ' + base + ': MISSING node "' + name + '"'); continue; }
    N[name].parameters = N[name].parameters || {};
    N[name].parameters.jsCode = code; touched.push(name);
  }
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => { if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); } }));
    }
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': patched [' + touched.join(', ') + ']');
}

TARGETS.forEach(patch);
console.log('S12 patch complete.');
