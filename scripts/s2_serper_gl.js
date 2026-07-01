/**
 * s2_serper_gl.js — derive Serper `gl` from the parsed country (never a US default).
 *
 * (P0.6) Matches the active invariant: the Serper body is a `jsonBody` that includes
 * `gl` ONLY when Parse Expand Query.country exists. There is NO keypair body that
 * always sends `gl`, and NO US/us fallback. Re-running this is safe and idempotent
 * with the current active node (same jsonBody the canonical p0_geo_defaults.js sets).
 *
 * Run: node scripts/s2_serper_gl.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// gl is added ONLY when country is set; otherwise the request carries no gl (global).
const SERPER_JSON_BODY =
  "={{ JSON.stringify(Object.assign(" +
  "{ q: $json.query, num: 10, hl: 'en', tbs: ($('Parse Expand Query').first().json.freshness || 'qdr:w') }, " +
  "($('Parse Expand Query').first().json.country ? { gl: String($('Parse Expand Query').first().json.country).toLowerCase() } : {})" +
  ")) }}";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Serper Job Search');
  if (!node) { console.log(`SKIP (${path.basename(file)}: no "Serper Job Search")`); return; }
  const p = node.parameters = node.parameters || {};
  p.sendBody = true;
  p.specifyBody = 'json';
  p.jsonBody = SERPER_JSON_BODY;
  delete p.bodyParameters;          // remove any old keypair body that always sent gl
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${path.basename(file)}: Serper -> jsonBody (gl only when country set, no US default)`);
}

TARGETS.forEach(patch);
console.log('S2 Serper patch complete (conditional gl, no US default).');
