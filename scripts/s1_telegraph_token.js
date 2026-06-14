/**
 * s1_telegraph_token.js — S1: Telegraph tabular view goes live.
 *
 * Findings that shaped this:
 *  - The Telegraph digest printed "token not configured" simply because no
 *    token was ever set (NOT an $env crash — N8N_BLOCK_ENV_ACCESS_IN_NODE=false).
 *  - api.telegra.ph is unreachable from this network (ECONNRESET, host+container);
 *    the official mirror api.graph.org works. So we point CreatePage at graph.org.
 *  - Token is stored in Postgres app_settings (deterministic, out of git, reused by
 *    S8's budget) and read via a new "Load Telegraph Token" PG node — code nodes
 *    can always read $json from an upstream node, regardless of the $env sandbox.
 *
 * Changes (additive, degrade-gracefully):
 *  1) New "Load Telegraph Token" Postgres node (SELECT value FROM app_settings).
 *  2) Rewire Parse Scorer Output -> Load Telegraph Token -> Build Telegraph Body
 *     (keeps Parse Scorer Output -> Record Matches). Splicing (not a sibling) so
 *     the token node is guaranteed to run BEFORE Build Telegraph Body.
 *  3) Build Telegraph Body: read token from the PG node instead of $env.
 *  4) Telegraph CreatePage: api.telegra.ph -> api.graph.org.
 *
 * Run: node scripts/s1_telegraph_token.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'), // LIVE (imported/active)
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];
const PG_CRED = { postgres: { id: '5pQq6UUmmGU7e04S', name: 'CareerForge Postgres' } };
const LOAD_SQL = "SELECT value FROM app_settings WHERE key='telegraph_token' LIMIT 1";

const OLD_TOKEN_LINE = "const token = sd.telegraph_token || $env.TELEGRAPH_TOKEN || '';";
const NEW_TOKEN_LINE =
  "const _lt = $('Load Telegraph Token').first();\n" +
  "const token = (_lt && _lt.json && _lt.json.value) || sd.telegraph_token || '';";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const req of ['Parse Scorer Output', 'Build Telegraph Body', 'Telegraph CreatePage']) {
    if (!N[req]) { console.log(`SKIP (${path.basename(file)}: no "${req}")`); return; }
  }

  // 1) Load Telegraph Token node
  if (!N['Load Telegraph Token']) {
    const [px, py] = N['Parse Scorer Output'].position;
    wf.nodes.push({
      parameters: { operation: 'executeQuery', query: LOAD_SQL, options: {} },
      id: crypto.randomUUID(), name: 'Load Telegraph Token', type: 'n8n-nodes-base.postgres',
      typeVersion: 2.6, position: [px + 112, py - 176], credentials: PG_CRED,
      onError: 'continueRegularOutput', alwaysOutputData: true,
    });
  }

  // 2) Rewire Parse Scorer Output -> Load Telegraph Token -> Build Telegraph Body
  const pso = wf.connections['Parse Scorer Output'];
  if (pso && pso.main && pso.main[0]) {
    const hop = pso.main[0].find((e) => e.node === 'Build Telegraph Body');
    if (hop) hop.node = 'Load Telegraph Token'; // redirect the existing edge
  }
  wf.connections['Load Telegraph Token'] = { main: [[{ node: 'Build Telegraph Body', type: 'main', index: 0 }]] };

  // 3) Build Telegraph Body: token from PG node, not $env
  const btb = N['Build Telegraph Body'];
  if (btb.parameters.jsCode.includes(OLD_TOKEN_LINE)) {
    btb.parameters.jsCode = btb.parameters.jsCode.replace(OLD_TOKEN_LINE, NEW_TOKEN_LINE);
  } else if (!btb.parameters.jsCode.includes("$('Load Telegraph Token')")) {
    console.log(`WARN (${path.basename(file)}): token line not found verbatim — leaving Build Telegraph Body unchanged`);
  }

  // 4) Telegraph CreatePage -> graph.org mirror
  N['Telegraph CreatePage'].parameters.url = 'https://api.graph.org/createPage';

  // validation gate: every connection target must resolve to a real node
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL: dangling source "${src}" in ${file}`); process.exit(1); }
    (obj.main || []).forEach((arr) => (arr || []).forEach((e) => {
      if (!names.has(e.node)) { console.error(`INTEGRITY FAIL: edge -> missing "${e.node}" in ${file}`); process.exit(1); }
    }));
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${path.basename(file)}: ${wf.nodes.length} nodes (Load Telegraph Token wired, CreatePage->graph.org)`);
}

TARGETS.forEach(patch);
console.log('S1 patch complete.');
