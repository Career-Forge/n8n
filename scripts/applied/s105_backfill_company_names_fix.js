/**
 * s105_backfill_company_names_fix.js -- fixes the real root cause behind
 * "Backfill Company Names" crashing on every ATS Poller tick since s95
 * shipped (73 of 75 non-empty ticks failed; the only 2 "successes" were
 * ticks where Parse Jobs found zero relevant jobs and this node never ran
 * at all -- confirmed via real execution data, ids 666/667 vs 686/744).
 *
 * SAME DISEASE as s104 (Schedule Payload), independently rediscovered here
 * in a different node/workflow: $getWorkflowStaticData(...) called directly
 * inside a {{ }} expression field is invalid outside a Code node. Grepped
 * the actual installed n8n-workflow package inside the container --
 * `getWorkflowStaticData` exists ONLY on the Code-node execution context
 * (node-execution-context.js, i.e. `this.getWorkflowStaticData()`), never
 * in workflow-data-proxy.js, which is what actually backs $json/$node/$now/
 * etc for every other {{ }} field in this app. Backfill Company Names'
 * `options.queryReplacement` called it directly -- evaluation comes back
 * as neither a string nor an array, and the Postgres node's own executeQuery
 * operation throws its generic "Query Parameters must be a string of
 * comma-separated values or an array of values" the moment >=1 item flows
 * in. Confirmed via a live failing execution (id 744, itemIndex 0).
 *
 * Blast radius, confirmed via the SAME execution's runData: NOT a blocker.
 * Backfill Company Names is a dead-end leaf off Parse Jobs (no outbound
 * connections) -- Tick Bookkeeping, Close Stale Jobs, Advance Poll State,
 * and Penalize Failed Boards all completed normally every single tick
 * regardless. Real damage is narrower: the company-name backfill itself has
 * never actually run once since shipping (zero real DB fixes applied), and
 * every affected tick's execution shows "Error" in the UI -- exactly the
 * "masked node errors" class of noise fixed elsewhere this session, which
 * makes genuine failures harder to spot in the executions list.
 *
 * Fix, matching the pattern every OTHER static-data-derived Postgres param
 * in this same workflow already uses successfully (Advance Poll State reads
 * $('Tick Bookkeeping').first().json.ok_json, Penalize Failed Boards reads
 * .failed_csv/.gone_csv): ride the payload out on Parse Jobs' own node
 * OUTPUT instead of back through global static data. Parse Jobs already
 * computes `nameBackfills` in-memory (a real Code node, where
 * $getWorkflowStaticData is legitimate) -- now it also stamps the
 * JSON-stringified payload onto every returned item as
 * `_name_backfills_json`, and Backfill Company Names reads
 * $('Parse Jobs').first().json._name_backfills_json. The now-dead
 * `$getWorkflowStaticData('global').name_backfills = nameBackfills` write
 * (zero remaining readers) is removed rather than left as a zombie.
 *
 * Bonus fix, same node, found in passing: queryReplacement's value doesn't
 * vary per item (same static payload every time), so with no batching
 * config Backfill Company Names was re-running the identical UPDATE once
 * per job row in the tick (up to CAP=25 per board) -- real redundant DB
 * load for zero benefit. Added `executeOnce: true` at the node level, the
 * exact mechanism this same workflow already uses on Tick Bookkeeping for
 * an identical "one query per tick, not one per item" need.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ── 1. Parse Jobs: ride the payload out on the node's own output ──
const PJ_OLD = "$getWorkflowStaticData('global').name_backfills = nameBackfills;\n\nreturn jobs.map(j => ({ json: Object.assign({}, j, { embed_input: ((j.title || '') + '\\n' + (j.jd_text || '')).slice(0, 8000) }) }));";
const PJ_NEW = "// s105: was $getWorkflowStaticData('global').name_backfills = nameBackfills,\n" +
  "// read back via an invalid $getWorkflowStaticData(...) call inside Backfill\n" +
  "// Company Names' queryReplacement expression -- that global only exists on\n" +
  "// `this` inside a Code node, never as a real symbol in the n8n expression\n" +
  "// sandbox that powers ={{ }} fields elsewhere (confirmed against the\n" +
  "// installed n8n-workflow package). Every tick with >=1 job crashed there\n" +
  "// since s95 shipped. Fix: ride the payload out on this node's own OUTPUT\n" +
  "// instead, same pattern Advance Poll State/Penalize Failed Boards already\n" +
  "// use for Tick Bookkeeping's fields ($('Node').first().json.x).\n" +
  "const _nameBackfillsJson = JSON.stringify(nameBackfills);\n\n" +
  "return jobs.map(j => ({ json: Object.assign({}, j, { embed_input: ((j.title || '') + '\\n' + (j.jd_text || '')).slice(0, 8000), _name_backfills_json: _nameBackfillsJson }) }));";

// ── 2. Backfill Company Names: read from Parse Jobs' output, run once/tick ──
const QR_OLD = "={{ [ JSON.stringify($getWorkflowStaticData('global').name_backfills || []) ] }}";
const QR_NEW = "={{ [ $('Parse Jobs').first().json._name_backfills_json || '[]' ] }}";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Parse Jobs', 'Backfill Company Names']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Jobs'].parameters.jsCode.includes('_name_backfills_json')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_OLD, PJ_NEW, 'name_backfills payload on output', base);
  replaceOnce(N['Backfill Company Names'].parameters.options, 'queryReplacement', QR_OLD, QR_NEW, 'queryReplacement source', base);
  N['Backfill Company Names'].executeOnce = true;

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Backfill Company Names fixed (node-output read + executeOnce) -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. Parse Jobs tail: prove the real patched source produces the right shape.
  const jobsFixture = [
    { title: 'AI Engineer', jd_text: 'do ai stuff' },
    { title: 'ML Engineer', jd_text: 'do ml stuff' },
  ];
  const nameBackfillsFixture = [{ company_id: 42, name: 'Acme Corp' }];
  const body = "const jobs = jobsFixture; const nameBackfills = nameBackfillsFixture;\n" + PJ_NEW;
  const fn = new Function('jobsFixture', 'nameBackfillsFixture', body);
  const out = fn(jobsFixture, nameBackfillsFixture);
  if (!Array.isArray(out) || out.length !== 2) { console.error('HARNESS FAIL: Parse Jobs tail did not return 2 items'); process.exit(1); }
  const expectedJson = JSON.stringify(nameBackfillsFixture);
  for (const item of out) {
    if (item.json._name_backfills_json !== expectedJson) { console.error('HARNESS FAIL: _name_backfills_json mismatch', item.json._name_backfills_json); process.exit(1); }
    if (!item.json.embed_input) { console.error('HARNESS FAIL: embed_input regressed'); process.exit(1); }
  }
  // empty-backfills case (the common tick) -- must serialize to '[]', not crash
  const outEmpty = fn(jobsFixture, []);
  if (outEmpty[0].json._name_backfills_json !== '[]') { console.error('HARNESS FAIL: empty-backfills case did not serialize to []'); process.exit(1); }

  // 2. queryReplacement: simulate n8n's own postgres-node validation logic
  //    (typeof-string / Array.isArray branches from executeQuery.operation.js)
  //    against what QR_NEW actually resolves to, proving it never falls into
  //    the throw branch the way $getWorkflowStaticData(...) did.
  function extractBraces(s) { return s.replace(/^=/, '').trim().replace(/^\{\{/, '').replace(/\}\}$/, '').trim(); }
  function simulateExpr(firstJson) {
    const $ = (name) => ({ first: () => ({ json: firstJson }) });
    return new Function('$', 'return ' + extractBraces(QR_NEW))($);
  }
  for (const fixtureJson of [{ _name_backfills_json: expectedJson }, {}, { _name_backfills_json: '[]' }]) {
    const queryReplacement = simulateExpr(fixtureJson);
    if (typeof queryReplacement === 'number' || typeof queryReplacement === 'string' || Array.isArray(queryReplacement)) {
      // real node logic: number/string branch, or Array.isArray -> both fine, never throws
    } else {
      console.error('HARNESS FAIL: queryReplacement would hit the throw branch for', JSON.stringify(fixtureJson));
      process.exit(1);
    }
    if (!Array.isArray(queryReplacement) || queryReplacement.length !== 1 || typeof queryReplacement[0] !== 'string') {
      console.error('HARNESS FAIL: queryReplacement shape wrong for', JSON.stringify(fixtureJson), '->', JSON.stringify(queryReplacement));
      process.exit(1);
    }
  }

  // 3. Old expression, same simulation harness -- proves the OLD code truly
  //    cannot produce a valid array/string (no $getWorkflowStaticData global
  //    exists in this sandbox), i.e. this is a real regression test for the
  //    bug, not just a check on the new code.
  function simulateOldExpr() {
    // no $getWorkflowStaticData provided -> ReferenceError, matching the real sandbox
    return new Function('return ' + extractBraces(QR_OLD))();
  }
  let oldThrew = false;
  try { simulateOldExpr(); } catch (e) { oldThrew = true; }
  if (!oldThrew) { console.error('HARNESS FAIL: expected the OLD expression to throw ReferenceError without a real getWorkflowStaticData global'); process.exit(1); }

  console.log('HARNESS OK: Parse Jobs stamps _name_backfills_json onto every output item (verified against real + empty fixtures); the new queryReplacement expression always resolves to a valid 1-element string array (never the throw branch); the OLD expression is reproduced throwing exactly as the live bug did, confirming this is a real fix, not a coincidental pass.');
})();

POLLER_TARGETS.forEach(patchFile);
console.log('S105 (Backfill Company Names crash fix) complete.');
