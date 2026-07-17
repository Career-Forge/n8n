/**
 * s71_dream_tier_expansion.js -- expands dream tier past the ATS-convenience
 * set (s70's 19) to the actual "IT professional dream company" roster the
 * user asked for: MAANGO-adjacent big tech, traditional MAANG, and high-paying
 * fintech, plus reasonable extensions (quant trading, other AI labs).
 *
 * Every row below is live-HTTP-verified this session (real job counts, not
 * guessed) -- and 2 initial "high confidence" guesses (Goldman Sachs, Tesla)
 * were caught and REVERSED by that verification: both looked like Avature
 * tenants on paper but turned out to have zero live DNS record / a proprietary
 * in-house system respectively. Real reachability:
 *
 *   VERIFIED, seeded:   Anthropic, Jane Street, Point72, SpaceX (+ its
 *                        separate international board), xAI (all Greenhouse);
 *                        Perplexity (Ashby); Nvidia, Barclays, Morgan Stanley
 *                        (Workday). LinkedIn promoted from its existing
 *                        SmartRecruiters row (no new seed needed).
 *   NO VIABLE ADAPTER:   JPMorgan Chase, Uber, Goldman Sachs -- all confirmed
 *                        Oracle Cloud HCM. Citadel -- no match on any of the 9
 *                        platforms, site blocks generic fetches. Snowflake --
 *                        Phenom People. Tesla -- proprietary in-house ATS, no
 *                        third-party platform at all.
 *   FOUND BUT NOT SEEDED (adapter gap, not a dead end): Bloomberg and Two
 *                        Sigma are BOTH genuinely on Avature -- but neither
 *                        fits this adapter's v1 scope. Bloomberg's real
 *                        listing page has ZERO of the `article--card` blocks
 *                        fetchAvature parses and uses path-style
 *                        `JobDetail/<slug>/<id>` links exclusively (confirmed
 *                        by inspecting the actual captured page -- 24 links,
 *                        all path-style, 0 query-style) -- this was disclosed
 *                        as a known gap in s69's own commit message before
 *                        Bloomberg was ever a concrete candidate. Two Sigma
 *                        sits behind a custom domain (careers.twosigma.com,
 *                        CNAME to twosigma.avature.net) with a differently-
 *                        named listing page (OpenRoles, not SearchJobs) --
 *                        the raw tenant host 404s directly. Seeding either
 *                        with the current adapter would silently poll
 *                        "successfully" while extracting zero jobs -- worse
 *                        than not seeding, since it would look healthy in the
 *                        registry while contributing nothing. Real follow-up:
 *                        extend fetchAvature with a second card-parsing
 *                        pattern and a per-company host/path override field,
 *                        not attempted here.
 *
 * No node count change. Run: inside the n8n container with the repo staged
 * under /tmp. The actual seed insert already ran directly against Postgres
 * (matching this session's standing pattern for registry backfills -- `n8n
 * execute` conflicts with the already-running server); this script exists so
 * the roster is tracked in git as the source of truth for future re-seeds,
 * not just live DB state.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Registry_Seeder.json'),
];

const SEED_OLD =
  "  { name: 'IBM', ats_type: 'avature', slug: 'ibmglobal', api_base: 'careers' },\n" +
  "];";
const SEED_NEW =
  "  { name: 'IBM', ats_type: 'avature', slug: 'ibmglobal', api_base: 'careers' },\n" +
  "  // s71: the actual \"IT professional dream company\" roster (MAANGO-adjacent,\n" +
  "  // traditional MAANG, high-paying fintech/quant) -- all live-verified, tier\n" +
  "  // dream. 2 initial high-confidence guesses (Goldman Sachs, Tesla) were\n" +
  "  // caught and reversed by live verification -- see the script header for\n" +
  "  // the full reachability breakdown, including Bloomberg/Two Sigma, which\n" +
  "  // ARE real Avature tenants but don't fit this adapter's v1 scope yet.\n" +
  "  { name: 'Anthropic',      ats_type: 'greenhouse', slug: 'anthropic',                     api_base: '', tier: 'dream' },\n" +
  "  { name: 'Jane Street',    ats_type: 'greenhouse', slug: 'janestreet',                    api_base: '', tier: 'dream' },\n" +
  "  { name: 'Point72',        ats_type: 'greenhouse', slug: 'point72',                       api_base: '', tier: 'dream' },\n" +
  "  { name: 'SpaceX',         ats_type: 'greenhouse', slug: 'spacex',                        api_base: '', tier: 'dream' },\n" +
  "  { name: 'SpaceX Global',  ats_type: 'greenhouse', slug: 'spacexglobal',                  api_base: '', tier: 'dream' },\n" +
  "  { name: 'xAI',            ats_type: 'greenhouse', slug: 'xai',                           api_base: '', tier: 'dream' },\n" +
  "  { name: 'Perplexity',     ats_type: 'ashby',      slug: 'perplexity',                    api_base: '', tier: 'dream' },\n" +
  "  { name: 'Nvidia',         ats_type: 'workday',    slug: 'NVIDIAExternalCareerSite',      api_base: 'nvidia.wd5',   tier: 'dream' },\n" +
  "  { name: 'Barclays',       ats_type: 'workday',    slug: 'External_Career_Site_Barclays', api_base: 'barclays.wd3', tier: 'dream' },\n" +
  "  { name: 'Morgan Stanley', ats_type: 'workday',    slug: 'External',                      api_base: 'ms.wd5',       tier: 'dream' },\n" +
  "];";

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
  if (N['Build Seed List'].parameters.jsCode.includes('Anthropic')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Seed List'].parameters, 'jsCode', SEED_OLD, SEED_NEW, 's71 dream-tier expansion', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: 10 new dream-tier companies added to the tracked seed list -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  const fullSeed = new Function(SEED_NEW.replace('];', '];\nreturn SEED;').replace(
    "  { name: 'IBM', ats_type: 'avature', slug: 'ibmglobal', api_base: 'careers' },\n",
    "const SEED = [{ name: 'IBM', ats_type: 'avature', slug: 'ibmglobal', api_base: 'careers' },\n"
  ))();
  const newRows = fullSeed.filter((c) => c.name !== 'IBM');
  if (newRows.length !== 10) { console.error('HARNESS FAIL: expected exactly 10 new rows', newRows.length); process.exit(1); }
  const byType = {};
  for (const c of newRows) {
    if (!c.name || !c.ats_type || !c.slug || c.tier !== 'dream') { console.error('HARNESS FAIL: row missing required field or wrong tier', c); process.exit(1); }
    byType[c.ats_type] = (byType[c.ats_type] || 0) + 1;
    if (c.ats_type === 'workday' && !/^[\w-]+\.wd\d+$/.test(c.api_base)) { console.error('HARNESS FAIL: workday api_base must match tenant.wdN shape', c); process.exit(1); }
  }
  if (byType.greenhouse !== 6 || byType.ashby !== 1 || byType.workday !== 3) { console.error('HARNESS FAIL: wrong per-type counts', byType); process.exit(1); }
  const keys = new Set(newRows.map((c) => c.ats_type + '|' + c.slug.toLowerCase()));
  if (keys.size !== 10) { console.error('HARNESS FAIL: duplicate (ats_type, slug) pairs', newRows); process.exit(1); }
  console.log('HARNESS OK: 10 new dream-tier rows -- 6 Greenhouse, 1 Ashby, 3 Workday -- correct shape, all tier=dream, no duplicates');
})();

SEEDER_TARGETS.forEach(patchSeeder);
console.log('S71 (dream-tier expansion: MAANGO/fintech/quant roster) complete.');
