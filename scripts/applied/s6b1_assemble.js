/**
 * s6b1_assemble.js — S6b-1: add the "Assemble Resume LaTeX" deterministic core.
 *
 * Adds ONE Code node (jsCode loaded verbatim from scripts/nodes/assemble_resume_latex.js)
 * that adopts the command-center SECTION_LATEX + buildFallbackSlots slot mechanism onto
 * the bot's skeleton/macros. Harness-verified (scripts/_harness_s6b1.js): renders +
 * compiles experienced/fresher/senior, falls back to a full resume when Pass-2 is empty,
 * and throws on a truly empty body (never ships blank).
 *
 * This sprint the node is added UNWIRED — no functional change. S6b-2 wires it live
 * (ResumeForge -> ... -> Assemble Resume LaTeX -> Compile Resume PDF).
 *
 * Node code lives in a separate file (not inline) to avoid LaTeX backslash/$ double-
 * escaping in this patch script. Run: node scripts/s6b1_assemble.js
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

const NODE_CODE = fs.readFileSync(path.join(__dirname, 'nodes', 'assemble_resume_latex.js'), 'utf8');

// parse-check the node code once up front
try { new Function('$input', '$', NODE_CODE); }
catch (e) { console.error('PARSE FAIL (node code): ' + e.message); process.exit(1); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);

  if (N['Assemble Resume LaTeX']) {
    // keep code in sync if re-run
    N['Assemble Resume LaTeX'].parameters.jsCode = NODE_CODE;
    fs.writeFileSync(file, JSON.stringify(wf, null, 2));
    console.log(`OK ${base}: Assemble Resume LaTeX already present — code synced (${wf.nodes.length} nodes)`);
    return;
  }

  const anchor = N['Build Resume LaTeX'] || N['Compile Resume PDF'];
  const [ax, ay] = (anchor && anchor.position) || [0, 0];
  wf.nodes.push({
    parameters: { jsCode: NODE_CODE },
    id: crypto.randomUUID(),
    name: 'Assemble Resume LaTeX',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [ax, ay + 200],
    onError: 'continueErrorOutput',
  });

  // integrity: all connection targets still resolve
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    (obj.main || []).forEach((a) => (a || []).forEach((e) => {
      if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${src} -> ${e.node}`); process.exit(1); }
    }));
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: added Assemble Resume LaTeX (unwired) — ${wf.nodes.length} nodes`);
}

TARGETS.forEach(patch);
console.log('S6b-1 patch complete.');
