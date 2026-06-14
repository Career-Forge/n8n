/**
 * s2b_scorer_fix.js — fix the silently-broken job scorer.
 *
 * Root cause: JobScorer (chainLlm) has an attached structured output parser
 * ("Scorer Output Parser", hasOutputParser:true), so the parsed result lands in
 * $json.output ({ scored: [...] }). But "Parse Scorer Output" only reads
 * $json.text / top-level .scored — it never looks at .output. So every run blew
 * through all 4 text strategies into the neutral fallback (everyone 5/10,
 * "Scoring unavailable — showing by source quality").
 *
 * Fix: add a Strategy 0 that reads the structured-parser result from .output
 * FIRST. Purely additive; the existing text strategies remain as fallbacks.
 *
 * Run: node scripts/s2b_scorer_fix.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const ANCHOR = "if (!scored.length) { try { const parsed = JSON.parse(raw);";
const INJECT =
  "// Strategy 0 — chainLlm's attached output parser puts the validated object under .output\n" +
  "if (!scored.length && rawInput && rawInput.output) { const o = rawInput.output; const v = validate(o.scored) || validate(o); if (v) { scored = v; strategy = 'parsed_output'; } }\n";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Parse Scorer Output');
  if (!node) { console.log(`SKIP (${path.basename(file)}: no "Parse Scorer Output")`); return; }
  let code = node.parameters.jsCode;
  if (code.includes("'parsed_output'")) { console.log(`OK ${path.basename(file)}: already patched`); return; }
  if (!code.includes(ANCHOR)) { console.log(`WARN (${path.basename(file)}): anchor not found — NOT patched`); return; }
  code = code.replace(ANCHOR, INJECT + ANCHOR);
  node.parameters.jsCode = code;
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${path.basename(file)}: Strategy 0 (.output reader) added`);
}

TARGETS.forEach(patch);
console.log('S2b patch complete.');
