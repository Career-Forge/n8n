/**
 * s102_error_hardening.js -- fixes 2 real, currently-live bugs found via a
 * flatted-SQLite execution pull (exec ids 690, 687, 693, 684) after the user
 * reported "2 crashes" (turned out to be 3 distinct issues; a 4th
 * candidate -- Pre-flight: Providers referencing 'Load Geo Reference
 * (Search)' -- turned out to be a stale pre-s98 error, already fixed by
 * that deploy, confirmed by checking its jsCode no longer calls that node).
 *
 * 1. Prepare Research (exec 690, "Find me contacts for 3rd role"): its
 *    try/catch used a THROW to detect "am I on the text-message path or the
 *    callback path" -- fragile because Prepare Research is fed by Route
 *    Intent at TWO output ports (5=intel, 6=outreach), and $('Route Intent')
 *    referenced without a port is ambiguous for a dual-connected upstream
 *    node. Whatever the try block's real (swallowed) error was, catch's own
 *    $('Extract Callback') reference then threw a SECOND time (Extract
 *    Callback never runs on the text-message path), and n8n's task-runner
 *    mangles that into the confusing "Cannot assign to read only property
 *    'name'" TypeError, masking the original cause entirely.
 *    Fix: (a) read routerOutput from $('Intent Router') instead of
 *    $('Route Intent') -- Intent Router is Route Intent's single-output
 *    upstream LLM node, so the data is identical but the port reference is
 *    unambiguous; (b) replace the try/catch with the same $('Node').isExecuted
 *    guard pattern already used elsewhere in this workflow (e.g. Build
 *    Telegraph Body's chat_id fallback chain), so a genuine failure produces
 *    an explicit, readable error instead of a masked one.
 *
 * 2. Expand Query Output Parser (exec 687, 693 -- both scheduled/bare-query
 *    ticks): gpt-5.4-mini consistently (6/6 sampled retries) wraps its JSON
 *    in an extra {"output": {...}} envelope when the query is bare/null
 *    (scheduled digest runs pass message_text: null), failing the
 *    role_families-required schema check every time -- retries don't help
 *    since the model is consistently wrong the same way. Fix: turn on the
 *    parser's own Auto-Fix Format (an LLM-corrective pass that only runs on
 *    parse failure, so zero added cost/latency in the common case), plus a
 *    free prompt line explicitly forbidding the wrapper key as a first line
 *    of defense.
 *
 * 3. Send Apply Ack (exec 684): ECONNRESET/socket-hang-up mid-request to
 *    Telegram's API -- a one-off transient network blip, not a logic bug.
 *    Audit found retryOnFail unset on ALL 49 Telegram nodes in this
 *    workflow, not just the Ack ones -- the same class of transient failure
 *    could silently drop any bot reply. Fix: retryOnFail:true, maxTries:3,
 *    waitBetweenTries:1000 on every n8n-nodes-base.telegram node, matching
 *    the retry convention already standing for LLM nodes.
 *
 * No node count change. Run: inside the n8n container with the repo staged
 * under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const PREPARE_RESEARCH_OLD = `let chatId, routerOutput, msgText;
try {
  chatId = $('Extract Input').first().json.chat_id;
  routerOutput = $('Route Intent').first().json.output || {};
  msgText = $('Extract Input').first().json.message_text || '';
} catch (e) {
  const cb = $('Extract Callback').first().json;
  const sd = $getWorkflowStaticData('global');
  const pending = sd.last_pasted_jd;
  const ttlSec = (pending && pending.ttl_seconds) || 1800;
  const fresh = !!(pending && pending.jd_text && ((Date.now() - new Date(pending.created_at).getTime()) / 1000) <= ttlSec);
  const cbId = ((cb.callback_data || '').split(':')[2]) || null;
  const idOk = !(pending && pending.id) || cbId === pending.id;
  if (!fresh || !idOk || !pending.company) {
    // s49: explicit error instead of a junk 'Unknown' contact search -- routed
    // through the existing draft-error plumbing (Load Draft Contact -> Send No Contact).
    return [{ json: { chat_id: cb.chat_id, research_type: 'draft', draft_number: null, _jd_expired: true, company: null, role: null, queries: [] } }];
  }
  return [{ json: { chat_id: cb.chat_id, research_type: 'outreach', company: pending.company, role: pending.role || 'Software Engineer', location: '', queries: [], draft_number: null } }];
}
const entities = routerOutput.entities || {};`;

const PREPARE_RESEARCH_NEW = `let chatId, routerOutput, msgText;
if ($('Extract Input').isExecuted) {
  chatId = $('Extract Input').first().json.chat_id;
  // s102: read from Intent Router (single output) instead of Route Intent
  // (a 19-output Switch connected to THIS node at two ports, 5 and 6 --
  // an ambiguous $('Route Intent') reference from here). Same data either
  // way since Route Intent only routes, never transforms.
  routerOutput = $('Intent Router').first().json.output || {};
  msgText = $('Extract Input').first().json.message_text || '';
} else if ($('Extract Callback').isExecuted) {
  const cb = $('Extract Callback').first().json;
  const sd = $getWorkflowStaticData('global');
  const pending = sd.last_pasted_jd;
  const ttlSec = (pending && pending.ttl_seconds) || 1800;
  const fresh = !!(pending && pending.jd_text && ((Date.now() - new Date(pending.created_at).getTime()) / 1000) <= ttlSec);
  const cbId = ((cb.callback_data || '').split(':')[2]) || null;
  const idOk = !(pending && pending.id) || cbId === pending.id;
  if (!fresh || !idOk || !pending.company) {
    // s49: explicit error instead of a junk 'Unknown' contact search -- routed
    // through the existing draft-error plumbing (Load Draft Contact -> Send No Contact).
    return [{ json: { chat_id: cb.chat_id, research_type: 'draft', draft_number: null, _jd_expired: true, company: null, role: null, queries: [] } }];
  }
  return [{ json: { chat_id: cb.chat_id, research_type: 'outreach', company: pending.company, role: pending.role || 'Software Engineer', location: '', queries: [], draft_number: null } }];
} else {
  // s102: neither source node executed -- fail loud and explicit instead of
  // an accidental $('Extract Callback') reference masking the real cause.
  throw new Error('Prepare Research: neither Extract Input nor Extract Callback executed for this run.');
}
const entities = routerOutput.entities || {};`;

const EXPAND_QUERY_PROMPT_OLD = 'Return ONLY raw JSON -- no ```json code fences, no markdown, no preamble or explanation before or after the JSON object.\n\nYou are a job search intent extractor.';
const EXPAND_QUERY_PROMPT_NEW = 'Return ONLY raw JSON -- no ```json code fences, no markdown, no preamble or explanation before or after the JSON object. The JSON object\'s top-level keys must be exactly the schema fields themselves (role_families, excluded_roles, etc.) -- do NOT wrap the object in an extra key like "output" or "result".\n\nYou are a job search intent extractor.';

function replaceOnce(val, oldStr, newStr, label) {
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: expected exactly 1 match for ${label}, found ${count}`); process.exit(1); }
  return val.split(oldStr).join(newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  const alreadyDone = N['Prepare Research'] && N['Prepare Research'].parameters.jsCode.includes('neither Extract Input nor Extract Callback executed');
  if (alreadyDone) { console.log(`  ${base}: already patched`); return; }

  // 1. Prepare Research
  if (!N['Prepare Research']) { console.error(`INTEGRITY FAIL ${base}: Prepare Research missing`); process.exit(1); }
  N['Prepare Research'].parameters.jsCode = replaceOnce(N['Prepare Research'].parameters.jsCode, PREPARE_RESEARCH_OLD, PREPARE_RESEARCH_NEW, 'Prepare Research body');

  // 2. Expand Query Output Parser -- Auto-Fix Format
  if (!N['Expand Query Output Parser']) { console.error(`INTEGRITY FAIL ${base}: Expand Query Output Parser missing`); process.exit(1); }
  N['Expand Query Output Parser'].parameters.autoFix = true;

  // 2b. Expand Query prompt -- explicit no-wrapper instruction
  if (!N['Expand Query']) { console.error(`INTEGRITY FAIL ${base}: Expand Query missing`); process.exit(1); }
  const mv = N['Expand Query'].parameters.messages.messageValues;
  mv[0].message = replaceOnce(mv[0].message, EXPAND_QUERY_PROMPT_OLD, EXPAND_QUERY_PROMPT_NEW, 'Expand Query prompt header');

  // 3. Telegram retryOnFail -- every n8n-nodes-base.telegram node
  let tgPatched = 0;
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.telegram') {
      n.retryOnFail = true;
      n.maxTries = 3;
      n.waitBetweenTries = 1000;
      tgPatched += 1;
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Prepare Research hardened, Expand Query Auto-Fix on, ${tgPatched} Telegram nodes given retryOnFail -- ${wf.nodes.length} nodes`);
}

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
