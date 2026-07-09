/**
 * s52_audit_hardening.js -- 7 fixes from the deep audit's error-paths and
 * staticdata-lifecycle lenses (all independently re-verified by an adversarial
 * refuter agent before landing here; 2 findings from the raw results were
 * checked against the live JSON and turned out inaccurate -- "You.com" isn't
 * actually part of the job-search HTTP fan-out under that name, only Serper
 * Job Search + Firecrawl Search are the real unguarded pair -- so only the
 * confirmed-real ones ship):
 *
 * 1. HIGH -- IF: ATS Low? dereferences $json.ats.overall_score unguarded.
 *    Its entire upstream chain (Validate ATS Signals, Calculate ATS Score) is
 *    armored with onError:continueRegularOutput specifically so a scoring
 *    failure can never block delivery of an already-built resume -- but
 *    Extract ATS Signals itself (the chainLlm at the head of that chain) had
 *    no onError, and the IF right after the armor defeats it anyway by
 *    crashing on a missing .ats. Both fixed: onError added to Extract ATS
 *    Signals, and the IF's expression now defaults a missing score to 999
 *    (routes to "not low" -- deliver as-is, exactly the armor's intent).
 *
 * 2. HIGH -- Scrape Job Page (Firecrawl) has zero error handling on the apply
 *    critical path; any 500/429/timeout kills the whole execution after the
 *    "Generating..." ack. Prepare Job Context already degrades gracefully
 *    when scrapeResult has no markdown (falls back to description_snippet),
 *    so onError:continueRegularOutput is a safe, sufficient fix.
 *
 * 3. HIGH -- in the job-search fan-out, RemoteOK/Adzuna/JSearch are guarded
 *    but Serper Job Search and Firecrawl Search are not, so either can kill
 *    the whole search even though the other sources would have succeeded.
 *
 * 4. HIGH -- the scheduled digest silently overwrites sd.last_jobs (no id,
 *    no TTL) with zero relation to what the user is currently looking at --
 *    unlike last_pasted_jd, which already got exactly this guard. Search at
 *    11pm, the 09:00 digest fires overnight, "2" the next morning resolves
 *    against the WRONG list with no warning. Fixed the same way: Assemble
 *    Digest stamps a timestamp, Retrieve Job's numbered branch rejects a
 *    stale list (4h) with a clear "run a job search again" error instead of
 *    silently tailoring the wrong job.
 *
 * 5. MEDIUM -- "forget schedule_times" deletes the key, which Schedule Gate's
 *    own documented tri-state reads as "unset -> use defaults" -- so removing
 *    the pref silently RE-ENABLES the default 09:00/18:00 digests instead of
 *    disabling them, and /prefs shows nothing to explain why. Special-cased.
 *
 * 6. MEDIUM -- Build Pass2 Regen Input's anti-hallucination rules had already
 *    drifted from Build Pass2 Input (dropped the explicit example-phrase ban
 *    and the "works for ANY company" rule) on exactly the run most likely to
 *    need them -- ATS regen injects the JD's own gap/culture keywords as
 *    "surface truthful coverage" guidance. Restored to parity.
 *
 * Explicitly deferred (documented, not silently dropped -- lower severity or
 * needs its own careful design, see the plan file's v8 backlog): jd:generate/
 * jd:contacts callback ack + double-tap lock; JD Paste Extract silent-failure
 * path; direct-URL job_id collision (constant direct-<company>-0); ForgeScore
 * reading ephemeral last_search_intent instead of durable user_prefs for visa/
 * salary; the coupled revise-flow staleness cluster (Load Revise Context /
 * Detect Revise Type / Send Revised PDF); owner_chat_id dead pref;
 * tracked_applications unbounded growth; Build Cover LaTeX missing V2
 * escaping/truncation parity; shortRole write-only field; ATS trio naming.
 * Also still pending: the field-overwrite and contract-mismatch audit lenses
 * never completed (session-limited both runs).
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. IF: ATS Low? -- default a missing score to 999 (not low -- deliver as-is) ═══
const ATS_IF_OLD = '={{ $json.ats.overall_score }}';
const ATS_IF_NEW = '={{ ($json.ats && typeof $json.ats.overall_score === \'number\') ? $json.ats.overall_score : 999 }}';

// ═══ 4. Assemble Digest / Retrieve Job -- last_jobs staleness TTL ═══
const DIGEST_OLD = "sd.last_jobs = last_jobs;";
const DIGEST_NEW = "sd.last_jobs = last_jobs;\nsd.last_jobs_created_at = new Date().toISOString();";

const RJ_NUM_OLD =
  "const lastJobs = staticData.last_jobs || {};\n" +
  "const job = lastJobs[jobNumber];\n" +
  "if (!job) return [{ json: { chat_id: chatId, error: `Job #${jobNumber} not found. Run a job search first, or paste a job URL directly.` } }];\n";
const RJ_NUM_NEW =
  "const lastJobs = staticData.last_jobs || {};\n" +
  "const job = lastJobs[jobNumber];\n" +
  "if (!job) return [{ json: { chat_id: chatId, error: `Job #${jobNumber} not found. Run a job search first, or paste a job URL directly.` } }];\n" +
  "// s52: reject a stale list -- a scheduled digest can silently replace the\n" +
  "// numbering hours after the user last saw it (same staleness class already\n" +
  "// guarded for last_pasted_jd, just no per-item id to key off here).\n" +
  "const listAgeSec = staticData.last_jobs_created_at ? (Date.now() - new Date(staticData.last_jobs_created_at).getTime()) / 1000 : 0;\n" +
  "if (listAgeSec > 14400) return [{ json: { chat_id: chatId, error: `That job list has expired (a newer search or scheduled digest replaced it). Please run a job search again and reply with a fresh number.` } }];\n";

// ═══ 5. Handle Pref Forget -- schedule_times special case ═══
const HPF_OLD =
  "if (key && prefs[key] !== undefined) {\n" +
  "  delete prefs[key];\n" +
  "  prefs._updated_at = new Date().toISOString();\n" +
  "  return [{ json: { message: '✅ Removed preference: *' + key + '*\\n\\n_Reply \\\\`/prefs\\\\` to see remaining preferences\\\\._' } }];\n" +
  "}";
const HPF_NEW =
  "if (key === 'schedule_times' && prefs[key] !== undefined) {\n" +
  "  // s52: deleting this key does NOT disable digests -- Schedule Gate's own\n" +
  "  // tri-state reads 'unset' as 'use the 09:00/18:00 defaults', so forgetting\n" +
  "  // it would silently RE-ENABLE them. Set to the real disabled state instead.\n" +
  "  prefs[key] = [];\n" +
  "  prefs._updated_at = new Date().toISOString();\n" +
  "  return [{ json: { message: '✅ Scheduled digests disabled (forgetting this preference does not restore the defaults -- say \\'enable my schedule\\' if you want them back).' } }];\n" +
  "}\n" +
  "if (key && prefs[key] !== undefined) {\n" +
  "  delete prefs[key];\n" +
  "  prefs._updated_at = new Date().toISOString();\n" +
  "  return [{ json: { message: '✅ Removed preference: *' + key + '*\\n\\n_Reply \\\\`/prefs\\\\` to see remaining preferences\\\\._' } }];\n" +
  "}";

// ═══ 6. Regen antiHalluc parity ═══
const REGEN_AH_OLD =
  "const antiHalluc = '\\n\\nCRITICAL ANTI-HALLUCINATION RULES:\\n'\n" +
  "  + '- NEVER mention company values, leadership principles, or culture keywords by name in any bullet\\n'\n" +
  "  + '- Bullets must read as natural achievements, not value-signaling statements\\n'\n" +
  "  + '- Use ONLY the verbatim excerpts from Pass 1 decisions as source material — do NOT invent metrics, technologies, or achievements';";
const REGEN_AH_NEW =
  "const antiHalluc = '\\n\\nCRITICAL ANTI-HALLUCINATION RULES:\\n'\n" +
  "  + '- NEVER mention company values, leadership principles, or culture keywords by name in any bullet\\n'\n" +
  "  + '- NEVER write phrases like \"demonstrating Customer Obsession\", \"aligned with LP\", or \"showing Ownership\"\\n'\n" +
  "  + '- Bullets must read as natural achievements, not value-signaling statements\\n'\n" +
  "  + '- The resume should work equally well for ANY company — no company-specific framing\\n'\n" +
  "  + '- Use ONLY the verbatim excerpts from Pass 1 decisions as source material — do NOT invent metrics, technologies, or achievements';";

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

  for (const need of ['Extract ATS Signals', 'IF: ATS Low?', 'Scrape Job Page', 'Serper Job Search', 'Firecrawl Search', 'Assemble Digest', 'Retrieve Job', 'Handle Pref Forget', 'Build Pass2 Regen Input']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Assemble Digest'].parameters.jsCode.includes('last_jobs_created_at')) { console.log(`  ${base}: already patched`); return; }

  // 1. Extract ATS Signals onError (node-level property, not inside parameters)
  if (N['Extract ATS Signals'].onError) { console.error(`INTEGRITY FAIL ${base}: Extract ATS Signals already has an onError, unexpected state`); process.exit(1); }
  N['Extract ATS Signals'].onError = 'continueRegularOutput';

  // 1b. IF: ATS Low? guarded expression
  replaceOnce(N['IF: ATS Low?'].parameters.conditions.conditions[0], 'leftValue', ATS_IF_OLD, ATS_IF_NEW, 'IF: ATS Low? leftValue', base);

  // 2. Scrape Job Page onError
  if (N['Scrape Job Page'].onError) { console.error(`INTEGRITY FAIL ${base}: Scrape Job Page already has an onError, unexpected state`); process.exit(1); }
  N['Scrape Job Page'].onError = 'continueRegularOutput';

  // 3. Serper Job Search + Firecrawl Search onError
  for (const name of ['Serper Job Search', 'Firecrawl Search']) {
    if (N[name].onError) { console.error(`INTEGRITY FAIL ${base}: "${name}" already has an onError, unexpected state`); process.exit(1); }
    N[name].onError = 'continueRegularOutput';
  }

  // 4. last_jobs TTL
  replaceOnce(N['Assemble Digest'].parameters, 'jsCode', DIGEST_OLD, DIGEST_NEW, 'Assemble Digest timestamp', base);
  replaceOnce(N['Retrieve Job'].parameters, 'jsCode', RJ_NUM_OLD, RJ_NUM_NEW, 'Retrieve Job staleness check', base);

  // 5. Handle Pref Forget schedule_times
  replaceOnce(N['Handle Pref Forget'].parameters, 'jsCode', HPF_OLD, HPF_NEW, 'Handle Pref Forget schedule_times', base);

  // 6. Regen antiHalluc parity
  replaceOnce(N['Build Pass2 Regen Input'].parameters, 'jsCode', REGEN_AH_OLD, REGEN_AH_NEW, 'Regen antiHalluc parity', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: all s52 hardening fixes applied`);
}

// ── harness ──
(function harness() {
  // 1. IF: ATS Low? expression: real behavioral proof.
  {
    const expr = ATS_IF_NEW.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const evalExpr = ($json) => new Function('$json', `return (${expr});`)($json);
    if (evalExpr({ ats: { overall_score: 55 } }) !== 55) { console.error('HARNESS FAIL: normal ats score should pass through'); process.exit(1); }
    if (evalExpr({}) !== 999) { console.error('HARNESS FAIL: missing ats should default to 999 (not-low)'); process.exit(1); }
    if (evalExpr({ ats: {} }) !== 999) { console.error('HARNESS FAIL: ats present but no overall_score should default to 999'); process.exit(1); }
    if (evalExpr({ ats: { overall_score: 0 } }) !== 0) { console.error('HARNESS FAIL: a real 0 score must not be treated as missing'); process.exit(1); }
  }
  console.log('HARNESS OK: IF: ATS Low? expression never throws on a missing ats key, defaults to 999 (routes to deliver-as-is), preserves a genuine 0 score');

  // 2. Retrieve Job staleness check: real eval against the actual patched block.
  {
    const body = RJ_NUM_NEW + "return [{ json: { chat_id: chatId, job_number: jobNumber, ok: true } }];";
    const run = (staticData, jobNumber) => new Function('staticData', 'chatId', 'jobNumber', body)(staticData, 99, jobNumber)[0].json;
    const fresh = run({ last_jobs: { 2: { job_id: 'x' } }, last_jobs_created_at: new Date().toISOString() }, 2);
    if (fresh.error) { console.error('HARNESS FAIL: fresh list should not error', fresh); process.exit(1); }
    const stale = run({ last_jobs: { 2: { job_id: 'x' } }, last_jobs_created_at: new Date(Date.now() - 5 * 3600 * 1000).toISOString() }, 2);
    if (!stale.error || !/expired/.test(stale.error)) { console.error('HARNESS FAIL: 5h-old list should error as expired', stale); process.exit(1); }
    const noTimestamp = run({ last_jobs: { 2: { job_id: 'x' } } }, 2); // legacy state, no last_jobs_created_at yet
    if (noTimestamp.error) { console.error('HARNESS FAIL: legacy state (no timestamp yet) must not error -- age defaults to 0', noTimestamp); process.exit(1); }
    const notFound = run({ last_jobs: {}, last_jobs_created_at: new Date().toISOString() }, 2);
    if (!notFound.error || !/not found/.test(notFound.error)) { console.error('HARNESS FAIL: missing job should still give the original not-found error', notFound); process.exit(1); }
  }
  console.log('HARNESS OK: Retrieve Job rejects a 5h-stale last_jobs list with a clear error, accepts a fresh one, degrades gracefully on legacy state with no timestamp yet, preserves the original not-found error');

  // 3. Handle Pref Forget: schedule_times sets [] not delete; other keys unaffected.
  {
    const run = (msgKey, prefsIn) => {
      const prefs = { ...prefsIn };
      const key = msgKey;
      const body = HPF_NEW + "\nconst available = Object.keys(prefs).filter(k => !k.startsWith('_')); const listStr = available.length ? available.join(', ') : '(none yet)'; return [{ json: { message: 'none found' } }];";
      new Function('key', 'prefs', body)(key, prefs);
      return prefs;
    };
    const p1 = run('schedule_times', { schedule_times: ['09:00', '18:00'] });
    if (!Array.isArray(p1.schedule_times) || p1.schedule_times.length !== 0) { console.error('HARNESS FAIL: forget schedule_times should set [], got', p1.schedule_times); process.exit(1); }
    const p2 = run('seniority', { seniority: 'mid' });
    if (p2.seniority !== undefined) { console.error('HARNESS FAIL: forget of a normal key should still delete it', p2); process.exit(1); }
  }
  console.log('HARNESS OK: "forget schedule_times" sets the real disabled state ([]) instead of deleting (which would silently re-enable the 09:00/18:00 defaults); other keys still delete normally');

  // 4. Regen antiHalluc parity: both rule sets now present.
  {
    if (!REGEN_AH_NEW.includes('demonstrating Customer Obsession') || !REGEN_AH_NEW.includes('ANY company')) {
      console.error('HARNESS FAIL: regen antiHalluc still missing rules'); process.exit(1);
    }
  }
  console.log('HARNESS OK: Build Pass2 Regen Input antiHalluc restored to parity with Build Pass2 Input (example-phrase ban + ANY-company rule both present)');
})();

TARGETS.forEach(patch);
console.log('S52 (audit hardening: ATS crash guard, scrape/search error tolerance, stale job-list rejection, schedule-forget fix, regen antiHalluc parity) complete.');
