/**
 * s11_cover_company.js — Sprint 2: cover-letter dash fix + company-name hardening.
 *  - Cover Pass2          -> new system prompt (forbid cramped en/em-dashes)
 *  - Build Cover LaTeX     -> spacing-aware dash normalize ("Scale--Applied" -> " -- ")
 *  - Build Telegraph Body  -> cleanCompany() backstop (kills "Https://Visa")
 * Writes all 3 masters. Run: node scripts/s11_cover_company.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const COVER_LATEX = fs.readFileSync(path.join(__dirname, 'nodes', 'build_cover_latex.js'), 'utf8');
const TELEGRAPH = fs.readFileSync(path.join(__dirname, 'nodes', 'build_telegraph_body.js'), 'utf8');
const COVER_PROMPT = fs.readFileSync(path.join(ROOT, 'prompts', 'Cover_Pass2.md'), 'utf8');

for (const [name, code] of [['build_cover_latex', COVER_LATEX], ['build_telegraph_body', TELEGRAPH]]) {
  try { new Function('$input', '$', '$getWorkflowStaticData', code); } catch (e) { console.error('PARSE FAIL ' + name + ': ' + e.message); process.exit(1); }
}

const CODE_NODES = { 'Build Cover LaTeX': COVER_LATEX, 'Build Telegraph Body': TELEGRAPH };
const PROMPT_NODES = ['Cover Pass2'];

function setSystemMessage(node, msg) {
  node.parameters = node.parameters || {};
  const opt = node.parameters;
  opt.messages = opt.messages || {};
  if (!Array.isArray(opt.messages.messageValues) || !opt.messages.messageValues.length) opt.messages.messageValues = [{ message: msg }];
  else opt.messages.messageValues[0].message = msg;
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
    N[name].parameters.jsCode = code; touched.push(name);
  }
  for (const name of PROMPT_NODES) {
    if (!N[name]) { console.log('  ' + base + ': MISSING node "' + name + '"'); continue; }
    setSystemMessage(N[name], COVER_PROMPT); touched.push(name);
  }
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => { if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); } }));
    }
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': patched [' + touched.join(', ') + ']');
}

TARGETS.forEach(patch);
console.log('S11 patch complete.');
