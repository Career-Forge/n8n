/**
 * s56_pass2_regen_prompt_sync.js -- re-sync Pass2 Regen's system prompt to
 * byte-match Pass2 Generate's.
 *
 * The two were byte-identical siblings by design (all regen-specific
 * guidance lives in the USER message built by Build Pass2 Regen Input, not
 * the system prompt). s44/s47 updated Pass2 Generate's prompt to the
 * tier-dependent bullet-length policy (130-165 chars mid/senior, keyword-
 * aware ~210 combined ceiling, BULLET COUNT MANDATORY section) but never
 * touched Pass2 Regen -- so ATS-retry regenerations were still writing to
 * the OLD "MAX 110 characters" policy, producing shorter bullets on exactly
 * the pass meant to IMPROVE the resume. Caught by the s56 drift-checker
 * expansion on its very first run.
 *
 * Fix: copy the sibling verbatim (not re-derive) -- one source of truth.
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

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const need of ['Pass2 Generate', 'Pass2 Regen']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  const gen = N['Pass2 Generate'].parameters.messages.messageValues[0].message;
  const regen = N['Pass2 Regen'].parameters.messages.messageValues[0].message;
  if (gen === regen) { console.log(`  ${base}: already in sync`); return; }
  // sanity: the generate side must carry the NEW policy (we sync regen TO it, never backwards)
  if (!gen.includes('130-165 characters') || gen.includes('hard-capped at 110')) {
    console.error(`INTEGRITY FAIL ${base}: Pass2 Generate does not carry the expected new policy -- refusing to sync`); process.exit(1);
  }
  if (!regen.includes('110')) {
    console.error(`INTEGRITY FAIL ${base}: Pass2 Regen's divergence is not the expected old-110 policy -- investigate before syncing`); process.exit(1);
  }
  N['Pass2 Regen'].parameters.messages.messageValues[0].message = gen;
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Pass2 Regen prompt re-synced to Pass2 Generate (byte-identical)`);
}

// ── harness ──
(function harness() {
  const file = TARGETS.find((f) => fs.existsSync(f));
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const gen = N['Pass2 Generate'].parameters.messages.messageValues[0].message;
  const regen = N['Pass2 Regen'].parameters.messages.messageValues[0].message;
  // prove the drift is exactly the expected one: generate has the new policy, regen the old
  if (gen === regen) { console.log('HARNESS: already in sync -- nothing to prove'); return; }
  if (!gen.includes('130-165 characters')) { console.error('HARNESS FAIL: generate side missing new policy'); process.exit(1); }
  if (!regen.includes('hard-capped at 110') && !regen.includes('MAX 110')) { console.error('HARNESS FAIL: regen divergence is not the expected old policy:', regen.slice(0, 200)); process.exit(1); }
  console.log('HARNESS OK: confirmed the drift is exactly the s44/s47 policy update that skipped the regen sibling -- syncing regen to generate is the correct direction');
})();

TARGETS.forEach(patch);
console.log('S56 (Pass2 Regen prompt re-sync) complete.');
