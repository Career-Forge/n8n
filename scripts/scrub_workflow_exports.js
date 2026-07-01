/**
 * scrub_workflow_exports.js -- repeatable pre-commit scrub for workflow JSON exports.
 *
 * n8n bakes instance runtime + owner identity into an exported workflow:
 *   - staticData.global  -> last_search_intent, last_resume_structured (the user's resume!),
 *                           last_apply, prefs, etc.
 *   - shared             -> project owner ("Name <email>")
 *   - pinData / meta      -> pinned run data + instance fingerprint (instanceId)
 * None of that belongs in a committed repo (the repo is shareable). This strips it.
 *
 * It removes ONLY top-level runtime/identity containers. It NEVER edits node
 * parameters -- tokens like `last_apply` / `resume_text` / `chat_id` also appear as
 * jsCode variable names / Telegram expressions, which are workflow logic, not data.
 *
 * Idempotent. Run:  node scripts/scrub_workflow_exports.js   (scrubs the 3 modern exports)
 *                   node scripts/scrub_workflow_exports.js --scan   (scan only, no write)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
];

// Top-level keys that carry instance runtime / owner identity -> removed on scrub.
const STRIP_NULL = ['staticData'];          // -> null (n8n's own "empty" shape)
const STRIP_EMPTY = ['pinData'];            // -> {}
const STRIP_DELETE = ['shared', 'meta', 'versionMetadata'];  // owner email + instance fingerprint

// Tokens to verify after scrubbing. Real leaks live in staticData/shared; anything
// remaining is expected to be node jsCode (a variable/key name), reported as such.
const SCAN = ['Pranav', 'pkowadkar', 'pk.kowadkar', '973', '727', 'last_resume_structured',
  'last_apply', 'resume_text', 'job_description', 'chat_id', 'last_search_intent', 'user_prefs'];

function countTok(str, tok) {
  return (str.match(new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

// Where does a token survive? Returns 'node-code' (in some node.parameters) or 'OTHER (leak?)'.
function classifyRemaining(wf, tok) {
  let inNodes = 0, inOther = 0;
  for (const n of wf.nodes || []) inNodes += countTok(JSON.stringify(n.parameters || {}), tok);
  const shell = { ...wf, nodes: undefined };
  inOther = countTok(JSON.stringify(shell), tok);
  if (inOther > 0) return `OTHER x${inOther} (REVIEW)` + (inNodes ? ` + node-code x${inNodes}` : '');
  if (inNodes > 0) return `node-code x${inNodes} (harmless: jsCode/expression)`;
  return 'gone';
}

const scanOnly = process.argv.includes('--scan');
let anyLeak = false;

for (const file of TARGETS) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + path.relative(ROOT, file)); continue; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.relative(ROOT, file);

  if (!scanOnly) {
    for (const k of STRIP_NULL) if (k in wf) wf[k] = null;
    for (const k of STRIP_EMPTY) if (k in wf) wf[k] = {};
    for (const k of STRIP_DELETE) delete wf[k];
    fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  }

  console.log('\n=== ' + base + (scanOnly ? '  (scan only)' : '  (scrubbed)') + ' ===');
  console.log('  staticData:', wf.staticData === null ? 'null' : typeof wf.staticData,
    '| pinData:', JSON.stringify(wf.pinData), '| shared:', 'shared' in wf ? 'PRESENT' : 'removed',
    '| meta:', 'meta' in wf ? 'PRESENT' : 'removed');
  for (const tok of SCAN) {
    const where = classifyRemaining(wf, tok);
    if (where.includes('REVIEW')) anyLeak = true;
    console.log('  ' + tok.padEnd(24) + ' -> ' + where);
  }
}

console.log('\n' + (anyLeak ? 'WARNING: tokens survive OUTSIDE node code -- review above.' : 'OK: no runtime/PII leaks outside node code.'));
