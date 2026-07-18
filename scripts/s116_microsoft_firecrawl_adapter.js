/**
 * s116_microsoft_firecrawl_adapter.js -- new adapter for Microsoft's
 * careers site, routed through Firecrawl (already a configured provider in
 * this pipeline) instead of a direct fetch.
 *
 * WHY FIRECRAWL, NOT A DIRECT FETCH: investigated thoroughly this session.
 * Microsoft rebuilt their careers portal as a fully client-rendered SPA
 * (jobs.careers.microsoft.com) with NO server-side embedded data (confirmed:
 * the largest inline <script> block on the real page is 1.3KB, nowhere near
 * enough to hold job data -- unlike D.E. Shaw's Next.js page, s115). A blog
 * post actively debugging this exact portal (2025) confirmed the real API
 * calls require bearer-token auth plus X-CorrelationId session headers,
 * both minted by frontend JS during page load -- no static fetch gets a
 * valid token. Firecrawl does real server-side headless rendering, so it
 * naturally clears both bars (JS execution + the resulting authenticated
 * state) via a plain HTTPS call that fits this pipeline's existing
 * require('https') architecture -- confirmed live: a Firecrawl /v1/scrape
 * call against jobs.careers.microsoft.com/global/en/search returns real,
 * clean markdown with actual job cards ("1532 jobs", real titles/locations/
 * ids), where a direct curl to the same URL returns an empty SPA shell.
 * `pg=` pagination confirmed real (page 1 vs page 2 returned 20 disjoint
 * job ids, zero overlap).
 *
 * ROBOTS.TXT CHECKED: jobs.careers.microsoft.com/robots.txt returns empty
 * -- no prohibition on automated collection, unlike Meta (see below).
 *
 * COST-CONSCIOUS BY DESIGN: unlike every other adapter (free public APIs),
 * Firecrawl is credit-metered -- this pipeline's own .env documents it as
 * the paid "scrape-tail," off by default elsewhere. Capped to MAX_PAGES=2
 * per tick (not the full ~1,500-job catalog) to keep steady-state credit
 * burn sane; the poller's existing title-relevance filter (push()) still
 * applies downstream, same as every other adapter.
 *
 * CREDENTIAL WIRING: Code nodes can't read process.env (confirmed by this
 * codebase's own established convention -- see Load Ingest Config/Load Geo
 * Reference, which read secrets from app_settings via a dedicated Postgres
 * node instead) or n8n node credentials directly. Added the Firecrawl API
 * key to app_settings (same table already holding telegraph_token, the
 * Apollo/Hunter budget, geo_reference, ingest_title_filter) and a new
 * "Load Firecrawl Key" Postgres node, spliced into the existing single-
 * connection chain (Load Ingest Config -> Select Due Companies becomes
 * Load Ingest Config -> Load Firecrawl Key -> Select Due Companies), read
 * by Parse Jobs via the same named-reference pattern as every other
 * upstream config node.
 *
 * VERIFY JOB LINKS: deliberately NOT touched. A direct (non-Firecrawl)
 * fetch to a real vs. a bogus Microsoft job id both return 200 (confirmed
 * live) -- no distinguishing signal without another Firecrawl call, and
 * running Firecrawl per-job-verified (not just per-tick) would multiply
 * credit cost far more than the ingest side. Falls through to the existing
 * generic-host fallback, which already defaults to "keep" for an
 * unrecognized host -- consistent with this codebase's "never guess dead"
 * policy. Staleness is still caught by the primary mechanism every adapter
 * relies on: Close Stale Jobs closes anything not seen in the current
 * tick's fetch.
 *
 * +1 node (poller: Load Firecrawl Key). Seeds Microsoft directly as a
 * single hardcoded integration (like Amazon/Apple/Google/D.E. Shaw/Oracle).
 *
 * Run: harness first (real parser against a real captured Firecrawl
 * response fixture), then direct SQL for the app_settings key, standard
 * deploy dance for the workflow changes.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_TARGETS = [path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json')];
const MASTER_TARGETS = [path.join(ROOT, 'workflows', 'CareerForge_Master_local.json')];
const FIXTURE_P1 = path.join(ROOT, 'fixtures', 'firecrawl_microsoft_p1.json');
const SQL_OUT = path.join(ROOT, '.tmp_s116_firecrawl_key.sql');

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ══════════════════════ 1. Build Requests (poller) ══════════════════════
const BR_IMPL_OLD = "IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw'];";
const BR_IMPL_NEW = "IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw', 'microsoft'];";
const BR_URL_OLD = "deshaw:     'https://www.deshaw.com/careers',";
const BR_URL_NEW = "deshaw:     'https://www.deshaw.com/careers',\n  microsoft:  'https://jobs.careers.microsoft.com/global/en/search',";

// ══════════════════════ 2. Parse Jobs (poller) ══════════════════════
const PJ_CONTINUE_OLD = "if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature' || t === 'google' || t === 'deshaw') continue; // self-fetch pass below, Fetch ATS's response for these is discarded";
const PJ_CONTINUE_NEW = "if (t === 'workday' || t === 'apple' || t === 'eightfold' || t === 'avature' || t === 'google' || t === 'deshaw' || t === 'microsoft') continue; // self-fetch pass below, Fetch ATS's response for these is discarded";

const PJ_FILTER_OLD = "const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature' || c.ats_type === 'google' || c.ats_type === 'deshaw');";
const PJ_FILTER_NEW = "const selfFetchCompanies = reqs.map((r) => (r || {}).json || {}).filter((c) => c.ats_type === 'workday' || c.ats_type === 'apple' || c.ats_type === 'eightfold' || c.ats_type === 'avature' || c.ats_type === 'google' || c.ats_type === 'deshaw' || c.ats_type === 'microsoft');";

const FETCH_MICROSOFT_SRC = `
async function fetchMicrosoft(company) {
  let fcKey = '';
  try { fcKey = $('Load Firecrawl Key').first().json.firecrawl_key || ''; } catch (e) {}
  if (!fcKey) return { rows: [], ok: false };
  const MAX_PAGES = 2;
  const rows = [];
  const seenIds = new Set();
  let ok = false;
  const cardRx = /\\[([^\\]]+)\\]\\((https:\\/\\/apply\\.careers\\.microsoft\\.com\\/careers\\/job\\/(\\d+))[^)]*\\)/g;
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
      const parts = m[1].split(/\\\\+\\s*\\n\\s*\\\\+\\s*\\n/).map((s) => s.trim()).filter(Boolean);
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
`.trim();

const PJ_FETCHONE_OLD = "if (company.ats_type === 'deshaw') return fetchDEShaw(company);\n      return { rows: [], ok: false };\n    }";
const PJ_FETCHONE_NEW = "if (company.ats_type === 'deshaw') return fetchDEShaw(company);\n      if (company.ats_type === 'microsoft') return fetchMicrosoft(company);\n      return { rows: [], ok: false };\n    }";

// ══════════════════════ 3. Tick Bookkeeping (poller) ══════════════════════
const TB_OLD = "SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw']);";
const TB_NEW = "SELF_FETCH_TYPES = new Set(['workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw', 'microsoft']);";

// ══════════════════════ 4. classifyUrlTier x3 normalize nodes (master) ══════════════════════
const TIER_OLD = "if (/deshaw\\.com\\/careers/.test(u)) return { tier: 1, label: 'ats:deshaw' };";
const TIER_NEW = "if (/deshaw\\.com\\/careers/.test(u)) return { tier: 1, label: 'ats:deshaw' };\n  if (/apply\\.careers\\.microsoft\\.com\\/careers\\/job/.test(u)) return { tier: 1, label: 'ats:microsoft' };";
const NORMALIZE_NODES = ['Normalize You.com results', 'Normalize Serper results', 'Normalize Firecrawl Results'];

// ══════════════════════ 5. Load Firecrawl Key node (poller, graph edit) ══════════════════════
function insertFirecrawlKeyNode(wf) {
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  if (N['Load Firecrawl Key']) return false; // already inserted
  const loadIngest = N['Load Ingest Config'];
  if (!loadIngest) { console.error('INTEGRITY FAIL: Load Ingest Config not found'); process.exit(1); }

  const newNode = {
    id: 'f1cec4a0-' + Math.random().toString(16).slice(2, 6) + '-4a0f-9c1e-' + Math.random().toString(16).slice(2, 14),
    name: 'Load Firecrawl Key',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [loadIngest.position[0] + 140, loadIngest.position[1]],
    parameters: {
      operation: 'executeQuery',
      query: "SELECT value AS firecrawl_key FROM app_settings WHERE key='firecrawl_api_key'",
    },
    credentials: JSON.parse(JSON.stringify(loadIngest.credentials)),
  };
  wf.nodes.push(newNode);

  // splice: Load Ingest Config -> Select Due Companies becomes
  //         Load Ingest Config -> Load Firecrawl Key -> Select Due Companies
  const oldConn = wf.connections['Load Ingest Config'];
  const target = oldConn.main[0][0]; // { node: 'Select Due Companies', type: 'main', index: 0 }
  if (target.node !== 'Select Due Companies') { console.error('INTEGRITY FAIL: Load Ingest Config connection shape unexpected:', JSON.stringify(oldConn)); process.exit(1); }
  wf.connections['Load Ingest Config'] = { main: [[{ node: 'Load Firecrawl Key', type: 'main', index: 0 }]] };
  wf.connections['Load Firecrawl Key'] = { main: [[{ node: 'Select Due Companies', type: 'main', index: 0 }]] };
  return true;
}

function patchPoller(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Build Requests', 'Parse Jobs', 'Tick Bookkeeping', 'Load Ingest Config']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Jobs'].parameters.jsCode.includes('fetchMicrosoft')) { console.log(`  ${base}: already patched`); return; }

  const inserted = insertFirecrawlKeyNode(wf);
  replaceOnce(N['Build Requests'].parameters, 'jsCode', BR_IMPL_OLD, BR_IMPL_NEW, 'IMPLEMENTED list', base);
  replaceOnce(N['Build Requests'].parameters, 'jsCode', BR_URL_OLD, BR_URL_NEW, 'mkUrl microsoft decoy', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_CONTINUE_OLD, PJ_CONTINUE_NEW, 'sync-loop self-fetch skip', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_FILTER_OLD, PJ_FILTER_NEW, 'selfFetchCompanies filter', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', PJ_FETCHONE_OLD, PJ_FETCHONE_NEW, 'fetchOne dispatch', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', "async function fetchOne(company) {", FETCH_MICROSOFT_SRC + "\n\n    async function fetchOne(company) {", 'fetchMicrosoft function insertion', base);
  replaceOnce(N['Tick Bookkeeping'].parameters, 'jsCode', TB_OLD, TB_NEW, 'SELF_FETCH_TYPES', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Microsoft adapter wired (Firecrawl key node ${inserted ? 'inserted' : 'already present'}) -- ${wf.nodes.length} nodes`);
}

function patchMaster(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of NORMALIZE_NODES) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  for (const name of NORMALIZE_NODES) {
    if (N[name].parameters.jsCode.includes('ats:microsoft')) { console.log(`  ${base}: already patched (${name})`); continue; }
    replaceOnce(N[name].parameters, 'jsCode', TIER_OLD, TIER_NEW, `classifyUrlTier microsoft (${name})`, base);
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: 3 normalize nodes wired for microsoft -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  if (!fs.existsSync(FIXTURE_P1)) { console.error('HARNESS FAIL: fixture missing'); process.exit(1); }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_P1, 'utf8'));

  const isRemote = (s) => /remote/i.test(String(s || ''));
  const TITLE_RX = /(machine\s*learning|\bml\b|\bai\b|artificial\s*intelligence|data\s*(scien|engineer|analy|platform)|analytics\s*engineer|deep\s*learning|\bnlp\b|\bllm\b|gen\s*ai|generative|computer\s*vision|research\s*(scientist|engineer)|applied\s*scientist|software\s*engineer|\bswe\b|\bsde\b|backend|back-end|full[\s-]*stack|platform\s*engineer|infrastructure\s*engineer|devops|mlops|\bsre\b)/i;
  const CAP = 25;

  let callCount = 0;
  async function httpFetch(host, p, method, headers, body, capOverride) {
    callCount++;
    if (callCount === 1) return { status: 200, body: JSON.stringify(fixture) };
    return { status: 200, body: JSON.stringify({ success: true, data: { markdown: '' } }) }; // page 2: no more results, keeps the harness fast
  }
  const $ = () => ({ first: () => ({ json: { firecrawl_key: 'test-key-123' } }) });

  const factory = new Function('httpFetch', 'isRemote', 'TITLE_RX', 'CAP', '$', `return (${FETCH_MICROSOFT_SRC});`);
  const fetchMicrosoft = factory(httpFetch, isRemote, TITLE_RX, CAP, $);

  return fetchMicrosoft({ company_id: 999, board: 'microsoft:microsoft' }).then((result) => {
    const { rows, ok } = result;
    if (!ok) { console.error('HARNESS FAIL: fetchMicrosoft reported ok:false against a real fixture'); process.exit(1); }
    if (rows.length < 15) { console.error(`HARNESS FAIL: expected >=15 jobs from the real fixture, got ${rows.length}`); process.exit(1); }
    for (const r of rows) {
      if (!/^\d+$/.test(r.external_id)) { console.error('HARNESS FAIL: non-numeric external_id', r.external_id); process.exit(1); }
      if (!r.title || r.title.length < 3) { console.error('HARNESS FAIL: empty/tiny title', JSON.stringify(r)); process.exit(1); }
      if (!r.apply_url.startsWith('https://apply.careers.microsoft.com/careers/job/')) { console.error('HARNESS FAIL: malformed apply_url', r.apply_url); process.exit(1); }
    }
    const withLoc = rows.filter((r) => r.location).length;
    if (withLoc < rows.length * 0.7) { console.error(`HARNESS FAIL: too many jobs missing location (${withLoc}/${rows.length})`); process.exit(1); }
    const ids = new Set(rows.map((r) => r.external_id));
    if (ids.size !== rows.length) { console.error('HARNESS FAIL: duplicate external_ids'); process.exit(1); }
    if (callCount !== 2) { console.error(`HARNESS FAIL: expected exactly 2 Firecrawl calls (MAX_PAGES), got ${callCount}`); process.exit(1); }

    console.log(`HARNESS OK: fetchMicrosoft extracted ${rows.length} real jobs from a real captured Firecrawl response fixture, all numeric ids, real titles, correct apply_urls, ${withLoc}/${rows.length} with locations, zero duplicates. Confirmed capped at exactly ${callCount} Firecrawl calls (MAX_PAGES), not the full catalog.`);

    // app_settings SQL for the Firecrawl key
    const FC_KEY = require('fs').readFileSync(path.join(ROOT, 'docker', '.env'), 'utf8').match(/^FIRECRAWL_API_KEY=(.+)$/m);
    if (!FC_KEY) { console.error('HARNESS FAIL: could not read FIRECRAWL_API_KEY from docker/.env'); process.exit(1); }
    const keyVal = FC_KEY[1].trim();
    const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const sql = `INSERT INTO app_settings (key, value) VALUES ('firecrawl_api_key', ${esc(keyVal)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`;
    fs.writeFileSync(SQL_OUT, sql);
    console.log(`Wrote ${SQL_OUT}. Run manually:`);
    console.log(`  docker cp ${SQL_OUT} careerforge_postgres:/tmp/fckey.sql && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/fckey.sql`);

    POLLER_TARGETS.forEach(patchPoller);
    MASTER_TARGETS.forEach(patchMaster);
    console.log('S116 (Microsoft Firecrawl adapter) script complete.');
  });
})();
