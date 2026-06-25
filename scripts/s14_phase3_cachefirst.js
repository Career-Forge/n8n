/**
 * s14_phase3_cachefirst.js — Phase 3: cache-first find + full-resume/full-JD feed.
 *
 * Injects the updated node bodies (from scripts/nodes/) into all 3 master files:
 *   - Hybrid Cache Search (SQL): trust+recency blended rank, LEFT JOIN companies
 *     (so company_id-NULL big-co/aggregator rows aren't dropped), new cols + full
 *     jd_text, LIMIT 60.
 *   - Cache Prefilter: carry the JobRecord forward (trust/skills/salary/full JD/
 *     posted_at), source_priority:0, NEG-filter on full JD.
 *   - Aggregate Jobs: cache-first sort (source_priority -> rrf_score -> tier -> recency).
 *   - Build Scorer Input: emit master_resume_text + forward cache fields to jobBatch.
 *   - Build Matcher Request: full resume + full JD + cache-first top-25.
 *   - Build Telegraph Body: validated-first ranking, posted_at freshness.
 *   - Build FC/You.com/Serper Queries: cache-shortfall gate (paid lanes skip when
 *     cache count >= 25).
 *
 * The matcher's 2-pass reorder is a separate change in services/matcher/app.py
 * (already deployed via image rebuild) — not part of this workflow patch.
 *
 * Writes timestamped backups. Run: node scripts/s14_phase3_cachefirst.js
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

// node name -> [file, field]
const MAP = {
  'Hybrid Cache Search': ['hybrid_cache_search.sql', 'query'],
  'Cache Prefilter': ['cache_prefilter.js', 'jsCode'],
  'Aggregate Jobs': ['aggregate_jobs.js', 'jsCode'],
  'Build Scorer Input': ['build_scorer_input.js', 'jsCode'],
  'Build Matcher Request': ['build_matcher_request.js', 'jsCode'],
  'Build Telegraph Body': ['build_telegraph_body.js', 'jsCode'],
  'Build FC Queries': ['build_fc_queries.js', 'jsCode'],
  'Build You.com Queries': ['build_youcom_queries.js', 'jsCode'],
  'Build Serper Queries': ['build_serper_queries.js', 'jsCode'],
};

// load bodies + parse-check JS
const BODIES = {};
for (const [name, [file, field]] of Object.entries(MAP)) {
  const body = fs.readFileSync(path.join(NODES, file), 'utf8');
  if (field === 'jsCode') {
    try { new Function('$input', '$', '$json', '$getWorkflowStaticData', body); }
    catch (e) { console.error('PARSE FAIL ' + file + ': ' + e.message); process.exit(1); }
  }
  BODIES[name] = { body, field };
}

function stamp() {
  // avoid Date in workflow scripts? this is a build script, Date is fine here
  return new Date().toISOString().replace(/[:.]/g, '-');
}

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
    if (!names.has(src)) { console.error('INTEGRITY FAIL: connection source missing ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((br) => (br || []).forEach((e) => {
        if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file + '.s14bak-' + stamp(), fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': patched [' + patched.length + '] ' + (missing.length ? '(MISSING: ' + missing.join(', ') + ')' : ''));
}

TARGETS.forEach(patch);
console.log('S14 patch complete.');
