/**
 * s111_google_adapter.js -- new self-fetch adapter for Google's own careers
 * site, following the Avature precedent (s69/s73) exactly: no public JSON
 * API, HTML scraping of a real SSR page, dead-posting signal determined
 * empirically before writing the branch, not assumed.
 *
 * LIVE-VERIFIED THIS SESSION (curl, real fixtures saved to fixtures/):
 * - `www.google.com/about/careers/applications/jobs/results?q=<term>&page=N`
 *   server-renders real job cards -- BUT a bare `?page=N` with no `q=` search
 *   term returns an EMPTY result set (confirmed: fixtures/google_careers_page1.html,
 *   0 job cards). A search term is mandatory. Fetches 3 broad terms
 *   ('software engineer', 'machine learning', 'data scientist') -- confirmed
 *   near-zero overlap between terms (1/20 shared ids between the first two),
 *   each with bounded pagination (20 jobs/page, confirmed real pagination --
 *   3 consecutive pages returned 3 disjoint sets of ids). Downstream TITLE_RX
 *   does the real relevance filtering, same as every other adapter -- these
 *   terms only need to surface a good candidate pool.
 * - Real card markup (`<li class="lLd3Je" ssk='...ID'>...<h3 class="QJPWVe">
 *   TITLE</h3>...<span class="r0wTof ">LOCATION</span>...href="jobs/results/
 *   ID-slug"`) verified structurally against 20/20 real cards -- clean,
 *   reliable extraction, not a fragile fallback regex.
 * - Card content sits ~958KB-1.09MB into the page -- past the shared
 *   `httpFetch` helper's existing 500KB cap (fine for every other adapter's
 *   much smaller pages). `httpFetch` gets an optional 6th `capOverride` param,
 *   defaulting to the existing 500000 so every other call site (workday/
 *   apple/eightfold/avature) is byte-for-byte unchanged; Google's calls pass
 *   1,300,000. Same "Ashby big-board fix" precedent as R1 (S31).
 * - Dead-posting signal: a bogus job id still returns HTTP 200 (client-
 *   rendered SPA route, confirmed) -- the real signal is the `og:title` meta
 *   tag, EMPTY for an invalid id, populated with the real title for a live
 *   one (confirmed against fixtures/goog_bogus vs goog_real captures). That
 *   tag sits ~948KB in too, so Verify Job Links' `reqBody` call for Google
 *   also needs a raised maxSize (1,200,000) over its 300000 default.
 *
 * v1 scope, explicit and disclosed (not silently dropped): no secondary
 * per-job detail fetch for full JD text (jd_text stays '', matching every
 * other adapter's own v1-scope precedent) -- title/location/apply_url only.
 *
 * +0 nodes (self-fetch dispatch, no new poller nodes -- same as workday/
 * apple/eightfold/avature). Seeds Google directly (single hardcoded
 * integration, like amazon/apple/oracle -- confirmed those 3 have zero
 * Extract Registry Candidates auto-discovery branches either, so none added
 * here) both live via SQL and in the Registry Seeder's SEED array for
 * fresh-clone reproducibility.
 *
 * Run: dry-run the parser against the real captured fixture first (harness),
 * then inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_TARGETS = [path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json')];
const MASTER_TARGETS = [path.join(ROOT, 'workflows', 'CareerForge_Master_local.json')];
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');
const FIXTURE = path.join(ROOT, 'fixtures', 'google_careers_query.html');

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ══════════════════════ 1. Build Requests (poller) ══════════════════════
const BR_IMPL_OLD = "const IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature'];";
const BR_IMPL_NEW = "const IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature', 'google'];";
// CORRECTED after a real bug caught live: the first version of this anchor
// matched only a SUBSTRING of avature's real line (its actual decoy URL
// already carries a SearchJobs pagination suffix from s73, which this
// anchor originally didn't know about) -- replaceOnce's count-of-1 check
// doesn't catch a partial-line match, so the first deploy silently
// truncated avature's suffix and reattached it to google's entry instead.
// Both are pure decoys (Fetch ATS's response is discarded for every
// self-fetch type, real fetching happens in Parse Jobs), so nothing broke
// functionally, but it was sloppy and misleading -- fixed directly on the
// live file and here, for anyone re-running this script from a clean clone.
const BR_URL_OLD = "avature:    'https://' + slug + '.avature.net/' + (apiBase || 'careers') + '/SearchJobs?jobRecordsPerPage=1&jobOffset=0',";
const BR_URL_NEW = "avature:    'https://' + slug + '.avature.net/' + (apiBase || 'careers') + '/SearchJobs?jobRecordsPerPage=1&jobOffset=0',\n  google:     'https://www.google.com/about/careers/applications/jobs/results',";

// ══════════════════════ 2. Parse Jobs (poller) -- the real adapter ══════════════════════
const PJ_CONTINUE_OLD = "if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature') continue; // self-fetch pass below, Fetch ATS's response for these is discarded";
const PJ_CONTINUE_NEW = "if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature' || t === 'google') continue; // self-fetch pass below, Fetch ATS's response for these is discarded";

const PJ_FILTER_OLD = "const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature');";
const PJ_FILTER_NEW = "const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature' || c.ats_type === 'google');";

const PJ_HTTPFETCH_OLD = "function httpFetch(host, path, method, headers, body) {\n      return new Promise((resolve) => {\n        const r = https.request(\n          { method, host, path, timeout: 6000, headers: Object.assign({ 'User-Agent': UA }, headers || {}) },\n          (res) => {\n            const chunks = []; let size = 0;\n            res.on('data', (c) => { size += c.length; if (size < 500000) chunks.push(c); });\n            res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));\n          }\n        );\n        r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: '' }); });\n        r.on('error', () => resolve({ status: 0, body: '' }));\n        if (body) r.write(body);\n        r.end();\n      });\n    }";
const PJ_HTTPFETCH_NEW = "function httpFetch(host, path, method, headers, body, capOverride) {\n      // s111: optional capOverride -- Google's job cards sit past the default\n      // 500KB cap (same \"raise the cap for the one adapter that needs it\"\n      // precedent as the Ashby big-board fix, R1/S31). Every existing caller\n      // omits the 6th arg, so behavior there is byte-for-byte unchanged.\n      const cap = capOverride || 500000;\n      return new Promise((resolve) => {\n        const r = https.request(\n          { method, host, path, timeout: 6000, headers: Object.assign({ 'User-Agent': UA }, headers || {}) },\n          (res) => {\n            const chunks = []; let size = 0;\n            res.on('data', (c) => { size += c.length; if (size < cap) chunks.push(c); });\n            res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));\n          }\n        );\n        r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: '' }); });\n        r.on('error', () => resolve({ status: 0, body: '' }));\n        if (body) r.write(body);\n        r.end();\n      });\n    }";

// The real fetchGoogle logic -- shared source for both the real patch and
// the harness (harness eval's this exact string against a real fixture).
const FETCH_GOOGLE_SRC = `
async function fetchGoogle(company) {
  // s111: Google requires a real search term to server-render any results
  // at all (confirmed live -- a bare ?page=N with no q= returns zero cards).
  // Downstream push()/TITLE_RX does the real relevance filtering, same as
  // every other adapter; these terms only need to surface a good pool.
  const QUERIES = ['software engineer', 'machine learning', 'data scientist'];
  const MAX_PAGES = 4;
  const rows = [];
  const seenIds = new Set();
  let ok = false;
  for (const q of QUERIES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const p = '/about/careers/applications/jobs/results?q=' + encodeURIComponent(q) + '&page=' + page;
      const res = await httpFetch('www.google.com', p, 'GET', { Accept: 'text/html' }, null, 1300000);
      if (res.status !== 200 || !res.body) break;
      ok = true;
      const cards = res.body.split('<li class="lLd3Je"').slice(1);
      if (!cards.length) break;
      for (const c of cards) {
        const idM = c.match(/ssk='(?:\\d+:)?(\\d+)'/);
        const hrefM = c.match(/href="(jobs\\/results\\/[^"?]+)/);
        if (!idM || !hrefM) continue;
        const external_id = idM[1];
        if (seenIds.has(external_id)) continue;
        seenIds.add(external_id);
        const titleM = c.match(/<h3 class="QJPWVe">([^<]+)<\\/h3>/);
        const locM = c.match(/class="r0wTof ">([^<]+)</);
        const title = (titleM ? titleM[1] : '').trim();
        const location = (locM ? locM[1] : '').trim();
        rows.push({
          company_id: company.company_id, board: company.board,
          external_id, title, jd_text: '', location,
          remote: isRemote(location + ' ' + title),
          apply_url: 'https://www.google.com/about/careers/applications/' + hrefM[1],
          posted_at: null,
        });
      }
      if (cards.length < 20) break; // short page -- last page for this query
    }
    if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
  }
  return { rows, ok };
}
`.trim();

const PJ_FETCHONE_OLD = "async function fetchOne(company) {\n      if (company.ats_type === 'workday') return fetchWorkday(company);\n      if (company.ats_type === 'apple') return fetchApple(company);\n      if (company.ats_type === 'eightfold') return fetchEightfold(company);\n      if (company.ats_type === 'avature') return fetchAvature(company);\n      return { rows: [], ok: false };\n    }";
const PJ_FETCHONE_NEW = FETCH_GOOGLE_SRC + "\n\n    async function fetchOne(company) {\n      if (company.ats_type === 'workday') return fetchWorkday(company);\n      if (company.ats_type === 'apple') return fetchApple(company);\n      if (company.ats_type === 'eightfold') return fetchEightfold(company);\n      if (company.ats_type === 'avature') return fetchAvature(company);\n      if (company.ats_type === 'google') return fetchGoogle(company);\n      return { rows: [], ok: false };\n    }";

// ══════════════════════ 3. Tick Bookkeeping (poller) ══════════════════════
const TB_OLD = "const SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold', 'avature']);";
const TB_NEW = "const SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold', 'avature', 'google']);";

// ══════════════════════ 4. Verify Job Links (master) ══════════════════════
const VJL_ANCHOR_OLD = "    if (h === 'www.linkedin.com' || h === 'linkedin.com') {";
const VJL_ANCHOR_NEW = `    if (h === 'www.google.com' && u.path.indexOf('/about/careers/applications/jobs/results/') === 0) {
      // s111: Google's job-detail route always 200s even for a bogus id
      // (client-rendered SPA route, confirmed live). Real signal: the
      // og:title meta tag is EMPTY for an invalid id, populated with the
      // real title otherwise (confirmed against a real vs bogus id this
      // session). That tag sits ~950KB into the page, past reqBody's
      // default 300KB cap -- raised to 1.2MB for this call only.
      const res = await reqBody(u, 'GET', 'text/html', 1200000);
      const m = res.body.match(/<meta property="og:title" content="([^"]*)"/);
      if (m && !m[1].trim()) return { verdict: 'dead', location: null };
      return { verdict: 'keep', location: null };
    }

    if (h === 'www.linkedin.com' || h === 'linkedin.com') {`;

// ══════════════════════ 5. classifyUrlTier x3 normalize nodes (master) ══════════════════════
const TIER_OLD = "if (/[\\w-]+\\.avature\\.net/.test(u)) return { tier: 1, label: 'ats:avature' };";
const TIER_NEW = "if (/[\\w-]+\\.avature\\.net/.test(u)) return { tier: 1, label: 'ats:avature' };\n  if (/google\\.com\\/about\\/careers\\/applications\\/jobs\\/results/.test(u)) return { tier: 1, label: 'ats:google' };";
const NORMALIZE_NODES = ['Normalize You.com results', 'Normalize Serper results', 'Normalize Firecrawl Results'];

// ══════════════════════ 6. Registry Seeder SEED array ══════════════════════
const SEED_OLD = "  { name: 'LinkedIn', ats_type: 'smartrecruiters', slug: 'linkedin3', api_base: '', tier: 'dream' },\n];";
const SEED_NEW = "  { name: 'LinkedIn', ats_type: 'smartrecruiters', slug: 'linkedin3', api_base: '', tier: 'dream' },\n  // s111: Google's own careers site, self-fetch HTML adapter (no public API).\n  { name: 'Google', ats_type: 'google', slug: 'google', api_base: '', tier: 'dream' },\n];";

function patchPoller(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Build Requests', 'Parse Jobs', 'Tick Bookkeeping']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Jobs'].parameters.jsCode.includes('fetchGoogle')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Requests'].parameters, 'jsCode', BR_IMPL_OLD, BR_IMPL_NEW, 'IMPLEMENTED list', base);
  replaceOnce(N['Build Requests'].parameters, 'jsCode', BR_URL_OLD, BR_URL_NEW, 'mkUrl google decoy', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_CONTINUE_OLD, PJ_CONTINUE_NEW, 'sync-loop self-fetch skip', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_FILTER_OLD, PJ_FILTER_NEW, 'selfFetchCompanies filter', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_HTTPFETCH_OLD, PJ_HTTPFETCH_NEW, 'httpFetch capOverride param', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_FETCHONE_OLD, PJ_FETCHONE_NEW, 'fetchGoogle + fetchOne dispatch', base);
  replaceOnce(N['Tick Bookkeeping'].parameters, 'jsCode', TB_OLD, TB_NEW, 'SELF_FETCH_TYPES', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Google adapter wired -- ${wf.nodes.length} nodes`);
}

function patchMaster(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Verify Job Links', ...NORMALIZE_NODES]) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Verify Job Links'].parameters.jsCode.includes('ats:google')) { console.log(`  ${base}: already patched (Verify Job Links)`); }
  else {
    replaceOnce(N['Verify Job Links'].parameters, 'jsCode', VJL_ANCHOR_OLD, VJL_ANCHOR_NEW, 'google dead-check branch', base);
  }
  for (const name of NORMALIZE_NODES) {
    if (N[name].parameters.jsCode.includes('ats:google')) { console.log(`  ${base}: already patched (${name})`); continue; }
    replaceOnce(N[name].parameters, 'jsCode', TIER_OLD, TIER_NEW, `classifyUrlTier google (${name})`, base);
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Verify Job Links + 3 normalize nodes wired for google -- ${wf.nodes.length} nodes`);
}

function patchSeeder() {
  if (!fs.existsSync(SEEDER_FILE)) { console.error('INTEGRITY FAIL: seeder file missing'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (!buildNode) { console.error('INTEGRITY FAIL: Build Seed List node not found'); process.exit(1); }
  if (buildNode.parameters.jsCode.includes("ats_type: 'google'")) { console.log('  seeder: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', SEED_OLD, SEED_NEW, 'append Google row', 'seeder');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log('OK: Registry Seeder SEED array gained the Google row');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. real fetchGoogle logic, run against the REAL captured fixture --
  //    fakes httpFetch to serve the fixture body instead of hitting the
  //    network, but the parsing logic executed is the EXACT patch string.
  if (!fs.existsSync(FIXTURE)) { console.error('HARNESS FAIL: fixture missing, run the curl capture first'); process.exit(1); }
  const fixtureBody = fs.readFileSync(FIXTURE, 'utf8');

  const TITLE_RX = /(machine\s*learning|\bml\b|\bai\b|artificial\s*intelligence|data\s*(scien|engineer|analy|platform)|analytics\s*engineer|deep\s*learning|\bnlp\b|\bllm\b|gen\s*ai|generative|computer\s*vision|research\s*(scientist|engineer)|applied\s*scientist|software\s*engineer|\bswe\b|\bsde\b|backend|back-end|full[\s-]*stack|platform\s*engineer|infrastructure\s*engineer|devops|mlops|\bsre\b)/i;
  const CAP = 25;
  const isRemote = (s) => /remote/i.test(String(s || ''));

  let callCount = 0;
  async function httpFetch(host, p, method, headers, body, capOverride) {
    callCount++;
    if (callCount === 1) return { status: 200, body: fixtureBody };
    return { status: 200, body: '' }; // subsequent pages/queries: simulate "no more results" to keep the harness fast
  }

  const fn = new Function('httpFetch', 'isRemote', 'TITLE_RX', 'CAP', `return (${FETCH_GOOGLE_SRC})({ company_id: 999, board: 'google:google' });`);
  return fn(httpFetch, isRemote, TITLE_RX, CAP).then((result) => {
    const { rows, ok } = result;
    if (!ok) { console.error('HARNESS FAIL: fetchGoogle reported ok:false against a real 200 fixture'); process.exit(1); }
    if (rows.length < 15) { console.error(`HARNESS FAIL: expected >=15 jobs from the real fixture, got ${rows.length}`); process.exit(1); }
    for (const r of rows) {
      if (!/^\d+$/.test(r.external_id)) { console.error('HARNESS FAIL: non-numeric external_id', r.external_id); process.exit(1); }
      if (!r.title || r.title.length < 3) { console.error('HARNESS FAIL: empty/tiny title', JSON.stringify(r)); process.exit(1); }
      if (!r.location) { console.error('HARNESS FAIL: empty location', JSON.stringify(r)); process.exit(1); }
      if (!r.apply_url.startsWith('https://www.google.com/about/careers/applications/jobs/results/')) {
        console.error('HARNESS FAIL: malformed apply_url', r.apply_url); process.exit(1);
      }
    }
    const ids = new Set(rows.map((r) => r.external_id));
    if (ids.size !== rows.length) { console.error('HARNESS FAIL: duplicate external_ids within one fetch'); process.exit(1); }

    console.log(`HARNESS OK: fetchGoogle extracted ${rows.length} real jobs from the live-captured fixture, all with numeric ids, real titles, non-empty locations, correct apply_urls, zero duplicates.`);

    patchPoller(POLLER_TARGETS[0]);
    patchMaster(MASTER_TARGETS[0]);
    patchSeeder();
    console.log('S111 (Google adapter) script complete.');
  });
})();
