/**
 * s2d_dedup.js — S2d (free-tier finish): upgrade Aggregate Jobs to composite-key dedup.
 *
 * Replaces the Aggregate Jobs node code (loaded from scripts/nodes/aggregate_jobs.js,
 * v9): dedup by canonical apply-URL OR lowercased company+title so the same job from
 * different sources (RemoteOK / Adzuna / web) collapses to one; on collision keep the
 * lower source_tier (structured/ATS preferred) and backfill salary + location from the
 * dropped dup. Tier-aware sort + Tier-3 drop unchanged. Harness: scripts/_harness... inline.
 *
 * The 3 premium structured lanes (USAJobs / JSearch / Apify) stay parked (need keys).
 * Run: node scripts/s2d_dedup.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];
const CODE = fs.readFileSync(path.join(__dirname, 'nodes', 'aggregate_jobs.js'), 'utf8');
try { new Function('$input', '$', CODE); } catch (e) { console.error('PARSE FAIL aggregate_jobs.js: ' + e.message); process.exit(1); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  if (!N['Aggregate Jobs']) { console.log(`  (no Aggregate Jobs in ${base})`); return; }
  N['Aggregate Jobs'].parameters.jsCode = CODE;
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Aggregate Jobs upgraded to v9 composite dedup`);
}

TARGETS.forEach(patch);
console.log('S2d patch complete.');
