/**
 * s6c_cover.js — S6c: cover 2-phase (replaces single-phase CoverForge) + fix the
 * Save Apply Context ResumeForge reference that S6b-2 left dangling.
 *
 *   Pass Dossier -> (fan) Build Pass1 Context [resume]  +  Cover Pass1 [cover]
 *   Cover Pass1 (haiku, PASS1_COVER) -> Parse Cover Pass1 -> Cover Pass2 (haiku, bot
 *     {title,salutation,hook,bullets,cta,word_count} shape) -> Parse Cover Pass2
 *     -> Save Apply Context -> Build Cover LaTeX (unchanged) -> Compile Cover PDF -> Send.
 *
 * Cover Pass2 emits the EXACT shape Build Cover LaTeX already consumes, so the LaTeX
 * builder + compile + send are untouched. The cover now hangs off Pass Dossier (gets
 * the researched values/mission), not the gate. CoverForge + its parser + model deleted.
 * No structured parsers (raw -> parseJSON). Word-count guidance is in the Pass2 prompt
 * (flag-only enforcement deferred). Run: node scripts/s6c_cover.js
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

const PROMPT_COVER1 = readPrompt('Cover_Pass1.md');
const PROMPT_COVER2 = readPrompt('Cover_Pass2.md');
const CODE_SAVE = readNode('save_apply_context.js');
const CODE_PARSE_C1 = PARSE + "\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);return [{json:{cover1:parseJSON(raw)}}];";
const CODE_PARSE_C2 = PARSE + "\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);return [{json:parseJSON(raw)}];";

for (const [nm, code] of Object.entries({ CODE_SAVE, CODE_PARSE_C1, CODE_PARSE_C2 })) {
  try { new Function('$input', '$', code); } catch (e) { console.error(`PARSE FAIL ${nm}: ${e.message}`); process.exit(1); }
}

const codeNode = (name, code, pos) => ({ parameters: { jsCode: code }, id: crypto.randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos });
const llmNode = (name, system, textExpr, pos) => ({
  parameters: { promptType: 'define', text: textExpr, hasOutputParser: false, messages: { messageValues: [{ message: system }] } },
  id: crypto.randomUUID(), name, type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4, position: pos,
});
const modelNode = (name, model, options, pos) => ({ parameters: { model, options: options || {} }, id: crypto.randomUUID(), name, type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1, position: pos, credentials: OR_CRED });

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);

  if (!N['Pass Dossier'] || !N['Build Cover LaTeX'] || !N['Save Apply Context']) { console.error(`  ${base}: prerequisites missing`); process.exit(1); }
  if (N['Cover Pass1']) { console.log(`  ${base}: already patched — skipping`); return; }

  // fix Save Apply Context (drop deleted ResumeForge ref)
  N['Save Apply Context'].parameters.jsCode = CODE_SAVE;

  let [bx, by] = N['Build Cover LaTeX'].position; bx -= 1200; by += 200;
  const col = (i, dy) => [bx + i * 230, by + (dy || 0)];

  const c1Text = "={{ JSON.stringify({ resume: $('Prepare Apply Context').first().json.resume_text, jd: $('Prepare Apply Context').first().json.job_description, company: $('Prepare Apply Context').first().json.company, dossier: ($('Pass Dossier').first().json||{}).dossier, tier: $('Prepare Apply Context').first().json.seniority_mode }) }}";
  const c2Text = "={{ JSON.stringify({ selection: $('Parse Cover Pass1').first().json.cover1, jd: $('Prepare Apply Context').first().json.job_description, company: $('Prepare Apply Context').first().json.company }) }}";

  wf.nodes.push(llmNode('Cover Pass1', PROMPT_COVER1, c1Text, col(0)));
  wf.nodes.push(modelNode('Cover Pass1 Model', 'anthropic/claude-haiku-4.5', { maxTokens: 6000, temperature: 0.3, timeout: 120000 }, col(0, 160)));
  wf.nodes.push(codeNode('Parse Cover Pass1', CODE_PARSE_C1, col(1)));
  wf.nodes.push(llmNode('Cover Pass2', PROMPT_COVER2, c2Text, col(2)));
  wf.nodes.push(modelNode('Cover Pass2 Model', 'anthropic/claude-haiku-4.5', { maxTokens: 4000, temperature: 0.3, timeout: 120000 }, col(2, 160)));
  wf.nodes.push(codeNode('Parse Cover Pass2', CODE_PARSE_C2, col(3)));

  // ai_languageModel
  C['Cover Pass1 Model'] = { ai_languageModel: [[{ node: 'Cover Pass1', type: 'ai_languageModel', index: 0 }]] };
  C['Cover Pass2 Model'] = { ai_languageModel: [[{ node: 'Cover Pass2', type: 'ai_languageModel', index: 0 }]] };

  // Pass Dossier -> [Build Pass1 Context, Cover Pass1]
  const pd = (C['Pass Dossier'] && C['Pass Dossier'].main && C['Pass Dossier'].main[0]) || [{ node: 'Build Pass1 Context', type: 'main', index: 0 }];
  if (!pd.some((e) => e.node === 'Cover Pass1')) pd.push({ node: 'Cover Pass1', type: 'main', index: 0 });
  C['Pass Dossier'] = { main: [pd] };

  // remove CoverForge from the gate branches
  const dropFromBranch = (srcName, branchIdx) => {
    const obj = C[srcName]; if (!obj || !obj.main || !obj.main[branchIdx]) return;
    obj.main[branchIdx] = obj.main[branchIdx].filter((e) => e.node !== 'CoverForge');
  };
  dropFromBranch('IF: Keyword Gaps?', 1);
  dropFromBranch('Send Gap Warning', 0);

  // cover chain
  C['Cover Pass1'] = { main: [[{ node: 'Parse Cover Pass1', type: 'main', index: 0 }]] };
  C['Parse Cover Pass1'] = { main: [[{ node: 'Cover Pass2', type: 'main', index: 0 }]] };
  C['Cover Pass2'] = { main: [[{ node: 'Parse Cover Pass2', type: 'main', index: 0 }]] };
  C['Parse Cover Pass2'] = { main: [[{ node: 'Save Apply Context', type: 'main', index: 0 }]] };
  // Save Apply Context -> Build Cover LaTeX already exists (unchanged)

  // delete CoverForge stack
  const drop = new Set(['CoverForge', 'Cover Output Parser', 'OpenRouter Chat Model7']);
  wf.nodes = wf.nodes.filter((n) => !drop.has(n.name));
  for (const d of drop) delete C[d];

  // integrity
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${src} -> ${e.node}`); process.exit(1); }
        if (drop.has(e.node)) { console.error(`INTEGRITY FAIL ${src} -> dropped ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S6c cover two-phase wired (${wf.nodes.length} nodes)`);
}

TARGETS.forEach(patch);
console.log('S6c patch complete.');
