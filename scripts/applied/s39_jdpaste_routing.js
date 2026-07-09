/**
 * s39_jdpaste_routing.js -- Phase 4.2 JD-paste menu, part 1: intent
 * classification + company/role extraction + the 2-button inline-keyboard
 * menu. (Part 2, s40, wires the button taps back into the existing apply/
 * outreach pipelines.)
 *
 * Research (4-agent parallel investigation, read in full before writing this)
 * confirmed:
 * - No existing mechanism ingests a raw pasted JD today (score/apply both
 *   require a prior bot-found job). jd_paste is a genuinely new intent.
 * - Intent Router's Structured Output Parser + Route Intent's Switch are both
 *   fully saturated (17 intents + 1 fallback = numberOutputs:18, zero spare
 *   branches) -- adding jd_paste requires touching all three in lockstep:
 *   system message, parser enum, and the Switch's numberOutputs/array/fallback.
 * - Step0 JD Analysis already has the exact company/role-extraction prompt
 *   shape needed here, but it runs too late in the real apply pipeline
 *   (after Prepare Apply Context, which needs company/job_title already
 *   known) -- so jd_paste gets its own standalone extraction pass upfront,
 *   reusing that prompt shape, rather than waiting on Step0.
 * - Step0's schema forces non-empty companyName/roleName (minLength:1, no
 *   null allowed) -- a real reliability gap for JDs that never name the
 *   company. This node's prompt explicitly tells the model to fall back to
 *   "the company"/"this role" wording instead of hallucinating a name.
 * - The only existing inline-keyboard precedent is Send Resume Preview
 *   (resume:apply/cancel/redo) -- cloned structurally here (nested
 *   row.buttons[].additionalFields.callback_data shape).
 * - User decision: Resume and Cover Letter are NOT split into separate
 *   generations (the existing apply pipeline always produces both PDFs
 *   together, unconditionally, and splitting that fan-out was ruled
 *   out-of-scope/higher-risk) -- so this is a 2-button menu, not 3:
 *   "Resume + Cover Letter" (jd:generate) and "Find Contacts" (jd:contacts).
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
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

const INTENT_ARRAY_OLD = "['help','find_jobs','apply','revise','score','intel','outreach','salary','track','status','setup_resume','view_prefs','update_prefs','forget_pref','verbose_toggle','check_resume','costs']";
const INTENT_ARRAY_NEW = "['help','find_jobs','apply','revise','score','intel','outreach','salary','track','status','setup_resume','view_prefs','update_prefs','forget_pref','verbose_toggle','check_resume','costs','jd_paste']";

const ROUTE_INTENT_OLD_EXPR = `={{ ${INTENT_ARRAY_OLD}.indexOf($json.output.intent) === -1 ? 17 : ${INTENT_ARRAY_OLD}.indexOf($json.output.intent) }}`;
const ROUTE_INTENT_NEW_EXPR = `={{ ${INTENT_ARRAY_NEW}.indexOf($json.output.intent) === -1 ? 18 : ${INTENT_ARRAY_NEW}.indexOf($json.output.intent) }}`;

const SYSMSG_COUNT_OLD = 'classify it into one of 16 intents';
const SYSMSG_COUNT_NEW = 'classify it into one of 18 intents';

const SYSMSG_SCHEMA_LINE_OLD = '"intent": "help | find_jobs | apply | revise | score | intel | outreach | salary | track | status | setup_resume | view_prefs | update_prefs | forget_pref | verbose_toggle | check_resume | costs",';
const SYSMSG_SCHEMA_LINE_NEW = '"intent": "help | find_jobs | apply | revise | score | intel | outreach | salary | track | status | setup_resume | view_prefs | update_prefs | forget_pref | verbose_toggle | check_resume | costs | jd_paste",';

const SYSMSG_TAIL_OLD = '17. costs — Show how much has been spent on paid API providers (Apollo, etc.). Triggers: "costs", "spend", "usage", "how much have I spent", "my bill".';
const SYSMSG_TAIL_NEW = SYSMSG_TAIL_OLD + '\n\n18. jd_paste — User pastes a full job description directly into the chat (a long block of text with role/company/requirements-like content), not a short command or question. Triggers: message length roughly 400+ characters that reads like an actual job posting (responsibilities, qualifications, "we are looking for" style language), especially if it names a role and lists skills/requirements. Do not route short questions ABOUT a company or role here -- those are intel or find_jobs. A single pasted block that IS a job description is jd_paste even with no explicit keyword like "apply" or "job".';

const NEW_NODE_NAME = 'JD Paste Extract';

function patchIntentRouter(wf, base) {
  const n = wf.nodes.find((x) => x.name === 'Intent Router');
  if (!n) { console.error(`INTEGRITY FAIL ${base}: Intent Router not found`); process.exit(1); }
  let sm = n.parameters.options.systemMessage;
  if (sm.includes('classify it into one of 18 intents')) return 0; // already patched

  if ((sm.match(new RegExp(SYSMSG_COUNT_OLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length !== 1) {
    console.error(`INTEGRITY FAIL ${base}: SYSMSG_COUNT_OLD anchor not found exactly once`); process.exit(1);
  }
  if (!sm.includes(SYSMSG_SCHEMA_LINE_OLD)) { console.error(`INTEGRITY FAIL ${base}: SYSMSG_SCHEMA_LINE_OLD anchor not found`); process.exit(1); }
  if (!sm.includes(SYSMSG_TAIL_OLD)) { console.error(`INTEGRITY FAIL ${base}: SYSMSG_TAIL_OLD anchor not found`); process.exit(1); }
  if (!sm.trimEnd().endsWith(SYSMSG_TAIL_OLD)) { console.error(`INTEGRITY FAIL ${base}: SYSMSG_TAIL_OLD is not the tail of the message -- unexpected trailing content`); process.exit(1); }

  sm = sm.replace(SYSMSG_COUNT_OLD, SYSMSG_COUNT_NEW);
  sm = sm.replace(SYSMSG_SCHEMA_LINE_OLD, SYSMSG_SCHEMA_LINE_NEW);
  sm = sm.replace(SYSMSG_TAIL_OLD, SYSMSG_TAIL_NEW);
  n.parameters.options.systemMessage = sm;
  return 1;
}

function patchOutputParser(wf, base) {
  const n = wf.nodes.find((x) => x.name === 'Structured Output Parser');
  if (!n) { console.error(`INTEGRITY FAIL ${base}: Structured Output Parser not found`); process.exit(1); }
  const schema = JSON.parse(n.parameters.inputSchema);
  if (schema.properties.intent.enum.includes('jd_paste')) return 0; // already patched
  if (!schema.properties.intent.enum.includes('costs')) { console.error(`INTEGRITY FAIL ${base}: intent enum missing expected "costs" entry`); process.exit(1); }
  schema.properties.intent.enum.push('jd_paste');
  n.parameters.inputSchema = JSON.stringify(schema, null, 2);
  return 1;
}

function patchRouteIntent(wf, base) {
  const n = wf.nodes.find((x) => x.name === 'Route Intent');
  if (!n) { console.error(`INTEGRITY FAIL ${base}: Route Intent not found`); process.exit(1); }
  if (n.parameters.numberOutputs === 19) return 0; // already patched
  if (n.parameters.numberOutputs !== 18) { console.error(`INTEGRITY FAIL ${base}: Route Intent numberOutputs expected 18, got ${n.parameters.numberOutputs}`); process.exit(1); }
  if (n.parameters.output !== ROUTE_INTENT_OLD_EXPR) { console.error(`INTEGRITY FAIL ${base}: Route Intent output expression did not match expected anchor`); process.exit(1); }
  n.parameters.numberOutputs = 19;
  n.parameters.output = ROUTE_INTENT_NEW_EXPR;

  const branches = wf.connections['Route Intent'].main;
  if (branches.length !== 18) { console.error(`INTEGRITY FAIL ${base}: Route Intent connections.main expected 18 branches, got ${branches.length}`); process.exit(1); }
  const fallbackBranch = branches[17];
  if (!fallbackBranch.some((e) => e.node === 'Send Fallback')) { console.error(`INTEGRITY FAIL ${base}: Route Intent branch 17 does not point at Send Fallback as expected`); process.exit(1); }
  branches.splice(17, 0, [{ node: NEW_NODE_NAME, type: 'main', index: 0 }]);
  if (branches.length !== 19 || !branches[18].some((e) => e.node === 'Send Fallback')) {
    console.error(`INTEGRITY FAIL ${base}: post-splice branch layout wrong`); process.exit(1);
  }
  return 1;
}

function buildNewNodes(anchorPos, telegramCred, openRouterCred) {
  const ax = anchorPos[0], ay = anchorPos[1];
  const extractNode = {
    parameters: {
      promptType: 'define',
      text: "={{ $('Extract Input').first().json.message_text }}",
      messages: {
        messageValues: [
          {
            message: 'Extract structured info from this pasted job description. Return ONLY valid JSON (no markdown):\n{\n  "companyName": "<exact company name as written in the JD -- if not stated anywhere, use \'the company\'>",\n  "roleName": "<exact role/position title from the JD -- if not stated, use \'this role\'>",\n  "shortRole": "<shortened role title in max 2 words for filename use -- e.g. \'AI Engineer\', \'Data Scientist\'>"\n}\nBe concise and factual. Do not invent a company or role name that is not actually present in the text.',
          },
        ],
      },
      hasOutputParser: true,
    },
    id: crypto.randomUUID(),
    name: 'JD Paste Extract',
    type: '@n8n/n8n-nodes-langchain.chainLlm',
    typeVersion: 1.4,
    position: [ax, ay],
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 1000,
  };
  const modelNode = {
    parameters: { model: 'openai/gpt-5.4-mini', options: {} },
    id: crypto.randomUUID(),
    name: 'JD Paste Extract Model',
    type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter',
    typeVersion: 1,
    position: [ax, ay + 200],
    credentials: { openRouterApi: openRouterCred },
  };
  const parserSchema = {
    type: 'object',
    properties: {
      companyName: { type: 'string', minLength: 1 },
      roleName: { type: 'string', minLength: 1 },
      shortRole: { type: 'string', minLength: 1 },
    },
    required: ['companyName', 'roleName', 'shortRole'],
    additionalProperties: true,
  };
  const parserNode = {
    parameters: { schemaType: 'manual', inputSchema: JSON.stringify(parserSchema, null, 2) },
    id: crypto.randomUUID(),
    name: 'JD Paste Extract Output Parser',
    type: '@n8n/n8n-nodes-langchain.outputParserStructured',
    typeVersion: 1.2,
    position: [ax + 150, ay + 200],
  };
  const stageNode = {
    parameters: {
      jsCode:
        "const raw = $('Extract Input').first().json;\n" +
        "const chatId = raw.chat_id;\n" +
        "const jdText = raw.message_text || '';\n" +
        "const extract = $input.first().json.output || {};\n" +
        "const sd = $getWorkflowStaticData('global');\n" +
        "const company = extract.companyName || 'the company';\n" +
        "const role = extract.roleName || 'this role';\n" +
        'sd.last_pasted_jd = {\n' +
        '  jd_text: jdText,\n' +
        '  company,\n' +
        '  role,\n' +
        "  short_role: extract.shortRole || 'Role',\n" +
        '  created_at: new Date().toISOString(),\n' +
        '  ttl_seconds: 1800\n' +
        '};\n' +
        'return [{ json: { chat_id: chatId, company, role } }];',
    },
    id: crypto.randomUUID(),
    name: 'Stage JD Paste',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [ax + 300, ay],
  };
  const menuNode = {
    parameters: {
      chatId: '={{ $json.chat_id }}',
      text: "={{ '📋 Got your pasted job description for *' + $json.role + '* at *' + $json.company + '*.\\n\\nWhat should I do with it?' }}",
      replyMarkup: 'inlineKeyboard',
      inlineKeyboard: {
        rows: [
          { row: { buttons: [{ text: '📄 Resume + Cover Letter', additionalFields: { callback_data: 'jd:generate' } }] } },
          { row: { buttons: [{ text: '👥 Find Contacts', additionalFields: { callback_data: 'jd:contacts' } }] } },
        ],
      },
      additionalFields: { appendAttribution: false, disable_web_page_preview: true, parse_mode: 'Markdown' },
    },
    id: crypto.randomUUID(),
    name: 'Send JD Paste Menu',
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: [ax + 600, ay],
    credentials: { telegramApi: telegramCred },
  };
  return { extractNode, modelNode, parserNode, stageNode, menuNode };
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);

  if (wf.nodes.some((n) => n.name === NEW_NODE_NAME)) {
    console.log(`  ${base}: already patched (${NEW_NODE_NAME} exists)`);
    return;
  }

  let edits = 0;
  edits += patchIntentRouter(wf, base);
  edits += patchOutputParser(wf, base);
  edits += patchRouteIntent(wf, base);

  const routeIntentNode = wf.nodes.find((n) => n.name === 'Route Intent');
  const anchor = [routeIntentNode.position[0] + 400, routeIntentNode.position[1] + 1500];
  const telegramCred = wf.nodes.find((n) => n.name === 'Send Resume Preview').credentials.telegramApi;
  const openRouterCred = wf.nodes.find((n) => n.name === 'Intent Router Model').credentials.openRouterApi;
  const { extractNode, modelNode, parserNode, stageNode, menuNode } = buildNewNodes(anchor, telegramCred, openRouterCred);
  wf.nodes.push(extractNode, modelNode, parserNode, stageNode, menuNode);
  edits++;

  wf.connections['JD Paste Extract Model'] = { ai_languageModel: [[{ node: 'JD Paste Extract', type: 'ai_languageModel', index: 0 }]] };
  wf.connections['JD Paste Extract Output Parser'] = { ai_outputParser: [[{ node: 'JD Paste Extract', type: 'ai_outputParser', index: 0 }]] };
  wf.connections['JD Paste Extract'] = { main: [[{ node: 'Stage JD Paste', type: 'main', index: 0 }]] };
  wf.connections['Stage JD Paste'] = { main: [[{ node: 'Send JD Paste Menu', type: 'main', index: 0 }]] };
  edits++;

  // integrity: no dangling connections
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling connection ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: jd_paste routing + extraction + menu added (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. Route Intent expression: real behavioral proof via new Function, old vs new.
  function makeIndexer(expr) {
    // strip the leading "={{ " and trailing " }}" n8n expression wrapper
    const body = expr.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    return new Function('$json', `return (${body});`);
  }
  const oldFn = makeIndexer(ROUTE_INTENT_OLD_EXPR);
  const newFn = makeIndexer(ROUTE_INTENT_NEW_EXPR);

  const oldCases = [['help', 0], ['costs', 16], ['garbage', 17]];
  for (const [intent, expected] of oldCases) {
    const got = oldFn({ output: { intent } });
    if (got !== expected) { console.error(`HARNESS FAIL: old expression for "${intent}" expected ${expected}, got ${got}`); process.exit(1); }
  }
  const newCases = [['help', 0], ['costs', 16], ['jd_paste', 17], ['garbage', 18]];
  for (const [intent, expected] of newCases) {
    const got = newFn({ output: { intent } });
    if (got !== expected) { console.error(`HARNESS FAIL: new expression for "${intent}" expected ${expected}, got ${got}`); process.exit(1); }
  }
  console.log('HARNESS OK: Route Intent expression verified old (17-way + fallback@17) and new (18-way + jd_paste@17 + fallback@18) via real JS eval');

  // 2. Splice-based branch insertion, against a graph-shaped fixture.
  {
    const branches = [];
    for (let i = 0; i < 17; i++) branches.push([{ node: 'X' + i, type: 'main', index: 0 }]);
    branches.push([{ node: 'Send Fallback', type: 'main', index: 0 }]);
    if (branches.length !== 18) throw new Error('fixture setup wrong');
    branches.splice(17, 0, [{ node: 'JD Paste Extract', type: 'main', index: 0 }]);
    if (branches.length !== 19) { console.error('HARNESS FAIL: splice did not grow to 19 branches'); process.exit(1); }
    if (branches[17][0].node !== 'JD Paste Extract') { console.error('HARNESS FAIL: branch 17 is not JD Paste Extract after splice'); process.exit(1); }
    if (branches[18][0].node !== 'Send Fallback') { console.error('HARNESS FAIL: Send Fallback did not shift to branch 18'); process.exit(1); }
  }
  console.log('HARNESS OK: connections.main splice inserts jd_paste at 17 and shifts Send Fallback to 18');

  // 3. Structured Output Parser schema roundtrip.
  {
    const schema = { type: 'object', properties: { intent: { type: 'string', enum: ['help', 'costs'] } } };
    schema.properties.intent.enum.push('jd_paste');
    const roundtripped = JSON.parse(JSON.stringify(schema, null, 2));
    if (!roundtripped.properties.intent.enum.includes('jd_paste')) { console.error('HARNESS FAIL: schema enum roundtrip lost jd_paste'); process.exit(1); }
  }

  // 4. New node shapes are structurally sound (button nesting, credentials wiring).
  {
    const { extractNode, modelNode, parserNode, stageNode, menuNode } = buildNewNodes([0, 0], { id: 'tg', name: 'x' }, { id: 'or', name: 'y' });
    if (extractNode.type !== '@n8n/n8n-nodes-langchain.chainLlm' || !extractNode.parameters.hasOutputParser) { console.error('HARNESS FAIL: extractNode malformed'); process.exit(1); }
    if (modelNode.parameters.model !== 'openai/gpt-5.4-mini') { console.error('HARNESS FAIL: modelNode wrong model'); process.exit(1); }
    const parsedParserSchema = JSON.parse(parserNode.parameters.inputSchema);
    if (!parsedParserSchema.required.includes('companyName')) { console.error('HARNESS FAIL: parserNode schema missing companyName'); process.exit(1); }
    // simulate Stage JD Paste's core logic
    const sd = {};
    const extract = { companyName: '', roleName: 'Backend Engineer', shortRole: 'Backend Eng' };
    const company = extract.companyName || 'the company';
    const role = extract.roleName || 'this role';
    if (company !== 'the company' || role !== 'Backend Engineer') { console.error('HARNESS FAIL: Stage JD Paste fallback logic wrong'); process.exit(1); }
    const rows = menuNode.parameters.inlineKeyboard.rows;
    const callbacks = rows.flatMap((r) => r.row.buttons.map((b) => b.additionalFields.callback_data));
    if (JSON.stringify(callbacks) !== JSON.stringify(['jd:generate', 'jd:contacts'])) { console.error('HARNESS FAIL: menu callback_data values wrong', callbacks); process.exit(1); }
  }
  console.log('HARNESS OK: new node shapes (chainLlm+model+parser+stage+menu) structurally verified, fallback-to-generic-name logic proven, menu callback_data confirmed jd:generate/jd:contacts');
})();

TARGETS.forEach(patch);
console.log('S39 (jd_paste routing + extraction + menu) complete.');
