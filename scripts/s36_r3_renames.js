/**
 * s36_r3_renames.js -- R3 item 2 (rename the OpenRouter model nodes) + the one
 * genuinely trivial item from R3 item 5 (rename the unrenamed "Code in
 * JavaScript" stub).
 *
 * Research correction: the prior audit said 11 model nodes; there are 10
 * (Model6/Model7 don't exist, and there's no bare "OpenRouter Chat Model"
 * either -- confirmed by exhaustive name-pattern search). Each of the 10 is a
 * pure single-consumer lmChatOpenRouter provider feeding exactly one node via
 * ai_languageModel -- a full-file regex sweep (raw text, not just parsed JSON)
 * found ZERO $('...') expression references to any of the 10 names anywhere
 * in the workflow. Each rename is exactly 2 touch points: the node's own
 * "name" field, and its own top-level key in the connections object (its
 * outgoing ai_languageModel edge). Nothing targets these nodes as a data
 * source, so no other node's connections need updating for these 10.
 *
 * "Code in JavaScript" (one of 3 empty-source stubs feeding the Serper/
 * Firecrawl/You.com disabled-provider fallback) is the one item in the
 * "smaller collapses" research that's genuinely zero-risk: unlike its two
 * siblings (Empty FC Stub, Empty YC Stub, already sensibly named), it kept
 * n8n's default new-Code-node name. Same rename shape, but this one DOES have
 * an inbound reference (IF: SERPER Disabled? routes to it by name) that needs
 * updating too -- handled by the same general rename helper.
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const RENAMES = [
  ['OpenRouter Chat Model1', 'ReviseForge Model'],
  ['OpenRouter Chat Model2', 'Intent Router Model'],
  ['OpenRouter Chat Model3', 'JobScorer Model'],
  ['OpenRouter Chat Model4', 'SeniorityDetector Model'],
  ['OpenRouter Chat Model5', 'ForgeScore Model'],
  ['OpenRouter Chat Model8', 'OutreachWriter Model'],
  ['OpenRouter Chat Model9', 'CompanyIntel Model'],
  ['OpenRouter Chat Model10', 'ContactFinder Model'],
  ['OpenRouter Chat Model11', 'SalarySummarize Model'],
  ['OpenRouter Chat Model12', 'Expand Query Model'],
  ['Code in JavaScript', 'Empty Serper Stub'],
];

// General rename: node's own name, its own connections key, and any OTHER
// node's edges that target it by name (only matters for the stub; a no-op for
// the 10 model nodes, which nothing targets -- confirmed by research).
function renameNode(wf, oldName, newName) {
  const node = wf.nodes.find((n) => n.name === oldName);
  if (!node) return false;
  node.name = newName;
  if (wf.connections[oldName]) {
    wf.connections[newName] = wf.connections[oldName];
    delete wf.connections[oldName];
  }
  for (const obj of Object.values(wf.connections)) {
    for (const connType of Object.keys(obj)) {
      obj[connType] = obj[connType].map((branch) => (branch || []).map((e) => (e.node === oldName ? { ...e, node: newName } : e)));
    }
  }
  return true;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  let edits = 0;

  const existingNames = new Set(wf.nodes.map((n) => n.name));
  for (const [oldName, newName] of RENAMES) {
    const alreadyDone = existingNames.has(newName) && !existingNames.has(oldName);
    if (alreadyDone) continue;
    if (!existingNames.has(oldName)) { console.error(`INTEGRITY FAIL ${base}: neither "${oldName}" nor "${newName}" found -- mapping stale?`); process.exit(1); }
    if (existingNames.has(newName)) { console.error(`INTEGRITY FAIL ${base}: proposed new name "${newName}" already exists as a different node -- collision`); process.exit(1); }
    if (!renameNode(wf, oldName, newName)) { console.error(`INTEGRITY FAIL ${base}: renameNode failed for "${oldName}"`); process.exit(1); }
    existingNames.delete(oldName);
    existingNames.add(newName);
    edits++;
  }

  // integrity: every connection edge resolves, connections object has no leftover old keys.
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [oldName] of RENAMES) {
    if (wf.connections[oldName]) { console.error(`INTEGRITY FAIL ${base}: stale connections key "${oldName}" survived the rename`); process.exit(1); }
  }
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling connection ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: ${edits} node(s) renamed -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  function edge(node, type, index) { return { node, type: type || 'main', index: index || 0 }; }

  // 1. renameNode on a synthetic fixture: own name, own connections key, AND a
  // reference from another node that targets it (mirrors the "Code in JavaScript"
  // case, which the 10 model-node renames don't exercise since nothing targets them).
  {
    const wf = {
      nodes: [{ name: 'IF: X Disabled?' }, { name: 'Old Stub Name' }, { name: 'Merge X' }],
      connections: {
        'IF: X Disabled?': { main: [[edge('Old Stub Name')], [edge('Real Provider')]] },
        'Old Stub Name': { main: [[edge('Merge X')]] },
      },
    };
    const ok = renameNode(wf, 'Old Stub Name', 'New Stub Name');
    if (!ok) { console.error('HARNESS FAIL: renameNode returned false for an existing node'); process.exit(1); }
    if (wf.nodes.find((n) => n.name === 'Old Stub Name')) { console.error('HARNESS FAIL: old node name still present'); process.exit(1); }
    if (!wf.nodes.find((n) => n.name === 'New Stub Name')) { console.error('HARNESS FAIL: new node name not set'); process.exit(1); }
    if (wf.connections['Old Stub Name']) { console.error('HARNESS FAIL: old connections key still present'); process.exit(1); }
    if (!wf.connections['New Stub Name'] || wf.connections['New Stub Name'].main[0][0].node !== 'Merge X') { console.error('HARNESS FAIL: connections key rename lost the outgoing edge'); process.exit(1); }
    if (wf.connections['IF: X Disabled?'].main[0][0].node !== 'New Stub Name') { console.error('HARNESS FAIL: inbound reference from IF: X Disabled? was not updated, got', JSON.stringify(wf.connections['IF: X Disabled?'])); process.exit(1); }
    if (wf.connections['IF: X Disabled?'].main[1][0].node !== 'Real Provider') { console.error('HARNESS FAIL: unrelated branch (Real Provider) must be untouched'); process.exit(1); }
    // idempotency: renaming again (old name gone) should return false, not corrupt anything.
    const again = renameNode(wf, 'Old Stub Name', 'New Stub Name');
    if (again !== false) { console.error('HARNESS FAIL: re-rename of an already-renamed node should return false'); process.exit(1); }
  }

  // 2. Pure-provider case (mirrors the 10 model nodes: nothing targets them, only
  // their own name + own connections key change).
  {
    const wf = {
      nodes: [{ name: 'Model Provider' }, { name: 'Consumer' }],
      connections: {
        'Model Provider': { ai_languageModel: [[edge('Consumer', 'ai_languageModel')]] },
      },
    };
    renameNode(wf, 'Model Provider', 'Consumer Model');
    if (!wf.connections['Consumer Model'] || wf.connections['Consumer Model'].ai_languageModel[0][0].node !== 'Consumer') { console.error('HARNESS FAIL: pure-provider rename broke the ai_languageModel edge'); process.exit(1); }
    if (wf.connections['Model Provider']) { console.error('HARNESS FAIL: pure-provider old key survived'); process.exit(1); }
  }

  // 3. No collisions: proposed new names are all distinct from each other and from
  // every old name (a self-contained check, not dependent on the live file).
  {
    const newNames = RENAMES.map((r) => r[1]);
    const oldNames = RENAMES.map((r) => r[0]);
    if (new Set(newNames).size !== newNames.length) { console.error('HARNESS FAIL: proposed new names are not all distinct'); process.exit(1); }
    if (newNames.some((n) => oldNames.includes(n))) { console.error('HARNESS FAIL: a proposed new name collides with one of the old names being renamed'); process.exit(1); }
  }

  // 4. Full RENAMES list applied to a fixture shaped like the real graph (10 pure
  // providers + 1 targeted stub) produces exactly 11 edits and is idempotent.
  {
    const wf = { nodes: [], connections: {} };
    for (const [oldName] of RENAMES) {
      wf.nodes.push({ name: oldName });
      if (oldName === 'Code in JavaScript') {
        wf.nodes.push({ name: 'IF: SERPER Disabled?' });
        wf.connections['IF: SERPER Disabled?'] = { main: [[edge('Code in JavaScript')], [edge('Serper Job Search')]] };
        wf.connections[oldName] = { main: [[edge('MergeSerper')]] };
      } else {
        wf.connections[oldName] = { ai_languageModel: [[edge('SomeConsumer', 'ai_languageModel')]] };
      }
    }
    let edits = 0;
    for (const [oldName, newName] of RENAMES) { if (renameNode(wf, oldName, newName)) edits++; }
    if (edits !== RENAMES.length) { console.error(`HARNESS FAIL: expected ${RENAMES.length} edits, got ${edits}`); process.exit(1); }
    if (wf.connections['IF: SERPER Disabled?'].main[0][0].node !== 'Empty Serper Stub') { console.error('HARNESS FAIL: full-list run did not update the stub inbound reference'); process.exit(1); }
    // idempotent re-run
    let edits2 = 0;
    for (const [oldName, newName] of RENAMES) { if (renameNode(wf, oldName, newName)) edits2++; }
    if (edits2 !== 0) { console.error('HARNESS FAIL: re-run over an already-renamed fixture should be a no-op, got', edits2); process.exit(1); }
  }

  console.log('HARNESS OK: renameNode verified for both shapes (targeted stub with an inbound reference, and pure ai_languageModel provider with none), no name collisions in the proposed mapping, and the full 11-rename list applies cleanly + idempotently against a graph-shaped fixture');
})();

TARGETS.forEach(patch);
console.log('S36 (R3: model-node renames + stub rename) complete.');
