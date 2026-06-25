/**
 * s15_sprintA_tiers.js — Sprint A: desirability-tier-aware ranking + display.
 *
 * Injects the updated node bodies (from scripts/nodes/) into all 3 master files:
 *   - Hybrid Cache Search (SQL): LEFT JOIN company_tiers on cf_name_norm(company),
 *     emit `tier`, multiply rrf_score by the tier weight (S 1.0 → D 0.25).
 *   - Cache Prefilter: carry `tier` forward onto each cache job.
 *   - Aggregate Jobs: backfill `tier` on dedup collisions.
 *   - Build Telegraph Body: tier as a strong sort booster (not a hard sort) +
 *     visible 🏆/⭐ badges in the header, meta line, and top-3 message.
 *
 * DB side (cf_name_norm + company_tiers table + seed) is in db/schema.sql +
 * db/seed_dream_tier.sql — applied with psql, not part of this workflow patch.
 *
 * Writes timestamped backups. Run: node scripts/s15_sprintA_tiers.js
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
  'Hybrid Cache Search':  ['hybrid_cache_search.sql', 'query'],
  'Cache Prefilter':      ['cache_prefilter.js', 'jsCode'],
  'Aggregate Jobs':       ['aggregate_jobs.js', 'jsCode'],
  'Build Matcher Request':['build_matcher_request.js', 'jsCode'],
  'Build Telegraph Body': ['build_telegraph_body.js', 'jsCode'],
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

  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections || {})) {
    if (!names.has(src)) { console.error('INTEGRITY FAIL: connection source missing ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((br) => (br || []).forEach((e) => {
        if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file + '.s15bak-' + stamp(), fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': patched [' + patched.length + '] ' + (missing.length ? '(MISSING: ' + missing.join(', ') + ')' : ''));
}

TARGETS.forEach(patch);
console.log('S15 patch complete.');
