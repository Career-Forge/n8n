/**
 * validate_workflow_scrub.js -- P0.7 read-only guard against PII / personal defaults
 * baked into EMBEDDED NODE LOGIC of the 3 modern workflow exports.
 *
 * Complements scripts/scrub_workflow_exports.js (which strips staticData/shared/pinData):
 * this catches personal literals hardcoded inside node parameters/expressions, which a
 * staticData scrub does NOT remove. Specifically forbids:
 *   - the owner's literal Telegram chat id (6805613388)
 *   - any `owner_chat_id || '<digits>'` / "<digits>" fallback (must be fail-closed: || '')
 *   - owner name/email PII literals (pkowadkar / pk.kowadkar / "Pranav Kowadkar")
 * NOTE: the bare token `chat_id` is NOT flagged -- it is legitimate Telegram node logic
 * ($json.message.chat.id); only personal LITERALS are.
 *
 * Read-only. Exits 0 if clean; nonzero naming the file (and node) on any hit.
 * Run:  node scripts/validate_workflow_scrub.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXPORTS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
];

// (label, regex). Each must NEVER appear in a modern export.
const FORBIDDEN = [
  ['owner Telegram chat id literal', /6805613388/],
  ['owner_chat_id digit fallback', /owner_chat_id\s*\|\|\s*['"]\s*\d+\s*['"]/],
  ['owner email/handle PII', /pk\.?kowadkar/i],
  ['owner name PII', /Pranav\s+Kowadkar/i],
];

const failures = [];

function nodeOf(wf, hayIndexFinder) {
  // best-effort: which node's parameters contain the match
  for (const n of wf.nodes || []) {
    if (hayIndexFinder(JSON.stringify(n.parameters || {}))) return n.name;
  }
  return null;
}

for (const file of EXPORTS) {
  const rel = path.relative(ROOT, file);
  if (!fs.existsSync(file)) { failures.push(rel + ': MISSING'); console.log('FAIL ' + rel + ' (missing)'); continue; }
  const raw = fs.readFileSync(file, 'utf8');
  let wf = null;
  try { wf = JSON.parse(raw); } catch (e) { failures.push(rel + ': JSON parse error'); console.log('FAIL ' + rel + ' (parse: ' + e.message + ')'); continue; }

  let fileHits = 0;
  for (const [label, rx] of FORBIDDEN) {
    if (rx.test(raw)) {
      fileHits++;
      const node = nodeOf(wf, (s) => rx.test(s));
      const where = node ? (' :: node "' + node + '"') : ' (outside node params)';
      failures.push(rel + where + ' -> ' + label);
      console.log('FAIL ' + rel + where + ' -> ' + label + '  /' + rx.source + '/');
    }
  }

  // Positive assertion: the Schedule Payload chat id expression is fail-closed.
  const sp = (wf.nodes || []).find((n) => n.name === 'Schedule Payload');
  if (sp) {
    const sps = JSON.stringify(sp.parameters || {});
    const m = sps.match(/owner_chat_id\s*\|\|\s*[^,}]*/);
    const expr = m ? m[0].replace(/\\+/g, '') : '(owner_chat_id fallback not found)';
    const failClosed = /owner_chat_id\s*\|\|\s*['"]['"]/.test(sps) || !/owner_chat_id/.test(sps);
    console.log((failClosed && fileHits === 0 ? 'OK   ' : 'WARN ') + rel + ' :: Schedule Payload -> ' + expr.slice(0, 70));
    if (!failClosed) failures.push(rel + ' :: Schedule Payload owner_chat_id fallback is not fail-closed');
  }
}

console.log('');
if (failures.length) {
  console.log('SCRUB GUARD FAIL (' + failures.length + '):');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('SCRUB GUARD OK -- no personal literals / chat-id defaults in the 3 modern exports.');
process.exit(0);
