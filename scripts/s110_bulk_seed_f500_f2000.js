/**
 * s110_bulk_seed_f500_f2000.js -- bulk-seeds the 102 companies s109's
 * discovery pipeline live-verified (data/registry_import/seed_f500_f2000_2026-07.json),
 * assigns tier, and bumps the poller's dream-lane capacity to match.
 *
 * TIER ASSIGNMENT: the user's ask was "product-based companies," not every
 * F500/F2000 member by revenue rank -- most of these 102 hits are legacy
 * F500 names (insurers, oil majors, distributors) that are real and worth
 * having in the registry, but aren't what "dream tier" means here. Promoted
 * to dream = the union of (a) 4 direct matches against company_tiers.json's
 * hand-curated overlay (Meta, IMC Trading, EY, Enterprise Holdings), and
 * (b) 36 matches against Forbes Global 2000's industry field being one of
 * the 5 tech-native categories already used to filter s109's own Forbes2000
 * candidate pool (IT Software & Services, Technology Hardware & Equipment,
 * Semiconductors, Telecommunications Services, Media) -- same principled
 * filter, not a fresh judgment call. Everything else seeds at probe (still
 * real, still reachable, just not fast-laned -- earns promotion by yield
 * like any other probe-tier company).
 *
 * Notable finds during tier computation: Palantir shows up again here
 * (SmartRecruiters) -- already dream-tier via Lever from s78; this is a
 * second real board for the same company (like OpenAI/Anthropic/Netflix's
 * existing multi-platform rows), not a duplicate. Meta's own hit
 * (recruitee:meta, redirects live to facebookdata.recruitee.com) was
 * hand-verified before trusting it -- "meta" is generic enough to worry
 * about a collision with an unrelated tenant, but it's confirmed real,
 * just a minor/secondary channel (1 job listed), not their main pipeline.
 *
 * Per the plan: Build Seed List is NOT extended with 102 rows (stays the
 * small curated-truth list per s78's design) -- a doc comment points at
 * this JSON file instead for fresh-clone reproducibility.
 *
 * Dream lane bump: 53 companies at dream tier before this deploy, growing
 * to ~93 after (53 + 40 promoted here). `Select Due Companies`' dream lane
 * LIMIT 8 -> 16 -- real headroom margin for this and future growth, not
 * because the math is tight today (93 dream companies x their poll_interval
 * still fits comfortably under LIMIT-8 capacity; this is proactive, not
 * reactive).
 *
 * Run: dry-run harness first (no network, no DB), then direct SQL against
 * Postgres for the bulk seed, standard replaceOnce+harness+deploy for the
 * poller's LIMIT bump.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEED_FILE = path.join(ROOT, 'data', 'registry_import', 'seed_f500_f2000_2026-07.json');
const TIERS_FILE = path.join(ROOT, 'data', 'reference', 'company_tiers.json');
const F2000_RAW = path.join(ROOT, 'data', 'reference', 'raw', 'forbes_global2000_2021.csv');
const POLLER_FILE = path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');
const SQL_OUT = path.join(ROOT, '.tmp_s110_seed.sql');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(inc|incorporated|corp|corporation|co|company|group|holdings|plc|ltd|limited|llc|the)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const TECH_INDUSTRIES = new Set([
  'IT Software & Services', 'Technology Hardware & Equipment',
  'Semiconductors', 'Telecommunications Services', 'Media',
]);

function loadF2000Industries() {
  const raw = fs.readFileSync(F2000_RAW, 'utf8');
  const lines = raw.split('\n').filter((l) => l && !l.startsWith('#'));
  const header = lines[0].split(',');
  const nameIdx = header.indexOf('organizationName');
  const industryIdx = header.indexOf('industry');
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    // reuse the same lightweight quoted-CSV parser convention as s109
    const line = lines[i]; if (!line.trim()) continue;
    const cells = []; let cur = ''; let inQ = false;
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (inQ) { if (ch === '"' && line[j + 1] === '"') { cur += '"'; j++; } else if (ch === '"') inQ = false; else cur += ch; }
      else { if (ch === '"') inQ = true; else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch; }
    }
    cells.push(cur);
    const name = cells[nameIdx], industry = cells[industryIdx];
    if (name) map[normName(name)] = industry;
  }
  return map;
}

function computeTiers() {
  const seedData = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  const tiersData = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8')).companies;
  const overlay = new Set(Object.values(tiersData).filter((v) => v.tier !== 'fortune500').map((v) => normName(v.name)));
  const f2000Industry = loadF2000Industries();

  const rows = seedData.rows.map((r) => {
    const n = normName(r.name);
    const dreamByOverlay = overlay.has(n);
    const dreamByIndustry = TECH_INDUSTRIES.has(f2000Industry[n]);
    return Object.assign({}, r, { tier: (dreamByOverlay || dreamByIndustry) ? 'dream' : 'probe' });
  });
  return rows;
}

function buildSql(rows) {
  const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const lines = ['BEGIN;'];
  for (const r of rows) {
    lines.push(
      `INSERT INTO companies (name, ats_type, slug, api_base, tier, next_poll_at) VALUES (${esc(r.name)}, ${esc(r.ats_type)}, ${esc(r.slug)}, ${esc(r.api_base || '')}, ${esc(r.tier)}, now()) ` +
      `ON CONFLICT (ats_type, slug, api_base) DO UPDATE SET tier = CASE WHEN EXCLUDED.tier = 'dream' THEN 'dream' ELSE companies.tier END, is_active = true;`
    );
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

// ── poller: dream lane LIMIT 8 -> 16 ──
const LANE_OLD = "WHERE is_active AND tier = 'dream' AND next_poll_at <= now() ORDER BY next_poll_at ASC LIMIT 8)";
const LANE_NEW = "WHERE is_active AND tier = 'dream' AND next_poll_at <= now() ORDER BY next_poll_at ASC LIMIT 16)";

function patchPoller() {
  if (!fs.existsSync(POLLER_FILE)) { console.error('INTEGRITY FAIL: poller file missing'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(POLLER_FILE, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Select Due Companies');
  if (!node) { console.error('INTEGRITY FAIL: Select Due Companies not found'); process.exit(1); }
  if (node.parameters.query.includes('LIMIT 16) UNION ALL (SELECT id, name, ats_type, slug, COALESCE(api_base,\'\'), (ats_type || \':\' || slug), COALESCE(etag,\'\'), \'never_polled\'')) {
    console.log('  poller: already patched'); return;
  }
  replaceOnce(node.parameters, 'query', LANE_OLD, LANE_NEW, 'dream lane LIMIT');
  fs.writeFileSync(POLLER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: dream lane LIMIT 8 -> 16 -- ${wf.nodes.length} nodes`);
}

// ── seeder: doc pointer, no row bloat (per plan) ──
const SEEDER_ANCHOR_OLD = "// s112: F500 Eightfold/SmartRecruiters manual-discovery batch (11 of 38 --\n  // partial, see the script header for what's confirmed vs still open).";
const SEEDER_ANCHOR_NEW = "// s112: F500 Eightfold/SmartRecruiters manual-discovery batch (11 of 38 --\n  // partial, see the script header for what's confirmed vs still open).\n  // s110: 102 more F500/Forbes2000 companies live-verified by\n  // scripts/s109_ats_discovery.js are NOT hand-added here (this list stays\n  // the small curated-truth set, per s78's design) -- they're bulk-seeded\n  // directly from data/registry_import/seed_f500_f2000_2026-07.json instead.\n  // Re-run that import (see s110's header for the SQL) on a fresh clone for\n  // the same coverage.";

function patchSeederDoc() {
  if (!fs.existsSync(SEEDER_FILE)) { console.error('INTEGRITY FAIL: seeder file missing'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (!buildNode) { console.error('INTEGRITY FAIL: Build Seed List node not found'); process.exit(1); }
  if (buildNode.parameters.jsCode.includes('s110: 102 more')) { console.log('  seeder doc: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', SEEDER_ANCHOR_OLD, SEEDER_ANCHOR_NEW, 's110 doc pointer');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log('OK: Registry Seeder gained a doc pointer to the bulk-seed file');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  const rows = computeTiers();
  if (rows.length !== 102) { console.error(`HARNESS FAIL: expected 102 rows, got ${rows.length}`); process.exit(1); }

  const dreamRows = rows.filter((r) => r.tier === 'dream');
  const dreamNames = new Set(dreamRows.map((r) => r.name));
  for (const expected of ['Meta', 'IMC Trading', 'EY', 'Enterprise Holdings', 'HP Inc.', 'Micron Technology', 'Palantir Technologies']) {
    if (!dreamNames.has(expected)) { console.error(`HARNESS FAIL: expected "${expected}" to be dream-tier, got ${rows.find((r) => r.name === expected) ? rows.find((r) => r.name === expected).tier : 'NOT FOUND'}`); process.exit(1); }
  }
  for (const notExpected of ['McKesson', 'Cigna', 'AIG', 'Dow']) {
    const row = rows.find((r) => r.name === notExpected);
    if (row && row.tier === 'dream') { console.error(`HARNESS FAIL: "${notExpected}" should NOT be dream-tier (not a product company)`); process.exit(1); }
  }
  if (dreamRows.length < 30 || dreamRows.length > 50) { console.error(`HARNESS FAIL: expected 30-50 dream promotions, got ${dreamRows.length} -- sanity check the filter`); process.exit(1); }

  for (const r of rows) {
    if (!r.name || !r.ats_type || !r.slug || !r.tier) { console.error('HARNESS FAIL: malformed row', JSON.stringify(r)); process.exit(1); }
  }

  const sql = buildSql(rows);
  const insertCount = (sql.match(/INSERT INTO companies/g) || []).length;
  if (insertCount !== 102) { console.error(`HARNESS FAIL: expected 102 INSERTs in generated SQL, got ${insertCount}`); process.exit(1); }
  if (!sql.trim().startsWith('BEGIN;') || !sql.trim().endsWith('COMMIT;')) { console.error('HARNESS FAIL: SQL not transaction-wrapped'); process.exit(1); }

  console.log(`HARNESS OK: 102 rows tiered (${dreamRows.length} dream / ${rows.length - dreamRows.length} probe); known product companies (Meta, HP, Micron, Palantir...) correctly dream, known non-product F500 legacy names (McKesson, Cigna, AIG, Dow) correctly stay probe; generated SQL well-formed and transaction-wrapped.`);

  fs.writeFileSync(SQL_OUT, sql);
  console.log(`Wrote ${SQL_OUT} (102 upserts). Run manually:`);
  console.log(`  docker cp ${SQL_OUT} careerforge_postgres:/tmp/seed110.sql && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/seed110.sql`);

  patchPoller();
  patchSeederDoc();
  console.log('S110 (bulk seed) script complete.');
})();
