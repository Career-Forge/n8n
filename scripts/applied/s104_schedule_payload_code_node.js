/**
 * s104_schedule_payload_code_node.js -- fixes the actual root cause behind
 * Expand Query's scheduled-tick "Model output doesn't fit required format"
 * failures (s102's Auto-Fix Format patch was reverted in s103 as the wrong
 * layer -- this is the real fix).
 *
 * Schedule Payload was a Set node calling $getWorkflowStaticData('global')
 * directly inside {{ }} field expressions for chat_id, message_text, and
 * user_prefs_snapshot -- the ONLY place in this entire 302-node workflow
 * that pattern is used (every other static-data read happens inside a Code
 * node, confirmed reliable throughout this codebase -- Schedule Gate,
 * Prepare Research, Parse Expand Query, etc).
 *
 * Pulled the real resolved output of Schedule Payload from a live failing
 * scheduled execution (id 687): {"chat_id":null,"message_text":null,
 * "source":"schedule","intent_override":"find_jobs","user_prefs_snapshot":
 * null} -- while the literal-string fields (source, intent_override)
 * resolved fine. Confirmed live static data actually HAS a populated
 * user_prefs object (location_canonical: "belagavi", real _history), so
 * the null isn't "prefs are missing" -- the $getWorkflowStaticData(...)...
 * call pattern itself silently fails inside a Set-node expression field.
 * Downstream, Expand Query's prompt became the literal string
 * "Query: null\n\nUser preferences: null..." -- a degenerate input that
 * lines up with why the model started wrapping its JSON in a spurious
 * {"output": {...}} envelope specifically on scheduled runs.
 *
 * Fix: convert Schedule Payload from a Set node to a Code node with the
 * exact same output shape and fallback defaults, just reading static data
 * the way every other node in this workflow already does successfully.
 *
 * Node count unchanged (in-place type conversion, same node name/id/
 * position). Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const NEW_JS_CODE = `// Schedule Payload
// s104: was a Set node calling $getWorkflowStaticData() directly inside
// {{ }} field expressions -- the only place in this workflow doing that.
// On scheduled runs those expressions silently resolved to null (confirmed
// via real execution data) even though user_prefs genuinely exists with
// real content, which fed Expand Query a literal "Query: null" prompt.
// Converted to a Code node -- same output shape, same fallback defaults,
// off the fragile expression path.
const sd = $getWorkflowStaticData('global');
const prefs = sd.user_prefs || {};
const chat_id = prefs.owner_chat_id || '6805613388';
const message_text = prefs.schedule_query || 'find me AI Engineer jobs';
return [{ json: {
  chat_id,
  message_text,
  source: 'schedule',
  intent_override: 'find_jobs',
  user_prefs_snapshot: JSON.stringify(prefs),
} }];`;

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  const node = N['Schedule Payload'];
  if (!node) { console.error(`INTEGRITY FAIL ${base}: Schedule Payload missing`); process.exit(1); }

  if (node.type === 'n8n-nodes-base.code') { console.log(`  ${base}: already converted`); return; }

  if (node.type !== 'n8n-nodes-base.set') { console.error(`INTEGRITY FAIL ${base}: Schedule Payload is not the expected Set node (found ${node.type})`); process.exit(1); }

  node.type = 'n8n-nodes-base.code';
  node.typeVersion = 2;
  node.parameters = { jsCode: NEW_JS_CODE };

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Schedule Payload converted from Set to Code node -- ${wf.nodes.length} nodes`);
}

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
