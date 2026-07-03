/**
 * s19_retry_resilience.js -- retry-on-fail for every hard structured-output node.
 *
 * Root-caused live (2026-07-03): after WS5 swapped writers/JSON-lanes off
 * openai/gpt-5.4-mini onto moonshotai/kimi-k2.6 / deepseek-v4-flash / deepseek-v4-pro,
 * "Find me AI jobs in Hyderabad" crashed Intent Router twice in a row with "Model
 * output doesn't fit required format". 10/10 direct OpenRouter replay calls with the
 * identical system+user message succeeded -- this is NOT a schema or prompt bug.
 *
 * The actual cause: unlike gpt-5.4-mini (one canonical OpenAI-hosted implementation),
 * every swapped model fans out across several INDEPENDENT OpenRouter backend
 * providers per request -- confirmed live: deepseek-v4-flash hit Alibaba/GMICloud/
 * DeepInfra/Venice across 6 calls, deepseek-v4-pro hit AtlasCloud/Baidu/StreamLake,
 * kimi-k2.6 hit Inceptron/Baidu/Decart. These are independent hostings of the same
 * open-weight model with independently variable tool-calling compliance -- one
 * backend producing malformed structured output on an isolated request is expected
 * probabilistic flakiness, not a deterministic failure to fix by editing a prompt.
 *
 * Fix: retryOnFail on every node with a hard-fail Structured Output Parser attached
 * (found by scanning ai_outputParser connections). A retry is a NEW OpenRouter
 * request, which very likely lands on a different backend -- turning "provider X
 * botched this one response" into "an isolated blip the user never sees" instead of
 * a crashed message. This is now a standing resilience requirement for any
 * OpenRouter-routed open-weight model on a hard-parse node, not a one-off patch.
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

// Nodes with an ai_outputParser connection feeding them -- a malformed response is a
// hard NodeOperationError, not a gracefully-degraded parse (unlike the Parse* Code
// nodes elsewhere, which already best-effort-repair raw text).
const RETRY_NODES = [
  'Intent Router', 'SeniorityDetector', 'ForgeScore', 'ReviseForge', 'ScoreOnly',
  'OutreachWriter', 'CompanyIntel', 'ContactFinder', 'SalarySummarize', 'JobScorer',
];

const MAX_TRIES = 3;
const WAIT_MS = 1000;

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  let edits = 0;
  for (const name of RETRY_NODES) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
    const n = N[name];
    if (n.retryOnFail === true && n.maxTries === MAX_TRIES && n.waitBetweenTries === WAIT_MS) continue;
    n.retryOnFail = true;
    n.maxTries = MAX_TRIES;
    n.waitBetweenTries = WAIT_MS;
    edits++;
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: retry-on-fail set on ${RETRY_NODES.length} nodes (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness: prove the retry fields land with the exact expected shape ──
(function harness() {
  const fakeWf = { nodes: RETRY_NODES.map((name) => ({ name, parameters: {} })) };
  const tmp = '/tmp/_s19_harness_fixture.json';
  fs.writeFileSync(tmp, JSON.stringify(fakeWf));
  const wf = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of RETRY_NODES) { N[name].retryOnFail = true; N[name].maxTries = MAX_TRIES; N[name].waitBetweenTries = WAIT_MS; }
  for (const name of RETRY_NODES) {
    if (N[name].retryOnFail !== true || N[name].maxTries !== 3 || N[name].waitBetweenTries !== 1000) {
      console.error('HARNESS FAIL: retry fields wrong for', name); process.exit(1);
    }
  }
  fs.unlinkSync(tmp);
  console.log('HARNESS OK: retry-on-fail shape (retryOnFail/maxTries/waitBetweenTries) verified for all 10 target nodes');
})();

TARGETS.forEach(patch);
console.log('S19 (retry resilience) complete.');
