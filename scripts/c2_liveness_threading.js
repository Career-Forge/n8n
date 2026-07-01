/**
 * c2_liveness_threading.js -- Tier 2.3: thread source/board/external_id/apply_url from the
 * cache search to the matcher so it can run find-time per-source liveness checks.
 *
 * MAP-splices (s14/lN2-style) the canonical node bodies that now carry the threading:
 *   - Hybrid Cache Search (SQL): SELECT j.source, j.board, j.external_id (+ the 1a gate fix).
 *   - Cache Prefilter (jsCode): carry ats_source/board/external_id/apply_url.
 *   - Build Scorer Input (jsCode): forward them.
 *   - Build Matcher Request (jsCode): include them in the /match payload.
 *
 * Does NOT touch queryReplacement (left as c1 set it). Idempotent. Backups + integrity check.
 * Run: node scripts/c2_liveness_threading.js
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

const MAP = {
  'Hybrid Cache Search': ['hybrid_cache_search.sql', 'query'],
  'Cache Prefilter': ['cache_prefilter.js', 'jsCode'],
  'Build Scorer Input': ['build_scorer_input.js', 'jsCode'],
  'Build Matcher Request': ['build_matcher_request.js', 'jsCode'],
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

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + file); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);

  const patched = [], missing = [];
  for (const [name, { body, field }] of Object.entries(BODIES)) {
    if (!N[name]) { missing.push(name); continue; }
    N[name].parameters = N[name].parameters || {};
    N[name].parameters[field] = body;
    patched.push(name);
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
  console.log('OK ' + base + ': nodes [' + patched.join(', ') + ']' + (missing.length ? ' MISSING: ' + missing.join(', ') : ''));
}

TARGETS.forEach(patch);
console.log('C2 patch complete.');
