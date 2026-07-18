/**
 * s122_fix_oracle_etag_header.js -- real, previously-undiscovered production
 * bug, found while chasing why JPMorgan Chase / Goldman Sachs kept showing
 * 0 jobs despite the s114 Oracle `expand=requisitionList` fix being
 * confirmed correctly deployed and confirmed working via direct curl.
 *
 * Root cause: `Fetch ATS` (poller workflow) is a UI-configured HTTP Request
 * node, not a Code node -- it sends `If-None-Match: {{ $json.etag }}` on
 * EVERY request via keypair-mode headerParameters, unconditionally, even
 * when etag is the empty string (true for every company on its first-ever
 * poll, or any company whose etag was cleared). n8n's keypair header mode
 * does NOT drop a header just because its value is empty -- it sends a
 * real `If-None-Match: ` header with a blank value.
 *
 * Oracle's own recruitingCEJobRequisitions endpoint validates that header
 * strictly and rejects it outright: pulled the real Fetch ATS response for
 * JPMorgan Chase from execution 825 (2026-07-18) and found
 *   HTTP 400, body: "The header if-none-match with value  is not valid."
 * Confirmed this affects EVERY oracle-type company on first poll, not just
 * JPMorgan/Goldman -- Macy's (one of the 17 s120 companies) hit the exact
 * same 400 on its own first-ever poll tick, and all 15 other s120 rows plus
 * the original Oracle row were still sitting at last_polled_at=NULL,
 * meaning they'd have hit this identical wall the moment their tier's
 * queue reached them. Every other seeded ATS type (greenhouse/lever/ashby/
 * workday/etc) tolerates an empty If-None-Match value -- Oracle is simply
 * the first provider in this registry strict enough to reject it, which is
 * why this bug went undetected until now.
 *
 * Fix: switch `Fetch ATS`'s header mode from keypair to JSON, with a
 * conditional expression that omits the If-None-Match key ENTIRELY when
 * etag is falsy, and includes it normally once a real etag exists (the
 * 304-caching behavior this header exists for still works for every
 * ats_type once a company has been polled at least once successfully).
 *
 * Run: harness (structural anchor check) + deploy (poller only) + verify
 * (force an immediate retry on all 20 oracle-type companies, watch the
 * next real poll tick land real jobs).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_FILE = path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json');

function patchPoller() {
  const wf = JSON.parse(fs.readFileSync(POLLER_FILE, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Fetch ATS');
  if (!node) { console.error('INTEGRITY FAIL: Fetch ATS node not found'); process.exit(1); }

  const p = node.parameters;
  if (p.specifyHeaders === 'json' && p.jsonHeaders && p.jsonHeaders.includes('$json.etag ?')) {
    console.log('  poller: already patched');
    return;
  }

  // Anchor check: confirm the exact known-broken shape before touching it,
  // so this script fails loudly instead of silently no-op'ing on a workflow
  // that has already drifted from what this fix assumes.
  const hp = p.headerParameters;
  const isKnownShape = p.sendHeaders === true
    && (!p.specifyHeaders || p.specifyHeaders === 'keypair')
    && hp && Array.isArray(hp.parameters) && hp.parameters.length === 1
    && hp.parameters[0].name === 'If-None-Match'
    && hp.parameters[0].value === '={{ $json.etag }}';
  if (!isKnownShape) {
    console.error('INTEGRITY FAIL: Fetch ATS headerParameters shape does not match the expected pre-fix state -- refusing to patch blind.');
    console.error('Current parameters:', JSON.stringify(p, null, 2));
    process.exit(1);
  }

  delete p.headerParameters;
  p.specifyHeaders = 'json';
  p.jsonHeaders = "={{ $json.etag ? { \"If-None-Match\": $json.etag } : {} }}";

  fs.writeFileSync(POLLER_FILE, JSON.stringify(wf, null, 2));
  console.log('OK: Fetch ATS now omits If-None-Match entirely when etag is empty');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // Simulate n8n's own expression evaluation semantics for both cases.
  function evalJsonHeaders(etag) {
    // eslint-disable-next-line no-new-func
    const fn = new Function('$json', 'return (' + "$json.etag ? { \"If-None-Match\": $json.etag } : {}" + ');');
    return fn({ etag });
  }
  const emptyCase = evalJsonHeaders('');
  const realCase = evalJsonHeaders('W/"abc123"');
  if (Object.keys(emptyCase).length !== 0) { console.error('HARNESS FAIL: empty etag should produce zero headers, got', emptyCase); process.exit(1); }
  if (realCase['If-None-Match'] !== 'W/"abc123"') { console.error('HARNESS FAIL: real etag should produce If-None-Match header, got', realCase); process.exit(1); }
  console.log('HARNESS OK: conditional header expression verified for both empty and real etag cases.');

  patchPoller();
  console.log('S122 (Oracle If-None-Match header fix) script complete.');
})();
