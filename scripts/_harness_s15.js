/* Harness for S15 desirability-tier wiring:
 *   cache rows (with tier) -> Cache Prefilter -> Aggregate Jobs -> Build Telegraph Body
 * Verifies: (1) tier survives prefilter + aggregate, (2) the telegraph display ranks
 * a high-tier role above a comparable lower-tier one (strong booster, not hard sort)
 * while keeping a much-better match on top, (3) body-shops (D) sink, (4) 🏆/⭐ badges
 * render. Run: node scripts/_harness_s15.js */
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
const JD = 'Python PyTorch deep learning LLM transformers RAG '.repeat(12);

// ── 1) Cache Prefilter carries tier ──
const CACHE_ROWS = [
  { job_id: 1, title: 'ML Engineer', company: 'OpenAI', location: 'Remote', remote: true, apply_url: 'https://openai.com/careers/1', url: 'https://openai.com/careers/1', jd_text: JD, posted_at: iso(3), status: 'active', trust: 30, skills: ['Python'], tier: 'S', rrf_score: 0.030 },
  { job_id: 2, title: 'ML Engineer', company: 'Cloudflare', location: 'Remote', remote: true, apply_url: 'https://boards.greenhouse.io/cloudflare/jobs/2', url: 'https://boards.greenhouse.io/cloudflare/jobs/2', jd_text: JD, posted_at: iso(3), status: 'active', trust: 30, skills: ['Python'], tier: 'B', rrf_score: 0.040 },
  { job_id: 3, title: 'Data Engineer', company: 'TCS', location: 'Remote', remote: true, apply_url: 'https://tcs.com/jobs/3', url: 'https://tcs.com/jobs/3', jd_text: JD, posted_at: iso(3), status: 'active', trust: 30, skills: ['Python'], tier: 'D', rrf_score: 0.045 },
  { job_id: 4, title: 'AI Engineer', company: 'Acme', location: 'Remote', remote: true, apply_url: 'https://acme.io/jobs/4', url: 'https://acme.io/jobs/4', jd_text: JD, posted_at: iso(3), status: 'active', trust: 30, skills: ['Python'], tier: null, rrf_score: 0.035 },
];
const pf = node('cache_prefilter.js')(inp(CACHE_ROWS), ref({}), () => ({}))[0].json;
console.log('[Cache Prefilter]');
ok('4 cache jobs', pf.jobs.length === 4 && pf.count === 4, 'got ' + pf.jobs.length);
ok('tier carried (S on job 1)', pf.jobs.find(j => j.job_id === 'cache_1').tier === 'S');
ok('tier carried (D on job 3)', pf.jobs.find(j => j.job_id === 'cache_3').tier === 'D');
ok('null tier stays null (job 4)', pf.jobs.find(j => j.job_id === 'cache_4').tier === null);

// ── 2) Aggregate keeps tier ──
const EQ = { role_families: ['AI Engineer', 'ML Engineer', 'Data Engineer'], excluded_roles: [], location_canonical: '', remote_preference: 'open', freshness: 'qdr:m' };
const agg = node('aggregate_jobs.js')(inp([{ jobs: pf.jobs, source: 'cache' }]), ref({ 'Parse Expand Query': EQ }), () => ({}))[0].json;
console.log('[Aggregate Jobs]');
ok('tier survives aggregate', agg.jobs.find(j => j.job_id === 'cache_1').tier === 'S');

// ── 3) Build Telegraph Body: tier-aware final ranking + badges ──
// scored: TCS has the BEST raw match (82) but is D; OpenAI is S at 78; Cloudflare B at 80; Acme untiered 79.
// Expect order: OpenAI(78+12=90) > Cloudflare(80+2=82) > Acme(79+0=79) > TCS(82-40=42, sinks last).
const scored = [
  { job_id: 'cache_1', match_pct: 78, score100: 78, validated: 'live', matched_skills: ['Python'], missing_skills: [], adjacent_skills: [], one_liner: '' },
  { job_id: 'cache_2', match_pct: 80, score100: 80, validated: 'live', matched_skills: ['Python'], missing_skills: [], adjacent_skills: [], one_liner: '' },
  { job_id: 'cache_3', match_pct: 82, score100: 82, validated: 'live', matched_skills: ['Python'], missing_skills: [], adjacent_skills: [], one_liner: '' },
  { job_id: 'cache_4', match_pct: 79, score100: 79, validated: 'live', matched_skills: ['Python'], missing_skills: [], adjacent_skills: [], one_liner: '' },
];
const tb = node('build_telegraph_body.js')(
  inp([{}]),
  ref({
    'Parse Scorer Output': { scored, strategy: 'matcher', total: 4, dropped: [] },
    'Aggregate Jobs': agg,
    'Load Telegraph Token': { value: 'tok' },
  }),
  () => ({ last_search_intent: { role_families: ['AI Engineer'] }, telegraph_token: 'tok' })
)[0].json;
console.log('[Build Telegraph Body]');
const order = tb.rankedJobs.map(j => j.job_id);
ok('S-tier floats to #1 over higher raw matches', order[0] === 'cache_1', 'order=' + order.join(','));
ok('B-tier (cache_2) ranks above untiered (cache_4)', order.indexOf('cache_2') < order.indexOf('cache_4'), 'order=' + order.join(','));
ok('body-shop (D) sinks to last', order[order.length - 1] === 'cache_3', 'order=' + order.join(','));
ok('🏆 S-tier badge rendered in content', tb.content.includes('🏆'));
ok('S-tier label in top3 message', tb.top3_msg.includes('S-tier'));

// ── 4) Location filter (synonyms + web-inclusive + evidence-based) ──
const LJD = 'Python machine learning engineer '.repeat(5);
const LOC_JOBS = [
  { job_id: 'l1', title: 'ML Engineer', company: 'A', url: 'https://boards.greenhouse.io/a/1', location: 'Bengaluru, Karnataka, IND', jd_text: LJD, source: 'cache', source_tier: 1, source_priority: 0, posted_at: iso(2) },
  { job_id: 'l2', title: 'ML Engineer', company: 'B', url: 'https://boards.greenhouse.io/b/2', location: 'Seattle, WA, USA', jd_text: LJD, source: 'cache', source_tier: 1, source_priority: 0, posted_at: iso(2) },
  { job_id: 'l3', title: 'ML Engineer - Remote', company: 'C', url: 'https://ex.com/3', location: '', jd_text: LJD, source: 'serper', source_tier: 2, posted_at: iso(2) },
  { job_id: 'l4', title: 'ML Engineer in Bangalore', company: 'D', url: 'https://ex.com/4', location: '', jd_text: LJD, source: 'serper', source_tier: 2, posted_at: iso(2) },
  { job_id: 'l5', title: 'ML Engineer', company: 'E', url: 'https://ex.com/5', location: 'San Francisco, CA', jd_text: LJD, source: 'serper', source_tier: 2, posted_at: iso(2) },
];
const EQ_BLR = { role_families: ['ML Engineer'], excluded_roles: [], location_canonical: 'bangalore', remote_preference: 'open', freshness: 'qdr:m' };
const aggL = node('aggregate_jobs.js')(inp([{ jobs: LOC_JOBS, source: 'mixed' }]), ref({ 'Parse Expand Query': EQ_BLR }), () => ({}))[0].json;
const lids = aggL.jobs.map(j => j.job_id);
console.log('[Location filter] kept:', lids.join(',') || '(none)');
ok('Bengaluru cache job kept (Bangalore synonym)', lids.includes('l1'));
ok('Seattle cache job dropped', !lids.includes('l2'));
ok('Remote web job kept', lids.includes('l3'));
ok('web job w/ Bangalore in title kept', lids.includes('l4'));
ok('wrong-location web job (SF) dropped', !lids.includes('l5'));

// ── 4b) Remote must be country/region-aware (Pune search) ──
const PUNE_JOBS = [
  { job_id: 'p1', title: 'ML Engineer', company: 'A', url: 'https://boards.greenhouse.io/a/p1', location: 'Pune, Maharashtra, IND', jd_text: LJD, source: 'cache', source_tier: 1, source_priority: 0, posted_at: iso(2) },
  { job_id: 'p2', title: 'ML Engineer', company: 'B', url: 'https://boards.greenhouse.io/b/p2', location: 'Remote - US', jd_text: LJD, source: 'cache', source_tier: 1, source_priority: 0, posted_at: iso(2) },
  { job_id: 'p3', title: 'ML Engineer', company: 'C', url: 'https://boards.greenhouse.io/c/p3', location: 'Remote - India', jd_text: LJD, source: 'cache', source_tier: 1, source_priority: 0, posted_at: iso(2) },
  { job_id: 'p4', title: 'ML Engineer', company: 'D', url: 'https://boards.greenhouse.io/d/p4', location: 'Remote', jd_text: LJD, source: 'cache', source_tier: 1, source_priority: 0, posted_at: iso(2) },
  { job_id: 'p5', title: 'ML Engineer', company: 'E', url: 'https://boards.greenhouse.io/e/p5', location: 'Remote - Ireland', jd_text: LJD, source: 'cache', source_tier: 1, source_priority: 0, posted_at: iso(2) },
];
const EQ_PUNE = { role_families: ['ML Engineer'], excluded_roles: [], location_canonical: 'pune', remote_preference: 'open', freshness: 'qdr:m' };
const aggP = node('aggregate_jobs.js')(inp([{ jobs: PUNE_JOBS, source: 'cache' }]), ref({ 'Parse Expand Query': EQ_PUNE }), () => ({}))[0].json;
const pids = aggP.jobs.map(j => j.job_id);
console.log('[Remote country-aware] kept:', pids.join(',') || '(none)');
ok('Pune onsite kept', pids.includes('p1'));
ok('Remote-US DROPPED for Pune search', !pids.includes('p2'));
ok('Remote-India kept for Pune search', pids.includes('p3'));
ok('bare Remote kept', pids.includes('p4'));
ok('Remote-Ireland DROPPED for Pune search', !pids.includes('p5'));

// ── 5) Web-junk filter (aggregator listing pages + staffing reposts) ──
const JUNK_JOBS = [
  { job_id: 'jk1', title: '300+ Machine Learning Engineer Jobs in Bengaluru 2026', company: 'BeBee', url: 'https://bebee.com/in/jobs/role/machine-learning-engineer/bengaluru', jd_text: JD, source: 'serper', source_tier: 2, posted_at: iso(1) },
  { job_id: 'jk2', title: '100+ Data Scientist Jobs at Product Companies India', company: 'Productbased', url: 'https://www.productbased.in/jobs/data-scientist', jd_text: JD, source: 'serper', source_tier: 2, posted_at: iso(1) },
  { job_id: 'jk3', title: 'AI Engineer', company: 'ElevenLabs', url: 'https://jobs.lever.co/smart-working-solutions/abc', jd_text: JD, source: 'serper', source_tier: 2, posted_at: iso(1) },
  { job_id: 'jk4', title: 'AI Engineer - Senior/Lead/Principal', company: 'Wissen Infotech', url: 'https://www.adzuna.in/land/ad/123', jd_text: JD, source: 'adzuna', source_tier: 2, posted_at: iso(1) },
  { job_id: 'jk5', title: 'Machine Learning Engineer', company: 'Level AI', url: 'https://jobs.lever.co/levelai/real-job', jd_text: JD, source: 'cache', source_tier: 1, source_priority: 0, posted_at: iso(2) },
];
const EQ_OPEN = { role_families: ['Machine Learning Engineer', 'AI Engineer'], excluded_roles: [], location_canonical: '', remote_preference: 'open', freshness: 'qdr:m' };
const aggJ = node('aggregate_jobs.js')(inp([{ jobs: JUNK_JOBS, source: 'mixed' }]), ref({ 'Parse Expand Query': EQ_OPEN }), () => ({}))[0].json;
const jids = aggJ.jobs.map(j => j.job_id);
console.log('[Web-junk filter] kept:', jids.join(',') || '(none)');
ok('BeBee listing page dropped', !jids.includes('jk1'));
ok('Productbased listing page dropped', !jids.includes('jk2'));
ok('staffing repost (smart-working-solutions) dropped', !jids.includes('jk3'));
ok('body-shop (Wissen Infotech) dropped', !jids.includes('jk4'));
ok('real Level AI job kept', jids.includes('jk5'));

console.log(fails ? ('\n*** ' + fails + ' FAILURES ***') : '\nALL PASSED');
process.exit(fails ? 1 : 0);
