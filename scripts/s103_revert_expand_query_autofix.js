/**
 * s103_revert_expand_query_autofix.js -- reverts the 2 Expand Query changes
 * from s102 (Auto-Fix Format on the output parser + the "don't wrap in
 * output" prompt line). Live exec 701 (post-s102-deploy) shows Expand Query
 * Output Parser STILL erroring -- Auto-Fix Format papered over a symptom
 * (the model's response shape) instead of the real bug: scheduled ticks
 * feed Expand Query a null message_text (see Schedule Tick/Schedule Gate/
 * Schedule Payload), which is what pushes the model into malformed output
 * in the first place. That root cause needs its own investigation and a
 * separate, approved fix -- this script only undoes the wrong patch.
 *
 * s102's OTHER two fixes (Prepare Research isExecuted rewrite + Telegram
 * retryOnFail on all 49 nodes) are untouched -- not implicated in this
 * failure, not in scope for this revert.
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

const PROMPT_NEW = 'Return ONLY raw JSON -- no ```json code fences, no markdown, no preamble or explanation before or after the JSON object. The JSON object\'s top-level keys must be exactly the schema fields themselves (role_families, excluded_roles, etc.) -- do NOT wrap the object in an extra key like "output" or "result".\n\nYou are a job search intent extractor.';
const PROMPT_OLD = 'Return ONLY raw JSON -- no ```json code fences, no markdown, no preamble or explanation before or after the JSON object.\n\nYou are a job search intent extractor.';

function replaceOnce(val, oldStr, newStr, label) {
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: expected exactly 1 match for ${label}, found ${count}`); process.exit(1); }
  return val.split(oldStr).join(newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Expand Query Output Parser'] || !N['Expand Query']) { console.error(`INTEGRITY FAIL ${base}: required node missing`); process.exit(1); }

  const alreadyReverted = N['Expand Query Output Parser'].parameters.autoFix !== true;
  if (alreadyReverted) { console.log(`  ${base}: already reverted`); return; }

  N['Expand Query Output Parser'].parameters.autoFix = false;

  const mv = N['Expand Query'].parameters.messages.messageValues;
  mv[0].message = replaceOnce(mv[0].message, PROMPT_NEW, PROMPT_OLD, 'Expand Query prompt header');

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Expand Query autoFix + prompt line reverted -- ${wf.nodes.length} nodes`);
}

console.log('Reverting s102 Expand Query changes...');
for (const t of TARGETS) patch(t);
console.log('Done.');
