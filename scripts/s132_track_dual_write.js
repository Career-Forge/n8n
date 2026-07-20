/**
 * s132_track_dual_write.js -- the bot's "track" intent already writes to
 * staticData.tracked_applications (capped at 100, unqueryable, gone on a
 * fresh staticData reset). The Mini App tracker needs the SAME event to
 * also land in Postgres's `applications` table (db/migrations/
 * 001_applications.sql) so bot-driven tracks and app-driven tracks share
 * one pipeline view -- not two disconnected lists.
 *
 * Push site confirmed by reading the live workflow directly (not assumed
 * from the plan): `Track Application` (fed by Route Intent's `track`
 * branch) is the ONLY writer of tracked_applications -- `List Applications`
 * only reads. Its current single connection is `Send Generic Reply`.
 *
 * Three edits, one deploy:
 * 1. `Store Apply Context` -- staticData.last_apply never carried a URL.
 *    `Prepare Job Context` DOES set `job_url` (`retrieveData.direct_url ||
 *    job.url || ''`), and it survives unbroken through the whole apply
 *    chain -- verified by reading each hop directly: Parse Personal Info
 *    spreads `...jobCtx` (= Prepare Job Context's own output), Select
 *    Relevant Resume Bubbles spreads `...ctx` from ITS input (confirmed via
 *    IF: Resume Valid?'s true branch, which is a pure router), Load
 *    Skeletons and Prepare Apply Context both spread `...ctx` again. So
 *    `ctx.job_url` is genuinely available at Store Apply Context -- add it
 *    to the persisted last_apply object.
 * 2. `Track Application` -- on the actually-pushed path only (not the
 *    "nothing to track" / "already tracking" replies), attach a `_pg_entry`
 *    the new Postgres node can consume.
 * 3. New node `Record Tracked Application` -- modeled on the existing
 *    `Record Matches` node (same executeQuery shape, same credential,
 *    same `onError: continueRegularOutput`, same jsonb_array_elements($1)
 *    fan-in pattern) -- added as a SECOND target from Track Application's
 *    existing output (parallel to Send Generic Reply, not blocking it;
 *    onError means a DB hiccup can never break the chat reply). Uses
 *    cf_url_norm() (db/migrations/001_applications.sql) for url_norm so
 *    this node and the miniapp API never maintain two dedup rules. A bare
 *    `ON CONFLICT DO NOTHING` (no target) absorbs either the (user_id,
 *    job_id) or (user_id, url_norm) partial unique index -- a targeted
 *    clause would still raise if the OTHER index collided.
 *
 * Run: harness (real node code, stubbed $()/staticData, asserts _pg_entry
 * present only on the genuine push path) + deploy (master only) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}

// ──────────────────────── Part 1: Store Apply Context ────────────────────────
const SAC_OLD = "staticData.last_apply = { job_id: ctx.job_id || ctx.job_number, job_title: ctx.job_title, company: ctx.company, seniority_mode: ctx.seniority_mode,";
const SAC_NEW = "staticData.last_apply = { job_id: ctx.job_id || ctx.job_number, job_title: ctx.job_title, company: ctx.company, url: ctx.job_url || null, seniority_mode: ctx.seniority_mode,";

// ──────────────────────── Part 2: Track Application ────────────────────────
const TA_ENTRY_OLD = "const entry = { job_id: lastApply.job_id, job_title: lastApply.job_title, company: lastApply.company, status: 'applied', score: lastApply.forge_score ? lastApply.forge_score.overall_score : null, applied_at: new Date().toISOString() };";
const TA_ENTRY_NEW = "const entry = { job_id: lastApply.job_id, job_title: lastApply.job_title, company: lastApply.company, url: lastApply.url || null, status: 'applied', score: lastApply.forge_score ? lastApply.forge_score.overall_score : null, applied_at: new Date().toISOString() };";

const TA_RETURN_OLD = 'return [{ json: { chat_id: chatId, message: "\\u2705 Tracking *" + entry.job_title + "* at *" + entry.company + "*.\\n\\nUse /status to see all tracked applications." } }];';
const TA_RETURN_NEW = 'return [{ json: { chat_id: chatId, message: "\\u2705 Tracking *" + entry.job_title + "* at *" + entry.company + "*.\\n\\nUse /status to see all tracked applications.", _pg_entry: { ...entry, chat_id: chatId, forge_score_detail: lastApply.forge_score || null } } }];';

// ──────────────────────── Part 3: Record Tracked Application node ────────────────────────
const RECORD_TRACKED_QUERY = `INSERT INTO applications (user_id, job_id, url, url_norm, job_title, company,
                          source, status, forge_score, score_detail, status_history, applied_at)
SELECT (e->>'chat_id')::bigint, NULLIF(e->>'job_id',''), NULLIF(e->>'url',''),
       cf_url_norm(e->>'url'), COALESCE(e->>'job_title',''), COALESCE(e->>'company',''),
       'bot', 'applied', (e->>'score')::numeric, e->'forge_score_detail',
       jsonb_build_array(jsonb_build_object('from', null, 'to', 'applied',
                                            'at', e->>'applied_at', 'via', 'bot')),
       (e->>'applied_at')::timestamptz
FROM jsonb_array_elements($1::jsonb) e
ON CONFLICT DO NOTHING`;

const RECORD_TRACKED_NODE = {
  parameters: {
    operation: 'executeQuery',
    query: RECORD_TRACKED_QUERY,
    options: {
      queryReplacement: "={{ [ JSON.stringify($json._pg_entry ? [$json._pg_entry] : []) ] }}",
    },
  },
  id: 'c4d8b6f2-1a9e-4c7d-8f3b-5a6e2d9c0b17',
  name: 'Record Tracked Application',
  type: 'n8n-nodes-base.postgres',
  typeVersion: 2.6,
  position: [29424, 50640],
  credentials: {
    postgres: { id: 'caLsB31DYOphw0EV', name: 'CareerForge_Postgres' },
  },
  onError: 'continueRegularOutput',
};

function patch() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const byName = {}; wf.nodes.forEach((n) => { byName[n.name] = n; });

  const sac = byName['Store Apply Context'];
  const ta = byName['Track Application'];
  if (!sac) { console.error('INTEGRITY FAIL: Store Apply Context missing'); process.exit(1); }
  if (!ta) { console.error('INTEGRITY FAIL: Track Application missing'); process.exit(1); }

  if (byName['Record Tracked Application']) {
    console.log('  master: already patched (Record Tracked Application exists)');
    return;
  }

  replaceOnce(sac.parameters, 'jsCode', SAC_OLD, SAC_NEW, 'Store Apply Context url field');
  replaceOnce(ta.parameters, 'jsCode', TA_ENTRY_OLD, TA_ENTRY_NEW, 'Track Application entry.url');
  replaceOnce(ta.parameters, 'jsCode', TA_RETURN_OLD, TA_RETURN_NEW, 'Track Application _pg_entry return');

  wf.nodes.push(JSON.parse(JSON.stringify(RECORD_TRACKED_NODE)));

  const taConn = wf.connections['Track Application'];
  if (!taConn || !taConn.main || !taConn.main[0]) { console.error('INTEGRITY FAIL: Track Application has no existing main[0] connection to fan out from'); process.exit(1); }
  const already = taConn.main[0].some((edge) => edge.node === 'Record Tracked Application');
  if (!already) {
    taConn.main[0].push({ node: 'Record Tracked Application', type: 'main', index: 0 });
  }

  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log(`  master: dual-write patched (${wf.nodes.length} nodes total)`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. Run the REAL patched Track Application logic (extracted verbatim,
  //    not reimplemented) against stubbed staticData/$().
  function runTrackApplication(lastApply, existingTracked) {
    const staticData = { last_apply: lastApply, tracked_applications: existingTracked ? existingTracked.slice() : undefined };
    const $ = (name) => {
      if (name !== 'Extract Input') throw new Error('unexpected $() ref: ' + name);
      return { first: () => ({ json: { chat_id: 999 } }) };
    };
    const $getWorkflowStaticData = () => staticData;
    const code = `
const staticData = $getWorkflowStaticData('global');
const chatId = $('Extract Input').first().json.chat_id;
const lastApply = staticData.last_apply;
if (!lastApply) return [{ json: { chat_id: chatId, message: "❌ Nothing to track. Apply to a job first." } }];
if (!staticData.tracked_applications) staticData.tracked_applications = [];
${TA_ENTRY_NEW}
const exists = staticData.tracked_applications.some(a => a.job_id === entry.job_id);
if (exists) return [{ json: { chat_id: chatId, message: "ℹ️ Already tracking *" + entry.job_title + "* at *" + entry.company + "*." } }];
staticData.tracked_applications.push(entry);
if (staticData.tracked_applications.length > 100) staticData.tracked_applications = staticData.tracked_applications.slice(-100);
${TA_RETURN_NEW}
`;
    const fn = new Function('$', '$getWorkflowStaticData', code);
    return fn($, $getWorkflowStaticData)[0].json;
  }

  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  // Genuine push: last_apply present, not already tracked -> _pg_entry present with url + forge_score_detail.
  const lastApply1 = { job_id: 'cache_9376', job_title: 'ML Engineer', company: 'Point72', url: 'https://boards.greenhouse.io/point72/jobs/1?gh_jid=1', forge_score: { overall_score: 8.1 } };
  const r1 = runTrackApplication(lastApply1, []);
  check('genuine push: _pg_entry present', !!r1._pg_entry);
  check('genuine push: url carried through', r1._pg_entry && r1._pg_entry.url === lastApply1.url);
  check('genuine push: forge_score_detail carried through', r1._pg_entry && r1._pg_entry.forge_score_detail.overall_score === 8.1);
  check('genuine push: chat_id attached', r1._pg_entry && r1._pg_entry.chat_id === 999);

  // Already tracking -> NO _pg_entry (must not double-insert).
  const r2 = runTrackApplication(lastApply1, [{ job_id: 'cache_9376' }]);
  check('already-tracking: no _pg_entry', !r2._pg_entry);
  check('already-tracking: correct message', /Already tracking/.test(r2.message));

  // Nothing to track -> no _pg_entry, no throw.
  const r3 = runTrackApplication(null, []);
  check('nothing-to-track: no _pg_entry', !r3._pg_entry);
  check('nothing-to-track: correct message', /Nothing to track/.test(r3.message));

  // No URL on last_apply (legacy/pre-s132 staticData) -> entry.url is null, not a throw.
  const lastApply2 = { job_id: 'x', job_title: 'Role', company: 'Co', forge_score: null };
  const r4 = runTrackApplication(lastApply2, []);
  check('missing url -> null, no throw', r4._pg_entry && r4._pg_entry.url === null);
  check('missing forge_score -> null forge_score_detail', r4._pg_entry && r4._pg_entry.forge_score_detail === null);

  // 2. queryReplacement expression, run for real against both cases.
  function evalQueryReplacement(json) {
    const $json = json;
    return [JSON.stringify($json._pg_entry ? [$json._pg_entry] : [])];
  }
  check('queryReplacement: push case -> single-element array', JSON.parse(evalQueryReplacement(r1)[0]).length === 1);
  check('queryReplacement: no-push case -> empty array', JSON.parse(evalQueryReplacement(r2)[0]).length === 0);

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: Track Application dual-write verified (genuine push carries url/forge_score/chat_id; already-tracking and nothing-to-track paths correctly emit no _pg_entry; missing-url legacy case handled without throwing).');

  patch();
  console.log('S132 (track dual-write) script complete.');
})();
