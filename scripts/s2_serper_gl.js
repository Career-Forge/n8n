/**
 * s2_serper_gl.js — S2: fix "India returned US jobs".
 *
 * Serper Job Search hardcoded gl=us in its body, which overrides any location
 * in the query string (gl is Google's "results for which country" knob). The
 * Expand Query LLM already produces an ISO `country` (US, IN, GB, ...), so we
 * just derive gl from it. Falls back to 'US' if country is absent — same as today.
 *
 * Match the param by name (not index) for safety. Run: node scripts/s2_serper_gl.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];
const GL_EXPR = "={{ ($('Parse Expand Query').first().json.country || 'US').toLowerCase() }}";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Serper Job Search');
  if (!node) { console.log(`SKIP (${path.basename(file)}: no "Serper Job Search")`); return; }
  const params = ((node.parameters || {}).bodyParameters || {}).parameters || [];
  const gl = params.find((p) => p.name === 'gl');
  if (!gl) { console.log(`WARN (${path.basename(file)}): no gl param found`); return; }
  gl.value = GL_EXPR;
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${path.basename(file)}: Serper gl -> country-derived`);
}

TARGETS.forEach(patch);
console.log('S2 patch complete.');
