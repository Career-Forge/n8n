/**
 * s37_r3_telegram_sender.js -- R3 item 3: consolidate the 10 parameter-
 * identical Telegram sendMessage nodes into one generic sender.
 *
 * Research confirmed (exact dict-equality check, not eyeballing) all 10 --
 * Send Done, Send Track Ack, Send Status, Send Score, Send Salary, Send
 * Revise Done, Send Intel, Send Contacts, Send Outreach, Send Resume Status
 * -- share the identical shape {chatId: {{$json.chat_id}}, text:
 * {{$json.message}}, additionalFields: {parse_mode: Markdown}}, same
 * credential, differing only in id/name/position/webhookId (cosmetic). 14
 * other Telegram nodes look similar but differ in chatId or text expression
 * or additionalFields -- explicitly out of scope, confirmed not touched here.
 *
 * All 10 are leaf nodes (zero outgoing connections -- nothing reads their
 * Telegram API response, confirmed via a full-file reference sweep finding
 * exactly 2-3 occurrences per name, all accounted for by the node's own
 * definition + its inbound edge(s)). All 10 are reachable via mutually
 * exclusive branches of Route Intent's 18-way Switch (or a downstream IF
 * whose true/false targets were individually confirmed disjoint) -- traced
 * back to the root for every one, so consolidating cannot cause two of these
 * messages to race or overwrite each other in the same execution.
 *
 * 11 upstream feeders (10 senders, but Send Intel has two: Format Intel
 * Report and Format Intel Report (Cached), an existing fan-in pattern this
 * reuses rather than invents) get their single outgoing edge repointed at a
 * new "Send Generic Reply" node; the 10 old sender nodes are then deleted.
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
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

const NEW_NODE_NAME = 'Send Generic Reply';

const OLD_SENDERS = [
  'Send Done', 'Send Track Ack', 'Send Status', 'Send Score', 'Send Salary',
  'Send Revise Done', 'Send Intel', 'Send Contacts', 'Send Outreach', 'Send Resume Status',
];

// feeder -> old sender it currently points at (11 edges, since Send Intel has 2 feeders)
const FEEDER_EDGES = [
  ['Store Apply Context', 'Send Done'],
  ['Track Application', 'Send Track Ack'],
  ['List Applications', 'Send Status'],
  ['Format Score Message', 'Send Score'],
  ['Format Salary', 'Send Salary'],
  ['Update Last Apply', 'Send Revise Done'],
  ['Format Intel Report', 'Send Intel'],
  ['Format Intel Report (Cached)', 'Send Intel'],
  ['Format Contacts', 'Send Contacts'],
  ['Format Outreach', 'Send Outreach'],
  ['Format Resume Status', 'Send Resume Status'],
];

const CANON_PARAMS = {
  chatId: '={{ $json.chat_id }}',
  text: '={{ $json.message }}',
  additionalFields: { parse_mode: 'Markdown' },
};

function deleteNodeEverywhere(wf, name) {
  const idx = wf.nodes.findIndex((n) => n.name === name);
  if (idx === -1) return false;
  wf.nodes.splice(idx, 1);
  delete wf.connections[name];
  for (const obj of Object.values(wf.connections)) {
    for (const connType of Object.keys(obj)) {
      obj[connType] = obj[connType].map((branch) => (branch || []).filter((e) => e.node !== name));
    }
  }
  return true;
}

function paramsEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  let edits = 0;

  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (N[NEW_NODE_NAME]) {
    console.log(`  ${base}: already patched (${NEW_NODE_NAME} exists)`);
    return;
  }

  for (const name of OLD_SENDERS) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: expected sender "${name}" not found`); process.exit(1); }
    if (!paramsEqual(N[name].parameters, CANON_PARAMS)) { console.error(`INTEGRITY FAIL ${base}: "${name}" parameters do not match the canonical shape.\nGot: ${JSON.stringify(N[name].parameters)}`); process.exit(1); }
    if (wf.connections[name] && Object.values(wf.connections[name]).some((branches) => (branches || []).some((b) => (b || []).length))) {
      console.error(`INTEGRITY FAIL ${base}: "${name}" has outgoing connections -- expected a leaf node`); process.exit(1);
    }
  }
  for (const [feeder, target] of FEEDER_EDGES) {
    if (!N[feeder]) { console.error(`INTEGRITY FAIL ${base}: feeder "${feeder}" not found`); process.exit(1); }
    const branch0 = (wf.connections[feeder] && wf.connections[feeder].main && wf.connections[feeder].main[0]) || [];
    if (!branch0.some((e) => e.node === target)) { console.error(`INTEGRITY FAIL ${base}: "${feeder}" does not currently point at "${target}", got ${JSON.stringify(branch0)}`); process.exit(1); }
  }

  const anchor = (N['Send Score'].position) || [30000, 49000];
  const telegramCred = N['Send Done'].credentials.telegramApi;
  wf.nodes.push({
    parameters: CANON_PARAMS,
    id: crypto.randomUUID(),
    name: NEW_NODE_NAME,
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: [anchor[0], anchor[1] - 300],
    credentials: { telegramApi: telegramCred },
  });
  edits++;

  for (const [feeder, oldTarget] of FEEDER_EDGES) {
    const branch0 = wf.connections[feeder].main[0];
    wf.connections[feeder].main[0] = branch0.map((e) => (e.node === oldTarget ? { ...e, node: NEW_NODE_NAME } : e));
  }
  edits++;

  for (const name of OLD_SENDERS) {
    if (deleteNodeEverywhere(wf, name)) edits++;
  }

  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling connection ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Telegram senders consolidated (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  function edge(node, index) { return { node, type: 'main', index: index || 0 }; }

  // Structural: full consolidation against a fixture shaped like the real graph
  // (10 senders, 11 feeder edges incl. the Send Intel 2:1 fan-in).
  {
    const wf = { nodes: [], connections: {} };
    for (const name of OLD_SENDERS) {
      wf.nodes.push({ parameters: JSON.parse(JSON.stringify(CANON_PARAMS)), id: 'id-' + name, name, type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [30000, 49000], credentials: { telegramApi: { id: 'X', name: 'CareerForge_Telegram' } } });
    }
    for (const [feeder, target] of FEEDER_EDGES) {
      if (!wf.nodes.some((n) => n.name === feeder)) wf.nodes.push({ name: feeder });
      wf.connections[feeder] = wf.connections[feeder] || { main: [[]] };
      wf.connections[feeder].main[0].push(edge(target));
    }

    patchFixture(wf);
    function patchFixture(wf) {
      // mirrors patch()'s core logic against the in-memory fixture
      const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
      for (const name of OLD_SENDERS) {
        if (!paramsEqual(N[name].parameters, CANON_PARAMS)) throw new Error('fixture params mismatch for ' + name);
      }
      const telegramCred = N['Send Done'].credentials.telegramApi;
      wf.nodes.push({ parameters: CANON_PARAMS, id: 'new-id', name: NEW_NODE_NAME, type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [30000, 48700], credentials: { telegramApi: telegramCred } });
      for (const [feeder, oldTarget] of FEEDER_EDGES) {
        wf.connections[feeder].main[0] = wf.connections[feeder].main[0].map((e) => (e.node === oldTarget ? { ...e, node: NEW_NODE_NAME } : e));
      }
      for (const name of OLD_SENDERS) deleteNodeEverywhere(wf, name);
    }

    if (!wf.nodes.find((n) => n.name === NEW_NODE_NAME)) { console.error('HARNESS FAIL: Send Generic Reply not created'); process.exit(1); }
    for (const name of OLD_SENDERS) {
      if (wf.nodes.find((n) => n.name === name)) { console.error('HARNESS FAIL: old sender', name, 'still present'); process.exit(1); }
      if (wf.connections[name]) { console.error('HARNESS FAIL: old connections key', name, 'still present'); process.exit(1); }
    }
    for (const [feeder] of FEEDER_EDGES) {
      const targets = wf.connections[feeder].main[0].map((e) => e.node);
      if (!targets.every((t) => t === NEW_NODE_NAME)) { console.error(`HARNESS FAIL: ${feeder} still points somewhere other than ${NEW_NODE_NAME}, got`, targets); process.exit(1); }
    }
    // Send Intel's 2:1 fan-in preserved as 2 separate feeders both -> Send Generic Reply.
    const intelFeeders = FEEDER_EDGES.filter(([, t]) => t === 'Send Intel').map(([f]) => f);
    if (intelFeeders.length !== 2) { console.error('HARNESS FAIL: fixture setup wrong, expected 2 Send Intel feeders'); process.exit(1); }
    for (const f of intelFeeders) {
      if (!wf.connections[f].main[0].some((e) => e.node === NEW_NODE_NAME)) { console.error('HARNESS FAIL: intel feeder', f, 'lost its edge to the generic sender'); process.exit(1); }
    }
    // no dangling connections
    const names = new Set(wf.nodes.map((n) => n.name));
    for (const [src, obj] of Object.entries(wf.connections)) {
      if (!names.has(src)) { console.error('HARNESS FAIL: dangling connection source', src); process.exit(1); }
      for (const branches of Object.values(obj)) (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error('HARNESS FAIL: dangling connection target', e.node); process.exit(1); }
      }));
    }
  }

  // paramsEqual must reject a near-miss (e.g. Send Costs' extra appendAttribution field) --
  // proves the integrity check in patch() would actually catch a wrongly-included node.
  {
    const nearMiss = { chatId: '={{ $json.chat_id }}', text: '={{ $json.message }}', additionalFields: { parse_mode: 'Markdown', appendAttribution: false } };
    if (paramsEqual(nearMiss, CANON_PARAMS)) { console.error('HARNESS FAIL: paramsEqual should reject a near-miss shape (extra field), but accepted it'); process.exit(1); }
  }

  console.log('HARNESS OK: full consolidation verified against a graph-shaped fixture (10 senders deleted, 1 generic sender created, all 11 feeder edges incl. the Send Intel 2:1 fan-in repointed, no dangling connections), and paramsEqual confirmed to reject a near-miss shape (would have caught an incorrectly-included node like Send Costs)');
})();

TARGETS.forEach(patch);
console.log('S37 (R3: Telegram sender consolidation) complete.');
