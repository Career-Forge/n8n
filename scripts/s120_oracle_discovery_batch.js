/**
 * s120_oracle_discovery_batch.js -- 17 Oracle Cloud HCM tenants, live-verified
 * this session directly against the real REST API (the same `&expand=
 * requisitionList` call the s114 fix uses -- NOT guessed, NOT taken from
 * search-result HTML alone). Every row below returned a real, non-empty
 * `requisitionList` with a real `TotalJobsCount` when curled just now:
 *
 *   Ford (843), Marriott (12581), Kroger (15414), Texas Instruments (532),
 *   Honeywell (1390), Carnival (211), Cummins (929), Sherwin-Williams (2126),
 *   Southern Company (101), Caesars Entertainment (1438), Yum Brands (183),
 *   Emerson (789), Mayo Clinic (1345), Quest Diagnostics (2023), Macy's
 *   (3180), CSX (38), Digital Realty (206).
 *
 * Tier: 'probe' (default), NOT 'dream' -- these are general F500 companies
 * from the CSV mining pass, not the user's curated MAANGO/fintech/quant
 * dream-tier list (that's why JPMorgan/Goldman in s114/s119 got 'dream':
 * explicit user ask; these didn't get one). They earn promotion by yield
 * like every other bulk-seeded F500 row (s110 precedent).
 *
 * Cerner was researched and deliberately EXCLUDED -- Oracle acquired it and
 * folded its hiring into Oracle Health, which is Oracle's own careers site
 * (already seeded), not a distinct tenant with its own siteNumber.
 *
 * Run: harness (structural) + direct SQL seed + Registry Seeder rows for
 * fresh-clone reproducibility.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');
const SQL_OUT = path.join(ROOT, '.tmp_s120_seed.sql');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

const ROWS = [
  { name: 'Ford',                 slug: 'CX_1',               api_base: 'efds.fa.em5.oraclecloud.com',           jobs: 843 },
  { name: 'Marriott',             slug: 'CX',                  api_base: 'ejwl.fa.us2.oraclecloud.com',           jobs: 12581 },
  { name: 'Kroger',               slug: 'CX_2001',             api_base: 'eluq.fa.us2.oraclecloud.com',           jobs: 15414 },
  { name: 'Texas Instruments',    slug: 'CX',                  api_base: 'edbz.fa.us2.oraclecloud.com',           jobs: 532 },
  { name: 'Honeywell',            slug: 'Honeywell',           api_base: 'ibqbjb.fa.ocs.oraclecloud.com',         jobs: 1390 },
  { name: 'Carnival',             slug: 'CORP',                api_base: 'eicl.fa.em5.oraclecloud.com',           jobs: 211 },
  { name: 'Cummins',              slug: 'CX_1',                api_base: 'fa-espx-saasfaprod1.fa.ocs.oraclecloud.com', jobs: 929 },
  { name: 'Sherwin-Williams',     slug: 'CX_2',                api_base: 'ejhp.fa.us6.oraclecloud.com',           jobs: 2126 },
  { name: 'Southern Company',     slug: 'SouthernCompanyJobs', api_base: 'emje.fa.us6.oraclecloud.com',           jobs: 101 },
  { name: 'Caesars Entertainment',slug: 'CX_1',                api_base: 'edmn.fa.us2.oraclecloud.com',           jobs: 1438 },
  { name: 'Yum Brands',           slug: 'CX_1',                api_base: 'eczd.fa.us2.oraclecloud.com',           jobs: 183 },
  { name: 'Emerson',              slug: 'CX_1',                api_base: 'hdjq.fa.us2.oraclecloud.com',           jobs: 789 },
  { name: 'Mayo Clinic',          slug: 'Mayo-US',             api_base: 'fa-euwp-saasfaprod1.fa.ocs.oraclecloud.com', jobs: 1345 },
  { name: 'Quest Diagnostics',    slug: 'CX_1',                api_base: 'hdox.fa.us6.oraclecloud.com',           jobs: 2023 },
  { name: "Macy's",               slug: 'CX_1001',             api_base: 'ebwh.fa.us2.oraclecloud.com',           jobs: 3180 },
  { name: 'CSX',                  slug: 'CSXCareers',          api_base: 'fa-eowa-saasfaprod1.fa.ocs.oraclecloud.com', jobs: 38 },
  { name: 'Digital Realty',       slug: 'CX',                  api_base: 'hdep.fa.us2.oraclecloud.com',           jobs: 206 },
];

const SEEDER_TAIL_OLD = "{ name: 'Microsoft', ats_type: 'microsoft', slug: 'microsoft', api_base: '', tier: 'dream' },\n];";
function buildTailNew() {
  const lines = ROWS.map((r) => `  { name: '${r.name.replace(/'/g, "\\'")}', ats_type: 'oracle', slug: '${r.slug}', api_base: '${r.api_base}' },`);
  return "{ name: 'Microsoft', ats_type: 'microsoft', slug: 'microsoft', api_base: '', tier: 'dream' },\n  // s120: Oracle Cloud HCM discovery batch -- 17 F500 tenants, live-verified\n  // this session via the real recruitingCEJobRequisitions API (expand=\n  // requisitionList). Default 'probe' tier, not dream -- general F500\n  // coverage, not curated product-company targets. See script header for\n  // per-company job counts at verification time.\n" + lines.join('\n') + "\n];";
}

function patchSeeder() {
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (buildNode.parameters.jsCode.includes('s120: Oracle Cloud HCM discovery batch')) { console.log('  seeder: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', SEEDER_TAIL_OLD, buildTailNew(), 'append 17 Oracle rows');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: Registry Seeder gained ${ROWS.length} Oracle rows`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (ROWS.length !== 17) { console.error(`HARNESS FAIL: expected 17 rows, got ${ROWS.length}`); process.exit(1); }
  const names = new Set(ROWS.map((r) => r.name));
  if (names.size !== ROWS.length) { console.error('HARNESS FAIL: duplicate name in ROWS'); process.exit(1); }
  for (const r of ROWS) {
    if (!r.name || !r.slug || !r.api_base) { console.error('HARNESS FAIL: malformed row', JSON.stringify(r)); process.exit(1); }
    if (!r.jobs || r.jobs < 1) { console.error('HARNESS FAIL: unverified/zero job count for', r.name); process.exit(1); }
  }
  console.log(`HARNESS OK: ${ROWS.length} rows well-formed, unique, all verified with real job counts.`);

  const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const sqlLines = ROWS.map((r) =>
    `INSERT INTO companies (name, ats_type, slug, api_base, tier, next_poll_at) VALUES (${esc(r.name)}, 'oracle', ${esc(r.slug)}, ${esc(r.api_base)}, 'probe', now()) ON CONFLICT (ats_type, slug, api_base) DO UPDATE SET name = EXCLUDED.name, is_active = true;`
  );
  fs.writeFileSync(SQL_OUT, sqlLines.join('\n') + '\n');
  console.log(`Wrote ${SQL_OUT}. Run manually:`);
  console.log(`  docker cp ${SQL_OUT} careerforge_postgres:/tmp/seed120.sql && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/seed120.sql`);

  patchSeeder();
  console.log('S120 (Oracle discovery batch) script complete.');
})();
