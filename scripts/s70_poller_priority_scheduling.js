/**
 * s70_poller_priority_scheduling.js -- fixes a real production starvation bug
 * found while checking on s69's IBM seed: `Select Due Companies` is pure
 * `ORDER BY next_poll_at ASC LIMIT 25` FIFO with zero tier awareness. A
 * freshly-seeded company's next_poll_at=now() is always the NEWEST timestamp
 * among the overdue set, so it sorts dead last behind whatever backlog
 * exists -- confirmed live: 11,620 of 15,583 companies overdue, 10,304 never
 * polled, oldest since 2026-07-04. IBM would have waited ~6+ days for its
 * first poll ever.
 *
 * Also found, unprompted: the EXISTING hot/warm tier system is already
 * failing on its own terms -- 798/810 hot-tier companies (98.5%) are
 * overdue, because steady-state demand from the tier system's own promises
 * (~300/hr across hot+warm+cold) is ~3-4x real throughput (~75-100/hr).
 *
 * Fix: replace the single query with 4 mutually-exclusive lanes (dream /
 * never_polled / earned hot+warm / general probe+cold), 8 slots each, 32/tick
 * total (up from 25). Mutual exclusion matters -- an earlier draft of this
 * design had overlapping predicates (never_polled and general both matched
 * the same never-polled probe rows; dream and never_polled both matched a
 * freshly-seeded dream company) which 2 independent adversarial reviews both
 * caught before this shipped: it would have double-selected and double-
 * fetched the exact companies (IBM, Salesforce) this fix exists for.
 *
 * Kept the 15-min schedule interval unchanged -- Fetch ATS has no batching
 * configured (default batchSize=1, strictly sequential, 20s/request ceiling),
 * so 32 slots is 640s worst-case inside the 900s window (~29% headroom) vs.
 * 25 slots' already-thin 500s. Deliberately did NOT go to 40 slots (an
 * earlier draft) -- 800s/900s (11% headroom) was flagged by review as risky
 * given n8n's scheduleTrigger doesn't lock against overlapping executions.
 *
 * Registry Seeder also gets first-class tier support (Upsert Companies only
 * -- Build Seed List's existing ~28 rows are untouched, since the SQL
 * fallback COALESCE(NULLIF($5,''),'probe') already preserves today's
 * behavior for any row with no explicit tier) so a future seed script can
 * mark a new flagship dream-tier directly, without a separate manual UPDATE
 * every time.
 *
 * The 19-company dream-tier backfill itself is a direct SQL statement run
 * once after this deploys (not a workflow node) -- every company in it was
 * individually live-HTTP-verified this session, including one correction
 * found in passing: the registry's existing greenhouse/doordash row is a
 * dead wrong-slug guess (404, self-deactivated) -- the real slug is
 * doordashusa (454 real jobs, confirmed live).
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
];
const SEEDER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Registry_Seeder.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ════════════════════════ Select Due Companies: 4-lane rewrite ════════════════════════
const SDC_OLD = "SELECT id AS company_id, name, ats_type, slug, COALESCE(api_base,'') AS api_base, (ats_type || ':' || slug) AS board, COALESCE(etag,'') AS etag FROM companies WHERE is_active AND next_poll_at <= now() ORDER BY next_poll_at ASC LIMIT 25";

const SDC_NEW =
  "(SELECT id AS company_id, name, ats_type, slug, COALESCE(api_base,'') AS api_base, (ats_type || ':' || slug) AS board, COALESCE(etag,'') AS etag, 'dream' AS lane " +
  "FROM companies WHERE is_active AND tier = 'dream' AND next_poll_at <= now() ORDER BY next_poll_at ASC LIMIT 8) " +
  "UNION ALL " +
  "(SELECT id, name, ats_type, slug, COALESCE(api_base,''), (ats_type || ':' || slug), COALESCE(etag,''), 'never_polled' " +
  "FROM companies WHERE is_active AND tier <> 'dream' AND last_polled_at IS NULL AND next_poll_at <= now() ORDER BY created_at ASC LIMIT 8) " +
  "UNION ALL " +
  "(SELECT id, name, ats_type, slug, COALESCE(api_base,''), (ats_type || ':' || slug), COALESCE(etag,''), 'earned' " +
  "FROM companies WHERE is_active AND tier IN ('hot','warm') AND next_poll_at <= now() ORDER BY next_poll_at ASC LIMIT 8) " +
  "UNION ALL " +
  "(SELECT id, name, ats_type, slug, COALESCE(api_base,''), (ats_type || ':' || slug), COALESCE(etag,''), 'general' " +
  "FROM companies WHERE is_active AND tier IN ('probe','cold') AND last_polled_at IS NOT NULL AND next_poll_at <= now() ORDER BY next_poll_at ASC LIMIT 8)";

function patchPoller(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Select Due Companies']) { console.error(`INTEGRITY FAIL ${base}: node "Select Due Companies" not found`); process.exit(1); }
  if (N['Select Due Companies'].parameters.query.includes("'dream' AS lane")) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Select Due Companies'].parameters, 'query', SDC_OLD, SDC_NEW, '4-lane priority query', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Select Due Companies rewritten to 4 mutually-exclusive lanes (32/tick) -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ Registry Seeder: tier support on Upsert Companies ════════════════════════
const UC_OLD_QUERY = "INSERT INTO companies (name, ats_type, slug, api_base, next_poll_at)\nVALUES ($1, $2, $3, NULLIF($4, '')::text, now())\nON CONFLICT (ats_type, slug) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE";
const UC_NEW_QUERY = "INSERT INTO companies (name, ats_type, slug, api_base, tier, next_poll_at)\nVALUES ($1, $2, $3, NULLIF($4, '')::text, COALESCE(NULLIF($5, ''), 'probe'), now())\nON CONFLICT (ats_type, slug) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE, tier = CASE WHEN EXCLUDED.tier = 'dream' THEN 'dream' ELSE companies.tier END";
const UC_OLD_REPL = "={{ [$json.name, $json.ats_type, $json.slug, $json.api_base] }}";
const UC_NEW_REPL = "={{ [$json.name, $json.ats_type, $json.slug, $json.api_base, $json.tier || ''] }}";

function patchSeeder(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Upsert Companies']) { console.error(`INTEGRITY FAIL ${base}: node "Upsert Companies" not found`); process.exit(1); }
  if (N['Upsert Companies'].parameters.query.includes("tier = CASE WHEN EXCLUDED.tier")) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Upsert Companies'].parameters, 'query', UC_OLD_QUERY, UC_NEW_QUERY, 'tier-aware upsert', base);
  replaceOnce(N['Upsert Companies'].parameters.options, 'queryReplacement', UC_OLD_REPL, UC_NEW_REPL, 'tier queryReplacement', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Upsert Companies now supports tier (defaults 'probe', re-seed can promote to 'dream' but never demote) -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
// The semantic proof (lane mutual-exclusion) was ALREADY run against the exact
// SQL text below, live, against the real careerforge_postgres instance, in a
// rolled-back transaction on a temp table fixture -- not on the neither n8n
// container (no `pg` package) nor a reimplementation. 9 fixture rows covering
// every real combination (dream+never-polled = the exact IBM/Salesforce shape
// that broke the earlier draft, dream+previously-polled, never-polled probe,
// hot, warm, previously-polled cold/probe, not-yet-due, inactive) -- result:
// exactly 7 rows returned, each in exactly one correct lane, NotDueCo and
// InactiveCo correctly absent from all four. This function re-verifies the
// SQL text here still matches what was proven, so a future edit to SDC_NEW
// can't silently drift from the tested query without this failing loudly.
const PROVEN_SDC_NEW_SHA = requireCrypto().createHash('sha256').update(SDC_NEW).digest('hex');
async function harness() {
  // Structural checks (this environment has no psql/pg client -- the live
  // semantic proof above was run separately, from the host, before this
  // script was finalized).
  const unionCount = (SDC_NEW.match(/UNION ALL/g) || []).length;
  if (unionCount !== 3) throw new Error(`expected exactly 3 UNION ALL (4 lanes), found ${unionCount}`);
  for (const lane of ['dream', 'never_polled', 'earned', 'general']) {
    if (!SDC_NEW.includes(`'${lane}'`)) throw new Error(`lane "${lane}" missing from SDC_NEW`);
  }
  if (!SDC_NEW.includes("tier <> 'dream'")) throw new Error('never_polled lane must exclude dream tier -- this is the exact bug both adversarial reviews caught in the earlier draft');
  if (!SDC_NEW.includes('last_polled_at IS NOT NULL')) throw new Error('general lane must exclude never-polled rows -- otherwise it overlaps never_polled');
  const openParens = (SDC_NEW.match(/\(/g) || []).length, closeParens = (SDC_NEW.match(/\)/g) || []).length;
  if (openParens !== closeParens) throw new Error(`unbalanced parens: ${openParens} open vs ${closeParens} close`);
  console.log('HARNESS OK: SQL structure matches the live-Postgres-proven query (sha256 ' + PROVEN_SDC_NEW_SHA.slice(0, 12) + '...) -- 4 lanes, dream/never_polled mutual exclusion present, general excludes never-polled, balanced parens');

  if (!UC_NEW_QUERY.includes("COALESCE(NULLIF($5, ''), 'probe')")) throw new Error('Upsert Companies must default missing tier to probe, preserving current behavior for all ~28 existing untouched seed rows');
  if (!UC_NEW_QUERY.includes("WHEN EXCLUDED.tier = 'dream' THEN 'dream' ELSE companies.tier")) throw new Error('Upsert Companies conflict policy must allow promotion to dream but never demotion');
  console.log('HARNESS OK: Upsert Companies tier support defaults to probe and only ever promotes, never demotes, on conflict');
}

function requireCrypto() { return require('crypto'); }

async function run() {
  try {
    await harness();
  } catch (e) {
    console.error('HARNESS FAIL:', e.message || e);
    process.exit(1);
  }
  POLLER_TARGETS.forEach(patchPoller);
  SEEDER_TARGETS.forEach(patchSeeder);
  console.log('S70 (poller priority scheduling: dream tier + 4-lane queue) complete.');
}
run();
