/**
 * s73_avature_v2_bloomberg_twosigma.js -- extends the Avature adapter (built
 * for IBM in s69, pagination-fixed in s72) to cover Bloomberg and Two Sigma,
 * both confirmed genuinely real Avature tenants that don't fit IBM's exact
 * template. Also seeds Citigroup and GEICO (plain Workday, zero new code).
 *
 * Root shape, confirmed live this session: Bloomberg and Two Sigma share ONE
 * alternate card template -- `<article class="article article--result">`
 * (not IBM's `article--card`) with path-style job links
 * (`/JobDetail/<title-slug>/<id>`, not IBM's `?jobId=<id>`). One shared
 * second pattern, not two one-offs. Two Sigma additionally sits behind a
 * custom domain (careers.twosigma.com, CNAMEd to twosigma.avature.net but
 * the raw tenant origin 404s directly -- must fetch the custom domain) and a
 * differently-named listing page (OpenRoles, not SearchJobs).
 *
 * Dead-posting /Error-redirect signal confirmed style-agnostic (live-tested
 * against a bogus Bloomberg path-style job id -- same 302-to-/Error).
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
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];
const SEEDER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Registry_Seeder.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ════════════════════════ POLLER: fetchAvature v2 ════════════════════════

const FETCHAVATURE_OLD = `async function fetchAvature(company) {
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

const FETCHAVATURE_NEW = `async function fetchAvature(company) {
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
            const jidM = b.match(/JobDetail\\?jobId=(\\d+)/);
            if (!jidM) continue;
            const titleM = b.match(/article__header__text__title[^>]*>\\s*<a[^>]*>\\s*([^<]+?)\\s*<\\/a>/);
            const locM = b.match(/card-item-location">([^<]*)<\\/span>/);
            external_id = jidM[1];
            title = (titleM ? titleM[1] : '').replace(/\\s+/g, ' ').trim();
            location = (locM ? locM[1] : '').replace(/\\s+/g, ' ').trim();
            apply_url = 'https://' + host + (useLocale ? '/en_US/' : '/') + portalUrlPath + '/JobDetail?jobId=' + external_id;
          } else {
            // s73: article--result template. The title link is already a complete
            // absolute URL -- use it as-is rather than reconstructing, and pull the
            // numeric id off its own trailing path segment.
            const hrefM = b.match(/href="(https:\\/\\/[^"]+)"/);
            if (!hrefM) continue;
            const idM = hrefM[1].match(/\\/(\\d+)(?:[?#]|$)/);
            if (!idM) continue;
            const titleM = b.match(/article__header__text__title[^>]*>\\s*<a[^>]*>\\s*([^<]+?)\\s*<\\/a>/);
            // list-item-location covers Bloomberg; Two Sigma uses a differently-named
            // span for location -- v2 scope, explicitly disclosed: location comes back
            // empty for Two Sigma rather than guessed, same "unknown, never guessed"
            // policy this codebase already applies everywhere else.
            const locM = b.match(/list-item-location">([^<]*)<\\/span>/);
            external_id = idM[1];
            title = (titleM ? titleM[1] : '').replace(/\\s+/g, ' ').trim();
            location = (locM ? locM[1] : '').replace(/\\s+/g, ' ').trim();
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
    }`;

function patchPoller(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Parse Jobs']) { console.error(`INTEGRITY FAIL ${base}: node "Parse Jobs" not found`); process.exit(1); }
  if (N['Parse Jobs'].parameters.jsCode.includes('resultStyle')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', FETCHAVATURE_OLD, FETCHAVATURE_NEW, 'fetchAvature v2 (dual template + host/page override)', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: fetchAvature v2 (article--result support, custom host, custom listing page) -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ MASTER: Verify Job Links avature branch ════════════════════════

const VJL_OLD = `    if (h.endsWith('.avature.net')) {
      // s69: dead-posting signal confirmed live on 2 real tenants (IBM, Bloomberg)
      // -- an invalid/nonexistent jobId 301/302-redirects to a path ending in
      // /Error; a live job redirects back to its own JobDetail URL. Query-style
      // JobDetail?jobId=N links only (matches fetchAvature's own v1 scope).
      const m = u.path.match(/[?&]jobId=(\\d+)/);
      if (!m) return { verdict: 'keep', location: null };
      const res = await req1(u, 'GET', 'text/html');
      if ((res.status === 301 || res.status === 302) && /\\/Error(?:[/?]|$)/i.test(res.location || '')) return { verdict: 'dead', location: null };
      return { verdict: 'keep', location: null };
    }`;
const VJL_NEW = `    if (h.endsWith('.avature.net') || h === 'careers.twosigma.com') {
      // s69/s73: dead-posting signal confirmed live on 3 real tenants (IBM,
      // Bloomberg, Two Sigma) -- an invalid/nonexistent jobId 301/302-redirects
      // to a path ending in /Error; a live job redirects back to its own
      // JobDetail URL. Recognizes both query-style (?jobId=N, IBM) and
      // path-style (/JobDetail/<slug>/N, Bloomberg/Two Sigma) job-detail URLs --
      // the redirect check itself is style-agnostic, only the "is this even a
      // job-detail URL worth probing" gate needed to learn the second shape.
      // Two Sigma's custom domain (careers.twosigma.com) is hardcoded here since
      // nothing about the URL itself reveals it's Avature-backed.
      const m = u.path.match(/[?&]jobId=(\\d+)/) || u.path.match(/\\/JobDetail\\/[^/]+\\/(\\d+)/);
      if (!m) return { verdict: 'keep', location: null };
      const res = await req1(u, 'GET', 'text/html');
      if ((res.status === 301 || res.status === 302) && /\\/Error(?:[/?]|$)/i.test(res.location || '')) return { verdict: 'dead', location: null };
      return { verdict: 'keep', location: null };
    }`;

function patchMaster(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Verify Job Links']) { console.error(`INTEGRITY FAIL ${base}: node "Verify Job Links" not found`); process.exit(1); }
  if (N['Verify Job Links'].parameters.jsCode.includes('careers.twosigma.com')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', VJL_OLD, VJL_NEW, 'avature v2 dead-link detection', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Verify Job Links now recognizes path-style Avature job URLs + Two Sigma's custom domain -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ SEEDER ════════════════════════

const SEED_OLD =
  "  { name: 'Morgan Stanley', ats_type: 'workday',    slug: 'External',                      api_base: 'ms.wd5',       tier: 'dream' },\n" +
  "];";
const SEED_NEW =
  "  { name: 'Morgan Stanley', ats_type: 'workday',    slug: 'External',                      api_base: 'ms.wd5',       tier: 'dream' },\n" +
  "  // s73: Citigroup + GEICO are plain Workday, zero new code. Bloomberg + Two\n" +
  "  // Sigma need fetchAvature v2 (this same commit) -- Two Sigma's slug is the\n" +
  "  // literal custom-domain host (contains a dot, triggers the host-override\n" +
  "  // path), api_base 'careers/OpenRoles' overrides the default SearchJobs page.\n" +
  "  { name: 'Citigroup', ats_type: 'workday', slug: '2', api_base: 'citi.wd5', tier: 'dream' },\n" +
  "  { name: 'GEICO', ats_type: 'workday', slug: 'External', api_base: 'geico.wd1', tier: 'dream' },\n" +
  "  { name: 'Bloomberg', ats_type: 'avature', slug: 'bloomberg', api_base: 'careers', tier: 'dream' },\n" +
  "  { name: 'Two Sigma', ats_type: 'avature', slug: 'careers.twosigma.com', api_base: 'careers/OpenRoles', tier: 'dream' },\n" +
  "];";

function patchSeeder(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Build Seed List']) { console.error(`INTEGRITY FAIL ${base}: node "Build Seed List" not found`); process.exit(1); }
  if (N['Build Seed List'].parameters.jsCode.includes("slug: 'careers.twosigma.com'")) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Seed List'].parameters, 'jsCode', SEED_OLD, SEED_NEW, 's73 seed additions', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Citigroup + GEICO + Bloomberg + Two Sigma added to the tracked seed list -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
// Runs the ACTUAL patched fetchAvature against REAL captured fixtures for all
// three shapes -- IBM (regression guard: must stay byte-identical), Bloomberg
// (new article--result + path-style pattern), Two Sigma (new pattern + custom
// host + custom listing page, all three overrides exercised at once).
async function harness() {
  const FIX = path.join('/tmp', 's73_fixtures');
  const ibmHtml = fs.readFileSync(path.join(FIX, 'ibm_avature_direct.html'), 'utf8');
  const bloombergHtml = fs.readFileSync(path.join(FIX, 'bloomberg.avature.net.html'), 'utf8');
  const twoSigmaHtml = fs.readFileSync(path.join(FIX, 'twosigma_openroles.html'), 'utf8');

  const isRemote = (s) => /remote/i.test(String(s || ''));
  const TITLE_RX = /(machine\s*learning|\bml\b|\bai\b|artificial\s*intelligence|data\s*(scien|engineer|analy|platform)|analytics\s*engineer|deep\s*learning|\bnlp\b|\bllm\b|gen\s*ai|generative|computer\s*vision|research\s*(scientist|engineer)|applied\s*scientist|software\s*engineer|\bswe\b|\bsde\b|backend|back-end|full[\s-]*stack|platform\s*engineer|infrastructure\s*engineer|devops|mlops|\bsre\b)/i;
  const CAP = 25;

  function makeFetcher(pages) {
    let call = 0;
    return async function httpFetch() {
      const res = pages[call] || { status: 200, body: '' };
      call++;
      return res;
    };
  }

  const fnNew = (pages) => new Function('httpFetch', 'isRemote', 'TITLE_RX', 'CAP', FETCHAVATURE_NEW + '\nreturn fetchAvature;')(makeFetcher(pages), isRemote, TITLE_RX, CAP);
  const fnOld = (pages) => new Function('httpFetch', 'isRemote', 'TITLE_RX', 'CAP', FETCHAVATURE_OLD + '\nreturn fetchAvature;')(makeFetcher(pages), isRemote, TITLE_RX, CAP);

  // Case 1: IBM regression guard -- new code on IBM's real fixture must extract
  // the identical set of jobs the old (already-shipped, s72-verified) code does.
  const ibmPages = [{ status: 301, body: ibmHtml }, { status: 200, body: '' }];
  const oldIbm = await fnOld(ibmPages)({ company_id: 15655, board: 'ibm', slug: 'ibmglobal', api_base: 'careers' });
  const newIbm = await fnNew(ibmPages)({ company_id: 15655, board: 'ibm', slug: 'ibmglobal', api_base: 'careers' });
  if (!newIbm.ok) throw new Error('IBM regression: expected ok=true');
  if (newIbm.rows.length !== oldIbm.rows.length) throw new Error(`IBM regression: old code found ${oldIbm.rows.length} rows, new code found ${newIbm.rows.length}`);
  const oldIds = new Set(oldIbm.rows.map((r) => r.external_id));
  const newIds = new Set(newIbm.rows.map((r) => r.external_id));
  if (oldIds.size !== newIds.size || [...oldIds].some((id) => !newIds.has(id))) throw new Error('IBM regression: extracted job ids differ between old and new code');
  console.log(`HARNESS OK: IBM regression guard -- new code extracts the identical ${newIbm.rows.length} jobs the already-shipped code does, byte-for-byte id match`);

  // Case 2: Bloomberg -- new article--result + path-style pattern, real fixture.
  const bbPages = [{ status: 301, body: 'LanguageManager::redirectToUrl::x' }, { status: 200, body: bloombergHtml }, { status: 200, body: '' }];
  const bb = await fnNew(bbPages)({ company_id: 99001, board: 'bloomberg', slug: 'bloomberg', api_base: 'careers' });
  if (!bb.ok) throw new Error('Bloomberg: expected ok=true');
  if (bb.rows.length < 5) throw new Error('Bloomberg: expected several real jobs extracted from the real fixture, got ' + bb.rows.length);
  const knownJob = bb.rows.find((r) => r.external_id === '20717');
  if (!knownJob) throw new Error('Bloomberg: known real job 20717 (Regional Business Analyst APAC Supply Chain) not extracted');
  if (!knownJob.title.includes('Business Analyst')) throw new Error('Bloomberg: title extraction wrong: ' + JSON.stringify(knownJob));
  if (knownJob.location !== 'Hong Kong, Hong Kong') throw new Error('Bloomberg: location extraction wrong: ' + JSON.stringify(knownJob));
  if (knownJob.apply_url !== 'https://bloomberg.avature.net/careers/JobDetail/Regional-Business-Analyst-APAC-Supply-Chain/20717') throw new Error('Bloomberg: apply_url wrong: ' + knownJob.apply_url);
  console.log(`HARNESS OK: Bloomberg -- article--result pattern correctly extracts ${bb.rows.length} real jobs (id/title/location/apply_url) from the real fixture, including the known real listing 20717`);

  // Case 3: Two Sigma -- new pattern + custom host override + custom listing page, all at once.
  let capturedHost = null, capturedPath = null;
  const tsPages = [{ status: 200, body: twoSigmaHtml }, { status: 200, body: '' }];
  let call = 0;
  const tsFetcher = async (host, urlPath) => { capturedHost = host; capturedPath = urlPath; const r = tsPages[call] || { status: 200, body: '' }; call++; return r; };
  const tsFn = new Function('httpFetch', 'isRemote', 'TITLE_RX', 'CAP', FETCHAVATURE_NEW + '\nreturn fetchAvature;')(tsFetcher, isRemote, TITLE_RX, CAP);
  const ts = await tsFn({ company_id: 99002, board: 'twosigma', slug: 'careers.twosigma.com', api_base: 'careers/OpenRoles' });
  if (capturedHost !== 'careers.twosigma.com') throw new Error('Two Sigma: host override failed, fetched ' + capturedHost + ' instead of the custom domain');
  if (!capturedPath.includes('/OpenRoles')) throw new Error('Two Sigma: listing-page override failed, requested path was ' + capturedPath);
  if (!ts.ok) throw new Error('Two Sigma: expected ok=true');
  if (ts.rows.length < 1) throw new Error('Two Sigma: expected at least 1 real job extracted, got 0');
  const knownTsJob = ts.rows.find((r) => r.external_id === '13671');
  if (!knownTsJob) throw new Error('Two Sigma: known real job 13671 (AI Research Scientist) not extracted');
  if (!knownTsJob.title.includes('Research Scientist')) throw new Error('Two Sigma: title extraction wrong: ' + JSON.stringify(knownTsJob));
  console.log(`HARNESS OK: Two Sigma -- custom-domain host override AND custom listing-page name both correctly applied (fetched careers.twosigma.com/careers/OpenRoles, not the raw tenant origin), ${ts.rows.length} real jobs extracted including known real listing 13671`);

  // Dead-link detection: style-agnostic /Error check works for path-style URLs too.
  const isDead = (loc) => /\/Error(?:[/?]|$)/i.test(loc || '');
  if (!isDead('https://bloomberg.avature.net/careers/Error')) throw new Error('dead-check: real Bloomberg dead-redirect location should match /Error');
  if (isDead('https://bloomberg.avature.net/careers/JobDetail/Regional-Business-Analyst-APAC-Supply-Chain/20717')) throw new Error('dead-check: real live Bloomberg job URL must NOT match /Error');
  const pathStyleMatch = '/careers/JobDetail/some-job-title/12345'.match(/[?&]jobId=(\d+)/) || '/careers/JobDetail/some-job-title/12345'.match(/\/JobDetail\/[^/]+\/(\d+)/);
  if (!pathStyleMatch || pathStyleMatch[1] !== '12345') throw new Error('dead-check: path-style job-detail gate did not recognize a real path-style URL shape');
  console.log('HARNESS OK: dead-link detection recognizes path-style job-detail URLs and the /Error redirect check (confirmed style-agnostic live this session) still matches correctly on real header values');
}

async function run() {
  try {
    await harness();
  } catch (e) {
    console.error('HARNESS FAIL:', e.message || e);
    process.exit(1);
  }
  POLLER_TARGETS.forEach(patchPoller);
  MASTER_TARGETS.forEach(patchMaster);
  SEEDER_TARGETS.forEach(patchSeeder);
  console.log('S73 (Avature v2: Bloomberg + Two Sigma, plus Citigroup + GEICO seed) complete.');
}
run();
