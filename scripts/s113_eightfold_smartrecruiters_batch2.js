/**
 * s113_eightfold_smartrecruiters_batch2.js -- continuation of s112's manual
 * Eightfold/SmartRecruiters discovery batch. s112 covered 11 of 38 F500
 * candidates and explicitly disclosed the remaining 24 as not-yet-
 * researched (13 Eightfold, 11 SmartRecruiters). This sprint covers that
 * exact remaining list, same method: WebSearch for the real tenant host,
 * live HTTP probe against the exact endpoint the poller calls, confirmation
 * = a real non-empty response, never a guess.
 *
 * 23 of 24 confirmed (only BNY Mellon rejected -- both Eightfold tiers
 * return HTML instead of JSON on their tenant, genuinely not reachable via
 * this method, same treatment as Microsoft in s112).
 *
 * Eightfold (12 of 13 -- host, real domain param confirmed live):
 *   Bayer              bayer.eightfold.ai            bayer.com          (smartapply)
 *   Deere              johndeere.eightfold.ai        johndeere.com      (pcsx)
 *   Vodafone           vodafone.eightfold.ai         vodafone.com       (pcsx)
 *   Eaton              eaton.eightfold.ai            eaton.com          (pcsx)
 *   Schlumberger (SLB) slb.eightfold.ai              slb.com            (pcsx) -- real
 *                      brand is just "SLB" now, not "Schlumberger"
 *   NetApp             netapp.eightfold.ai           netapp.com         (smartapply)
 *   Lam Research       lamresearch.eightfold.ai      lamresearch.com    (pcsx)
 *   Fluor              fluor.eightfold.ai            fluor.com          (smartapply)
 *   Johns Hopkins      jhu.eightfold.ai              jhu.edu            (pcsx)
 *   Mercado Libre      mercadolibre.eightfold.ai     mercadolibre.com   (pcsx)
 *   Estee Lauder       elcompanies.eightfold.ai      elcompanies.com    (pcsx) --
 *                      real tenant is "elcompanies" (the parent company),
 *                      NOT "esteelauder"
 *   Whirlpool          whirlpool.eightfold.ai        whirlpool.com      (pcsx)
 *
 * SmartRecruiters (11 of 11, all confirmed):
 *   Wise, Intuitive Surgical (slug "intuitive"), Accor (slug "accorcorpo"),
 *   Domino's (slug "Dominos"), AECOM (slug "AECOM2"), Roland Berger,
 *   Abercrombie & Fitch (slug "abercrombieandfitchco"), Wynn Resorts,
 *   McDonald's (slug "mcdonaldscorporation"), Expeditors (slug
 *   "EXPEDITORS"), Freshworks.
 *
 * REJECTED, not force-guessed: BNY Mellon (bnymellon.eightfold.ai) --
 * both api/apply/v2/jobs and api/pcsx/search return an HTML page (not
 * JSON) regardless of Accept header, unlike every other confirmed tenant.
 * Genuinely not reachable via the standard 2-tier method; needs a
 * different discovery approach if ever revisited (not attempted here).
 *
 * TIER: all 23 seed at 'dream' -- these are the F500 continuation of the
 * same "product/major companies" discovery effort s110 already tiered
 * this way; unlike s110's mixed F500+F2000 batch, this list has no
 * legacy-insurer/oil-major noise to filter out; every name here is a
 * real, sizeable, recognizable employer worth fast-laning.
 *
 * Run: harness first (structural, no network -- probes already done by
 * hand this session), then direct SQL seed + workflow-file doc pointer.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');
const SQL_OUT = path.join(ROOT, '.tmp_s113_seed.sql');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

const CONFIRMED = [
  { name: 'Bayer', ats_type: 'eightfold', slug: 'bayer.com', api_base: 'bayer.eightfold.ai' },
  { name: 'Deere', ats_type: 'eightfold', slug: 'johndeere.com', api_base: 'johndeere.eightfold.ai' },
  { name: 'Vodafone', ats_type: 'eightfold', slug: 'vodafone.com', api_base: 'vodafone.eightfold.ai' },
  { name: 'Eaton', ats_type: 'eightfold', slug: 'eaton.com', api_base: 'eaton.eightfold.ai' },
  { name: 'SLB', ats_type: 'eightfold', slug: 'slb.com', api_base: 'slb.eightfold.ai' },
  { name: 'NetApp', ats_type: 'eightfold', slug: 'netapp.com', api_base: 'netapp.eightfold.ai' },
  { name: 'Lam Research', ats_type: 'eightfold', slug: 'lamresearch.com', api_base: 'lamresearch.eightfold.ai' },
  { name: 'Fluor', ats_type: 'eightfold', slug: 'fluor.com', api_base: 'fluor.eightfold.ai' },
  { name: 'Johns Hopkins', ats_type: 'eightfold', slug: 'jhu.edu', api_base: 'jhu.eightfold.ai' },
  { name: 'Mercado Libre', ats_type: 'eightfold', slug: 'mercadolibre.com', api_base: 'mercadolibre.eightfold.ai' },
  { name: 'Estee Lauder', ats_type: 'eightfold', slug: 'elcompanies.com', api_base: 'elcompanies.eightfold.ai' },
  { name: 'Whirlpool', ats_type: 'eightfold', slug: 'whirlpool.com', api_base: 'whirlpool.eightfold.ai' },
  { name: 'Wise', ats_type: 'smartrecruiters', slug: 'Wise', api_base: '' },
  { name: 'Intuitive Surgical', ats_type: 'smartrecruiters', slug: 'intuitive', api_base: '' },
  { name: 'Accor', ats_type: 'smartrecruiters', slug: 'accorcorpo', api_base: '' },
  { name: "Domino's", ats_type: 'smartrecruiters', slug: 'Dominos', api_base: '' },
  { name: 'AECOM', ats_type: 'smartrecruiters', slug: 'AECOM2', api_base: '' },
  { name: 'Roland Berger', ats_type: 'smartrecruiters', slug: 'RolandBerger', api_base: '' },
  { name: 'Abercrombie & Fitch', ats_type: 'smartrecruiters', slug: 'abercrombieandfitchco', api_base: '' },
  { name: 'Wynn Resorts', ats_type: 'smartrecruiters', slug: 'WynnResorts', api_base: '' },
  { name: "McDonald's", ats_type: 'smartrecruiters', slug: 'mcdonaldscorporation', api_base: '' },
  { name: 'Expeditors', ats_type: 'smartrecruiters', slug: 'EXPEDITORS', api_base: '' },
  { name: 'Freshworks', ats_type: 'smartrecruiters', slug: 'Freshworks', api_base: '' },
];

function buildSql(rows) {
  const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const lines = ['BEGIN;'];
  for (const r of rows) {
    lines.push(
      `INSERT INTO companies (name, ats_type, slug, api_base, tier, next_poll_at) VALUES (${esc(r.name)}, ${esc(r.ats_type)}, ${esc(r.slug)}, ${esc(r.api_base || '')}, 'dream', now()) ` +
      `ON CONFLICT (ats_type, slug, api_base) DO UPDATE SET tier = 'dream', is_active = true;`
    );
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

const SEEDER_ANCHOR_OLD = "// s110: 102 more F500/Forbes2000 companies live-verified by\n  // scripts/s109_ats_discovery.js are NOT hand-added here (this list stays\n  // the small curated-truth set, per s78's design) -- they're bulk-seeded\n  // directly from data/registry_import/seed_f500_f2000_2026-07.json instead.\n  // Re-run that import (see s110's header for the SQL) on a fresh clone for\n  // the same coverage.";
const SEEDER_ANCHOR_NEW = SEEDER_ANCHOR_OLD + "\n  // s113: 23 more F500 companies -- continuation of s112's Eightfold/\n  // SmartRecruiters manual-discovery batch (24 previously-unresearched\n  // names, 23 confirmed). See scripts/s113_eightfold_smartrecruiters_batch2.js\n  // for the full list + verification method.";

function patchSeederDoc() {
  if (!fs.existsSync(SEEDER_FILE)) { console.error('INTEGRITY FAIL: seeder file missing'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (!buildNode) { console.error('INTEGRITY FAIL: Build Seed List node not found'); process.exit(1); }
  if (buildNode.parameters.jsCode.includes('s113: 23 more')) { console.log('  seeder doc: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', SEEDER_ANCHOR_OLD, SEEDER_ANCHOR_NEW, 's113 doc pointer');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log('OK: Registry Seeder gained an s113 doc pointer');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (CONFIRMED.length !== 23) { console.error(`HARNESS FAIL: expected 23 rows, got ${CONFIRMED.length}`); process.exit(1); }
  const names = new Set(CONFIRMED.map((c) => c.name));
  if (names.size !== CONFIRMED.length) { console.error('HARNESS FAIL: duplicate name in CONFIRMED'); process.exit(1); }
  for (const c of CONFIRMED) {
    if (!c.name || !c.ats_type || !c.slug) { console.error('HARNESS FAIL: malformed row', JSON.stringify(c)); process.exit(1); }
    if (c.ats_type === 'eightfold' && !c.api_base) { console.error('HARNESS FAIL: eightfold row missing api_base', JSON.stringify(c)); process.exit(1); }
  }
  const eightfoldCount = CONFIRMED.filter((c) => c.ats_type === 'eightfold').length;
  const smartrecruitersCount = CONFIRMED.filter((c) => c.ats_type === 'smartrecruiters').length;
  if (eightfoldCount !== 12 || smartrecruitersCount !== 11) {
    console.error(`HARNESS FAIL: expected 12 eightfold + 11 smartrecruiters, got ${eightfoldCount} + ${smartrecruitersCount}`); process.exit(1);
  }

  const sql = buildSql(CONFIRMED);
  const insertCount = (sql.match(/INSERT INTO companies/g) || []).length;
  if (insertCount !== 23) { console.error(`HARNESS FAIL: expected 23 INSERTs, got ${insertCount}`); process.exit(1); }
  if (!sql.trim().startsWith('BEGIN;') || !sql.trim().endsWith('COMMIT;')) { console.error('HARNESS FAIL: SQL not transaction-wrapped'); process.exit(1); }

  console.log(`HARNESS OK: 23 confirmed rows (12 eightfold / 11 smartrecruiters) well-formed and unique; SQL well-formed and transaction-wrapped.`);

  fs.writeFileSync(SQL_OUT, sql);
  console.log(`Wrote ${SQL_OUT}. Run manually:`);
  console.log(`  docker cp ${SQL_OUT} careerforge_postgres:/tmp/seed113.sql && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/seed113.sql`);

  patchSeederDoc();
  console.log('S113 (Eightfold/SmartRecruiters batch 2) script complete.');
})();
