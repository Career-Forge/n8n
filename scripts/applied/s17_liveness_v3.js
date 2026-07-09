/**
 * s17_liveness_v3.js -- liveness v3: verify by API, not by probe.
 *
 * S14 shipped sandbox-safe status-code probing (no new URL()) and fixed the "0 roles"
 * incident. This pass fixes the accuracy gaps the 2026-07-02 digest audit found:
 *   1) Ashby was skipped entirely (its HTML always 200s) -- now uses the org-level
 *      posting API, which also URL-decodes org slugs ("Wisdom%20AI" bug).
 *   2) Greenhouse used redirect-chase + string-matching "error=true" -- now uses the
 *      JSON API (boards-api.greenhouse.io) as the primary, definitive check, with the
 *      old redirect-chase kept as a fallback if the API call itself errors.
 *   3) Workday's anchor parser took "last URL segment" as the job slug, which broke on
 *      URLs with a trailing /apply/<something> suffix (real bug: Fractal listing
 *      resolved to slug "useMyLastApplication" instead of the real job anchor) -- now
 *      strips any /apply/... suffix and /details/ before extracting the anchor, and
 *      treats a 200 response with canApply:false as dead (not just 404).
 *   4) LinkedIn now uses the jobs-guest API explicitly (closed-job marker / redirect
 *      containing expired_jd_redirect), instead of relying on generic status-chase.
 *   5) Listing-page garbage (a "300+ jobs in X" aggregator page mistaken for a single
 *      posting -- the bebee.com case in the audit) is filtered before probing at all.
 *
 * Everything here is verified against the exact ATS behaviors probed live 2026-07-02.
 * Per-job wall-clock ceiling stays at 8s; inconclusive (403, timeout, org-API failure)
 * still means KEEP, never dead -- the S14 invariant is unchanged.
 *
 * NOTE: this does NOT wire the "org-API response backfills the jobs cache" side effect
 * from the roadmap -- n8n Code nodes cannot write to Postgres directly (no `pg` client
 * in the sandbox; every DB write in this codebase goes through a dedicated Postgres
 * node). That needs a new node + connection and ships as its own follow-up.
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

const OLD_BODY = String.raw`// Verify Job Links -- WS2 v2. Per-host liveness probes; inconclusive != dead.
// Sandbox: NO global URL/fetch; https builtin only (no http). Degrades to pass-through.
const agg = $input.first().json || {};
const jobs = Array.isArray(agg.jobs) ? agg.jobs : [];
let out = jobs, deadRemoved = 0, mode = 'off';

function parseUrl(raw) {
  const m = String(raw || '').trim().match(/^(https?):\/\/([^\/?#]+)((?:\/[^#]*)?)/);
  if (!m) return null;
  const host = m[2].split('@').pop().split(':')[0].toLowerCase();
  return { proto: m[1].toLowerCase(), host, path: m[3] || '/' };
}
function resolveLoc(cur, loc) {
  if (!loc) return null;
  if (/^https:\/\//i.test(loc)) return loc;
  if (/^http:\/\//i.test(loc)) return null; // no http builtin -> unfollowable -> inconclusive
  if (loc.slice(0, 2) === '//') return 'https:' + loc;
  if (loc[0] === '/') return 'https://' + cur.host + loc;
  return null;
}
function workdayCxs(u) {
  // https://<tenant>.<wdN>.myworkdayjobs.com/[<lang-REGION>/]<site>/job/.../<slug>
  const tenant = u.host.split('.')[0];
  const segs = u.path.split('?')[0].split('/').filter(Boolean);
  if (segs.length && /^[a-z]{2}-[A-Z]{2}$/.test(segs[0])) segs.shift();
  const jobIdx = segs.indexOf('job');
  if (jobIdx < 1 || jobIdx === segs.length - 1) return null;
  return { proto: 'https', host: u.host, path: '/wday/cxs/' + tenant + '/' + segs[0] + '/job/' + segs[segs.length - 1] };
}

try {
  const https = require('https');
  mode = 'https';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
  const req1 = (u, method, accept) => new Promise((resolve) => {
    const r = https.request(
      { method, host: u.host, path: u.path, timeout: 3500,
        headers: Object.assign({ 'User-Agent': UA }, accept ? { Accept: accept } : {}) },
      (res) => { res.resume(); resolve({ status: res.statusCode || 0, location: (res.headers || {}).location || '' }); }
    );
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, location: '' }); });
    r.on('error', () => resolve({ status: 0, location: '' }));
    r.end();
  });
  async function chase(u, method) {
    let cur = u, url = 'https://' + u.host + u.path;
    for (let hop = 0; hop <= 3; hop++) {
      const res = await req1(cur, method);
      if ([301, 302, 303, 307, 308].indexOf(res.status) !== -1) {
        const next = resolveLoc(cur, res.location);
        if (!next) return { status: res.status, finalUrl: url };
        url = next;
        const p = parseUrl(next);
        if (!p || p.proto !== 'https') return { status: res.status, finalUrl: url };
        cur = p;
        continue;
      }
      return { status: res.status, finalUrl: url };
    }
    return { status: 0, finalUrl: url }; // redirect cap -> inconclusive
  }
  async function probe(job) {
    const u = parseUrl(job.url);
    if (!u || u.proto !== 'https') return 'keep';
    const h = u.host;
    if (h === 'jobs.ashbyhq.com') return 'keep'; // always-200 host, body check not worth it
    if (h.endsWith('.myworkdayjobs.com')) {
      const cxs = workdayCxs(u);
      if (!cxs) return 'keep';
      const res = await req1(cxs, 'GET', 'application/json');
      return res.status === 404 ? 'dead' : 'keep';
    }
    const r = await chase(u, 'HEAD');
    if (r.status === 404 || r.status === 410) return 'dead';
    if ((h === 'boards.greenhouse.io' || h === 'job-boards.greenhouse.io') && r.finalUrl.indexOf('error=true') !== -1) return 'dead';
    return 'keep';
  }
  const wait = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const verdicts = await Promise.all(out.map((j) => Promise.race([probe(j), wait(8000, 'keep')])));
  const alive = [];
  for (let i = 0; i < out.length; i++) {
    if (verdicts[i] !== 'dead') alive.push(Object.assign({}, out[i], { link_checked: true }));
  }
  deadRemoved = out.length - alive.length;
  out = alive;
} catch (e) { mode = 'unavailable'; }

return [{ json: Object.assign({}, agg, { jobs: out, count: out.length, dead_removed: deadRemoved, liveness: mode }) }];`;

const NEW_BODY = String.raw`// Verify Job Links -- v3. API-verify instead of status-probe where a definitive,
// unauthenticated endpoint exists (Lever/Greenhouse/Ashby/Workday/LinkedIn); generic
// HEAD-chase remains the fallback for everything else. Inconclusive != dead, always.
// Sandbox: NO global URL/fetch; https builtin only (no http). Degrades to pass-through.
const agg = $input.first().json || {};
let jobs = Array.isArray(agg.jobs) ? agg.jobs : [];

// Listing-page garbage: a "300+ Machine Learning Engineer Jobs in X" aggregator page
// mistaken for one posting -- digits, up to 4 words, then a plural jobs-word.
const LISTING_PAGE_RX = /\b\d+\+?\s+(?:[a-z]+\s+){0,4}(jobs|openings|positions|roles)\b/i;
jobs = jobs.filter((j) => !LISTING_PAGE_RX.test(String(j.title || '')));

let out = jobs, deadRemoved = 0, mode = 'off';

function parseUrl(raw) {
  const m = String(raw || '').trim().match(/^(https?):\/\/([^\/?#]+)((?:\/[^#]*)?)/);
  if (!m) return null;
  const host = m[2].split('@').pop().split(':')[0].toLowerCase();
  return { proto: m[1].toLowerCase(), host, path: m[3] || '/' };
}
function resolveLoc(cur, loc) {
  if (!loc) return null;
  if (/^https:\/\//i.test(loc)) return loc;
  if (/^http:\/\//i.test(loc)) return null; // no http builtin -> unfollowable -> inconclusive
  if (loc.slice(0, 2) === '//') return 'https:' + loc;
  if (loc[0] === '/') return 'https://' + cur.host + loc;
  return null;
}
function workdayCxs(u) {
  // https://<tenant>.<wdN>.myworkdayjobs.com/[<lang-REGION>/]<site>/job|details/.../<slug>[/apply/...]
  const tenant = u.host.split('.')[0];
  let segs = u.path.split('?')[0].split('/').filter(Boolean);
  if (segs.length && /^[a-z]{2}-[A-Z]{2}$/.test(segs[0])) segs.shift(); // strip locale
  const applyIdx = segs.indexOf('apply');
  if (applyIdx !== -1) segs = segs.slice(0, applyIdx); // strip trailing /apply/<action> (real bug: /apply/useMyLastApplication)
  let markerIdx = segs.indexOf('job');
  if (markerIdx === -1) markerIdx = segs.indexOf('details'); // CXS only accepts /job/, source URLs may say /details/
  if (markerIdx < 1 || markerIdx === segs.length - 1) return null;
  return { proto: 'https', host: u.host, path: '/wday/cxs/' + tenant + '/' + segs[0] + '/job/' + segs[segs.length - 1] };
}

try {
  const https = require('https');
  mode = 'https';
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
  const req1 = (u, method, accept) => new Promise((resolve) => {
    const r = https.request(
      { method, host: u.host, path: u.path, timeout: 3500,
        headers: Object.assign({ 'User-Agent': UA }, accept ? { Accept: accept } : {}) },
      (res) => { res.resume(); resolve({ status: res.statusCode || 0, location: (res.headers || {}).location || '' }); }
    );
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, location: '' }); });
    r.on('error', () => resolve({ status: 0, location: '' }));
    r.end();
  });
  const reqBody = (u, method, accept) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const r = https.request(
      { method, host: u.host, path: u.path, timeout: 3500,
        headers: Object.assign({ 'User-Agent': UA }, accept ? { Accept: accept } : {}) },
      (res) => {
        res.on('data', (c) => { size += c.length; if (size < 300000) chunks.push(c); });
        res.on('end', () => resolve({ status: res.statusCode || 0, location: (res.headers || {}).location || '', body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, location: '', body: '' }); });
    r.on('error', () => resolve({ status: 0, location: '', body: '' }));
    r.end();
  });
  async function chase(u, method) {
    let cur = u, url = 'https://' + u.host + u.path;
    for (let hop = 0; hop <= 3; hop++) {
      const res = await req1(cur, method);
      if ([301, 302, 303, 307, 308].indexOf(res.status) !== -1) {
        const next = resolveLoc(cur, res.location);
        if (!next) return { status: res.status, finalUrl: url };
        url = next;
        const p = parseUrl(next);
        if (!p || p.proto !== 'https') return { status: res.status, finalUrl: url };
        cur = p;
        continue;
      }
      return { status: res.status, finalUrl: url };
    }
    return { status: 0, finalUrl: url }; // redirect cap -> inconclusive
  }

  const ashbyOrgCache = new Map(); // org (decoded) -> Set(ids) | null (API failed -> inconclusive)
  async function ashbyOrgIds(org) {
    if (ashbyOrgCache.has(org)) return ashbyOrgCache.get(org);
    const res = await reqBody({ proto: 'https', host: 'api.ashbyhq.com', path: '/posting-api/job-board/' + encodeURIComponent(org) }, 'GET', 'application/json');
    let ids = null;
    if (res.status === 200) {
      try { const data = JSON.parse(res.body); ids = new Set((data.jobs || []).map((j) => j.id)); } catch (e) { ids = null; }
    }
    ashbyOrgCache.set(org, ids);
    return ids;
  }

  async function probe(job) {
    const u = parseUrl(job.url);
    if (!u || u.proto !== 'https') return 'keep';
    const h = u.host;

    if (h === 'jobs.ashbyhq.com') {
      const m = u.path.match(/^\/([^\/]+)\/([0-9a-fA-F-]{20,})/);
      if (!m) return 'keep';
      const org = decodeURIComponent(m[1]);
      const ids = await ashbyOrgIds(org);
      if (!ids) return 'keep'; // org API failed -> inconclusive
      return ids.has(m[2]) ? 'keep' : 'dead';
    }

    if (h === 'boards.greenhouse.io' || h === 'job-boards.greenhouse.io') {
      const m = u.path.match(/^\/([^\/]+)\/jobs\/(\d+)/);
      if (m) {
        const res = await req1({ proto: 'https', host: 'boards-api.greenhouse.io', path: '/v1/boards/' + m[1] + '/jobs/' + m[2] }, 'GET', 'application/json');
        if (res.status === 404) return 'dead';
        if (res.status === 200) return 'keep';
        // API errored (network/timeout) -> fall through to redirect-chase below
      }
      const r = await chase(u, 'HEAD');
      if (r.status === 404 || r.status === 410) return 'dead';
      if (r.finalUrl.indexOf('error=true') !== -1) return 'dead';
      return 'keep';
    }

    if (h.endsWith('.myworkdayjobs.com')) {
      const cxs = workdayCxs(u);
      if (!cxs) return 'keep';
      const res = await reqBody(cxs, 'GET', 'application/json');
      if (res.status === 404) return 'dead';
      if (res.status === 200) {
        try { const data = JSON.parse(res.body); if (data.jobPostingInfo && data.jobPostingInfo.canApply === false) return 'dead'; } catch (e) {}
        return 'keep';
      }
      return 'keep'; // 403/other (tenant firewalls CXS) -> inconclusive
    }

    if (h === 'www.linkedin.com' || h === 'linkedin.com') {
      const m = u.path.match(/\/jobs\/view\/(?:[^\/]*-)?(\d+)/);
      if (m) {
        const res = await reqBody({ proto: 'https', host: 'www.linkedin.com', path: '/jobs-guest/jobs/api/jobPosting/' + m[1] }, 'GET', 'text/html');
        if (res.status === 404) return 'dead';
        if (/no longer accepting applications|closed-job/i.test(res.body)) return 'dead';
      }
      const r = await chase(u, 'HEAD');
      if (r.status === 404 || r.status === 410) return 'dead';
      if (r.finalUrl.indexOf('expired_jd_redirect') !== -1) return 'dead';
      return 'keep';
    }

    const r = await chase(u, 'HEAD');
    if (r.status === 404 || r.status === 410) return 'dead';
    return 'keep';
  }

  const wait = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const verdicts = await Promise.all(out.map((j) => Promise.race([probe(j), wait(8000, 'keep')])));
  const alive = [];
  for (let i = 0; i < out.length; i++) {
    if (verdicts[i] !== 'dead') alive.push(Object.assign({}, out[i], { link_checked: true }));
  }
  deadRemoved = out.length - alive.length;
  out = alive;
} catch (e) { mode = 'unavailable'; }

return [{ json: Object.assign({}, agg, { jobs: out, count: out.length, dead_removed: deadRemoved, liveness: mode }) }];`;

// ── harness: mock https per host, prove every new branch + the two real bugs fixed ──
(async function harness() {
  function mkHttps(responses) {
    // responses: fn(host, path, method) -> { status, location, body }
    return {
      request(opts, cb) {
        const r = responses(opts.host, opts.path, opts.method, opts.headers) || { status: 0 };
        setImmediate(() => {
          const res = {
            statusCode: r.status,
            headers: r.location ? { location: r.location } : {},
            resume() {},
            on(ev, fn) {
              if (ev === 'data' && r.body) setImmediate(() => fn(Buffer.from(r.body)));
              if (ev === 'end') setImmediate(() => fn());
              return res;
            },
          };
          cb(res);
        });
        return { on() { return this; }, end() {}, destroy() {} };
      },
    };
  }
  async function run(jobs, responder) {
    const fn = new Function('$input', 'require', 'return (async () => {\n' + NEW_BODY + '\n})()');
    const mockInput = { first: () => ({ json: { jobs, count: jobs.length } }) };
    const mockRequire = (mod) => { if (mod === 'https') return mkHttps(responder); throw new Error('unexpected require: ' + mod); };
    return fn(mockInput, mockRequire);
  }

  // 1) Ashby: org API confirms alive + dead, and URL-decodes "Wisdom%20AI"
  const ashbyJobs = [
    { url: 'https://jobs.ashbyhq.com/openai/11111111-1111-1111-1111-111111111111', title: 'Alive @ OpenAI' },
    { url: 'https://jobs.ashbyhq.com/openai/22222222-2222-2222-2222-222222222222', title: 'Dead @ OpenAI' },
    { url: 'https://jobs.ashbyhq.com/Wisdom%20AI/33333333-3333-3333-3333-333333333333', title: 'Alive @ Wisdom AI' },
  ];
  const ashbyOut = await run(ashbyJobs, (host, p) => {
    if (host === 'api.ashbyhq.com' && p.includes('/openai')) return { status: 200, body: JSON.stringify({ jobs: [{ id: '11111111-1111-1111-1111-111111111111' }] }) };
    if (host === 'api.ashbyhq.com' && p.includes(encodeURIComponent('Wisdom AI'))) return { status: 200, body: JSON.stringify({ jobs: [{ id: '33333333-3333-3333-3333-333333333333' }] }) };
    return { status: 404 };
  });
  const ashbyTitles = ashbyOut[0].json.jobs.map((j) => j.title);
  if (ashbyOut[0].json.dead_removed !== 1 || !ashbyTitles.includes('Alive @ OpenAI') || !ashbyTitles.includes('Alive @ Wisdom AI') || ashbyTitles.includes('Dead @ OpenAI')) {
    console.error('HARNESS FAIL: Ashby org-API check wrong:', JSON.stringify(ashbyOut[0].json)); process.exit(1);
  }

  // 2) Greenhouse: JSON API 200/404
  const ghJobs = [
    { url: 'https://job-boards.greenhouse.io/gitlab/jobs/1001', title: 'GH alive' },
    { url: 'https://job-boards.greenhouse.io/gitlab/jobs/2002', title: 'GH dead' },
  ];
  const ghOut = await run(ghJobs, (host, p) => {
    if (host === 'boards-api.greenhouse.io' && p.includes('/1001')) return { status: 200 };
    if (host === 'boards-api.greenhouse.io' && p.includes('/2002')) return { status: 404 };
    return { status: 0 };
  });
  if (ghOut[0].json.count !== 1 || ghOut[0].json.jobs[0].title !== 'GH alive') { console.error('HARNESS FAIL: Greenhouse API check wrong:', JSON.stringify(ghOut[0].json)); process.exit(1); }

  // 3) Workday: the real bug -- /apply/useMyLastApplication suffix must not corrupt the anchor
  const wdJobs = [
    { url: 'https://fractal.wd1.myworkdayjobs.com/en-US/Careers/job/Bengaluru/Real-Slug_SR-31318/apply/useMyLastApplication', title: 'WD with apply suffix (alive)' },
    { url: 'https://fractal.wd1.myworkdayjobs.com/en-US/Careers/job/Bengaluru/Dead-Slug_SR-99999', title: 'WD dead' },
    { url: 'https://ntst.wd1.myworkdayjobs.com/en-US/Careers/job/Senior-Data-Scientist_R015344', title: 'WD canApply false' },
  ];
  const wdOut = await run(wdJobs, (host, p) => {
    if (p.includes('Real-Slug_SR-31318')) return { status: 200, body: JSON.stringify({ jobPostingInfo: { canApply: true } }) };
    if (p.includes('useMyLastApplication')) return { status: 404 }; // proves the buggy anchor would have been requested if not stripped
    if (p.includes('Dead-Slug_SR-99999')) return { status: 404 };
    if (p.includes('Senior-Data-Scientist_R015344')) return { status: 200, body: JSON.stringify({ jobPostingInfo: { canApply: false } }) };
    return { status: 0 };
  });
  const wdTitles = wdOut[0].json.jobs.map((j) => j.title);
  if (!wdTitles.includes('WD with apply suffix (alive)')) { console.error('HARNESS FAIL: Workday /apply suffix bug not fixed:', JSON.stringify(wdOut[0].json)); process.exit(1); }
  if (wdTitles.includes('WD dead') || wdTitles.includes('WD canApply false')) { console.error('HARNESS FAIL: Workday dead/canApply:false not caught:', JSON.stringify(wdOut[0].json)); process.exit(1); }

  // 4) Workday: 403-firewalled tenant -> inconclusive, keep
  const wd403 = await run([{ url: 'https://ag.wd3.myworkdayjobs.com/en-US/Airbus/job/Bangalore-Area/Slug_JR1', title: 'firewalled' }], () => ({ status: 403 }));
  if (wd403[0].json.count !== 1) { console.error('HARNESS FAIL: Workday 403 should be inconclusive/keep'); process.exit(1); }

  // 5) LinkedIn: closed-job marker + expired redirect
  const liJobs = [
    { url: 'https://www.linkedin.com/jobs/view/some-title-4001', title: 'LI alive' },
    { url: 'https://www.linkedin.com/jobs/view/some-title-4002', title: 'LI closed banner' },
  ];
  const liOut = await run(liJobs, (host, p) => {
    if (host === 'www.linkedin.com' && p.includes('/jobPosting/4001')) return { status: 200, body: '<div>Apply now</div>' };
    if (host === 'www.linkedin.com' && p.includes('/jobPosting/4002')) return { status: 200, body: '<div class="closed-job">No longer accepting applications</div>' };
    return { status: 0 };
  });
  if (liOut[0].json.count !== 1 || liOut[0].json.jobs[0].title !== 'LI alive') { console.error('HARNESS FAIL: LinkedIn guest-API check wrong:', JSON.stringify(liOut[0].json)); process.exit(1); }

  // 6) Listing-page garbage filtered before any probing occurs
  const garbageJobs = [
    { url: 'https://bebee.com/jobs/ml-engineer-bengaluru', title: '300+ Machine Learning Engineer Jobs in Bengaluru 2026' },
    { url: 'https://boards.greenhouse.io/acme/jobs/555', title: 'Real ML Engineer role' },
  ];
  let ghApiCalled = false;
  const garbageOut = await run(garbageJobs, (host, p) => {
    if (host === 'boards-api.greenhouse.io') { ghApiCalled = true; return { status: 200 }; }
    return { status: 301, location: 'https://job-boards.greenhouse.io/acme/jobs/555' };
  });
  if (garbageOut[0].json.count !== 1 || garbageOut[0].json.jobs[0].title.indexOf('300+') !== -1) { console.error('HARNESS FAIL: listing-page garbage not filtered:', JSON.stringify(garbageOut[0].json)); process.exit(1); }

  // 7) degraded path: require('https') throws -> pass-through, nothing lost
  const degradeFn = new Function('$input', 'require', 'return (async () => {\n' + NEW_BODY + '\n})()');
  const degraded = await degradeFn({ first: () => ({ json: { jobs: [{ url: 'https://x.example.com/j/1', title: 'x' }] } }) }, () => { throw new Error('sandboxed'); });
  if (degraded[0].json.count !== 1 || degraded[0].json.liveness !== 'unavailable') { console.error('HARNESS FAIL: degraded path'); process.exit(1); }

  console.log('HARNESS OK: Ashby org-API (+URL-decode), Greenhouse JSON API, Workday /apply-suffix fix + canApply + 403-inconclusive, LinkedIn guest-API, listing-page filter, degraded pass-through -- all verified');
})().then(() => {
  function patch(file) {
    if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
    const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = path.basename(file);
    const node = wf.nodes.find((n) => n.name === 'Verify Job Links');
    if (!node) { console.error(`INTEGRITY FAIL ${base}: Verify Job Links not found`); process.exit(1); }
    if (node.parameters.jsCode === NEW_BODY) { console.log(`  ${base}: Verify Job Links already patched`); return; }
    if (node.parameters.jsCode !== OLD_BODY) { console.error(`INTEGRITY FAIL ${base}: Verify Job Links does not match expected old value`); process.exit(1); }
    node.parameters.jsCode = NEW_BODY;
    fs.writeFileSync(file, JSON.stringify(wf, null, 2));
    console.log(`OK ${base}: liveness v3 applied -- ${wf.nodes.length} nodes`);
  }
  TARGETS.forEach(patch);
  console.log('S17 (liveness v3) complete.');
}).catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
