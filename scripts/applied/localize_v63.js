/**
 * localize_v63.js — Build a fully-local (Docker n8n, no Supabase, no fs) workflow
 * from "CareerForge Master v6.3.json".
 *
 * Storage model:
 *   - Global master resume  -> /data/user-data/resume_structured.json   (file)
 *   - Pending preview        -> /data/user-data/.cf_pending.json         (file)
 *   File I/O uses native nodes only: readWriteFile + extractFromFile (read)
 *   and convertToFile + readWriteFile (write). No require('fs') anywhere.
 *
 * Run:  node scripts/localize_v63.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'workflows', 'CareerForge Master v6.3.json');
const OUT1 = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const OUT2 = path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json');

const GLOBAL_FILE = '/data/user-data/resume_structured.json';
const PENDING_FILE = '/data/user-data/.cf_pending.json';

const wf = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const nodes = wf.nodes;
const conns = wf.connections;
const N = {}; nodes.forEach(n => { N[n.name] = n; });

const uid = () => crypto.randomUUID();
function mk(name, type, typeVersion, parameters, pos, extra = {}) {
  return { parameters, id: uid(), name, type, typeVersion, position: pos, ...extra };
}
function addNode(node) { nodes.push(node); N[node.name] = node; }
function removeNode(name) {
  const i = nodes.findIndex(n => n.name === name);
  if (i >= 0) nodes.splice(i, 1);
  delete N[name];
  delete conns[name];
  for (const src in conns) {
    const o = conns[src];
    for (const t in o) o[t] = o[t].map(br => (br ? br.filter(c => c.node !== name) : br));
  }
}
function out(from, toName, index = 0) {
  conns[from] = conns[from] || {};
  conns[from].main = conns[from].main || [];
  conns[from].main[index] = [{ node: toName, type: 'main', index: 0 }];
}
const READ_RW = (sel) => ({ fileSelector: sel, options: {} });
const READ_EXTRACT = { operation: 'fromJson', binaryPropertyName: 'data', destinationKey: 'value', options: {} };
const WRITE_CONVERT = { operation: 'toJson', mode: 'each', options: { format: true } };
const WRITE_RW = (file) => ({ operation: 'write', fileName: file, dataPropertyName: 'data', options: {} });
const CONTINUE = { onError: 'continueRegularOutput' };
// Robust JSON-file parse: read the binary from the preceding readWriteFile and JSON.parse it.
// Proven mechanism (same getBinaryDataBuffer that Read Uploaded File uses); replaces extractFromFile.
const PARSE_CODE = [
  '// Parse the JSON file read by the preceding Read/Write Files node (no fs, no extractFromFile).',
  'let value = null;',
  "try { const buf = await this.helpers.getBinaryDataBuffer(0, 'data'); if (buf && buf.length) value = JSON.parse(buf.toString('utf8')); } catch (e) {}",
  'return [{ json: { value } }];'
].join('\n');

// ───────────────────────────────────────────────────────────────────────────
// 1) RESUME READS: supabase getAll -> readWriteFile(read) + extractFromFile(fromJson)
//    All three read the same global resume file and emit { value:<resume> }.
// ───────────────────────────────────────────────────────────────────────────
const reads = [
  { node: 'Read Resume',                consumer: 'Build Scorer Input' },
  { node: 'Read Master Resume (Apply)', consumer: 'Parse Personal Info' },
  { node: 'Read Resume Status',         consumer: 'Format Resume Status' },
];
for (const r of reads) {
  const src = N[r.node];
  const pos = src.position;
  // mutate in place -> readWriteFile read
  src.type = 'n8n-nodes-base.readWriteFile';
  src.typeVersion = 1.1;
  src.parameters = READ_RW(GLOBAL_FILE);
  src.onError = 'continueRegularOutput';
  delete src.credentials;
  // insert parse node between src and consumer
  const parseName = r.node + ' (parse)';
  addNode(mk(parseName, 'n8n-nodes-base.code', 2, { jsCode: PARSE_CODE }, [pos[0] + 180, pos[1]]));
  out(r.node, parseName);
  out(parseName, r.consumer);
}

// ───────────────────────────────────────────────────────────────────────────
// 2) PENDING LOOKUP: supabase -> readWriteFile(read) + extractFromFile  (pending file)
//    emits { value:{ resume_doc, created_at, ttl_seconds, chat_id } }
// ───────────────────────────────────────────────────────────────────────────
{
  const src = N['Lookup Pending Resume'];
  const pos = src.position;
  src.type = 'n8n-nodes-base.readWriteFile';
  src.typeVersion = 1.1;
  src.parameters = READ_RW(PENDING_FILE);
  src.onError = 'continueRegularOutput';
  delete src.credentials;
  addNode(mk('Lookup Pending Resume (parse)', 'n8n-nodes-base.code', 2, { jsCode: PARSE_CODE }, [pos[0] + 160, pos[1]]));
  out('Lookup Pending Resume', 'Lookup Pending Resume (parse)');
  out('Lookup Pending Resume (parse)', 'Route Callback Action');
}

// ───────────────────────────────────────────────────────────────────────────
// 3) PENDING SAVE: Prep Save Pending Body -> Stage -> convertToFile -> write -> Send Resume Preview
//    (drops Delete Existing Pending Resume / Restore Pending Row For Save / Save Pending Resume)
// ───────────────────────────────────────────────────────────────────────────
const PREP_PENDING_POS = N['Prep Save Pending Body'].position;
removeNode('Delete Existing Pending Resume');
removeNode('Restore Pending Row For Save');
removeNode('Save Pending Resume');
addNode(mk('Stage Pending Write', 'n8n-nodes-base.code', 2, {
  jsCode: [
    "// Localized: build the pending-preview row to persist as a JSON file.",
    "const j = $input.first().json || {};",
    "const v = (j.value && typeof j.value === 'object') ? j.value : {};",
    "return [{ json: {",
    "  resume_doc: v.resume_doc,",
    "  created_at: v.created_at || new Date().toISOString(),",
    "  ttl_seconds: v.ttl_seconds || 900,",
    "  chat_id: j.chat_id",
    "} }];",
  ].join('\n')
}, [PREP_PENDING_POS[0] + 170, PREP_PENDING_POS[1]]));
addNode(mk('Pending To File', 'n8n-nodes-base.convertToFile', 1.1, WRITE_CONVERT, [PREP_PENDING_POS[0] + 340, PREP_PENDING_POS[1]]));
addNode(mk('Save Pending File', 'n8n-nodes-base.readWriteFile', 1.1, WRITE_RW(PENDING_FILE), [PREP_PENDING_POS[0] + 510, PREP_PENDING_POS[1]]));
out('Prep Save Pending Body', 'Stage Pending Write');
out('Stage Pending Write', 'Pending To File');
out('Pending To File', 'Save Pending File');
out('Save Pending File', 'Send Resume Preview');

// ───────────────────────────────────────────────────────────────────────────
// 4) GLOBAL SAVE (apply confirm): IF#0 -> Restore Apply Row For Save -> Stage -> convertToFile -> write -> Send Apply Confirm
//    (drops Delete Existing Global Resume / Apply Resume / Delete Pending After Apply)
// ───────────────────────────────────────────────────────────────────────────
const RESTORE_POS = N['Restore Apply Row For Save'].position;
removeNode('Delete Existing Global Resume');
removeNode('Apply Resume');
removeNode('Delete Pending After Apply');
// IF: Pending Resume Valid? -> #0 Restore Apply Row For Save (keep), #1 Send Apply Resume Error
out('IF: Pending Resume Valid?', 'Restore Apply Row For Save', 0);
out('IF: Pending Resume Valid?', 'Send Apply Resume Error', 1);
addNode(mk('Stage Global Write', 'n8n-nodes-base.code', 2, {
  jsCode: [
    "// Localized: persist confirmed master resume; mirror to staticData fallback.",
    "const sd = $getWorkflowStaticData('global');",
    "const v = ($input.first().json && $input.first().json.value) || {};",
    "sd.last_resume_structured = v;",
    "sd.last_resume_saved_at = new Date().toISOString();",
    "return [{ json: v }];",
  ].join('\n')
}, [RESTORE_POS[0] + 170, RESTORE_POS[1]]));
addNode(mk('Global To File', 'n8n-nodes-base.convertToFile', 1.1, WRITE_CONVERT, [RESTORE_POS[0] + 340, RESTORE_POS[1]]));
addNode(mk('Save Global File', 'n8n-nodes-base.readWriteFile', 1.1, WRITE_RW(GLOBAL_FILE), [RESTORE_POS[0] + 510, RESTORE_POS[1]]));
out('Restore Apply Row For Save', 'Stage Global Write');
out('Stage Global Write', 'Global To File');
out('Global To File', 'Save Global File');
out('Save Global File', 'Send Apply Confirm');

// ───────────────────────────────────────────────────────────────────────────
// 5) CANCEL: Route Callback Action#1 -> Send Cancel Confirm (drop Delete Pending After Cancel)
//    preserve #0 (Prep Apply Body) and #2 (Send Redo Placeholder)
// ───────────────────────────────────────────────────────────────────────────
removeNode('Delete Pending After Cancel');
out('Route Callback Action', 'Prep Apply Body', 0);
out('Route Callback Action', 'Send Cancel Confirm', 1);
out('Route Callback Action', 'Send Redo Placeholder', 2);

// ───────────────────────────────────────────────────────────────────────────
// 6) LOAD SKELETONS: drop fs; inline the four .tex templates.
// ───────────────────────────────────────────────────────────────────────────
const tpl = (f) => fs.readFileSync(path.join(ROOT, 'templates', f), 'utf8');
const SK = { fresher: tpl('resume_skeleton_fresher.tex'), experienced: tpl('resume_skeleton_experienced.tex'), senior: tpl('resume_skeleton_senior.tex') };
const COVER = tpl('cover_skeleton.tex');
N['Load Skeletons'].parameters.jsCode = [
  "// Localized: skeleton templates inlined (no fs).",
  "let ctx = {};",
  "try { ctx = $('Select Relevant Resume Bubbles').first().json; } catch (e) { ctx = $('Parse Personal Info').first().json; }",
  "const seniorityOutput = $input.first().json.output || { mode: 'experienced' };",
  "const mode = seniorityOutput.mode || 'experienced';",
  "const SKELETONS = " + JSON.stringify(SK) + ";",
  "const COVER = " + JSON.stringify(COVER) + ";",
  "const resumeSkeleton = SKELETONS[mode] || SKELETONS.experienced || '';",
  "const coverSkeleton = COVER || '';",
  "return [{ json: {",
  "  ...ctx,",
  "  seniority_mode: mode,",
  "  total_years_experience: seniorityOutput.total_years_experience || seniorityOutput.candidate_yoe || 0,",
  "  resume_skeleton: resumeSkeleton,",
  "  cover_skeleton: coverSkeleton,",
  "  fit_strategy: seniorityOutput.fit_strategy || 'perfect_fit',",
  "  candidate_yoe: seniorityOutput.candidate_yoe || seniorityOutput.total_years_experience || 0,",
  "  jd_required_min: seniorityOutput.jd_required_min ?? null,",
  "  jd_required_max: seniorityOutput.jd_required_max ?? null,",
  "  jd_seniority: seniorityOutput.jd_seniority || 'unknown'",
  "} }];",
].join('\n');

// ───────────────────────────────────────────────────────────────────────────
// 7) PARSE PERSONAL INFO: remove the dead require('fs') legacy-file fallback block.
// ───────────────────────────────────────────────────────────────────────────
{
  const ppi = N['Parse Personal Info'];
  let code = ppi.parameters.jsCode;
  const re = /if \(!resumeText\) \{\s*let fs = null;[\s\S]*?if \(resumeText\) personal = parsePersonalFromText\(resumeText\);\s*\}/;
  if (!re.test(code)) throw new Error('Parse Personal Info fs block not found — aborting (pattern drift).');
  code = code.replace(re, '// [localized] fs legacy-file fallback removed — resume comes from resume_structured.json');
  if (/require\(['"]fs['"]\)/.test(code)) throw new Error('Parse Personal Info still references fs after strip.');
  ppi.parameters.jsCode = code;
}

// ───────────────────────────────────────────────────────────────────────────
// 8) MODEL PARAMS: strip temperature from the two gpt-5.4-mini nodes that set it.
// ───────────────────────────────────────────────────────────────────────────
for (const mn of ['OpenRouter Chat Model', 'OpenRouter Chat Model12']) {
  const n = N[mn];
  if (n && n.parameters && n.parameters.options && 'temperature' in n.parameters.options) {
    delete n.parameters.options.temperature;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 8.5) REBIND CREDENTIALS to this LOCAL n8n instance's credential ids (by type).
//      The imported v6.3 nodes reference cloud credential ids that don't exist
//      locally, so the trigger can't activate -> no webhook. Rebinding by type
//      resolves all 60+ nodes at once (re-import the JSON; no per-node clicking).
//      NOTE: these ids are specific to this local n8n instance.
// ───────────────────────────────────────────────────────────────────────────
const CRED_MAP = {
  telegramApi:    { id: 'PNR29RagTwMTSv2S', name: 'Telegram account' },
  openRouterApi:  { id: 'xZD1i4ZBmSxVDuIe', name: 'OpenRouter account' },
  firecrawlApi:   { id: 'sTMgw2RCqCvdZKyw', name: 'Firecrawl account' },
  youDotComApi:   { id: 's2UBYXUFAom4193K', name: 'You.com account' },
  httpHeaderAuth: { id: 'aaGlxQQAKSikN3Te', name: 'Serper API' },
  postgres:       { id: '5pQq6UUmmGU7e04S', name: 'CareerForge Postgres' },
};
let rebinds = 0;
for (const n of nodes) {
  if (!n.credentials) continue;
  for (const type of Object.keys(n.credentials)) {
    if (CRED_MAP[type]) { n.credentials[type] = { ...CRED_MAP[type] }; rebinds++; }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 8.7) JSON-TEMPLATE RESUME INGESTION (deterministic, no-LLM, no text parser).
//      Replaces the brittle text parser + PDF/DOCX extraction with:
//      read file/paste -> JSON.parse -> validate -> assemble resume_doc.
//      Non-JSON (or no resume) -> the onboarding "fill this template" message.
// ───────────────────────────────────────────────────────────────────────────
const readUploadedCode = fs.readFileSync(path.join(ROOT, 'scripts', 'nodes', 'read_uploaded_file.js'), 'utf8');
const ingestCode = fs.readFileSync(path.join(ROOT, 'scripts', 'nodes', 'ingest_resume_json.js'), 'utf8');
const templateJson = fs.readFileSync(path.join(ROOT, 'scripts', 'resume_template.json'), 'utf8').trim();

// Clone a working telegram sendMessage node (already credential-rebound above) for valid structure.
const tgClone = JSON.parse(JSON.stringify(N['Send Setup Prompt'] || N['Send Resume Setup Error']));
const PRB = N['Prepare Resume Bubbles'] ? N['Prepare Resume Bubbles'].position : [23856, 43568];

['IF: Resume Is PDF?', 'Extract Resume PDF Text', 'IF: Resume Is DOCX?', 'Mark DOCX As ZIP',
 'Decompress DOCX Zip', 'Extract DOCX Text From XML', 'Extract Resume Text', 'Prepare Resume Bubbles',
 'Send Setup Prompt', 'Send Resume Parse Error'].forEach(removeNode);

addNode(mk('Read Uploaded File', 'n8n-nodes-base.code', 2, { jsCode: readUploadedCode }, [PRB[0] - 360, PRB[1]]));
addNode(mk('Ingest Resume JSON', 'n8n-nodes-base.code', 2, { jsCode: ingestCode }, [PRB[0], PRB[1]]));

const tplMsg = [
  '🗂️ <b>I need your résumé as JSON (one-time setup)</b>',
  '',
  'I read résumés from a fixed JSON template — deterministic, private, and reliable (no AI guessing in the loop).',
  '',
  '<b>How:</b>',
  '1️⃣ Copy the block below.',
  '2️⃣ Paste it into ChatGPT / Claude, then paste your résumé under it.',
  '3️⃣ Send the filled JSON back to me — as a <b>.json file</b> (best for long résumés) or pasted text.',
  '',
  '<pre>You are filling a résumé JSON template. Copy facts VERBATIM from the résumé below — never invent, embellish, or drop anything. Keep every job, project, and bullet. Use "YYYY-MM" (or "YYYY") for dates and "Present" for current roles. Output ONLY the filled JSON.',
  '',
  'TEMPLATE:',
  templateJson,
  '',
  'RÉSUMÉ:',
  '(paste your résumé here)</pre>'
].join('\n');

tgClone.name = 'Send Resume Template';
tgClone.id = uid();
tgClone.position = [PRB[0] + 220, PRB[1] + 220];
tgClone.parameters = { ...(tgClone.parameters || {}), chatId: '={{ $json.chat_id }}', text: tplMsg,
  additionalFields: { appendAttribution: false, parse_mode: 'HTML', disable_web_page_preview: true } };
addNode(tgClone);

if (N['Send Setup Ack']) N['Send Setup Ack'].parameters.text = '📄 Got your file — reading it now…';

// Universal template-first: every "no résumé" gate funnels the user to the JSON template.
for (const nm of ['Send Resume Missing For Scoring', 'Send Resume Setup Error']) {
  if (N[nm]) {
    N[nm].parameters.text = tplMsg;
    N[nm].parameters.additionalFields = { ...(N[nm].parameters.additionalFields || {}), parse_mode: 'HTML', disable_web_page_preview: true };
  }
}
// check_resume "no résumé" message -> point to the JSON template (Markdown-safe).
if (N['Format Resume Status']) {
  N['Format Resume Status'].parameters.jsCode = N['Format Resume Status'].parameters.jsCode
    .replace('Send your resume as pasted text or upload a PDF/DOCX/TXT, then tap',
             'Send /setup to get the JSON template, fill it with your résumé, send it back, then tap');
}

// rewire setup flow
out('Download Resume File', 'Read Uploaded File');
out('Read Uploaded File', 'Ingest Resume JSON');
out('Ingest Resume JSON', 'IF: Resume Parse OK?');
out('IF: Resume Parse OK?', 'Build Bubble Preview', 0);
out('IF: Resume Parse OK?', 'Send Resume Template', 1);
out('IF: Resume Pasted?', 'Ingest Resume JSON', 0);
out('IF: Resume Pasted?', 'Send Resume Template', 1);

// also treat any JSON-looking paste as a resume submission (not just >800 chars)
if (N['Detect Setup Sub-Intent']) {
  N['Detect Setup Sub-Intent'].parameters.jsCode = N['Detect Setup Sub-Intent'].parameters.jsCode
    .replace('const looksLikeResume = text.length > 800;', 'const looksLikeResume = text.length > 800 || /^\\s*\\{/.test(text);');
}

// ───────────────────────────────────────────────────────────────────────────
// 8.8) RÉSUMÉ-FIRST GATE: require a résumé before find_jobs runs the search.
//      Route Intent #1 (find_jobs) -> read résumé -> IF present: search, else: template.
//      (Prep Expand Input reads via $('Extract Input')+staticData, so the gate is non-intrusive.)
// ───────────────────────────────────────────────────────────────────────────
const PEI = N['Prep Expand Input'].position;
const GATE_CHECK = [
  'let has = false;',
  "try { const buf = await this.helpers.getBinaryDataBuffer(0, 'data'); if (buf && buf.length) { const d = JSON.parse(buf.toString('utf8')); has = !!(d && d.personal && d.personal.name && Array.isArray(d.experience) && d.experience.length); } } catch (e) {}",
  'let ctx = {};',
  "try { ctx = $('Extract Input').first().json || {}; } catch (e) {}",
  'return [{ json: { ...ctx, _has_resume: has } }];'
].join('\n');
addNode(mk('Gate Read Resume', 'n8n-nodes-base.readWriteFile', 1.1, READ_RW(GLOBAL_FILE), [PEI[0] - 540, PEI[1] + 40], CONTINUE));
addNode(mk('Gate Has Resume', 'n8n-nodes-base.code', 2, { jsCode: GATE_CHECK }, [PEI[0] - 380, PEI[1] + 40]));
const ifGate = JSON.parse(JSON.stringify(N['IF: Resume Parse OK?']));
ifGate.name = 'IF: Resume For Search?';
ifGate.id = uid();
ifGate.position = [PEI[0] - 210, PEI[1] + 40];
ifGate.parameters.conditions.conditions = [{ id: uid(), leftValue: '={{ $json._has_resume }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }];
addNode(ifGate);
out('Route Intent', 'Gate Read Resume', 1);          // find_jobs branch
out('Gate Read Resume', 'Gate Has Resume');
out('Gate Has Resume', 'IF: Resume For Search?');
out('IF: Resume For Search?', 'Prep Expand Input', 0);
out('IF: Resume For Search?', 'Send Resume Template', 1);

// ───────────────────────────────────────────────────────────────────────────
// 9) META + cleanup
// ───────────────────────────────────────────────────────────────────────────
wf.name = 'CareerForge Master — Local v6.3';
wf.active = false;
delete wf.id;             // let n8n assign on import
wf.pinData = {};
// strip any lingering supabase credentials
for (const n of nodes) { if (n.credentials && n.credentials.supabaseApi) delete n.credentials.supabaseApi; }

// ───────────────────────────────────────────────────────────────────────────
// VALIDATION
// ───────────────────────────────────────────────────────────────────────────
const problems = [];
const names = new Set(nodes.map(n => n.name));
// no supabase nodes
for (const n of nodes) if (n.type.includes('supabase')) problems.push('supabase node remains: ' + n.name);
// no fs in any code node
for (const n of nodes) { const p = JSON.stringify(n.parameters || {}); if (/require\(\\?['"]fs['"]\)/.test(p)) problems.push('fs reference remains: ' + n.name); }
// no temperature on gpt-5.4 model nodes
for (const n of nodes) {
  if (n.type.includes('lmChatOpenRouter')) {
    const model = n.parameters && n.parameters.model;
    const temp = n.parameters && n.parameters.options && n.parameters.options.temperature;
    if (typeof model === 'string' && model.includes('gpt-5.4') && temp !== undefined) problems.push('gpt-5.4 temperature remains: ' + n.name);
  }
}
// connection integrity: every referenced node exists
for (const src in conns) {
  if (!names.has(src)) problems.push('connection from missing node: ' + src);
  for (const t in conns[src]) for (const br of conns[src][t]) if (br) for (const c of br) if (!names.has(c.node)) problems.push('connection to missing node: ' + src + ' -> ' + c.node);
}
// removed nodes truly gone
for (const dead of ['Apply Resume', 'Save Pending Resume', 'Delete Pending After Apply', 'Delete Pending After Cancel', 'Delete Existing Global Resume', 'Delete Existing Pending Resume', 'Restore Pending Row For Save']) {
  if (names.has(dead)) problems.push('node should be removed: ' + dead);
}
// every credential reference points at a known LOCAL credential id
const localIds = new Set(Object.values(CRED_MAP).map(c => c.id));
const foreignCreds = {};
for (const n of nodes) {
  if (!n.credentials) continue;
  for (const [type, c] of Object.entries(n.credentials)) {
    if (!localIds.has(c.id)) { (foreignCreds[`${type}:${c.id}`] = foreignCreds[`${type}:${c.id}`] || []).push(n.name); }
  }
}
for (const k of Object.keys(foreignCreds)) problems.push('unbound/foreign credential ' + k + ' on ' + foreignCreds[k].length + ' node(s)');

const credCounts = {};
for (const n of nodes) if (n.credentials) for (const t of Object.keys(n.credentials)) credCounts[t] = (credCounts[t] || 0) + 1;
const summary = {
  name: wf.name, active: wf.active, nodeCount: nodes.length,
  supabaseNodes: nodes.filter(n => n.type.includes('supabase')).length,
  newFileNodes: nodes.filter(n => /readWriteFile|extractFromFile|convertToFile/.test(n.type)).map(n => n.name),
  credentialRebinds: rebinds,
  credentialRefsByType: credCounts,
  problems,
};
console.log(JSON.stringify(summary, null, 2));
if (problems.length) { console.error('\nVALIDATION FAILED — not writing output.'); process.exit(1); }

fs.writeFileSync(OUT1, JSON.stringify(wf, null, 2));
fs.writeFileSync(OUT2, JSON.stringify(wf, null, 2));
console.log('\nWrote:\n  ' + OUT1 + '\n  ' + OUT2);
