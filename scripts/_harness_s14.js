/* Harness for S14 cache-first dataflow:
 *   (cache SQL rows) -> Cache Prefilter -> Aggregate Jobs -> Experience Filter
 *   -> Build Scorer Input -> Build Matcher Request
 * Verifies the JobRecord fields (full jd_text, rrf_score, source_priority) survive
 * and that the matcher gets full resume + full JD + cache-first ordering.
 * Run: node scripts/_harness_s14.js */
const fs = require('fs');
const path = require('path');
const node = (f) => new Function('$input', '$', '$getWorkflowStaticData', fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8'));
const inp = (arr) => ({ all: () => arr.map((j) => ({ json: j })), first: () => ({ json: arr[0] }) });
const ref = (map) => (name) => {
  if (!(name in map)) throw new Error('unexpected $("' + name + '")');
  const v = map[name];
  return { first: () => ({ json: v }), all: () => (Array.isArray(v) ? v.map((j) => ({ json: j })) : [{ json: v }]) };
};
let fails = 0;
const ok = (label, cond, extra) => { if (!cond) { fails++; console.log('  FAIL: ' + label + (extra ? ' :: ' + extra : '')); } else console.log('  ok:   ' + label); };
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const LONGJD = 'Python PyTorch deep learning LLM transformers RAG Docker Kubernetes '.repeat(20);

// ── 1) Cache Prefilter ──
const CACHE_ROWS = [
  { job_id: 101, title: 'Senior AI Engineer', company: 'NVIDIA', company_domain: 'nvidia.wd5.myworkdayjobs.com', location: 'Santa Clara', remote: false, apply_url: 'https://nvidia.wd5.myworkdayjobs.com/job/AI_JR1', url: 'https://nvidia.wd5.myworkdayjobs.com/job/AI_JR1', jd_text: LONGJD, posted_at: iso(2), status: 'active', trust: 25, skills: ['Python', 'PyTorch', 'Deep Learning'], seniority: 'senior', employment_type: null, salary_min: null, salary_max: null, salary_currency: null, rrf_score: 0.0301 },
  { job_id: 102, title: 'ML Engineer', company: 'Acme', company_domain: null, location: 'Remote', remote: true, apply_url: 'https://boards.greenhouse.io/acme/jobs/2', url: 'https://boards.greenhouse.io/acme/jobs/2', jd_text: 'Machine learning Python TensorFlow ' + LONGJD, posted_at: iso(5), status: 'active', trust: 30, skills: ['Python', 'TensorFlow'], seniority: 'mid', employment_type: 'full-time', salary_min: 150000, salary_max: 200000, salary_currency: 'USD', rrf_score: 0.0345 },
];
const pf = node('cache_prefilter.js')(inp(CACHE_ROWS), ref({}), () => ({}))[0].json;
console.log('[Cache Prefilter]');
ok('emits 2 cache jobs', pf.jobs.length === 2 && pf.count === 2);
ok('job_id prefixed cache_', pf.jobs[0].job_id === 'cache_101');
ok('source_priority 0', pf.jobs.every((j) => j.source_priority === 0));
ok('full jd_text carried (not truncated to 600)', pf.jobs[0].jd_text.length > 600 && pf.jobs[0].jd_text === LONGJD);
ok('description_snippet capped 600', pf.jobs[0].description_snippet.length <= 600);
ok('rrf_score + trust + skills carried', pf.jobs[1].rrf_score === 0.0345 && pf.jobs[1].trust === 30 && pf.jobs[1].skills.length === 2);
ok('salary carried', pf.jobs[1].salary_min === 150000);

// ── 2) Aggregate Jobs (cache vs web) ──
const WEB = { job_id: 'web_1', title: 'AI Engineer', company: 'WebCo', url: 'https://example.com/jobs/web1', source: 'serper', source_tier: 2, updated_at: iso(1), description_snippet: 'AI engineer role' };
const EQ = { role_families: ['AI Engineer', 'ML Engineer'], excluded_roles: [], location_canonical: '', remote_preference: 'open', freshness: 'qdr:m' };
const agg = node('aggregate_jobs.js')(inp([{ jobs: pf.jobs, source: 'cache' }, { jobs: [WEB], source: 'serper' }]), ref({ 'Parse Expand Query': EQ }), () => ({}))[0].json;
console.log('[Aggregate Jobs]');
ok('3 jobs kept', agg.jobs.length === 3, 'got ' + agg.jobs.length);
ok('cache jobs ranked above web (source_priority)', agg.jobs[0].source_priority === 0 && agg.jobs[1].source_priority === 0 && (agg.jobs[2].source_priority ?? 1) === 1);
ok('within cache, higher rrf first (Acme .0345 > NVIDIA .0301)', agg.jobs[0].job_id === 'cache_102' && agg.jobs[1].job_id === 'cache_101');
ok('cache full jd_text survives aggregate', agg.jobs[1].jd_text === LONGJD);

// ── 3) Experience Filter (pass-through) ──
// Experience Filter just spreads job + adds yoe fields (not mirrored); emulate it
// inline to keep the chain going and confirm the spread preserves cache fields.
const efJobs = agg.jobs.map((j) => ({ ...j, required_yoe_min: null, required_yoe_max: null, yoe_compat_score: 1.0 }));
console.log('[Experience Filter] (emulated spread)');
const ef102 = efJobs.find((j) => j.job_id === 'cache_102');
ok('fields preserved through spread', ef102.jd_text.length > 600 && ef102.rrf_score === 0.0345 && ef102.source_priority === 0);

// ── 4) Build Scorer Input ──
const RESUME = { kind: 'structured', personal: { name: 'PK' }, raw_text: 'FULL RESUME TEXT: AI Engineer Python PyTorch RAG LLM transformers Docker. '.repeat(10), skills: { core: ['Python', 'PyTorch', 'RAG'] }, experience: [{ title: 'AI Engineer', company: 'X', bullets: ['built RAG'] }] };
const bsi = node('build_scorer_input.js')(
  inp([{ id: 'global:resume_structured', value: JSON.stringify(RESUME) }]),
  ref({ 'Experience Filter': { jobs: efJobs }, 'Parse Expand Query': EQ }),
  () => ({})
)[0].json;
console.log('[Build Scorer Input]');
ok('master_resume_text = full raw_text', bsi.master_resume_text.startsWith('FULL RESUME TEXT') && bsi.master_resume_text.length > 500);
ok('master_resume_summary still present', !!bsi.master_resume_summary && !bsi.resume_missing);
const bsi102 = bsi.jobs.find((j) => j.job_id === 'cache_102');
const bsi101 = bsi.jobs.find((j) => j.job_id === 'cache_101');
ok('jobBatch carries full jd_text', bsi101.jd_text === LONGJD && bsi102.jd_text.length > 600);
ok('jobBatch carries source_priority + rrf_score', bsi102.source_priority === 0 && bsi102.rrf_score === 0.0345);

// ── 5) Build Matcher Request ──
const bmr = node('build_matcher_request.js')(
  inp([{}]),
  ref({ 'Build Scorer Input': bsi, 'Aggregate Jobs': agg }),
  () => ({})
)[0].json;
console.log('[Build Matcher Request]');
ok('resume_text = full resume (not summary)', bmr.resume_text.startsWith('FULL RESUME TEXT'));
ok('enrich true, top_n 15', bmr.enrich === true && bmr.top_n === 15);
ok('sends FULL jd_text to matcher', bmr.jobs.find((j) => j.id === 'cache_101').jd_text === LONGJD);
ok('cache-first order (cache_102 first by rrf)', bmr.jobs[0].id === 'cache_102' && bmr.jobs[1].id === 'cache_101');
ok('web job sent last', bmr.jobs[bmr.jobs.length - 1].id === 'web_1');

console.log(fails ? ('\n*** ' + fails + ' FAILURES ***') : '\nALL PASSED');
process.exit(fails ? 1 : 0);
