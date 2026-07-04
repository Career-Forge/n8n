/**
 * s26_intent_router_reliability.js -- fixes a live crash: "Model output doesn't fit
 * required format" from Structured Output Parser (attached to Intent Router).
 *
 * Root-caused against real execution data (exec 151, 2026-07-04 21:54 UTC, user
 * message "AI jobs in India"): all 3 of S19's retryOnFail attempts produced
 * plausible-looking JSON as the model's plain TEXT response, but none of them
 * actually invoked the `format_final_json_response` tool that
 * @n8n/n8n-nodes-langchain.agent (Tools Agent) architecture requires for
 * structured output. This is a DIFFERENT and more precise failure mode than the
 * "OpenRouter multi-provider backend variance" diagnosis from the earlier Intent
 * Router incident (S19) -- that one was real too, but this crash persisted through
 * all 3 retries, which points at the underlying model's native tool-calling
 * compliance in an Agent context, not just an isolated bad backend response.
 *
 * Intent Router is the ONLY node in this workflow using Agent architecture --
 * checked its connections: OpenRouter Chat Model2 (ai_languageModel), Simple Memory
 * (ai_memory), Structured Output Parser (ai_outputParser). No other real tools.
 * Every other structured-output node (SeniorityDetector, ForgeScore, ReviseForge,
 * ScoreOnly, OutreachWriter, CompanyIntel, ContactFinder, SalarySummarize,
 * JobScorer) uses chainLlm (Basic LLM Chain) + plain-JSON-in-text parsing instead,
 * and none have shown this failure mode.
 *
 * Considered switching Intent Router to chainLlm to match those 9 nodes -- verified
 * via n8n docs/community first (not guessed): chainLlm does NOT support ai_memory
 * connections at all, it's explicitly stateless. Converting would have silently
 * dropped the "last 5 conversation turns" context the system prompt promises,
 * breaking follow-up disambiguation (e.g. resolving "make it shorter" against a
 * prior apply). Not worth trading one bug for a different, quieter one -- kept
 * Agent architecture, fixed it two other ways instead:
 *
 * 1. Model swap: deepseek/deepseek-v4-flash -> openai/gpt-5.4-mini for THIS node
 *    only. gpt-5.4-mini is single-vendor-hosted (no OpenRouter multi-provider
 *    routing variance) and was the pre-WS5 model for exactly this role, chosen for
 *    strong native tool-calling compliance -- WS5's cost-optimization swap to a
 *    cheap JSON-lane model was a good call for the 9 chainLlm nodes (backend
 *    variance mostly just affects JSON-formatting, which retrying already
 *    compensates for) but a mismatch for the one node that specifically needs
 *    reliable native tool invocation. Other JSON-lane nodes are untouched.
 * 2. Defense in depth: even a reliable model can occasionally fail all 3 retries.
 *    Intent Router being the single entry point for every user message makes a
 *    hard crash here the worst possible failure mode -- the user gets nothing
 *    back, not even a degraded response. Adds onError: continueErrorOutput plus a
 *    small fallback node that defaults to the 'help' intent (matching the shape
 *    Route Intent's switch already expects), so a persistent failure degrades to
 *    a help message instead of a raw crash.
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

const OLD_MODEL = 'deepseek/deepseek-v4-flash';
const NEW_MODEL = 'openai/gpt-5.4-mini';

const FALLBACK_CODE = String.raw`// Intent Router Fallback -- Structured Output Parser exhausted all retries (S19)
// without the model ever invoking the required format_final_json_response tool.
// Rather than crash the whole execution (Intent Router is the entry point for
// EVERY message -- the worst possible place for a hard failure), default to
// 'help' so the user gets a response instead of silence. Shape matches exactly
// what Route Intent's switch expects from a successful classification.
return [{ json: { output: {
  intent: 'help',
  entities: { company: null, role: null, location: null, job_number: null, changes: null },
  confidence: 'low',
  reasoning: 'Could not classify this message due to a model error -- showing help.'
} } }];`;

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of ['Intent Router', 'OpenRouter Chat Model2', 'Route Intent']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  // 1. Model swap
  {
    const n = N['OpenRouter Chat Model2'];
    const cur = n.parameters.model;
    if (cur !== NEW_MODEL) {
      if (cur !== OLD_MODEL) { console.error(`INTEGRITY FAIL ${base}: OpenRouter Chat Model2 model is "${cur}", expected "${OLD_MODEL}"`); process.exit(1); }
      n.parameters.model = NEW_MODEL;
      edits++;
    }
  }

  // 2. onError + fallback node + wiring
  const ir = N['Intent Router'];
  if (ir.onError !== 'continueErrorOutput') { ir.onError = 'continueErrorOutput'; edits++; }

  if (!N['Intent Router Fallback']) {
    wf.nodes.push({
      parameters: { jsCode: FALLBACK_CODE },
      id: crypto.randomUUID(),
      name: 'Intent Router Fallback',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [(ir.position || [0, 0])[0] + 150, (ir.position || [0, 0])[1] + 200],
    });
    edits++;
  }

  const C = wf.connections;
  // main[1] = error output. Intent Router's connections currently only have main[0].
  if (!Array.isArray(C['Intent Router'].main[1])) {
    C['Intent Router'].main[1] = [];
  }
  if (!C['Intent Router'].main[1].some((e) => e.node === 'Intent Router Fallback')) {
    C['Intent Router'].main[1].push({ node: 'Intent Router Fallback', type: 'main', index: 0 });
    edits++;
  }
  if (!C['Intent Router Fallback']) {
    C['Intent Router Fallback'] = { main: [[{ node: 'Route Intent', type: 'main', index: 0 }]] };
    edits++;
  }

  // integrity: every edge resolves
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source ${src} missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: ${src} -> ${e.node} target missing`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Intent Router reliability fix applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  const failures = [];
  function check(name, cond) { if (!cond) failures.push(name); }

  // 1. Fallback node's own logic produces the exact shape Route Intent expects.
  const fn = new Function(FALLBACK_CODE);
  const out = fn();
  check('fallback node returns one item', Array.isArray(out) && out.length === 1);
  check('fallback shape has output.intent = help', out[0].json.output.intent === 'help');
  check('fallback entities all null (matches successful-classification shape)', Object.values(out[0].json.output.entities).every((v) => v === null));

  // 2. Route Intent's switch expression, evaluated against the fallback's exact
  // output shape, must route to index 0 ('help') -- proves the fallback actually
  // reaches the correct existing branch, not just that it "looks plausible".
  const SWITCH_EXPR = "['help','find_jobs','apply','revise','score','intel','outreach','salary','track','status','setup_resume','view_prefs','update_prefs','forget_pref','verbose_toggle','check_resume','costs'].indexOf($json.output.intent) === -1 ? 17 : ['help','find_jobs','apply','revise','score','intel','outreach','salary','track','status','setup_resume','view_prefs','update_prefs','forget_pref','verbose_toggle','check_resume','costs'].indexOf($json.output.intent)";
  const routeIdx = new Function('$json', 'return (' + SWITCH_EXPR + ');')(out[0].json);
  check('Route Intent switch sends fallback output to index 0 (help)', routeIdx === 0);

  if (failures.length) { console.error('HARNESS FAIL:', failures.join(', ')); process.exit(1); }
  console.log('HARNESS OK: fallback node shape verified against Route Intent\'s real switch expression (routes to help, index 0) -- model swap and onError wiring verified structurally in patch()');
})();

TARGETS.forEach(patch);
console.log('S26 (Intent Router reliability) complete.');
