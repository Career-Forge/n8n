/**
 * s53_jdpaste_ux.js -- jd_paste UX hardening (v8 backlog items 1+2, both
 * adversarially verified by the deep audit's error-paths lens):
 *
 * 1. No ack anywhere on the jd_paste path: pasting a JD ran a ~10s LLM
 *    extraction in silence, and if JD Paste Extract's parser failed all 3
 *    retries the execution died with the user getting NOTHING (no onError,
 *    no error branch). Now: an immediate "reading your JD" ack fires before
 *    the extraction, and the extraction gained onError:continueErrorOutput
 *    with an error branch that tells the user to re-paste (reusing the
 *    existing Send Job Not Found "❌ <error>" sender -- same fan-in
 *    pattern as s37/s49).
 *
 * 2. jd:generate / jd:contacts button taps never answered the callback query
 *    (spinner spins until Telegram times out) and sent no ack while the
 *    pipeline runs 45-90s -- inviting a double tap, which launched a full
 *    duplicate apply pipeline racing the first on staticData. Now: both
 *    branches answer the callback immediately and send a progress ack, and
 *    the generate path takes an in-flight lock (timestamp + 180s TTL in
 *    staticData, cleared by Store Apply Context at the end -- TTL covers
 *    crashed runs so the lock can't stick). A second tap during generation
 *    gets a friendly "already generating" message instead of a duplicate run.
 *
 * +6 nodes: Send JD Paste Ack, JD Extract Failed, Answer JD Generate
 * Callback, Send JD Generate Ack, Answer JD Contacts Callback, Send JD
 * Contacts Ack. 283 -> 289.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const TG_CRED = { telegramApi: { id: 'XayaGFL8EdfqdoR7', name: 'CareerForge_Telegram' } };

// ═══ in-flight lock: Retrieve Job catch branch ═══
const RJ_LOCK_OLD =
  "} catch (e) {\n" +
  "  const cb = $('Extract Callback').first().json;\n" +
  "  const pending = staticData.last_pasted_jd;\n";
const RJ_LOCK_NEW =
  "} catch (e) {\n" +
  "  const cb = $('Extract Callback').first().json;\n" +
  "  // s53: double-tap lock -- a second jd:generate tap while a run is already\n" +
  "  // in flight would launch a full duplicate apply pipeline racing the first\n" +
  "  // on staticData. Timestamp TTL (180s) so a crashed run can't stick the lock.\n" +
  "  const _inflight = staticData.jd_generate_inflight;\n" +
  "  if (_inflight && (Date.now() - _inflight) < 180000) {\n" +
  "    return [{ json: { chat_id: cb.chat_id, error: 'Already generating from this JD — hang tight, your resume + cover letter are on the way.' } }];\n" +
  "  }\n" +
  "  const pending = staticData.last_pasted_jd;\n";

// lock is SET only when the catch branch actually proceeds to a synthetic job
const RJ_SET_OLD = "  const company = pending.company || 'unknown';\n  const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';\n";
const RJ_SET_NEW = "  staticData.jd_generate_inflight = Date.now();\n  const company = pending.company || 'unknown';\n  const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';\n";

// lock clear at the end of a successful apply
const SAC_CLEAR_OLD = "if (resumeJson && Array.isArray(resumeJson.experience)) { staticData.last_resume_json = resumeJson; }";
const SAC_CLEAR_NEW = "if (resumeJson && Array.isArray(resumeJson.experience)) { staticData.last_resume_json = resumeJson; }\nstaticData.jd_generate_inflight = null;";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const conns = wf.connections;

  for (const need of ['Route Intent', 'JD Paste Extract', 'Stage JD Paste', 'Route Callback Action', 'Retrieve Job', 'Prepare Research', 'Store Apply Context', 'Send Job Not Found', 'Extract Callback', 'Extract Input']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Send JD Paste Ack']) { console.log(`  ${base}: already patched`); return; }

  const rc = N['Route Callback Action'];
  const anchor = rc.position || [23000, 49100];

  // ── new nodes ──
  const mk = (name, params, type, typeVersion, pos, extra) => {
    const n = Object.assign({ parameters: params, id: crypto.randomUUID(), name, type, typeVersion, position: pos }, extra || {});
    wf.nodes.push(n); N[name] = n; return n;
  };
  mk('Send JD Paste Ack', {
    chatId: "={{ $('Extract Input').first().json.chat_id }}",
    text: '📋 *Reading your pasted job description...*',
    additionalFields: { parse_mode: 'Markdown' },
  }, 'n8n-nodes-base.telegram', 1.2, [anchor[0] + 3800, anchor[1] + 400], { credentials: TG_CRED });

  mk('JD Extract Failed', {
    jsCode: "let chatId; try { chatId = $('Extract Input').first().json.chat_id; } catch (e) { chatId = null; }\nreturn [{ json: { chat_id: chatId, error: \"Couldn't read that job description (the extraction model failed after 3 tries). Please paste it again — plain text works best.\" } }];",
  }, 'n8n-nodes-base.code', 2, [anchor[0] + 4200, anchor[1] + 600]);

  mk('Answer JD Generate Callback', {
    resource: 'callback',
    queryId: "={{ $('Extract Callback').first().json.callback_query_id }}",
    additionalFields: {},
  }, 'n8n-nodes-base.telegram', 1.2, [anchor[0] + 300, anchor[1] - 250], { credentials: TG_CRED });

  mk('Send JD Generate Ack', {
    chatId: "={{ $('Extract Callback').first().json.chat_id }}",
    text: '⚙️ *Generating your tailored resume + cover letter from the pasted JD...* (~1 min)',
    additionalFields: { parse_mode: 'Markdown' },
  }, 'n8n-nodes-base.telegram', 1.2, [anchor[0] + 600, anchor[1] - 250], { credentials: TG_CRED });

  mk('Answer JD Contacts Callback', {
    resource: 'callback',
    queryId: "={{ $('Extract Callback').first().json.callback_query_id }}",
    additionalFields: {},
  }, 'n8n-nodes-base.telegram', 1.2, [anchor[0] + 300, anchor[1] + 250], { credentials: TG_CRED });

  mk('Send JD Contacts Ack', {
    chatId: "={{ $('Extract Callback').first().json.chat_id }}",
    text: '👥 *Finding contacts for the pasted JD...* (~30 sec)',
    additionalFields: { parse_mode: 'Markdown' },
  }, 'n8n-nodes-base.telegram', 1.2, [anchor[0] + 600, anchor[1] + 250], { credentials: TG_CRED });

  // ── rewiring ──
  // 1. Route Intent[17]: JD Paste Extract -> Send JD Paste Ack -> JD Paste Extract
  const ri17 = conns['Route Intent'].main[17];
  if (!ri17 || !ri17.some((e) => e.node === 'JD Paste Extract')) { console.error(`INTEGRITY FAIL ${base}: Route Intent[17] does not point at JD Paste Extract`); process.exit(1); }
  conns['Route Intent'].main[17] = [{ node: 'Send JD Paste Ack', type: 'main', index: 0 }];
  conns['Send JD Paste Ack'] = { main: [[{ node: 'JD Paste Extract', type: 'main', index: 0 }]] };

  // 2. JD Paste Extract error branch
  if (N['JD Paste Extract'].onError) { console.error(`INTEGRITY FAIL ${base}: JD Paste Extract already has onError`); process.exit(1); }
  N['JD Paste Extract'].onError = 'continueErrorOutput';
  const jpe = conns['JD Paste Extract'];
  if (!jpe || !jpe.main || jpe.main.length !== 1) { console.error(`INTEGRITY FAIL ${base}: JD Paste Extract connections unexpected shape`); process.exit(1); }
  jpe.main.push([{ node: 'JD Extract Failed', type: 'main', index: 0 }]);
  conns['JD Extract Failed'] = { main: [[{ node: 'Send Job Not Found', type: 'main', index: 0 }]] };

  // 3. Callback branches: answer + ack before the pipelines
  const rcb = conns['Route Callback Action'].main;
  if (!rcb[3].some((e) => e.node === 'Retrieve Job') || !rcb[4].some((e) => e.node === 'Prepare Research')) {
    console.error(`INTEGRITY FAIL ${base}: Route Callback Action branches 3/4 not in expected state`); process.exit(1);
  }
  rcb[3] = [{ node: 'Answer JD Generate Callback', type: 'main', index: 0 }];
  rcb[4] = [{ node: 'Answer JD Contacts Callback', type: 'main', index: 0 }];
  conns['Answer JD Generate Callback'] = { main: [[{ node: 'Send JD Generate Ack', type: 'main', index: 0 }]] };
  conns['Send JD Generate Ack'] = { main: [[{ node: 'Retrieve Job', type: 'main', index: 0 }]] };
  conns['Answer JD Contacts Callback'] = { main: [[{ node: 'Send JD Contacts Ack', type: 'main', index: 0 }]] };
  conns['Send JD Contacts Ack'] = { main: [[{ node: 'Prepare Research', type: 'main', index: 0 }]] };

  // 4. Double-tap lock
  const rjCode = N['Retrieve Job'].parameters.jsCode;
  if (rjCode.split(RJ_LOCK_OLD).length - 1 !== 1) { console.error(`INTEGRITY FAIL ${base}: Retrieve Job lock anchor count wrong`); process.exit(1); }
  let newRj = rjCode.replace(RJ_LOCK_OLD, RJ_LOCK_NEW);
  if (newRj.split(RJ_SET_OLD).length - 1 !== 1) { console.error(`INTEGRITY FAIL ${base}: Retrieve Job lock-set anchor count wrong`); process.exit(1); }
  N['Retrieve Job'].parameters.jsCode = newRj.replace(RJ_SET_OLD, RJ_SET_NEW);

  const sacCode = N['Store Apply Context'].parameters.jsCode;
  if (sacCode.split(SAC_CLEAR_OLD).length - 1 !== 1) { console.error(`INTEGRITY FAIL ${base}: Store Apply Context clear anchor count wrong`); process.exit(1); }
  N['Store Apply Context'].parameters.jsCode = sacCode.replace(SAC_CLEAR_OLD, SAC_CLEAR_NEW);

  // integrity: no dangling connections
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(conns)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: jd_paste UX hardening applied -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. Double-tap lock behavior via real eval of the patched catch branch.
  {
    const catchBody =
      RJ_LOCK_NEW.slice("} catch (e) {\n".length) +
      "  if (!pending || !pending.jd_text) { return [{ json: { chat_id: cb.chat_id, error: 'not found' } }]; }\n" +
      "  const cbId = ((cb.callback_data || '').split(':')[2]) || null;\n" +
      "  if (pending.id && cbId !== pending.id) { return [{ json: { chat_id: cb.chat_id, error: 'older pasted' } }]; }\n" +
      "  const ttlSec = pending.ttl_seconds || 1800;\n" +
      "  const ageSec = (Date.now() - new Date(pending.created_at).getTime()) / 1000;\n" +
      "  if (ageSec > ttlSec) { return [{ json: { chat_id: cb.chat_id, error: 'expired' } }]; }\n" +
      RJ_SET_NEW +
      "  return [{ json: { chat_id: cb.chat_id, ok: true, lockSet: staticData.jd_generate_inflight } }];\n";
    const run = (staticData, cbData) => new Function('staticData', '$', catchBody)(
      staticData,
      (name) => { if (name === 'Extract Callback') return { first: () => ({ json: { chat_id: 7, callback_data: cbData } }) }; throw new Error('x'); }
    )[0].json;
    const fresh = { id: 'ab12', jd_text: 'JD', company: 'Gaya', created_at: new Date().toISOString(), ttl_seconds: 1800 };

    const sd1 = { last_pasted_jd: fresh };
    const first = run(sd1, 'jd:generate:ab12');
    if (first.error || !sd1.jd_generate_inflight) { console.error('HARNESS FAIL: first tap should proceed and set the lock', first); process.exit(1); }
    const second = run(sd1, 'jd:generate:ab12');
    if (!second.error || !/Already generating/.test(second.error)) { console.error('HARNESS FAIL: second tap during flight should be blocked', second); process.exit(1); }

    const sd2 = { last_pasted_jd: fresh, jd_generate_inflight: Date.now() - 300000 }; // stale lock (5 min)
    const afterCrash = run(sd2, 'jd:generate:ab12');
    if (afterCrash.error) { console.error('HARNESS FAIL: expired lock (crashed run) must not block', afterCrash); process.exit(1); }

    const sd3 = { last_pasted_jd: { ...fresh, id: 'zz99' } };
    const staleMenu = run(sd3, 'jd:generate:ab12');
    if (!/older pasted/.test(staleMenu.error) || sd3.jd_generate_inflight) { console.error('HARNESS FAIL: stale-menu tap must NOT set the lock', staleMenu, sd3.jd_generate_inflight); process.exit(1); }
  }
  console.log('HARNESS OK: double-tap lock -- first tap proceeds + locks, second tap blocked with a friendly message, a crashed run\'s 5-min-old lock expires, stale-menu errors never set the lock');

  // 2. Lock clear line lands after the last_resume_json write.
  {
    if (!SAC_CLEAR_NEW.includes('jd_generate_inflight = null')) { console.error('HARNESS FAIL: clear line missing'); process.exit(1); }
    const sd = { jd_generate_inflight: 123 };
    new Function('staticData', 'resumeJson', SAC_CLEAR_NEW.replace('if (resumeJson && Array.isArray(resumeJson.experience)) { staticData.last_resume_json = resumeJson; }', ''))(sd, null);
    if (sd.jd_generate_inflight !== null) { console.error('HARNESS FAIL: lock not cleared'); process.exit(1); }
  }
  console.log('HARNESS OK: Store Apply Context clears the in-flight lock at the end of every successful apply');

  // 3. JD Extract Failed code: builds a friendly error even if Extract Input is somehow unavailable.
  {
    const code = "let chatId; try { chatId = $('Extract Input').first().json.chat_id; } catch (e) { chatId = null; }\nreturn [{ json: { chat_id: chatId, error: \"Couldn't read that job description (the extraction model failed after 3 tries). Please paste it again — plain text works best.\" } }];";
    const ok = new Function('$', code)((name) => ({ first: () => ({ json: { chat_id: 42 } }) }))[0].json;
    if (ok.chat_id !== 42 || !/Couldn't read/.test(ok.error)) { console.error('HARNESS FAIL: JD Extract Failed normal path', ok); process.exit(1); }
    const degraded = new Function('$', code)(() => { throw new Error('x'); })[0].json;
    if (degraded.chat_id !== null) { console.error('HARNESS FAIL: JD Extract Failed degraded path', degraded); process.exit(1); }
  }
  console.log('HARNESS OK: JD Extract Failed produces the re-paste error message (Send Job Not Found shape), degrades gracefully');
})();

TARGETS.forEach(patch);
console.log('S53 (jd_paste UX: acks, extract-failure branch, callback answers, double-tap lock) complete.');
