/**
 * s60_help_text_full_intents.js -- v9 wave Area D: the bot's own /help text
 * documented only 9 of 18 real intents. The 8 missing ones (setup_resume,
 * view_prefs, update_prefs, forget_pref, verbose_toggle, check_resume, costs,
 * jd_paste) had zero documentation anywhere in the repo -- confirmed via grep
 * across every .md file. This is the single highest-leverage doc fix in the
 * whole v9 docs pass for actual end-user discoverability. Also mentions A2's
 * new "newest" sort_by mode inline on the Find Jobs line.
 *
 * No node count change.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const HELP_OLD =
  '👋 *CareerForge — Your AI Job Hunt Assistant*\n\n' +
  "Here's what I can do:\n\n" +
  '🔍 *Find Jobs* — "find ML jobs in NYC"\n' +
  '📄 *Apply* — reply with a job number (e.g. "3") to generate a tailored resume + cover letter\n' +
  '✏️ *Revise* — "make it shorter" / "add more Python"\n' +
  '📊 *Score* — "score my resume" for a fit check\n' +
  '🏢 *Company Intel* — "tell me about Anthropic"\n' +
  '📧 *Outreach* — "find recruiters at Scale AI"\n' +
  '💰 *Salary* — "salary for ML Engineer at Google"\n' +
  '📋 *Track* — "track this application"\n' +
  '📁 *Status* — "show my applications"\n\n' +
  "Just type naturally — I'll figure out what you need!";

const HELP_NEW =
  '👋 *CareerForge — Your AI Job Hunt Assistant*\n\n' +
  "Here's what I can do:\n\n" +
  '🔍 *Find Jobs* — "find ML jobs in NYC" (add "newest" to sort by most recent instead of best match)\n' +
  '📥 *Paste a JD* — paste a full job posting directly, no search needed\n' +
  '📄 *Apply* — reply with a job number (e.g. "3") to generate a tailored resume + cover letter\n' +
  '✏️ *Revise* — "make it shorter" / "add more Python"\n' +
  '📊 *Score* — "score my resume" for a fit check\n' +
  '🏢 *Company Intel* — "tell me about Anthropic"\n' +
  '📧 *Outreach* — "find recruiters at Scale AI"\n' +
  '💰 *Salary* — "salary for ML Engineer at Google"\n' +
  '📋 *Track* — "track this application"\n' +
  '📁 *Status* — "show my applications"\n' +
  '🗂️ *Set Up Resume* — send a resume file, or "set up my resume"\n' +
  '📎 *Check Resume* — "do you have my resume?"\n' +
  '⚙️ *Preferences* — "/prefs" to see what I remember, "remember I need cap-exempt sponsors" to save one, "/prefs forget location" to remove one\n' +
  '🔊 *Verbose Mode* — "/verbose on" to see my search reasoning\n' +
  '💵 *Costs* — "costs" for your API spend\n\n' +
  "Just type naturally — I'll figure out what you need!";

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

  if (!N['Send Help']) { console.error(`INTEGRITY FAIL ${base}: node "Send Help" not found`); process.exit(1); }
  if (N['Send Help'].parameters.text.includes('Set Up Resume')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Send Help'].parameters, 'text', HELP_OLD, HELP_NEW, 'Send Help full intent list', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: /help documents all 18 intents -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  const REQUIRED_INTENTS_TEXT = ['Find Jobs', 'Paste a JD', 'Apply', 'Revise', 'Score', 'Company Intel', 'Outreach', 'Salary', 'Track', 'Status', 'Set Up Resume', 'Check Resume', 'Preferences', 'Verbose Mode', 'Costs'];
  for (const label of REQUIRED_INTENTS_TEXT) {
    if (!HELP_NEW.includes(label)) { console.error(`HARNESS FAIL: new help text missing "${label}"`); process.exit(1); }
  }
  // 15 intent-bullet lines + the title line ("CareerForge — Your AI...") + the
  // closing line ("Just type naturally — ...") both also contain " — ".
  const dashLines = HELP_NEW.split('\n').filter((l) => l.includes(' — '));
  if (dashLines.length !== REQUIRED_INTENTS_TEXT.length + 2) { console.error(`HARNESS FAIL: expected ${REQUIRED_INTENTS_TEXT.length + 2} lines containing " — ", found ${dashLines.length}`); process.exit(1); }
})();

TARGETS.forEach(patch);
console.log('S60 (v9 Area D: /help text documents all 18 intents) complete.');
