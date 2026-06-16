/**
 * s9_polish.js — S9 (part 1): orphan cleanup + central model map.
 *
 * 1) Delete the two nodes left dangling by the S6b-2 2-phase swap:
 *    - Validate Resume Sections (its feeder ResumeForge was deleted; never runs)
 *    - Build Resume LaTeX (superseded by Assemble Resume LaTeX; never runs)
 *    (Simple Memory + sticky notes are left alone — Simple Memory may be wired to an
 *    agent via ai_memory, which the main-connection scan doesn't see.)
 *
 * 2) Central model map: MODEL_MAP is the ONE place every LLM model is defined
 *    (keyed by model-node name). Re-run this script + redeploy to swap any model.
 *    A runtime config node was rejected: both the Telegram and Schedule triggers run
 *    LLM nodes, so a single upstream config node can't be guaranteed before every
 *    model node ($('Load Model Config') would throw on the path where it didn't run).
 *    Current values are kept as-is (no behavior change before the user's smoke test);
 *    the user's preferred cheaper map is documented inline + in the README.
 *
 * Run: node scripts/s9_polish.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ── Central model map (model-node name -> OpenRouter model id) ──
// All ids verified on openrouter.ai, June 2026. To swap a model, edit here + re-run.
// Preferred cheaper alternatives (user's model map) noted per line; opt in by changing
// the value and re-running. JSON-critical roles work well + cheap on deepseek-v4-flash.
const MODEL_MAP = {
  // --- generation (quality) ---
  'Pass2 Model': 'anthropic/claude-sonnet-4.6',          // resume bullet generation
  'Pass2 Regen Model': 'anthropic/claude-sonnet-4.6',    // ATS-retry regeneration
  'OpenRouter Chat Model1': 'anthropic/claude-sonnet-4.6', // ReviseForge
  'Pass1 Model': 'anthropic/claude-haiku-4.5',           // resume selection
  'Cover Pass1 Model': 'anthropic/claude-haiku-4.5',     // cover selection
  'Cover Pass2 Model': 'anthropic/claude-haiku-4.5',     // cover writing
  // --- JSON-utility / structured (already cheap on deepseek) ---
  'Step0 Model': 'deepseek/deepseek-v4-flash',           // JD analysis
  'Extract ATS Model': 'deepseek/deepseek-v4-flash',     // ATS signal extraction
  'CompanyIntel Apply Model': 'deepseek/deepseek-v4-flash', // apply-time intel
  // --- legacy roles (currently gpt-5.4-mini; preferred: deepseek-v4-flash for JSON,
  //     haiku-4.5 for outreach). Kept as-is until the user opts in to avoid changing
  //     the core scoring/intent paths right before testing. ---
  'OpenRouter Chat Model2': 'openai/gpt-5.4-mini',       // Intent Router      (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model12': 'openai/gpt-5.4-mini',      // Expand Query       (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model3': 'openai/gpt-5.4-mini',       // JobScorer          (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model': 'openai/gpt-5.4-mini',        // ScoreOnly          (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model4': 'openai/gpt-5.4-mini',       // SeniorityDetector  (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model5': 'openai/gpt-5.4-mini',       // ForgeScore         (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model11': 'openai/gpt-5.4-mini',      // SalarySummarize    (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model9': 'openai/gpt-5.4-mini',       // CompanyIntel       (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model10': 'openai/gpt-5.4-mini',      // ContactFinder      (pref: deepseek/deepseek-v4-flash)
  'OpenRouter Chat Model8': 'openai/gpt-5.4-mini',       // OutreachWriter     (pref: anthropic/claude-haiku-4.5)
};

const DROP = new Set(['Validate Resume Sections', 'Build Resume LaTeX']);

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);
  let modelEdits = 0, dropped = 0;

  // 1) apply model map
  for (const [nodeName, model] of Object.entries(MODEL_MAP)) {
    if (N[nodeName] && N[nodeName].parameters.model !== model) { N[nodeName].parameters.model = model; modelEdits++; }
  }

  // 2) orphan cleanup
  wf.nodes = wf.nodes.filter((n) => { if (DROP.has(n.name)) { dropped++; return false; } return true; });
  for (const d of DROP) delete C[d];
  // strip any dangling edges pointing at dropped nodes
  for (const obj of Object.values(C)) {
    for (const key of Object.keys(obj)) {
      obj[key] = (obj[key] || []).map((branch) => (branch || []).filter((e) => !DROP.has(e.node)));
    }
  }

  // integrity
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: model map (${modelEdits} changed), orphans dropped (${dropped}) — ${wf.nodes.length} nodes`);
}

TARGETS.forEach(patch);
console.log('S9 (polish) patch complete.');
