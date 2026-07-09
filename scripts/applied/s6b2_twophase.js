/**
 * s6b2_twophase.js — S6b-2: replace single-phase ResumeForge with the 2-phase
 * select->generate pipeline, and wire the S6b-1 Assemble node live.
 *
 * New chain (sequential — Pass1 doesn't depend on Step0; Step0 is a small fast
 * deepseek call, so sequential avoids a Merge-barrier double-execution risk):
 *   Build Pass1 Context -> Pass1 Selection(haiku) -> Parse Pass1
 *     -> Step0 JD Analysis(deepseek) -> Parse Step0
 *     -> Build Pass2 Input -> Pass2 Generate(sonnet-4.6) -> Parse Pass2
 *     -> Assemble Resume LaTeX -> Compile Resume PDF (b1 -> Send Apply Build Error)
 *
 * The LLM nodes have NO structured output parser (raw text -> ported parseJSON in
 * the Parse* nodes) — the S2b lesson: strict parsers choke on LaTeX-heavy JSON.
 * Pass1 reuses SeniorityDetector.mode + ForgeScore gaps (already merged into
 * Prepare Apply Context). Validate Resume Sections / Build Resume LaTeX are left
 * orphaned (the old {sections} shape is gone; Assemble has its own empty-body throw).
 *
 * Harness: scripts/_harness_s6b2.js (full chain + parseJSON torture + live compile).
 * Run: node scripts/s6b2_twophase.js
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
const OR_CRED = { openRouterApi: { id: 'xZD1i4ZBmSxVDuIe', name: 'OpenRouter account' } };

const readNode = (f) => fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8');
const readPrompt = (f) => fs.readFileSync(path.join(ROOT, 'prompts', f), 'utf8').replace(/\r\n/g, '\n');

const PROMPT_STEP0 = readPrompt('Step0_JD.md');
const PROMPT_PASS1 = readPrompt('Pass1_Resume.md');
const PROMPT_PASS2 = readPrompt('Pass2_Resume.md');
const CODE_BUILD_P1 = readNode('build_pass1_context.js');
const CODE_BUILD_P2 = readNode('build_pass2_input.js');
const PARSE = readNode('_parseJSON_snippet.js');
const CODE_PARSE_P1 = PARSE + "\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);return [{json:{pass1:parseJSON(raw)}}];";
const CODE_PARSE_S0 = PARSE + "\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);return [{json:{step0:parseJSON(raw)}}];";
const CODE_PARSE_P2 = PARSE + "\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);const pass1=($('Build Pass2 Input').first().json||{}).pass1||{};return [{json:{pass1:pass1,pass2:parseJSON(raw)}}];";

// parse-check every Code body up front
for (const [nm, code] of Object.entries({ CODE_BUILD_P1, CODE_BUILD_P2, CODE_PARSE_P1, CODE_PARSE_S0, CODE_PARSE_P2 })) {
  try { new Function('$input', '$', code); } catch (e) { console.error(`PARSE FAIL ${nm}: ${e.message}`); process.exit(1); }
}

function codeNode(name, code, pos, onError) {
  const n = { parameters: { jsCode: code }, id: crypto.randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos };
  if (onError) { n.onError = onError; n.alwaysOutputData = true; }
  return n;
}
function llmNode(name, systemPrompt, textExpr, pos) {
  return {
    parameters: { promptType: 'define', text: textExpr, hasOutputParser: false, messages: { messageValues: [{ message: systemPrompt }] } },
    id: crypto.randomUUID(), name, type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4, position: pos,
  };
}
function modelNode(name, model, options, pos) {
  return { parameters: { model, options: options || {} }, id: crypto.randomUUID(), name, type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1, position: pos, credentials: OR_CRED };
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);

  if (!N['Assemble Resume LaTeX']) { console.error(`  ${base}: Assemble Resume LaTeX missing — run s6b1 first`); process.exit(1); }
  if (N['Pass1 Selection']) { console.log(`  ${base}: already patched (Pass1 Selection exists) — skipping`); return; }

  const anchor = N['ResumeForge'] || N['Assemble Resume LaTeX'];
  let [bx, by] = anchor.position; bx -= 1600;
  const col = (i) => [bx + i * 240, by];
  const mcol = (i) => [bx + i * 240, by + 140];

  // ── add nodes ──
  wf.nodes.push(codeNode('Build Pass1 Context', CODE_BUILD_P1, col(0)));
  wf.nodes.push(llmNode('Pass1 Selection', PROMPT_PASS1, "={{ $('Build Pass1 Context').first().json.pass1_user }}", col(1)));
  wf.nodes.push(modelNode('Pass1 Model', 'anthropic/claude-haiku-4.5', { maxTokens: 8000, temperature: 0.3, timeout: 120000 }, mcol(1)));
  wf.nodes.push(codeNode('Parse Pass1', CODE_PARSE_P1, col(2)));
  wf.nodes.push(llmNode('Step0 JD Analysis', PROMPT_STEP0, "={{ $('Build Pass1 Context').first().json.step0_user }}", col(3)));
  wf.nodes.push(modelNode('Step0 Model', 'deepseek/deepseek-v4-flash', { maxTokens: 2048, timeout: 60000 }, mcol(3)));
  wf.nodes.push(codeNode('Parse Step0', CODE_PARSE_S0, col(4)));
  wf.nodes.push(codeNode('Build Pass2 Input', CODE_BUILD_P2, col(5)));
  wf.nodes.push(llmNode('Pass2 Generate', PROMPT_PASS2, "={{ $('Build Pass2 Input').first().json.pass2_user }}", col(6)));
  wf.nodes.push(modelNode('Pass2 Model', 'anthropic/claude-sonnet-4.6', { maxTokens: 8000, temperature: 0.3, timeout: 120000 }, mcol(6)));
  wf.nodes.push(codeNode('Parse Pass2', CODE_PARSE_P2, col(7)));

  // ── ai_languageModel connections (model -> chainLlm) ──
  C['Pass1 Model'] = { ai_languageModel: [[{ node: 'Pass1 Selection', type: 'ai_languageModel', index: 0 }]] };
  C['Step0 Model'] = { ai_languageModel: [[{ node: 'Step0 JD Analysis', type: 'ai_languageModel', index: 0 }]] };
  C['Pass2 Model'] = { ai_languageModel: [[{ node: 'Pass2 Generate', type: 'ai_languageModel', index: 0 }]] };

  // ── rewire entry: gap-gate ResumeForge target -> Build Pass1 Context (keep CoverForge) ──
  const retarget = (srcName, branchIdx) => {
    const arr = ((C[srcName] || {}).main || [])[branchIdx] || [];
    arr.forEach((e) => { if (e.node === 'ResumeForge') e.node = 'Build Pass1 Context'; });
  };
  retarget('IF: Keyword Gaps?', 1);
  retarget('Send Gap Warning', 0);

  // ── main chain ──
  C['Build Pass1 Context'] = { main: [[{ node: 'Pass1 Selection', type: 'main', index: 0 }]] };
  C['Pass1 Selection'] = { main: [[{ node: 'Parse Pass1', type: 'main', index: 0 }]] };
  C['Parse Pass1'] = { main: [[{ node: 'Step0 JD Analysis', type: 'main', index: 0 }]] };
  C['Step0 JD Analysis'] = { main: [[{ node: 'Parse Step0', type: 'main', index: 0 }]] };
  C['Parse Step0'] = { main: [[{ node: 'Build Pass2 Input', type: 'main', index: 0 }]] };
  C['Build Pass2 Input'] = { main: [[{ node: 'Pass2 Generate', type: 'main', index: 0 }]] };
  C['Pass2 Generate'] = { main: [[{ node: 'Parse Pass2', type: 'main', index: 0 }]] };
  C['Parse Pass2'] = { main: [[{ node: 'Assemble Resume LaTeX', type: 'main', index: 0 }]] };
  // Assemble: success -> Compile Resume PDF, error -> Send Apply Build Error
  C['Assemble Resume LaTeX'] = { main: [
    [{ node: 'Compile Resume PDF', type: 'main', index: 0 }],
    [{ node: 'Send Apply Build Error', type: 'main', index: 0 }],
  ] };

  // ── delete ResumeForge + its parser + its model (and their connection keys) ──
  const drop = new Set(['ResumeForge', 'Resume Output Parser', 'OpenRouter Chat Model6']);
  wf.nodes = wf.nodes.filter((n) => !drop.has(n.name));
  for (const d of drop) delete C[d];

  // ── integrity: every main + ai_* target resolves ──
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    for (const [ctype, branches] of Object.entries(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${src} --[${ctype}]--> ${e.node}`); process.exit(1); }
      }));
    }
  }
  // also ensure nothing still points AT a dropped node
  for (const [src, obj] of Object.entries(C)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (drop.has(e.node)) { console.error(`INTEGRITY FAIL: ${src} still -> dropped ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S6b-2 two-phase wired (${wf.nodes.length} nodes; -3 ResumeForge stack, +11 new)`);
}

TARGETS.forEach(patch);
console.log('S6b-2 patch complete.');
