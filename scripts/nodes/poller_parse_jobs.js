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
const CAP = 25;
const count = {};
const jobs = [];
// FIX (found while adding new adapters, unrelated to this expansion but in the same
// node): this was `new RegExp("... \s ... \b ...")` -- a STRING passed to RegExp,
// where JS string-escape processing silently eats \s (becomes literal "s") and turns
// \b into an actual backspace control character, not a word-boundary token. Verified
// live: the broken version matched ZERO of "Machine Learning Engineer", "AI Engineer",
// "Data Scientist", "NLP Researcher", "Senior Software Engineer", "Deep Learning
// Researcher" -- the poller's relevance filter has been discarding almost every
// genuinely relevant title since this filter was written. A regex LITERAL (below)
// isn't string-escape-processed, so \s and \b reach the regex engine as intended.
const TITLE_RX = /(machine\s*learning|\bml\b|\bai\b|artificial\s*intelligence|data\s*(scien|engineer|analy|platform)|analytics\s*engineer|deep\s*learning|\bnlp\b|\bllm\b|gen\s*ai|generative|computer\s*vision|research\s*(scientist|engineer)|applied\s*scientist|software\s*engineer|\bswe\b|\bsde\b|backend|back-end|full[\s-]*stack|platform\s*engineer|infrastructure\s*engineer|devops|mlops|\bsre\b)/i;
const push = (board, obj) => { if (!TITLE_RX.test(String(obj.title || ''))) return; count[board] = (count[board] || 0); if (count[board] >= CAP) return; count[board]++; jobs.push(obj); };
const dec = s => String(s == null ? '' : s).split('&amp;').join('&').split('&lt;').join('<').split('&gt;').join('>').split('&quot;').join('"').split('&#39;').join("'").split('&#x27;').join("'");
const strip = s => dec(dec(s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const iso = v => { try { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); } catch (e) { return null; } };
const isRemote = s => /remote/i.test(String(s || ''));

for (let i = 0; i < resps.length; i++) {
  const company = (reqs[i] || {}).json || {};
  const t = company.ats_type;
  if (t === 'workday' || t === 'apple' || t === 'eightfold') continue; // self-fetch pass below, Fetch ATS's response for these is discarded
  const R = respOf(resps[i]);
  if (statusOf(R) < 200 || statusOf(R) >= 300) continue;
  let body = null;
  try { body = JSON.parse(bodyOf(R)); } catch (e) { body = null; }
  if (!body || body.error) continue;
  try {
    if (t === 'greenhouse') {
      for (const j of (body.jobs || [])) push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id), title: j.title || '', jd_text: strip(j.content), location: (j.location && j.location.name) || '', remote: isRemote(j.location && j.location.name), apply_url: j.absolute_url || '', posted_at: iso(j.updated_at || j.first_published) });
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
      const list = (body.items && body.items[0] && body.items[0].requisitionList) || [];
      for (const j of list) {
        push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.Id || ''), title: j.Title || '', jd_text: strip(j.ShortDescriptionStr || ''), location: j.PrimaryLocation || j.PrimaryLocationCountry || '', remote: isRemote(j.WorkplaceType || j.WorkplaceTypeCode), apply_url: 'https://careers.oracle.com/en/sites/jobsearch/job/' + (j.Id || '') + '/', posted_at: iso(j.PostedDate) });
      }
    }
  } catch (e) {}
}

// ── self-fetch pass: workday / apple / eightfold, run concurrently, require('https') ──
const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold');
if (selfFetchCompanies.length) {
  try {
    const https = require('https');
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

    function httpFetch(host, path, method, headers, body) {
      return new Promise((resolve) => {
        const r = https.request(
          { method, host, path, timeout: 6000, headers: Object.assign({ 'User-Agent': UA }, headers || {}) },
          (res) => {
            const chunks = []; let size = 0;
            res.on('data', (c) => { size += c.length; if (size < 500000) chunks.push(c); });
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
      if (dot === -1) return [];
      const tenant = apiBase.slice(0, dot), wdN = apiBase.slice(dot + 1);
      if (!tenant || !wdN || !company.slug) return [];
      const host = tenant + '.' + wdN + '.myworkdayjobs.com';
      const path = '/wday/cxs/' + tenant + '/' + company.slug + '/jobs';
      const LIMIT = 20, MAX_PAGES = 5;
      let cachedTotal = null;
      const rows = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * LIMIT;
        const reqBody = JSON.stringify({ appliedFacets: {}, limit: LIMIT, offset, searchText: '' });
        const res = await httpFetch(host, path, 'POST', { 'Content-Type': 'application/json' }, reqBody);
        if (res.status !== 200) break;
        let data; try { data = JSON.parse(res.body); } catch (e) { break; }
        if (cachedTotal === null) cachedTotal = data.total || 0;
        const postings = data.jobPostings || [];
        if (!postings.length) break;
        for (const j of postings) {
          rows.push({ company_id: company.company_id, board: company.board, external_id: String(j.externalPath || ''), title: j.title || '', jd_text: '', location: j.locationsText || '', remote: /flex|remote/i.test(String(j.remoteType || '')), apply_url: 'https://' + host + '/' + company.slug + (j.externalPath || ''), posted_at: null });
        }
        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
        if (offset + LIMIT >= cachedTotal) break;
      }
      return rows;
    }

    function slugifyTitle(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'position'; }
    async function fetchApple(company) {
      const LIMIT_PAGES = 5;
      const rows = [];
      for (let page = 1; page <= LIMIT_PAGES; page++) {
        const reqBody = JSON.stringify({ query: '', locale: 'en-us', sort: 'newest', filters: {}, page, format: 'json' });
        const res = await httpFetch('jobs.apple.com', '/api/v1/search', 'POST', { 'Content-Type': 'application/json' }, reqBody);
        if (res.status !== 200) break;
        let data; try { data = JSON.parse(res.body); } catch (e) { break; }
        const results = (data.res && data.res.searchResults) || [];
        if (!results.length) break;
        for (const j of results) {
          const locs = (j.locations || []).map((l) => [l.city, l.stateProvince, l.countryName].filter(Boolean).join(', ')).filter(Boolean).join(' | ');
          rows.push({ company_id: company.company_id, board: company.board, external_id: String(j.positionId || j.id || ''), title: j.postingTitle || '', jd_text: strip(j.jobSummary || ''), location: locs, remote: !!j.homeOffice, apply_url: 'https://jobs.apple.com/en-us/details/' + (j.positionId || '') + '/' + slugifyTitle(j.postingTitle), posted_at: iso(j.postingDate || j.postDateInGMT) });
        }
        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
        if (results.length < 20) break; // short of a full page -- no more results
      }
      return rows;
    }

    async function fetchEightfold(company) {
      const host = company.api_base, domain = company.slug;
      if (!host || !domain) return [];
      const LIMIT = 10, MAX_PAGES = 5;
      let tier = 'smartapply';
      const rows = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const start = page * LIMIT;
        const qs = 'domain=' + encodeURIComponent(domain) + '&start=' + start + '&num=' + LIMIT;
        let path = (tier === 'pcsx' ? '/api/pcsx/search?' : '/api/apply/v2/jobs?') + qs;
        let res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });
        if (tier === 'smartapply' && res.status === 403) {
          tier = 'pcsx';
          path = '/api/pcsx/search?' + qs;
          res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });
        }
        if (res.status !== 200) break;
        let data; try { data = JSON.parse(res.body); } catch (e) { break; }
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
      return rows;
    }

    async function fetchOne(company) {
      if (company.ats_type === 'workday') return fetchWorkday(company);
      if (company.ats_type === 'apple') return fetchApple(company);
      if (company.ats_type === 'eightfold') return fetchEightfold(company);
      return [];
    }

    const results = await Promise.all(selfFetchCompanies.map((c) => Promise.race([fetchOne(c).catch(() => []), wait(20000, [])])));
    for (const rows of results) for (const r of rows) push(r.board, r);
  } catch (e) {} // require('https') unavailable or unexpected failure -- degrade to whatever the sync pass already found
}

return jobs.map(j => ({ json: Object.assign({}, j, { embed_input: ((j.title || '') + '\n' + (j.jd_text || '')).slice(0, 8000) }) }));
