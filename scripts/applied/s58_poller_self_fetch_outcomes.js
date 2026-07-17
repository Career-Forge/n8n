/**
 * s58_poller_self_fetch_outcomes.js -- v9 wave Area B1: fix a real, active-clock bug
 * in the poller's self-fetch adapters (workday/apple/eightfold).
 *
 * `Tick Bookkeeping` buckets every polled company into okParsed/gone/failed using
 * ONLY `Fetch ATS`'s HTTP status. But workday/apple/eightfold companies don't use
 * Fetch ATS at all -- `Parse Jobs` deliberately ignores Fetch ATS's response for
 * these 3 types and self-fetches via require('https') instead (Fetch ATS's request
 * for them is a designed-to-fail throwaway URL, kept only so the node has "something
 * harmless to GET"). So these 3 board types land in `failed` on EVERY tick regardless
 * of whether their real self-fetch succeeded, and `Penalize Failed Boards`' 5-strike
 * exponential-backoff SQL will silently deactivate a perfectly working company.
 *
 * Fix: `Parse Jobs`' self-fetch functions (fetchWorkday/fetchApple/fetchEightfold)
 * now return `{ rows, ok }` instead of a bare `rows` array -- `ok` is true once the
 * first page's request comes back 200 with parseable JSON (a real "the endpoint
 * responded, zero-postings is a legitimate answer" case is judged the same as a real
 * result; a network failure/timeout/bad-status/malformed-JSON stays `ok:false`). The
 * per-board outcome is written to `$getWorkflowStaticData('global').self_fetch_outcomes`
 * (fresh every run -- no staleness risk, `Tick Bookkeeping` only ever looks up boards that
 * were due and attempted THIS run). `Tick Bookkeeping` reads that map for workday/
 * apple/eightfold companies instead of Fetch ATS's status; every other ats_type's
 * logic is byte-for-byte unchanged. If the outcome map is somehow missing a board
 * (e.g. require('https') itself failed, an edge case that swallows the whole
 * self-fetch pass), Tick Bookkeeping falls back to the old Fetch-ATS-status logic --
 * never worse than today, only better when self-fetch actually ran.
 *
 * Free side effect, no extra change needed: `Close Stale Jobs` already reads
 * `Tick Bookkeeping`'s okParsed list to close postings not seen this run -- once
 * self-fetch successes land there correctly, stale-job closing starts working for
 * these 3 adapter types too.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
];

// ═══ 1. fetchWorkday: track ok, return { rows, ok } ═══
const FW_OLD =
  "    async function fetchWorkday(company) {\n" +
  "      const apiBase = String(company.api_base || '');\n" +
  "      const dot = apiBase.indexOf('.');\n" +
  "      if (dot === -1) return [];\n" +
  "      const tenant = apiBase.slice(0, dot), wdN = apiBase.slice(dot + 1);\n" +
  "      if (!tenant || !wdN || !company.slug) return [];\n" +
  "      const host = tenant + '.' + wdN + '.myworkdayjobs.com';\n" +
  "      const path = '/wday/cxs/' + tenant + '/' + company.slug + '/jobs';\n" +
  "      const LIMIT = 20, MAX_PAGES = 5;\n" +
  "      let cachedTotal = null;\n" +
  "      const rows = [];\n" +
  "      for (let page = 0; page < MAX_PAGES; page++) {\n" +
  "        const offset = page * LIMIT;\n" +
  "        const reqBody = JSON.stringify({ appliedFacets: {}, limit: LIMIT, offset, searchText: '' });\n" +
  "        const res = await httpFetch(host, path, 'POST', { 'Content-Type': 'application/json' }, reqBody);\n" +
  "        if (res.status !== 200) break;\n" +
  "        let data; try { data = JSON.parse(res.body); } catch (e) { break; }\n" +
  "        if (cachedTotal === null) cachedTotal = data.total || 0;\n" +
  "        const postings = data.jobPostings || [];\n" +
  "        if (!postings.length) break;\n" +
  "        for (const j of postings) {\n" +
  "          rows.push({ company_id: company.company_id, board: company.board, external_id: String(j.externalPath || ''), title: j.title || '', jd_text: '', location: j.locationsText || '', remote: /flex|remote/i.test(String(j.remoteType || '')), apply_url: 'https://' + host + '/' + company.slug + (j.externalPath || ''), posted_at: null });\n" +
  "        }\n" +
  "        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;\n" +
  "        if (offset + LIMIT >= cachedTotal) break;\n" +
  "      }\n" +
  "      return rows;\n" +
  "    }";
const FW_NEW =
  "    async function fetchWorkday(company) {\n" +
  "      const apiBase = String(company.api_base || '');\n" +
  "      const dot = apiBase.indexOf('.');\n" +
  "      if (dot === -1) return { rows: [], ok: false };\n" +
  "      const tenant = apiBase.slice(0, dot), wdN = apiBase.slice(dot + 1);\n" +
  "      if (!tenant || !wdN || !company.slug) return { rows: [], ok: false };\n" +
  "      const host = tenant + '.' + wdN + '.myworkdayjobs.com';\n" +
  "      const path = '/wday/cxs/' + tenant + '/' + company.slug + '/jobs';\n" +
  "      const LIMIT = 20, MAX_PAGES = 5;\n" +
  "      let cachedTotal = null;\n" +
  "      const rows = [];\n" +
  "      let ok = false;\n" +
  "      for (let page = 0; page < MAX_PAGES; page++) {\n" +
  "        const offset = page * LIMIT;\n" +
  "        const reqBody = JSON.stringify({ appliedFacets: {}, limit: LIMIT, offset, searchText: '' });\n" +
  "        const res = await httpFetch(host, path, 'POST', { 'Content-Type': 'application/json' }, reqBody);\n" +
  "        if (res.status !== 200) break;\n" +
  "        let data; try { data = JSON.parse(res.body); } catch (e) { break; }\n" +
  "        ok = true;\n" +
  "        if (cachedTotal === null) cachedTotal = data.total || 0;\n" +
  "        const postings = data.jobPostings || [];\n" +
  "        if (!postings.length) break;\n" +
  "        for (const j of postings) {\n" +
  "          rows.push({ company_id: company.company_id, board: company.board, external_id: String(j.externalPath || ''), title: j.title || '', jd_text: '', location: j.locationsText || '', remote: /flex|remote/i.test(String(j.remoteType || '')), apply_url: 'https://' + host + '/' + company.slug + (j.externalPath || ''), posted_at: null });\n" +
  "        }\n" +
  "        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;\n" +
  "        if (offset + LIMIT >= cachedTotal) break;\n" +
  "      }\n" +
  "      return { rows, ok };\n" +
  "    }";

// ═══ 2. fetchApple: track ok, return { rows, ok } ═══
const FA_OLD =
  "    async function fetchApple(company) {\n" +
  "      const LIMIT_PAGES = 5;\n" +
  "      const rows = [];\n" +
  "      for (let page = 1; page <= LIMIT_PAGES; page++) {\n" +
  "        const reqBody = JSON.stringify({ query: '', locale: 'en-us', sort: 'newest', filters: {}, page, format: 'json' });\n" +
  "        const res = await httpFetch('jobs.apple.com', '/api/v1/search', 'POST', { 'Content-Type': 'application/json' }, reqBody);\n" +
  "        if (res.status !== 200) break;\n" +
  "        let data; try { data = JSON.parse(res.body); } catch (e) { break; }\n" +
  "        const results = (data.res && data.res.searchResults) || [];\n" +
  "        if (!results.length) break;\n" +
  "        for (const j of results) {\n" +
  "          const locs = (j.locations || []).map((l) => [l.city, l.stateProvince, l.countryName].filter(Boolean).join(', ')).filter(Boolean).join(' | ');\n" +
  "          rows.push({ company_id: company.company_id, board: company.board, external_id: String(j.positionId || j.id || ''), title: j.postingTitle || '', jd_text: strip(j.jobSummary || ''), location: locs, remote: !!j.homeOffice, apply_url: 'https://jobs.apple.com/en-us/details/' + (j.positionId || '') + '/' + slugifyTitle(j.postingTitle), posted_at: iso(j.postingDate || j.postDateInGMT) });\n" +
  "        }\n" +
  "        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;\n" +
  "        if (results.length < 20) break; // short of a full page -- no more results\n" +
  "      }\n" +
  "      return rows;\n" +
  "    }";
const FA_NEW =
  "    async function fetchApple(company) {\n" +
  "      const LIMIT_PAGES = 5;\n" +
  "      const rows = [];\n" +
  "      let ok = false;\n" +
  "      for (let page = 1; page <= LIMIT_PAGES; page++) {\n" +
  "        const reqBody = JSON.stringify({ query: '', locale: 'en-us', sort: 'newest', filters: {}, page, format: 'json' });\n" +
  "        const res = await httpFetch('jobs.apple.com', '/api/v1/search', 'POST', { 'Content-Type': 'application/json' }, reqBody);\n" +
  "        if (res.status !== 200) break;\n" +
  "        let data; try { data = JSON.parse(res.body); } catch (e) { break; }\n" +
  "        ok = true;\n" +
  "        const results = (data.res && data.res.searchResults) || [];\n" +
  "        if (!results.length) break;\n" +
  "        for (const j of results) {\n" +
  "          const locs = (j.locations || []).map((l) => [l.city, l.stateProvince, l.countryName].filter(Boolean).join(', ')).filter(Boolean).join(' | ');\n" +
  "          rows.push({ company_id: company.company_id, board: company.board, external_id: String(j.positionId || j.id || ''), title: j.postingTitle || '', jd_text: strip(j.jobSummary || ''), location: locs, remote: !!j.homeOffice, apply_url: 'https://jobs.apple.com/en-us/details/' + (j.positionId || '') + '/' + slugifyTitle(j.postingTitle), posted_at: iso(j.postingDate || j.postDateInGMT) });\n" +
  "        }\n" +
  "        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;\n" +
  "        if (results.length < 20) break; // short of a full page -- no more results\n" +
  "      }\n" +
  "      return { rows, ok };\n" +
  "    }";

// ═══ 3. fetchEightfold: track ok, return { rows, ok } ═══
const FE_OLD =
  "    async function fetchEightfold(company) {\n" +
  "      const host = company.api_base, domain = company.slug;\n" +
  "      if (!host || !domain) return [];\n" +
  "      const LIMIT = 10, MAX_PAGES = 5;\n" +
  "      let tier = 'smartapply';\n" +
  "      const rows = [];\n" +
  "      for (let page = 0; page < MAX_PAGES; page++) {\n" +
  "        const start = page * LIMIT;\n" +
  "        const qs = 'domain=' + encodeURIComponent(domain) + '&start=' + start + '&num=' + LIMIT;\n" +
  "        let path = (tier === 'pcsx' ? '/api/pcsx/search?' : '/api/apply/v2/jobs?') + qs;\n" +
  "        let res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });\n" +
  "        if (tier === 'smartapply' && res.status === 403) {\n" +
  "          tier = 'pcsx';\n" +
  "          path = '/api/pcsx/search?' + qs;\n" +
  "          res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });\n" +
  "        }\n" +
  "        if (res.status !== 200) break;\n" +
  "        let data; try { data = JSON.parse(res.body); } catch (e) { break; }\n" +
  "        const positions = (tier === 'pcsx' ? ((data.data && data.data.positions) || []) : (data.positions || []));\n" +
  "        if (!positions.length) break;\n" +
  "        for (const j of positions) {\n" +
  "          rows.push({\n" +
  "            company_id: company.company_id, board: company.board,\n" +
  "            external_id: String(j.ats_job_id || j.displayJobId || j.atsJobId || j.id || ''),\n" +
  "            title: j.name || '',\n" +
  "            jd_text: strip(j.job_description || ''),\n" +
  "            location: Array.isArray(j.locations) ? j.locations.filter(Boolean).join(' | ') : (j.location || ''),\n" +
  "            remote: /remote/i.test(String(j.work_location_option || j.workLocationOption || '')),\n" +
  "            apply_url: j.canonicalPositionUrl || j.positionUrl || ('https://' + host + '/careers/job/' + (j.id || '')),\n" +
  "            posted_at: j.t_create ? iso(j.t_create * 1000) : null,\n" +
  "          });\n" +
  "        }\n" +
  "        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;\n" +
  "      }\n" +
  "      return rows;\n" +
  "    }";
const FE_NEW =
  "    async function fetchEightfold(company) {\n" +
  "      const host = company.api_base, domain = company.slug;\n" +
  "      if (!host || !domain) return { rows: [], ok: false };\n" +
  "      const LIMIT = 10, MAX_PAGES = 5;\n" +
  "      let tier = 'smartapply';\n" +
  "      const rows = [];\n" +
  "      let ok = false;\n" +
  "      for (let page = 0; page < MAX_PAGES; page++) {\n" +
  "        const start = page * LIMIT;\n" +
  "        const qs = 'domain=' + encodeURIComponent(domain) + '&start=' + start + '&num=' + LIMIT;\n" +
  "        let path = (tier === 'pcsx' ? '/api/pcsx/search?' : '/api/apply/v2/jobs?') + qs;\n" +
  "        let res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });\n" +
  "        if (tier === 'smartapply' && res.status === 403) {\n" +
  "          tier = 'pcsx';\n" +
  "          path = '/api/pcsx/search?' + qs;\n" +
  "          res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });\n" +
  "        }\n" +
  "        if (res.status !== 200) break;\n" +
  "        let data; try { data = JSON.parse(res.body); } catch (e) { break; }\n" +
  "        ok = true;\n" +
  "        const positions = (tier === 'pcsx' ? ((data.data && data.data.positions) || []) : (data.positions || []));\n" +
  "        if (!positions.length) break;\n" +
  "        for (const j of positions) {\n" +
  "          rows.push({\n" +
  "            company_id: company.company_id, board: company.board,\n" +
  "            external_id: String(j.ats_job_id || j.displayJobId || j.atsJobId || j.id || ''),\n" +
  "            title: j.name || '',\n" +
  "            jd_text: strip(j.job_description || ''),\n" +
  "            location: Array.isArray(j.locations) ? j.locations.filter(Boolean).join(' | ') : (j.location || ''),\n" +
  "            remote: /remote/i.test(String(j.work_location_option || j.workLocationOption || '')),\n" +
  "            apply_url: j.canonicalPositionUrl || j.positionUrl || ('https://' + host + '/careers/job/' + (j.id || '')),\n" +
  "            posted_at: j.t_create ? iso(j.t_create * 1000) : null,\n" +
  "          });\n" +
  "        }\n" +
  "        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;\n" +
  "      }\n" +
  "      return { rows, ok };\n" +
  "    }";

// ═══ 4. fetchOne: fallback shape ═══
const FO_OLD =
  "    async function fetchOne(company) {\n" +
  "      if (company.ats_type === 'workday') return fetchWorkday(company);\n" +
  "      if (company.ats_type === 'apple') return fetchApple(company);\n" +
  "      if (company.ats_type === 'eightfold') return fetchEightfold(company);\n" +
  "      return [];\n" +
  "    }";
const FO_NEW =
  "    async function fetchOne(company) {\n" +
  "      if (company.ats_type === 'workday') return fetchWorkday(company);\n" +
  "      if (company.ats_type === 'apple') return fetchApple(company);\n" +
  "      if (company.ats_type === 'eightfold') return fetchEightfold(company);\n" +
  "      return { rows: [], ok: false };\n" +
  "    }";

// ═══ 5. Aggregation: build + persist the per-board outcome map ═══
const AGG_OLD =
  "    const results = await Promise.all(selfFetchCompanies.map((c) => Promise.race([fetchOne(c).catch(() => []), wait(20000, [])])));\n" +
  "    for (const rows of results) for (const r of rows) push(r.board, r);\n" +
  "  } catch (e) {} // require('https') unavailable or unexpected failure -- degrade to whatever the sync pass already found";
const AGG_NEW =
  "    const results = await Promise.all(selfFetchCompanies.map((c) => Promise.race([fetchOne(c).catch(() => ({ rows: [], ok: false })), wait(20000, { rows: [], ok: false })])));\n" +
  "    const selfFetchOutcomes = {};\n" +
  "    for (let i = 0; i < results.length; i++) {\n" +
  "      const c = selfFetchCompanies[i];\n" +
  "      const { rows, ok } = results[i];\n" +
  "      selfFetchOutcomes[c.board] = { ok, count: rows.length };\n" +
  "      for (const r of rows) push(r.board, r);\n" +
  "    }\n" +
  "    $getWorkflowStaticData('global').self_fetch_outcomes = selfFetchOutcomes;\n" +
  "  } catch (e) {} // require('https') unavailable or unexpected failure -- degrade to whatever the sync pass already found";

// ═══ 6. Tick Bookkeeping: read the outcome map for self-fetch types ═══
const TB_OLD =
  "const relByBoard = {};\n" +
  "for (const it of $('Parse Jobs').all()) { const b = it.json.board; relByBoard[b] = (relByBoard[b] || 0) + 1; }\n" +
  "const okParsed = [], okEtag = [], gone = [], failed = [];\n" +
  "for (let i = 0; i < reqs.length; i++) {\n" +
  "  const board = reqs[i].json.board;\n" +
  "  const R = respOf(resps[i]);\n" +
  "  const status = statusOf(R);\n" +
  "  if (status === 304) { okEtag.push({ board: board, etag: null, relevant: -1 }); continue; }\n" +
  "  if (status === 404 || status === 410) { gone.push(board); continue; }\n" +
  "  const body = bodyOf(R);\n" +
  "  if (status >= 200 && status < 300 && body) {\n" +
  "    let parsed = null;\n" +
  "    try { parsed = JSON.parse(body); } catch (e) {}\n" +
  "    if (parsed && !parsed.error) {\n" +
  "      okParsed.push(board);\n" +
  "      okEtag.push({ board: board, etag: etagOf(R) || null, relevant: relByBoard[board] || 0 });\n" +
  "      continue;\n" +
  "    }\n" +
  "  }\n" +
  "  failed.push(board);\n" +
  "}";
const TB_NEW =
  "const relByBoard = {};\n" +
  "for (const it of $('Parse Jobs').all()) { const b = it.json.board; relByBoard[b] = (relByBoard[b] || 0) + 1; }\n" +
  "// s58: workday/apple/eightfold self-fetch via Parse Jobs' own require('https') calls --\n" +
  "// Fetch ATS's response for these 3 types is a designed-to-fail throwaway URL (Parse\n" +
  "// Jobs ignores it entirely), so judging them on Fetch ATS status penalized every\n" +
  "// working self-fetch board on every tick. Read Parse Jobs' real outcome instead;\n" +
  "// fall back to the old Fetch-ATS-status logic if the outcome map is missing an entry.\n" +
  "const SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold']);\n" +
  "const selfFetchOutcomes = $getWorkflowStaticData('global').self_fetch_outcomes || {};\n" +
  "const okParsed = [], okEtag = [], gone = [], failed = [];\n" +
  "for (let i = 0; i < reqs.length; i++) {\n" +
  "  const board = reqs[i].json.board;\n" +
  "  const atsType = reqs[i].json.ats_type;\n" +
  "  if (SELF_FETCH_TYPES.has(atsType) && Object.prototype.hasOwnProperty.call(selfFetchOutcomes, board)) {\n" +
  "    const outcome = selfFetchOutcomes[board];\n" +
  "    if (outcome.ok) {\n" +
  "      okParsed.push(board);\n" +
  "      okEtag.push({ board: board, etag: null, relevant: relByBoard[board] || 0 });\n" +
  "    } else {\n" +
  "      failed.push(board);\n" +
  "    }\n" +
  "    continue;\n" +
  "  }\n" +
  "  const R = respOf(resps[i]);\n" +
  "  const status = statusOf(R);\n" +
  "  if (status === 304) { okEtag.push({ board: board, etag: null, relevant: -1 }); continue; }\n" +
  "  if (status === 404 || status === 410) { gone.push(board); continue; }\n" +
  "  const body = bodyOf(R);\n" +
  "  if (status >= 200 && status < 300 && body) {\n" +
  "    let parsed = null;\n" +
  "    try { parsed = JSON.parse(body); } catch (e) {}\n" +
  "    if (parsed && !parsed.error) {\n" +
  "      okParsed.push(board);\n" +
  "      okEtag.push({ board: board, etag: etagOf(R) || null, relevant: relByBoard[board] || 0 });\n" +
  "      continue;\n" +
  "    }\n" +
  "  }\n" +
  "  failed.push(board);\n" +
  "}";

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

  for (const need of ['Parse Jobs', 'Tick Bookkeeping', 'Build Requests', 'Fetch ATS']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Tick Bookkeeping'].parameters.jsCode.includes('SELF_FETCH_TYPES')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', FW_OLD, FW_NEW, 'fetchWorkday {rows,ok}', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', FA_OLD, FA_NEW, 'fetchApple {rows,ok}', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', FE_OLD, FE_NEW, 'fetchEightfold {rows,ok}', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', FO_OLD, FO_NEW, 'fetchOne fallback shape', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', AGG_OLD, AGG_NEW, 'self-fetch outcome map', base);
  replaceOnce(N['Tick Bookkeeping'].parameters, 'jsCode', TB_OLD, TB_NEW, 'Tick Bookkeeping self-fetch branch', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: self-fetch outcome tracking wired -- ${wf.nodes.length} nodes`);
}

// ── harness (async IIFE, top-level-await style -- every check below must complete
// and be asserted BEFORE any file is touched, so all async checks are awaited) ──
(async function harness() {
  // 1. fetchWorkday shape: success (200 + parseable, some postings) -> ok:true, rows populated.
  //    Failure (non-200 on first page) -> ok:false, rows empty. Malformed company row -> ok:false.
  {
    const TITLE_RX = /engineer/i;
    const CAP = 25;
    async function httpFetchOk() { return { status: 200, body: JSON.stringify({ total: 1, jobPostings: [{ title: 'Software Engineer', externalPath: '/job/1' }] }) }; }
    async function httpFetchFail() { return { status: 500, body: '' }; }
    async function httpFetchBadJson() { return { status: 200, body: 'not json' }; }
    const fn = (httpFetch) => new Function('httpFetch', 'TITLE_RX', 'CAP', FW_NEW.replace('async function fetchWorkday', 'return async function fetchWorkday'))(httpFetch, TITLE_RX, CAP);
    const ok = fn(httpFetchOk);
    const fail = fn(httpFetchFail);
    const badJson = fn(httpFetchBadJson);
    const [r1, r2, r3] = await Promise.all([
      ok({ company_id: 1, board: 'b1', api_base: 'acme.wd5', slug: 'careers' }),
      fail({ company_id: 2, board: 'b2', api_base: 'acme.wd5', slug: 'careers' }),
      badJson({ company_id: 3, board: 'b3', api_base: 'acme.wd5', slug: 'careers' }),
    ]);
    if (!r1.ok || r1.rows.length !== 1) { console.error('HARNESS FAIL: fetchWorkday success case should be ok:true with 1 row', r1); process.exit(1); }
    if (r2.ok !== false || r2.rows.length !== 0) { console.error('HARNESS FAIL: fetchWorkday non-200 should be ok:false', r2); process.exit(1); }
    if (r3.ok !== false) { console.error('HARNESS FAIL: fetchWorkday bad JSON should be ok:false', r3); process.exit(1); }
    const malformed = fn(httpFetchOk);
    const r4 = await malformed({ company_id: 4, board: 'b4', api_base: 'noversion', slug: 'careers' });
    if (r4.ok !== false) { console.error('HARNESS FAIL: fetchWorkday malformed api_base should be ok:false', r4); process.exit(1); }
    console.log('HARNESS OK: fetchWorkday returns {rows,ok} correctly for success/failure/bad-JSON/malformed-config');
  }

  // 2. Aggregation: Promise.race timeout resolves to {rows:[],ok:false}, per-board outcome map built correctly.
  {
    const wait = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
    const fetchOne = (c) => c.slow ? new Promise(() => {}) /* never resolves within the race window */ : Promise.resolve(c.fail ? { rows: [], ok: false } : { rows: [{ x: 1 }], ok: true });
    const selfFetchCompanies = [{ board: 'fast-ok', fail: false }, { board: 'fast-fail', fail: true }, { board: 'slow-timeout', slow: true }];
    const results = await Promise.all(selfFetchCompanies.map((c) => Promise.race([fetchOne(c).catch(() => ({ rows: [], ok: false })), wait(50, { rows: [], ok: false })])));
    const selfFetchOutcomes = {};
    for (let i = 0; i < results.length; i++) { const c = selfFetchCompanies[i]; const { rows, ok } = results[i]; selfFetchOutcomes[c.board] = { ok, count: rows.length }; }
    if (!selfFetchOutcomes['fast-ok'].ok || selfFetchOutcomes['fast-ok'].count !== 1) { console.error('HARNESS FAIL: fast-ok should be ok:true, count:1', selfFetchOutcomes); process.exit(1); }
    if (selfFetchOutcomes['fast-fail'].ok !== false) { console.error('HARNESS FAIL: fast-fail should be ok:false', selfFetchOutcomes); process.exit(1); }
    if (selfFetchOutcomes['slow-timeout'].ok !== false) { console.error('HARNESS FAIL: slow-timeout should degrade to ok:false via the race, not hang', selfFetchOutcomes); process.exit(1); }
    console.log('HARNESS OK: aggregation builds a correct per-board outcome map, timeout branch resolves to ok:false instead of looking like a legitimate empty result');
  }

  // 3. Tick Bookkeeping: self-fetch ok:true -> okParsed; ok:false -> failed; missing entry -> old Fetch-ATS-status fallback; non-self-fetch untouched.
  {
    function run(reqs, resps, outcomes, parseJobsItems) {
      const $ = (name) => ({
        all: () => (name === 'Build Requests' ? reqs : name === 'Fetch ATS' ? resps : name === 'Parse Jobs' ? parseJobsItems : []),
      });
      const $getWorkflowStaticData = () => ({ self_fetch_outcomes: outcomes });
      const $ctx = { Run_Start: { run_start: 't0' } };
      const body =
        "const respOf = (it) => (it || {}).json || {};\n" +
        "const statusOf = (R) => R.statusCode ?? (R.error ? 0 : ((typeof R.body === 'string' || typeof R.data === 'string') ? 200 : 0));\n" +
        "const bodyOf = (R) => typeof R.body === 'string' ? R.body : (typeof R.data === 'string' ? R.data : null);\n" +
        "const etagOf = (R) => { const h = R.headers || {}; return h.etag || h.ETag || h.Etag || ''; };\n" +
        "const reqs = $('Build Requests').all();\n" +
        "const resps = $('Fetch ATS').all();\n" +
        "const run_start = 't0';\n" +
        TB_NEW +
        "\nreturn { okParsed, gone, failed };";
      return new Function('$', '$getWorkflowStaticData', body)($, $getWorkflowStaticData);
    }
    const reqs = [
      { json: { board: 'wd-board', ats_type: 'workday' } },
      { json: { board: 'wd-board-fail', ats_type: 'workday' } },
      { json: { board: 'wd-board-nomap', ats_type: 'workday' } },
      { json: { board: 'gh-board', ats_type: 'greenhouse' } },
    ];
    const resps = [
      { json: { statusCode: 500, body: '' } }, // wd-board: throwaway Fetch ATS response, should be IGNORED since outcome map has it
      { json: { statusCode: 500, body: '' } }, // wd-board-fail: same, outcome map says ok:false
      { json: { statusCode: 200, body: JSON.stringify({ ok: true }) } }, // wd-board-nomap: no outcome entry -> falls back to THIS Fetch ATS response, which is a success
      { json: { statusCode: 200, body: JSON.stringify({ jobs: [] }) } }, // gh-board: normal greenhouse path, unaffected
    ];
    const outcomes = { 'wd-board': { ok: true, count: 3 }, 'wd-board-fail': { ok: false, count: 0 } };
    const result = run(reqs, resps, outcomes, []);
    if (!result.okParsed.includes('wd-board')) { console.error('HARNESS FAIL: wd-board (outcome ok:true) should be in okParsed despite a failing Fetch ATS response', result); process.exit(1); }
    if (!result.failed.includes('wd-board-fail')) { console.error('HARNESS FAIL: wd-board-fail (outcome ok:false) should be in failed', result); process.exit(1); }
    if (!result.okParsed.includes('wd-board-nomap')) { console.error('HARNESS FAIL: wd-board-nomap (no outcome entry) should fall back to Fetch ATS status, which was a success here', result); process.exit(1); }
    if (!result.okParsed.includes('gh-board')) { console.error('HARNESS FAIL: non-self-fetch board (greenhouse) should be unaffected and still okParsed on a normal 200', result); process.exit(1); }
    console.log('HARNESS OK: Tick Bookkeeping judges self-fetch boards on their real outcome (not the throwaway Fetch ATS status), falls back safely when the outcome map lacks an entry, leaves non-self-fetch boards untouched');
  }
})().then(() => {
  TARGETS.forEach(patch);
  console.log('S58 (poller self-fetch outcome tracking: workday/apple/eightfold judged on their real fetch result, not a throwaway Fetch ATS status) complete.');
}).catch((e) => { console.error('HARNESS FAIL: unexpected error', e); process.exit(1); });
