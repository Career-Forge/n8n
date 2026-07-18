/**
 * s118_activision_blizzard_seed.js -- seeds Activision Blizzard, live-
 * verified this session on the real Workday adapter (zero new code).
 *
 * The user pointed at careers.activisionblizzard.com and correctly
 * suspected a custom ATS given the apply flow stays on that domain -- but
 * that's a front-end aggregator (embeds real job data as inline JSON per
 * card, no bot-wall) that itself pulls from a REAL Workday tenant. The
 * embedded `applyUrl` field on every job card reveals it directly:
 * `xboxgaming.wd1.myworkdayjobs.com/External/job/.../apply` -- not the
 * "activision" tenant guessed earlier this session (which hit Workday's
 * own maintenance-page redirect, genuinely retired post-Microsoft-
 * acquisition). Verified live against the real CXS endpoint: 64 real jobs,
 * genuine Activision-branded postings ("Santa Monica - Activision - The
 * Pen Factory").
 *
 * Run: harness (structural) + direct SQL seed + Registry Seeder row for
 * fresh-clone reproducibility.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');
const SQL_OUT = path.join(ROOT, '.tmp_s118_seed.sql');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

const ROW = { name: 'Activision Blizzard', ats_type: 'workday', slug: 'External', api_base: 'xboxgaming.wd1' };

const SEEDER_TAIL_OLD = "{ name: 'AstraZeneca', ats_type: 'workday', slug: 'Careers', api_base: 'astrazeneca.wd3', tier: 'dream' },\n];";
const SEEDER_TAIL_NEW = "{ name: 'AstraZeneca', ats_type: 'workday', slug: 'Careers', api_base: 'astrazeneca.wd3', tier: 'dream' },\n  // s118: real Workday tenant found via the site's own embedded applyUrl\n  // field, not the \"activision\" tenant guessed earlier (retired/maintenance).\n  { name: 'Activision Blizzard', ats_type: 'workday', slug: 'External', api_base: 'xboxgaming.wd1', tier: 'dream' },\n];";

function patchSeeder() {
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (buildNode.parameters.jsCode.includes('xboxgaming.wd1')) { console.log('  seeder: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', SEEDER_TAIL_OLD, SEEDER_TAIL_NEW, 'append Activision Blizzard row');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log('OK: Registry Seeder gained the Activision Blizzard row');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (!ROW.name || !ROW.ats_type || !ROW.slug || !ROW.api_base) { console.error('HARNESS FAIL: malformed row'); process.exit(1); }
  const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const sql = `INSERT INTO companies (name, ats_type, slug, api_base, tier, next_poll_at) VALUES (${esc(ROW.name)}, ${esc(ROW.ats_type)}, ${esc(ROW.slug)}, ${esc(ROW.api_base)}, 'dream', now()) ON CONFLICT (ats_type, slug, api_base) DO UPDATE SET tier = 'dream', is_active = true;`;
  fs.writeFileSync(SQL_OUT, sql);
  console.log(`HARNESS OK: row well-formed. Wrote ${SQL_OUT}. Run manually:`);
  console.log(`  docker cp ${SQL_OUT} careerforge_postgres:/tmp/seed118.sql && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/seed118.sql`);
  patchSeeder();
  console.log('S118 (Activision Blizzard seed) script complete.');
})();
