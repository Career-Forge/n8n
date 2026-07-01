/**
 * validate_source_policy.js -- P2.1 drift guard (read-only; CI/pre-commit friendly).
 *
 * Verifies the centralized source policy has NOT drifted between:
 *   - the canonical  scripts/nodes/_source_policy.js  (the SOURCE_POLICY IIFE)
 *   - the inlined block in each generated node file
 *   - the inlined block in each of the 5 relevant nodes in the 3 modern exports
 * Compares the content BETWEEN the BEGIN/END markers byte-for-byte against the canonical
 * IIFE (marker lines themselves are ignored). Also runs export parse / node-count /
 * dangling-connection / Merge-Sources integrity checks.
 *
 * Exits 0 if everything matches; nonzero (with the offending file/node) on any drift.
 * Run:  node scripts/validate_source_policy.js
 * Fix drift (only if reported):  node scripts/p2_source_policy.js   (then re-run this guard)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODES = path.join(__dirname, 'nodes');
const BEGIN_PREFIX = '// === BEGIN _source_policy';
const END_MARK = '// === END _source_policy ===';
const EXPECTED_NODE_COUNT = 279;          // current invariant for the 3 modern exports
const EXPECTED_MERGE_INPUTS = 5;

const NODE_MAP = [
  ['aggregate_jobs.js', 'Aggregate Jobs'],
  ['normalize_serper.js', 'Normalize Serper results'],
  ['normalize_firecrawl.js', 'Normalize Firecrawl Results'],
  ['normalize_youcom.js', 'Normalize You.com results'],
  ['build_fc_queries.js', 'Build FC Queries'],
];
const EXPORTS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
];

const failures = [];
const fail = (msg) => { failures.push(msg); };

// --- canonical IIFE ---
function canonicalBlock() {
  const s = fs.readFileSync(path.join(NODES, '_source_policy.js'), 'utf8');
  const a = s.indexOf('const SOURCE_POLICY = (function');
  const b = s.indexOf('})();', a);
  if (a < 0 || b < 0) throw new Error('_source_policy.js: SOURCE_POLICY IIFE not found');
  // syntax sanity on the canonical file
  try { new Function('module', s); } catch (e) { throw new Error('_source_policy.js does not parse: ' + e.message); }
  return s.slice(a, b + 5).trim();
}
// --- extract inlined block (between markers) from a code string ---
function inlinedBlock(code) {
  const a = code.indexOf(BEGIN_PREFIX);
  if (a < 0) return null;
  const nl = code.indexOf('\n', a);
  const e = code.indexOf(END_MARK, nl);
  if (e < 0) return null;
  return code.slice(nl + 1, e).trim();
}

let CANON;
try { CANON = canonicalBlock(); }
catch (e) { console.error('FATAL: ' + e.message); process.exit(2); }

console.log('=== Source policy block parity ===');
console.log('canonical: scripts/nodes/_source_policy.js (' + CANON.length + ' chars)\n');

// 1) generated node files
console.log('-- generated node files --');
for (const [file] of NODE_MAP) {
  const p = path.join(NODES, file);
  if (!fs.existsSync(p)) { console.log('  FAIL  ' + file + ' (missing file)'); fail('node file missing: ' + file); continue; }
  const blk = inlinedBlock(fs.readFileSync(p, 'utf8'));
  if (blk == null) { console.log('  FAIL  ' + file + ' (no _source_policy block)'); fail(file + ': missing policy block'); continue; }
  const ok = blk === CANON;
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + file);
  if (!ok) fail(file + ': policy block differs from canonical');
}

// 2) modern exports x 5 relevant nodes
console.log('\n-- modern exports (5 relevant nodes each) --');
for (const file of EXPORTS) {
  const rel = path.relative(ROOT, file);
  if (!fs.existsSync(file)) { console.log('  FAIL  ' + rel + ' (missing)'); fail('export missing: ' + rel); continue; }
  let wf;
  try { wf = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log('  FAIL  ' + rel + ' (JSON parse: ' + e.message + ')'); fail(rel + ': JSON parse error'); continue; }
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const [, nodeName] of NODE_MAP) {
    const node = N[nodeName];
    if (!node) { console.log('  FAIL  ' + rel + ' :: ' + nodeName + ' (node missing)'); fail(rel + ' :: ' + nodeName + ': missing'); continue; }
    const blk = inlinedBlock((node.parameters && node.parameters.jsCode) || '');
    if (blk == null) { console.log('  FAIL  ' + rel + ' :: ' + nodeName + ' (no policy block)'); fail(rel + ' :: ' + nodeName + ': missing policy block'); continue; }
    const ok = blk === CANON;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + rel + ' :: ' + nodeName);
    if (!ok) fail(rel + ' :: ' + nodeName + ': policy block differs');
  }
}

// 3) parse / integrity
console.log('\n=== Workflow parse / integrity ===');
for (const file of EXPORTS) {
  const rel = path.relative(ROOT, file);
  if (!fs.existsSync(file)) continue;
  let wf;
  try { wf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; }
  const names = new Set(wf.nodes.map((n) => n.name));
  let dangling = 0;
  for (const [src, obj] of Object.entries(wf.connections || {})) {
    if (!names.has(src)) dangling++;
    for (const branches of Object.values(obj)) (branches || []).forEach((br) => (br || []).forEach((e) => { if (!names.has(e.node)) dangling++; }));
  }
  const ms = (wf.nodes.find((n) => n.name === 'Merge Sources') || {}).parameters || {};
  const nodeCount = wf.nodes.length, merge = ms.numberInputs;
  const okCount = nodeCount === EXPECTED_NODE_COUNT, okDangle = dangling === 0, okMerge = merge === EXPECTED_MERGE_INPUTS;
  console.log('  ' + rel + ': nodes ' + nodeCount + (okCount ? '' : ' (EXPECTED ' + EXPECTED_NODE_COUNT + ')') +
    ' | dangling ' + dangling + ' | Merge Sources ' + merge + (okMerge ? '' : ' (EXPECTED ' + EXPECTED_MERGE_INPUTS + ')') +
    ' | ' + (okCount && okDangle && okMerge ? 'OK' : 'FAIL'));
  if (!okCount) fail(rel + ': node count ' + nodeCount + ' != ' + EXPECTED_NODE_COUNT);
  if (!okDangle) fail(rel + ': ' + dangling + ' dangling connection(s)');
  if (!okMerge) fail(rel + ': Merge Sources inputs ' + merge + ' != ' + EXPECTED_MERGE_INPUTS);
}

console.log('\n=== RESULT ===');
if (failures.length) {
  console.log('DRIFT/INTEGRITY FAILURES (' + failures.length + '):');
  failures.forEach((f) => console.log('  - ' + f));
  console.log('\nFix policy drift with:  node scripts/p2_source_policy.js   (then re-run this guard)');
  process.exit(1);
}
console.log('OK -- source policy in sync across canonical + 5 node files + 3 exports; integrity clean.');
process.exit(0);
