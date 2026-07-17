/**
 * s65_expand_query_model_swap.js -- fixes "AI jobs in Pune" silently failing
 * with "Couldn't figure out what role you're looking for," found in the same
 * live test as s64's dead-link bugs (exec id 337, ~1 min before exec 338).
 *
 * Root-caused with real execution data: Expand Query Model (deepseek/
 * deepseek-v4-flash) produced a PERFECTLY VALID response -- role_families,
 * location_canonical "Pune,Maharashtra,India", everything correct -- but
 * wrapped it in a ```json markdown fence despite the prompt asking for raw
 * JSON. n8n's structured output parser (Expand Query Output Parser) failed
 * to strip the fence and silently returned an EMPTY object instead of
 * throwing (executionStatus: "success", 1ms). Because this doesn't throw,
 * the node's own retryOnFail:true/maxTries:3 never even engaged -- it
 * "succeeded" with garbage on the first attempt. Parse Expand Query then
 * correctly detected the empty upstream and returned the honest-but-
 * misleading "couldn't figure out what role" error.
 *
 * This is the exact same failure class Intent Router hit before (a cheap
 * model's structured-output compliance gap defeating retryOnFail because the
 * failure is silent, not thrown) -- fixed there by moving to a model with
 * strong native tool-calling. Same fix here: Expand Query Model moves from
 * deepseek/deepseek-v4-flash to openai/gpt-5.4-mini, matching Intent Router's
 * already-proven precedent in this exact codebase. Also reinforces the
 * "no markdown" instruction as the prompt's own opening line (was previously
 * only stated once, 77% of the way through a 4188-char prompt) as a cheap
 * complementary safeguard -- not a substitute for the model swap, since the
 * instruction already existed and was still violated.
 *
 * No node count change. Run: inside the n8n container with the repo staged
 * under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Expand Query Model: deepseek-v4-flash -> gpt-5.4-mini (Intent Router's proven fix) ═══
const MODEL_OLD = 'deepseek/deepseek-v4-flash';
const MODEL_NEW = 'openai/gpt-5.4-mini'; // verify this is still current at openrouter.ai/models before reusing elsewhere

// ═══ 2. Expand Query prompt: emphatic no-markdown instruction as the opening line ═══
const PROMPT_OLD = "You are a job search intent extractor. Given a user's job search message, extract structured search parameters as strict JSON. Merge with any user preferences provided in the context.";
const PROMPT_NEW = "Return ONLY raw JSON -- no ```json code fences, no markdown, no preamble or explanation before or after the JSON object.\n\nYou are a job search intent extractor. Given a user's job search message, extract structured search parameters as strict JSON. Merge with any user preferences provided in the context.";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Expand Query Model'] || !N['Expand Query']) { console.error(`INTEGRITY FAIL ${base}: Expand Query nodes not found`); process.exit(1); }
  if (N['Expand Query Model'].parameters.model === MODEL_NEW) { console.log(`  ${base}: already patched`); return; }

  if (N['Expand Query Model'].parameters.model !== MODEL_OLD) {
    console.error(`INTEGRITY FAIL ${base}: Expand Query Model's current model is "${N['Expand Query Model'].parameters.model}", expected "${MODEL_OLD}"`);
    process.exit(1);
  }
  N['Expand Query Model'].parameters.model = MODEL_NEW;
  replaceOnce(N['Expand Query'].parameters.messages.messageValues[0], 'message', PROMPT_OLD, PROMPT_NEW, 'no-markdown opening line', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Expand Query Model swapped to ${MODEL_NEW}, prompt reinforced -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  if (MODEL_NEW !== 'openai/gpt-5.4-mini') { console.error('HARNESS FAIL: unexpected target model'); process.exit(1); }
  if (!PROMPT_NEW.startsWith('Return ONLY raw JSON')) { console.error('HARNESS FAIL: no-markdown instruction must be the prompt\'s opening line'); process.exit(1); }
  if (!PROMPT_NEW.includes(PROMPT_OLD)) { console.error('HARNESS FAIL: original prompt content must be preserved, not replaced'); process.exit(1); }
  console.log('HARNESS OK: model target confirmed, no-markdown instruction is the prompt\'s new opening line, original content preserved');
})();

TARGETS.forEach(patch);
console.log('S61 (Expand Query: model swap to gpt-5.4-mini + reinforced no-markdown instruction) complete.');
