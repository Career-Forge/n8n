/**
 * s119_backfill_seeder_reproducibility.js -- closes the fresh-clone
 * reproducibility gap flagged while seeding Activision Blizzard: s114
 * (Bridgewater, Hudson River Trading, Millennium Management, JPMorgan
 * Chase, Goldman Sachs) and s115/s116 (D. E. Shaw, Microsoft) all seeded
 * the LIVE database directly but never added rows to the Registry
 * Seeder's Build Seed List -- a fresh clone of this repo would be missing
 * all 7. Pure bookkeeping: every value here is already live-verified data
 * from earlier this session, no new research or live probing needed.
 *
 * Run: harness (structural) + workflow deploy. No SQL -- the live DB
 * already has all 7 rows (seeded directly in s114/s115/s116).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

const ROWS = [
  { name: 'Bridgewater Associates', ats_type: 'greenhouse', slug: 'bridgewater89', api_base: '' },
  { name: 'Hudson River Trading', ats_type: 'greenhouse', slug: 'wehrtyou', api_base: '' },
  { name: 'Millennium Management', ats_type: 'eightfold', slug: 'mlp.com', api_base: 'mlp.eightfold.ai' },
  { name: 'JPMorgan Chase', ats_type: 'oracle', slug: 'CX_1001', api_base: 'jpmc.fa.oraclecloud.com' },
  { name: 'Goldman Sachs', ats_type: 'oracle', slug: 'LateralHiring', api_base: 'hdpc.fa.us2.oraclecloud.com' },
  { name: 'D. E. Shaw', ats_type: 'deshaw', slug: 'deshaw', api_base: '' },
  { name: 'Microsoft', ats_type: 'microsoft', slug: 'microsoft', api_base: '' },
];

const TAIL_OLD = "{ name: 'Activision Blizzard', ats_type: 'workday', slug: 'External', api_base: 'xboxgaming.wd1', tier: 'dream' },\n];";
function buildTailNew() {
  const lines = ROWS.map((r) => `  { name: '${r.name.replace(/'/g, "\\'")}', ats_type: '${r.ats_type}', slug: '${r.slug}', api_base: '${r.api_base}', tier: 'dream' },`);
  return "{ name: 'Activision Blizzard', ats_type: 'workday', slug: 'External', api_base: 'xboxgaming.wd1', tier: 'dream' },\n  // s119: reproducibility backfill -- these 7 were seeded directly to the\n  // live DB in s114 (Bridgewater/HRT/Millennium/JPMorgan/Goldman) and\n  // s115/s116 (D.E. Shaw/Microsoft) but never added here. No new data --\n  // every value is already live-verified, see those scripts' headers.\n" + lines.join('\n') + "\n];";
}

function patchSeeder() {
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (buildNode.parameters.jsCode.includes('s119: reproducibility backfill')) { console.log('  seeder: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', TAIL_OLD, buildTailNew(), 'append 7 backfill rows');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: Registry Seeder gained ${ROWS.length} backfill rows`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (ROWS.length !== 7) { console.error(`HARNESS FAIL: expected 7 rows, got ${ROWS.length}`); process.exit(1); }
  const names = new Set(ROWS.map((r) => r.name));
  if (names.size !== ROWS.length) { console.error('HARNESS FAIL: duplicate name in ROWS'); process.exit(1); }
  for (const r of ROWS) {
    if (!r.name || !r.ats_type || !r.slug) { console.error('HARNESS FAIL: malformed row', JSON.stringify(r)); process.exit(1); }
  }
  console.log(`HARNESS OK: ${ROWS.length} rows well-formed and unique.`);
  patchSeeder();
  console.log('S119 (seeder reproducibility backfill) script complete.');
})();
