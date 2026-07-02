/**
 * local_remove_hunter_bind_apollo.js — one-off local-setup fix:
 * 1) Remove "Hunter Verify" entirely (Hunter's credential UI wouldn't let the user
 *    log in; hunter_enabled defaults to false in app_settings anyway, so this
 *    capability was never load-bearing). "IF: Hunter Enabled?" true-branch is
 *    rewired to converge on "Finalize Enriched Contact", same as its false branch —
 *    both branches now lead to the same place, so the gate becomes a harmless no-op
 *    rather than a dangling edge.
 * 2) Bind "Apollo Match" (credentials was null, generic httpHeaderAuth auth) to the
 *    "CareerForge_Apollo" credential the user created via the n8n UI.
 *
 * Run inside the n8n container (only place with a Node runtime + these files staged
 * at matching relative paths — see local_remap_credentials.js header for the pattern).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const APOLLO_CRED = { id: 'P2CM45hc8Rah4MB3', name: 'CareerForge_Apollo' };

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const C = wf.connections;

  // 1) rewire IF: Hunter Enabled? true-branch to bypass Hunter Verify
  const gate = C['IF: Hunter Enabled?'];
  if (!gate) { console.error(`INTEGRITY FAIL ${base}: "IF: Hunter Enabled?" not found`); process.exit(1); }
  gate.main[0] = [{ node: 'Finalize Enriched Contact', type: 'main', index: 0 }];

  // 2) drop Hunter Verify node + its connections entry
  const before = wf.nodes.length;
  wf.nodes = wf.nodes.filter((n) => n.name !== 'Hunter Verify');
  delete C['Hunter Verify'];
  const dropped = before - wf.nodes.length;

  // 3) bind Apollo Match's credentials (was null)
  const apollo = wf.nodes.find((n) => n.name === 'Apollo Match');
  if (!apollo) { console.error(`INTEGRITY FAIL ${base}: "Apollo Match" not found`); process.exit(1); }
  apollo.credentials = { httpHeaderAuth: { id: APOLLO_CRED.id, name: APOLLO_CRED.name } };

  // integrity: no dangling edges left pointing at the dropped node
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: dropped Hunter Verify (${dropped} node), bound Apollo Match — ${wf.nodes.length} nodes`);
}

TARGETS.forEach(patch);
console.log('Hunter removal + Apollo bind complete.');
