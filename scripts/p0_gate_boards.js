/**
 * p0_gate_boards.js -- P0(C): gate the third-party board/aggregator lanes default-OFF.
 *
 * RemoteOK and Adzuna currently feed Merge Sources directly (always on). They are
 * third-party sources that dilute company-direct results, so they become opt-in via
 * env flags REMOTEOK_ENABLED / ADZUNA_ENABLED (default OFF). Adzuna is ALSO skipped
 * when the query named no country (P0-B: never call /jobs/us by default).
 *
 * Mirrors the proven FC/YC/Serper shape exactly so Merge Sources never hangs:
 *     <feeder> -> IF: X Disabled? --(true/disabled)--> Empty X Stub --\
 *                                  --(false/enabled)--> X Fetch -> Normalize X -> MergeX -> Merge Sources[idx]
 * Merge Sources keeps numberInputs=5 (RemoteOK=input 3, Adzuna=input 4).
 *
 * Idempotent (re-runs reset the wiring deterministically). Backups + integrity check.
 * Run: node scripts/p0_gate_boards.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
];
const uuid = () => crypto.randomUUID();
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const RM_EXPR = "={{ $env.REMOTEOK_ENABLED !== 'true' }}";
const AZ_EXPR = "={{ $env.ADZUNA_ENABLED !== 'true' || !($('Parse Expand Query').first().json.country) }}";

function ifNode(name, leftExpr, pos) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 3 },
        conditions: [{ id: uuid(), leftValue: leftExpr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    type: 'n8n-nodes-base.if', typeVersion: 2.3, position: pos, id: uuid(), name,
  };
}
function stubNode(name, source, pos) {
  return { parameters: { jsCode: `return [{ json: { jobs: [], source: '${source}', count: 0, _disabled: true } }];` },
    type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, id: uuid(), name };
}
function mergeNode(name, pos) {
  return { parameters: {}, type: 'n8n-nodes-base.merge', typeVersion: 3, position: pos, id: uuid(), name };
}

const NEW_NODES = [
  ['IF: RemoteOK Disabled?', () => ifNode('IF: RemoteOK Disabled?', RM_EXPR, [30100, 47760])],
  ['Empty RemoteOK Stub', () => stubNode('Empty RemoteOK Stub', 'remoteok_disabled', [30360, 48000])],
  ['MergeRemoteOK', () => mergeNode('MergeRemoteOK', [30780, 47900])],
  ['IF: Adzuna Disabled?', () => ifNode('IF: Adzuna Disabled?', AZ_EXPR, [30400, 48080])],
  ['Empty Adzuna Stub', () => stubNode('Empty Adzuna Stub', 'adzuna_disabled', [30620, 48320])],
  ['MergeAdzuna', () => mergeNode('MergeAdzuna', [31060, 48220])],
];

const E = (node, index = 0) => ({ node, type: 'main', index });

function filterAdd(wf, src, outIdx, removeNames, addEntries) {
  const c = (wf.connections[src] = wf.connections[src] || { main: [] });
  c.main[outIdx] = c.main[outIdx] || [];
  c.main[outIdx] = c.main[outIdx].filter((e) => !removeNames.includes(e.node));
  for (const ae of addEntries) {
    if (!c.main[outIdx].some((e) => e.node === ae.node && e.index === ae.index)) c.main[outIdx].push(ae);
  }
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + path.relative(ROOT, file)); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.relative(ROOT, file);
  const byName = {}; wf.nodes.forEach((n) => { byName[n.name] = n; });

  // required anchors must exist
  for (const a of ['Pre-flight: Providers', 'RemoteOK Fetch', 'Normalize RemoteOK', 'Load Structured Config',
    'Adzuna Fetch', 'Normalize Adzuna', 'Merge Sources']) {
    if (!byName[a]) { console.error('ANCHOR MISSING in ' + base + ': ' + a); process.exit(1); }
  }

  // upsert the 6 new nodes (idempotent)
  for (const [name, make] of NEW_NODES) {
    const node = make();
    const existing = wf.nodes.findIndex((n) => n.name === name);
    if (existing >= 0) { node.id = wf.nodes[existing].id; wf.nodes[existing] = node; }
    else wf.nodes.push(node);
  }

  wf.connections = wf.connections || {};
  // RemoteOK lane
  filterAdd(wf, 'Pre-flight: Providers', 0, ['RemoteOK Fetch'], [E('IF: RemoteOK Disabled?')]);
  wf.connections['IF: RemoteOK Disabled?'] = { main: [[E('Empty RemoteOK Stub')], [E('RemoteOK Fetch')]] };
  wf.connections['Empty RemoteOK Stub'] = { main: [[E('MergeRemoteOK', 0)]] };
  filterAdd(wf, 'Normalize RemoteOK', 0, ['Merge Sources'], [E('MergeRemoteOK', 1)]);
  wf.connections['MergeRemoteOK'] = { main: [[E('Merge Sources', 3)]] };
  // Adzuna lane
  filterAdd(wf, 'Load Structured Config', 0, ['Adzuna Fetch'], [E('IF: Adzuna Disabled?')]);
  wf.connections['IF: Adzuna Disabled?'] = { main: [[E('Empty Adzuna Stub')], [E('Adzuna Fetch')]] };
  wf.connections['Empty Adzuna Stub'] = { main: [[E('MergeAdzuna', 0)]] };
  filterAdd(wf, 'Normalize Adzuna', 0, ['Merge Sources'], [E('MergeAdzuna', 1)]);
  wf.connections['MergeAdzuna'] = { main: [[E('Merge Sources', 4)]] };

  // integrity: every connection target exists
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error('INTEGRITY FAIL: source ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) (branches || []).forEach((br) => (br || []).forEach((e) => {
      if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
    }));
  }
  // sanity: Merge Sources still 5 inputs
  const ms = byName['Merge Sources'];
  const inputs = ms.parameters && ms.parameters.numberInputs;
  if (inputs !== 5) console.log('  NOTE: Merge Sources numberInputs=' + inputs + ' (expected 5)');

  fs.writeFileSync(file + '.p0bak-' + stamp(), fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': +6 gate nodes, lanes rewired (RemoteOK->in3, Adzuna->in4)');
}

TARGETS.forEach(patch);
console.log('p0_gate_boards complete.');
