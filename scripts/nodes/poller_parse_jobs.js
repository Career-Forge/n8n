// Parse Jobs -- v2, Phase 2.3 adapter expansion.
// Existing greenhouse/lever/ashby/workable/recruitee branches are byte-identical to
// the pre-expansion version -- zero behavior change there. Adds:
//   - smartrecruiters/amazon/oracle: parsed straight from Fetch ATS's response
//     (single page, same pattern as the 5 existing adapters).
//   - workday/apple/eightfold: Fetch ATS's response is IGNORED for these types --
//     they self-fetch via require('https') (POST bodies / small page caps / a
//     dual-endpoint-tier fallback that a single GET can't express), with bounded
//     pagination (MAX_PAGES) since their per-page caps are small (10-20) and a
//     single page badly undercounts a large company's real listing.
// v1 scope, explicit and disclosed (not silently dropped): no secondary per-job
// detail-call for full JD text on ANY of the 6 new adapters -- jd_text is whatever
// the list response provides (full for amazon; short/absent for the rest). The
// existing title-relevance filter (push/TITLE_RX) only ever tests the title, so
// this doesn't affect matching, only the richness of embed_input/JobScorer input
// for these sources specifically. Oracle's apply_url is hardcoded to Oracle's own
// public careers domain -- generalizing to other Oracle-ORC customers would need a
// way to know their public career-site domain, which isn't derivable from the pod
// host alone; not attempted here (Oracle itself is the only seeded oracle-type row).
const respOf = (it) => (it || {}).json || {};
const statusOf = (R) => R.statusCode ?? (R.error ? 0 : ((typeof R.body === 'string' || typeof R.data === 'string') ? 200 : 0));
const bodyOf = (R) => typeof R.body === 'string' ? R.body : (typeof R.data === 'string' ? R.data : null);
const etagOf = (R) => { const h = R.headers || {}; return h.etag || h.ETag || h.Etag || ''; };
const reqs = $('Build Requests').all();
const resps = $input.all();
const count = {};
const jobs = [];
// s95: one company_name capture per greenhouse board per tick -- see header.
const nameBackfills = [];
const nameBackfillSeen = new Set();
// FIX (found while adding new adapters, unrelated to this expansion but in the same
// node): this was `new RegExp("... \s ... \b ...")` -- a STRING passed to RegExp,
// where JS string-escape processing silently eats \s (becomes literal "s") and turns
// \b into an actual backspace control character, not a word-boundary token. Verified
// live: the broken version matched ZERO of "Machine Learning Engineer", "AI Engineer",
// "Data Scientist", "NLP Researcher", "Senior Software Engineer", "Deep Learning
// Researcher" -- the poller's relevance filter has been discarding almost every
// genuinely relevant title since this filter was written. A regex LITERAL (below)
// isn't string-escape-processed, so \s and \b reach the regex engine as intended.
// s91: title-relevance filter + per-board cap are now config-driven
// (app_settings 'ingest_title_filter', same externalization pattern as
// 'geo_reference') instead of a single hardcoded regex -- see Load Ingest
// Config. Falls back to this EXACT original regex/cap if the config row is
// missing or malformed -- a config problem must never silently stop ingestion.
const FALLBACK_TITLE_RX = /(machine\s*learning|\bml\b|\bai\b|artificial\s*intelligence|data\s*(scien|engineer|analy|platform)|analytics\s*engineer|deep\s*learning|\bnlp\b|\bllm\b|gen\s*ai|generative|computer\s*vision|research\s*(scientist|engineer)|applied\s*scientist|software\s*engineer|\bswe\b|\bsde\b|backend|back-end|full[\s-]*stack|platform\s*engineer|infrastructure\s*engineer|devops|mlops|\bsre\b)/i;
function buildTitleFilter(cfg) {
  if (cfg && cfg.mode === 'all') return { rx: /^/, cap: (typeof cfg.cap_per_board === 'number' && cfg.cap_per_board > 0) ? cfg.cap_per_board : 25 };
  if (!cfg || cfg.mode !== 'keywords' || !Array.isArray(cfg.keywords) || !cfg.keywords.length) return { rx: FALLBACK_TITLE_RX, cap: 25 };
  const esc = (s) => String(s).trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const parts = cfg.keywords.map((kw) => String(kw || '').trim()).filter(Boolean).map((raw) => {
    const pattern = esc(raw);
    return raw.length <= 4 ? '\\b' + pattern + '\\b' : pattern;
  });
  if (!parts.length) return { rx: FALLBACK_TITLE_RX, cap: 25 };
  let rx;
  try { rx = new RegExp('(' + parts.join('|') + ')', 'i'); } catch (e) { return { rx: FALLBACK_TITLE_RX, cap: 25 }; }
  return { rx, cap: (typeof cfg.cap_per_board === 'number' && cfg.cap_per_board > 0) ? cfg.cap_per_board : 25 };
}
let _ingestConfig = null;
try { _ingestConfig = $('Load Ingest Config').first().json.ingest_config; } catch (e) {}
const { rx: TITLE_RX, cap: CAP } = buildTitleFilter(_ingestConfig);
const push = (board, obj) => { if (!TITLE_RX.test(String(obj.title || ''))) return; count[board] = (count[board] || 0); if (count[board] >= CAP) return; count[board]++; jobs.push(obj); };
const dec = s => String(s == null ? '' : s).split('&amp;').join('&').split('&lt;').join('<').split('&gt;').join('>').split('&quot;').join('"').split('&#39;').join("'").split('&#x27;').join("'");
const strip = s => dec(dec(s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const iso = v => { try { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); } catch (e) { return null; } };
const isRemote = s => /remote/i.test(String(s || ''));

for (let i = 0; i < resps.length; i++) {
  const company = (reqs[i] || {}).json || {};
  const t = company.ats_type;
  if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature' || t === 'google' || t === 'deshaw' || t === 'microsoft') continue; // self-fetch pass below, Fetch ATS's response for these is discarded
  const R = respOf(resps[i]);
  if (statusOf(R) < 200 || statusOf(R) >= 300) continue;
  let body = null;
  try { body = JSON.parse(bodyOf(R)); } catch (e) { body = null; }
  if (!body || body.error) continue;
  try {
    if (t === 'greenhouse') {
      for (const j of (body.jobs || [])) {
        push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id), title: j.title || '', jd_text: strip(j.content), location: (j.location && j.location.name) || '', remote: isRemote(j.location && j.location.name), apply_url: j.absolute_url || '', posted_at: iso(j.updated_at || j.first_published) });
        if (j.company_name && !nameBackfillSeen.has(company.board)) {
          nameBackfillSeen.add(company.board);
          nameBackfills.push({ company_id: company.company_id, name: String(j.company_name).trim() });
        }
      }
    } else if (t === 'lever') {
      const arr = Array.isArray(body) ? body : (body.data || []);
      for (const j of arr) push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id), title: j.text || '', jd_text: j.descriptionPlain || strip(j.description), location: (j.categories && j.categories.location) || '', remote: isRemote(((j.categories && j.categories.location) || '') + ' ' + (j.workplaceType || '')), apply_url: j.hostedUrl || j.applyUrl || '', posted_at: iso(j.createdAt) });
    } else if (t === 'ashby') {
      for (const j of (body.jobs || [])) { if (j.isListed === false) continue; push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id), title: j.title || '', jd_text: j.descriptionPlain || strip(j.descriptionHtml), location: j.location || '', remote: !!j.isRemote, apply_url: j.jobUrl || j.applyUrl || '', posted_at: iso(j.publishedAt) }); }
    } else if (t === 'workable') {
      for (const j of (body.jobs || [])) push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.shortcode || j.id), title: j.title || '', jd_text: strip(j.description), location: [j.city, j.state, j.country].filter(Boolean).join(', '), remote: isRemote(j.workplace || (j.location && j.location.location)), apply_url: j.url || j.application_url || '', posted_at: iso(j.published_on) });
    } else if (t === 'recruitee') {
      for (const j of (body.offers || [])) { if (j.status && j.status !== 'published') continue; push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id), title: j.title || '', jd_text: strip((j.description || '') + ' ' + (j.requirements || '')), location: j.location || [j.city, j.country].filter(Boolean).join(', '), remote: isRemote(j.location), apply_url: j.careers_url || j.url || '', posted_at: iso(j.published_at) }); }
    } else if (t === 'smartrecruiters') {
      for (const j of (body.content || [])) {
        const loc = j.location || {};
        push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id || ''), title: j.name || '', jd_text: '', location: loc.fullLocation || [loc.city, loc.region, loc.country].filter(Boolean).join(', '), remote: !!loc.remote, apply_url: 'https://jobs.smartrecruiters.com/' + encodeURIComponent(company.slug) + '/' + j.id, posted_at: iso(j.releasedDate) });
      }
    } else if (t === 'amazon') {
      for (const j of (body.jobs || [])) {
        let remote = false;
        try { remote = (j.locations || []).map(s => JSON.parse(s)).some(l => l && l.type === 'VIRTUAL'); } catch (e) {}
        push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id_icims || j.id || ''), title: j.title || '', jd_text: strip(j.description || ''), location: j.location || '', remote, apply_url: j.url_next_step || ('https://www.amazon.jobs' + (j.job_path || '')), posted_at: null });
      }
    } else if (t === 'oracle') {
      const host = company.api_base || '';
      const list = (body.items && body.items[0] && body.items[0].requisitionList) || [];
      for (const j of list) {
        push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.Id || ''), title: j.Title || '', jd_text: strip(j.ShortDescriptionStr || ''), location: j.PrimaryLocation || j.PrimaryLocationCountry || '', remote: isRemote(j.WorkplaceType || j.WorkplaceTypeCode), apply_url: 'https://' + host + '/hcmUI/CandidateExperience/en/sites/' + encodeURIComponent(company.slug) + '/job/' + (j.Id || ''), posted_at: iso(j.PostedDate) });
      }
    }
  } catch (e) {}
}

// ── self-fetch pass: workday / apple / eightfold, run concurrently, require('https') ──
const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature' || c.ats_type === 'google' || c.ats_type === 'deshaw' || c.ats_type === 'microsoft');
if (selfFetchCompanies.length) {
  try {
    const https = require('https');
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

    function httpFetch(host, path, method, headers, body, capOverride) {
      // s111: optional capOverride -- Google's job cards sit past the default
      // 500KB cap (same "raise the cap for the one adapter that needs it"
      // precedent as the Ashby big-board fix, R1/S31). Every existing caller
      // omits the 6th arg, so behavior there is byte-for-byte unchanged.
      const cap = capOverride || 500000;
      return new Promise((resolve) => {
        const r = https.request(
          { method, host, path, timeout: 6000, headers: Object.assign({ 'User-Agent': UA }, headers || {}) },
          (res) => {
            const chunks = []; let size = 0;
            res.on('data', (c) => { size += c.length; if (size < cap) chunks.push(c); });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
          }
        );
        r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: '' }); });
        r.on('error', () => resolve({ status: 0, body: '' }));
        if (body) r.write(body);
        r.end();
      });
    }

    const wait = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));

    async function fetchWorkday(company) {
      const apiBase = String(company.api_base || '');
      const dot = apiBase.indexOf('.');
      if (dot === -1) return { rows: [], ok: false };
      const tenant = apiBase.slice(0, dot), wdN = apiBase.slice(dot + 1);
      if (!tenant || !wdN || !company.slug) return { rows: [], ok: false };
      const host = tenant + '.' + wdN + '.myworkdayjobs.com';
      const path = '/wday/cxs/' + tenant + '/' + company.slug + '/jobs';
      const LIMIT = 20, MAX_PAGES = 5;
      let cachedTotal = null;
      const rows = [];
      let ok = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * LIMIT;
        const reqBody = JSON.stringify({ appliedFacets: {}, limit: LIMIT, offset, searchText: '' });
        const res = await httpFetch(host, path, 'POST', { 'Content-Type': 'application/json' }, reqBody);
        if (res.status !== 200) break;
        let data; try { data = JSON.parse(res.body); } catch (e) { break; }
        ok = true;
        if (cachedTotal === null) cachedTotal = data.total || 0;
        const postings = data.jobPostings || [];
        if (!postings.length) break;
        for (const j of postings) {
          rows.push({ company_id: company.company_id, board: company.board, external_id: String(j.externalPath || ''), title: j.title || '', jd_text: '', location: j.locationsText || '', remote: /flex|remote/i.test(String(j.remoteType || '')), apply_url: 'https://' + host + '/' + company.slug + (j.externalPath || ''), posted_at: null });
        }
        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
        if (offset + LIMIT >= cachedTotal) break;
      }
      return { rows, ok };
    }

    function slugifyTitle(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'position'; }
    async function fetchApple(company) {
      const LIMIT_PAGES = 5;
      const rows = [];
      let ok = false;
      for (let page = 1; page <= LIMIT_PAGES; page++) {
        const reqBody = JSON.stringify({ query: '', locale: 'en-us', sort: 'newest', filters: {}, page, format: 'json' });
        const res = await httpFetch('jobs.apple.com', '/api/v1/search', 'POST', { 'Content-Type': 'application/json' }, reqBody);
        if (res.status !== 200) break;
        let data; try { data = JSON.parse(res.body); } catch (e) { break; }
        ok = true;
        const results = (data.res && data.res.searchResults) || [];
        if (!results.length) break;
        for (const j of results) {
          const locs = (j.locations || []).map((l) => [l.city, l.stateProvince, l.countryName].filter(Boolean).join(', ')).filter(Boolean).join(' | ');
          rows.push({ company_id: company.company_id, board: company.board, external_id: String(j.positionId || j.id || ''), title: j.postingTitle || '', jd_text: strip(j.jobSummary || ''), location: locs, remote: !!j.homeOffice, apply_url: 'https://jobs.apple.com/en-us/details/' + (j.positionId || '') + '/' + slugifyTitle(j.postingTitle), posted_at: iso(j.postingDate || j.postDateInGMT) });
        }
        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
        if (results.length < 20) break; // short of a full page -- no more results
      }
      return { rows, ok };
    }

    async function fetchEightfold(company) {
      const host = company.api_base, domain = company.slug;
      if (!host || !domain) return { rows: [], ok: false };
      const LIMIT = 10, MAX_PAGES = 5;
      let tier = 'smartapply';
      const rows = [];
      let ok = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const start = page * LIMIT;
        const qs = 'domain=' + encodeURIComponent(domain) + '&start=' + start + '&num=' + LIMIT;
        let path = (tier === 'pcsx' ? '/api/pcsx/search?' : '/api/apply/v2/jobs?') + qs;
        let res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });
        let data; try { data = JSON.parse(res.body); } catch (e) { data = null; }
        // s112: smartapply can return 200 with a genuinely EMPTY positions array
        // instead of a 403 (confirmed live: PayPal/Starbucks/Boston Scientific are
        // all real, working tenants smartapply reports as empty while pcsx returns
        // real jobs) -- the OLD code only ever fell back to pcsx on a 403, so these
        // tenants would silently ingest zero jobs forever. Falls back on EITHER
        // signal now, but only on page 0 -- a later page legitimately running out
        // of results on an already-working tier must not re-trigger a switch.
        const smartapplyEmpty = tier === 'smartapply' && page === 0 && res.status === 200 && data && Array.isArray(data.positions) && data.positions.length === 0;
        if (tier === 'smartapply' && (res.status === 403 || smartapplyEmpty)) {
          tier = 'pcsx';
          path = '/api/pcsx/search?' + qs;
          res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });
          try { data = JSON.parse(res.body); } catch (e) { data = null; }
        }
        if (res.status !== 200 || !data) break;
        ok = true;
        const positions = (tier === 'pcsx' ? ((data.data && data.data.positions) || []) : (data.positions || []));
        if (!positions.length) break;
        for (const j of positions) {
          rows.push({
            company_id: company.company_id, board: company.board,
            external_id: String(j.ats_job_id || j.displayJobId || j.atsJobId || j.id || ''),
            title: j.name || '',
            jd_text: strip(j.job_description || ''),
            location: Array.isArray(j.locations) ? j.locations.filter(Boolean).join(' | ') : (j.location || ''),
            remote: /remote/i.test(String(j.work_location_option || j.workLocationOption || '')),
            apply_url: j.canonicalPositionUrl || j.positionUrl || ('https://' + host + '/careers/job/' + (j.id || '')),
            posted_at: j.t_create ? iso(j.t_create * 1000) : null,
          });
        }
        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
      }
      return { rows, ok };
    }


    async function fetchAvature(company) {
      const tenant = String(company.slug || '');
      // s73: slug doubles as a host override when it contains a dot -- Two Sigma
      // sits behind a custom domain (careers.twosigma.com) whose raw Avature
      // tenant origin 404s directly, so the real fetch must target the custom
      // domain. Bare tenant prefixes (ibmglobal, bloomberg) never contain a dot,
      // so this is fully backward compatible.
      if (!tenant) return { rows: [], ok: false };
      const host = tenant.indexOf('.') !== -1 ? tenant : tenant + '.avature.net';
      // s73: api_base doubles as "portalPath[/listingPage]" -- everyone except
      // Two Sigma keeps the default SearchJobs; Two Sigma's real listing page is
      // named OpenRoles instead.
      const apiBaseParts = String(company.api_base || 'careers').split('/');
      const portalUrlPath = apiBaseParts[0] || 'careers';
      const listingPage = apiBaseParts[1] || 'SearchJobs';
      const REQUEST_SIZE = 50, MAX_PAGES = 10;
      let ok = false, useLocale = true, offset = 0;
      const rows = [];
      const pathFor = (withLocale) => (withLocale ? '/en_US/' : '/') + portalUrlPath + '/' + listingPage + '?jobRecordsPerPage=' + REQUEST_SIZE + '&jobOffset=' + offset;
      for (let page = 0; page < MAX_PAGES; page++) {
        let res = await httpFetch(host, pathFor(useLocale), 'GET', { Accept: 'text/html' });
        if (page === 0 && (!res.body || res.body.indexOf('LanguageManager::redirectToUrl') !== -1)) {
          // this tenant's Avature template doesn't want the /en_US/ locale prefix --
          // verified live on 2 real tenants with opposite conventions (IBM needs it,
          // Bloomberg doesn't) -- auto-retry the other way rather than hardcode one.
          useLocale = false;
          res = await httpFetch(host, pathFor(useLocale), 'GET', { Accept: 'text/html' });
        }
        if (res.status !== 200 && res.status !== 301 && res.status !== 302) break;
        if (!res.body || res.body.indexOf('LanguageManager::redirectToUrl') !== -1) break;
        ok = true;
        // s73: two known card templates. article--card (IBM) with query-style
        // ?jobId=N links; article--result (Bloomberg, Two Sigma -- confirmed
        // identical between the two live tenants) with path-style
        // /JobDetail/<slug>/<id> links. Try card first (unchanged IBM behavior),
        // fall back to result only when card yields nothing.
        let blocks = res.body.split('<article class="article article--card').slice(1);
        let resultStyle = false;
        if (!blocks.length) {
          blocks = res.body.split('<article class="article article--result').slice(1);
          resultStyle = true;
        }
        // s72: jobRecordsPerPage is NOT honored by every tenant -- confirmed live on
        // IBM, whose real per-page render is a fixed ~9 regardless of the 50
        // requested. A short page is therefore NOT a reliable "last page" signal --
        // the only one that is: a genuinely EMPTY page. Advance offset by however
        // many rows actually came back, never by the requested (possibly-ignored)
        // page size, or real content gets silently skipped.
        if (!blocks.length) break;
        for (const b of blocks) {
          let external_id, title, location, apply_url;
          if (!resultStyle) {
            // v1 scope, explicit and disclosed: query-style JobDetail links only,
            // verified live on IBM.
            const jidM = b.match(/JobDetail\?jobId=(\d+)/);
            if (!jidM) continue;
            const titleM = b.match(/article__header__text__title[^>]*>\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/);
            const locM = b.match(/card-item-location">([^<]*)<\/span>/);
            external_id = jidM[1];
            title = (titleM ? titleM[1] : '').replace(/\s+/g, ' ').trim();
            location = (locM ? locM[1] : '').replace(/\s+/g, ' ').trim();
            apply_url = 'https://' + host + (useLocale ? '/en_US/' : '/') + portalUrlPath + '/JobDetail?jobId=' + external_id;
          } else {
            // s73: article--result template. The title link is already a complete
            // absolute URL -- use it as-is rather than reconstructing, and pull the
            // numeric id off its own trailing path segment.
            const hrefM = b.match(/href="(https:\/\/[^"]+)"/);
            if (!hrefM) continue;
            const idM = hrefM[1].match(/\/(\d+)(?:[?#]|$)/);
            if (!idM) continue;
            const titleM = b.match(/article__header__text__title[^>]*>\s*<a[^>]*>\s*([^<]+?)\s*<\/a>/);
            // list-item-location covers Bloomberg; Two Sigma uses a differently-named
            // span for location -- v2 scope, explicitly disclosed: location comes back
            // empty for Two Sigma rather than guessed, same "unknown, never guessed"
            // policy this codebase already applies everywhere else.
            const locM = b.match(/list-item-location">([^<]*)<\/span>/);
            external_id = idM[1];
            title = (titleM ? titleM[1] : '').replace(/\s+/g, ' ').trim();
            location = (locM ? locM[1] : '').replace(/\s+/g, ' ').trim();
            apply_url = hrefM[1];
          }
          rows.push({
            company_id: company.company_id, board: company.board,
            external_id, title, jd_text: '', location,
            remote: isRemote(location + ' ' + title),
            apply_url, posted_at: null,
          });
        }
        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
        offset += blocks.length;
      }
      return { rows, ok };
    }

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
        const idM = c.match(/ssk='(?:\d+:)?(\d+)'/);
        const hrefM = c.match(/href="(jobs\/results\/[^"?]+)/);
        if (!idM || !hrefM) continue;
        const external_id = idM[1];
        if (seenIds.has(external_id)) continue;
        seenIds.add(external_id);
        const titleM = c.match(/<h3 class="QJPWVe">([^<]+)<\/h3>/);
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

    async function fetchDEShaw(company) {
  // s115: plain GET, no search term needed (unlike Google) -- the whole
  // dataset ships on first load. __NEXT_DATA__ blob is large (~1.47MB),
  // needs the raised capOverride.
  const res = await httpFetch('www.deshaw.com', '/careers', 'GET', { Accept: 'text/html' }, null, 2000000);
  if (res.status !== 200 || !res.body) return { rows: [], ok: false };
  const m = res.body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
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

    async function fetchMicrosoft(company) {
  let fcKey = '';
  try { fcKey = $('Load Firecrawl Key').first().json.firecrawl_key || ''; } catch (e) {}
  if (!fcKey) return { rows: [], ok: false };
  const MAX_PAGES = 2;
  const rows = [];
  const seenIds = new Set();
  let ok = false;
  const cardRx = /\[([^\]]+)\]\((https:\/\/apply\.careers\.microsoft\.com\/careers\/job\/(\d+))[^)]*\)/g;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const targetUrl = 'https://jobs.careers.microsoft.com/global/en/search?q=software+engineer&pg=' + page;
    const reqBody = JSON.stringify({ url: targetUrl, formats: ['markdown'] });
    const res = await httpFetch('api.firecrawl.dev', '/v1/scrape', 'POST', { 'Content-Type': 'application/json', Authorization: 'Bearer ' + fcKey }, reqBody, 2000000);
    if (res.status !== 200) break;
    let data;
    try { data = JSON.parse(res.body); } catch (e) { break; }
    if (!data.success || !data.data || !data.data.markdown) break;
    ok = true;
    const md = data.data.markdown;
    let m;
    let pageCount = 0;
    cardRx.lastIndex = 0;
    while ((m = cardRx.exec(md))) {
      const id = m[3];
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      pageCount++;
      const parts = m[1].split(/\\+\s*\n\s*\\+\s*\n/).map((s) => s.trim()).filter(Boolean);
      const title = parts[0] || '';
      const location = parts[1] || '';
      rows.push({
        company_id: company.company_id, board: company.board,
        external_id: id, title, jd_text: '', location,
        remote: isRemote(location + ' ' + title),
        apply_url: m[2],
        posted_at: null,
      });
    }
    if (!pageCount) break;
    if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
  }
  return { rows, ok };
}

    async function fetchOne(company) {
      if (company.ats_type === 'workday') return fetchWorkday(company);
      if (company.ats_type === 'apple') return fetchApple(company);
      if (company.ats_type === 'eightfold') return fetchEightfold(company);
      if (company.ats_type === 'avature') return fetchAvature(company);
      if (company.ats_type === 'google') return fetchGoogle(company);
      if (company.ats_type === 'deshaw') return fetchDEShaw(company);
      if (company.ats_type === 'microsoft') return fetchMicrosoft(company);
      return { rows: [], ok: false };
    }

    const results = await Promise.all(selfFetchCompanies.map((c) => Promise.race([fetchOne(c).catch(() => ({ rows: [], ok: false })), wait(20000, { rows: [], ok: false })])));
    const selfFetchOutcomes = {};
    for (let i = 0; i < results.length; i++) {
      const c = selfFetchCompanies[i];
      const { rows, ok } = results[i];
      selfFetchOutcomes[c.board] = { ok, count: rows.length };
      for (const r of rows) push(r.board, r);
    }
    $getWorkflowStaticData('global').self_fetch_outcomes = selfFetchOutcomes;
  } catch (e) {} // require('https') unavailable or unexpected failure -- degrade to whatever the sync pass already found
}

// s105: was $getWorkflowStaticData('global').name_backfills = nameBackfills,
// read back via an invalid $getWorkflowStaticData(...) call inside Backfill
// Company Names' queryReplacement expression -- that global only exists on
// `this` inside a Code node, never as a real symbol in the n8n expression
// sandbox that powers ={{ }} fields elsewhere (confirmed against the
// installed n8n-workflow package). Every tick with >=1 job crashed there
// since s95 shipped. Fix: ride the payload out on this node's own OUTPUT
// instead, same pattern Advance Poll State/Penalize Failed Boards already
// use for Tick Bookkeeping's fields ($('Node').first().json.x).
const _nameBackfillsJson = JSON.stringify(nameBackfills);

return jobs.map(j => ({ json: Object.assign({}, j, { embed_input: ((j.title || '') + '\n' + (j.jd_text || '')).slice(0, 8000), _name_backfills_json: _nameBackfillsJson }) }));
