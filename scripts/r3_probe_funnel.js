/**
 * r3_probe_funnel.js — R3: title pre-filter + yield-based promotion funnel.
 *
 * - Parse Jobs: TITLE_RX gate inside push() — irrelevant jobs are dropped
 *   BEFORE embedding (the big volume cut for the 15.5K-board probe sweep).
 * - Tick Bookkeeping: per-board relevant counts from Parse Jobs output
 *   (304 boards send relevant = -1, meaning "no information — change nothing").
 * - Advance Poll State: monotonic promotion (probe -> cold/warm/hot by yield;
 *   never auto-demote; dream tier label preserved), relevant_yield accumulation.
 *
 * Apply AFTER r2_poller_fix.js. Patches both poller JSON copies.
 * Run:  node scripts/r3_probe_funnel.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
];

// Target-profile title filter. Tune freely — this is the probe sweep's throttle.
const TITLE_RX_SRC =
  "(machine\\s*learning|\\bml\\b|\\bai\\b|artificial\\s*intelligence|data\\s*(scien|engineer|analy|platform)|analytics\\s*engineer|deep\\s*learning|\\bnlp\\b|\\bllm\\b|gen\\s*ai|generative|computer\\s*vision|research\\s*(scientist|engineer)|applied\\s*scientist|software\\s*engineer|\\bswe\\b|\\bsde\\b|backend|back-end|full[\\s-]*stack|platform\\s*engineer|infrastructure\\s*engineer|devops|mlops|\\bsre\\b)";

const PUSH_OLD =
  "const push = (board, obj) => { count[board] = (count[board] || 0); if (count[board] >= CAP) return; count[board]++; jobs.push(obj); };";
const PUSH_NEW =
  "const TITLE_RX = new RegExp(\"" + TITLE_RX_SRC + "\", 'i');\n" +
  "const push = (board, obj) => { if (!TITLE_RX.test(String(obj.title || ''))) return; count[board] = (count[board] || 0); if (count[board] >= CAP) return; count[board]++; jobs.push(obj); };";

const TICK_OLD_OK = "okEtag.push({ board: board, etag: etagOf(R) || null });";
const TICK_NEW_OK = "okEtag.push({ board: board, etag: etagOf(R) || null, relevant: relByBoard[board] || 0 });";
const TICK_OLD_304 = "okEtag.push({ board: board, etag: null });";
const TICK_NEW_304 = "okEtag.push({ board: board, etag: null, relevant: -1 });";
const TICK_REL_PRELUDE =
  "const relByBoard = {};\nfor (const it of $('Parse Jobs').all()) { const b = it.json.board; relByBoard[b] = (relByBoard[b] || 0) + 1; }\n";

const ADVANCE_SQL =
  "UPDATE companies SET " +
  "last_polled_at = now(), consecutive_failures = 0, " +
  "etag = COALESCE(e.etag, companies.etag), " +
  "relevant_yield = relevant_yield + GREATEST(e.relevant, 0), " +
  "poll_interval = CASE " +
  "WHEN e.relevant >= 3 THEN LEAST(poll_interval, interval '3 hours') " +
  "WHEN e.relevant >= 1 THEN LEAST(poll_interval, interval '24 hours') " +
  "WHEN e.relevant = 0 AND tier = 'probe' THEN interval '30 days' " +
  "ELSE poll_interval END, " +
  "tier = CASE " +
  "WHEN tier = 'dream' THEN 'dream' " +
  "WHEN e.relevant >= 3 THEN 'hot' " +
  "WHEN e.relevant >= 1 AND tier <> 'hot' THEN 'warm' " +
  "WHEN e.relevant = 0 AND tier = 'probe' THEN 'cold' " +
  "ELSE tier END, " +
  "next_poll_at = now() + (CASE " +
  "WHEN e.relevant >= 3 THEN LEAST(poll_interval, interval '3 hours') " +
  "WHEN e.relevant >= 1 THEN LEAST(poll_interval, interval '24 hours') " +
  "WHEN e.relevant = 0 AND tier = 'probe' THEN interval '30 days' " +
  "ELSE poll_interval END) " +
  "FROM jsonb_to_recordset($1::jsonb) AS e(board text, etag text, relevant int) " +
  "WHERE (companies.ats_type || ':' || companies.slug) = e.board";

for (const file of TARGETS) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  // 1) Parse Jobs: title gate in push()
  const pj = N['Parse Jobs'];
  if (pj.parameters.jsCode.includes('TITLE_RX')) {
    console.log(`${file}: TITLE_RX already present`);
  } else {
    if (!pj.parameters.jsCode.includes(PUSH_OLD)) throw new Error(`push() anchor not found in ${file}`);
    pj.parameters.jsCode = pj.parameters.jsCode.replace(PUSH_OLD, PUSH_NEW);
  }

  // 2) Tick Bookkeeping: relevant counts
  const tb = N['Tick Bookkeeping'];
  let code = tb.parameters.jsCode;
  if (!code.includes('relByBoard')) {
    if (!code.includes(TICK_OLD_OK) || !code.includes(TICK_OLD_304)) throw new Error(`Tick anchors not found in ${file}`);
    code = code.replace("const okParsed = [], okEtag = [], gone = [], failed = [];", TICK_REL_PRELUDE + "const okParsed = [], okEtag = [], gone = [], failed = [];");
    code = code.replace(TICK_OLD_OK, TICK_NEW_OK).replace(TICK_OLD_304, TICK_NEW_304);
    tb.parameters.jsCode = code;
  }

  // 3) Advance Poll State: promotion funnel
  N['Advance Poll State'].parameters.query = ADVANCE_SQL;

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`${file}: R3 funnel patched.`);
}
console.log('R3 patch complete.');
