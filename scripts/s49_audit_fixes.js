/**
 * s49_audit_fixes.js -- 7 fixes from the deep behavioral audit (6-lens
 * adversarially-verified workflow audit over all 283 nodes). Every finding
 * was either machine-verified by an independent refuter agent or re-verified
 * by hand against the live JSON before landing here:
 *
 * 1. HIGH -- track dedup broken for every URL/jd_paste apply. Retrieve Job
 *    builds a real unique job_id (direct-<co>-0 / jdpaste-<slug>-<ts> /
 *    registry ids), but Prepare Job Context forwards only the SLOT NUMBER
 *    (0 for all pasted applies), and Store Apply Context stores that as
 *    last_apply.job_id -- so Track Application's dedup collides: a second
 *    'track' from a DIFFERENT company is rejected as already-tracking.
 *    Fix: forward the real job_id through Prepare Job Context and prefer
 *    it in Store Apply Context.
 *
 * 2. HIGH -- chained revises silently lose the previous revision. Update
 *    Last Apply writes the revised resume only to last_apply.resume_json,
 *    while Detect Revise Type feeds ReviseForge from sd.last_resume_json
 *    (written only by a full apply). Revise #2 operated on the pre-revise-#1
 *    resume; the first revision's edits vanished without warning -- in the
 *    exact flow the bot's own reply ("More tweaks? Just describe...")
 *    encourages. Fix: Update Last Apply syncs sd.last_resume_json too.
 *
 * 3. MED -- jd_paste menus carry no JD identity while last_pasted_jd is a
 *    single overwrite slot: paste JD A, paste JD B, tap menu A's button ->
 *    Company-B documents under a message naming Company A. Fix: Stage JD
 *    Paste mints a short id, buttons carry jd:generate:<id> /
 *    jd:contacts:<id>, Route Callback Action routes on the prefix, and both
 *    consumers reject an id mismatch with a clear "older pasted JD" error.
 *
 * 4. MED -- jd:contacts after TTL expiry silently degraded to a junk
 *    company='Unknown' contact search (burning You.com+Serper+LLM calls and
 *    clobbering last_contacts, which poisons 'draft N'), while jd:generate
 *    correctly errored. Fix: the stale/mismatched case now routes an
 *    explicit error through the existing draft-error plumbing
 *    (Load Draft Contact -> IF: Contact Found? -> Send No Contact).
 *
 * 5. HIGH (crash) -- Send Resume Setup Error's chatId fallback chain ends in
 *    $('Schedule Payload'), which never executes on the jd:generate callback
 *    path: a resume-validation failure during a callback apply killed the
 *    whole execution with no user-facing message. Fix: F1-pattern chain
 *    extended with Extract Callback, terminating in null.
 *
 * 6+7. LATENT -- Format Intel Report (Cached) and Load Draft Contact both
 *    hard-reference $('Extract Input') on branches graph-reachable from the
 *    callback entry (currently saved only by the catch branch hardcoding
 *    research_type 'outreach'; fix 4 makes the draft branch REACHABLE from
 *    callbacks, so #7 stops being latent). Fix: guarded chat_id reads
 *    falling back to Prepare Research's output.
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Real job_id through the apply chain ═══
const PJC_RETURN_OLD = "return [{ json: { chat_id: retrieveData.chat_id, job_number: retrieveData.job_number, job_title: jobTitle, company, company_slug: retrieveData.company_slug, location: job.location || metadata.geo_region || 'Unknown', job_url: retrieveData.direct_url || job.url || '', job_description: jobDescription, fit_score_from_digest: job.fit_score || null } }];";
const PJC_RETURN_NEW = "return [{ json: { chat_id: retrieveData.chat_id, job_number: retrieveData.job_number, job_id: (job.job_id || ('slot-' + retrieveData.job_number)), job_title: jobTitle, company, company_slug: retrieveData.company_slug, location: job.location || metadata.geo_region || 'Unknown', job_url: retrieveData.direct_url || job.url || '', job_description: jobDescription, fit_score_from_digest: job.fit_score || null } }];";

const SAC_JOBID_OLD = "staticData.last_apply = { job_id: ctx.job_number,";
const SAC_JOBID_NEW = "staticData.last_apply = { job_id: ctx.job_id || ctx.job_number,";

// ═══ 2. Chained revise sync ═══
const ULA_OLD = "if (type === 'cover') { staticData.last_apply.cover_json = revised; } else { staticData.last_apply.resume_json = revised; }";
const ULA_NEW = "if (type === 'cover') { staticData.last_apply.cover_json = revised; } else { staticData.last_apply.resume_json = revised; staticData.last_resume_json = revised; }";

// ═══ 3a. Stage JD Paste: mint id ═══
const STAGE_OLD =
  "sd.last_pasted_jd = {\n" +
  "  jd_text: jdText,\n" +
  "  company,\n" +
  "  role,\n" +
  "  short_role: extract.shortRole || 'Role',\n" +
  "  created_at: new Date().toISOString(),\n" +
  "  ttl_seconds: 1800\n" +
  "};\n" +
  "return [{ json: { chat_id: chatId, company, role } }];";
const STAGE_NEW =
  "const jdId = Date.now().toString(36).slice(-6);\n" +
  "sd.last_pasted_jd = {\n" +
  "  id: jdId,\n" +
  "  jd_text: jdText,\n" +
  "  company,\n" +
  "  role,\n" +
  "  short_role: extract.shortRole || 'Role',\n" +
  "  created_at: new Date().toISOString(),\n" +
  "  ttl_seconds: 1800\n" +
  "};\n" +
  "return [{ json: { chat_id: chatId, company, role, jd_id: jdId } }];";

// ═══ 3b. Menu buttons carry the id ═══
const BTN_GEN_OLD = 'jd:generate';
const BTN_GEN_NEW = "={{ 'jd:generate:' + $json.jd_id }}";
const BTN_CON_OLD = 'jd:contacts';
const BTN_CON_NEW = "={{ 'jd:contacts:' + $json.jd_id }}";

// ═══ 3c. Route Callback Action: prefix routing ═══
const RCA_OLD = "={{ ['resume:apply','resume:cancel','resume:redo','jd:generate','jd:contacts'].indexOf($('Extract Callback').first().json.callback_data) }}";
const RCA_NEW = "={{ ['resume:apply','resume:cancel','resume:redo'].indexOf($('Extract Callback').first().json.callback_data) !== -1 ? ['resume:apply','resume:cancel','resume:redo'].indexOf($('Extract Callback').first().json.callback_data) : ($('Extract Callback').first().json.callback_data.startsWith('jd:generate') ? 3 : ($('Extract Callback').first().json.callback_data.startsWith('jd:contacts') ? 4 : -1)) }}";

// ═══ 3d+1. Retrieve Job catch: id check + keep real job_id flowing ═══
const RJ_CATCH_OLD =
  "} catch (e) {\n" +
  "  const cb = $('Extract Callback').first().json;\n" +
  "  const pending = staticData.last_pasted_jd;\n" +
  "  if (!pending || !pending.jd_text) {\n" +
  "    return [{ json: { chat_id: cb.chat_id, error: 'That pasted job description expired or was not found. Please paste it again.' } }];\n" +
  "  }\n" +
  "  const ttlSec = pending.ttl_seconds || 1800;\n" +
  "  const ageSec = (Date.now() - new Date(pending.created_at).getTime()) / 1000;\n" +
  "  if (ageSec > ttlSec) {\n" +
  "    return [{ json: { chat_id: cb.chat_id, error: 'That pasted job description expired. Please paste it again.' } }];\n" +
  "  }\n";
const RJ_CATCH_NEW =
  "} catch (e) {\n" +
  "  const cb = $('Extract Callback').first().json;\n" +
  "  const pending = staticData.last_pasted_jd;\n" +
  "  if (!pending || !pending.jd_text) {\n" +
  "    return [{ json: { chat_id: cb.chat_id, error: 'That pasted job description expired or was not found. Please paste it again.' } }];\n" +
  "  }\n" +
  "  const cbId = ((cb.callback_data || '').split(':')[2]) || null;\n" +
  "  if (pending.id && cbId !== pending.id) {\n" +
  "    return [{ json: { chat_id: cb.chat_id, error: 'That menu belongs to an older pasted job description (a newer one replaced it). Please use the newest menu or paste the JD again.' } }];\n" +
  "  }\n" +
  "  const ttlSec = pending.ttl_seconds || 1800;\n" +
  "  const ageSec = (Date.now() - new Date(pending.created_at).getTime()) / 1000;\n" +
  "  if (ageSec > ttlSec) {\n" +
  "    return [{ json: { chat_id: cb.chat_id, error: 'That pasted job description expired. Please paste it again.' } }];\n" +
  "  }\n";

// ═══ 4+3d. Prepare Research catch: stale/mismatch -> explicit error via draft plumbing ═══
const PR_CATCH_OLD =
  "} catch (e) {\n" +
  "  const cb = $('Extract Callback').first().json;\n" +
  "  const sd = $getWorkflowStaticData('global');\n" +
  "  const pending = sd.last_pasted_jd;\n" +
  "  const ttlSec = (pending && pending.ttl_seconds) || 1800;\n" +
  "  const fresh = !!(pending && pending.jd_text && ((Date.now() - new Date(pending.created_at).getTime()) / 1000) <= ttlSec);\n" +
  "  const company = (fresh && pending.company) || 'Unknown';\n" +
  "  const role = (fresh && pending.role) || 'Software Engineer';\n" +
  "  return [{ json: { chat_id: cb.chat_id, research_type: 'outreach', company, role, location: '', queries: [], draft_number: null } }];\n" +
  "}";
const PR_CATCH_NEW =
  "} catch (e) {\n" +
  "  const cb = $('Extract Callback').first().json;\n" +
  "  const sd = $getWorkflowStaticData('global');\n" +
  "  const pending = sd.last_pasted_jd;\n" +
  "  const ttlSec = (pending && pending.ttl_seconds) || 1800;\n" +
  "  const fresh = !!(pending && pending.jd_text && ((Date.now() - new Date(pending.created_at).getTime()) / 1000) <= ttlSec);\n" +
  "  const cbId = ((cb.callback_data || '').split(':')[2]) || null;\n" +
  "  const idOk = !(pending && pending.id) || cbId === pending.id;\n" +
  "  if (!fresh || !idOk || !pending.company) {\n" +
  "    // s49: explicit error instead of a junk 'Unknown' contact search -- routed\n" +
  "    // through the existing draft-error plumbing (Load Draft Contact -> Send No Contact).\n" +
  "    return [{ json: { chat_id: cb.chat_id, research_type: 'draft', draft_number: null, _jd_expired: true, company: null, role: null, queries: [] } }];\n" +
  "  }\n" +
  "  return [{ json: { chat_id: cb.chat_id, research_type: 'outreach', company: pending.company, role: pending.role || 'Software Engineer', location: '', queries: [], draft_number: null } }];\n" +
  "}";

// ═══ 5. Send Resume Setup Error: callback-safe chatId chain ═══
const SRSE_OLD = "={{ $('Extract Input').isExecuted ? $('Extract Input').first().json.chat_id : $('Schedule Payload').first().json.chat_id }}";
const SRSE_NEW = "={{ $('Extract Input').isExecuted ? $('Extract Input').first().json.chat_id : ($('Extract Callback').isExecuted ? $('Extract Callback').first().json.chat_id : ($('Schedule Payload').isExecuted ? $('Schedule Payload').first().json.chat_id : null)) }}";

// ═══ 6. Format Intel Report (Cached): guarded chat_id ═══
const FIRC_OLD = "const chatId = $('Extract Input').first().json.chat_id;";
const FIRC_NEW = "let chatId; try { chatId = $('Extract Input').first().json.chat_id; } catch (e) { chatId = $('Prepare Research').first().json.chat_id; }";

// ═══ 7. Load Draft Contact: guarded chat_id + _jd_expired handling ═══
const LDC_OLD =
  "const staticData = $getWorkflowStaticData('global');\n" +
  "const chatId = $('Extract Input').first().json.chat_id;\n" +
  "const ctx = $('Prepare Research').first().json;\n" +
  "const draftNum = ctx.draft_number;";
const LDC_NEW =
  "const staticData = $getWorkflowStaticData('global');\n" +
  "const ctx = $('Prepare Research').first().json;\n" +
  "let chatId; try { chatId = $('Extract Input').first().json.chat_id; } catch (e) { chatId = ctx.chat_id; }\n" +
  "if (ctx._jd_expired) {\n" +
  "  return [{ json: { chat_id: chatId, error: 'That pasted job description expired (or a newer one replaced it). Please paste the JD again and tap Find Contacts within 30 minutes.' } }];\n" +
  "}\n" +
  "const draftNum = ctx.draft_number;";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const need of ['Prepare Job Context', 'Store Apply Context', 'Update Last Apply', 'Stage JD Paste', 'Send JD Paste Menu', 'Route Callback Action', 'Retrieve Job', 'Prepare Research', 'Send Resume Setup Error', 'Format Intel Report (Cached)', 'Load Draft Contact']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Stage JD Paste'].parameters.jsCode.includes('jdId')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Prepare Job Context'].parameters, 'jsCode', PJC_RETURN_OLD, PJC_RETURN_NEW, 'PJC job_id', base);
  replaceOnce(N['Store Apply Context'].parameters, 'jsCode', SAC_JOBID_OLD, SAC_JOBID_NEW, 'SAC job_id', base);
  replaceOnce(N['Update Last Apply'].parameters, 'jsCode', ULA_OLD, ULA_NEW, 'ULA revise sync', base);
  replaceOnce(N['Stage JD Paste'].parameters, 'jsCode', STAGE_OLD, STAGE_NEW, 'Stage jd id', base);

  const rows = N['Send JD Paste Menu'].parameters.inlineKeyboard.rows;
  const btnGen = rows[0].row.buttons[0].additionalFields;
  const btnCon = rows[1].row.buttons[0].additionalFields;
  if (btnGen.callback_data !== BTN_GEN_OLD || btnCon.callback_data !== BTN_CON_OLD) {
    console.error(`INTEGRITY FAIL ${base}: menu callback_data not in expected state`); process.exit(1);
  }
  btnGen.callback_data = BTN_GEN_NEW;
  btnCon.callback_data = BTN_CON_NEW;

  replaceOnce(N['Route Callback Action'].parameters, 'output', RCA_OLD, RCA_NEW, 'RCA prefix routing', base);
  replaceOnce(N['Retrieve Job'].parameters, 'jsCode', RJ_CATCH_OLD, RJ_CATCH_NEW, 'RJ id check', base);
  replaceOnce(N['Prepare Research'].parameters, 'jsCode', PR_CATCH_OLD, PR_CATCH_NEW, 'PR stale error', base);
  replaceOnce(N['Send Resume Setup Error'].parameters, 'chatId', SRSE_OLD, SRSE_NEW, 'SRSE chatId chain', base);
  replaceOnce(N['Format Intel Report (Cached)'].parameters, 'jsCode', FIRC_OLD, FIRC_NEW, 'FIRC guard', base);
  replaceOnce(N['Load Draft Contact'].parameters, 'jsCode', LDC_OLD, LDC_NEW, 'LDC guard + expiry', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: all s49 audit fixes applied`);
}

// ── harness ──
(function harness() {
  // 1. Prepare Job Context forwards real job_id; Store Apply Context prefers it.
  {
    const mk = new Function('retrieveData', 'job', 'jobTitle', 'company', 'jobDescription', 'metadata', PJC_RETURN_NEW.replace('return ', 'return '))
    const out = mk({ chat_id: 1, job_number: 0, company_slug: 'gaya', direct_url: '' }, { job_id: 'jdpaste-gaya-1234', fit_score: null, location: '', url: '' }, 'AI Eng', 'Gaya', 'jd', {})[0].json;
    if (out.job_id !== 'jdpaste-gaya-1234') { console.error('HARNESS FAIL: PJC did not forward real job_id, got', out.job_id); process.exit(1); }
    const mk2 = new Function('retrieveData', 'job', 'jobTitle', 'company', 'jobDescription', 'metadata', PJC_RETURN_NEW)
    const out2 = mk2({ chat_id: 1, job_number: 3, company_slug: 'x' }, { fit_score: null, location: '', url: '' }, 'T', 'C', 'jd', {})[0].json;
    if (out2.job_id !== 'slot-3') { console.error('HARNESS FAIL: PJC slot fallback wrong, got', out2.job_id); process.exit(1); }
    const sd = {}; const ctx = { job_id: 'jdpaste-gaya-1234', job_number: 0 };
    // simulate the SAC line
    sd.last_apply = { job_id: ctx.job_id || ctx.job_number };
    if (sd.last_apply.job_id !== 'jdpaste-gaya-1234') { console.error('HARNESS FAIL: SAC job_id preference wrong'); process.exit(1); }
  }
  console.log('HARNESS OK: real job_id flows through Prepare Job Context (jdpaste-gaya-1234, slot-3 fallback) and Store Apply Context prefers it -- track dedup gets unique keys');

  // 2. Update Last Apply syncs both slots.
  {
    const staticData = { last_apply: {} };
    const run = (type, revised) => { new Function('staticData', 'type', 'revised', ULA_NEW)(staticData, type, revised); };
    run('resume', { v: 1 });
    if (!staticData.last_apply.resume_json || !staticData.last_resume_json || staticData.last_resume_json.v !== 1) { console.error('HARNESS FAIL: ULA did not sync last_resume_json'); process.exit(1); }
    run('cover', { c: 2 });
    if (staticData.last_resume_json.v !== 1) { console.error('HARNESS FAIL: cover revise must not clobber last_resume_json'); process.exit(1); }
  }
  console.log('HARNESS OK: Update Last Apply syncs sd.last_resume_json on resume revises (chained revises now build on each other), cover revises leave it alone');

  // 3. Route Callback Action prefix routing: all cases.
  {
    const expr = RCA_NEW.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const route = (cb) => new Function('$', `return (${expr});`)(() => ({ first: () => ({ json: { callback_data: cb } }) }));
    const cases = [['resume:apply', 0], ['resume:cancel', 1], ['resume:redo', 2], ['jd:generate:ab12cd', 3], ['jd:contacts:ab12cd', 4], ['jd:generate', 3], ['garbage', -1]];
    for (const [cb, want] of cases) {
      const got = route(cb);
      if (got !== want) { console.error(`HARNESS FAIL: RCA route for "${cb}" expected ${want}, got ${got}`); process.exit(1); }
    }
  }
  console.log('HARNESS OK: Route Callback Action routes suffixed jd:generate:<id>/jd:contacts:<id> (and legacy unsuffixed) correctly, resume:* unchanged, garbage still drops');

  // 4. Retrieve Job catch: id mismatch and match.
  {
    const body =
      "const staticData = $getWorkflowStaticData('global');\n" +
      "try { throw new Error('force catch'); " + RJ_CATCH_NEW.slice(0, RJ_CATCH_NEW.length) +
      "  const company = pending.company || 'unknown';\n" +
      "  const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';\n" +
      "  return [{ json: { chat_id: cb.chat_id, job_number: 0, source: 'jd_paste', company_slug: companySlug, job: { job_id: 'jdpaste-' + companySlug, title: pending.role || '', company, description_snippet: pending.jd_text } } }];\n" +
      "}";
    const run = (cbData, pending) => new Function('$', '$getWorkflowStaticData', body)(
      (name) => { if (name === 'Extract Callback') return { first: () => ({ json: { chat_id: 9, callback_data: cbData } }) }; throw new Error('no_execution_data'); },
      () => ({ last_pasted_jd: pending })
    )[0].json;
    const freshPending = { id: 'abc123', jd_text: 'JD', company: 'Gaya', role: 'AI Eng', created_at: new Date().toISOString(), ttl_seconds: 1800 };
    const ok = run('jd:generate:abc123', freshPending);
    if (ok.error || ok.job.company !== 'Gaya') { console.error('HARNESS FAIL: RJ matching id should proceed', ok); process.exit(1); }
    const stale = run('jd:generate:zzz999', freshPending);
    if (!stale.error || !/older pasted/.test(stale.error)) { console.error('HARNESS FAIL: RJ id mismatch should error', stale); process.exit(1); }
    const legacyPending = { jd_text: 'JD', company: 'Gaya', created_at: new Date().toISOString(), ttl_seconds: 1800 };
    const legacy = run('jd:generate:abc123', legacyPending);
    if (legacy.error) { console.error('HARNESS FAIL: RJ pending without id (pre-deploy) should still work', legacy); process.exit(1); }
  }
  console.log('HARNESS OK: Retrieve Job accepts matching id, rejects mismatched id with a clear error, tolerates pre-deploy pending without id');

  // 5. Prepare Research catch: fresh+match -> outreach; stale/mismatch/empty-company -> _jd_expired draft.
  {
    const body = "try { throw new Error('force'); " + PR_CATCH_NEW;
    const run = (cbData, pending) => new Function('$', '$getWorkflowStaticData', body)(
      (name) => { if (name === 'Extract Callback') return { first: () => ({ json: { chat_id: 9, callback_data: cbData } }) }; throw new Error('no_execution_data'); },
      () => ({ last_pasted_jd: pending })
    )[0].json;
    const fresh = { id: 'abc123', jd_text: 'JD', company: 'Gaya', role: 'AI Eng', created_at: new Date().toISOString(), ttl_seconds: 1800 };
    const ok = run('jd:contacts:abc123', fresh);
    if (ok.research_type !== 'outreach' || ok.company !== 'Gaya') { console.error('HARNESS FAIL: PR fresh+match should run outreach', ok); process.exit(1); }
    const expired = run('jd:contacts:abc123', { ...fresh, created_at: new Date(Date.now() - 3600e3).toISOString() });
    if (!expired._jd_expired || expired.research_type !== 'draft') { console.error('HARNESS FAIL: PR expired should route _jd_expired draft', expired); process.exit(1); }
    const mismatch = run('jd:contacts:zzz', fresh);
    if (!mismatch._jd_expired) { console.error('HARNESS FAIL: PR id mismatch should route _jd_expired', mismatch); process.exit(1); }
  }
  console.log('HARNESS OK: Prepare Research runs real outreach on fresh+matching id, routes an explicit _jd_expired error (not a junk Unknown search) on stale/mismatch');

  // 6. Load Draft Contact: _jd_expired -> error via existing plumbing; chatId guarded.
  {
    const body = LDC_NEW + "\nreturn [{ json: { chat_id: chatId, proceeded: true, draftNum } }];";
    const run = (ctx, extractInputAvailable) => new Function('$', '$getWorkflowStaticData', body)(
      (name) => {
        if (name === 'Prepare Research') return { first: () => ({ json: ctx }) };
        if (name === 'Extract Input' && extractInputAvailable) return { first: () => ({ json: { chat_id: 111 } }) };
        throw new Error('no_execution_data');
      },
      () => ({})
    )[0].json;
    const expired = run({ chat_id: 222, _jd_expired: true }, false);
    if (!expired.error || expired.chat_id !== 222) { console.error('HARNESS FAIL: LDC _jd_expired should error with callback chat_id', expired); process.exit(1); }
    const normal = run({ chat_id: 222, draft_number: 2 }, true);
    if (normal.error || normal.chat_id !== 111 || normal.draftNum !== 2) { console.error('HARNESS FAIL: LDC normal path regressed', normal); process.exit(1); }
  }
  console.log('HARNESS OK: Load Draft Contact surfaces the expiry error through the existing Send No Contact plumbing and its chat_id survives the callback path');

  // 7. Expression sanity for SRSE chain.
  {
    let depth = 0;
    for (const ch of SRSE_NEW) { if (ch === '(') depth++; if (ch === ')') depth--; }
    if (depth !== 0 || !(SRSE_NEW.includes("$('Extract Callback').isExecuted"))) { console.error('HARNESS FAIL: SRSE chain malformed'); process.exit(1); }
  }
  console.log("HARNESS OK: Send Resume Setup Error's chatId chain is balanced and covers message/callback/schedule paths ending in null");
})();

TARGETS.forEach(patch);
console.log('S49 (audit fixes: track job_id, chained revise, jd menu identity, jd:contacts expiry, callback-path crash + 2 latent guards) complete.');
