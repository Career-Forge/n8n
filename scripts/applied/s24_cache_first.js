/**
 * s24_cache_first.js -- Phase 4.1 (Roadmap v4): cache-first two-stage scoring.
 *
 * Widens the candidate pool Hybrid Cache Search + Aggregate Jobs surface (30/50 ->
 * 150), caps the EXPENSIVE JobScorer LLM call to just the top 30 of that pool (cost/
 * latency control -- was implicitly capped at whatever Aggregate Jobs produced, up
 * to 50), and adds a Telegraph-page appendix so the other ~120 candidates aren't
 * silently discarded now that the pool is wider -- shown ranked by the cache's own
 * relevance score (rrf_score) or tier/recency, clearly labeled as a match ESTIMATE
 * rather than individually AI-reviewed.
 *
 * Also fixes a real badge collision found while touching Build Telegraph Body: F2's
 * "location unverified" marker and this node's pre-existing tier-3-aggregator glyph
 * both used 🌐 for unrelated meanings -- moved F2's marker to 🔎. tierGlyph now also
 * distinguishes cache-sourced tier-1 (🔓, verified as of the poller's last check)
 * from freshly-probed ATS-direct tier-1 (✅, verified live just now) -- not the same
 * guarantee, shouldn't share a badge.
 *
 * v1 scope, explicitly not attempted here: "find newest" recency-primary sort mode
 * (a genuinely separate feature -- intent detection + sort-mode plumbing -- not
 * required for cache-first scoring itself to work correctly).
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══════════════════════════════════════════════════════════════
// 1. Hybrid Cache Search -- widen candidate pool 30 -> 150
// ═══════════════════════════════════════════════════════════════

const HCS_OLD = "WITH q AS (SELECT $1::vector AS qvec, websearch_to_tsquery('english', COALESCE($2,'')) AS qtext), vec AS (SELECT j.id, row_number() OVER (ORDER BY j.embedding <=> (SELECT qvec FROM q)) AS rnk FROM jobs j WHERE j.status='active' AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 50), kw AS (SELECT j.id, row_number() OVER (ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC) AS rnk FROM jobs j WHERE j.status='active' AND (SELECT qtext FROM q)::text <> '' AND j.jd_tsv @@ (SELECT qtext FROM q) ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 50), fused AS (SELECT COALESCE(v.id,k.id) AS id, COALESCE(1.0/(60+v.rnk),0)+COALESCE(1.0/(60+k.rnk),0) AS score FROM vec v FULL OUTER JOIN kw k ON v.id=k.id) SELECT j.id AS job_id, j.title, c.name AS company, j.location, j.remote, j.apply_url, left(j.jd_text,1200) AS jd_text, j.posted_at, (f.score * (1 - LEAST(0.3, GREATEST(0, 50 - COALESCE(ci.health_score,60))::numeric/100))) AS rrf_score FROM fused f JOIN jobs j ON j.id=f.id JOIN companies c ON c.id=j.company_id LEFT JOIN company_intel ci ON ci.company_key = lower(regexp_replace(c.name,'[,.].*$','')) ORDER BY rrf_score DESC LIMIT 30";

const HCS_NEW = "WITH q AS (SELECT $1::vector AS qvec, websearch_to_tsquery('english', COALESCE($2,'')) AS qtext), vec AS (SELECT j.id, row_number() OVER (ORDER BY j.embedding <=> (SELECT qvec FROM q)) AS rnk FROM jobs j WHERE j.status='active' AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 200), kw AS (SELECT j.id, row_number() OVER (ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC) AS rnk FROM jobs j WHERE j.status='active' AND (SELECT qtext FROM q)::text <> '' AND j.jd_tsv @@ (SELECT qtext FROM q) ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 200), fused AS (SELECT COALESCE(v.id,k.id) AS id, COALESCE(1.0/(60+v.rnk),0)+COALESCE(1.0/(60+k.rnk),0) AS score FROM vec v FULL OUTER JOIN kw k ON v.id=k.id) SELECT j.id AS job_id, j.title, c.name AS company, j.location, j.remote, j.apply_url, left(j.jd_text,1200) AS jd_text, j.posted_at, (f.score * (1 - LEAST(0.3, GREATEST(0, 50 - COALESCE(ci.health_score,60))::numeric/100))) AS rrf_score FROM fused f JOIN jobs j ON j.id=f.id JOIN companies c ON c.id=j.company_id LEFT JOIN company_intel ci ON ci.company_key = lower(regexp_replace(c.name,'[,.].*$','')) ORDER BY rrf_score DESC LIMIT 150";

// ═══════════════════════════════════════════════════════════════
// 2. Aggregate Jobs -- widen final cap 50 -> 150
// ═══════════════════════════════════════════════════════════════

const AGG_OLD = "const top = filtered.slice(0, 50);";
const AGG_NEW = "const top = filtered.slice(0, 150);";

// ═══════════════════════════════════════════════════════════════
// 3. Build Scorer Input -- cap the EXPENSIVE JobScorer batch to top 30
// ═══════════════════════════════════════════════════════════════

const BSI_OLD = `const jobBatch = jobs.map(j => ({
  job_id: j.job_id, title: j.title, company: j.company, location: j.location,
  department: j.department, url: j.url, description_snippet: j.description_snippet,
  source: j.source, source_tier: j.source_tier, source_tier_label: j.source_tier_label || j.tier_label,
  required_yoe_min: j.required_yoe_min ?? null, required_yoe_max: j.required_yoe_max ?? null,
  yoe_compat_score: j.yoe_compat_score ?? null,
  salary_min: j.salary_min ?? null, salary_max: j.salary_max ?? null, salary_currency: j.salary_currency || null
}));`;

const BSI_NEW = `// Phase 4.1: cap the batch sent to the LLM scorer -- Aggregate Jobs now surfaces up
// to 150 candidates (widened cache-first pool), but deep-scoring all of them would
// multiply JobScorer's cost/latency for no benefit; the rest are still shown in the
// Telegraph appendix (Build Telegraph Body), ranked by cache relevance instead.
const jobBatch = jobs.slice(0, 30).map(j => ({
  job_id: j.job_id, title: j.title, company: j.company, location: j.location,
  department: j.department, url: j.url, description_snippet: j.description_snippet,
  source: j.source, source_tier: j.source_tier, source_tier_label: j.source_tier_label || j.tier_label,
  required_yoe_min: j.required_yoe_min ?? null, required_yoe_max: j.required_yoe_max ?? null,
  yoe_compat_score: j.yoe_compat_score ?? null,
  salary_min: j.salary_min ?? null, salary_max: j.salary_max ?? null, salary_currency: j.salary_currency || null
}));`;

// ═══════════════════════════════════════════════════════════════
// 4. Build Telegraph Body -- full rewrite (appendix + badge fixes)
// ═══════════════════════════════════════════════════════════════

const BTB_NEW = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'nodes', 'build_telegraph_body.js'), 'utf8');

function replaceExact(node, base, label, oldStr, newStr, getField, setField) {
  const cur = getField(node);
  if (typeof cur !== 'string') { console.error(`INTEGRITY FAIL ${base}: ${label} -- getField() returned ${typeof cur}`); process.exit(1); }
  if (cur === newStr) return false;
  if (cur.indexOf(oldStr) === -1) { console.error(`INTEGRITY FAIL ${base}: ${label} does not contain expected old value.\nGot (first 300 chars): ${cur.slice(0, 300)}`); process.exit(1); }
  setField(cur.split(oldStr).join(newStr));
  return true;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of ['Hybrid Cache Search', 'Aggregate Jobs', 'Build Scorer Input', 'Build Telegraph Body']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  {
    const n = N['Hybrid Cache Search'];
    if (replaceExact(n, base, 'Hybrid Cache Search query', HCS_OLD, HCS_NEW, () => n.parameters.query, (v) => { n.parameters.query = v; })) edits++;
  }
  {
    const n = N['Aggregate Jobs'];
    if (replaceExact(n, base, 'Aggregate Jobs final cap', AGG_OLD, AGG_NEW, () => n.parameters.jsCode, (v) => { n.parameters.jsCode = v; })) edits++;
  }
  {
    const n = N['Build Scorer Input'];
    if (replaceExact(n, base, 'Build Scorer Input batch cap', BSI_OLD, BSI_NEW, () => n.parameters.jsCode, (v) => { n.parameters.jsCode = v; })) edits++;
  }
  {
    const n = N['Build Telegraph Body'];
    if (n.parameters.jsCode !== BTB_NEW) { n.parameters.jsCode = BTB_NEW; edits++; }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: cache-first two-stage scoring applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. SQL limit bump -- string-level sanity (can't execute real SQL here).
  if (!/LIMIT 200\).*LIMIT 200\).*LIMIT 150$/s.test(HCS_NEW)) { console.error('HARNESS FAIL: Hybrid Cache Search NEW query does not have the expected 200/200/150 limits in order'); process.exit(1); }
  if (HCS_OLD === HCS_NEW) { console.error('HARNESS FAIL: HCS_OLD/NEW identical, no-op'); process.exit(1); }

  // 2. Aggregate Jobs cap, evaluated as real JS.
  {
    const filtered = Array.from({ length: 200 }, (_, i) => i);
    const top = new Function('filtered', AGG_NEW.replace('const top =', 'return') + ' ')(filtered);
    if (top.length !== 150) { console.error('HARNESS FAIL: Aggregate Jobs cap did not produce 150 items, got', top.length); process.exit(1); }
  }

  // 3. Build Scorer Input cap, evaluated as real JS against a 40-job fixture.
  {
    const jobs = Array.from({ length: 40 }, (_, i) => ({ job_id: 'j' + i, title: 't' + i, company: 'c', location: 'l' }));
    const jobBatch = new Function('jobs', BSI_NEW + '\nreturn jobBatch;')(jobs);
    if (jobBatch.length !== 30) { console.error('HARNESS FAIL: Build Scorer Input should cap batch at 30, got', jobBatch.length); process.exit(1); }
    if (jobBatch[0].job_id !== 'j0' || jobBatch[29].job_id !== 'j29') { console.error('HARNESS FAIL: Build Scorer Input cap took the wrong slice'); process.exit(1); }
  }

  // 4. Build Telegraph Body -- full mock exercising the appendix + badge fixes.
  {
    const allJobs = [];
    for (let i = 0; i < 40; i++) {
      allJobs.push({ job_id: 'j' + i, title: 'Role ' + i, company: 'Co', location: 'Remote', url: 'https://example.com/' + i, source: i < 5 ? 'cache' : 'serper', source_tier: i < 5 ? 1 : 2, rrf_score: i < 5 ? (1 - i * 0.01) : 0, updated_at: '2026-06-01', location_verified: i === 3 ? null : true });
    }
    // Only the first 30 (by job_id j0..j29) were sent to the scorer -- matches Build Scorer Input's cap.
    const scored = allJobs.slice(0, 30).map((j, i) => ({ job_id: j.job_id, fit_score: 8, one_liner: 'Good fit', detected_location: 'Remote', location_match: 'match', score100: 90 - i, sub_scores: { skills: 80, experience: 80, workauth: 80, location: 100, company_health: 60, compensation: 60 }, bottleneck: 'skills', bin: 'Strong' }));

    const $ = (name) => {
      if (name === 'Parse Scorer Output') return { first: () => ({ json: { scored, strategy: 'direct' } }) };
      if (name === 'Aggregate Jobs') return { first: () => ({ json: { jobs: allJobs } }) };
      if (name === 'Verify Job Links') return { first: () => ({ json: { dead_removed: 0 } }) };
      if (name === 'Load Telegraph Token') return { first: () => ({ json: { value: 'tok123' } }) };
      throw new Error('unexpected $ ref: ' + name);
    };
    const staticData = { last_search_intent: { role_families: ['AI Engineer'] } };
    const $getWorkflowStaticData = () => staticData;

    const fn = new Function('$', '$getWorkflowStaticData', BTB_NEW);
    const out = fn($, $getWorkflowStaticData)[0].json;

    if (out.total_jobs !== 30) { console.error('HARNESS FAIL: expected 30 ranked (scored) jobs, got', out.total_jobs); process.exit(1); }
    if (out.appendix_count !== 10) { console.error('HARNESS FAIL: expected 10 appendix jobs (40 total - 30 scored), got', out.appendix_count); process.exit(1); }
    if (!out.top3_msg.includes('+10 more in the full list')) { console.error('HARNESS FAIL: top3_msg should mention the appendix count, got', out.top3_msg.slice(0, 100)); process.exit(1); }
    const contentStr = out.content;
    if (!contentStr.includes('📋 10 more matches')) { console.error('HARNESS FAIL: appendix header missing from content'); process.exit(1); }
    if (!contentStr.includes('match ESTIMATE')) { console.error('HARNESS FAIL: appendix disclaimer missing from content'); process.exit(1); }
    // Badge collision fix: 🌐 must still appear (tier-3 glyph unaffected elsewhere), but the
    // specific unverified-location marker (job j3, in the scored/ranked set) must be 🔎, not 🌐.
    if (!contentStr.includes('Remote 🔎')) { console.error('HARNESS FAIL: unverified-location badge should render as "Remote 🔎", not found in content'); process.exit(1); }
    // Cache vs ATS-direct tier-1 distinction: cache-sourced jobs (j0-j4) get 🔓, not ✅.
    if (!contentStr.includes('🔓')) { console.error('HARNESS FAIL: cache-sourced tier-1 jobs should render the 🔓 badge, not found'); process.exit(1); }
  }

  console.log('HARNESS OK: Hybrid Cache Search limits (200/200/150), Aggregate Jobs cap (150), Build Scorer Input cap (30), Build Telegraph Body appendix (count + disclaimer + top3Msg mention) + badge collision fix (🔎 vs 🌐) + cache/ATS-direct tier-1 distinction (🔓 vs ✅) -- all verified');
})();

TARGETS.forEach(patch);
console.log('S24 (cache-first two-stage scoring) complete.');
