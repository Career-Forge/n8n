/**
 * s6b4_ats.js — S6b-4: ATS scoring + bounded auto-improve loop.
 *
 * Restructure (no graph cycle, no double-send): the first assembly now flows THROUGH
 * scoring before compiling, and a low score triggers exactly one Pass-2 regeneration.
 *
 *   Assemble Resume LaTeX[b0] -> Extract ATS Signals(deepseek) -> Validate ATS Signals
 *     -> Calculate ATS Score ->(parallel) Send ATS Summary
 *                            -> IF: ATS Low? (overall_score < 70)
 *         true  -> Build Pass2 Regen Input -> Pass2 Regen(sonnet) -> Parse Pass2 Regen
 *                  -> Assemble Regen[b0] -> Pick Resume LaTeX
 *         false -> Pick Resume LaTeX
 *   Pick Resume LaTeX -> Compile Resume PDF -> Send Resume PDF (unchanged)
 *
 * Scoring runs ONCE on the first assembly, so the retry is naturally bounded (the
 * regenerated resume is not re-scored). Pick Resume LaTeX converges the ok/retry
 * branches (only one fires) so a single Compile/Send happens. The regen reuses the
 * existing Pass-1 selection + Step-0 (one extra LLM, not three). Assemble Regen and
 * Pass2 Regen duplicate their originals but load from the same source files.
 * All ATS nodes are graceful (onError) so a scoring failure never blocks the PDF.
 * Run: node scripts/s6b4_ats.js
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
const PARSE = readNode('_parseJSON_snippet.js');

const PROMPT_ATS = readPrompt('ATS_Extraction.md');
const PROMPT_PASS2 = readPrompt('Pass2_Resume.md');
const CODE_VALIDATE = PARSE + '\n' + readNode('validate_ats_signals.js');
const CODE_CALC = readNode('calculate_ats_score.js');
const CODE_REGEN_INPUT = readNode('build_pass2_regen_input.js');
const CODE_PICK = readNode('pick_resume_latex.js');
const CODE_ASSEMBLE = readNode('assemble_resume_latex.js');
const CODE_PARSE_REGEN = PARSE + "\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);const pass1=($('Build Pass2 Regen Input').first().json||{}).pass1||{};return [{json:{pass1:pass1,pass2:parseJSON(raw)}}];";

for (const [nm, code] of Object.entries({ CODE_VALIDATE, CODE_CALC, CODE_REGEN_INPUT, CODE_PICK, CODE_ASSEMBLE, CODE_PARSE_REGEN })) {
  try { new Function('$input', '$', code); } catch (e) { console.error(`PARSE FAIL ${nm}: ${e.message}`); process.exit(1); }
}

const codeNode = (name, code, pos, onError) => {
  const n = { parameters: { jsCode: code }, id: crypto.randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos };
  if (onError) { n.onError = onError; n.alwaysOutputData = true; }
  return n;
};
const llmNode = (name, system, textExpr, pos) => ({
  parameters: { promptType: 'define', text: textExpr, hasOutputParser: false, messages: { messageValues: [{ message: system }] } },
  id: crypto.randomUUID(), name, type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4, position: pos,
});
const modelNode = (name, model, options, pos) => ({
  parameters: { model, options: options || {} }, id: crypto.randomUUID(), name, type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1, position: pos, credentials: OR_CRED,
});

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);

  if (!N['Assemble Resume LaTeX'] || !N['Compile Resume PDF']) { console.error(`  ${base}: prerequisites missing`); process.exit(1); }
  if (N['Calculate ATS Score']) { console.log(`  ${base}: already patched — skipping`); return; }

  let [bx, by] = N['Assemble Resume LaTeX'].position; by += 320;
  const col = (i, dy) => [bx + i * 230, by + (dy || 0)];

  // ── nodes ──
  wf.nodes.push(llmNode('Extract ATS Signals', PROMPT_ATS,
    "={{ 'RESUME:\\n' + ($('Assemble Resume LaTeX').first().json.resumePlainText || '') + '\\n\\nJOB DESCRIPTION:\\n' + ($('Prepare Job Context').first().json.job_description || 'No JD provided.') }}", col(0)));
  wf.nodes.push(modelNode('Extract ATS Model', 'deepseek/deepseek-v4-flash', { maxTokens: 3000, timeout: 90000 }, col(0, 160)));
  wf.nodes.push(codeNode('Validate ATS Signals', CODE_VALIDATE, col(1), 'continueRegularOutput'));
  wf.nodes.push(codeNode('Calculate ATS Score', CODE_CALC, col(2), 'continueRegularOutput'));
  wf.nodes.push({
    parameters: { chatId: "={{ $('Prepare Apply Context').first().json.chat_id }}", text: '={{ $json.summary_text }}', additionalFields: { appendAttribution: false, parse_mode: 'Markdown' } },
    id: crypto.randomUUID(), name: 'Send ATS Summary', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: col(3, 160), onError: 'continueRegularOutput',
  });
  wf.nodes.push({
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [{ leftValue: '={{ $json.ats.overall_score }}', rightValue: 70, operator: { type: 'number', operation: 'lt' } }], combinator: 'and' }, options: {} },
    id: crypto.randomUUID(), name: 'IF: ATS Low?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: col(3),
  });
  wf.nodes.push(codeNode('Build Pass2 Regen Input', CODE_REGEN_INPUT, col(4)));
  wf.nodes.push(llmNode('Pass2 Regen', PROMPT_PASS2, "={{ $('Build Pass2 Regen Input').first().json.pass2_user }}", col(5)));
  wf.nodes.push(modelNode('Pass2 Regen Model', 'anthropic/claude-sonnet-4.6', { maxTokens: 8000, temperature: 0.3, timeout: 120000 }, col(5, 160)));
  wf.nodes.push(codeNode('Parse Pass2 Regen', CODE_PARSE_REGEN, col(6)));
  wf.nodes.push(codeNode('Assemble Regen', CODE_ASSEMBLE, col(7), 'continueErrorOutput'));
  wf.nodes.push(codeNode('Pick Resume LaTeX', CODE_PICK, col(8)));

  // ── ai_languageModel ──
  C['Extract ATS Model'] = { ai_languageModel: [[{ node: 'Extract ATS Signals', type: 'ai_languageModel', index: 0 }]] };
  C['Pass2 Regen Model'] = { ai_languageModel: [[{ node: 'Pass2 Regen', type: 'ai_languageModel', index: 0 }]] };

  // ── rewire: Assemble[b0] no longer -> Compile; -> Extract ATS Signals (keep b1 error) ──
  const asmMain = C['Assemble Resume LaTeX'].main || [[], []];
  C['Assemble Resume LaTeX'] = { main: [
    [{ node: 'Extract ATS Signals', type: 'main', index: 0 }],
    (asmMain[1] || [{ node: 'Send Apply Build Error', type: 'main', index: 0 }]),
  ] };

  // ── ATS chain ──
  C['Extract ATS Signals'] = { main: [[{ node: 'Validate ATS Signals', type: 'main', index: 0 }]] };
  C['Validate ATS Signals'] = { main: [[{ node: 'Calculate ATS Score', type: 'main', index: 0 }]] };
  C['Calculate ATS Score'] = { main: [[
    { node: 'IF: ATS Low?', type: 'main', index: 0 },
    { node: 'Send ATS Summary', type: 'main', index: 0 },
  ]] };
  // IF true (low) -> regen ; IF false (ok) -> pick
  C['IF: ATS Low?'] = { main: [
    [{ node: 'Build Pass2 Regen Input', type: 'main', index: 0 }],
    [{ node: 'Pick Resume LaTeX', type: 'main', index: 0 }],
  ] };
  C['Build Pass2 Regen Input'] = { main: [[{ node: 'Pass2 Regen', type: 'main', index: 0 }]] };
  C['Pass2 Regen'] = { main: [[{ node: 'Parse Pass2 Regen', type: 'main', index: 0 }]] };
  C['Parse Pass2 Regen'] = { main: [[{ node: 'Assemble Regen', type: 'main', index: 0 }]] };
  C['Assemble Regen'] = { main: [
    [{ node: 'Pick Resume LaTeX', type: 'main', index: 0 }],
    [{ node: 'Send Apply Build Error', type: 'main', index: 0 }],
  ] };
  C['Pick Resume LaTeX'] = { main: [[{ node: 'Compile Resume PDF', type: 'main', index: 0 }]] };

  // ── integrity ──
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S6b-4 ATS lane + regen loop wired (${wf.nodes.length} nodes)`);
}

TARGETS.forEach(patch);
console.log('S6b-4 patch complete.');
