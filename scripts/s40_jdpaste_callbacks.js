/**
 * s40_jdpaste_callbacks.js -- Phase 4.2 JD-paste menu, part 2: wires the two
 * new inline-keyboard buttons (jd:generate / jd:contacts, added by s39's
 * "Send JD Paste Menu") back into the EXISTING apply and outreach pipelines,
 * rather than building parallel duplicate pipelines.
 *
 * Research (read in full before writing this) established the exact
 * constraint driving this design: 16 downstream nodes resolve
 * $('Prepare Apply Context') / $('Prepare Job Context') / $('Prepare Research')
 * by LITERAL node name -- a same-shaped sibling node under a new name would
 * be invisible to all of them. So the pasted-JD callback path must re-enter
 * these exact existing nodes in the same execution, not clone them.
 *
 * The blocker to that: Retrieve Job and Prepare Research both do hard,
 * un-guarded $('Extract Input')/$('Route Intent') name-lookups, which throw
 * synchronously (n8n's no_execution_data error) when the execution actually
 * originated from a callback_query (Extract Input/Route Intent never ran in
 * that fork -- confirmed via IF: Is Callback Query?'s top-level split).
 * Fix: try/catch each node's existing lookups and add an alternate branch
 * that reads the pasted JD from $getWorkflowStaticData('global').last_pasted_jd
 * (the same "big blob under a short key" idiom already used for last_jobs/
 * last_resume_structured -- confirmed as the only existing precedent for
 * this problem; there is zero precedent for cramming data into callback_data).
 *
 * Retrieve Job's callback branch reuses its OWN existing error-return
 * convention ({chat_id, error}) so the already-wired IF: Job Found? ->
 * Send Job Not Found gate handles missing/expired pending JDs for free --
 * zero new nodes needed for that gate. Prepare Research has no equivalent
 * error convention, so its callback branch instead reuses its OWN existing
 * graceful-default convention ('Unknown' / 'Software Engineer') for the
 * missing/expired case -- also zero new nodes, same reasoning.
 *
 * One new node IS required: Scrape Job Page has no onError/continueOnFail
 * config, so feeding it an empty URL (the jd_paste synthetic job has none --
 * the full JD text is already in hand, nothing to scrape) would crash the
 * execution. IF: Needs Scrape? gates on whether a URL exists at all and
 * skips straight to Prepare Job Context when it doesn't; Prepare Job
 * Context's own scrapeResult-is-truthy-but-has-no-.markdown fallback (already
 * in its code, unmodified) then correctly falls through to
 * retrieveData.job.description_snippet, i.e. the full pasted JD text.
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

const CALLBACK_ARRAY_OLD = "['resume:apply','resume:cancel','resume:redo']";
const CALLBACK_ARRAY_NEW = "['resume:apply','resume:cancel','resume:redo','jd:generate','jd:contacts']";
const ROUTE_CB_OLD_EXPR = `={{ ${CALLBACK_ARRAY_OLD}.indexOf($('Extract Callback').first().json.callback_data) }}`;
const ROUTE_CB_NEW_EXPR = `={{ ${CALLBACK_ARRAY_NEW}.indexOf($('Extract Callback').first().json.callback_data) }}`;

const RETRIEVE_JOB_ANCHOR_OLD =
  "const staticData = $getWorkflowStaticData('global');\n" +
  "const chatId = $('Extract Input').first().json.chat_id;\n" +
  "const rawMessage = $('Telegram Trigger').first().json.message?.text || '';\n" +
  "const entities = $('Route Intent').first().json.output?.entities || {};\n";

const RETRIEVE_JOB_ANCHOR_NEW =
  "const staticData = $getWorkflowStaticData('global');\n" +
  "let chatId, rawMessage, entities;\n" +
  "try {\n" +
  "  chatId = $('Extract Input').first().json.chat_id;\n" +
  "  rawMessage = $('Telegram Trigger').first().json.message?.text || '';\n" +
  "  entities = $('Route Intent').first().json.output?.entities || {};\n" +
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
  "  }\n" +
  "  const company = pending.company || 'unknown';\n" +
  "  const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';\n" +
  "  return [{ json: { chat_id: cb.chat_id, job_number: 0, source: 'jd_paste', company_slug: companySlug, greenhouse_id: null, job: { job_id: `jdpaste-${companySlug}-${Date.now()}`, title: pending.role || '', company, location: '', url: '', description_snippet: pending.jd_text } } }];\n" +
  "}\n";

const PREPARE_RESEARCH_ANCHOR_OLD =
  "const chatId = $('Extract Input').first().json.chat_id;\n" +
  "const routerOutput = $('Route Intent').first().json.output || {};\n" +
  "const entities = routerOutput.entities || {};\n" +
  "const intent = routerOutput.intent || 'outreach';\n" +
  "const msgText = $('Extract Input').first().json.message_text || '';\n";

const PREPARE_RESEARCH_ANCHOR_NEW =
  "let chatId, routerOutput, msgText;\n" +
  "try {\n" +
  "  chatId = $('Extract Input').first().json.chat_id;\n" +
  "  routerOutput = $('Route Intent').first().json.output || {};\n" +
  "  msgText = $('Extract Input').first().json.message_text || '';\n" +
  "} catch (e) {\n" +
  "  const cb = $('Extract Callback').first().json;\n" +
  "  const sd = $getWorkflowStaticData('global');\n" +
  "  const pending = sd.last_pasted_jd;\n" +
  "  const ttlSec = (pending && pending.ttl_seconds) || 1800;\n" +
  "  const fresh = !!(pending && pending.jd_text && ((Date.now() - new Date(pending.created_at).getTime()) / 1000) <= ttlSec);\n" +
  "  const company = (fresh && pending.company) || 'Unknown';\n" +
  "  const role = (fresh && pending.role) || 'Software Engineer';\n" +
  "  return [{ json: { chat_id: cb.chat_id, research_type: 'outreach', company, role, location: '', queries: [], draft_number: null } }];\n" +
  "}\n" +
  "const entities = routerOutput.entities || {};\n" +
  "const intent = routerOutput.intent || 'outreach';\n";

const NEEDS_SCRAPE_NODE_NAME = 'IF: Needs Scrape?';

function patchRouteCallbackAction(wf, base) {
  const n = wf.nodes.find((x) => x.name === 'Route Callback Action');
  if (!n) { console.error(`INTEGRITY FAIL ${base}: Route Callback Action not found`); process.exit(1); }
  if (n.parameters.numberOutputs === 5) return 0;
  if (n.parameters.numberOutputs !== 3) { console.error(`INTEGRITY FAIL ${base}: Route Callback Action numberOutputs expected 3, got ${n.parameters.numberOutputs}`); process.exit(1); }
  if (n.parameters.output !== ROUTE_CB_OLD_EXPR) { console.error(`INTEGRITY FAIL ${base}: Route Callback Action output expression mismatch`); process.exit(1); }
  n.parameters.numberOutputs = 5;
  n.parameters.output = ROUTE_CB_NEW_EXPR;

  const branches = wf.connections['Route Callback Action'].main;
  if (branches.length !== 3) { console.error(`INTEGRITY FAIL ${base}: Route Callback Action connections.main expected 3 branches, got ${branches.length}`); process.exit(1); }
  branches.push([{ node: 'Retrieve Job', type: 'main', index: 0 }]);
  branches.push([{ node: 'Prepare Research', type: 'main', index: 0 }]);
  return 1;
}

function patchRetrieveJob(wf, base) {
  const n = wf.nodes.find((x) => x.name === 'Retrieve Job');
  if (!n) { console.error(`INTEGRITY FAIL ${base}: Retrieve Job not found`); process.exit(1); }
  if (n.parameters.jsCode.includes("last_pasted_jd")) return 0;
  if (!n.parameters.jsCode.startsWith(RETRIEVE_JOB_ANCHOR_OLD)) { console.error(`INTEGRITY FAIL ${base}: Retrieve Job jsCode anchor mismatch`); process.exit(1); }
  n.parameters.jsCode = RETRIEVE_JOB_ANCHOR_NEW + n.parameters.jsCode.slice(RETRIEVE_JOB_ANCHOR_OLD.length);
  return 1;
}

function patchPrepareResearch(wf, base) {
  const n = wf.nodes.find((x) => x.name === 'Prepare Research');
  if (!n) { console.error(`INTEGRITY FAIL ${base}: Prepare Research not found`); process.exit(1); }
  if (n.parameters.jsCode.includes('last_pasted_jd')) return 0;
  if (!n.parameters.jsCode.startsWith(PREPARE_RESEARCH_ANCHOR_OLD)) { console.error(`INTEGRITY FAIL ${base}: Prepare Research jsCode anchor mismatch`); process.exit(1); }
  n.parameters.jsCode = PREPARE_RESEARCH_ANCHOR_NEW + n.parameters.jsCode.slice(PREPARE_RESEARCH_ANCHOR_OLD.length);
  return 1;
}

function patchNeedsScrapeGate(wf, base) {
  if (wf.nodes.some((n) => n.name === NEEDS_SCRAPE_NODE_NAME)) return 0;
  const jobFound = wf.nodes.find((n) => n.name === 'IF: Job Found?');
  if (!jobFound) { console.error(`INTEGRITY FAIL ${base}: IF: Job Found? not found`); process.exit(1); }
  const branches = wf.connections['IF: Job Found?'].main;
  if (branches.length !== 2 || !branches[0].some((e) => e.node === 'Build Scrape Body')) {
    console.error(`INTEGRITY FAIL ${base}: IF: Job Found? true branch does not point at Build Scrape Body as expected`); process.exit(1);
  }
  const pos = [jobFound.position[0] + 100, jobFound.position[1] + 250];
  const gateNode = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            leftValue: "={{ Boolean($json.job?.url) || Boolean($json.direct_url) }}",
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: crypto.randomUUID(),
    name: NEEDS_SCRAPE_NODE_NAME,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: pos,
  };
  wf.nodes.push(gateNode);
  wf.connections['IF: Job Found?'].main[0] = [{ node: NEEDS_SCRAPE_NODE_NAME, type: 'main', index: 0 }];
  wf.connections[NEEDS_SCRAPE_NODE_NAME] = {
    main: [
      [{ node: 'Build Scrape Body', type: 'main', index: 0 }],
      [{ node: 'Prepare Job Context', type: 'main', index: 0 }],
    ],
  };
  return 1;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);

  const already = wf.nodes.some((n) => n.name === NEEDS_SCRAPE_NODE_NAME)
    && (wf.nodes.find((n) => n.name === 'Route Callback Action') || {}).parameters?.numberOutputs === 5;
  if (already) { console.log(`  ${base}: already patched`); return; }

  let edits = 0;
  edits += patchRouteCallbackAction(wf, base);
  edits += patchRetrieveJob(wf, base);
  edits += patchPrepareResearch(wf, base);
  edits += patchNeedsScrapeGate(wf, base);

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
  console.log(`OK ${base}: jd_paste callback wiring added (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. Route Callback Action expression: real behavioral proof, old vs new.
  function makeIndexer(expr) {
    const body = expr.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    return new Function('$', `return (${body});`);
  }
  const mock$ = (data) => (name) => ({ first: () => ({ json: data }) });

  const oldFn = makeIndexer(ROUTE_CB_OLD_EXPR);
  for (const [cb, expected] of [['resume:apply', 0], ['resume:cancel', 1], ['resume:redo', 2], ['jd:generate', -1]]) {
    const got = oldFn(mock$({ callback_data: cb }));
    if (got !== expected) { console.error(`HARNESS FAIL: old callback expr for "${cb}" expected ${expected}, got ${got}`); process.exit(1); }
  }
  const newFn = makeIndexer(ROUTE_CB_NEW_EXPR);
  for (const [cb, expected] of [['resume:apply', 0], ['resume:redo', 2], ['jd:generate', 3], ['jd:contacts', 4], ['garbage', -1]]) {
    const got = newFn(mock$({ callback_data: cb }));
    if (got !== expected) { console.error(`HARNESS FAIL: new callback expr for "${cb}" expected ${expected}, got ${got}`); process.exit(1); }
  }
  console.log('HARNESS OK: Route Callback Action expression verified old (3-way, no fallback) and new (5-way, jd:generate@3, jd:contacts@4, unmatched still -1/dropped -- unchanged behavior preserved for that edge case)');

  // 2. Retrieve Job callback-branch logic: real behavioral proof via new Function,
  //    exercising the ACTUAL replacement text (not a re-typed summary of it).
  {
    const fullOld =
      RETRIEVE_JOB_ANCHOR_OLD +
      "const jobNumber = entities.job_number;\n" +
      "const urlMatch = rawMessage.match(/https?:\\/\\/[^\\s]+/);\n" +
      "if (urlMatch) { return [{ json: { branch: 'url' } }]; }\n" +
      "if (!jobNumber) return [{ json: { chat_id: chatId, error: 'No job number provided.' } }];\n" +
      "return [{ json: { branch: 'number', chat_id: chatId, jobNumber } }];\n";
    const patched = RETRIEVE_JOB_ANCHOR_NEW + fullOld.slice(RETRIEVE_JOB_ANCHOR_OLD.length);
    const fn = new Function('$', "$getWorkflowStaticData", patched);

    // normal (non-callback) execution still works: Extract Input/Route Intent resolve fine.
    function nonCallback$(name) {
      if (name === 'Extract Input') return { first: () => ({ json: { chat_id: 555 } }) };
      if (name === 'Telegram Trigger') return { first: () => ({ json: { message: { text: '3' } } }) };
      if (name === 'Route Intent') return { first: () => ({ json: { output: { entities: { job_number: 3 } } } }) };
      throw new Error('no_execution_data: ' + name);
    }
    const r1 = fn(nonCallback$, () => ({}))[0].json;
    if (r1.branch !== 'number' || r1.jobNumber !== 3) { console.error('HARNESS FAIL: Retrieve Job normal-path regression', r1); process.exit(1); }

    // callback execution, fresh pending JD -> synthetic job.
    function callback$fresh(name) {
      if (name === 'Extract Callback') return { first: () => ({ json: { chat_id: 777, callback_data: 'jd:generate' } }) };
      throw new Error('no_execution_data: ' + name);
    }
    const sdFresh = { last_pasted_jd: { jd_text: 'We are hiring a Backend Engineer...', company: 'Acme Corp', role: 'Backend Engineer', created_at: new Date(Date.now() - 60000).toISOString(), ttl_seconds: 1800 } };
    const r2 = fn(callback$fresh, () => sdFresh)[0].json;
    if (r2.error || r2.chat_id !== 777 || r2.job.company !== 'Acme Corp' || r2.job.description_snippet !== sdFresh.last_pasted_jd.jd_text || r2.job.url !== '') {
      console.error('HARNESS FAIL: Retrieve Job fresh-callback branch wrong', r2); process.exit(1);
    }
    if (!/^jdpaste-acme-corp-\d+$/.test(r2.job.job_id)) { console.error('HARNESS FAIL: jd_paste job_id slug wrong', r2.job.job_id); process.exit(1); }

    // callback execution, expired pending JD -> error (routes to Send Job Not Found for free).
    const sdExpired = { last_pasted_jd: { jd_text: 'x', company: 'Acme', role: 'Eng', created_at: new Date(Date.now() - 3600 * 1000).toISOString(), ttl_seconds: 1800 } };
    const r3 = fn(callback$fresh, () => sdExpired)[0].json;
    if (!r3.error || !/expired/.test(r3.error)) { console.error('HARNESS FAIL: Retrieve Job expired-callback branch did not error', r3); process.exit(1); }

    // callback execution, no pending JD at all -> error.
    const r4 = fn(callback$fresh, () => ({}))[0].json;
    if (!r4.error) { console.error('HARNESS FAIL: Retrieve Job missing-pending-callback branch did not error', r4); process.exit(1); }
  }
  console.log('HARNESS OK: Retrieve Job callback branch proven via real JS eval of the actual patched code -- normal typed-apply path unaffected, fresh/expired/missing pending-JD cases all correct');

  // 3. Prepare Research callback-branch logic: same rigor.
  {
    const fullOld =
      PREPARE_RESEARCH_ANCHOR_OLD +
      "return [{ json: { branch: 'normal', chat_id: chatId, intent: routerOutput.intent, company: entities.company, msgText } }];\n";
    const patched = PREPARE_RESEARCH_ANCHOR_NEW + fullOld.slice(PREPARE_RESEARCH_ANCHOR_OLD.length);
    const fn = new Function('$', "$getWorkflowStaticData", patched);

    function nonCallback$(name) {
      if (name === 'Extract Input') return { first: () => ({ json: { chat_id: 111, message_text: 'find recruiters at Acme' } }) };
      if (name === 'Route Intent') return { first: () => ({ json: { output: { intent: 'outreach', entities: { company: 'Acme' } } } }) };
      throw new Error('no_execution_data: ' + name);
    }
    const r1 = fn(nonCallback$, () => ({}))[0].json;
    if (r1.branch !== 'normal' || r1.company !== 'Acme') { console.error('HARNESS FAIL: Prepare Research normal-path regression', r1); process.exit(1); }

    function callback$(name) {
      if (name === 'Extract Callback') return { first: () => ({ json: { chat_id: 222, callback_data: 'jd:contacts' } }) };
      throw new Error('no_execution_data: ' + name);
    }
    const sdFresh = { last_pasted_jd: { jd_text: 'JD text', company: 'Beta Inc', role: 'Data Scientist', created_at: new Date().toISOString(), ttl_seconds: 1800 } };
    const r2 = fn(callback$, () => sdFresh)[0].json;
    if (r2.chat_id !== 222 || r2.company !== 'Beta Inc' || r2.role !== 'Data Scientist' || r2.research_type !== 'outreach') {
      console.error('HARNESS FAIL: Prepare Research fresh-callback branch wrong', r2); process.exit(1);
    }
    const sdExpired = { last_pasted_jd: { jd_text: 'x', company: 'Beta', role: 'Eng', created_at: new Date(Date.now() - 3600 * 1000).toISOString(), ttl_seconds: 1800 } };
    const r3 = fn(callback$, () => sdExpired)[0].json;
    if (r3.company !== 'Unknown' || r3.role !== 'Software Engineer') { console.error('HARNESS FAIL: Prepare Research expired-callback should degrade to existing defaults', r3); process.exit(1); }
  }
  console.log('HARNESS OK: Prepare Research callback branch proven via real JS eval -- normal outreach/intel path unaffected, fresh pending JD carries through, expired pending JD degrades to the existing Unknown/Software Engineer defaults (no crash, no new error convention needed)');

  // 4. IF: Needs Scrape? structural insertion, against a graph-shaped fixture.
  {
    const wf = {
      nodes: [
        { name: 'IF: Job Found?', position: [100, 100] },
        { name: 'Build Scrape Body' }, { name: 'Prepare Job Context' }, { name: 'Send Job Not Found' },
      ],
      connections: {
        'IF: Job Found?': { main: [[{ node: 'Build Scrape Body', type: 'main', index: 0 }], [{ node: 'Send Job Not Found', type: 'main', index: 0 }]] },
      },
    };
    patchNeedsScrapeGate(wf, 'fixture');
    if (!wf.nodes.some((n) => n.name === NEEDS_SCRAPE_NODE_NAME)) { console.error('HARNESS FAIL: IF: Needs Scrape? not created'); process.exit(1); }
    const jf = wf.connections['IF: Job Found?'].main;
    if (jf[0][0].node !== NEEDS_SCRAPE_NODE_NAME) { console.error('HARNESS FAIL: IF: Job Found? true branch not retargeted'); process.exit(1); }
    if (jf[1][0].node !== 'Send Job Not Found') { console.error('HARNESS FAIL: IF: Job Found? false branch regressed'); process.exit(1); }
    const gate = wf.connections[NEEDS_SCRAPE_NODE_NAME].main;
    if (gate[0][0].node !== 'Build Scrape Body' || gate[1][0].node !== 'Prepare Job Context') { console.error('HARNESS FAIL: IF: Needs Scrape? branches wrong', gate); process.exit(1); }
    // condition proof: has-url vs no-url
    const condFn = new Function('$json', 'return Boolean($json.job?.url) || Boolean($json.direct_url);');
    if (condFn({ job: { url: 'https://x.com/job' } }) !== true) { console.error('HARNESS FAIL: needs-scrape condition false for a real job URL'); process.exit(1); }
    if (condFn({ direct_url: 'https://x.com' } ) !== true) { console.error('HARNESS FAIL: needs-scrape condition false for a direct_url paste'); process.exit(1); }
    if (condFn({ job: { url: '' }, company_slug: 'acme' }) !== false) { console.error('HARNESS FAIL: needs-scrape condition true for the jd_paste synthetic job (should skip scrape)'); process.exit(1); }
  }
  console.log('HARNESS OK: IF: Needs Scrape? correctly retargets IF: Job Found?\'s true branch, skips scraping only for the URL-less jd_paste synthetic job, and leaves the false (not-found) branch untouched');
})();

TARGETS.forEach(patch);
console.log('S40 (jd_paste callback wiring: Retrieve Job / Prepare Research / Route Callback Action / IF: Needs Scrape?) complete.');
