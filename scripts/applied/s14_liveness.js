/**
 * s14_liveness.js -- WS2 v2: kill expired listings + sink unknown-location results.
 *
 * Supersedes the reverted s12 attempt, which died on `new URL()` (the n8n task-runner
 * sandbox injects NO global URL -- only Buffer/timers/btoa/atob/TextEncoder/FormData).
 * This version parses URLs manually and probes per-host (empirical rules from real
 * curl research against each ATS):
 *   - greenhouse: legacy URLs 301 for everything -> follow redirects (cap 3);
 *     dead = 404/410 OR final URL contains error=true.
 *   - lever / linkedin: plain status works (404/410 = dead).
 *   - ashby: HTML is 200 even for dead postings -> skip probing (keep).
 *   - workday: HTML always 200 -> probe the CXS JSON endpoint
 *     /wday/cxs/<tenant>/<site>/job/<slug> which returns a real 200/404.
 *   - everything else: HEAD; dead only on 404/410. Timeouts, errors, 405s,
 *     redirect caps, http:// targets: inconclusive != dead -> keep.
 * Splice: the single edge Aggregate Jobs -> Experience Filter (new "Verify Job Links"
 * code node). Experience Filter falls back to the unfiltered Aggregate list if the
 * verify node errored -- inconclusive must never wipe a digest. Degrades to
 * pass-through (liveness:'unavailable') if require('https') is sandboxed away.
 *
 * Also: Parse Scorer Output scores unknown-location 35 / mismatch 0 (was 60/20)
 * when the query names a location and isn't remote-only, plus a final
 * score-then-location sort; Build Telegraph Body gains a "N expired removed" badge.
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const VERIFY_CODE = String.raw`// Verify Job Links -- WS2 v2. Per-host liveness probes; inconclusive != dead.
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

const EF_OLD = String.raw`const jobs = $('Aggregate Jobs').first().json.jobs || [];`;
const EF_NEW = String.raw`let jobs = [];
try { jobs = $('Verify Job Links').first().json.jobs || []; } catch (e) {}
if (!jobs.length) { try { jobs = $('Aggregate Jobs').first().json.jobs || []; } catch (e) {} }`;

const BADGE_OLD = String.raw`const tierBadgeLine = tierBadgeParts.length ? ('Sources: ' + tierBadgeParts.join(' · ')) : '';`;
const BADGE_NEW = String.raw`const _vjl = (() => { try { return $('Verify Job Links').first().json || {}; } catch (e) { return {}; } })();
if ((_vjl.dead_removed || 0) > 0) tierBadgeParts.push('✂ ' + _vjl.dead_removed + ' expired removed');
const tierBadgeLine = tierBadgeParts.length ? ('Sources: ' + tierBadgeParts.join(' · ')) : '';`;

const LOC_OLD = String.raw`const _locMap = { match: 100, unknown: 60, mismatch: 20 };`;
const LOC_NEW = String.raw`const _locSpecific = !!_eq.location_canonical && _eq.remote_preference !== 'remote_only';
const _locMap = _locSpecific ? { match: 100, unknown: 35, mismatch: 0 } : { match: 100, unknown: 60, mismatch: 20 };`;

const SORT_OLD = String.raw`return [{ json: { scored, total: scored.length, strategy, parse_error: parseError } }];`;
const SORT_NEW = String.raw`const _ordLoc = { match: 0, unknown: 1, mismatch: 2 };
scored.sort((a, b) => (b.score100 - a.score100) || ((_ordLoc[a.location_match] != null ? _ordLoc[a.location_match] : 1) - (_ordLoc[b.location_match] != null ? _ordLoc[b.location_match] : 1)));
return [{ json: { scored, total: scored.length, strategy, parse_error: parseError } }];`;

// ── harness: exercise every probe path against a scripted mock https ──
(async function harness() {
  const calls = [];
  const script = {
    // host -> handler(path, method) -> { status, location } | 'timeout'
    'boards.greenhouse.io': () => ({ status: 301, location: 'https://job-boards.greenhouse.io/acme/jobs/123?error=true' }),
    'job-boards.greenhouse.io': () => ({ status: 200, location: '' }),
    'jobs.lever.co': (p) => ({ status: p.indexOf('dead') !== -1 ? 404 : 200, location: '' }),
    'www.linkedin.com': (p) => ({ status: p.indexOf('gone') !== -1 ? 404 : 200, location: '' }),
    'acme.wd5.myworkdayjobs.com': (p) => ({ status: p.indexOf('/wday/cxs/acme/Careers/job/Sr-Eng_JR999') === 0 ? 404 : 200, location: '' }),
    'nvidia.wd5.myworkdayjobs.com': (p) => ({ status: p.indexOf('/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/JR123') === 0 ? 200 : 500, location: '' }),
    'slow.example.com': () => 'timeout',
    'loop.example.com': () => ({ status: 302, location: 'https://loop.example.com/again' }),
  };
  const fakeHttps = { request: (opts, cb) => {
    calls.push(opts.host + opts.path);
    const handlers = {};
    const r = { on: (ev, fn) => { handlers[ev] = fn; return r; }, end: () => {
      const h = script[opts.host];
      const res = h ? h(opts.path, opts.method) : { status: 200, location: '' };
      if (res === 'timeout') { setImmediate(() => handlers.timeout && handlers.timeout()); return; }
      setImmediate(() => cb({ statusCode: res.status, headers: { location: res.location }, resume() {} }));
    }, destroy: () => {} };
    return r;
  } };
  const JOBS = [
    { url: 'https://boards.greenhouse.io/acme/jobs/123', title: 'gh-legacy-dead' },
    { url: 'https://jobs.lever.co/acme/dead-role', title: 'lever-dead' },
    { url: 'https://jobs.lever.co/acme/live-role', title: 'lever-live' },
    { url: 'https://www.linkedin.com/jobs/view/gone', title: 'li-dead' },
    { url: 'https://www.linkedin.com/jobs/view/here', title: 'li-live' },
    { url: 'https://jobs.ashbyhq.com/acme/uuid-123', title: 'ashby-skip' },
    { url: 'https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Pune/Sr-Eng_JR999', title: 'wd-dead' },
    { url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA/Sr-Eng_JR123', title: 'wd-live' },
    { url: 'https://slow.example.com/j/1', title: 'timeout-keep' },
    { url: 'https://loop.example.com/j/1', title: 'loop-keep' },
    { url: 'http://plain.example.com/j/1', title: 'http-keep' },
    { url: 'not a url', title: 'garbage-keep' },
  ];
  const run = (requireImpl, jobs) => new Function('$input', 'require',
    'return (async () => {\n' + VERIFY_CODE + '\n})()'
  )({ first: () => ({ json: { jobs, count: jobs.length, sources: {}, tier_counts: {} } }) }, requireImpl);

  const t0 = Date.now();
  const res = (await run(() => fakeHttps, JOBS))[0].json;
  const kept = res.jobs.map((j) => j.title);
  const expectDead = ['gh-legacy-dead', 'lever-dead', 'li-dead', 'wd-dead'];
  const expectKeep = ['lever-live', 'li-live', 'ashby-skip', 'wd-live', 'timeout-keep', 'loop-keep', 'http-keep', 'garbage-keep'];
  for (const t of expectDead) if (kept.indexOf(t) !== -1) { console.error('HARNESS FAIL: ' + t + ' should be dead'); process.exit(1); }
  for (const t of expectKeep) if (kept.indexOf(t) === -1) { console.error('HARNESS FAIL: ' + t + ' should be kept'); process.exit(1); }
  if (res.dead_removed !== 4 || res.count !== 8 || res.liveness !== 'https') {
    console.error('HARNESS FAIL: counters wrong: ' + JSON.stringify({ dead_removed: res.dead_removed, count: res.count, liveness: res.liveness })); process.exit(1);
  }
  if (!res.jobs.every((j) => j.link_checked === true)) { console.error('HARNESS FAIL: link_checked missing'); process.exit(1); }
  if (calls.some((c) => c.indexOf('jobs.ashbyhq.com') !== -1)) { console.error('HARNESS FAIL: ashby was probed'); process.exit(1); }
  if (!calls.some((c) => c === 'acme.wd5.myworkdayjobs.com/wday/cxs/acme/Careers/job/Sr-Eng_JR999')) {
    console.error('HARNESS FAIL: workday CXS path wrong (locale strip): ' + calls.filter((c) => c.indexOf('wday') !== -1).join(', ')); process.exit(1);
  }
  if (!calls.some((c) => c === 'nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/Sr-Eng_JR123')) {
    console.error('HARNESS FAIL: workday CXS path wrong (no locale)'); process.exit(1);
  }
  if (Date.now() - t0 > 9000) { console.error('HARNESS FAIL: wall clock exceeded 9s'); process.exit(1); }

  const degraded = (await run(() => { throw new Error('sandboxed'); }, JOBS))[0].json;
  if (degraded.count !== JOBS.length || degraded.liveness !== 'unavailable' || degraded.dead_removed !== 0) {
    console.error('HARNESS FAIL: degraded path: ' + JSON.stringify({ count: degraded.count, liveness: degraded.liveness })); process.exit(1);
  }

  // loc-map + sort snippets
  const locFn = new Function('_eq', LOC_NEW + '\nreturn _locMap;');
  const strict = locFn({ location_canonical: 'Pune,India', remote_preference: 'open' });
  const loose = locFn({ location_canonical: null, remote_preference: 'open' });
  const remote = locFn({ location_canonical: 'Pune,India', remote_preference: 'remote_only' });
  if (strict.unknown !== 35 || strict.mismatch !== 0 || loose.unknown !== 60 || remote.unknown !== 60) {
    console.error('HARNESS FAIL: loc map'); process.exit(1);
  }
  const scored = [
    { score100: 80, location_match: 'unknown' }, { score100: 80, location_match: 'match' },
    { score100: 90, location_match: 'mismatch' },
  ];
  const sortFn = new Function('scored', SORT_NEW.split('return [{ json: { scored, total: scored.length, strategy, parse_error: parseError } }];').join('return scored;'));
  const sortedOut = sortFn(scored);
  if (sortedOut[0].score100 !== 90 || sortedOut[1].location_match !== 'match') { console.error('HARNESS FAIL: sort'); process.exit(1); }

  console.log('HARNESS OK: per-host probes (gh/lever/li/ashby/workday/timeout/loop/http/garbage), degraded path, loc-rank verified');

  TARGETS.forEach(patch);
  console.log('S14 (liveness v2) complete.');
})();

function editCode(wf, base, nodeName, pairs) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) { console.error(`INTEGRITY FAIL ${base}: node "${nodeName}" not found`); process.exit(1); }
  for (const [oldS, newS] of pairs) {
    const parts = node.parameters.jsCode.split(oldS);
    if (parts.length !== 2) {
      if (node.parameters.jsCode.includes(newS)) { console.log(`  ${base}: ${nodeName} already patched`); continue; }
      console.error(`INTEGRITY FAIL ${base}: "${nodeName}" target found ${parts.length - 1}x (want 1): ${oldS.slice(0, 80)}`);
      process.exit(1);
    }
    node.parameters.jsCode = parts.join(newS);
  }
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Aggregate Jobs'] || !N['Experience Filter']) { console.error(`INTEGRITY FAIL ${base}: splice endpoints missing`); process.exit(1); }

  if (!N['Verify Job Links']) {
    wf.nodes.push({
      parameters: { jsCode: VERIFY_CODE },
      id: crypto.randomUUID(), name: 'Verify Job Links', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [33112, 46320], alwaysOutputData: true,
    });
  }

  // splice the single edge Aggregate Jobs -> Experience Filter
  const aggMain = wf.connections['Aggregate Jobs'].main[0];
  const efIdx = aggMain.findIndex((e) => e.node === 'Experience Filter');
  const already = aggMain.some((e) => e.node === 'Verify Job Links');
  if (efIdx === -1 && !already) { console.error(`INTEGRITY FAIL ${base}: Aggregate Jobs -> Experience Filter edge missing`); process.exit(1); }
  if (efIdx !== -1) aggMain.splice(efIdx, 1, { node: 'Verify Job Links', type: 'main', index: 0 });
  wf.connections['Verify Job Links'] = { main: [[{ node: 'Experience Filter', type: 'main', index: 0 }]] };

  editCode(wf, base, 'Experience Filter', [[EF_OLD, EF_NEW]]);
  editCode(wf, base, 'Build Telegraph Body', [[BADGE_OLD, BADGE_NEW]]);
  editCode(wf, base, 'Parse Scorer Output', [[LOC_OLD, LOC_NEW], [SORT_OLD, SORT_NEW]]);

  // integrity: every edge resolves
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source ${src} missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Verify Job Links spliced + loc-rank + badge -- ${wf.nodes.length} nodes`);
}
