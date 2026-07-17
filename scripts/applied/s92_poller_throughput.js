/**
 * s92_poller_throughput.js -- raises Select Due Companies' per-lane LIMITs so
 * the registry's never-polled backlog actually drains. Confirmed live before
 * this patch: 8,910 companies have NEVER been polled once (tier <> 'dream',
 * last_polled_at IS NULL) and 2,539 more are due in the general (probe/cold)
 * lane -- both lanes were capped at LIMIT 8 per 15-min tick, so the
 * never_polled lane alone would take ~9 more days to reach every company a
 * single time, and boards discovered by the self-growing registry hook
 * (Extract Registry Candidates) queue up faster than they ever get polled.
 *
 * Raises: never_polled 8 -> 40, general 8 -> 16. dream and earned (hot/warm)
 * lanes are UNCHANGED -- those are the tiers that already get real traffic
 * and don't need a throughput change. New worst case: 8+40+8+16 = 72 boards/
 * tick (was 32), never_polled backlog clears in ~2 days instead of ~9.
 *
 * Real timing data pulled from execution_entity before choosing these
 * numbers (not guessed): the 10 most recent ticks at patch time ranged
 * 16-79 seconds end to end (well under the 15-min budget) at the OLD 8/8/8/8
 * cap. Per the plan's own instruction to measure rather than assume, this
 * needs 2-3 real ticks observed AFTER deploy to confirm the new worst case
 * still finishes comfortably inside 15 minutes -- Ollama embedding is the
 * likely bottleneck at higher volume, not the ATS fetches themselves.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
];

const NEVER_POLLED_OLD = `'never_polled' FROM companies WHERE is_active AND tier <> 'dream' AND last_polled_at IS NULL AND next_poll_at <= now() ORDER BY created_at ASC LIMIT 8)`;
const NEVER_POLLED_NEW = `'never_polled' FROM companies WHERE is_active AND tier <> 'dream' AND last_polled_at IS NULL AND next_poll_at <= now() ORDER BY created_at ASC LIMIT 40)`;

const GENERAL_OLD = `'general' FROM companies WHERE is_active AND tier IN ('probe','cold') AND last_polled_at IS NOT NULL AND next_poll_at <= now() ORDER BY next_poll_at ASC LIMIT 8)`;
const GENERAL_NEW = `'general' FROM companies WHERE is_active AND tier IN ('probe','cold') AND last_polled_at IS NOT NULL AND next_poll_at <= now() ORDER BY next_poll_at ASC LIMIT 16)`;

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

  if (!N['Select Due Companies']) { console.error(`INTEGRITY FAIL ${base}: node "Select Due Companies" not found`); process.exit(1); }

  if (N['Select Due Companies'].parameters.query.includes('never_polled') && N['Select Due Companies'].parameters.query.includes('LIMIT 40')) {
    console.log(`  ${base}: already patched`); return;
  }

  replaceOnce(N['Select Due Companies'].parameters, 'query', NEVER_POLLED_OLD, NEVER_POLLED_NEW, 'never_polled LIMIT raise', base);
  replaceOnce(N['Select Due Companies'].parameters, 'query', GENERAL_OLD, GENERAL_NEW, 'general LIMIT raise', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: poller throughput raised (never_polled 8->40, general 8->16) -- ${wf.nodes.length} nodes`);
}

// ── harness: prove the query still has exactly 4 UNION ALL lanes with the intended limits ──
(function harness() {
  const wf = JSON.parse(fs.readFileSync(TARGETS[1], 'utf8'));
  const already = wf.nodes.find((n) => n.name === 'Select Due Companies').parameters.query.includes('LIMIT 40');
  const q = already ? wf.nodes.find((n) => n.name === 'Select Due Companies').parameters.query
    : wf.nodes.find((n) => n.name === 'Select Due Companies').parameters.query
        .split(NEVER_POLLED_OLD).join(NEVER_POLLED_NEW)
        .split(GENERAL_OLD).join(GENERAL_NEW);
  // Two lane shapes: the first UNION member names its columns ('dream' AS
  // lane FROM companies); the other 3 select positionally into that same
  // column list ('lane_name' FROM companies, no "AS lane").
  const laneChecks = [
    { name: 'dream', anchor: "'dream' AS lane FROM companies", expectLimit: 8 },
    { name: 'never_polled', anchor: "'never_polled' FROM companies", expectLimit: 40 },
    { name: 'earned', anchor: "'earned' FROM companies", expectLimit: 8 },
    { name: 'general', anchor: "'general' FROM companies", expectLimit: 16 },
  ];
  for (const { name, anchor, expectLimit } of laneChecks) {
    const i = q.indexOf(anchor);
    if (i === -1) { console.error(`HARNESS FAIL: lane "${name}" anchor not found in query`); process.exit(1); }
    const m = q.slice(i, i + 400).match(/LIMIT (\d+)\)/);
    if (!m || Number(m[1]) !== expectLimit) { console.error(`HARNESS FAIL: lane "${name}" expected LIMIT ${expectLimit}, got`, m && m[1]); process.exit(1); }
  }
  console.log('HARNESS OK: 4 lanes present, dream=8 (unchanged), never_polled=40 (was 8), earned=8 (unchanged), general=16 (was 8)');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
