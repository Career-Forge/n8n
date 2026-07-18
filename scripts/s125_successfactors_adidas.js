/**
 * s125_successfactors_adidas.js -- adds adidas as a 4th SuccessFactors
 * tenant, live-verified this session (jobs.adidas-group.com/search/tile-
 * search-results returns real job tiles via the same generic pagination
 * endpoint as Cargill/Vodafone/ExxonMobil).
 *
 * Continuation of the s121 discovery: also tried BMW (empty tile response,
 * unclear -- not a bot-wall, just zero matched tiles, same inconclusive
 * class as Colgate), Deloitte (uses an older SF "JobDetail"-path template,
 * not the Career Site Builder /job/ shape this adapter targets -- confirmed
 * apply.deloitte.com/search/tile-search-results 404s), Kimberly-Clark
 * (403 bot-wall), and Nestle/Volkswagen (both run the OLDER shared-host
 * SuccessFactors product at career2/5.successfactors.eu?company=X --
 * architecturally different from Career Site Builder, confirmed 404 on
 * the tile-search-results endpoint). Sanofi/GSK/Diageo/PepsiCo all turned
 * out to run Workday or iCIMS, not SuccessFactors -- not relevant here.
 * None of these gaps are forced; documented for whoever picks this up next.
 *
 * Run: harness (structural) + direct SQL seed + Registry Seeder row.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');
const SQL_OUT = path.join(ROOT, '.tmp_s125_seed.sql');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

const ROW = { name: 'adidas', ats_type: 'successfactors', slug: 'adidas', api_base: 'jobs.adidas-group.com' };

const SEEDER_TAIL_OLD = "{ name: 'Anywhere Real Estate', ats_type: 'oracle', slug: 'CX_1', api_base: 'ibmqjb.fa.ocs.oraclecloud.com' },\n];";
const SEEDER_TAIL_NEW = "{ name: 'Anywhere Real Estate', ats_type: 'oracle', slug: 'CX_1', api_base: 'ibmqjb.fa.ocs.oraclecloud.com' },\n  // s125: 4th SuccessFactors tenant, same adapter as s121 -- live-verified\n  // via jobs.adidas-group.com/search/tile-search-results.\n  { name: 'adidas', ats_type: 'successfactors', slug: 'adidas', api_base: 'jobs.adidas-group.com' },\n];";

function patchSeeder() {
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (buildNode.parameters.jsCode.includes("name: 'adidas'")) { console.log('  seeder: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', SEEDER_TAIL_OLD, SEEDER_TAIL_NEW, 'append adidas row');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log('OK: Registry Seeder gained the adidas row');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (!ROW.name || !ROW.ats_type || !ROW.slug || !ROW.api_base) { console.error('HARNESS FAIL: malformed row'); process.exit(1); }
  const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const sql = `INSERT INTO companies (name, ats_type, slug, api_base, tier, next_poll_at) VALUES (${esc(ROW.name)}, ${esc(ROW.ats_type)}, ${esc(ROW.slug)}, ${esc(ROW.api_base)}, 'probe', now()) ON CONFLICT (ats_type, slug, api_base) DO UPDATE SET name = EXCLUDED.name, is_active = true;`;
  fs.writeFileSync(SQL_OUT, sql);
  console.log(`HARNESS OK: row well-formed. Wrote ${SQL_OUT}. Run manually:`);
  console.log(`  docker cp ${SQL_OUT} careerforge_postgres:/tmp/seed125.sql && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/seed125.sql`);
  patchSeeder();
  console.log('S125 (adidas SuccessFactors seed) script complete.');
})();
