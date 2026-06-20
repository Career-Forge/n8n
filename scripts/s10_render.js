/**
 * s10_render.js — Sprint 1: deterministic resume render (LLM emits TEXT only).
 *
 * Updates the Pass-2 lane + its ATS-regen twin so the LLM never emits LaTeX:
 *  - Assemble Resume LaTeX + Assemble Regen   -> new deterministic assembler jsCode
 *  - Pass2 Generate + Pass2 Regen             -> new text-only system prompt
 *  - Build Pass2 Input + Build Pass2 Regen Input -> updated instruction jsCode
 * Writes all 3 master copies. Run: node scripts/s10_render.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const ASSEMBLE = fs.readFileSync(path.join(__dirname, 'nodes', 'assemble_resume_latex.js'), 'utf8');
const PASS2_INPUT = fs.readFileSync(path.join(__dirname, 'nodes', 'build_pass2_input.js'), 'utf8');
const PASS2_REGEN_INPUT = fs.readFileSync(path.join(__dirname, 'nodes', 'build_pass2_regen_input.js'), 'utf8');
const PASS2_PROMPT = fs.readFileSync(path.join(ROOT, 'prompts', 'Pass2_Resume.md'), 'utf8');

// parse-check every Code body before deploying
for (const [name, code] of [['assemble', ASSEMBLE], ['pass2_input', PASS2_INPUT], ['pass2_regen_input', PASS2_REGEN_INPUT]]) {
  try { new Function('$input', '$', code); } catch (e) { console.error('PARSE FAIL ' + name + ': ' + e.message); process.exit(1); }
}

const CODE_NODES = {
  'Assemble Resume LaTeX': ASSEMBLE,
  'Assemble Regen': ASSEMBLE,
  'Build Pass2 Input': PASS2_INPUT,
  'Build Pass2 Regen Input': PASS2_REGEN_INPUT,
};
const PROMPT_NODES = ['Pass2 Generate', 'Pass2 Regen'];

function setSystemMessage(node, msg) {
  node.parameters = node.parameters || {};
  const opt = node.parameters;
  opt.messages = opt.messages || {};
  if (!Array.isArray(opt.messages.messageValues) || !opt.messages.messageValues.length) {
    opt.messages.messageValues = [{ message: msg }];
  } else {
    opt.messages.messageValues[0].message = msg;
  }
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + file); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  const touched = [];

  for (const [name, code] of Object.entries(CODE_NODES)) {
    if (!N[name]) { console.log('  ' + base + ': MISSING node "' + name + '"'); continue; }
    N[name].parameters = N[name].parameters || {};
    N[name].parameters.jsCode = code;
    touched.push(name);
  }
  for (const name of PROMPT_NODES) {
    if (!N[name]) { console.log('  ' + base + ': MISSING node "' + name + '"'); continue; }
    setSystemMessage(N[name], PASS2_PROMPT);
    touched.push(name);
  }

  // integrity: all connection targets still exist (no structural change, but verify)
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': patched ' + touched.length + ' nodes [' + touched.join(', ') + ']');
}

TARGETS.forEach(patch);
console.log('S10 render patch complete.');
