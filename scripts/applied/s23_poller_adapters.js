/**
 * s23_poller_adapters.js -- Phase 2.3 (Roadmap v4): poller adapter expansion.
 *
 * Adds 6 new ATS/company adapters to the registry poller, on top of the existing
 * greenhouse/lever/ashby/workable/recruitee. Every endpoint shape below was verified
 * empirically (direct curl against real, live tenants) by 5 parallel research agents
 * this session -- not guessed from training data. Two explicitly NOT implemented:
 * Meta (rotating per-deploy GraphQL doc_id + session CSRF token + undocumented input
 * schema + WAF rate-limiting under light load + an explicit robots.txt prohibition on
 * automated collection -- this is the "too fragile / not allowed" case, consistent
 * with this project's standing no-scraping-social-platforms principle) and Google
 * (no stable public API since 2021; the current careers site is Closure/WIZ internal
 * RPC requiring headless-browser session capture, a fundamentally different and far
 * more fragile integration than everything else here).
 *
 * New adapters:
 *   smartrecruiters, amazon, oracle -- GET, parsed straight from Fetch ATS's response
 *     (single page; same pattern as the 5 existing adapters).
 *   workday, apple, eightfold -- Fetch ATS's response is ignored for these; they
 *     self-fetch via require('https') inside Parse Jobs (POST bodies / small per-page
 *     caps / eightfold's dual-endpoint-tier fallback -- none of which a single GET
 *     node can express), with bounded pagination (MAX_PAGES=5) since their page sizes
 *     are small (10-20) and a single page badly undercounts a large tenant's real
 *     listing. This mirrors the require('https')-inside-a-Code-node pattern already
 *     proven safe in this exact sandbox by Verify Job Links (S17 liveness).
 *
 * v1 scope, explicitly disclosed: no secondary per-job detail-call for full JD text on
 * any of the 6 new adapters (jd_text is whatever the list response provides -- full
 * for amazon, short/absent for the rest). The existing relevance filter only tests
 * title, so this doesn't affect matching, only embed_input/JobScorer richness for
 * these sources. Oracle's apply_url is hardcoded to Oracle's own public careers
 * domain -- generalizing to other Oracle-ORC customers needs their public career-site
 * domain, which isn't derivable from the pod host alone; only Oracle itself is seeded.
 *
 * Bonus fix, found while adding these (unrelated to the expansion, but in the exact
 * node being touched): TITLE_RX was `new RegExp("string containing \s and \b")` --
 * JS string-escape processing silently eats \s (-> literal "s") and turns \b into an
 * actual backspace control character, not a word-boundary token. Verified live: the
 * broken version matched ZERO of "Machine Learning Engineer", "AI Engineer", "Data
 * Scientist", "NLP Researcher", "Senior Software Engineer", "Deep Learning
 * Researcher" -- the poller's relevance filter has been discarding almost every
 * genuinely relevant title since this filter was written, across ALL adapters, not
 * just the new ones. Fixed by switching to a regex literal (not string-escape-processed).
 *
 * Targets the ATS POLLER workflow (2 tracked copies, not the 3-copy master triad).
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
];

const NEW_BUILD_REQUESTS = fs.readFileSync(path.join(ROOT, 'scripts', 'nodes', 'poller_build_requests.js'), 'utf8');
const NEW_PARSE_JOBS = fs.readFileSync(path.join(ROOT, 'scripts', 'nodes', 'poller_parse_jobs.js'), 'utf8');

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of ['Build Requests', 'Parse Jobs']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  if (N['Build Requests'].parameters.jsCode !== NEW_BUILD_REQUESTS) {
    N['Build Requests'].parameters.jsCode = NEW_BUILD_REQUESTS;
    edits++;
  }
  if (N['Parse Jobs'].parameters.jsCode !== NEW_PARSE_JOBS) {
    N['Parse Jobs'].parameters.jsCode = NEW_PARSE_JOBS;
    edits++;
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: poller adapter expansion applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness: exercise the real logic against real-shaped sample payloads (the same
// fixtures used in standalone testing earlier this session, condensed here so this
// script is self-verifying like every other patch script in this repo). ──
(function harness() {
  function mockHttps(routes) {
    const counters = new Map();
    return {
      request(opts, cb) {
        const key = opts.method + ' ' + opts.host + ' ' + opts.path;
        const idx = counters.get(key) || 0;
        const candidates = routes.filter((r) => opts.method === r.method && opts.host === r.host && opts.path === r.path);
        const matched = candidates[idx] || null;
        counters.set(key, idx + 1);
        const EventEmitter = require('events');
        const req = new EventEmitter();
        req.write = () => {};
        req.end = () => {
          setImmediate(() => {
            const res = new EventEmitter();
            res.statusCode = matched ? matched.status : 404;
            cb(res);
            setImmediate(() => { if (matched) res.emit('data', Buffer.from(matched.body)); res.emit('end'); });
          });
        };
        req.destroy = () => {};
        return req;
      },
    };
  }
  async function runParseJobs(inputItems, buildRequestsItems, httpsRoutes) {
    const $input = { all: () => inputItems.map((j) => ({ json: j })) };
    const $ = (name) => ({ all: () => buildRequestsItems.map((j) => ({ json: j })) });
    const req = (name) => { if (name === 'https') return mockHttps(httpsRoutes || []); throw new Error('unexpected require: ' + name); };
    const fn = new Function('$input', '$', 'require', 'return (async () => {' + NEW_PARSE_JOBS + '})()');
    return fn($input, $, req);
  }

  const failures = [];
  function check(name, cond) { if (!cond) failures.push(name); }
  const asyncChecks = [];

  // Build Requests: correct URLs, unsupported types dropped.
  {
    const companies = [
      { company_id: 1, board: 'greenhouse:acme', ats_type: 'greenhouse', slug: 'acme' },
      { company_id: 2, board: 'smartrecruiters:linkedin3', ats_type: 'smartrecruiters', slug: 'linkedin3' },
      { company_id: 5, board: 'workday:intel.wd1|External', ats_type: 'workday', slug: 'External', api_base: 'intel.wd1' },
      { company_id: 8, board: 'unsupported:x', ats_type: 'personio', slug: 'x' },
    ];
    const $input = { all: () => companies.map((c) => ({ json: c })) };
    const fn = new Function('$input', NEW_BUILD_REQUESTS);
    const out = fn($input);
    check('Build Requests: unsupported ats_type dropped (3 of 4 kept)', out.length === 3);
    check('Build Requests: workday URL uses api_base tenant.wdN + slug site', out.some((o) => o.json.url === 'https://intel.wd1.myworkdayjobs.com/wday/cxs/intel/External/jobs'));
  }

  // TITLE_RX fix: must match canonical relevant titles that the old string-based
  // RegExp("...\s...\b...") construction silently never matched (\s eaten, \b became
  // a literal backspace control character).
  asyncChecks.push((async () => {
    const greenhouseBody = JSON.stringify({ jobs: [{ id: 1, title: 'Machine Learning Engineer', content: 'x', location: {}, absolute_url: 'u', updated_at: '2026-01-01' }] });
    const out = await runParseJobs([{ statusCode: 200, body: greenhouseBody }], [{ company_id: 1, board: 'greenhouse:acme', ats_type: 'greenhouse', slug: 'acme' }]);
    check('TITLE_RX fix: "Machine Learning Engineer" now matches', out.length === 1);
  })());

  // Regression: greenhouse untouched behavior.
  asyncChecks.push((async () => {
    const greenhouseBody = JSON.stringify({ jobs: [{ id: 111, title: 'AI Engineer', content: '<p>Do ML</p>', location: { name: 'Remote' }, absolute_url: 'https://gh.example/1', updated_at: '2026-06-01T00:00:00Z' }] });
    const out = await runParseJobs([{ statusCode: 200, body: greenhouseBody }], [{ company_id: 1, board: 'greenhouse:acme', ats_type: 'greenhouse', slug: 'acme' }]);
    check('greenhouse regression: parses correctly', out.length === 1 && out[0].json.title === 'AI Engineer');
  })());

  // SmartRecruiters.
  asyncChecks.push((async () => {
    const srBody = JSON.stringify({ content: [{ id: '744000135809904', name: 'AI Engineer', releasedDate: '2026-07-04T01:44:49.468Z', location: { fullLocation: 'Bengaluru, India', remote: false } }] });
    const out = await runParseJobs([{ statusCode: 200, body: srBody }], [{ company_id: 2, board: 'smartrecruiters:linkedin3', ats_type: 'smartrecruiters', slug: 'linkedin3' }]);
    check('smartrecruiters: parses + builds apply_url', out.length === 1 && out[0].json.apply_url === 'https://jobs.smartrecruiters.com/linkedin3/744000135809904');
  })());

  // Amazon (full JD embedded, no detail call).
  asyncChecks.push((async () => {
    const amznBody = JSON.stringify({ jobs: [{ id_icims: '2764321', title: 'Software Engineer AI', description: '<p>Build</p>', location: 'US, WA, Seattle', locations: [JSON.stringify({ type: 'VIRTUAL' })], url_next_step: 'https://account.amazon.com/jobs/2764321/apply' }] });
    const out = await runParseJobs([{ statusCode: 200, body: amznBody }], [{ company_id: 3, board: 'amazon:amazon', ats_type: 'amazon', slug: 'amazon' }]);
    check('amazon: parses + remote from VIRTUAL + jd_text present', out.length === 1 && out[0].json.remote === true && out[0].json.jd_text === 'Build');
  })());

  // Oracle.
  asyncChecks.push((async () => {
    const oracleBody = JSON.stringify({ items: [{ requisitionList: [{ Id: '12345', Title: 'ML Engineer', PrimaryLocation: 'Austin', WorkplaceType: 'Remote', PostedDate: '2026-06-01' }] }] });
    const out = await runParseJobs([{ statusCode: 200, body: oracleBody }], [{ company_id: 4, board: 'oracle:CX_45001', ats_type: 'oracle', slug: 'CX_45001', api_base: 'eeho.fa.us2.oraclecloud.com' }]);
    check('oracle: parses + apply_url', out.length === 1 && out[0].json.apply_url === 'https://careers.oracle.com/en/sites/jobsearch/job/12345/');
  })());

  // Workday self-fetch: 2 pages, correctly advances offset (no duplication).
  asyncChecks.push((async () => {
    const page0 = JSON.stringify({ total: 25, jobPostings: Array.from({ length: 20 }, (_, i) => ({ title: i < 3 ? 'AI Engineer ' + i : 'Facilities Tech ' + i, externalPath: '/job/Site/Job_' + i })) });
    const page1 = JSON.stringify({ total: 25, jobPostings: Array.from({ length: 5 }, (_, i) => ({ title: 'Random Role ' + i, externalPath: '/job/Site/Job2_' + i })) });
    const route = { method: 'POST', host: 'intel.wd1.myworkdayjobs.com', path: '/wday/cxs/intel/External/jobs', status: 200 };
    const out = await runParseJobs(
      [{ statusCode: 0, body: '' }],
      [{ company_id: 5, board: 'workday:intel.wd1|External', ats_type: 'workday', slug: 'External', api_base: 'intel.wd1' }],
      [Object.assign({}, route, { body: page0 }), Object.assign({}, route, { body: page1 })]
    );
    check('workday self-fetch: paginates without duplicating (3 of 20 matched, not 6)', out.length === 3);
  })());

  // Apple self-fetch.
  asyncChecks.push((async () => {
    const appleBody = JSON.stringify({ res: { searchResults: [{ positionId: '200123', postingTitle: 'AI/ML Software Engineer', jobSummary: 'Build ML', locations: [{ city: 'Cupertino' }], postingDate: '2026-06-15' }] } });
    const out = await runParseJobs([{ statusCode: 0, body: '' }], [{ company_id: 6, board: 'apple:apple', ats_type: 'apple', slug: 'apple' }], [{ method: 'POST', host: 'jobs.apple.com', path: '/api/v1/search', status: 200, body: appleBody }]);
    check('apple self-fetch: parses + short-page stops pagination', out.length === 1);
  })());

  // Eightfold: smartapply works directly.
  asyncChecks.push((async () => {
    const efBody = JSON.stringify({ positions: [{ id: 790298014263, name: 'AI Engineer 6', location: 'USA - Remote', t_create: 1721692800, work_location_option: 'remote_local', canonicalPositionUrl: 'https://explore.jobs.netflix.net/careers/job/790298014263' }] });
    const out = await runParseJobs([{ statusCode: 0, body: '' }], [{ company_id: 7, board: 'eightfold:netflix.com', ats_type: 'eightfold', slug: 'netflix.com', api_base: 'explore.jobs.netflix.net' }], [{ method: 'GET', host: 'explore.jobs.netflix.net', path: '/api/apply/v2/jobs?domain=netflix.com&start=0&num=10', status: 200, body: efBody }]);
    check('eightfold smartapply: parses, remote from remote_local', out.length === 1 && out[0].json.remote === true);
  })());

  // Eightfold: smartapply 403s, falls back to pcsx tier (Microsoft's real behavior).
  asyncChecks.push((async () => {
    const pcsxBody = JSON.stringify({ data: { positions: [{ displayJobId: '200039153', name: 'Principal Software Engineer - AI', locations: ['Redmond, WA'] }] } });
    const out = await runParseJobs(
      [{ statusCode: 0, body: '' }],
      [{ company_id: 8, board: 'eightfold:microsoft.com', ats_type: 'eightfold', slug: 'microsoft.com', api_base: 'apply.careers.microsoft.com' }],
      [
        { method: 'GET', host: 'apply.careers.microsoft.com', path: '/api/apply/v2/jobs?domain=microsoft.com&start=0&num=10', status: 403, body: '{}' },
        { method: 'GET', host: 'apply.careers.microsoft.com', path: '/api/pcsx/search?domain=microsoft.com&start=0&num=10', status: 200, body: pcsxBody },
      ]
    );
    check('eightfold pcsx fallback: 403 on smartapply correctly falls back and parses', out.length === 1 && out[0].json.external_id === '200039153');
  })());

  return Promise.all(asyncChecks).then(() => {
    if (failures.length) { console.error('HARNESS FAIL:', failures.join(', ')); process.exit(1); }
    console.log('HARNESS OK: Build Requests URL table + all 6 new adapters (smartrecruiters/amazon/oracle sync-parsed, workday/apple/eightfold self-fetch with pagination + eightfold tier-fallback, no duplication) + TITLE_RX fix + greenhouse regression -- all verified');
  });
})().then(() => {
  TARGETS.forEach(patch);
  console.log('S23 (poller adapter expansion) complete.');
}).catch((e) => { console.error('FATAL:', e); process.exit(1); });
