/**
 * s131_miniapp_bridge_webhook.js -- adds a 3-node webhook island to the
 * master workflow so the Mini App's FastAPI sidecar can read a snapshot
 * of n8n's session staticData (user_prefs, last_jobs, tracked_applications,
 * last_apply, last_search_intent) without n8n ever giving up being the
 * sole reader/writer of that staticData -- the sidecar gets a read-only
 * copy over HTTP, nothing more.
 *
 * First webhook-type node ever added to this workflow (confirmed via
 * exploration: zero n8n-nodes-base.webhook nodes exist anywhere in the 3
 * live workflows today). Webhook nodes register independently of other
 * triggers in an ACTIVE workflow -- the existing Telegram Trigger +
 * Schedule Tick pair already proves multi-trigger works here, an
 * unconnected Webhook-node island is the same mechanism.
 *
 * Auth: a shared secret header (X-Miniapp-Secret vs $env.MINIAPP_BRIDGE_SECRET),
 * checked first, before any staticData read. This path is NEVER mounted on
 * the public Tailscale Funnel (only /webhook/careerforge-telegram is) --
 * the secret is defense-in-depth for anything reaching the docker network
 * directly, not the primary access control.
 *
 * The snapshot deliberately STRIPS last_apply down to summary fields --
 * resume_json/cover_json/skeletons/resume_text/job_description are
 * hundreds of KB each and the Mini App never needs them (it links out to
 * the real PDFs already sent in Telegram).
 *
 * Run: harness (secret-check + snapshot-shape assertions against a mocked
 * $env/$getWorkflowStaticData) + deploy (master only) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

const BRIDGE_SNAPSHOT_CODE = `// Miniapp Bridge (s131) -- n8n stays the sole reader/writer of staticData;
// this node serializes a READ-ONLY snapshot for the FastAPI sidecar.
// Secret check first, before any staticData read -- this webhook path is
// never mounted on the public Tailscale Funnel (only the Telegram webhook
// is), so this is defense-in-depth, not the primary access control.
const req = $input.first().json;                       // Webhook node shape: {headers, params, query, body}
const secret = (req.headers || {})['x-miniapp-secret'];
if (!$env.MINIAPP_BRIDGE_SECRET || secret !== $env.MINIAPP_BRIDGE_SECRET) {
  return [{ json: { _status: 401, ok: false, error: 'unauthorized' } }];
}
const action = (req.body || {}).action || 'snapshot';
const sd = $getWorkflowStaticData('global');
if (action === 'snapshot') {
  const la = sd.last_apply || null;
  // STRIP the heavy fields -- resume_json/cover_json/skeletons/resume_text/
  // job_description are hundreds of KB each and the app only needs the
  // summary (it links to the PDFs already delivered in Telegram).
  const lastApply = la ? {
    job_id: la.job_id, job_title: la.job_title,
    company: la.company, location: la.location || '',
    url: la.url || null,
    forge_score: la.forge_score || null,
    seniority_mode: la.seniority_mode || null,
    timestamp: la.timestamp || null
  } : null;
  return [{ json: {
    _status: 200, ok: true, generated_at: new Date().toISOString(),
    user_prefs: sd.user_prefs || null,
    last_jobs: sd.last_jobs || {},
    last_jobs_created_at: sd.last_jobs_created_at || null,
    tracked_applications: sd.tracked_applications || [],
    last_apply: lastApply,
    last_search_intent: sd.last_search_intent || null
  } }];
}
return [{ json: { _status: 400, ok: false, error: 'unknown action: ' + action } }];`;

const MINIAPP_BRIDGE_NODE = {
  parameters: {
    httpMethod: 'POST',
    path: 'miniapp-bridge',
    responseMode: 'responseNode',
    options: {},
  },
  id: 'e2a6f4c1-9b3d-4a7e-8c5f-1d6e0b3a7f92',
  name: 'Miniapp Bridge',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [21712, 52800],
  webhookId: 'miniapp-bridge',
};

const BRIDGE_SNAPSHOT_NODE = {
  parameters: { jsCode: BRIDGE_SNAPSHOT_CODE },
  id: 'f3b7a5d2-0c4e-4b8f-9d6a-2e7f1c4b8a03',
  name: 'Bridge Snapshot',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [22032, 52800],
};

const BRIDGE_RESPOND_NODE = {
  parameters: {
    respondWith: 'firstIncomingItem',
    options: { responseCode: '={{ $json._status || 200 }}' },
  },
  id: 'a1c9e6f4-3d8b-4e2a-8f5c-6b9d0e3a7c14',
  name: 'Bridge Respond',
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  position: [22352, 52800],
};

function patch() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const byName = {}; wf.nodes.forEach((n) => { byName[n.name] = n; });

  if (byName['Miniapp Bridge']) {
    console.log('  master: already patched (Miniapp Bridge exists)');
    return;
  }

  wf.nodes.push(JSON.parse(JSON.stringify(MINIAPP_BRIDGE_NODE)));
  wf.nodes.push(JSON.parse(JSON.stringify(BRIDGE_SNAPSHOT_NODE)));
  wf.nodes.push(JSON.parse(JSON.stringify(BRIDGE_RESPOND_NODE)));

  wf.connections['Miniapp Bridge'] = { main: [[{ node: 'Bridge Snapshot', type: 'main', index: 0 }]] };
  wf.connections['Bridge Snapshot'] = { main: [[{ node: 'Bridge Respond', type: 'main', index: 0 }]] };

  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log(`  master: 3-node bridge island added (${wf.nodes.length} nodes total)`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  try { new Function('$input', '$env', '$getWorkflowStaticData', BRIDGE_SNAPSHOT_CODE); }
  catch (e) { console.error('HARNESS FAIL: Bridge Snapshot code does not parse:', e.message); process.exit(1); }

  function run(headers, body, env, sd) {
    const $input = { first: () => ({ json: { headers: headers || {}, body: body || {} } }) };
    const $env = env || {};
    const $getWorkflowStaticData = () => sd || {};
    const fn = new Function('$input', '$env', '$getWorkflowStaticData', BRIDGE_SNAPSHOT_CODE);
    return fn($input, $env, $getWorkflowStaticData)[0].json;
  }

  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  // 1. No secret configured at all -> 401 (fail closed, never fail open on missing config)
  check('no MINIAPP_BRIDGE_SECRET configured -> 401',
    run({}, {}, {}, {})._status === 401);

  // 2. Wrong secret -> 401
  check('wrong secret -> 401',
    run({ 'x-miniapp-secret': 'wrong' }, {}, { MINIAPP_BRIDGE_SECRET: 'right' }, {})._status === 401);

  // 3. No secret header at all -> 401
  check('missing header -> 401',
    run({}, {}, { MINIAPP_BRIDGE_SECRET: 'right' }, {})._status === 401);

  // 4. Correct secret + snapshot action -> 200, full shape, heavy fields stripped
  const sdFixture = {
    user_prefs: { location_canonical: 'IN' },
    last_jobs: { '1': { job_id: 'x', title: 'AI Engineer' } },
    last_jobs_created_at: '2026-07-19T00:00:00.000Z',
    tracked_applications: [{ job_id: 'x', status: 'applied' }],
    last_apply: {
      job_id: 'x', job_title: 'AI Engineer', company: 'Acme', location: 'Remote',
      url: 'https://acme.com/jobs/1', forge_score: { overall_score: 8.1 },
      seniority_mode: 'mid', timestamp: '2026-07-19T00:00:00.000Z',
      resume_json: { huge: 'x'.repeat(1000) }, resume_text: 'x'.repeat(1000),
      job_description: 'x'.repeat(1000), resume_skeleton: 'x'.repeat(1000),
    },
    last_search_intent: { role_families: ['AI Engineer'] },
  };
  const ok = run({ 'x-miniapp-secret': 'right' }, { action: 'snapshot' }, { MINIAPP_BRIDGE_SECRET: 'right' }, sdFixture);
  check('correct secret -> 200', ok._status === 200 && ok.ok === true);
  check('snapshot carries user_prefs', JSON.stringify(ok.user_prefs) === JSON.stringify(sdFixture.user_prefs));
  check('snapshot carries last_jobs', JSON.stringify(ok.last_jobs) === JSON.stringify(sdFixture.last_jobs));
  check('snapshot carries tracked_applications', JSON.stringify(ok.tracked_applications) === JSON.stringify(sdFixture.tracked_applications));
  check('last_apply stripped to summary fields only',
    ok.last_apply.job_id === 'x' && ok.last_apply.forge_score.overall_score === 8.1 &&
    !('resume_json' in ok.last_apply) && !('resume_text' in ok.last_apply) &&
    !('job_description' in ok.last_apply) && !('resume_skeleton' in ok.last_apply));

  // 5. Empty staticData -> all fields default safely, no throw
  const empty = run({ 'x-miniapp-secret': 'right' }, { action: 'snapshot' }, { MINIAPP_BRIDGE_SECRET: 'right' }, {});
  check('empty staticData -> 200 with safe defaults',
    empty._status === 200 && empty.user_prefs === null && JSON.stringify(empty.last_jobs) === '{}' &&
    JSON.stringify(empty.tracked_applications) === '[]' && empty.last_apply === null);

  // 6. Unknown action -> 400
  check('unknown action -> 400',
    run({ 'x-miniapp-secret': 'right' }, { action: 'bogus' }, { MINIAPP_BRIDGE_SECRET: 'right' }, {})._status === 400);

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: bridge secret-check (missing config/wrong/absent all 401) + snapshot shape (heavy last_apply fields stripped) + empty-staticData safety + unknown-action 400.');

  patch();
  console.log('S131 (miniapp bridge webhook) script complete.');
})();
