/**
 * s61_bulk_seed_workday.js -- v9 wave Area B2: bulk-seed the poller's registry for
 * the truly generic multi-tenant ATS types added by the Phase 2.3 adapter expansion.
 *
 * amazon/apple/oracle are deliberately NOT seeded further -- confirmed by reading
 * Build Requests/Parse Jobs that these 3 are single-company hardcoded integrations
 * (literal URLs ignoring slug/api_base for amazon/apple; oracle's apply_url is
 * hardcoded to careers.oracle.com regardless of which row triggered it). A second
 * row under any of these 3 types would silently mislabel or misroute, not add
 * coverage. SmartRecruiters/Eightfold are also NOT seeded -- their tenant
 * identifiers are opaque per-company ids, not derivable from a brand name (tested
 * several plausible guesses; all returned well-formed-but-empty responses, i.e.
 * valid-shaped garbage rather than a helpful error). Guessing those would create
 * dead rows that never surface as broken.
 *
 * Workday IS generic and IS seedable -- 5 tenants below, live-verified via
 * WebSearch this session (not pulled from memory/training data), including 2
 * corrections to this exact codebase's own stale COHORT_TARGETS entries (used
 * separately by Parse Expand Query for cohort site: query generation, unrelated
 * to the poller but sharing the same underlying tenant data -- fixed in the same
 * script since both would otherwise point at the same wrong Workday URLs):
 *   - Visa:       COHORT_TARGETS had visa.wd1/Visa       -- real is visa.wd5/Visa
 *   - Mastercard: COHORT_TARGETS had mastercard.wd1/mastercard_careers -- real
 *                 site is mastercard.wd1/CorporateCareers (tenant was right,
 *                 site slug was wrong)
 *
 * No node count change (registry seeder); Parse Expand Query unchanged in shape,
 * only 2 stale literal values corrected.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Registry_Seeder.json'),
];
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Registry Seeder: append 5 verified Workday tenants ═══
const SEED_OLD =
  "  { name: 'Notion',     ats_type: 'ashby',      slug: 'notion',     api_base: '' },\n" +
  "];";
const SEED_NEW =
  "  { name: 'Notion',     ats_type: 'ashby',      slug: 'notion',     api_base: '' },\n" +
  "  // v9 Area B2: workday is the only generic multi-tenant type among the newer\n" +
  "  // poller adapters worth bulk-seeding -- amazon/apple/oracle are single-company\n" +
  "  // hardcoded integrations (see Parse Jobs), a 2nd row would mislabel/misroute;\n" +
  "  // smartrecruiters/eightfold use opaque per-tenant ids not derivable from a\n" +
  "  // brand name. These 5 were live-verified, not guessed.\n" +
  "  { name: 'Adobe',      ats_type: 'workday',    slug: 'external_experienced', api_base: 'adobe.wd5' },\n" +
  "  { name: 'Target',     ats_type: 'workday',    slug: 'targetcareers',        api_base: 'target.wd5' },\n" +
  "  { name: 'Walmart',    ats_type: 'workday',    slug: 'WalmartExternal',      api_base: 'walmart.wd5' },\n" +
  "  { name: 'Visa',       ats_type: 'workday',    slug: 'Visa',                 api_base: 'visa.wd5' },\n" +
  "  { name: 'Mastercard', ats_type: 'workday',    slug: 'CorporateCareers',     api_base: 'mastercard.wd1' },\n" +
  "];";

// ═══ 2. Parse Expand Query: fix 2 stale COHORT_TARGETS entries ═══
const CT_OLD = "'visa': { workday_tenant: 'visa.wd1', workday_site: 'Visa' },\n  'mastercard': { workday_tenant: 'mastercard.wd1', workday_site: 'mastercard_careers' },";
const CT_NEW = "'visa': { workday_tenant: 'visa.wd5', workday_site: 'Visa' },\n  'mastercard': { workday_tenant: 'mastercard.wd1', workday_site: 'CorporateCareers' },";

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
  if (N['Build Seed List'].parameters.jsCode.includes('Adobe')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Seed List'].parameters, 'jsCode', SEED_OLD, SEED_NEW, 'Build Seed List Workday additions', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: 5 Workday tenants seeded`);
}

function patchMaster(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Parse Expand Query']) { console.error(`INTEGRITY FAIL ${base}: node "Parse Expand Query" not found`); process.exit(1); }
  if (N['Parse Expand Query'].parameters.jsCode.includes("workday_tenant: 'visa.wd5'")) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', CT_OLD, CT_NEW, 'COHORT_TARGETS visa/mastercard fix', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: COHORT_TARGETS visa/mastercard corrected`);
}

// ── harness ──
(function harness() {
  // 1. Seed list: exactly 5 new rows, all ats_type workday, all have non-empty
  // slug + api_base in the expected tenant.wdN shape, no duplicate slugs.
  {
    const fullSeed = new Function(SEED_NEW.replace('];', '];\nreturn SEED;').replace(
      "  { name: 'Notion',     ats_type: 'ashby',      slug: 'notion',     api_base: '' },\n",
      "const SEED = [{ name: 'Notion', ats_type: 'ashby', slug: 'notion', api_base: '' },\n"
    ))();
    const newRows = fullSeed.filter((c) => c.name !== 'Notion');
    if (newRows.length !== 5) { console.error('HARNESS FAIL: expected exactly 5 new seed rows', newRows.length); process.exit(1); }
    for (const c of newRows) {
      if (c.ats_type !== 'workday') { console.error('HARNESS FAIL: all new rows must be ats_type workday', c); process.exit(1); }
      if (!c.slug || !c.api_base) { console.error('HARNESS FAIL: slug/api_base must be non-empty', c); process.exit(1); }
      if (!/^[\w-]+\.wd\d+$/.test(c.api_base)) { console.error('HARNESS FAIL: api_base must match tenant.wdN shape', c); process.exit(1); }
    }
    const slugs = new Set(newRows.map((c) => c.api_base + '|' + c.slug));
    if (slugs.size !== 5) { console.error('HARNESS FAIL: duplicate (api_base, slug) pairs among new rows', newRows); process.exit(1); }
  }
  console.log('HARNESS OK: 5 new Workday seed rows, correct ats_type, non-empty tenant.wdN api_base, unique slugs');

  // 2. COHORT_TARGETS fix: visa/mastercard now point at the corrected tenant/site.
  {
    const obj = new Function('return {' + CT_NEW.replace(/'visa'/, '"visa"').replace(/'mastercard'/, '"mastercard"') + '};')();
    if (obj.visa.workday_tenant !== 'visa.wd5') { console.error('HARNESS FAIL: visa tenant not corrected', obj.visa); process.exit(1); }
    if (obj.mastercard.workday_site !== 'CorporateCareers') { console.error('HARNESS FAIL: mastercard site not corrected', obj.mastercard); process.exit(1); }
  }
  console.log('HARNESS OK: COHORT_TARGETS visa/mastercard entries corrected to the live-verified tenant/site');
})();

SEEDER_TARGETS.forEach(patchSeeder);
MASTER_TARGETS.forEach(patchMaster);
console.log('S61 (v9 Area B2: bulk-seed 5 Workday tenants + COHORT_TARGETS visa/mastercard fix) complete.');
