/**
 * s121_successfactors_adapter.js -- new SAP SuccessFactors Career Site Builder
 * adapter (16th ATS type), following the self-fetch HTML pattern exactly
 * (Workday/Apple/Eightfold/Avature/Google/D.E.Shaw/Microsoft precedent).
 *
 * Investigation, live this session (not guessed): SuccessFactors has no
 * public JSON job API (confirmed by research -- the real JobRequisition
 * OData API needs Recruiter-Operator auth). But its "Career Site Builder"
 * product -- confirmed identical across 3 independent real tenants, Cargill
 * (jobs.cargill.com), Vodafone (opportunities.vodafone.com), ExxonMobil
 * (jobs.exxonmobil.com) -- exposes a real, server-rendered, unauthenticated
 * pagination endpoint the site's OWN front-end JS uses for "load more jobs":
 *   GET https://{host}/search/tile-search-results?q=&sortColumn=referencedate&sortDirection=desc&startrow=N
 * 25 jobs/page, real numeric external ids, real title/location text, real
 * relative apply URLs (`/job/<slug>/<id>/`).
 *
 * robots.txt COMPLIANCE, checked explicitly (identical default policy on
 * all 3 tenants -- this is the platform's own template, not per-company):
 *   Disallow: /applybutton/ /talentcommunity/ /mobile/talentcommunity/
 *             /emailsubscribe/ /email/image/ /services/ /preapply/ /error
 *             /unsubscribe/ /reset/
 * Every path this adapter reads (/search/tile-search-results, /job/<id>/)
 * is NOT in that list -- these are the platform's own public, indexable job
 * pages (meta name="robots" content on job pages is "noindex", which only
 * asks search engines not to index individual postings -- it does not
 * appear in robots.txt as a Disallow and isn't a machine-readable scraping
 * restriction). Same disclosed-compliance discipline as the Microsoft
 * adapter's robots.txt check earlier this session.
 *
 * A 4th real tenant (BJ's Wholesale, careers.bjs.com) returned a 503
 * Cloudflare bot-wall on every path including robots.txt itself -- that's
 * a tenant-specific WAF layer (same class of per-tenant variance already
 * seen with Avature/Google), not a platform-wide block; that tenant simply
 * isn't seeded. A 5th (Colgate, jobs.colgate.com) returned a real page but
 * an empty tile-search-results response for unclear reasons (not a bot-wall
 * -- got a real 76KB page back, just zero job tiles) -- also not seeded,
 * documented rather than forced.
 *
 * Dead-posting signal, confirmed live against a real filled/closed posting:
 * the job-detail page ALWAYS returns 200 (server-rendered, no redirect) but
 * a closed requisition's `jobDisplayShell` div omits
 * `itemtype="http://schema.org/JobPosting"` entirely (renders literal text
 * "Sorry, this position has been filled." instead) -- a live posting's same
 * div has that itemtype plus real schema.org JobPosting microdata
 * (addressLocality/addressRegion/addressCountry/datePosted/validThrough).
 * Using the itemtype presence/absence as the signal (not the free-text
 * message, which could vary by locale) -- same "structural signal over
 * wording" discipline as every other dead-check this session.
 *
 * NOT wired into Extract Registry Candidates / classifyUrlTier (auto-
 * discovery from web-search hits) -- unlike avature/workday, SF tenants use
 * ARBITRARY company-owned hostnames with no shared suffix, so there is no
 * safe way to recognize "this URL is secretly SuccessFactors" from a URL
 * alone without a real false-positive risk against unrelated career-site-
 * builder-style sites. Same disclosed gap class as oracle/amazon/apple/
 * google/deshaw/microsoft, none of which are auto-discovered either --
 * new SF tenants need manual seeding, same as those.
 *
 * Seeds 3 companies, tier 'probe' (general F500 coverage, not curated
 * dream-tier product companies): Cargill, Vodafone, ExxonMobil.
 *
 * Run: harness (structural, replays the real regex extraction against a
 * captured real Cargill search-results HTML fragment) + deploy (poller +
 * master + seeder, 3 files) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_FILE = path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

const SEED_ROWS = [
  { name: 'Cargill',     slug: 'cargill',     api_base: 'jobs.cargill.com' },
  { name: 'Vodafone',    slug: 'vodafone',    api_base: 'opportunities.vodafone.com' },
  { name: 'ExxonMobil',  slug: 'exxonmobil',  api_base: 'jobs.exxonmobil.com' },
];

const FETCH_SF_FN = `async function fetchSuccessFactors(company) {
  // s121: SAP SuccessFactors Career Site Builder -- see script header for the
  // full live-verification writeup (3 tenants, robots.txt check, dead-check
  // signal). api_base holds the tenant's real career-site hostname.
  const host = company.api_base || '';
  if (!host) return { rows: [], ok: false };
  const PAGE_SIZE = 25;
  const MAX_PAGES = 8; // 200 jobs/tick ceiling, same order as Google's cap
  const rows = [];
  let ok = false;
  for (let p = 0; p < MAX_PAGES; p++) {
    const startrow = p * PAGE_SIZE;
    const qpath = '/search/tile-search-results?q=&sortColumn=referencedate&sortDirection=desc&startrow=' + startrow;
    const res = await httpFetch(host, qpath, 'GET', { Accept: 'text/html' }, null, 1000000);
    if (res.status !== 200 || !res.body) break;
    ok = true;
    const blocks = res.body.split('<li class="job-tile job-id-').slice(1);
    if (!blocks.length) break;
    for (const block of blocks) {
      const idM = block.match(/^(\\d+)/);
      const hrefM = block.match(/data-url="([^"]+)"/);
      const titleM = block.match(/jobTitle-link[^>]*>\\s*([^<]+?)\\s*</);
      const locM = block.match(/-value">\\s*([^<]+?)\\s*<\\/div>/);
      if (!idM || !hrefM || !titleM) continue;
      const location = locM ? dec(locM[1]) : '';
      const title = dec(titleM[1]);
      rows.push({
        company_id: company.company_id, board: company.board,
        external_id: idM[1], title, jd_text: '', location,
        remote: isRemote(location + ' ' + title),
        apply_url: 'https://' + host + hrefM[1],
        posted_at: null,
      });
    }
    if (blocks.length < PAGE_SIZE) break;
  }
  return { rows, ok };
}

    async function fetchOne(company) {`;

const VERIFY_BRANCH = `    if (h === 'www.linkedin.com' || h === 'linkedin.com') {`;
const VERIFY_BRANCH_NEW = `    if (/\\/job\\/[^/]+\\/\\d+\\/?$/.test(u.path)) {
      // s121: SuccessFactors Career Site Builder job-detail pages always 200
      // (server-rendered) even for a closed/filled posting -- see the fetch
      // adapter's header comment for the full live-verification writeup.
      // Real signal: a live posting's jobDisplayShell div carries
      // itemtype="http://schema.org/JobPosting" + real schema.org
      // microdata; a closed one omits itemtype entirely. Path-shape matched
      // (not host-suffix, unlike Avature/Workday) since SF tenants use
      // arbitrary company-owned hostnames with no shared suffix -- this
      // runs after every host-specific branch above, so it only ever
      // catches URLs nothing else claimed.
      const res = await reqBody(u, 'GET', 'text/html', 400000);
      if (res.status !== 200 || !res.body) return { verdict: 'keep', location: null };
      if (!/itemtype="http:\\/\\/schema\\.org\\/JobPosting"/.test(res.body)) return { verdict: 'dead', location: null };
      const locM = res.body.match(/addressLocality" content="([^"]*)"/);
      const regM = res.body.match(/addressRegion" content="([^"]*)"/);
      const countryM = res.body.match(/addressCountry" content="([^"]*)"/);
      const location = [locM && locM[1], regM && regM[1], countryM && countryM[1]].filter(Boolean).join(', ') || null;
      return { verdict: 'keep', location };
    }

    if (h === 'www.linkedin.com' || h === 'linkedin.com') {`;

function patchPoller() {
  const wf = JSON.parse(fs.readFileSync(POLLER_FILE, 'utf8'));

  const buildReq = wf.nodes.find((n) => n.name === 'Build Requests');
  if (buildReq.parameters.jsCode.includes("'successfactors'")) {
    console.log('  poller: already patched');
  } else {
    replaceOnce(buildReq.parameters, 'jsCode',
      "const IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw', 'microsoft'];",
      "const IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw', 'microsoft', 'successfactors'];",
      'Build Requests IMPLEMENTED array');
    replaceOnce(buildReq.parameters, 'jsCode',
      "  microsoft:  'https://jobs.careers.microsoft.com/global/en/search',\n}[t]);",
      "  microsoft:  'https://jobs.careers.microsoft.com/global/en/search',\n  successfactors: 'https://' + apiBase + '/search/tile-search-results?q=&sortColumn=referencedate&sortDirection=desc&startrow=0',\n}[t]);",
      'Build Requests mkUrl table');

    const parseJobs = wf.nodes.find((n) => n.name === 'Parse Jobs');
    replaceOnce(parseJobs.parameters, 'jsCode',
      "if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature' || t === 'google' || t === 'deshaw' || t === 'microsoft') continue; // self-fetch pass below, Fetch ATS's response for these is discarded",
      "if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature' || t === 'google' || t === 'deshaw' || t === 'microsoft' || t === 'successfactors') continue; // self-fetch pass below, Fetch ATS's response for these is discarded",
      'Parse Jobs sync-loop skip');
    replaceOnce(parseJobs.parameters, 'jsCode',
      "const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature' || c.ats_type === 'google' || c.ats_type === 'deshaw' || c.ats_type === 'microsoft');",
      "const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature' || c.ats_type === 'google' || c.ats_type === 'deshaw' || c.ats_type === 'microsoft' || c.ats_type === 'successfactors');",
      'Parse Jobs selfFetchCompanies filter');
    replaceOnce(parseJobs.parameters, 'jsCode',
      '    async function fetchOne(company) {',
      FETCH_SF_FN,
      'insert fetchSuccessFactors + fetchOne anchor');
    replaceOnce(parseJobs.parameters, 'jsCode',
      "      if (company.ats_type === 'microsoft') return fetchMicrosoft(company);\n      return { rows: [], ok: false };",
      "      if (company.ats_type === 'microsoft') return fetchMicrosoft(company);\n      if (company.ats_type === 'successfactors') return fetchSuccessFactors(company);\n      return { rows: [], ok: false };",
      'fetchOne dispatch');

    const tickBook = wf.nodes.find((n) => n.name === 'Tick Bookkeeping');
    replaceOnce(tickBook.parameters, 'jsCode',
      "const SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw', 'microsoft']);",
      "const SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw', 'microsoft', 'successfactors']);",
      'Tick Bookkeeping SELF_FETCH_TYPES');

    fs.writeFileSync(POLLER_FILE, JSON.stringify(wf, null, 2));
    console.log('OK: poller patched (Build Requests, Parse Jobs, Tick Bookkeeping)');
  }
}

function patchMaster() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const verifyNode = wf.nodes.find((n) => n.name === 'Verify Job Links');
  if (verifyNode.parameters.jsCode.includes('s121: SuccessFactors')) {
    console.log('  master: already patched');
    return;
  }
  replaceOnce(verifyNode.parameters, 'jsCode', VERIFY_BRANCH, VERIFY_BRANCH_NEW, 'Verify Job Links successfactors branch');
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log('OK: master patched (Verify Job Links)');
}

function patchSeeder() {
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (buildNode.parameters.jsCode.includes("ats_type: 'successfactors'")) {
    console.log('  seeder: already patched');
    return;
  }
  const OLD_TAIL = "{ name: 'Digital Realty', ats_type: 'oracle', slug: 'CX', api_base: 'hdep.fa.us2.oraclecloud.com' },\n];";
  const lines = SEED_ROWS.map((r) => `  { name: '${r.name.replace(/'/g, "\\'")}', ats_type: 'successfactors', slug: '${r.slug}', api_base: '${r.api_base}' },`);
  const NEW_TAIL = "{ name: 'Digital Realty', ats_type: 'oracle', slug: 'CX', api_base: 'hdep.fa.us2.oraclecloud.com' },\n  // s121: SAP SuccessFactors Career Site Builder, new adapter this same\n  // commit -- 3 real tenants live-verified via the site's own /search/\n  // tile-search-results pagination endpoint. See script header for the\n  // full robots.txt + dead-check writeup.\n" + lines.join('\n') + "\n];";
  replaceOnce(buildNode.parameters, 'jsCode', OLD_TAIL, NEW_TAIL, 'append SuccessFactors seed rows');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: Registry Seeder gained ${SEED_ROWS.length} SuccessFactors rows`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // Real captured fixture: page-1 job-tile block from the live Cargill
  // /search/tile-search-results response (this exact HTML was fetched live
  // this session, not synthesized).
  const FIXTURE = `<li class="job-tile job-id-1358858257 job-row-index-1" data-url="/job/Nindiri-Supervisor%28a%29-de-Mantenimiento-Masa-42200/1358858257/" data-row-index="1">
                <div class="job-tile-cell">
                        <div class="tiletitle">
            <span style="font-family:Arial, Helvetica, sans-serif; font-size:22px;" class="col-md-12 section-title title" role="heading" aria-level="2">
                <a class="jobTitle-link fontcolorf3d0eced64da8a9e" href="/job/Nindiri-Supervisor%28a%29-de-Mantenimiento-Masa-42200/1358858257/">
                    Supervisor(a) de Mantenimiento
                </a>
            </span>
        </div>
            <div id="job-1358858257-desktop-section-location" class="section-field location">
                <span class="section-label">Location</span>
                <div id="job-1358858257-desktop-section-location-value">Nindiri, Masaya, NI Nicaragua, 42200
                </div>
            </div>
        </li>`;
  const dec = s => String(s == null ? '' : s).split('&amp;').join('&').split('&lt;').join('<').split('&gt;').join('>').split('&quot;').join('"').split('&#39;').join("'").split('&#x27;').join("'");
  const isRemote = s => /remote/i.test(String(s || ''));
  const blocks = FIXTURE.split('<li class="job-tile job-id-').slice(1);
  if (blocks.length !== 1) { console.error(`HARNESS FAIL: expected 1 fixture block, got ${blocks.length}`); process.exit(1); }
  const block = blocks[0];
  const idM = block.match(/^(\d+)/);
  const hrefM = block.match(/data-url="([^"]+)"/);
  const titleM = block.match(/jobTitle-link[^>]*>\s*([^<]+?)\s*</);
  const locM = block.match(/-value">\s*([^<]+?)\s*<\/div>/);
  if (!idM || idM[1] !== '1358858257') { console.error('HARNESS FAIL: id extraction wrong', idM); process.exit(1); }
  if (!hrefM || !hrefM[1].startsWith('/job/Nindiri')) { console.error('HARNESS FAIL: href extraction wrong', hrefM); process.exit(1); }
  if (!titleM || dec(titleM[1]) !== 'Supervisor(a) de Mantenimiento') { console.error('HARNESS FAIL: title extraction wrong', JSON.stringify(titleM && titleM[1])); process.exit(1); }
  if (!locM || dec(locM[1]) !== 'Nindiri, Masaya, NI Nicaragua, 42200') { console.error('HARNESS FAIL: location extraction wrong', JSON.stringify(locM && locM[1])); process.exit(1); }
  const apply_url = 'https://jobs.cargill.com' + hrefM[1];
  if (apply_url !== 'https://jobs.cargill.com/job/Nindiri-Supervisor%28a%29-de-Mantenimiento-Masa-42200/1358858257/') { console.error('HARNESS FAIL: apply_url wrong', apply_url); process.exit(1); }

  // dead-check regex sanity: real live vs real filled fixture snippets
  const LIVE_SNIPPET = '<div class="jobDisplayShell" itemscope="itemscope" itemtype="http://schema.org/JobPosting"><span itemprop="jobLocation">';
  const DEAD_SNIPPET = '<div class="jobDisplayShell" itemscope="itemscope">\n                    <div class="jobDisplay">';
  if (!/itemtype="http:\/\/schema\.org\/JobPosting"/.test(LIVE_SNIPPET)) { console.error('HARNESS FAIL: live snippet should match schema check'); process.exit(1); }
  if (/itemtype="http:\/\/schema\.org\/JobPosting"/.test(DEAD_SNIPPET)) { console.error('HARNESS FAIL: dead snippet should NOT match schema check'); process.exit(1); }

  // path-shape regex sanity
  const PATH_RX = /\/job\/[^/]+\/\d+\/?$/;
  if (!PATH_RX.test('/job/Nindiri-Supervisor%28a%29-de-Mantenimiento-Masa-42200/1358858257/')) { console.error('HARNESS FAIL: path regex should match real SF job path'); process.exit(1); }
  if (PATH_RX.test('/careers/search')) { console.error('HARNESS FAIL: path regex false-positived on an unrelated path'); process.exit(1); }

  if (SEED_ROWS.length !== 3) { console.error('HARNESS FAIL: expected 3 seed rows'); process.exit(1); }
  const names = new Set(SEED_ROWS.map((r) => r.name));
  if (names.size !== 3) { console.error('HARNESS FAIL: duplicate seed row name'); process.exit(1); }

  console.log('HARNESS OK: extraction regexes verified against real captured HTML, dead-check + path-shape regexes verified, seed rows well-formed.');

  patchPoller();
  patchMaster();
  patchSeeder();
  console.log('S121 (SuccessFactors adapter) script complete.');
})();
