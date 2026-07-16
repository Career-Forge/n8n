/**
 * s101_timing_copy_fixes.js -- fixes 2 stale timing estimates in bot-facing
 * text, found during a doc/copy audit. Both nodes ack the SAME multi-pass
 * apply pipeline (Retrieve Job -> Prepare Job Context -> SeniorityDetector/
 * ForgeScore -> Pass1/Step0/Pass2 -> Extract ATS Signals/Calculate ATS Score
 * -> conditional Pass2 Regen -> Cover Pass1/Pass2 -> PDF compile/merge/send)
 * -- confirmed by the user's own real-world testing: this takes ~5 minutes
 * end to end, not the 45sec/1min the copy originally guessed.
 *
 * Send JD Contacts Ack's "~30 sec" claim is a SEPARATE, untested flow
 * (outreach/contact-finding) -- deliberately NOT touched here until the user
 * has a real number for it.
 *
 * No node count change (2 existing nodes). Run: inside the n8n container
 * with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const APPLY_ACK_OLD = '⚙️ *Generating your tailored resume + cover letter...* (~45 sec)';
const APPLY_ACK_NEW = '⚙️ *Generating your tailored resume + cover letter...* (~5 min)';

const JD_GENERATE_ACK_OLD = '⚙️ *Generating your tailored resume + cover letter from the pasted JD...* (~1 min)';
const JD_GENERATE_ACK_NEW = '⚙️ *Generating your tailored resume + cover letter from the pasted JD...* (~5 min)';

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Send Apply Ack'] || !N['Send JD Generate Ack']) { console.error(`INTEGRITY FAIL ${base}: required node missing`); process.exit(1); }
  if (N['Send Apply Ack'].parameters.text.includes('~5 min')) { console.log(`  ${base}: already patched`); return; }

  if (N['Send Apply Ack'].parameters.text !== APPLY_ACK_OLD) { console.error(`INTEGRITY FAIL ${base}: Send Apply Ack text doesn't match expected anchor`); process.exit(1); }
  N['Send Apply Ack'].parameters.text = APPLY_ACK_NEW;

  if (N['Send JD Generate Ack'].parameters.text !== JD_GENERATE_ACK_OLD) { console.error(`INTEGRITY FAIL ${base}: Send JD Generate Ack text doesn't match expected anchor`); process.exit(1); }
  N['Send JD Generate Ack'].parameters.text = JD_GENERATE_ACK_NEW;

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: apply-flow timing acks corrected to ~5 min -- ${wf.nodes.length} nodes`);
}

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
