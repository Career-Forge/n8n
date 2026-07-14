/**
 * s81_cohort_vocabulary.js -- bakes the user's cohort definitions into the
 * Expand Query prompt so "MAANGO" et al expand to HIS lists, not the model's
 * guess. Evidence (execs 582/584, 2026-07-14): "MAANGO"/"MAANGO-style" both
 * expanded to plain MAANG [Meta, Amazon, Apple, Netflix, Google], while the
 * user's MAANGO = Meta, Anthropic, Amazon, Nvidia, Google, OpenAI -- and the
 * cache held Nvidia 25 / OpenAI 25 / Anthropic 25 active jobs that were never
 * targeted. Cohort table user-confirmed 2026-07-14 (AskUserQuestion):
 * MAANGO, pinned MAANG/FAANG, high-paying fintech, Big 4, and a "dream
 * companies" alias resolving to the 36 dream-tier names taken VERBATIM from
 * the Registry Seeder's Build Seed List (the git-tracked source of curated
 * truth since s78). "SpaceX" and "SpaceX Global" both listed -- s80's cache
 * SQL matches names exactly, so each board needs its own entry.
 *
 * Prompt-only change (all 3 master mirrors); the deploy step separately
 * proves via read-only psql that every cache-servable table name resolves
 * against live registry companies.name case-insensitively.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// Verbatim from Registry Seeder Build Seed List (s78), sorted:
const DREAM_36 = ["Airbnb","Amazon","Anthropic","Apple","Barclays","Bloomberg","Citigroup","Cloudflare","Coinbase","DoorDash","Figma","GEICO","IBM","Instacart","Jane Street","LinkedIn","Mastercard","Morgan Stanley","Netflix","Notion","Nvidia","OpenAI","Palantir","Perplexity","Point72","Reddit","Robinhood","Salesforce","SpaceX","SpaceX Global","Spotify","Target","Two Sigma","Visa","Walmart","xAI"];

const ANCHOR = '- target_companies: if company_cohort is set, list the actual company names you know belong to it (e.g. FAANG -> ["Meta","Amazon","Apple","Netflix","Google"]); else [].';
const COHORT_BLOCK = ANCHOR + '\n' +
  '  COHORT DEFINITIONS (exact lookup -- these ALWAYS override your own knowledge; match the cohort name case-insensitively, including suffixed forms like "MAANGO-style" or "MAANG companies"; cohorts NOT listed here resolve from your own knowledge as before):\n' +
  '  * MAANGO = ["Meta","Anthropic","Amazon","Nvidia","Google","OpenAI"]\n' +
  '  * MAANG or FAANG = ["Meta","Apple","Amazon","Netflix","Google"]\n' +
  '  * high-paying fintech / fintech giants / top fintech = ["Barclays","Bloomberg","JPMorgan Chase","Morgan Stanley","Citigroup","Two Sigma","Visa","Mastercard","Jane Street","Point72"]\n' +
  '  * Big 4 = ["Deloitte","EY","KPMG","PwC"]\n' +
  '  * dream companies / dream tier / my dream companies = ' + JSON.stringify(DREAM_36) + '\n' +
  '    (dream list source: Registry Seeder "Build Seed List" -- update this line when the dream tier changes)';

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  if (!N['Expand Query']) { console.error(`INTEGRITY FAIL ${base}: Expand Query not found`); process.exit(1); }
  const mv = N['Expand Query'].parameters.messages.messageValues;
  if (mv[0].message.includes('COHORT DEFINITIONS')) { console.log(`  ${base}: already patched`); return; }
  replaceOnce(mv[0], 'message', ANCHOR, COHORT_BLOCK, 'cohort definitions block', base);
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: cohort vocabulary table inserted -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (DREAM_36.length !== 36) { console.error(`HARNESS FAIL: dream list has ${DREAM_36.length} names, expected 36`); process.exit(1); }
  if (new Set(DREAM_36.map((s) => s.toLowerCase())).size !== 36) { console.error('HARNESS FAIL: duplicate dream names'); process.exit(1); }
  for (const must of ['MAANGO', 'Anthropic', 'Nvidia', 'OpenAI', 'Big 4', 'JPMorgan Chase', 'SpaceX Global']) {
    if (!COHORT_BLOCK.includes(must)) { console.error(`HARNESS FAIL: "${must}" missing from cohort block`); process.exit(1); }
  }
  // MAANGO must NOT contain Apple/Netflix (the user's definition, not MAANG's)
  const maangoLine = COHORT_BLOCK.split('\n').find((l) => l.includes('* MAANGO'));
  if (maangoLine.includes('Apple') || maangoLine.includes('Netflix')) { console.error('HARNESS FAIL: MAANGO contaminated with MAANG members'); process.exit(1); }
  console.log('HARNESS OK: 36-name dream list intact and deduped, MAANGO is the user definition (no Apple/Netflix), all cohort keys present.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S81 (cohort vocabulary table) complete.');
