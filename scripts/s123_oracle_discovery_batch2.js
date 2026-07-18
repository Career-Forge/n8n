/**
 * s123_oracle_discovery_batch2.js -- 19 more Oracle Cloud HCM tenants,
 * live-verified this session directly against the real
 * recruitingCEJobRequisitions API (the same expand=requisitionList shape
 * used throughout this discovery arc). Continuation of s120's batch --
 * rounds out the original ~42-candidate CSV-mined list.
 *
 *   Lazard (98), Chubb (575), Akamai (227), Fortinet (928), Tenet
 *   Healthcare (2584), Albertsons (6396), American Eagle (3505), IHG
 *   (2475), Northwell Health (1379), Molina Healthcare (454), Subaru (59),
 *   First Solar (249), Hearst (334), Stantec (1408), WSP (3836),
 *   Providence Health (1930), UCSF Health (807), Newmark (262), Anywhere
 *   Real Estate (205, the Coldwell Banker/Century 21/Sotheby's parent --
 *   seeded under its real legal entity name, not "Coldwell Banker", since
 *   that's the actual tenant; Coldwell Banker itself has no separate
 *   Oracle tenant of its own).
 *
 * Ritz-Carlton was researched and skipped -- it's a Marriott brand with no
 * separate Oracle tenant (Marriott itself already seeded in s120).
 *
 * Tier: 'probe' (default), matching s120's policy -- general F500/Forbes
 * coverage, not curated dream-tier product companies.
 *
 * Run: harness (structural) + direct SQL seed + Registry Seeder rows.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');
const SQL_OUT = path.join(ROOT, '.tmp_s123_seed.sql');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

const ROWS = [
  { name: 'Lazard',             slug: 'LazardProfessionalCareers', api_base: 'icbpjb.fa.ocs.oraclecloud.com',         jobs: 98 },
  { name: 'Chubb',               slug: 'CX_2001', api_base: 'fa-ewgu-saasfaprod1.fa.ocs.oraclecloud.com',            jobs: 575 },
  { name: 'Akamai',              slug: 'CX_1',    api_base: 'fa-extu-saasfaprod1.fa.ocs.oraclecloud.com',            jobs: 227 },
  { name: 'Fortinet',            slug: 'CX_2001', api_base: 'edel.fa.us2.oraclecloud.com',                            jobs: 928 },
  { name: 'Tenet Healthcare',    slug: 'CX_1001', api_base: 'eodr.fa.us2.oraclecloud.com',                            jobs: 2584 },
  { name: 'Albertsons',          slug: 'CX_1001', api_base: 'eofd.fa.us6.oraclecloud.com',                            jobs: 6396 },
  { name: 'American Eagle',      slug: 'AEO-Careers', api_base: 'hcml.fa.us2.oraclecloud.com',                        jobs: 3505 },
  { name: 'IHG',                 slug: 'CX_1001', api_base: 'fa-evax-saasfaprod1.fa.ocs.oraclecloud.com',            jobs: 2475 },
  { name: 'Northwell Health',    slug: 'CX_2',    api_base: 'eppr.fa.us2.oraclecloud.com',                            jobs: 1379 },
  { name: 'Molina Healthcare',   slug: 'CX_1',    api_base: 'hckd.fa.us2.oraclecloud.com',                            jobs: 454 },
  { name: 'Subaru',              slug: 'CX_1001', api_base: 'hcal.fa.us2.oraclecloud.com',                            jobs: 59 },
  { name: 'First Solar',         slug: 'CX_1',    api_base: 'fa-esbv-saasfaprod1.fa.ocs.oraclecloud.com',            jobs: 249 },
  { name: 'Hearst',              slug: 'CX_1',    api_base: 'eevd.fa.us6.oraclecloud.com',                            jobs: 334 },
  { name: 'Stantec',             slug: 'CX_1',    api_base: 'hdhl.fa.us6.oraclecloud.com',                            jobs: 1408 },
  { name: 'WSP',                 slug: 'CX_2001', api_base: 'emit.fa.ca3.oraclecloud.com',                            jobs: 3836 },
  { name: 'Providence Health',   slug: 'CX_1',    api_base: 'evac.fa.us2.oraclecloud.com',                            jobs: 1930 },
  { name: 'UCSF Health',         slug: 'CX_1',    api_base: 'iazuqy.fa.ocs.oraclecloud.com',                          jobs: 807 },
  { name: 'Newmark',             slug: 'CX_1001', api_base: 'hdow.fa.us6.oraclecloud.com',                            jobs: 262 },
  { name: 'Anywhere Real Estate',slug: 'CX_1',    api_base: 'ibmqjb.fa.ocs.oraclecloud.com',                          jobs: 205 },
];

const SEEDER_TAIL_OLD = "{ name: 'ExxonMobil', ats_type: 'successfactors', slug: 'exxonmobil', api_base: 'jobs.exxonmobil.com' },\n];";
function buildTailNew() {
  const lines = ROWS.map((r) => `  { name: '${r.name.replace(/'/g, "\\'")}', ats_type: 'oracle', slug: '${r.slug}', api_base: '${r.api_base}' },`);
  return "{ name: 'ExxonMobil', ats_type: 'successfactors', slug: 'exxonmobil', api_base: 'jobs.exxonmobil.com' },\n  // s123: Oracle Cloud HCM discovery batch 2 -- continuation of s120,\n  // rounds out the original ~42-candidate CSV-mined list. All live-\n  // verified via the real recruitingCEJobRequisitions API. See script\n  // header for per-company job counts at verification time.\n" + lines.join('\n') + "\n];";
}

function patchSeeder() {
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (buildNode.parameters.jsCode.includes('s123: Oracle Cloud HCM discovery batch 2')) { console.log('  seeder: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', SEEDER_TAIL_OLD, buildTailNew(), 'append 19 Oracle rows');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: Registry Seeder gained ${ROWS.length} Oracle rows`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (ROWS.length !== 19) { console.error(`HARNESS FAIL: expected 19 rows, got ${ROWS.length}`); process.exit(1); }
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
  console.log(`  docker cp ${SQL_OUT} careerforge_postgres:/tmp/seed123.sql && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/seed123.sql`);

  patchSeeder();
  console.log('S123 (Oracle discovery batch 2) script complete.');
})();
