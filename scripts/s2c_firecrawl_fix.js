/**
 * s2c_firecrawl_fix.js — make Firecrawl pull its weight in find-jobs.
 *
 * (P0.6) This now splices the CANONICAL `scripts/nodes/build_fc_queries.js` body
 * into the "Build FC Queries" node instead of carrying its own embedded copy, so
 * it can NEVER drift back to a silent US default. The canonical body enforces the
 * active invariant: `country = ctx.country || null`, `bodyObj` includes `country`
 * ONLY when set, deterministic `site:ATS "role" "location"` queries, cache-first gate.
 *
 * Run: node scripts/s2c_firecrawl_fix.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// Single source of truth — the canonical node body (no silent US default lives here).
const NEW_CODE = fs.readFileSync(path.join(__dirname, 'nodes', 'build_fc_queries.js'), 'utf8');
try { new Function('$input', '$', '$json', '$getWorkflowStaticData', '$env', NEW_CODE); }
catch (e) { console.error('PARSE FAIL build_fc_queries.js: ' + e.message); process.exit(1); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Build FC Queries');
  if (!node) { console.log(`SKIP (${path.basename(file)}: no "Build FC Queries")`); return; }
  node.parameters.jsCode = NEW_CODE;
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${path.basename(file)}: Build FC Queries <- canonical build_fc_queries.js`);
}

TARGETS.forEach(patch);
console.log('S2c Firecrawl patch complete (canonical splice — no US default).');
