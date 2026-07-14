/**
 * s78_dream_tier_reproducibility.js -- makes the dream tier reproducible from
 * git. Audit (2026-07-14, live Postgres vs Build Seed List) found 22+ dream
 * rows that exist ONLY in the live DB: the s70 19-company backfill, the
 * Amazon/Apple promotions, and the LinkedIn/Netflix rows were all one-off SQL
 * run directly against Postgres -- a fresh clone (CSV bulk import + seeder
 * run) would come up with a dream tier missing most of its members.
 *
 * Fix: the Registry Seeder becomes the single git-tracked source of curated
 * truth. Two kinds of change to Build Seed List:
 *   (a) tier: 'dream' added to 10 EXISTING rows (Figma, OpenAI, Notion, IBM,
 *       Spotify, Mastercard, Visa, Walmart, Target, Salesforce) -- the
 *       seeder's conflict policy (s70) is promote-only, so re-running can
 *       promote these but never demote anything.
 *   (b) 12 NEW rows appended (Amazon, Apple, Netflix/eightfold, Airbnb,
 *       Cloudflare, Coinbase, DoorDash, Instacart, Reddit, Robinhood,
 *       Palantir, LinkedIn) with tier: 'dream' -- names/slugs/api_base taken
 *       verbatim from tonight's live-DB audit, not from memory.
 *
 * BONUS BUG the audit surfaced: **Thomson Reuters is tier='dream' in the live
 * DB** -- an accident of the s74 corruption fix (the row spent weeks
 * mislabeled "Salesforce" and was dream-promoted under that name in s70; s74
 * restored the name but the tier stayed). TR was never an intended dream
 * company. Demoted to 'probe' via direct SQL as part of this deploy
 * (documented here, run alongside -- tier never demotes through any workflow
 * path by design, so SQL is the only lever):
 *   UPDATE companies SET tier='probe'
 *    WHERE ats_type='workday' AND slug='External_Career_Site'
 *      AND api_base='thomsonreuters.wd5' AND tier='dream';
 * AND the same accident hit Intel (workday/External/intel.wd1) -- its row was
 * mislabeled Morgan Stanley (s71) then GEICO (s73) and dream-promoted under
 * those names; s74 restored the name, the tier stayed. Also demoted:
 *   UPDATE companies SET tier='probe'
 *    WHERE ats_type='workday' AND slug='External'
 *      AND api_base='intel.wd1' AND tier='dream';
 * Post-demote intended dream tier: exactly 36 rows, all seeder-reproducible.
 *
 * Audit-keying note: post-s74 the registry key is (ats_type, slug, api_base)
 * -- an (ats_type, slug)-keyed diff silently collapses Salesforce/Thomson
 * Reuters (both workday/External_Career_Site) and GEICO/Morgan Stanley (both
 * workday/External). The first audit pass did exactly that and hid the
 * Salesforce gap; this script's harness keys on all three columns.
 *
 * NOT changed: data/registry_import/ stays the June-12 bulk snapshot it is
 * (a provenance README is added beside it separately). The full live registry
 * is exported as a LOCAL, gitignored backup -- publishing 15.6K rows with
 * tier labels to the public repo is the user's call, not this script's.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Registry_Seeder.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// (a) tier: 'dream' onto existing rows -- anchors are the EXACT current lines.
const TIER_UPDATES = [
  ["{ name: 'Figma',      ats_type: 'greenhouse', slug: 'figma',      api_base: '' }",
   "{ name: 'Figma',      ats_type: 'greenhouse', slug: 'figma',      api_base: '', tier: 'dream' }"],
  ["{ name: 'OpenAI',     ats_type: 'ashby',      slug: 'openai',     api_base: '' }",
   "{ name: 'OpenAI',     ats_type: 'ashby',      slug: 'openai',     api_base: '', tier: 'dream' }"],
  ["{ name: 'Notion',     ats_type: 'ashby',      slug: 'notion',     api_base: '' }",
   "{ name: 'Notion',     ats_type: 'ashby',      slug: 'notion',     api_base: '', tier: 'dream' }"],
  ["{ name: 'IBM', ats_type: 'avature', slug: 'ibmglobal', api_base: 'careers' }",
   "{ name: 'IBM', ats_type: 'avature', slug: 'ibmglobal', api_base: 'careers', tier: 'dream' }"],
  ["{ name: 'Spotify',    ats_type: 'lever',      slug: 'spotify',    api_base: '' }",
   "{ name: 'Spotify',    ats_type: 'lever',      slug: 'spotify',    api_base: '', tier: 'dream' }"],
  ["{ name: 'Mastercard', ats_type: 'workday',    slug: 'CorporateCareers',     api_base: 'mastercard.wd1' }",
   "{ name: 'Mastercard', ats_type: 'workday',    slug: 'CorporateCareers',     api_base: 'mastercard.wd1', tier: 'dream' }"],
  ["{ name: 'Visa',       ats_type: 'workday',    slug: 'Visa',                 api_base: 'visa.wd5' }",
   "{ name: 'Visa',       ats_type: 'workday',    slug: 'Visa',                 api_base: 'visa.wd5', tier: 'dream' }"],
  ["{ name: 'Walmart',    ats_type: 'workday',    slug: 'WalmartExternal',      api_base: 'walmart.wd5' }",
   "{ name: 'Walmart',    ats_type: 'workday',    slug: 'WalmartExternal',      api_base: 'walmart.wd5', tier: 'dream' }"],
  ["{ name: 'Target',     ats_type: 'workday',    slug: 'targetcareers',        api_base: 'target.wd5' }",
   "{ name: 'Target',     ats_type: 'workday',    slug: 'targetcareers',        api_base: 'target.wd5', tier: 'dream' }"],
  ["{ name: 'Salesforce',  ats_type: 'workday',    slug: 'External_Career_Site', api_base: 'salesforce.wd12' }",
   "{ name: 'Salesforce',  ats_type: 'workday',    slug: 'External_Career_Site', api_base: 'salesforce.wd12', tier: 'dream' }"],
];

// (b) new rows -- values verbatim from the live-DB audit output.
const TAIL_OLD = "{ name: 'Two Sigma', ats_type: 'avature', slug: 'careers.twosigma.com', api_base: 'careers/OpenRoles', tier: 'dream' },\n];";
const TAIL_NEW = "{ name: 'Two Sigma', ats_type: 'avature', slug: 'careers.twosigma.com', api_base: 'careers/OpenRoles', tier: 'dream' },\n" +
  "  // s78: dream rows previously promoted only via one-off SQL (s70 backfill,\n" +
  "  // Amazon/Apple promotions) -- now reproducible from a fresh clone.\n" +
  "  { name: 'Amazon', ats_type: 'amazon', slug: 'amazon', api_base: '', tier: 'dream' },\n" +
  "  { name: 'Apple', ats_type: 'apple', slug: 'apple', api_base: '', tier: 'dream' },\n" +
  "  { name: 'Netflix', ats_type: 'eightfold', slug: 'netflix.com', api_base: 'explore.jobs.netflix.net', tier: 'dream' },\n" +
  "  { name: 'Airbnb', ats_type: 'greenhouse', slug: 'airbnb', api_base: '', tier: 'dream' },\n" +
  "  { name: 'Cloudflare', ats_type: 'greenhouse', slug: 'cloudflare', api_base: '', tier: 'dream' },\n" +
  "  { name: 'Coinbase', ats_type: 'greenhouse', slug: 'coinbase', api_base: '', tier: 'dream' },\n" +
  "  { name: 'DoorDash', ats_type: 'greenhouse', slug: 'doordashusa', api_base: '', tier: 'dream' },\n" +
  "  { name: 'Instacart', ats_type: 'greenhouse', slug: 'instacart', api_base: '', tier: 'dream' },\n" +
  "  { name: 'Reddit', ats_type: 'greenhouse', slug: 'reddit', api_base: '', tier: 'dream' },\n" +
  "  { name: 'Robinhood', ats_type: 'greenhouse', slug: 'robinhood', api_base: '', tier: 'dream' },\n" +
  "  { name: 'Palantir', ats_type: 'lever', slug: 'palantir', api_base: '', tier: 'dream' },\n" +
  "  { name: 'LinkedIn', ats_type: 'smartrecruiters', slug: 'linkedin3', api_base: '', tier: 'dream' },\n" +
  "];";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  if (!N['Build Seed List']) { console.error(`INTEGRITY FAIL ${base}: Build Seed List not found`); process.exit(1); }
  if (N['Build Seed List'].parameters.jsCode.includes("slug: 'linkedin3'")) { console.log(`  ${base}: already patched`); return; }

  for (const [oldS, newS] of TIER_UPDATES) {
    replaceOnce(N['Build Seed List'].parameters, 'jsCode', oldS, newS, oldS.slice(0, 40), base);
  }
  replaceOnce(N['Build Seed List'].parameters, 'jsCode', TAIL_OLD, TAIL_NEW, 's78 new dream rows', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));

  // post-write validation: parse ALL seed rows back out and check invariants
  const code = N['Build Seed List'].parameters.jsCode;
  const rows = [...code.matchAll(/\{\s*name:\s*'([^']*)'\s*,\s*ats_type:\s*'([^']*)'\s*,\s*slug:\s*'([^']*)'\s*,\s*api_base:\s*'([^']*)'(?:\s*,\s*tier:\s*'([^']*)')?/g)]
    .map((m) => ({ name: m[1], ats_type: m[2], slug: m[3], api_base: m[4], tier: m[5] || 'probe' }));
  const keys = rows.map((r) => `${r.ats_type}|${r.slug}|${r.api_base}`);
  if (new Set(keys).size !== keys.length) { console.error(`INTEGRITY FAIL ${base}: duplicate (ats_type, slug, api_base) in seed list`); process.exit(1); }
  const dream = rows.filter((r) => r.tier === 'dream');
  console.log(`OK ${base}: ${rows.length} seed rows, ${dream.length} dream -- no 3-column-key duplicates`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // The full intended dream set (36 rows: live 38 minus the accidental Thomson
  // Reuters, keyed on all THREE columns -- the s74 lesson baked into the audit).
  // After this patch, seeder-dream must cover every intended row that the CSV
  // bulk can't (CSV rows carry no tier at all).
  const newRows = [...TAIL_NEW.matchAll(/\{\s*name:\s*'([^']*)'\s*,\s*ats_type:\s*'([^']*)'\s*,\s*slug:\s*'([^']*)'\s*,\s*api_base:\s*'([^']*)'\s*,\s*tier:\s*'dream'/g)]
    .map((m) => `${m[2]}|${m[3]}|${m[4]}`);
  const updatedRows = TIER_UPDATES.map(([, n]) => {
    const m = n.match(/ats_type:\s*'([^']*)'\s*,\s*slug:\s*'([^']*)'\s*,\s*api_base:\s*'([^']*)'/);
    return `${m[1]}|${m[2]}|${m[3]}`;
  });
  const covered = new Set([...newRows, ...updatedRows]);

  const MUST_COVER = [
    'amazon|amazon|', 'apple|apple|', 'eightfold|netflix.com|explore.jobs.netflix.net',
    'greenhouse|airbnb|', 'greenhouse|cloudflare|', 'greenhouse|coinbase|', 'greenhouse|doordashusa|',
    'greenhouse|instacart|', 'greenhouse|reddit|', 'greenhouse|robinhood|', 'greenhouse|figma|',
    'lever|palantir|', 'lever|spotify|', 'ashby|openai|', 'ashby|notion|', 'avature|ibmglobal|careers',
    'smartrecruiters|linkedin3|', 'workday|CorporateCareers|mastercard.wd1', 'workday|Visa|visa.wd5',
    'workday|WalmartExternal|walmart.wd5', 'workday|targetcareers|target.wd5',
    'workday|External_Career_Site|salesforce.wd12',
  ];
  for (const k of MUST_COVER) {
    if (!covered.has(k)) { console.error(`HARNESS FAIL: gap row not covered by patch: ${k}`); process.exit(1); }
  }
  // Thomson Reuters must NOT be promoted by this patch (it's being demoted).
  if (covered.has('workday|External_Career_Site|thomsonreuters.wd5')) {
    console.error('HARNESS FAIL: Thomson Reuters must not be seeded as dream'); process.exit(1);
  }
  // No duplicates within the patch itself
  const all = [...newRows, ...updatedRows];
  if (new Set(all).size !== all.length) { console.error('HARNESS FAIL: duplicate keys within the patch'); process.exit(1); }

  console.log(`HARNESS OK: patch covers all ${MUST_COVER.length} non-reproducible dream rows on the full 3-column key, excludes the accidental Thomson Reuters promotion, and contains no internal duplicates.`);
})();

SEEDER_TARGETS.forEach(patchFile);
console.log('S78 (dream-tier reproducibility: seeder is now the git-tracked source of curated truth) complete.');
