/* Harness for S13 find-pipeline rewire: build_matcher_request -> (matcher resp)
 * -> parse_matcher_output -> build_telegraph_body. Run: node scripts/_harness_s13.js */
const fs = require('fs');
const path = require('path');
const load = (f) => fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8');
const BMR = new Function('$input', '$', '$getWorkflowStaticData', load('build_matcher_request.js'));
const PARSE = new Function('$input', '$', '$getWorkflowStaticData', load('parse_matcher_output.js'));
const TB = new Function('$input', '$', '$getWorkflowStaticData', load('build_telegraph_body.js'));

let fails = 0;
const ok = (label, cond, extra) => { if (!cond) { fails++; console.log('  FAIL: ' + label + (extra ? ' :: ' + extra : '')); } else console.log('  ok:   ' + label); };

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const BSI = {
  master_resume_summary: 'AI Engineer: Python, PyTorch, RAG, LLM, transformers, Transfer Learning.',
  jobs: [
    { job_id: 'cache_1', title: 'AI Engineer', company: 'Acme', url: 'https://a.co/1', description_snippet: 'LLM RAG Python', source_tier: 1 },
    { job_id: 'cache_2', title: 'ML Engineer', company: 'https://beta', url: 'https://b.co/2', description_snippet: 'deep learning CV', source_tier: 2 },
  ],
};
const AGG = { jobs: [
  { job_id: 'cache_1', company: 'Acme', url: 'https://a.co/1', location: 'New York, NY', updated_at: iso(20), source_tier: 1, source: 'serper' },
  { job_id: 'cache_2', company: 'https://beta', url: 'https://b.co/2', location: 'Remote', updated_at: iso(1), source_tier: 2, source: 'firecrawl' },
] };
const $for = (map) => (name) => { if (!(name in map)) throw new Error('unexpected $("' + name + '")'); return { first: () => ({ json: map[name] }) }; };

// 1) Build Matcher Request
const bmrOut = BMR({ first: () => ({ json: {} }) }, $for({ 'Build Scorer Input': BSI, 'Aggregate Jobs': AGG }))[0].json;
console.log('[Build Matcher Request]');
ok('has resume_text', !!bmrOut.resume_text);
ok('enrich true', bmrOut.enrich === true);
ok('top_n 12', bmrOut.top_n === 12);
ok('jobs mapped {id,title,jd_text,url}', bmrOut.jobs.length === 2 && bmrOut.jobs[0].id === 'cache_1' && bmrOut.jobs[0].jd_text === 'LLM RAG Python' && bmrOut.jobs[0].title.includes('AI Engineer'));

// 2) matcher response -> Parse
const MATCH_RESP = { results: [
  { id: 'cache_2', match_pct: 71, rerank_score: 0.66, validated: 'live', skill_match: { required: ['Deep Learning', 'Computer Vision', 'Python'], matched: ['Python'], missing: ['Computer Vision'], adjacent: [{ skill: 'Deep Learning', via: 'Transfer Learning', credit: 0.43 }], coverage: 0.55 } },
  { id: 'cache_1', match_pct: 78, rerank_score: 0.74, validated: 'live', skill_match: { required: ['Python', 'RAG', 'Docker'], matched: ['Python', 'RAG'], missing: ['Docker'], adjacent: [], coverage: 0.66 } },
], resume_skills: ['Python', 'RAG'], dropped: [{ id: 'cache_3', reason: 'http_404' }] };
const parseOut = PARSE({ first: () => ({ json: MATCH_RESP }) }, $for({}))[0].json;
console.log('[Parse Scorer Output (matcher)]');
ok('strategy matcher', parseOut.strategy === 'matcher');
ok('2 scored', parseOut.scored.length === 2);
const s1 = parseOut.scored.find(s => s.job_id === 'cache_1');
ok('score100 = match_pct (78)', s1.score100 === 78 && s1.match_pct === 78);
ok('matched skills carried', JSON.stringify(s1.matched_skills) === JSON.stringify(['Python', 'RAG']));
ok('adjacent flattened to names', JSON.stringify(parseOut.scored.find(s => s.job_id === 'cache_2').adjacent_skills) === JSON.stringify(['Deep Learning']));
ok('one_liner built', /Matches Python, RAG/.test(s1.one_liner));
ok('dropped carried (1)', parseOut.dropped.length === 1);

// 3) build_telegraph_body
const sd = { last_search_intent: { role_families: ['AI Engineer'] }, telegraph_token: '' };
const tbOut = TB({ first: () => ({ json: {} }) }, $for({ 'Parse Scorer Output': parseOut, 'Aggregate Jobs': AGG, 'Load Telegraph Token': { value: '' } }), () => sd)[0].json;
console.log('[Build Telegraph Body]');
const content = tbOut.content; const msg = tbOut.top3_msg;
ok('rankedJobs has 2', tbOut.rankedJobs.length === 2);
ok('top3 msg shows % match', /78% match/.test(msg) && /71% match/.test(msg));
ok('top3 shows matched skills', /Python, RAG/.test(msg));
ok('top3 shows dropped count', /Dropped 1 dead/.test(msg));
ok('company cleaned in top3 (no Https://)', !/Https:\/\//.test(msg));
ok('content has skill emojis', /✅/.test(content));
ok('content has validated badge', /verified/.test(content));
// ranking: cache_1 (78, 20d) vs cache_2 (71, 1d): 78+1=79 vs 71+6=77 -> cache_1 first
ok('ranked by match%+freshness (cache_1 first)', tbOut.rankedJobs[0].job_id === 'cache_1');

console.log(fails ? ('\n*** ' + fails + ' FAILURES ***') : '\nALL PASSED');
process.exit(fails ? 1 : 0);
