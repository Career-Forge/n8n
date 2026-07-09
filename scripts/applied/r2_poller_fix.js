/**
 * r2_poller_fix.js — R2: poller failure handling + ETag.
 *
 * - Build Requests: honor ATS_*_ENABLED env toggles; carry etag per board.
 * - Fetch ATS: send If-None-Match, fullResponse (status + headers visible).
 * - Parse Jobs: defensive body access (fullResponse or legacy shape); skip non-2xx.
 * - Tick Bookkeeping: classify ALL requested boards into ok-parsed / 304 / gone /
 *   failed from Build Requests + Fetch ATS (not Parse Jobs output).
 * - Advance Poll State: advance ok boards, persist new etags (jsonb_to_recordset).
 * - NEW Penalize Failed Boards: failures+1, exponential backoff capped 7d,
 *   deactivate at 5 consecutive failures; 404/410 deactivate immediately.
 *
 * Patches workflows/ and docker/workflows/ copies of CareerForge_ATS_Poller.json.
 * Run:  node scripts/r2_poller_fix.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
];

// Shared defensive response helpers (injected into Code nodes)
const RESP_HELPERS = `
const respOf = (it) => (it || {}).json || {};
const statusOf = (R) => R.statusCode ?? (R.error ? 0 : ((typeof R.body === 'string' || typeof R.data === 'string') ? 200 : 0));
const bodyOf = (R) => typeof R.body === 'string' ? R.body : (typeof R.data === 'string' ? R.data : null);
const etagOf = (R) => { const h = R.headers || {}; return h.etag || h.ETag || h.Etag || ''; };
`.trim();

const BUILD_REQUESTS = `const items = $input.all();
const enabled = (t) => String(process.env['ATS_' + t.toUpperCase() + '_ENABLED'] ?? 'true').toLowerCase() !== 'false';
const IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee'].filter(enabled);
const mkUrl = (t, slug) => ({
  greenhouse: 'https://boards-api.greenhouse.io/v1/boards/' + slug + '/jobs?content=true',
  lever:      'https://api.lever.co/v0/postings/' + slug + '?mode=json',
  ashby:      'https://api.ashbyhq.com/posting-api/job-board/' + slug + '?includeCompensation=true',
  workable:   'https://apply.workable.com/api/v1/widget/accounts/' + slug + '?details=true',
  recruitee:  'https://' + slug + '.recruitee.com/api/offers',
}[t]);
const out = [];
for (const it of items) {
  const c = it.json;
  if (IMPLEMENTED.indexOf(c.ats_type) === -1) continue;
  const u = mkUrl(c.ats_type, c.slug);
  if (!u) continue;
  out.push({ json: { company_id: c.company_id, board: c.board, ats_type: c.ats_type, slug: c.slug, url: u, etag: c.etag || '' } });
}
return out;`;

const TICK_BOOKKEEPING = `${RESP_HELPERS}
const reqs = $('Build Requests').all();
const resps = $('Fetch ATS').all();
const run_start = $('Run Start').first().json.run_start;
const okParsed = [], okEtag = [], gone = [], failed = [];
for (let i = 0; i < reqs.length; i++) {
  const board = reqs[i].json.board;
  const R = respOf(resps[i]);
  const status = statusOf(R);
  if (status === 304) { okEtag.push({ board: board, etag: null }); continue; }
  if (status === 404 || status === 410) { gone.push(board); continue; }
  const body = bodyOf(R);
  if (status >= 200 && status < 300 && body) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) {}
    if (parsed && !parsed.error) {
      okParsed.push(board);
      okEtag.push({ board: board, etag: etagOf(R) || null });
      continue;
    }
  }
  failed.push(board);
}
return [{ json: {
  run_start: run_start,
  boards_csv: okParsed.join(','),
  ok_json: JSON.stringify(okEtag),
  gone_csv: gone.join(','),
  failed_csv: failed.join(','),
} }];`;

const ADVANCE_SQL =
  "UPDATE companies SET last_polled_at = now(), next_poll_at = now() + poll_interval, consecutive_failures = 0, etag = COALESCE(e.etag, companies.etag) " +
  "FROM jsonb_to_recordset($1::jsonb) AS e(board text, etag text) " +
  "WHERE (companies.ats_type || ':' || companies.slug) = e.board";

const PENALIZE_SQL =
  "UPDATE companies SET consecutive_failures = consecutive_failures + 1, last_polled_at = now(), " +
  "next_poll_at = now() + LEAST(poll_interval * POWER(2, LEAST(consecutive_failures + 1, 6)), interval '7 days'), " +
  "is_active = CASE WHEN (ats_type || ':' || slug) = ANY(string_to_array($2, ',')) THEN false ELSE (consecutive_failures + 1) < 5 END " +
  "WHERE (ats_type || ':' || slug) = ANY(string_to_array($1, ',')) OR (ats_type || ':' || slug) = ANY(string_to_array($2, ','))";

for (const file of TARGETS) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });
  const pgCred = N['Select Due Companies'].credentials;

  // 1) Build Requests
  N['Build Requests'].parameters.jsCode = BUILD_REQUESTS;

  // 2) Fetch ATS: If-None-Match + fullResponse
  const fa = N['Fetch ATS'].parameters;
  fa.sendHeaders = true;
  fa.headerParameters = { parameters: [{ name: 'If-None-Match', value: '={{ $json.etag }}' }] };
  fa.options.response.response = { neverError: true, fullResponse: true, responseFormat: 'text', outputPropertyName: 'data' };

  // 3) Parse Jobs: defensive body access + 2xx gate (prepend helpers, swap body line)
  const pj = N['Parse Jobs'];
  let code = pj.parameters.jsCode;
  code = code.replace(
    "let body = null;\n  try { body = JSON.parse(((resps[i] || {}).json || {}).data); } catch (e) { body = null; }\n  if (!body || body.error) continue;",
    "const R = respOf(resps[i]);\n  if (statusOf(R) < 200 || statusOf(R) >= 300) continue;\n  let body = null;\n  try { body = JSON.parse(bodyOf(R)); } catch (e) { body = null; }\n  if (!body || body.error) continue;"
  );
  if (!code.includes('respOf')) throw new Error(`Parse Jobs body-access replace failed in ${file}`);
  pj.parameters.jsCode = RESP_HELPERS + '\n' + code;

  // 4) Tick Bookkeeping rewrite
  N['Tick Bookkeeping'].parameters.jsCode = TICK_BOOKKEEPING;

  // 5) Advance Poll State: etag-aware update
  N['Advance Poll State'].parameters.query = ADVANCE_SQL;
  N['Advance Poll State'].parameters.options.queryReplacement = "={{ [$('Tick Bookkeeping').first().json.ok_json] }}";

  // 6) New Penalize Failed Boards node after Advance Poll State
  if (!N['Penalize Failed Boards']) {
    const node = {
      parameters: {
        operation: 'executeQuery',
        query: PENALIZE_SQL,
        options: { queryReplacement: "={{ [$('Tick Bookkeeping').first().json.failed_csv, $('Tick Bookkeeping').first().json.gone_csv] }}" },
      },
      id: crypto.randomUUID(),
      name: 'Penalize Failed Boards',
      type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6,
      position: [2300, 300],
      credentials: pgCred,
    };
    wf.nodes.push(node);
    wf.connections['Advance Poll State'] = { main: [[{ node: 'Penalize Failed Boards', type: 'main', index: 0 }]] };
  }

  // 7) Update sticky note
  const sticky = N['Sticky Note'];
  if (sticky) {
    sticky.parameters.content = sticky.parameters.content.replace(
      /\n\nOllama URL\/model hardcoded/,
      '\n\nFailure bookkeeping: ok boards advance + save etag; failed boards back off exponentially (cap 7d) and deactivate after 5 strikes; 404/410 deactivate immediately; 304 advances without liveness diff.\n\nOllama URL/model hardcoded'
    );
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`${file}: patched (${wf.nodes.length} nodes).`);
}
console.log('R2 patch complete.');
