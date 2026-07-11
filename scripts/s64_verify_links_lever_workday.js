/**
 * s64_verify_links_lever_workday.js -- 2 real dead-link-detection bugs found
 * from a live "AI jobs in Pune" find_jobs digest (29 jobs, user reported
 * "a shit ton... not existing"). Root-caused with real HTTP probes against
 * the actual live Workday/Lever endpoints, not guessed.
 *
 * 1. Lever: `Verify Job Links`' top-of-file comment claims "API-verify instead
 *    of status-probe where a definitive, unauthenticated endpoint exists
 *    (Lever/Greenhouse/Ashby/Workday/LinkedIn)" -- but there has never
 *    actually been a `jobs.lever.co` branch in `probe()`. Every Lever job
 *    silently falls through to the generic HEAD-chase fallback, which does
 *    NOT reliably catch a dead Lever posting (Lever's job page is a
 *    client-rendered SPA that returns 200 regardless). Confirmed live: of the
 *    8 Lever jobs in the reported digest, 2 (Veeva, Pattern) are absent from
 *    Lever's own public postings API (https://api.lever.co/v0/postings/<co>)
 *    -- i.e. genuinely gone -- yet both survived verification. Added a real
 *    branch using the exact same org-level-cache pattern already proven for
 *    Ashby (one cached fetch per company, membership-checked per job).
 *
 * 2. Workday: confirmed via a real live probe that Workday's CXS job-detail
 *    endpoint returns HTTP 403 (body: {"errorCode":"S22",...,"message":
 *    "permission denied"}) for a posting that no longer exists -- NOT 404.
 *    The existing code only checked for 404, and its own comment shows the
 *    403 case was assumed to be "tenant firewalls CXS -> inconclusive." That
 *    assumption is wrong for at least this case: the SAME tenant returned a
 *    clean 200 with real job data for a still-live posting moments later,
 *    proving 403 is Workday's per-JOB "gone" signal here, not a tenant-wide
 *    block. Now treats 403 as dead ONLY when the body carries this specific
 *    Workday not-found signature (errorCode S22 or a "permission denied"
 *    message) -- any other 403 shape (a genuine WAF block, auth issue, etc.)
 *    still falls through to the existing inconclusive/keep default, so this
 *    doesn't widen the blast radius beyond the confirmed case.
 *
 * No node count change. Run: inside the n8n container with the repo staged
 * under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1a. Lever org-postings cache (mirrors ashbyOrgCache exactly) ═══
const LEVER_CACHE_OLD = "const ashbyOrgCache = new Map(); // org (decoded) -> Promise<Map(id -> job) | null> (null = API failed/unparseable -> inconclusive)";
const LEVER_CACHE_NEW =
  "const ashbyOrgCache = new Map(); // org (decoded) -> Promise<Map(id -> job) | null> (null = API failed/unparseable -> inconclusive)\n" +
  "  // s60: same caching idiom for Lever -- one org-level fetch shared across every\n" +
  "  // job from that company in this batch, not one call per job.\n" +
  "  const leverOrgCache = new Map();\n" +
  "  function leverOrgPostings(company) {\n" +
  "    if (!leverOrgCache.has(company)) {\n" +
  "      leverOrgCache.set(company, (async () => {\n" +
  "        const res = await reqBody({ proto: 'https', host: 'api.lever.co', path: '/v0/postings/' + encodeURIComponent(company) + '?mode=json' }, 'GET', 'application/json', 26214400);\n" +
  "        let postingsMap = null;\n" +
  "        if (res.status === 200) {\n" +
  "          try { const data = JSON.parse(res.body); postingsMap = new Map((Array.isArray(data) ? data : []).map((p) => [p.id, p])); } catch (e) { postingsMap = null; }\n" +
  "        }\n" +
  "        return postingsMap;\n" +
  "      })());\n" +
  "    }\n" +
  "    return leverOrgCache.get(company);\n" +
  "  }";

// ═══ 1b. Lever probe branch, inserted right after Ashby's ═══
const ASHBY_BLOCK_OLD =
  "    if (h === 'jobs.ashbyhq.com') {\n" +
  "      const m = u.path.match(/^\\/([^\\/]+)\\/([0-9a-fA-F-]{20,})/);\n" +
  "      if (!m) return { verdict: 'keep', location: null };\n" +
  "      const org = decodeURIComponent(m[1]);\n" +
  "      const jobsMap = await ashbyOrgJobs(org);\n" +
  "      if (!jobsMap) return { verdict: 'keep', location: null }; // org API failed -> inconclusive\n" +
  "      const found = jobsMap.get(m[2]);\n" +
  "      if (!found) return { verdict: 'dead', location: null };\n" +
  "      return { verdict: 'keep', location: ashbyLocationString(found) };\n" +
  "    }";
const ASHBY_BLOCK_NEW =
  ASHBY_BLOCK_OLD +
  "\n\n" +
  "    if (h === 'jobs.lever.co') {\n" +
  "      // s60: was completely unverified despite this file's own header comment\n" +
  "      // claiming Lever was covered -- fell through to the generic HEAD-chase,\n" +
  "      // which doesn't catch a dead Lever posting (SPA page, still 200s).\n" +
  "      const m = u.path.match(/^\\/([^\\/]+)\\/([0-9a-fA-F-]{20,})/);\n" +
  "      if (!m) return { verdict: 'keep', location: null };\n" +
  "      const company = decodeURIComponent(m[1]);\n" +
  "      const postingsMap = await leverOrgPostings(company);\n" +
  "      if (!postingsMap) return { verdict: 'keep', location: null }; // API failed -> inconclusive\n" +
  "      const found = postingsMap.get(m[2]);\n" +
  "      if (!found) return { verdict: 'dead', location: null };\n" +
  "      const loc = (found.categories && found.categories.location) || null;\n" +
  "      return { verdict: 'keep', location: loc };\n" +
  "    }";

// ═══ 2. Workday: recognize the real 403 "gone" signature ═══
const WORKDAY_403_OLD =
  "      const res = await reqBody(cxs, 'GET', 'application/json');\n" +
  "      if (res.status === 404) return { verdict: 'dead', location: null };\n" +
  "      if (res.status === 200) {";
const WORKDAY_403_NEW =
  "      const res = await reqBody(cxs, 'GET', 'application/json');\n" +
  "      if (res.status === 404) return { verdict: 'dead', location: null };\n" +
  "      if (res.status === 403) {\n" +
  "        // s60: confirmed via a real live probe that Workday's CXS API returns\n" +
  "        // 403 (not 404) for a posting that no longer exists -- errorCode S22,\n" +
  "        // \"permission denied\" -- while the SAME tenant returns a clean 200 for\n" +
  "        // a still-live posting moments later. This is a per-job signal, not the\n" +
  "        // tenant-wide firewall block the old 403->keep comment assumed. Only\n" +
  "        // treat it as dead when this specific signature is present, so a real\n" +
  "        // network-level 403 (WAF, auth) still falls through to inconclusive.\n" +
  "        try {\n" +
  "          const errBody = JSON.parse(res.body);\n" +
  "          if (errBody && (errBody.errorCode === 'S22' || /permission denied/i.test(String(errBody.message || '')))) return { verdict: 'dead', location: null };\n" +
  "        } catch (e) {}\n" +
  "      }\n" +
  "      if (res.status === 200) {";

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

  if (!N['Verify Job Links']) { console.error(`INTEGRITY FAIL ${base}: node "Verify Job Links" not found`); process.exit(1); }
  if (N['Verify Job Links'].parameters.jsCode.includes('leverOrgPostings')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', LEVER_CACHE_OLD, LEVER_CACHE_NEW, 'lever cache decl', base);
  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', ASHBY_BLOCK_OLD, ASHBY_BLOCK_NEW, 'lever probe branch', base);
  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', WORKDAY_403_OLD, WORKDAY_403_NEW, 'workday 403 signature', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Lever verification branch + Workday 403 fix applied -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(async function harness() {
  // 1. Lever: dead posting (not in the cached org map) -> dead; live posting -> keep + location; API failure -> inconclusive.
  {
    // Realistic Lever-shaped ids: 36-char hex+dash UUIDs, matching the real
    // ASHBY_BLOCK_NEW regex's {20,} threshold exactly -- not a shortened stand-in.
    const LIVE_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
    const DEAD_ID = 'bbbbbbbb-5555-6666-7777-888888888888';
    const reqBody = async (u) => {
      if (u.host !== 'api.lever.co') throw new Error('unexpected host ' + u.host);
      if (u.path.includes('failco')) return { status: 500, body: '' };
      return { status: 200, body: JSON.stringify([{ id: LIVE_ID, categories: { location: 'Remote' } }]) };
    };
    const body = LEVER_CACHE_NEW.split('\n').slice(2).join('\n') + '\n' +
      "async function testBranch(url) {\n" +
      "  const m = url.match(/^\\/([^\\/]+)\\/([0-9a-fA-F-]{20,})/);\n" +
      "  const company = m[1];\n" +
      "  const postingsMap = await leverOrgPostings(company);\n" +
      "  if (!postingsMap) return { verdict: 'keep', location: null };\n" +
      "  const found = postingsMap.get(m[2]);\n" +
      "  if (!found) return { verdict: 'dead', location: null };\n" +
      "  return { verdict: 'keep', location: (found.categories && found.categories.location) || null };\n" +
      "}\n" +
      "return testBranch(url);";
    const fn = new Function('reqBody', 'url', body);
    const dead = await fn(reqBody, '/goodco/' + DEAD_ID);
    if (dead.verdict !== 'dead') { console.error('HARNESS FAIL: posting absent from Lever API should be dead', dead); process.exit(1); }
    const live = await fn(reqBody, '/goodco/' + LIVE_ID);
    if (live.verdict !== 'keep' || live.location !== 'Remote') { console.error('HARNESS FAIL: posting present in Lever API should be keep+location', live); process.exit(1); }
    const failed = await fn(reqBody, '/failco/' + DEAD_ID);
    if (failed.verdict !== 'keep') { console.error('HARNESS FAIL: API failure should be inconclusive/keep, not dead', failed); process.exit(1); }
  }
  console.log('HARNESS OK: Lever branch -- dead posting (absent from API) correctly flagged dead, live posting kept with location, API failure stays inconclusive');

  // 2. Workday: 404 -> dead (unchanged); 403 + S22/permission-denied -> dead (new); 403 other shape -> keep (unchanged); 200 -> keep (unchanged).
  {
    const run = (status, body) => {
      // Lines 1-14 of WORKDAY_403_NEW: the 404 check through the closing "}"
      // of the 403 block, deliberately EXCLUDING the trailing, unclosed
      // "if (res.status === 200) {" (line 15) -- that branch is stubbed below
      // instead, so this harness never depends on brace-matching a slice.
      const bodySrc = WORKDAY_403_NEW.split('\n').slice(1, 15).join('\n');
      const fn = new Function('res', bodySrc + '\nif (res.status === 200) return { verdict: "keep-200" };\nreturn null;');
      return fn({ status, body });
    };
    const r404 = run(404, '');
    if (!r404 || r404.verdict !== 'dead') { console.error('HARNESS FAIL: 404 must still be dead', r404); process.exit(1); }
    const r403gone = run(403, JSON.stringify({ errorCode: 'S22', message: 'permission denied' }));
    if (!r403gone || r403gone.verdict !== 'dead') { console.error('HARNESS FAIL: 403 with S22/permission-denied signature must be dead', r403gone); process.exit(1); }
    const r403other = run(403, JSON.stringify({ errorCode: 'SOMETHING_ELSE', message: 'rate limited' }));
    if (r403other) { console.error('HARNESS FAIL: an unrelated 403 shape must NOT be classified dead here (falls through to the existing keep default)', r403other); process.exit(1); }
    const r200 = run(200, '');
    if (!r200 || r200.verdict !== 'keep-200') { console.error('HARNESS FAIL: 200 path must be unaffected', r200); process.exit(1); }
  }
  console.log('HARNESS OK: Workday 403 fix -- 404 still dead, the confirmed S22/permission-denied 403 signature is now dead, any other 403 shape and the 200 path are unchanged');
})().then(() => {
  TARGETS.forEach(patch);
  console.log('S60 (Verify Job Links: real Lever verification branch + Workday 403 dead-signal fix) complete.');
}).catch((e) => { console.error('HARNESS FAIL: unexpected error', e); process.exit(1); });
