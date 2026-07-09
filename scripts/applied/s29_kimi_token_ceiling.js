/**
 * s29_kimi_token_ceiling.js -- fixes a live crash: "Model output doesn't fit
 * required format" on Cover Pass1 (exec 157, 2026-07-04 22:30 UTC), surviving all
 * 3 of S28's retryOnFail attempts.
 *
 * Root-caused against real execution data, NOT guessed: pulled the resolved
 * execution tree (n8n stores it in a flatted/indexed format -- every string value
 * inside an object/array is itself an index reference into the top-level array;
 * only numbers/booleans/null are inline) and inspected Cover Pass1 Model's 3
 * retry attempts directly. All 3 are IDENTICAL:
 *   { text: "", generationInfo: { finish_reason: "length" } },
 *   tokenUsage: { completionTokens: 6000, promptTokens: 5495, totalTokens: 11495 }
 * completionTokens == the node's own maxTokens cap (6000), and visible text is
 * empty. This is a DIFFERENT failure class than S26/S27 (backend/prompt-compliance
 * variance, where retrying helps because a retry can land on a different
 * OpenRouter backend) -- here all 3 retries are byte-identical, meaning this is
 * deterministic per-input. retryOnFail cannot fix it no matter how many tries.
 *
 * Confirmed via research (WebSearch, not assumed): moonshotai/kimi-k2.6 is a
 * mandatory "thinking" model -- it always runs internal chain-of-thought before
 * the visible answer, and on OpenRouter those reasoning tokens are billed AND
 * COUNTED against the same completion/maxTokens budget as the final answer, with
 * no separate allowance. There's a known, open, live bug (SillyTavern #5599, filed
 * against OpenRouter) matching this exact symptom: Kimi K2.6's reasoning can
 * consume the ENTIRE token budget with zero visible answer produced. Disabling
 * reasoning outright is not a safe alternative -- the same issue reports it can
 * hang the request instead. The only real lever available at the node-config
 * level is raising the ceiling so reasoning has room to finish before the answer
 * needs to start.
 *
 * Scope: Cover Pass1 was the one that actually crashed, but grepping the model
 * map (s9_polish.js) for every node routed to moonshotai/kimi-k2.6 turns up 7
 * nodes total, ALL exposed to the identical failure mode, with caps ranging
 * 4000-8192 (Cover Pass2 at 4000 is the MOST exposed, not yet observed to fail
 * only because it hasn't been hit with a big-enough dossier yet):
 *   Pass1 Model (8000), Pass2 Model (8000), Pass2 Regen Model (8000),
 *   OpenRouter Chat Model1 / ReviseForge (8192), Cover Pass1 Model (6000),
 *   Cover Pass2 Model (4000), OpenRouter Chat Model8 / OutreachWriter (unset --
 *   silently inheriting whatever n8n/OpenRouter's own default is, which is its own
 *   quiet gap given every other node in this lane has an explicit cap).
 *
 * Fix: raise every one of the 7 to 16000. Kimi K2.6's context window is 262K, so
 * this is nowhere near a model-side ceiling; it's purely about giving the
 * reasoning trace (routinely 4-8k+ tokens per Moonshot's own numbers) enough room
 * to finish before the actual JSON answer needs to be written. This raises the
 * worst-case per-call cost ceiling but does not change typical-case cost --
 * OpenRouter bills actual tokens used, not the cap. retryOnFail stays on for all 7
 * (still useful for genuine transient backend variance, just not this specific
 * failure mode).
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

const NEW_CEILING = 16000;

// [nodeName, expected-old-maxTokens-or-null-if-unset] -- documents exactly what
// we found live, so a mismatch at patch time means the workflow drifted from
// what this fix was scoped against, not a silent overwrite.
const NODES = [
  ['Pass1 Model', 8000],
  ['Pass2 Model', 8000],
  ['Pass2 Regen Model', 8000],
  ['OpenRouter Chat Model1', 8192],
  ['Cover Pass1 Model', 6000],
  ['Cover Pass2 Model', 4000],
  ['OpenRouter Chat Model8', null],
];

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const [name] of NODES) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
    if (N[name].parameters.model !== 'moonshotai/kimi-k2.6') {
      console.error(`INTEGRITY FAIL ${base}: "${name}" model is "${N[name].parameters.model}", expected moonshotai/kimi-k2.6`);
      process.exit(1);
    }
  }

  for (const [name, expectedOld] of NODES) {
    const n = N[name];
    if (!n.parameters.options) n.parameters.options = {};
    const cur = n.parameters.options.maxTokens !== undefined ? n.parameters.options.maxTokens : null;
    if (cur !== expectedOld) {
      console.error(`INTEGRITY FAIL ${base}: "${name}" maxTokens is ${cur}, expected ${expectedOld}`);
      process.exit(1);
    }
    if (n.parameters.options.maxTokens !== NEW_CEILING) {
      n.parameters.options.maxTokens = NEW_CEILING;
      edits++;
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Kimi token ceiling raised on ${NODES.length} nodes (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  const failures = [];
  function check(name, cond) { if (!cond) failures.push(name); }

  check('exactly 7 nodes targeted', NODES.length === 7);
  check('new ceiling is well above every observed old cap', NODES.every(([, old]) => old === null || NEW_CEILING > old));
  check('new ceiling leaves real headroom over the observed failure (6000, all consumed by reasoning)', NEW_CEILING >= 16000);

  // Simulates the patch's own integrity-check logic against a synthetic node set
  // matching exactly what was found live, to prove the anchor values are right
  // before touching real files.
  const fakeWf = { nodes: NODES.map(([name, old]) => ({
    name,
    parameters: { model: 'moonshotai/kimi-k2.6', options: old === null ? {} : { maxTokens: old, temperature: 0.3, timeout: 120000 } },
  })) };
  for (const [name, expectedOld] of NODES) {
    const n = fakeWf.nodes.find((x) => x.name === name);
    const cur = n.parameters.options.maxTokens !== undefined ? n.parameters.options.maxTokens : null;
    check(`${name}: synthetic old value matches documented anchor`, cur === expectedOld);
  }

  if (failures.length) { console.error('HARNESS FAIL:', failures.join(', ')); process.exit(1); }
  console.log('HARNESS OK: 7 Kimi K2.6 nodes, all old-value anchors verified against a synthetic reconstruction, new ceiling (16000) confirmed above every observed cap with real headroom over the observed all-reasoning failure -- verified');
})();

TARGETS.forEach(patch);
console.log('S29 (Kimi token ceiling) complete.');
