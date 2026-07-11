/**
 * s68_seed_workable_recruitee_salesforce.js -- 3 new-opportunity seeds from the
 * issues report:
 *
 * 1. Salesforce -- confirmed reachable via the EXISTING generic Workday adapter,
 *    zero new code. Live-verified this session (real POST to the CXS endpoint,
 *    real response: total 1486, real job titles/locations) -- not guessed from
 *    the brand name, same discipline as the original 5-tenant Workday seed
 *    (which caught 2 wrong guesses that way).
 *
 * 2. Workable & Recruitee -- both adapters (Build Requests' mkUrl.workable /
 *    mkUrl.recruitee) are fully generic and already correct, but had ZERO
 *    seeded companies -- that adapter code has never ingested a single real
 *    job. Found and live-verified 4 real Workable tenants and 5 real Recruitee
 *    tenants this session (WebSearch for real career-page URLs on each
 *    platform, then a live HTTP probe against the real API for every
 *    candidate -- several guessed slugs on both platforms returned a clean
 *    404, confirming guessing from a brand name alone is NOT reliable here,
 *    exactly the same lesson as the Workday precedent).
 *
 * No node count change (registry seeder). Run: inside the n8n container with
 * the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Registry_Seeder.json'),
];

// ═══ Append Salesforce (workday) + 4 Workable + 5 Recruitee, all live-verified ═══
const SEED_OLD =
  "  { name: 'Mastercard', ats_type: 'workday',    slug: 'CorporateCareers',     api_base: 'mastercard.wd1' },\n" +
  "];";
const SEED_NEW =
  "  { name: 'Mastercard', ats_type: 'workday',    slug: 'CorporateCareers',     api_base: 'mastercard.wd1' },\n" +
  "  // s68: Salesforce is reachable via the existing generic Workday adapter --\n" +
  "  // live-verified (real CXS response, total 1486 jobs), zero new code needed.\n" +
  "  { name: 'Salesforce',  ats_type: 'workday',    slug: 'External_Career_Site', api_base: 'salesforce.wd12' },\n" +
  "  // s68: Workable & Recruitee were fully coded, generic, and correctly wired\n" +
  "  // (mkUrl.workable / mkUrl.recruitee both read slug straight from the row,\n" +
  "  // no code changes needed) but had ZERO seeded companies -- these 9 are all\n" +
  "  // live-verified real tenants with real, current job counts (not guessed --\n" +
  "  // several other guessed slugs on both platforms returned a clean 404).\n" +
  "  { name: 'Hugging Face', ats_type: 'workable',  slug: 'huggingface',    api_base: '' },\n" +
  "  { name: 'Skylight',     ats_type: 'workable',  slug: 'skylight-frame', api_base: '' },\n" +
  "  { name: 'WorkMotion',   ats_type: 'workable',  slug: 'workmotion',     api_base: '' },\n" +
  "  { name: 'Curology',     ats_type: 'workable',  slug: 'curology',       api_base: '' },\n" +
  "  { name: 'Tether Operations Limited',  ats_type: 'recruitee', slug: 'tether',             api_base: '' },\n" +
  "  { name: 'Huawei Technologies Canada', ats_type: 'recruitee', slug: 'huaweicanada',       api_base: '' },\n" +
  "  { name: 'Wilcox + Flegel',            ats_type: 'recruitee', slug: 'wilcoxflegel',       api_base: '' },\n" +
  "  { name: 'Great Minds',                ats_type: 'recruitee', slug: 'greatminds',         api_base: '' },\n" +
  "  { name: 'Companion Group',            ats_type: 'recruitee', slug: 'companiongroupltd',  api_base: '' },\n" +
  "];";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patchSeeder(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Build Seed List']) { console.error(`INTEGRITY FAIL ${base}: node "Build Seed List" not found`); process.exit(1); }
  if (N['Build Seed List'].parameters.jsCode.includes('Salesforce')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Seed List'].parameters, 'jsCode', SEED_OLD, SEED_NEW, 'Build Seed List Salesforce+Workable+Recruitee additions', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: 10 new companies seeded (1 workday, 4 workable, 5 recruitee)`);
}

// ── harness ──
(function harness() {
  const fullSeed = new Function(SEED_NEW.replace('];', '];\nreturn SEED;').replace(
    "  { name: 'Mastercard', ats_type: 'workday',    slug: 'CorporateCareers',     api_base: 'mastercard.wd1' },\n",
    "const SEED = [{ name: 'Mastercard', ats_type: 'workday', slug: 'CorporateCareers', api_base: 'mastercard.wd1' },\n"
  ))();
  const newRows = fullSeed.filter((c) => c.name !== 'Mastercard');
  if (newRows.length !== 10) { console.error('HARNESS FAIL: expected exactly 10 new seed rows', newRows.length); process.exit(1); }

  const byType = { workday: 0, workable: 0, recruitee: 0 };
  for (const c of newRows) {
    if (!c.name || !c.ats_type || !c.slug) { console.error('HARNESS FAIL: name/ats_type/slug must be non-empty', c); process.exit(1); }
    if (!(c.ats_type in byType)) { console.error('HARNESS FAIL: unexpected ats_type', c); process.exit(1); }
    byType[c.ats_type]++;
    if (c.ats_type === 'workday' && !/^[\w-]+\.wd\d+$/.test(c.api_base)) { console.error('HARNESS FAIL: workday api_base must match tenant.wdN shape', c); process.exit(1); }
    if (c.ats_type !== 'workday' && c.api_base !== '') { console.error('HARNESS FAIL: workable/recruitee rows should not carry an api_base', c); process.exit(1); }
  }
  if (byType.workday !== 1 || byType.workable !== 4 || byType.recruitee !== 5) { console.error('HARNESS FAIL: wrong per-type counts', byType); process.exit(1); }

  const keys = new Set(newRows.map((c) => c.ats_type + '|' + c.slug.toLowerCase()));
  if (keys.size !== 10) { console.error('HARNESS FAIL: duplicate (ats_type, slug) pairs among new rows', newRows); process.exit(1); }

  console.log('HARNESS OK: 10 new rows -- 1 Workday (Salesforce), 4 Workable, 5 Recruitee -- correct shape, no duplicates');
})();

SEEDER_TARGETS.forEach(patchSeeder);
console.log('S68 (seed Salesforce + 4 Workable + 5 Recruitee, all live-verified) complete.');
