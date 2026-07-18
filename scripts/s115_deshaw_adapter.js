/**
 * s115_deshaw_adapter.js -- new self-fetch adapter for D. E. Shaw's own
 * careers site (deshaw.com/careers). Unlike Meta/Microsoft (investigated
 * the same session, both genuinely hard-blocked or JS-only), D.E. Shaw
 * turned out to be trivially reachable: a server-rendered Next.js page
 * that embeds the ENTIRE job dataset as clean JSON in a `__NEXT_DATA__`
 * script tag on first load -- no bot-wall, no JS execution needed, same
 * complexity tier as the Google adapter (s111).
 *
 * LIVE-VERIFIED THIS SESSION (fixtures saved to fixtures/deshaw_*.html):
 * - `www.deshaw.com/careers` (plain GET, no query params needed unlike
 *   Google) returns real, rich job data at
 *   `props.pageProps.regularJobs` (78 jobs) and `props.pageProps.internships`
 *   (14 jobs) -- each entry's `.data` has `id`, `displayName` (title),
 *   `jobUrl` (Title-Case-Hyphenated slug -- the REAL url is this
 *   lowercased, confirmed against a real captured href), `jobDescription.
 *   websiteDescription` (real JD text), and `jobMetadata.jobLocations[].name`
 *   (real location, e.g. "New York"). `internalJobs` (81) is INTENTIONALLY
 *   excluded -- internal-transfer-only postings, not real external openings.
 * - Dead-posting signal, confirmed against a real vs a bogus job id: the
 *   individual job page (`deshaw.com/careers/{slug}`) always 200s (SPA
 *   route) but its own __NEXT_DATA__ differs cleanly -- a bogus id's
 *   pageProps has `redirectToCareers` (no `jobData`), a real one has
 *   `pageProps.jobData` populated. No ambiguous middle case observed.
 * - The __NEXT_DATA__ blob is large (~1.47MB on its own, spanning byte
 *   375K-1.84MB of a 1.84MB page) -- past the shared httpFetch helper's
 *   default 500KB cap (already extended with an optional capOverride for
 *   Google in s111); D.E. Shaw's calls pass 2,000,000.
 *
 * v1 scope, explicit and disclosed: no separate detail-page fetch for
 * richer JD text -- the listing page's `jobDescription.websiteDescription`
 * is already the real, full description (confirmed non-truncated), so
 * there's nothing a second fetch would add.
 *
 * +0 nodes (self-fetch dispatch, same pattern as workday/apple/eightfold/
 * avature/google -- no new poller nodes). Seeds D.E. Shaw directly as a
 * single hardcoded integration (like Amazon/Apple/Google/Oracle) since
 * there's exactly one D.E. Shaw, not a multi-tenant platform.
 *
 * Run: harness first (real parser against the real captured fixtures --
 * both the listing page and the dead/alive job-detail pair), then inside
 * the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_TARGETS = [path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json')];
const MASTER_TARGETS = [path.join(ROOT, 'workflows', 'CareerForge_Master_local.json')];
const FIXTURE_LISTING = path.join(ROOT, 'fixtures', 'deshaw_careers.html');
const FIXTURE_BOGUS = path.join(ROOT, 'fixtures', 'deshaw_job_bogus.html');
const FIXTURE_REAL = path.join(ROOT, 'fixtures', 'deshaw_job_real.html');

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ══════════════════════ 1. Build Requests (poller) ══════════════════════
const BR_IMPL_OLD = "IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature', 'google'];";
const BR_IMPL_NEW = "IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw'];";
const BR_URL_OLD = "google:     'https://www.google.com/about/careers/applications/jobs/results',";
const BR_URL_NEW = "google:     'https://www.google.com/about/careers/applications/jobs/results',\n  deshaw:     'https://www.deshaw.com/careers',";

// ══════════════════════ 2. Parse Jobs (poller) ══════════════════════
const PJ_CONTINUE_OLD = "if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature' || t === 'google') continue; // self-fetch pass below, Fetch ATS's response for these is discarded";
const PJ_CONTINUE_NEW = "if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature' || t === 'google' || t === 'deshaw') continue; // self-fetch pass below, Fetch ATS's response for these is discarded";

const PJ_FILTER_OLD = "const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature' || c.ats_type === 'google');";
const PJ_FILTER_NEW = "const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature' || c.ats_type === 'google' || c.ats_type === 'deshaw');";

const FETCH_DESHAW_SRC = `
async function fetchDEShaw(company) {
  // s115: plain GET, no search term needed (unlike Google) -- the whole
  // dataset ships on first load. __NEXT_DATA__ blob is large (~1.47MB),
  // needs the raised capOverride.
  const res = await httpFetch('www.deshaw.com', '/careers', 'GET', { Accept: 'text/html' }, null, 2000000);
  if (res.status !== 200 || !res.body) return { rows: [], ok: false };
  const m = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/);
  if (!m) return { rows: [], ok: false };
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { return { rows: [], ok: false }; }
  const pp = (data.props && data.props.pageProps) || {};
  // internalJobs deliberately excluded -- internal-transfer-only postings.
  const pools = [].concat(pp.regularJobs || [], pp.internships || []);
  const rows = [];
  for (const entry of pools) {
    const j = entry.data || entry;
    if (!j || !j.id) continue;
    const jobUrl = String(j.jobUrl || '').toLowerCase();
    if (!jobUrl) continue;
    const locs = ((j.jobMetadata && j.jobMetadata.jobLocations) || []).map((l) => l.name).filter(Boolean);
    rows.push({
      company_id: company.company_id, board: company.board,
      external_id: String(j.id), title: j.displayName || '',
      jd_text: strip((j.jobDescription && j.jobDescription.websiteDescription) || ''),
      location: locs.join(' | '),
      remote: isRemote(locs.join(' | ') + ' ' + (j.displayName || '')),
      apply_url: 'https://www.deshaw.com/careers/' + jobUrl,
      posted_at: null,
    });
  }
  return { rows, ok: true };
}
`.trim();

const PJ_FETCHONE_OLD = "if (company.ats_type === 'google') return fetchGoogle(company);\n      return { rows: [], ok: false };\n    }";
const PJ_FETCHONE_NEW = "if (company.ats_type === 'google') return fetchGoogle(company);\n      if (company.ats_type === 'deshaw') return fetchDEShaw(company);\n      return { rows: [], ok: false };\n    }";

// ══════════════════════ 3. Tick Bookkeeping (poller) ══════════════════════
const TB_OLD = "SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold', 'avature', 'google']);";
const TB_NEW = "SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw']);";

// ══════════════════════ 4. Verify Job Links (master) ══════════════════════
const VJL_ANCHOR_OLD = "    if (h === 'www.linkedin.com' || h === 'linkedin.com') {";
const VJL_ANCHOR_NEW = `    if (h === 'www.deshaw.com' && u.path.indexOf('/careers/') === 0) {
      // s115: D.E. Shaw's job-detail route always 200s (Next.js SPA route,
      // confirmed live) even for a bogus id. Real signal: the page's own
      // __NEXT_DATA__ blob -- a bogus id's pageProps has redirectToCareers
      // (no jobData), a real one has pageProps.jobData populated. Confirmed
      // against a real vs bogus id fixture, no ambiguous middle case seen.
      const res = await reqBody(u, 'GET', 'text/html', 2000000);
      const m = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/);
      if (!m) return { verdict: 'keep', location: null };
      try {
        const data = JSON.parse(m[1]);
        const pp = (data.props && data.props.pageProps) || {};
        if (pp.redirectToCareers && !pp.jobData) return { verdict: 'dead', location: null };
      } catch (e) {}
      return { verdict: 'keep', location: null };
    }

    if (h === 'www.linkedin.com' || h === 'linkedin.com') {`;

// ══════════════════════ 5. classifyUrlTier x3 normalize nodes (master) ══════════════════════
const TIER_OLD = "if (/google\\.com\\/about\\/careers\\/applications\\/jobs\\/results/.test(u)) return { tier: 1, label: 'ats:google' };";
const TIER_NEW = "if (/google\\.com\\/about\\/careers\\/applications\\/jobs\\/results/.test(u)) return { tier: 1, label: 'ats:google' };\n  if (/deshaw\\.com\\/careers/.test(u)) return { tier: 1, label: 'ats:deshaw' };";
const NORMALIZE_NODES = ['Normalize You.com results', 'Normalize Serper results', 'Normalize Firecrawl Results'];

function patchPoller(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Build Requests', 'Parse Jobs', 'Tick Bookkeeping']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Jobs'].parameters.jsCode.includes('fetchDEShaw')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Requests'].parameters, 'jsCode', BR_IMPL_OLD, BR_IMPL_NEW, 'IMPLEMENTED list', base);
  replaceOnce(N['Build Requests'].parameters, 'jsCode', BR_URL_OLD, BR_URL_NEW, 'mkUrl deshaw decoy', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_CONTINUE_OLD, PJ_CONTINUE_NEW, 'sync-loop self-fetch skip', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_FILTER_OLD, PJ_FILTER_NEW, 'selfFetchCompanies filter', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_FETCHONE_OLD, PJ_FETCHONE_NEW, 'fetchOne dispatch', base);
  // insert fetchDEShaw function body right before the fetchOne dispatcher's anchor line
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', "async function fetchOne(company) {", FETCH_DESHAW_SRC + "\n\n    async function fetchOne(company) {", 'fetchDEShaw function insertion', base);
  replaceOnce(N['Tick Bookkeeping'].parameters, 'jsCode', TB_OLD, TB_NEW, 'SELF_FETCH_TYPES', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: D.E. Shaw adapter wired -- ${wf.nodes.length} nodes`);
}

function patchMaster(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Verify Job Links', ...NORMALIZE_NODES]) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Verify Job Links'].parameters.jsCode.includes('ats:deshaw')) { console.log(`  ${base}: already patched (Verify Job Links)`); }
  else {
    replaceOnce(N['Verify Job Links'].parameters, 'jsCode', VJL_ANCHOR_OLD, VJL_ANCHOR_NEW, 'deshaw dead-check branch', base);
  }
  for (const name of NORMALIZE_NODES) {
    if (N[name].parameters.jsCode.includes('ats:deshaw')) { console.log(`  ${base}: already patched (${name})`); continue; }
    replaceOnce(N[name].parameters, 'jsCode', TIER_OLD, TIER_NEW, `classifyUrlTier deshaw (${name})`, base);
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Verify Job Links + 3 normalize nodes wired for deshaw -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (!fs.existsSync(FIXTURE_LISTING) || !fs.existsSync(FIXTURE_BOGUS) || !fs.existsSync(FIXTURE_REAL)) {
    console.error('HARNESS FAIL: fixtures missing, run the curl captures first'); process.exit(1);
  }
  const listingBody = fs.readFileSync(FIXTURE_LISTING, 'utf8');
  const bogusBody = fs.readFileSync(FIXTURE_BOGUS, 'utf8');
  const realBody = fs.readFileSync(FIXTURE_REAL, 'utf8');

  const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const isRemote = (s) => /remote/i.test(String(s || ''));

  // 1. fetchDEShaw against the real listing fixture
  let callCount = 0;
  async function httpFetch(host, p, method, headers, body, capOverride) {
    callCount++;
    return { status: 200, body: listingBody };
  }
  const factory = new Function('httpFetch', 'strip', 'isRemote', `return (${FETCH_DESHAW_SRC});`);
  const fetchDEShaw = factory(httpFetch, strip, isRemote);

  return fetchDEShaw({ company_id: 999, board: 'deshaw:deshaw' }).then((result) => {
    const { rows, ok } = result;
    if (!ok) { console.error('HARNESS FAIL: fetchDEShaw reported ok:false against a real fixture'); process.exit(1); }
    if (rows.length < 80) { console.error(`HARNESS FAIL: expected >=80 jobs (78 regular + 14 internships, minus any malformed), got ${rows.length}`); process.exit(1); }
    for (const r of rows) {
      if (!/^\d+$/.test(r.external_id)) { console.error('HARNESS FAIL: non-numeric external_id', r.external_id); process.exit(1); }
      if (!r.title) { console.error('HARNESS FAIL: empty title', JSON.stringify(r)); process.exit(1); }
      if (!r.apply_url.startsWith('https://www.deshaw.com/careers/')) { console.error('HARNESS FAIL: malformed apply_url', r.apply_url); process.exit(1); }
      if (/[A-Z]/.test(r.apply_url.slice('https://www.deshaw.com/careers/'.length))) { console.error('HARNESS FAIL: apply_url slug not lowercased', r.apply_url); process.exit(1); }
    }
    const ids = new Set(rows.map((r) => r.external_id));
    if (ids.size !== rows.length) { console.error('HARNESS FAIL: duplicate external_ids'); process.exit(1); }
    const withLoc = rows.filter((r) => r.location).length;
    if (withLoc < rows.length * 0.8) { console.error(`HARNESS FAIL: too many jobs missing location (${withLoc}/${rows.length})`); process.exit(1); }

    // 2. dead-posting detection against the real bogus vs real job fixtures
    function checkDead(body) {
      const m = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) return 'keep';
      const data = JSON.parse(m[1]);
      const pp = (data.props && data.props.pageProps) || {};
      if (pp.redirectToCareers && !pp.jobData) return 'dead';
      return 'keep';
    }
    if (checkDead(bogusBody) !== 'dead') { console.error('HARNESS FAIL: bogus job fixture should verdict dead'); process.exit(1); }
    if (checkDead(realBody) !== 'keep') { console.error('HARNESS FAIL: real job fixture should verdict keep'); process.exit(1); }

    console.log(`HARNESS OK: fetchDEShaw extracted ${rows.length} real jobs (regular + internships) from the live fixture, all numeric ids, real titles, lowercased apply_urls, ${withLoc}/${rows.length} with real locations, zero duplicates. Dead-posting detection correctly verdicts the real bogus-vs-real job fixture pair.`);

    POLLER_TARGETS.forEach(patchPoller);
    MASTER_TARGETS.forEach(patchMaster);
    console.log('S115 (D.E. Shaw adapter) script complete.');
  });
})();
