/**
 * s59_cache_filter_sort_newest.js -- v9 wave Area A1+A2, the last 2 real gaps in
 * Phase 4.1's cache-first scoring (everything else -- 150-cap pool, 30-cap scorer
 * batch, RRF-ranked appendix, tier badges -- was already live before this wave).
 *
 * A1 -- Hybrid Cache Search had zero location/remote predicate in its SQL, relying
 * entirely on Aggregate Jobs' downstream JS three-state filter after merging with
 * the other 5 search lanes. Deliberately NOT porting Aggregate Jobs' full
 * COUNTRY_NAMES/checkLocationState matcher into SQL (that's the exact risk this gap
 * warns about -- a subtly-wrong SQL matcher could silently drop good jobs pre-merge
 * with no fallback). Instead: a coarse, permissive pre-filter that can only shrink
 * the cache lane's OWN contribution, never touch the other 5 lanes, and never
 * override the real downstream filter (which still runs unchanged on the merged
 * set). Pre-flight: Providers computes cache_loc_terms/cache_remote_only using the
 * EXACT SAME hasCityConstraint/locTerms gate Aggregate Jobs already uses (hand-
 * copied -- n8n Code nodes can't share modules -- so the SQL filter and the JS
 * filter always agree on "is this even a location-scoped search"). Hybrid Cache
 * Search's SQL then: keeps a cached job if it's remote, OR its location is
 * null/empty (matches the existing "unknown -> kept, never guessed-dropped"
 * policy), OR its location text loosely matches a query term; separately, for
 * remote_preference==='remote_only', hard-requires j.remote=true (safe as a hard
 * filter -- plain boolean column, no lookup-table risk). This is intentionally
 * stricter than Aggregate Jobs is for remote-only queries today -- a scoped
 * exception limited to the cache lane, not backported elsewhere.
 *
 * A2 -- adds sort_by: "relevance" (default) | "newest" end to end: Expand Query's
 * prompt+schema, Parse Expand Query's default-cascade (same pattern every other
 * field already uses), Aggregate Jobs' sort (location_verified always stays first --
 * it's a correctness concern, "newest" must never resurrect a wrong-location job
 * ahead of a right-location one -- tier is dropped when sort_by==='newest' since
 * it's purely a display preference), and Build Telegraph Body's rankedJobs.sort
 * (newest mode = pure recency, both tier and score dropped -- most literal reading
 * of "show me what's newest"). The Telegraph appendix's own sort is deliberately
 * left untouched either way -- already explicitly labeled a relevance-only estimate.
 *
 * No node count change.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ A1a. Pre-flight: Providers -- compute cache_loc_terms/cache_remote_only ═══
const PFP_OLD =
  "// Pre-flight: Providers v2\n" +
  "// All three providers now use n8n credentials (no env vars needed on Cloud).\n" +
  "// We assume each is active if the user has configured the credential — n8n\n" +
  "// will surface a per-node auth error if a credential is missing or invalid.\n" +
  "const ctx = $input.first().json;\n" +
  "const active = ['Firecrawl 🔥', 'You.com 🔍', 'Serper ⚡'];\n" +
  "return [{ json: {\n" +
  "  ...ctx,\n" +
  "  _providers_active: active,\n" +
  "  _providers_count: active.length,\n" +
  "  _no_providers: false\n" +
  "}}];";
const PFP_NEW =
  "// Pre-flight: Providers v2\n" +
  "// All three providers now use n8n credentials (no env vars needed on Cloud).\n" +
  "// We assume each is active if the user has configured the credential — n8n\n" +
  "// will surface a per-node auth error if a credential is missing or invalid.\n" +
  "const ctx = $input.first().json;\n" +
  "const active = ['Firecrawl 🔥', 'You.com 🔍', 'Serper ⚡'];\n" +
  "// v9 A1: coarse location/remote pre-filter terms for Hybrid Cache Search's SQL --\n" +
  "// mirrors Aggregate Jobs' own hasCityConstraint/locTerms gate exactly so the SQL\n" +
  "// pre-filter and the real downstream JS filter never disagree on \"is this even a\n" +
  "// location-scoped search.\" Deliberately duplicated, not shared (n8n Code nodes\n" +
  "// can't share modules) -- keep in sync with Aggregate Jobs if that gate changes.\n" +
  "const locationCanon = (ctx.location_canonical || '').trim().toLowerCase();\n" +
  "const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon);\n" +
  "const cacheLocTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter((t) => t.length > 1).join(',') : '';\n" +
  "const cacheRemoteOnly = ctx.remote_preference === 'remote_only' ? 'true' : '';\n" +
  "return [{ json: {\n" +
  "  ...ctx,\n" +
  "  _providers_active: active,\n" +
  "  _providers_count: active.length,\n" +
  "  _no_providers: false,\n" +
  "  cache_loc_terms: cacheLocTerms,\n" +
  "  cache_remote_only: cacheRemoteOnly\n" +
  "}}];";

// ═══ A1b. Hybrid Cache Search -- SQL predicate in both vec and kw CTEs ═══
const HCS_VEC_OLD = "AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 200)";
const HCS_VEC_NEW = "AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL AND ($3 = '' OR j.remote = true OR j.location IS NULL OR j.location = '' OR EXISTS (SELECT 1 FROM unnest(string_to_array(lower($3), ',')) AS term WHERE lower(j.location) LIKE '%' || term || '%')) AND ($4 <> 'true' OR j.remote = true) ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 200)";
const HCS_KW_OLD = "AND (SELECT qtext FROM q)::text <> '' AND j.jd_tsv @@ (SELECT qtext FROM q) ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 200)";
const HCS_KW_NEW = "AND (SELECT qtext FROM q)::text <> '' AND j.jd_tsv @@ (SELECT qtext FROM q) AND ($3 = '' OR j.remote = true OR j.location IS NULL OR j.location = '' OR EXISTS (SELECT 1 FROM unnest(string_to_array(lower($3), ',')) AS term WHERE lower(j.location) LIKE '%' || term || '%')) AND ($4 <> 'true' OR j.remote = true) ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 200)";

const HCS_QR_OLD = "={{ [ ($json.embeddings && $json.embeddings[0] && $json.embeddings[0].length===1024) ? ('[' + $json.embeddings[0].join(',') + ']') : null, (($('Pre-flight: Providers').first().json.role_families)||[]).join(' ') ] }}";
const HCS_QR_NEW = "={{ [ ($json.embeddings && $json.embeddings[0] && $json.embeddings[0].length===1024) ? ('[' + $json.embeddings[0].join(',') + ']') : null, (($('Pre-flight: Providers').first().json.role_families)||[]).join(' '), $('Pre-flight: Providers').first().json.cache_loc_terms || '', $('Pre-flight: Providers').first().json.cache_remote_only || '' ] }}";

// ═══ A2a. Expand Query prompt + parser schema ═══
const EQ_PROMPT_OLD = '- freshness: "qdr:d" (24hrs) | "qdr:w" (1 week, DEFAULT) | "qdr:m" (1 month)';
const EQ_PROMPT_NEW = '- freshness: "qdr:d" (24hrs) | "qdr:w" (1 week, DEFAULT) | "qdr:m" (1 month)\n- sort_by: "relevance" (DEFAULT) | "newest" -- set to "newest" ONLY on explicit recency language ("newest", "most recent", "just posted", "latest"); otherwise "relevance"';
const EQ_SCHEMA_OLD = '"freshness":{"type":"string"},';
const EQ_SCHEMA_NEW = '"freshness":{"type":"string"},"sort_by":{"type":"string"},';

// ═══ A2b. Parse Expand Query -- default cascade ═══
const PEQ_OLD = "freshness:          parsed.freshness            || userPrefs.freshness           || 'qdr:w',";
const PEQ_NEW = "freshness:          parsed.freshness            || userPrefs.freshness           || 'qdr:w',\n  sort_by:            parsed.sort_by              || userPrefs.sort_by             || 'relevance',";

// ═══ A2c. Aggregate Jobs -- drop the tier level of the sort when sort_by==='newest' ═══
const AGG_SORT_OLD =
  "filtered.sort((a, b) => {\n" +
  "  const locDiff = (a.location_verified === true ? 0 : 1) - (b.location_verified === true ? 0 : 1);\n" +
  "  if (locDiff !== 0) return locDiff;\n" +
  "  const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);\n" +
  "  if (tierDiff !== 0) return tierDiff;\n" +
  "  const ad = new Date(a.updated_at || 0).getTime() || 0;\n" +
  "  const bd = new Date(b.updated_at || 0).getTime() || 0;\n" +
  "  return bd - ad;\n" +
  "});";
const AGG_SORT_NEW =
  "const _sortNewest = expandCtx.sort_by === 'newest';\n" +
  "filtered.sort((a, b) => {\n" +
  "  const locDiff = (a.location_verified === true ? 0 : 1) - (b.location_verified === true ? 0 : 1);\n" +
  "  if (locDiff !== 0) return locDiff;\n" +
  "  if (!_sortNewest) {\n" +
  "    const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);\n" +
  "    if (tierDiff !== 0) return tierDiff;\n" +
  "  }\n" +
  "  const ad = new Date(a.updated_at || 0).getTime() || 0;\n" +
  "  const bd = new Date(b.updated_at || 0).getTime() || 0;\n" +
  "  return bd - ad;\n" +
  "});";

// ═══ A2d. Build Telegraph Body -- rankedJobs.sort, pure recency in newest mode ═══
const BTB_SORT_OLD =
  "  .sort((a, b) => {\n" +
  "    const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);\n" +
  "    if (tierDiff !== 0) return tierDiff;\n" +
  "    const scoreDiff = (b.score100 || 0) - (a.score100 || 0);\n" +
  "    if (scoreDiff !== 0) return scoreDiff;\n" +
  "    return (new Date(b.updated_at || 0).getTime() || 0) - (new Date(a.updated_at || 0).getTime() || 0);\n" +
  "  })";
const BTB_SORT_NEW =
  "  .sort((a, b) => {\n" +
  "    if (intent.sort_by === 'newest') {\n" +
  "      return (new Date(b.updated_at || 0).getTime() || 0) - (new Date(a.updated_at || 0).getTime() || 0);\n" +
  "    }\n" +
  "    const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);\n" +
  "    if (tierDiff !== 0) return tierDiff;\n" +
  "    const scoreDiff = (b.score100 || 0) - (a.score100 || 0);\n" +
  "    if (scoreDiff !== 0) return scoreDiff;\n" +
  "    return (new Date(b.updated_at || 0).getTime() || 0) - (new Date(a.updated_at || 0).getTime() || 0);\n" +
  "  })";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const need of ['Pre-flight: Providers', 'Hybrid Cache Search', 'Expand Query', 'Expand Query Output Parser', 'Parse Expand Query', 'Aggregate Jobs', 'Build Telegraph Body']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Pre-flight: Providers'].parameters.jsCode.includes('cache_loc_terms')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Pre-flight: Providers'].parameters, 'jsCode', PFP_OLD, PFP_NEW, 'Pre-flight: Providers cache filter terms', base);
  replaceOnce(N['Hybrid Cache Search'].parameters, 'query', HCS_VEC_OLD, HCS_VEC_NEW, 'Hybrid Cache Search vec CTE filter', base);
  replaceOnce(N['Hybrid Cache Search'].parameters, 'query', HCS_KW_OLD, HCS_KW_NEW, 'Hybrid Cache Search kw CTE filter', base);
  replaceOnce(N['Hybrid Cache Search'].parameters.options, 'queryReplacement', HCS_QR_OLD, HCS_QR_NEW, 'Hybrid Cache Search queryReplacement', base);
  replaceOnce(N['Expand Query'].parameters.messages.messageValues[0], 'message', EQ_PROMPT_OLD, EQ_PROMPT_NEW, 'Expand Query sort_by prompt bullet', base);
  replaceOnce(N['Expand Query Output Parser'].parameters, 'inputSchema', EQ_SCHEMA_OLD, EQ_SCHEMA_NEW, 'Expand Query Output Parser sort_by schema', base);
  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', PEQ_OLD, PEQ_NEW, 'Parse Expand Query sort_by cascade', base);
  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', AGG_SORT_OLD, AGG_SORT_NEW, 'Aggregate Jobs newest-mode sort', base);
  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', BTB_SORT_OLD, BTB_SORT_NEW, 'Build Telegraph Body newest-mode sort', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: cache hard-filter + sort_by newest mode wired -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // A1a. Pre-flight: Providers cache_loc_terms/cache_remote_only -- mirrors Aggregate
  // Jobs' own gate exactly (broad query -> '', scoped city -> terms, remote_only -> 'true').
  {
    const run = (ctx) => new Function('$input', PFP_NEW)({ first: () => ({ json: ctx }) })[0].json;
    const broad = run({ location_canonical: 'any', remote_preference: 'open' });
    if (broad.cache_loc_terms !== '') { console.error('HARNESS FAIL: broad/any location should produce empty loc terms', broad); process.exit(1); }
    const scoped = run({ location_canonical: 'New York, New York, United States', remote_preference: 'open' });
    if (scoped.cache_loc_terms !== 'new,york,new,york,united,states') { console.error('HARNESS FAIL: scoped location terms wrong', scoped); process.exit(1); }
    const remoteOnly = run({ location_canonical: null, remote_preference: 'remote_only' });
    if (remoteOnly.cache_remote_only !== 'true') { console.error('HARNESS FAIL: remote_only flag should be "true"', remoteOnly); process.exit(1); }
    const notRemoteOnly = run({ location_canonical: null, remote_preference: 'hybrid_ok' });
    if (notRemoteOnly.cache_remote_only !== '') { console.error('HARNESS FAIL: non-remote-only should produce empty flag', notRemoteOnly); process.exit(1); }
  }
  console.log('HARNESS OK: Pre-flight: Providers computes cache_loc_terms/cache_remote_only matching Aggregate Jobs\' own hasCityConstraint gate exactly');

  // A1b. SQL predicate shape: the FULL patched query (not just the anchor fragment,
  // which intentionally ends mid-CTE and is never balanced on its own) must be
  // paren-balanced, and each CTE's new clause must reference $3/$4 with the intended
  // permissive structure (remote OR null-location OR term-match) plus the hard
  // remote_only clause. A live end-to-end SQL smoke test runs post-deploy (this
  // harness only proves the string surgery is structurally sound before any write).
  {
    // Reconstruct one full CTE fragment (open paren through the new predicate) to
    // check balance against its own opening -- this is what patch() actually
    // produces per CTE, not an isolated tail substring.
    const VEC_OPEN = "vec AS (SELECT j.id, row_number() OVER (ORDER BY j.embedding <=> (SELECT qvec FROM q)) AS rnk FROM jobs j WHERE j.status='active' ";
    const KW_OPEN = "kw AS (SELECT j.id, row_number() OVER (ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC) AS rnk FROM jobs j WHERE j.status='active' ";
    for (const [label, open, sql] of [['vec', VEC_OPEN, HCS_VEC_NEW], ['kw', KW_OPEN, HCS_KW_NEW]]) {
      const full = open + sql;
      let depth = 0;
      for (const ch of full) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) { console.error(`HARNESS FAIL: ${label} CTE goes paren-negative before the end`, full); process.exit(1); } }
      if (depth !== 0) { console.error(`HARNESS FAIL: ${label} CTE predicate has unbalanced parens (depth ${depth})`, full); process.exit(1); }
      if (!sql.includes("$3 = ''") || !sql.includes('j.remote = true') || !sql.includes("j.location IS NULL") || !sql.includes("j.location = ''")) { console.error(`HARNESS FAIL: ${label} CTE missing permissive-filter clauses`); process.exit(1); }
      if (!sql.includes("$4 <> 'true'")) { console.error(`HARNESS FAIL: ${label} CTE missing remote_only hard clause`); process.exit(1); }
    }
  }
  console.log('HARNESS OK: Hybrid Cache Search SQL predicates are syntactically balanced, permissive (remote/null-location/term-match survive), and hard-enforce remote_only');

  // A2b. Parse Expand Query sort_by cascade: parsed value wins, falls back to prefs, defaults to relevance.
  {
    const run = (parsed, userPrefs) => new Function('parsed', 'userPrefs', 'return {' + PEQ_NEW + '};')(parsed, userPrefs);
    const explicit = run({ sort_by: 'newest' }, {});
    if (explicit.sort_by !== 'newest') { console.error('HARNESS FAIL: explicit sort_by should win', explicit); process.exit(1); }
    const prefFallback = run({}, { sort_by: 'newest' });
    if (prefFallback.sort_by !== 'newest') { console.error('HARNESS FAIL: prefs fallback should apply when unstated', prefFallback); process.exit(1); }
    const defaulted = run({}, {});
    if (defaulted.sort_by !== 'relevance') { console.error('HARNESS FAIL: should default to relevance', defaulted); process.exit(1); }
  }
  console.log('HARNESS OK: Parse Expand Query sort_by cascade -- explicit wins, prefs fill the gap, defaults to relevance (backward compatible)');

  // A2c. Aggregate Jobs sort: relevance mode unchanged (location -> tier -> recency);
  // newest mode drops tier but keeps location_verified authoritative.
  {
    const run = (jobs, sortBy) => { const expandCtx = { sort_by: sortBy }; const filtered = jobs.slice(); new Function('filtered', 'expandCtx', AGG_SORT_NEW)(filtered, expandCtx); return filtered; };
    const jobs = [
      { id: 'a', location_verified: true, source_tier: 3, updated_at: '2026-07-01' },
      { id: 'b', location_verified: true, source_tier: 1, updated_at: '2026-07-05' },
      { id: 'c', location_verified: false, source_tier: 1, updated_at: '2026-07-10' },
    ];
    const relevance = run(jobs, 'relevance');
    if (relevance[0].id !== 'b' || relevance[1].id !== 'a' || relevance[2].id !== 'c') { console.error('HARNESS FAIL: relevance mode should be unchanged (verified-location first, then tier)', relevance.map((j) => j.id)); process.exit(1); }
    const newest = run(jobs, 'newest');
    if (newest[2].id !== 'c') { console.error('HARNESS FAIL: unverified location must still sort last even in newest mode', newest.map((j) => j.id)); process.exit(1); }
    if (newest[0].id !== 'b' || newest[1].id !== 'a') { console.error('HARNESS FAIL: within verified jobs, newest mode should ignore tier and sort by recency only', newest.map((j) => j.id)); process.exit(1); }
  }
  console.log('HARNESS OK: Aggregate Jobs -- relevance mode byte-identical to today, newest mode drops tier but never resurrects an unverified-location job ahead of a verified one');

  // A2d. Build Telegraph Body rankedJobs.sort: relevance mode unchanged, newest mode pure recency.
  {
    const run = (jobs, sortBy) => { const intent = { sort_by: sortBy }; const arr = jobs.slice(); return new Function('intent', 'arr', 'return arr.slice()' + BTB_SORT_NEW + ';')(intent, arr); };
    const jobs = [
      { id: 'x', source_tier: 3, score100: 90, updated_at: '2026-07-01' },
      { id: 'y', source_tier: 1, score100: 50, updated_at: '2026-07-08' },
    ];
    const relevance = run(jobs, 'relevance');
    if (relevance[0].id !== 'y') { console.error('HARNESS FAIL: relevance mode should be unchanged (tier wins over score/recency)', relevance.map((j) => j.id)); process.exit(1); }
    const newest = run(jobs, 'newest');
    if (newest[0].id !== 'y') { console.error('HARNESS FAIL: newest mode should sort by recency, y is newer', newest.map((j) => j.id)); process.exit(1); }
    const jobs2 = [
      { id: 'older-high-tier', source_tier: 1, score100: 99, updated_at: '2026-06-01' },
      { id: 'newer-low-tier', source_tier: 3, score100: 10, updated_at: '2026-07-09' },
    ];
    const newest2 = run(jobs2, 'newest');
    if (newest2[0].id !== 'newer-low-tier') { console.error('HARNESS FAIL: newest mode must ignore tier/score entirely, purely recency', newest2.map((j) => j.id)); process.exit(1); }
  }
  console.log('HARNESS OK: Build Telegraph Body rankedJobs.sort -- relevance mode byte-identical to today, newest mode is pure recency ignoring tier and score');
})();

TARGETS.forEach(patch);
console.log('S59 (v9 Area A1+A2: Hybrid Cache Search hard location/remote pre-filter + sort_by relevance/newest mode) complete.');
