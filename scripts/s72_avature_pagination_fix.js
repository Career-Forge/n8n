/**
 * s72_avature_pagination_fix.js -- fixes a real bug found while watching IBM's
 * first real poll tick: it succeeded (ok:true, no error, no penalty) but
 * extracted ZERO relevant jobs. Root-caused with live probes, not guessed:
 *
 * fetchAvature's pagination stop condition was `if (blocks.length < LIMIT)
 * break` -- i.e. "a short page means we've reached the end." That assumes
 * jobRecordsPerPage is honored by the tenant. It ISN'T, at least not on IBM:
 * requesting jobRecordsPerPage=50 still returns a fixed ~9 cards per page
 * (confirmed live: IBM's own list-controls legend literally says "10+
 * results" while rendering exactly 9 -- a UI convention, not a real total).
 * So `blocks.length` (9) was always less than `LIMIT` (50), and the adapter
 * broke after page 1 on every single poll -- never seeing anything beyond
 * the first 9 listings.
 *
 * This wasn't cosmetic: sampled jobOffset=0,9,18,27,36,45 live just now --
 * genuinely different jobs at every offset (53 unique across 6 pages, only 1
 * boundary overlap), and 7 of those 53 are real AI/tech-relevant roles that
 * match TITLE_RX (the shared relevance filter every adapter uses) -- e.g.
 * "AI Foundations - Research Scientist", "AI Back-End Engineer". All 7 were
 * invisible to the poller before this fix; IBM's first live poll (2026-07-12
 * 08:01 UTC) landed 0 jobs specifically because page 1 happened to be a
 * repetitive, non-technical Japan campus-hire campaign with zero matches,
 * and the adapter never looked past it.
 *
 * Fix: the only reliable "exhausted" signal is a genuinely EMPTY page
 * (`!blocks.length`), never a length comparison against the requested page
 * size. Offset now advances by however many rows actually came back each
 * page, not by the (possibly-ignored) requested page size -- otherwise
 * incrementing by a phantom 50 while the real page size is 9 would skip most
 * of the listing even with the length-check removed. MAX_PAGES raised 5->10
 * to compensate for real page sizes potentially being much smaller than
 * requested (10 pages x ~9 real items is a more honest budget than 5 pages
 * x an assumed-50 that was never actually delivered).
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
];

const FETCHAVATURE_OLD = `async function fetchAvature(company) {
      const tenant = String(company.slug || '');
      const portalUrlPath = String(company.api_base || 'careers');
      if (!tenant) return { rows: [], ok: false };
      const host = tenant + '.avature.net';
      const LIMIT = 50, MAX_PAGES = 5;
      let ok = false, useLocale = true;
      const rows = [];
      const pathFor = (withLocale, offset) => (withLocale ? '/en_US/' : '/') + portalUrlPath + '/SearchJobs?jobRecordsPerPage=' + LIMIT + '&jobOffset=' + offset;
      for (let page = 0; page < MAX_PAGES; page++) {
        const offset = page * LIMIT;
        let res = await httpFetch(host, pathFor(useLocale, offset), 'GET', { Accept: 'text/html' });
        if (page === 0 && (!res.body || res.body.indexOf('LanguageManager::redirectToUrl') !== -1)) {
          // this tenant's Avature template doesn't want the /en_US/ locale prefix --
          // verified live on 2 real tenants with opposite conventions (IBM needs it,
          // Bloomberg doesn't) -- auto-retry the other way rather than hardcode one.
          useLocale = false;
          res = await httpFetch(host, pathFor(useLocale, offset), 'GET', { Accept: 'text/html' });
        }
        if (res.status !== 200 && res.status !== 301 && res.status !== 302) break;
        if (!res.body || res.body.indexOf('LanguageManager::redirectToUrl') !== -1) break;
        ok = true;
        const blocks = res.body.split('<article class="article article--card').slice(1);
        if (!blocks.length) break;
        for (const b of blocks) {
          // v1 scope, explicit and disclosed: query-style JobDetail links only,
          // verified live on IBM. At least one other real Avature tenant (Bloomberg)
          // uses a path-style JobDetail/<slug>/<id> link instead -- not extracted by
          // this pattern; not seeded here, so this doesn't affect IBM's coverage.
          const jidM = b.match(/JobDetail\\?jobId=(\\d+)/);
          if (!jidM) continue;
          const titleM = b.match(/article__header__text__title[^>]*>\\s*<a[^>]*>\\s*([^<]+?)\\s*<\\/a>/);
          const locM = b.match(/card-item-location">([^<]*)<\\/span>/);
          const title = (titleM ? titleM[1] : '').replace(/\\s+/g, ' ').trim();
          const location = (locM ? locM[1] : '').replace(/\\s+/g, ' ').trim();
          rows.push({
            company_id: company.company_id, board: company.board,
            external_id: jidM[1], title, jd_text: '', location,
            remote: isRemote(location + ' ' + title),
            apply_url: 'https://' + host + (useLocale ? '/en_US/' : '/') + portalUrlPath + '/JobDetail?jobId=' + jidM[1],
            posted_at: null,
          });
        }
        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
        if (blocks.length < LIMIT) break;
      }
      return { rows, ok };
    }`;

const FETCHAVATURE_NEW = `async function fetchAvature(company) {
      const tenant = String(company.slug || '');
      const portalUrlPath = String(company.api_base || 'careers');
      if (!tenant) return { rows: [], ok: false };
      const host = tenant + '.avature.net';
      const REQUEST_SIZE = 50, MAX_PAGES = 10;
      let ok = false, useLocale = true, offset = 0;
      const rows = [];
      const pathFor = (withLocale) => (withLocale ? '/en_US/' : '/') + portalUrlPath + '/SearchJobs?jobRecordsPerPage=' + REQUEST_SIZE + '&jobOffset=' + offset;
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
        const blocks = res.body.split('<article class="article article--card').slice(1);
        // s72: jobRecordsPerPage is NOT honored by every tenant -- confirmed live on
        // IBM, whose real per-page render is a fixed ~9 regardless of the 50
        // requested. A short page is therefore NOT a reliable "last page" signal --
        // the only one that is: a genuinely EMPTY page. Advance offset by however
        // many rows actually came back, never by the requested (possibly-ignored)
        // page size, or real content gets silently skipped.
        if (!blocks.length) break;
        for (const b of blocks) {
          // v1 scope, explicit and disclosed: query-style JobDetail links only,
          // verified live on IBM. At least one other real Avature tenant (Bloomberg)
          // uses a path-style JobDetail/<slug>/<id> link instead -- not extracted by
          // this pattern; not seeded here, so this doesn't affect IBM's coverage.
          const jidM = b.match(/JobDetail\\?jobId=(\\d+)/);
          if (!jidM) continue;
          const titleM = b.match(/article__header__text__title[^>]*>\\s*<a[^>]*>\\s*([^<]+?)\\s*<\\/a>/);
          const locM = b.match(/card-item-location">([^<]*)<\\/span>/);
          const title = (titleM ? titleM[1] : '').replace(/\\s+/g, ' ').trim();
          const location = (locM ? locM[1] : '').replace(/\\s+/g, ' ').trim();
          rows.push({
            company_id: company.company_id, board: company.board,
            external_id: jidM[1], title, jd_text: '', location,
            remote: isRemote(location + ' ' + title),
            apply_url: 'https://' + host + (useLocale ? '/en_US/' : '/') + portalUrlPath + '/JobDetail?jobId=' + jidM[1],
            posted_at: null,
          });
        }
        if (rows.filter((r) => TITLE_RX.test(r.title)).length >= CAP) break;
        offset += blocks.length;
      }
      return { rows, ok };
    }`;

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

  if (!N['Parse Jobs']) { console.error(`INTEGRITY FAIL ${base}: node "Parse Jobs" not found`); process.exit(1); }
  if (N['Parse Jobs'].parameters.jsCode.includes('REQUEST_SIZE')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', FETCHAVATURE_OLD, FETCHAVATURE_NEW, 'fetchAvature pagination fix', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: fetchAvature pagination fixed (real-count-based offset, empty-page-only stop) -- ${wf.nodes.length} nodes`);
}

// ── harness: run the ACTUAL patched function against the REAL IBM pages fetched live this session ──
async function harness() {
  const FIX = path.join('/tmp', 's72_fixtures');
  const pages = {};
  for (const off of [0, 9, 18, 27, 36, 45]) {
    pages[off] = fs.readFileSync(path.join(FIX, `offset_${off}.html`), 'utf8');
  }
  // Page 54+ doesn't exist in our real sample -- simulate genuine exhaustion there.
  const isRemote = (s) => /remote/i.test(String(s || ''));
  const TITLE_RX = /(machine\s*learning|\bml\b|\bai\b|artificial\s*intelligence|data\s*(scien|engineer|analy|platform)|analytics\s*engineer|deep\s*learning|\bnlp\b|\bllm\b|gen\s*ai|generative|computer\s*vision|research\s*(scientist|engineer)|applied\s*scientist|software\s*engineer|\bswe\b|\bsde\b|backend|back-end|full[\s-]*stack|platform\s*engineer|infrastructure\s*engineer|devops|mlops|\bsre\b)/i;
  const CAP = 25;

  async function httpFetch(host, urlPath) {
    const m = urlPath.match(/jobOffset=(\d+)/);
    const off = m ? parseInt(m[1], 10) : 0;
    if (Object.prototype.hasOwnProperty.call(pages, off)) return { status: 301, body: pages[off] };
    return { status: 200, body: '' }; // real exhaustion past our sampled range
  }

  const fn = new Function('httpFetch', 'isRemote', 'TITLE_RX', 'CAP', FETCHAVATURE_NEW + '\nreturn fetchAvature;')(httpFetch, isRemote, TITLE_RX, CAP);
  const { rows, ok } = await fn({ company_id: 15655, board: 'ibm', slug: 'ibmglobal', api_base: 'careers' });

  if (!ok) throw new Error('expected ok=true');
  const uniqueIds = new Set(rows.map((r) => r.external_id));
  if (uniqueIds.size < 50) throw new Error('expected the fixed pagination to walk through all 6 real pages (~53 unique jobs), got ' + uniqueIds.size);
  const relevant = rows.filter((r) => TITLE_RX.test(r.title));
  if (relevant.length < 7) throw new Error('expected at least the 7 real AI/tech-relevant jobs confirmed live in this sample, got ' + relevant.length);
  const hasResearchScientist = relevant.some((r) => r.title.includes('AI Foundations - Research Scientist'));
  if (!hasResearchScientist) throw new Error('expected the known real "AI Foundations - Research Scientist" listing to be found -- it was invisible before this fix');

  console.log(`HARNESS OK: fixed pagination (run against the ACTUAL patched code, against IBM's REAL live pages captured this session) finds ${uniqueIds.size} unique jobs across all 6 real pages including ${relevant.length} genuinely relevant matches -- all invisible to the pre-fix code, which stopped after page 1 (9 jobs, 0 matches) every time`);

  // Sanity: the OLD code, run the same way, should reproduce the exact bug (stops after page 1).
  const fnOld = new Function('httpFetch', 'isRemote', 'TITLE_RX', 'CAP', FETCHAVATURE_OLD + '\nreturn fetchAvature;')(httpFetch, isRemote, TITLE_RX, CAP);
  const oldResult = await fnOld({ company_id: 15655, board: 'ibm', slug: 'ibmglobal', api_base: 'careers' });
  if (oldResult.rows.length !== 9) throw new Error('sanity check failed: the OLD code should reproduce exactly the observed live bug (9 rows, page-1-only), got ' + oldResult.rows.length);
  if (oldResult.rows.some((r) => TITLE_RX.test(r.title))) throw new Error('sanity check failed: the OLD code page-1-only result should have zero relevant matches, matching the real live poll outcome');
  console.log('HARNESS OK: confirmed the OLD code reproduces the exact observed bug (9 rows, page 1 only, 0 relevant matches) against the same real fixtures -- this is a genuine fix, not a no-op');
}

async function run() {
  try {
    await harness();
  } catch (e) {
    console.error('HARNESS FAIL:', e.message || e);
    process.exit(1);
  }
  POLLER_TARGETS.forEach(patch);
  console.log('S72 (Avature pagination fix) complete.');
}
run();
