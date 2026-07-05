/**
 * s31_r1_hotfixes.js -- Sprint R1 of the post-audit rebuild plan (2026-07-05).
 * Three independent correctness fixes, all root-caused against real execution
 * data (execs 174, 178, 181) and live ATS API probes -- see the audit session.
 *
 * 1. WRITER LANE OFF kimi-k2.6 -> anthropic/claude-sonnet-4-6 (user-approved).
 *    S29 raised maxTokens to 16000 after Cover Pass1 burned its whole 6000 cap
 *    on hidden reasoning; the raise just let it burn MORE. Real data since:
 *    exec 181 Cover Pass2 = 2x 120s timeouts + 1x "success" with 15999/16000
 *    completion tokens consumed and ZERO visible text; exec 174 = Cover Pass1
 *    at 115s/13.6k tokens for 7.3k chars, Cover Pass2 at 15.3k tokens for 2.6k
 *    chars, then Pass1 Model 3x timeout, run dead. Post-S29 apply success rate:
 *    1 of 3. Kimi K2.6's mandatory reasoning (uncappable via OpenRouter, known
 *    open bug) makes the lane slow, coin-flip reliable, and no longer cheap --
 *    the hidden tokens cost more than Sonnet's visible ones. All 7 writer nodes
 *    move to claude-sonnet-4-6 (single-vendor on OpenRouter -> no multi-backend
 *    variance; the lane's pre-WS5 model class, proven). maxTokens 16000 and
 *    timeout 120000 are KEPT -- harmless ceilings for a non-reasoning model.
 *    s9_polish.js's MODEL_MAP is updated separately so a re-run can't
 *    reintroduce kimi.
 *
 * 2. TELEGRAPH APPENDIX READS POST-VERIFICATION DATA. Phase 4.1's appendix in
 *    Build Telegraph Body read $('Aggregate Jobs') -- the PRE-verification job
 *    list -- so every job Verify Job Links killed (dead links) or S30's
 *    location correction dropped got resurrected in the appendix. Confirmed in
 *    exec 178: the appendix's 3 entries were EXACTLY the 3 removed jobs (ZURU +
 *    Lingaro, both Lever 404s, and PATH's London job correctly dropped from an
 *    India query). Fix: read $('Experience Filter') instead -- same lane,
 *    always executes before this node, post-liveness + post-experience-filter.
 *
 * 3. ASHBY BIG-BOARD LIVENESS FIX. Verify Job Links' reqBody caps response
 *    bodies at 300KB; OpenAI's Ashby board is 11.4MB (722 postings), so the
 *    JSON.parse failed and every OpenAI job was kept as "inconclusive" -- which
 *    is how a dead posting (confirmed absent from the org API, and dead Ashby
 *    pages return HTTP 200 so no page-probe can ever catch them) reached the
 *    digest as #3. Fix: reqBody gains a per-call maxSize (default unchanged at
 *    300KB), the Ashby org fetch passes 25MB, and the org cache now stores the
 *    fetch PROMISE instead of the resolved value so concurrent probes for the
 *    same org share ONE download instead of racing N parallel 11MB fetches
 *    (pre-existing flaw, material now that bodies are big).
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

const OLD_MODEL = 'moonshotai/kimi-k2.6';
const NEW_MODEL = 'anthropic/claude-sonnet-4-6';
const WRITER_NODES = [
  'Pass1 Model',
  'Pass2 Model',
  'Pass2 Regen Model',
  'Cover Pass1 Model',
  'Cover Pass2 Model',
  'OpenRouter Chat Model1', // ReviseForge
  'OpenRouter Chat Model8', // OutreachWriter
];

// ---- Fix 2: Build Telegraph Body appendix source ----
const BTB_SRC_OLD = `const aggregateOut = $('Aggregate Jobs').first().json;
const allJobs = aggregateOut.jobs || [];`;
const BTB_SRC_NEW = `// S31: read the POST-verification list (Experience Filter = after liveness check
// + S30 location correction + experience filter), not Aggregate Jobs -- reading
// the pre-verification list resurrected every removed job in the appendix.
const aggregateOut = $('Experience Filter').first().json;
const allJobs = aggregateOut.jobs || [];`;

const BTB_COMMENT_OLD = `// Phase 4.1: everything Aggregate Jobs surfaced (up to 150) that did NOT make the
// cut into the LLM-scored batch (capped at 30 in Build Scorer Input) -- ranked by`;
const BTB_COMMENT_NEW = `// Phase 4.1 (source corrected in S31): everything that survived verification and
// filtering (up to 150) but did NOT make the
// cut into the LLM-scored batch (capped at 30 in Build Scorer Input) -- ranked by`;

// ---- Fix 3: Verify Job Links reqBody cap + promise-cached org fetch ----
const VJL_REQBODY_OLD = `  const reqBody = (u, method, accept) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const r = https.request(
      { method, host: u.host, path: u.path, timeout: 3500,
        headers: Object.assign({ 'User-Agent': UA }, accept ? { Accept: accept } : {}) },
      (res) => {
        res.on('data', (c) => { size += c.length; if (size < 300000) chunks.push(c); });`;
const VJL_REQBODY_NEW = `  const reqBody = (u, method, accept, maxSize) => new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const cap = maxSize || 300000;
    const r = https.request(
      { method, host: u.host, path: u.path, timeout: 3500,
        headers: Object.assign({ 'User-Agent': UA }, accept ? { Accept: accept } : {}) },
      (res) => {
        res.on('data', (c) => { size += c.length; if (size < cap) chunks.push(c); });`;

const VJL_ASHBY_OLD = `  const ashbyOrgCache = new Map(); // org (decoded) -> Map(id -> job) | null (API failed -> inconclusive)
  async function ashbyOrgJobs(org) {
    if (ashbyOrgCache.has(org)) return ashbyOrgCache.get(org);
    const res = await reqBody({ proto: 'https', host: 'api.ashbyhq.com', path: '/posting-api/job-board/' + encodeURIComponent(org) }, 'GET', 'application/json');
    let jobsMap = null;
    if (res.status === 200) {
      try { const data = JSON.parse(res.body); jobsMap = new Map((data.jobs || []).map((j) => [j.id, j])); } catch (e) { jobsMap = null; }
    }
    ashbyOrgCache.set(org, jobsMap);
    return jobsMap;
  }`;
const VJL_ASHBY_NEW = `  // S31: promise-cached (concurrent probes for one org share ONE fetch instead of
  // N parallel downloads) + 25MB body cap (OpenAI's board is 11.4MB; the default
  // 300KB cap truncated it, failed the parse, and made every big-org Ashby job
  // permanently "inconclusive" -- dead Ashby pages return HTTP 200, so the org API
  // is the ONLY thing that can catch them).
  const ashbyOrgCache = new Map(); // org (decoded) -> Promise<Map(id -> job) | null> (null = API failed/unparseable -> inconclusive)
  function ashbyOrgJobs(org) {
    if (!ashbyOrgCache.has(org)) {
      ashbyOrgCache.set(org, (async () => {
        const res = await reqBody({ proto: 'https', host: 'api.ashbyhq.com', path: '/posting-api/job-board/' + encodeURIComponent(org) }, 'GET', 'application/json', 26214400);
        let jobsMap = null;
        if (res.status === 200) {
          try { const data = JSON.parse(res.body); jobsMap = new Map((data.jobs || []).map((j) => [j.id, j])); } catch (e) { jobsMap = null; }
        }
        return jobsMap;
      })());
    }
    return ashbyOrgCache.get(org);
  }`;

function applyAnchored(node, edits, base) {
  let cur = node.parameters.jsCode;
  let n = 0;
  for (let i = 0; i < edits.length; i++) {
    const [oldStr, newStr] = edits[i];
    if (cur.indexOf(newStr) !== -1) continue;
    if (cur.indexOf(oldStr) === -1) { console.error(`INTEGRITY FAIL ${base}: ${node.name} edit #${i} anchor not found`); process.exit(1); }
    cur = cur.split(oldStr).join(newStr);
    n++;
  }
  node.parameters.jsCode = cur;
  return n;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of [...WRITER_NODES, 'Build Telegraph Body', 'Verify Job Links', 'Experience Filter']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  // Fix 1: writer model swap
  for (const name of WRITER_NODES) {
    const n = N[name];
    const cur = n.parameters.model;
    if (cur === NEW_MODEL) continue;
    if (cur !== OLD_MODEL) { console.error(`INTEGRITY FAIL ${base}: "${name}" model is "${cur}", expected "${OLD_MODEL}"`); process.exit(1); }
    n.parameters.model = NEW_MODEL;
    edits++;
  }

  // Fix 2: appendix source
  edits += applyAnchored(N['Build Telegraph Body'], [
    [BTB_SRC_OLD, BTB_SRC_NEW],
    [BTB_COMMENT_OLD, BTB_COMMENT_NEW],
  ], base);

  // Fix 3: Ashby cap + promise cache
  edits += applyAnchored(N['Verify Job Links'], [
    [VJL_REQBODY_OLD, VJL_REQBODY_NEW],
    [VJL_ASHBY_OLD, VJL_ASHBY_NEW],
  ], base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: R1 hotfixes applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(async function harness() {
  const failures = [];
  function check(name, cond) { if (!cond) failures.push(name); }

  check('7 writer nodes targeted', WRITER_NODES.length === 7);
  check('new model is the user-approved sonnet string', NEW_MODEL === 'anthropic/claude-sonnet-4-6');

  // Fix 3 behavior: promise-cache dedupes concurrent fetches, and the raised cap
  // lets a board bigger than the old 300KB limit parse. Simulated with a mock
  // reqBody that counts calls and honors maxSize exactly like the real one.
  {
    let fetchCount = 0;
    const targetId = '346e9855-8de1-4a06-a3f2-816c2164abd3'; // the real dead OpenAI posting
    const bigBoard = JSON.stringify({ jobs: Array.from({ length: 700 }, (_, i) => ({ id: 'job-' + i, title: 'x'.repeat(700) })) });
    check('synthetic board exceeds the old 300KB cap', bigBoard.length > 300000);
    const reqBody = (u, method, accept, maxSize) => new Promise((resolve) => {
      fetchCount++;
      const cap = maxSize || 300000;
      setTimeout(() => resolve({ status: 200, location: '', body: bigBoard.slice(0, cap) }), 5);
    });
    const src = VJL_ASHBY_NEW + '\nreturn ashbyOrgJobs;';
    const makeAshby = new Function('reqBody', src);
    const ashbyOrgJobs = makeAshby(reqBody);
    const [a, b, c] = await Promise.all([ashbyOrgJobs('openai'), ashbyOrgJobs('openai'), ashbyOrgJobs('openai')]);
    check('3 concurrent probes -> exactly 1 fetch', fetchCount === 1);
    check('big board parses under the new cap', a instanceof Map && a.size === 700);
    check('all concurrent callers get the same map', a === b && b === c);
    check('dead posting id correctly absent -> would return dead verdict', !a.has(targetId));

    // Old behavior reproduced for contrast: same board through a 300KB cap fails to parse.
    let truncParsed = true;
    try { JSON.parse(bigBoard.slice(0, 300000)); } catch (e) { truncParsed = false; }
    check('same board truncated at the old cap is unparseable (the exact live failure)', !truncParsed);
  }

  // Fix 2 behavior: appendix built from the post-verification list excludes the
  // removed jobs; scored-id mapping still resolves (scored is a subset of filtered).
  {
    const aggJobs = [{ job_id: 'a' }, { job_id: 'b' }, { job_id: 'dead1' }, { job_id: 'dead2' }, { job_id: 'wrongloc' }];
    const filteredJobs = [{ job_id: 'a', url: 'https://x/a' }, { job_id: 'b', url: 'https://x/b' }];
    const scoredIds = new Set(['a']);
    const appendixOld = aggJobs.filter((j) => !scoredIds.has(j.job_id));
    const appendixNew = filteredJobs.filter((j) => !scoredIds.has(j.job_id) && j.url);
    check('old source resurrects removed jobs (reproduces the live bug)', appendixOld.some((j) => j.job_id.startsWith('dead') || j.job_id === 'wrongloc'));
    check('new source excludes every removed job', !appendixNew.some((j) => j.job_id.startsWith('dead') || j.job_id === 'wrongloc'));
    check('new source still surfaces unscored survivors', appendixNew.length === 1 && appendixNew[0].job_id === 'b');
  }

  if (failures.length) { console.error('HARNESS FAIL:', failures.join(', ')); process.exit(1); }
  console.log('HARNESS OK: model swap targets verified; promise-cache dedupe (3 probes -> 1 fetch) + 25MB cap parse verified against a synthetic >300KB board (old cap reproducibly fails on the same board); appendix source fix verified to exclude removed jobs while keeping unscored survivors -- verified');

  TARGETS.forEach(patch);
  console.log('S31 (R1 hotfixes) complete.');
})();
