/**
 * s124_fix_jsonheaders_regression.js -- urgent regression fix for a bug
 * s122 itself introduced minutes after deploying. s122 switched Fetch ATS's
 * If-None-Match header to JSON mode with the expression
 *   ={{ $json.etag ? { "If-None-Match": $json.etag } : {} }}
 * which evaluates to a real JS OBJECT. n8n's JSON-headers parser
 * (HttpRequestV3.node.js's parseJsonParameter) calls JSON.parse() directly
 * on whatever that expression returns -- JSON.parse() requires a STRING,
 * and calling it on an object throws immediately with "The value in the
 * 'JSON Headers' field is not valid JSON". Confirmed by pulling the real
 * execution data for the very next poller tick (execution 826, 04:15:27):
 * ALL 51 selected companies' Fetch ATS output was this exact error, not a
 * real HTTP response -- this broke every ATS type's fetch, not just
 * Oracle's, for the ~15 minutes between the s122 deploy and this fix.
 *
 * Blast radius, checked directly against Postgres before writing this fix:
 * ZERO companies had last_polled_at update during the broken window --
 * the execution stopped cleanly after Parse Jobs (which tolerates a
 * Fetch-ATS-error item by skipping it) and never reached Tick Bookkeeping/
 * Penalize Failed Boards/Advance Poll State, so no company was incorrectly
 * penalized. The only cost was one wasted 15-minute poll cycle.
 *
 * Fix: wrap the conditional object in JSON.stringify() so the expression
 * returns a real JSON string, matching what parseJsonParameter expects.
 * Verified via a plain-JS round-trip (JSON.parse(JSON.stringify(...)))
 * before deploying, both for the empty-etag and real-etag cases.
 *
 * Run: harness (structural + round-trip proof) + deploy (poller only).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_FILE = path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json');

const OLD_EXPR = '={{ $json.etag ? { "If-None-Match": $json.etag } : {} }}';
const NEW_EXPR = '={{ JSON.stringify($json.etag ? { "If-None-Match": $json.etag } : {}) }}';

function patchPoller() {
  const wf = JSON.parse(fs.readFileSync(POLLER_FILE, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Fetch ATS');
  if (!node) { console.error('INTEGRITY FAIL: Fetch ATS node not found'); process.exit(1); }
  const p = node.parameters;
  if (p.jsonHeaders === NEW_EXPR) { console.log('  poller: already patched'); return; }
  if (p.jsonHeaders !== OLD_EXPR) {
    console.error('INTEGRITY FAIL: jsonHeaders does not match the expected s122 shape -- refusing to patch blind.');
    console.error('Current value:', JSON.stringify(p.jsonHeaders));
    process.exit(1);
  }
  p.jsonHeaders = NEW_EXPR;
  fs.writeFileSync(POLLER_FILE, JSON.stringify(wf, null, 2));
  console.log('OK: Fetch ATS jsonHeaders now returns a real JSON string');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  function evalExpr(etag) {
    return JSON.stringify(etag ? { 'If-None-Match': etag } : {});
  }
  const emptyStr = evalExpr('');
  const realStr = evalExpr('W/"abc123"');
  if (typeof emptyStr !== 'string') { console.error('HARNESS FAIL: expression must return a string, not', typeof emptyStr); process.exit(1); }
  const emptyParsed = JSON.parse(emptyStr);
  const realParsed = JSON.parse(realStr);
  if (Object.keys(emptyParsed).length !== 0) { console.error('HARNESS FAIL: empty etag should round-trip to zero headers'); process.exit(1); }
  if (realParsed['If-None-Match'] !== 'W/"abc123"') { console.error('HARNESS FAIL: real etag should round-trip correctly'); process.exit(1); }
  console.log('HARNESS OK: expression returns a real JSON string that round-trips through JSON.parse for both cases.');

  patchPoller();
  console.log('S124 (jsonHeaders regression fix) script complete.');
})();
