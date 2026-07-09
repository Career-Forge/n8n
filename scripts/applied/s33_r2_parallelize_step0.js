/**
 * s33_r2_parallelize_step0.js -- Sprint R2 item 3 of the post-audit rebuild
 * plan (2026-07-05 v5 addendum): parallelize Step0 JD Analysis with Pass1
 * Selection instead of running it serially afterward for no data reason.
 *
 * Confirmed before touching anything: Step0 JD Analysis's own input is
 * `$('Build Pass1 Context').first().json.step0_user` -- a direct reference to
 * Build Pass1 Context, NOT to Pass1 Selection or Parse Pass1's output. The
 * current wiring (Build Pass1 Context -> Pass1 Selection -> Parse Pass1 ->
 * Step0 JD Analysis -> Parse Step0 -> Build Pass2 Input) is a topological
 * accident, not a data dependency -- Step0 has zero reason to wait for Pass1
 * to finish. Build Pass2 Input already reads BOTH $('Parse Pass1') and
 * $('Parse Step0') via direct expression access (not via $input), so it does
 * not care which single node triggers it -- it only needs both to have
 * executed already by the time it runs.
 *
 * Fix: fan Build Pass1 Context out to Pass1 Selection AND Step0 JD Analysis in
 * parallel, then join Parse Pass1 + Parse Step0 through a new Merge node
 * (n8n-nodes-base.merge, the same type/version/empty-params shape as this
 * workflow's existing Merge Cache / Merge PDFs nodes -- confirmed by reading
 * both) before Build Pass2 Input. A Merge node only fires once ALL of its
 * connected inputs have data, which is the actual synchronization primitive
 * this needs -- a bare pair of parallel connections into Build Pass2 Input
 * without a Merge node would race (whichever branch finishes first would
 * trigger it, and if that were the fast Step0 branch, $('Parse Pass1') could
 * throw no_execution_data before Pass1 Selection -- the far slower of the two
 * calls -- ever completes).
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

const MERGE_NODE_NAME = 'Merge Pass1 Step0';

function edge(node, index) { return { node, type: 'main', index: index || 0 }; }

// Pure graph-transform function -- shared by the harness (structural assertions
// against a synthetic fixture) and patch() (the real workflow), so the harness
// proves exactly the transform that runs against live data, not a parallel copy.
function parallelizeStep0(wf) {
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Build Pass1 Context', 'Parse Pass1', 'Step0 JD Analysis', 'Parse Step0', 'Build Pass2 Input']) {
    if (!N[name]) throw new Error(`node "${name}" not found`);
  }

  if (N[MERGE_NODE_NAME]) return 0; // already patched

  const parse1Pos = N['Parse Pass1'].position || [0, 0];
  const parseStep0Pos = N['Parse Step0'].position || [0, 0];
  wf.nodes.push({
    parameters: {},
    id: crypto.randomUUID(),
    name: MERGE_NODE_NAME,
    type: 'n8n-nodes-base.merge',
    typeVersion: 3,
    position: [Math.max(parse1Pos[0], parseStep0Pos[0]) + 240, Math.round((parse1Pos[1] + parseStep0Pos[1]) / 2)],
  });

  const C = wf.connections;

  // Build Pass1 Context: fan out to Step0 JD Analysis alongside Pass1 Selection (parallel start).
  if (!C['Build Pass1 Context'].main[0].some((e) => e.node === 'Step0 JD Analysis')) {
    C['Build Pass1 Context'].main[0].push(edge('Step0 JD Analysis'));
  }

  // Parse Pass1: no longer triggers Step0 (parallel now) -- feeds the Merge node's input 0 instead.
  C['Parse Pass1'].main[0] = [edge(MERGE_NODE_NAME, 0)];

  // Parse Step0: no longer triggers Build Pass2 Input directly -- feeds the Merge node's input 1.
  C['Parse Step0'].main[0] = [edge(MERGE_NODE_NAME, 1)];

  // Merge node -> Build Pass2 Input (only fires once BOTH inputs have arrived).
  C[MERGE_NODE_NAME] = { main: [[edge('Build Pass2 Input', 0)]] };

  return 1;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);

  let edits;
  try { edits = parallelizeStep0(wf); }
  catch (e) { console.error(`INTEGRITY FAIL ${base}: ${e.message}`); process.exit(1); }

  // integrity: every connection edge resolves to a node that exists.
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
  console.log(`OK ${base}: Step0 parallelized via ${MERGE_NODE_NAME} (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness: structural graph assertions against a synthetic fixture mirroring
// the real node names/shapes (no jsCode logic here -- this is a topology change,
// so the harness verifies topology, not runtime behavior). ──
(function harness() {
  function makeFixture() {
    return {
      nodes: [
        { name: 'Build Pass1 Context', position: [0, 0] },
        { name: 'Pass1 Selection', position: [200, -100] },
        { name: 'Parse Pass1', position: [400, -100] },
        { name: 'Step0 JD Analysis', position: [400, 100] },
        { name: 'Parse Step0', position: [600, 100] },
        { name: 'Build Pass2 Input', position: [800, 0] },
      ],
      connections: {
        'Build Pass1 Context': { main: [[edge('Pass1 Selection')]] },
        'Pass1 Selection': { main: [[edge('Parse Pass1')]] },
        'Parse Pass1': { main: [[edge('Step0 JD Analysis')]] },
        'Step0 JD Analysis': { main: [[edge('Parse Step0')]] },
        'Parse Step0': { main: [[edge('Build Pass2 Input')]] },
      },
    };
  }

  const wf = makeFixture();
  const edits = parallelizeStep0(wf);
  if (edits !== 1) { console.error('HARNESS FAIL: expected exactly 1 edit on a fresh fixture, got', edits); process.exit(1); }

  const C = wf.connections;
  // Build Pass1 Context must fan out to BOTH Pass1 Selection and Step0 JD Analysis in the SAME branch (parallel).
  const bpcTargets = C['Build Pass1 Context'].main[0].map((e) => e.node).sort();
  if (JSON.stringify(bpcTargets) !== JSON.stringify(['Pass1 Selection', 'Step0 JD Analysis'])) {
    console.error('HARNESS FAIL: Build Pass1 Context should fan out to both Pass1 Selection and Step0 JD Analysis, got', bpcTargets); process.exit(1);
  }
  // Parse Pass1 no longer feeds Step0 directly -- feeds the merge node at index 0.
  if (C['Parse Pass1'].main[0].length !== 1 || C['Parse Pass1'].main[0][0].node !== MERGE_NODE_NAME || C['Parse Pass1'].main[0][0].index !== 0) {
    console.error('HARNESS FAIL: Parse Pass1 should feed the merge node at index 0, got', JSON.stringify(C['Parse Pass1'])); process.exit(1);
  }
  // Parse Step0 no longer feeds Build Pass2 Input directly -- feeds the merge node at index 1.
  if (C['Parse Step0'].main[0].length !== 1 || C['Parse Step0'].main[0][0].node !== MERGE_NODE_NAME || C['Parse Step0'].main[0][0].index !== 1) {
    console.error('HARNESS FAIL: Parse Step0 should feed the merge node at index 1, got', JSON.stringify(C['Parse Step0'])); process.exit(1);
  }
  // Step0 JD Analysis still feeds Parse Step0 (unchanged link).
  if (C['Step0 JD Analysis'].main[0][0].node !== 'Parse Step0') { console.error('HARNESS FAIL: Step0 JD Analysis -> Parse Step0 link broken'); process.exit(1); }
  // Merge node feeds Build Pass2 Input.
  if (!C[MERGE_NODE_NAME] || C[MERGE_NODE_NAME].main[0][0].node !== 'Build Pass2 Input') { console.error('HARNESS FAIL: merge node does not feed Build Pass2 Input'); process.exit(1); }
  // The merge node itself has the exact type/version/empty-params shape this workflow's
  // existing Merge Cache / Merge PDFs nodes use.
  const mergeNode = wf.nodes.find((n) => n.name === MERGE_NODE_NAME);
  if (!mergeNode || mergeNode.type !== 'n8n-nodes-base.merge' || mergeNode.typeVersion !== 3 || Object.keys(mergeNode.parameters).length !== 0) {
    console.error('HARNESS FAIL: merge node does not match the existing Merge Cache/Merge PDFs shape, got', JSON.stringify(mergeNode)); process.exit(1);
  }
  // No dangling connections in the transformed fixture.
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    if (!names.has(src)) { console.error('HARNESS FAIL: fixture connection source missing from nodes:', src); process.exit(1); }
    for (const branches of Object.values(obj)) (branches || []).forEach((b) => (b || []).forEach((e) => {
      if (!names.has(e.node)) { console.error('HARNESS FAIL: dangling fixture connection to', e.node); process.exit(1); }
    }));
  }

  // Idempotency: running again on the already-patched fixture must be a no-op (0 edits), not a duplicate node/edge.
  const edits2 = parallelizeStep0(wf);
  if (edits2 !== 0) { console.error('HARNESS FAIL: re-running on an already-patched graph should be a no-op, got', edits2, 'edits'); process.exit(1); }
  const mergeNodeCount = wf.nodes.filter((n) => n.name === MERGE_NODE_NAME).length;
  if (mergeNodeCount !== 1) { console.error('HARNESS FAIL: expected exactly 1 merge node after a re-run, got', mergeNodeCount); process.exit(1); }

  console.log('HARNESS OK: Build Pass1 Context fans out to Pass1 Selection + Step0 JD Analysis in parallel, Parse Pass1 + Parse Step0 both join through the new Merge node (same type/version/empty-params shape as the existing Merge Cache/Merge PDFs nodes) before Build Pass2 Input, no dangling connections, re-run is idempotent -- all verified');
})();

TARGETS.forEach(patch);
console.log('S33 (R2 item 3: parallelize Step0) complete.');
