/**
 * s80_cache_company_targeting.js -- the cache lane now targets companies when
 * the query does. Found via the post-s79 MAANG retest trace (exec 578):
 * location handling was fully fixed ('worldwide' honored, 267 raw candidates),
 * but the digest still showed only 3 jobs -- and ZERO came from the cache,
 * despite the cache holding 19 active MAANG jobs (Amazon 7, Netflix 9,
 * Apple 3) at query time.
 *
 * Root cause: Hybrid Cache Search ranks the WHOLE 10.6K-job cache by semantic
 * + keyword relevance and returns the top 150. On a cohort query ("MAANG",
 * "FAANG"), those 150 are almost never from the 5 target companies -- and
 * Aggregate Jobs' cohort filter then deletes every non-target row. Net: 147
 * cache rows fetched, 147 dropped. The moat holds the exact jobs the user
 * asked for and contributes none of them.
 *
 * Fix: a 5th query parameter -- comma-separated target company names, empty
 * for non-cohort queries. When set, both retrieval CTEs (vec + kw) restrict
 * to jobs whose company name matches a target (exact, case-insensitive).
 * Restriction (not boosting) is correct here BECAUSE the downstream cohort
 * filter drops non-target rows anyway -- there is nothing to lose and 150
 * slots to gain. When $5 is empty the SQL is behavior-identical to today.
 *
 * Google/Meta remain structurally web-only (no adapter exists for their
 * custom ATSes) -- this fix surfaces the cached Amazon/Apple/Netflix jobs;
 * it cannot conjure companies the poller can't reach.
 *
 * HNSW TRAP (found live -- first attempt returned 4 of 19): a filtered
 * `ORDER BY embedding <=> vec LIMIT n` walks the ANN index FIRST and
 * post-filters its neighborhood, so a selective company filter starves.
 * The vec CTE is split into two $5-guarded branches: untargeted keeps the
 * byte-identical ANN path; targeted computes exact distances over the tiny
 * restricted set, ordering wrapped in `* 1.0` so the planner cannot pick
 * the index. n8n's driver sends unnamed prepared statements (custom-planned
 * with real params every time), so the dead branch prunes at plan time.
 *
 * Verification: the patched SQL is executed against the LIVE Postgres with
 * real parameters before deploy -- targeted run must return Amazon/Netflix/
 * Apple rows; empty-$5 run must return the same top rows as the current
 * production query (regression proof).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

const VEC_OLD = "vec AS (SELECT j.id, row_number() OVER (ORDER BY j.embedding <=> (SELECT qvec FROM q)) AS rnk FROM jobs j WHERE j.status='active' AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL AND ($3 = '' OR j.remote = true OR j.location IS NULL OR j.location = '' OR EXISTS (SELECT 1 FROM unnest(string_to_array(lower($3), ',')) AS term WHERE lower(j.location) LIKE '%' || term || '%')) AND ($4 <> 'true' OR j.remote = true) ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 200)";
const VEC_NEW = "vec AS (SELECT id, row_number() OVER (ORDER BY dist) AS rnk FROM ((SELECT j.id, j.embedding <=> (SELECT qvec FROM q) AS dist FROM jobs j WHERE $5 = '' AND j.status='active' AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL AND ($3 = '' OR j.remote = true OR j.location IS NULL OR j.location = '' OR EXISTS (SELECT 1 FROM unnest(string_to_array(lower($3), ',')) AS term WHERE lower(j.location) LIKE '%' || term || '%')) AND ($4 <> 'true' OR j.remote = true) ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 200) UNION ALL (SELECT j.id, (j.embedding <=> (SELECT qvec FROM q)) * 1.0 AS dist FROM jobs j WHERE $5 <> '' AND j.status='active' AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL AND ($3 = '' OR j.remote = true OR j.location IS NULL OR j.location = '' OR EXISTS (SELECT 1 FROM unnest(string_to_array(lower($3), ',')) AS term WHERE lower(j.location) LIKE '%' || term || '%')) AND ($4 <> 'true' OR j.remote = true) AND EXISTS (SELECT 1 FROM companies tc WHERE tc.id = j.company_id AND lower(tc.name) = ANY(string_to_array(lower($5), ','))) ORDER BY dist LIMIT 200)) u)";
// kw CTE: GIN/tsquery filtering has no ANN post-filter problem -- plain guard.
const KW_OLD = "AND ($4 <> 'true' OR j.remote = true) ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 200)";
const KW_NEW = "AND ($4 <> 'true' OR j.remote = true) AND ($5 = '' OR EXISTS (SELECT 1 FROM companies tc WHERE tc.id = j.company_id AND lower(tc.name) = ANY(string_to_array(lower($5), ',')))) ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 200)";

const QR_OLD = "$('Pre-flight: Providers').first().json.cache_remote_only || '' ] }}";
const QR_NEW = "$('Pre-flight: Providers').first().json.cache_remote_only || '', $('Pre-flight: Providers').first().json.cache_target_companies || '' ] }}";

const PF_OLD = "const cacheRemoteOnly = ctx.remote_preference === 'remote_only' ? 'true' : '';\nreturn [{ json: {\n  ...ctx,\n  _providers_active: active,\n  _providers_count: active.length,\n  _no_providers: false,\n  cache_loc_terms: cacheLocTerms,\n  cache_remote_only: cacheRemoteOnly\n}}];";
const PF_NEW = "const cacheRemoteOnly = ctx.remote_preference === 'remote_only' ? 'true' : '';\n" +
  "// s80: cohort queries (MAANG/FAANG/...) restrict the cache lane to the\n" +
  "// target companies -- otherwise the semantic top-150 across the whole cache\n" +
  "// rarely contains them and the downstream cohort filter deletes the lane's\n" +
  "// entire contribution. Empty for non-cohort queries (behavior unchanged).\n" +
  "const cacheTargetCompanies = (Array.isArray(ctx.target_companies) ? ctx.target_companies : []).map((s) => String(s).trim()).filter(Boolean).join(',');\n" +
  "return [{ json: {\n  ...ctx,\n  _providers_active: active,\n  _providers_count: active.length,\n  _no_providers: false,\n  cache_loc_terms: cacheLocTerms,\n  cache_remote_only: cacheRemoteOnly,\n  cache_target_companies: cacheTargetCompanies\n}}];";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Hybrid Cache Search', 'Pre-flight: Providers']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Hybrid Cache Search'].parameters.query.includes('cache_target')) { /* not in SQL */ }
  if (N['Pre-flight: Providers'].parameters.jsCode.includes('cacheTargetCompanies')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Hybrid Cache Search'].parameters, 'query', VEC_OLD, VEC_NEW, 'vec CTE target clause', base);
  replaceOnce(N['Hybrid Cache Search'].parameters, 'query', KW_OLD, KW_NEW, 'kw CTE target clause', base);
  replaceOnce(N['Hybrid Cache Search'].parameters.options, 'queryReplacement', QR_OLD, QR_NEW, '$5 param', base);
  replaceOnce(N['Pre-flight: Providers'].parameters, 'jsCode', PF_OLD, PF_NEW, 'cache_target_companies compute', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: cache lane company-targeting wired ($5) -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (!VEC_NEW.includes("string_to_array(lower($5), ',')") || !KW_NEW.includes("string_to_array(lower($5), ',')")) {
    console.error('HARNESS FAIL: target clause missing from a CTE'); process.exit(1);
  }
  if ((VEC_NEW + KW_NEW).split('$5').length - 1 !== 5) { console.error('HARNESS FAIL: expected 5 uses of $5 (vec guards x2 + vec target + kw guard + kw target)'); process.exit(1); }
  if (!VEC_NEW.includes('* 1.0 AS dist')) { console.error('HARNESS FAIL: targeted vec branch must break the ANN operator pattern (exact scan)'); process.exit(1); }
  if (!VEC_NEW.includes("$5 = ''") || !VEC_NEW.includes("$5 <> ''")) { console.error('HARNESS FAIL: vec branches must be mutually exclusive on $5'); process.exit(1); }
  if (!QR_NEW.includes('cache_target_companies')) { console.error('HARNESS FAIL: queryReplacement missing 5th param'); process.exit(1); }

  // The compute logic, run for real:
  const compute = new Function('ctx', "return (Array.isArray(ctx.target_companies) ? ctx.target_companies : []).map((s) => String(s).trim()).filter(Boolean).join(',');");
  if (compute({ target_companies: ['Meta', 'Amazon', 'Apple', 'Netflix', 'Google'] }) !== 'Meta,Amazon,Apple,Netflix,Google') { console.error('HARNESS FAIL: compute joined wrong'); process.exit(1); }
  if (compute({ target_companies: [] }) !== '' || compute({}) !== '') { console.error('HARNESS FAIL: empty/no cohort must yield empty string'); process.exit(1); }

  console.log('HARNESS OK: $5 target clause present in both CTEs, empty-string disengage preserved, param plumbing and compute verified. Live-Postgres proof runs separately before deploy (see deploy step).');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S80 (cache lane company-targeting for cohort queries) complete.');
