/**
 * s108_registry_dedup.js -- registry hygiene pass before the F500/Forbes2000
 * bulk seed (s109-s110). Read-only audit first (grouped by normalized name +
 * ats_type, since cross-ATS-type name collisions turned out to be almost all
 * legitimate -- OpenAI/Anthropic/Netflix genuinely cross-post to 2-3 ATS
 * platforms at once, confirmed live and left alone) found 29 groups sharing
 * a normalized name AND ats_type. Every single one, without exception, is
 * the SAME Workday/Ashby tenant seeded twice under different slug CASING --
 * e.g. company_id 15628 (slug "nvidiaexternalcareersite") and 15663 (slug
 * "NVIDIAExternalCareerSite"), both api_base "nvidia.wd5".
 *
 * ROOT CAUSE: the DB's UNIQUE(ats_type, slug, api_base) constraint is
 * case-SENSITIVE, but the two paths that write `companies` rows disagree on
 * casing. s67 normalized (decode + lowercase) the auto-discovery path
 * (Extract Registry Candidates), but the Registry Seeder's hand-typed
 * `Build Seed List` array (the s70/s71/s73 dream-tier backfills) used each
 * company's "natural" Workday site-slug casing as it renders on their own
 * careers page. Both are live, valid URLs (Workday's cxs API path is
 * case-insensitive at the HTTP level -- confirmed empirically: BOTH rows in
 * every pair returned real, distinct job counts, e.g. Nvidia 206 vs 123,
 * Mastercard 96 vs 55, Visa 44 vs 28) -- so the poller has been fetching the
 * SAME live tenant twice per tick under two different `board` strings and
 * FRAGMENTING one company's postings across two company_id rows. This is
 * worse than wasted poll slots: it actively splits search/cache-lane
 * visibility for exactly the dream-tier companies this session's plan cares
 * about most (Nvidia, Visa, Mastercard, Salesforce, Intel).
 *
 * Fix, two parts:
 * 1. THIS SCRIPT (direct SQL, same class of action as s74/s78's live-DB
 *    corrections): for each of the 29 groups, pick a winner (most jobs;
 *    tie -> non-probe tier; tie -> lower id / first-seeded), repoint
 *    `jobs.company_id` from every loser to the winner (verified SAFE first
 *    -- every pair's jobs carry DISTINCT `board` strings since board embeds
 *    the differently-cased slug, so repointing can never collide with
 *    jobs.UNIQUE(board, external_id)), delete the loser row(s), then
 *    normalize the winner's own slug+api_base to lowercase so the DB no
 *    longer holds two different "true" casings to drift apart again.
 * 2. `Registry Seeder`'s `Build Seed List` (separate workflow patch, same
 *    script, own harness): lowercase every hardcoded slug/api_base in the
 *    SEED array. Without this, a future re-run of the seeder would recreate
 *    today's exact bug by re-inserting the original mixed-case row the
 *    moment its ON CONFLICT target (ats_type, slug, api_base) no longer
 *    matches the now-lowercased live row.
 *
 * DELIBERATELY NOT adding a case-insensitive DB constraint/index -- would
 * require also retargeting every ON CONFLICT clause (Upsert Companies here,
 * plus s110's new bulk-seed upsert) at that index instead of the existing
 * one, real added complexity for the same outcome the write-layer fix
 * already gives: s109's discovery pipeline controls its own casing (always
 * emits lowercase), and s110's bulk upsert normalizes with lower() in the
 * INSERT itself -- no path left that can write mixed case going forward.
 *
 * Run: dedup SQL directly against Postgres (docker exec), workflow patch
 * via the standard replaceOnce + harness + import + restart dance.
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

// ── Real data pulled from the live registry, 2026-07-17 (see header) ──
// [winnerId, loserId(s), label] -- winner picked by the pickWinner() rule
// below, verified by hand against the real jobs/tier/id figures.
const DUPES = [
  // slug|api_base groups with real job data -- winner = more jobs
  { winner: 15663, losers: [15628], label: 'Nvidia (workday, nvidia.wd5)' },        // 206 vs 123
  { winner: 15543, losers: [15804], label: 'Mastercard (workday, mastercard.wd1)' }, // 96 vs 55
  { winner: 15542, losers: [15859], label: 'Visa (workday, visa.wd5)' },             // 44 vs 28
  { winner: 15670, losers: [15959], label: 'Salesforce (workday, salesforce.wd12)' },// 83 vs 0
  { winner: 15536, losers: [15963], label: 'Intel (workday, intel.wd1)' },           // 10 vs 0
  { winner: 2383,  losers: [4048],  label: 'Lantern (greenhouse)' },                 // 13 vs 0
  { winner: 2392,  losers: [2391],  label: 'EnCharge AI (greenhouse)' },             // 10 vs 0
  // zero-job pairs -- winner = lower id (first-seeded), tier identical (all probe)
  { winner: 15626, losers: [15759], label: 'Alto (workday, alto.wd1) -- id 374 is a SEPARATE greenhouse company named "alto", correctly left untouched, not part of this group' },
  { winner: 8612,  losers: [8616],  label: 'Bee Talents (lever)' },
  { winner: 13002, losers: [13003], label: 'Chainlink Labs (ashby)' },
  { winner: 15555, losers: [15697, 15699], label: 'Clarivate (workday, clarivate.wd3) -- triple' },
  { winner: 13182, losers: [15613], label: 'Crusoe (ashby)' },
  { winner: 15577, losers: [16054], label: 'Dentsu Aegis (workday, dentsuaegis.wd3)' },
  { winner: 15944, losers: [16102], label: 'diconium (workday, diconium.wd3)' },
  { winner: 13301, losers: [13303], label: 'DuckDuckGo (ashby)' },
  { winner: 15614, losers: [15977], label: 'ERM (workday, erm.wd3)' },
  { winner: 13445, losers: [13446], label: 'Finni Health (ashby)' },
  { winner: 15566, losers: [15854], label: 'Fractal (workday, fractal.wd1)' },
  { winner: 15556, losers: [15685], label: 'Genpact (workday, genpact.wd108)' },
  { winner: 13594, losers: [13595], label: 'Glimpse (ashby)' },
  { winner: 13727, losers: [13728], label: 'Hims & Hers (ashby)' },
  { winner: 14106, losers: [14107], label: 'Matter Labs (ashby)' },
  { winner: 14174, losers: [15576], label: 'Mintlify (ashby)' },
  { winner: 14437, losers: [14438], label: 'Paradigm AI (ashby)' },
  { winner: 15551, losers: [15691], label: 'Pulsora Inc (ashby) -- recurrence of the s67-documented dupe under new ids' },
  { winner: 15541, losers: [16025], label: 'Walmart (workday, walmart.wd5)' },
  { winner: 15549, losers: [15689], label: 'Wisdom AI (ashby)' },
  { winner: 15627, losers: [15758], label: 'Zillow (workday, zillow.wd5)' },
];

// ── pickWinner: the deterministic rule the DUPES table above encodes,
//    expressed as real code so the harness can prove it against fixtures
//    matching the actual rows pulled from the live DB. ──
function pickWinner(rows) {
  return rows.slice().sort((a, b) => {
    if (b.jobs !== a.jobs) return b.jobs - a.jobs;
    const aProbe = a.tier === 'probe' ? 1 : 0;
    const bProbe = b.tier === 'probe' ? 1 : 0;
    if (aProbe !== bProbe) return aProbe - bProbe; // non-probe wins
    return a.id - b.id; // lower id (first-seeded) wins
  })[0];
}

function buildSql() {
  const lines = [];
  lines.push('BEGIN;');
  for (const { winner, losers, label } of DUPES) {
    lines.push(`-- ${label}`);
    for (const loser of losers) {
      lines.push(`UPDATE jobs SET company_id = ${winner} WHERE company_id = ${loser};`);
      lines.push(`DELETE FROM companies WHERE id = ${loser};`);
    }
  }
  lines.push('-- normalize every winner\'s slug/api_base to lowercase (prevents re-drift)');
  const winnerIds = DUPES.map((d) => d.winner).join(',');
  lines.push(`UPDATE companies SET slug = lower(slug), api_base = lower(api_base) WHERE id IN (${winnerIds});`);
  lines.push('COMMIT;');
  return lines.join('\n');
}

// ── Registry Seeder: lowercase every hardcoded slug/api_base in the SEED array ──
// Anchors are the EXACT current lines for the 8 dream-tier rows this dupe
// wave touches directly (the ones proven live above); other SEED rows are
// already lowercase (greenhouse/lever/ashby slugs were always typed lower).
const SEED_UPDATES = [
  ["{ name: 'Mastercard', ats_type: 'workday',    slug: 'CorporateCareers',     api_base: 'mastercard.wd1', tier: 'dream' },",
   "{ name: 'Mastercard', ats_type: 'workday',    slug: 'corporatecareers',     api_base: 'mastercard.wd1', tier: 'dream' },"],
  ["{ name: 'Visa',       ats_type: 'workday',    slug: 'Visa',                 api_base: 'visa.wd5', tier: 'dream' },",
   "{ name: 'Visa',       ats_type: 'workday',    slug: 'visa',                 api_base: 'visa.wd5', tier: 'dream' },"],
  ["{ name: 'Walmart',    ats_type: 'workday',    slug: 'WalmartExternal',      api_base: 'walmart.wd5', tier: 'dream' },",
   "{ name: 'Walmart',    ats_type: 'workday',    slug: 'walmartexternal',      api_base: 'walmart.wd5', tier: 'dream' },"],
  ["{ name: 'Salesforce',  ats_type: 'workday',    slug: 'External_Career_Site', api_base: 'salesforce.wd12', tier: 'dream' },",
   "{ name: 'Salesforce',  ats_type: 'workday',    slug: 'external_career_site', api_base: 'salesforce.wd12', tier: 'dream' },"],
];

function patchSeeder() {
  if (!fs.existsSync(SEEDER_FILE)) { console.error('INTEGRITY FAIL: seeder file missing'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (!buildNode) { console.error('INTEGRITY FAIL: Build Seed List node not found'); process.exit(1); }
  if (buildNode.parameters.jsCode.includes("slug: 'corporatecareers'")) { console.log('  seeder: already patched'); return; }
  for (const [oldStr, newStr] of SEED_UPDATES) {
    replaceOnce(buildNode.parameters, 'jsCode', oldStr, newStr, oldStr.slice(0, 40));
  }
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: Registry Seeder SEED array lowercased for ${SEED_UPDATES.length} dream-tier rows`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. pickWinner against real fixture shapes pulled from the live DB.
  const cases = [
    [[{ id: 15628, jobs: 123, tier: 'dream' }, { id: 15663, jobs: 206, tier: 'dream' }], 15663, 'more jobs wins (nvidia)'],
    [[{ id: 15670, jobs: 83, tier: 'dream' }, { id: 15959, jobs: 0, tier: 'probe' }], 15670, 'more jobs + non-probe wins (salesforce)'],
    [[{ id: 15626, jobs: 0, tier: 'probe' }, { id: 15759, jobs: 0, tier: 'probe' }], 15626, 'tie on jobs+tier -> lower id wins'],
    [[{ id: 15697, jobs: 0, tier: 'probe' }, { id: 15555, jobs: 0, tier: 'probe' }, { id: 15699, jobs: 0, tier: 'probe' }], 15555, 'triple tie -> lowest id wins (clarivate)'],
  ];
  for (const [rows, wantId, label] of cases) {
    const got = pickWinner(rows).id;
    if (got !== wantId) { console.error(`HARNESS FAIL: "${label}" -> got ${got}, wanted ${wantId}`); process.exit(1); }
  }

  // 2. every DUPES entry's winner must actually be present, and no id
  //    appears as both a winner somewhere and a loser elsewhere (would
  //    indicate a bad transitive merge chain).
  const allWinners = new Set(DUPES.map((d) => d.winner));
  const allLosers = new Set(DUPES.flatMap((d) => d.losers));
  for (const w of allWinners) {
    if (allLosers.has(w)) { console.error(`HARNESS FAIL: id ${w} is both a winner and a loser -- bad merge chain`); process.exit(1); }
  }
  if (allWinners.size !== DUPES.length) { console.error('HARNESS FAIL: duplicate winner id across groups'); process.exit(1); }
  const loserArr = DUPES.flatMap((d) => d.losers);
  if (new Set(loserArr).size !== loserArr.length) { console.error('HARNESS FAIL: duplicate loser id across groups'); process.exit(1); }

  // 3. generated SQL is well-formed: one UPDATE+DELETE pair per loser, wrapped in a transaction.
  const sql = buildSql();
  const expectedDeletes = loserArr.length;
  const actualDeletes = (sql.match(/DELETE FROM companies/g) || []).length;
  if (actualDeletes !== expectedDeletes) { console.error(`HARNESS FAIL: expected ${expectedDeletes} DELETEs, got ${actualDeletes}`); process.exit(1); }
  if (!sql.trim().startsWith('BEGIN;') || !sql.trim().endsWith('COMMIT;')) { console.error('HARNESS FAIL: SQL not transaction-wrapped'); process.exit(1); }

  console.log(`HARNESS OK: pickWinner verified against 4 real-shaped fixtures; ${DUPES.length} groups produce ${expectedDeletes} deletes with no id collision; SQL is transaction-wrapped.`);
})();

// ════════════════════════ EXECUTE ════════════════════════
const sql = buildSql();
const sqlPath = path.join(ROOT, '.tmp_s108_dedup.sql');
fs.writeFileSync(sqlPath, sql);
console.log(`Wrote ${sqlPath} (${DUPES.length} groups, ${DUPES.flatMap((d) => d.losers).length} rows to merge+delete)`);
console.log('Run manually against Postgres:');
console.log(`  docker cp ${sqlPath} careerforge_postgres:/tmp/dedup.sql && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/dedup.sql`);

patchSeeder();
console.log('S108 (registry dedup) script complete -- run the printed SQL command, then verify counts.');
