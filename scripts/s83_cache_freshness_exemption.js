/**
 * s83_cache_freshness_exemption.js -- stop discarding liveness-verified cache
 * rows for being "posted too long ago." Evidence (exec 582, 2026-07-14):
 * Netflix "AI Engineer 6" (posted 2024-07-23, STILL LIVE, liveness-verified by
 * the poller) and "Staff ML Software Engineer" (posted 2026-06-11) were both
 * dropped by the silent 7-day freshness default. Cache Prefilter maps
 * posted_at -> updated_at, and Aggregate Jobs' recency filter cuts anything
 * older than the freshness window (default qdr:w). For tier-1 cache rows this
 * is redundant AND harmful: status='active' already means the poller saw the
 * posting live within its poll interval, and Close Stale Jobs retires the
 * dead ones. Big-company postings routinely stay open for months.
 *
 * Design (one PLANNED DEVIATION, documented): the plan sketched an LLM-emitted
 * `freshness_explicit` field plus a deterministic backstop. Implemented as
 * PURELY deterministic instead -- a regex over the raw message in Parse
 * Expand Query -- because s82 exists precisely because LLM booleans wired to
 * hard filters wobble. No LLM field, no wobble, same semantics.
 *
 * - Parse Expand Query (3 mirrors): result.freshness_explicit = time-window
 *   regex test on the raw message (via Prep Expand Input, same access pattern
 *   as s82's gate).
 * - Aggregate Jobs (3 mirrors): recency filter exempts source==='cache' rows
 *   unless freshness_explicit -- web lanes unchanged (old web hit = likely
 *   dead is still a good heuristic there; cache has a better mechanism).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ── (1) Parse Expand Query: deterministic flag, appended after the s82 gate ──
const PEQ_ANCHOR = "} catch (e) { /* Prep Expand Input always runs on this path; fail-open keeps the parsed value */ }";
const FRESH_FLAG =
  "\n\n// s83: freshness_explicit gates the cache-lane recency exemption downstream.\n" +
  "// Purely deterministic (no LLM field -- s82 exists because LLM booleans wired\n" +
  "// to hard filters wobble): true only when the message states a time window.\n" +
  "const FRESH_LANG_RX = /last\\s*\\d+\\s*(hour|day|week|month)|past\\s*(day|week|month|24)|24\\s*hours?|this\\s*week|today|newest|latest|just\\s*posted|recently\\s*posted|posted\\s*(in|within|recently)/i;\n" +
  "try {\n" +
  "  result.freshness_explicit = FRESH_LANG_RX.test(String($('Prep Expand Input').first().json.message_text || ''));\n" +
  "} catch (e) { result.freshness_explicit = false; }";
const PEQ_NEW = PEQ_ANCHOR + FRESH_FLAG;

// ── (2) Aggregate Jobs: cache exemption in the recency filter ──
const AJ_OLD = "// Recency filter (soft)\nfiltered = filtered.filter(j => {\n  if (!j.updated_at) return true;\n  const t = new Date(j.updated_at).getTime();\n  return isNaN(t) || t >= cutoff;\n});";
const AJ_NEW = "// Recency filter (soft). s83: cache rows are liveness-verified by the poller\n" +
  "// (status='active' = seen live within the poll interval; Close Stale Jobs\n" +
  "// retires the dead) -- a posted-date cutoff there throws away verified-live\n" +
  "// jobs (exec 582 dropped a still-live 2024 Netflix posting). Cache rows are\n" +
  "// exempt unless the user explicitly asked for a time window. Web lanes\n" +
  "// unchanged: an old web hit really is likely dead.\n" +
  "const freshnessExplicit = expandCtx.freshness_explicit === true;\n" +
  "filtered = filtered.filter(j => {\n" +
  "  if (j.source === 'cache' && !freshnessExplicit) return true;\n" +
  "  if (!j.updated_at) return true;\n" +
  "  const t = new Date(j.updated_at).getTime();\n" +
  "  return isNaN(t) || t >= cutoff;\n" +
  "});";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Parse Expand Query', 'Aggregate Jobs']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Expand Query'].parameters.jsCode.includes('FRESH_LANG_RX')) { console.log(`  ${base}: already patched`); return; }
  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', PEQ_ANCHOR, PEQ_NEW, 'freshness_explicit flag', base);
  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', AJ_OLD, AJ_NEW, 'cache recency exemption', base);
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: freshness_explicit flag + cache recency exemption -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // (a) the flag regex, run for real against real queries from this session
  const flagOf = (msg) => new Function('$',
    FRESH_FLAG.replace('result.freshness_explicit =', 'return').replace(/try \{|\} catch[^]*$/g, '').trim()
  )(() => ({ first: () => ({ json: { message_text: msg } }) }));
  const flagCases = [
    ['Find me AI jobs in MAANG worldwide', false],
    ['Find me AI jobs in MAANGO-style companies worldwide', false],
    ['newest AI jobs at MAANG this week', true],
    ['AI roles posted in the last 24 hours', true],
    ['show latest ML openings', true],
    ['find AI jobs in Bangalore', false],
  ];
  for (const [msg, want] of flagCases) {
    const got = flagOf(msg);
    if (got !== want) { console.error(`HARNESS FAIL flag: "${msg}" -> ${got}, wanted ${want}`); process.exit(1); }
  }

  // (b) the recency filter, run for real with exec-582's actual casualties
  const CUTOFF = Date.parse('2026-07-07T00:00:00Z'); // 7 days before 2026-07-14
  const rows = [
    { label: 'Netflix AI Engineer 6 (posted 2024-07-23, LIVE)', source: 'cache', updated_at: '2024-07-23T00:00:00' },
    { label: 'Staff ML Software Engineer (posted 2026-06-11, LIVE)', source: 'cache', updated_at: '2026-06-11T00:00:00' },
    { label: 'fresh cache row', source: 'cache', updated_at: '2026-07-13T00:00:00' },
    { label: 'old web-lane row', source: 'serper', updated_at: '2026-05-01T00:00:00' },
    { label: 'fresh web-lane row', source: 'youcom', updated_at: '2026-07-13T00:00:00' },
    { label: 'no-date row', source: 'serper', updated_at: null },
  ];
  function runFilter(jobs, freshnessExplicit) {
    const body = AJ_NEW
      .replace("const freshnessExplicit = expandCtx.freshness_explicit === true;", "")
      .replace(/^\/\/[^\n]*\n/gm, '')
      .replace('filtered = filtered.filter', 'return jobs.filter');
    return new Function('jobs', 'cutoff', 'freshnessExplicit', body)(jobs, CUTOFF, freshnessExplicit);
  }
  const keptDefault = runFilter(rows, false).map((r) => r.label);
  const wantDefault = ['Netflix AI Engineer 6 (posted 2024-07-23, LIVE)', 'Staff ML Software Engineer (posted 2026-06-11, LIVE)', 'fresh cache row', 'fresh web-lane row', 'no-date row'];
  if (JSON.stringify(keptDefault) !== JSON.stringify(wantDefault)) { console.error('HARNESS FAIL default-mode kept: ' + JSON.stringify(keptDefault)); process.exit(1); }
  const keptExplicit = runFilter(rows, true).map((r) => r.label);
  const wantExplicit = ['fresh cache row', 'fresh web-lane row', 'no-date row'];
  if (JSON.stringify(keptExplicit) !== JSON.stringify(wantExplicit)) { console.error('HARNESS FAIL explicit-mode kept: ' + JSON.stringify(keptExplicit)); process.exit(1); }

  // (c) old-code repro: the exec-582 casualties DO die under the old filter
  const oldKept = rows.filter((j) => { if (!j.updated_at) return true; const t = new Date(j.updated_at).getTime(); return isNaN(t) || t >= CUTOFF; }).map((r) => r.label);
  if (oldKept.includes('Netflix AI Engineer 6 (posted 2024-07-23, LIVE)')) { console.error('HARNESS FAIL: old code does not reproduce the drop -- fixture unfaithful'); process.exit(1); }

  console.log('HARNESS OK: flag regex correct on all six real queries; new filter keeps both exec-582 casualties by default, still date-filters cache when a time window is stated, web lanes byte-identical in behavior; old code proven to reproduce the drops.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S83 (cache freshness exemption for liveness-verified rows) complete.');
