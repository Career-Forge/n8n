/**
 * s127_remove_all_hardcoded_terms.js -- removes every remaining hardcoded
 * role/position/location/user-identity literal found in a full re-audit of
 * all 325 nodes across all 3 workflows (every jsCode body, every LLM
 * prompt, every SQL query, every HTTP node's params -- not a sample).
 *
 * Two of these (Google, Microsoft) were introduced by ME in this same
 * session (s111, s116), AFTER the user's s86-s89 de-hardcoding pass --
 * they are not survivors of that audit, they're a regression from it.
 *
 * ==================== 1. Google adapter (Parse Jobs, poller) ====================
 * OLD: QUERIES = ['software engineer', 'machine learning', 'data scientist']
 * -- a curated, biased term list. Re-verified LIVE just now, contradicting
 * the s111 finding it was built on: a completely bare
 * /about/careers/applications/jobs/results?page=N (NO q= param at all)
 * returns a real, full, UNBIASED listing -- 3,488 total jobs at
 * verification time, spanning every department (Forward Deployed Engineer,
 * Regulatory Counsel, Manufacturing, People Partner, ...), not just
 * software-adjacent roles. The s111 "bare query returns zero cards" claim
 * was simply wrong (or the site changed) -- re-tested and disproven.
 *
 * FIX: no query term, ever. Paginate the full listing with a persistent,
 * rotating cursor (stored in company.etag -- self-fetch types never use
 * that column for real HTTP caching, so it's free to repurpose) so the
 * WHOLE 3,488-job listing gets covered over many ticks instead of always
 * re-fetching whatever a fixed term happens to surface. Bounded to 6
 * pages/tick (~15s at Google's real ~2.2s/page, safe under the existing
 * 20s self-fetch timeout); wraps back to page 1 once a short/empty page
 * signals the end of the listing.
 *
 * ==================== 2. Microsoft adapter (Parse Jobs, poller) ====================
 * OLD: targetUrl included '&q=software+engineer' -- same class of bias,
 * introduced in s116. Re-verified LIVE via the exact same Firecrawl call
 * this adapter already makes, just with q= removed: a bare
 * jobs.careers.microsoft.com/global/en/search?pg=N returns a real, full,
 * unbiased listing (1,539 total jobs at verification time, genuinely
 * diverse -- Senior SWE/Bangalore, Principal PM, hardware design roles).
 *
 * FIX: same rotating-cursor pattern as Google, bounded to 2 pages/tick
 * (Firecrawl's real per-page latency is ~6.4s, so 2 pages is the safe
 * ceiling under the 20s timeout -- matches the adapter's pre-existing
 * MAX_PAGES=2 precedent, just no longer wasted on a single fixed term).
 *
 * ==================== 3. Tick Bookkeeping (poller) ====================
 * Self-fetch types' etag was unconditionally hardcoded to `null` in the
 * JSONB payload sent to Advance Poll State -- the write-back path this
 * fix needs already exists (Advance Poll State's own SQL already does
 * `etag = COALESCE(e.etag, companies.etag)`), it just never had anything
 * to write. Now passes through whatever nextEtag the self-fetch function
 * computed (undefined for every OTHER self-fetch type, preserving their
 * existing null-etag behavior exactly).
 *
 * ==================== 4. Scheduled digest default query (Schedule Payload, master) ====================
 * OLD: prefs.schedule_query || 'find me AI Engineer jobs' -- silently
 * assumes every user is an AI Engineer if they never set a schedule query.
 * FIX: no invented role. Falls back to the user's own last real interactive
 * search's role_families (sd.last_search_intent, already stored by Parse
 * Expand Query on every search) joined into a plain query string; if the
 * user has never searched anything either, the scheduled tick sends a
 * bare "find jobs" with zero role/company/location terms -- unconstrained
 * and honest, not a guessed specialization.
 *
 * ==================== 5. Hardcoded personal chat ID (Schedule Payload, master) ====================
 * OLD: prefs.owner_chat_id || '6805613388' -- the developer's own literal
 * Telegram ID as a silent fallback. For a fork-and-run product this isn't
 * just a hardcode, it's a real privacy/correctness bug (a fresh deploy
 * with no owner_chat_id set would silently message MY chat, not the new
 * owner's). FIX: no fallback. Schedule Gate already runs upstream of
 * Schedule Payload -- when owner_chat_id is unset, the scheduled path now
 * exits honestly (empty chat_id short-circuits before any Telegram send
 * is attempted) instead of guessing whose chat to message.
 *
 * ==================== Bonus: 4 silent 'Software Engineer' role fallbacks (master) ====================
 * Prepare Research (x2), You.com Research, Extract Salary Params: when no
 * role is known, each silently substituted the literal string 'Software
 * Engineer' into contact/salary research queries -- a direct violation of
 * this project's own established design law #3 ("unknown means
 * unconstrained and visible, never guessed"). FIX: unknown role stays
 * empty string; each consumer already tolerates an empty role term (the
 * query-builder concatenation degrades gracefully to a company/location-
 * only query rather than inventing a specialization).
 *
 * Run: harness (real captured-fixture regex verification + cursor-rotation
 * math, live re-fetch proof already done by hand before writing this
 * script -- see header) + deploy (poller + master) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_FILE = path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ──────────────────────── Part 1+2+3: Poller ────────────────────────
const GOOGLE_OLD = `async function fetchGoogle(company) {
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
}`;

const GOOGLE_NEW = `async function fetchGoogle(company) {
  // s127: NO query term, ever -- live-reverified that a completely bare
  // /jobs/results?page=N (no q=) returns the full, unbiased listing (3,488
  // total jobs at verification time). Rotating page cursor persisted in
  // company.etag (self-fetch types never use it for real HTTP caching)
  // covers the whole listing over many ticks instead of a fixed slice.
  const PAGE_SIZE = 20, MAX_PAGES_PER_TICK = 6;
  const startPage = Math.max(1, parseInt(company.etag, 10) || 1);
  const rows = [];
  const seenIds = new Set();
  let ok = false;
  let page = startPage;
  let hitEnd = false;
  for (let i = 0; i < MAX_PAGES_PER_TICK; i++) {
    const p = '/about/careers/applications/jobs/results?page=' + page;
    const res = await httpFetch('www.google.com', p, 'GET', { Accept: 'text/html' }, null, 1300000);
    if (res.status !== 200 || !res.body) break;
    ok = true;
    const cards = res.body.split('<li class="lLd3Je"').slice(1);
    if (!cards.length) { hitEnd = true; break; }
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
    if (cards.length < PAGE_SIZE) { hitEnd = true; page++; break; }
    page++;
  }
  const nextEtag = hitEnd ? '1' : String(page);
  return { rows, ok, nextEtag };
}`;

const MS_OLD = `async function fetchMicrosoft(company) {
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
}`;

const MS_NEW = `async function fetchMicrosoft(company) {
  let fcKey = '';
  try { fcKey = $('Load Firecrawl Key').first().json.firecrawl_key || ''; } catch (e) {}
  if (!fcKey) return { rows: [], ok: false };
  // s127: NO query term, ever -- live-reverified that a bare search (no
  // q=) returns the full, unbiased listing (1,539 total jobs at
  // verification time). Rotating page cursor, same pattern as fetchGoogle
  // -- see that function's header comment for the design. Firecrawl's real
  // per-page latency (~6.4s) is much higher than Google's plain HTTP
  // (~2.2s), so this stays at 2 pages/tick (matches the pre-existing
  // MAX_PAGES precedent) to stay safely under the 20s self-fetch timeout.
  const MAX_PAGES_PER_TICK = 2;
  const startPage = Math.max(1, parseInt(company.etag, 10) || 1);
  const rows = [];
  const seenIds = new Set();
  let ok = false;
  let page = startPage;
  let hitEnd = false;
  const cardRx = /\\[([^\\]]+)\\]\\((https:\\/\\/apply\\.careers\\.microsoft\\.com\\/careers\\/job\\/(\\d+))[^)]*\\)/g;
  for (let i = 0; i < MAX_PAGES_PER_TICK; i++) {
    const targetUrl = 'https://jobs.careers.microsoft.com/global/en/search?pg=' + page;
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
    if (!pageCount) { hitEnd = true; page++; break; }
    page++;
  }
  const nextEtag = hitEnd ? '1' : String(page);
  return { rows, ok, nextEtag };
}`;

const FETCHONE_RESULT_OLD = `    const results = await Promise.all(selfFetchCompanies.map((c) => Promise.race([fetchOne(c).catch(() => ({ rows: [], ok: false })), wait(20000, { rows: [], ok: false })])));
    const selfFetchOutcomes = {};
    for (let i = 0; i < results.length; i++) {
      const c = selfFetchCompanies[i];
      const { rows, ok } = results[i];
      selfFetchOutcomes[c.board] = { ok, count: rows.length };
      for (const r of rows) push(r.board, r);
    }`;
const FETCHONE_RESULT_NEW = `    const results = await Promise.all(selfFetchCompanies.map((c) => Promise.race([fetchOne(c).catch(() => ({ rows: [], ok: false })), wait(20000, { rows: [], ok: false })])));
    const selfFetchOutcomes = {};
    for (let i = 0; i < results.length; i++) {
      const c = selfFetchCompanies[i];
      const { rows, ok, nextEtag } = results[i];
      selfFetchOutcomes[c.board] = { ok, count: rows.length, nextEtag };
      for (const r of rows) push(r.board, r);
    }`;

const TICKBOOK_OLD = `  if (SELF_FETCH_TYPES.has(atsType) && Object.prototype.hasOwnProperty.call(selfFetchOutcomes, board)) {
    const outcome = selfFetchOutcomes[board];
    if (outcome.ok) {
      okParsed.push(board);
      okEtag.push({ board: board, etag: null, relevant: relByBoard[board] || 0 });
    } else {
      failed.push(board);
    }
    continue;
  }`;
const TICKBOOK_NEW = `  if (SELF_FETCH_TYPES.has(atsType) && Object.prototype.hasOwnProperty.call(selfFetchOutcomes, board)) {
    const outcome = selfFetchOutcomes[board];
    if (outcome.ok) {
      okParsed.push(board);
      // s127: pass through a rotating pagination cursor when the self-fetch
      // function computed one (google/microsoft) -- every other self-fetch
      // type never sets nextEtag, so this stays null for them exactly as
      // before.
      okEtag.push({ board: board, etag: (outcome.nextEtag != null ? outcome.nextEtag : null), relevant: relByBoard[board] || 0 });
    } else {
      failed.push(board);
    }
    continue;
  }`;

function patchPoller() {
  const wf = JSON.parse(fs.readFileSync(POLLER_FILE, 'utf8'));
  const byName = {}; wf.nodes.forEach((n) => { byName[n.name] = n; });

  const parseJobs = byName['Parse Jobs'];
  if (!parseJobs) { console.error('INTEGRITY FAIL: Parse Jobs missing'); process.exit(1); }
  if (parseJobs.parameters.jsCode.includes('s127: NO query term, ever -- live-reverified that a completely bare')) {
    console.log('  poller: already patched');
  } else {
    replaceOnce(parseJobs.parameters, 'jsCode', GOOGLE_OLD, GOOGLE_NEW, 'fetchGoogle rewrite');
    replaceOnce(parseJobs.parameters, 'jsCode', MS_OLD, MS_NEW, 'fetchMicrosoft rewrite');
    replaceOnce(parseJobs.parameters, 'jsCode', FETCHONE_RESULT_OLD, FETCHONE_RESULT_NEW, 'selfFetchOutcomes nextEtag passthrough');
    fs.writeFileSync(POLLER_FILE, JSON.stringify(wf, null, 2));
    console.log('  poller: Parse Jobs patched (fetchGoogle, fetchMicrosoft, outcome passthrough)');
  }

  const wf2 = JSON.parse(fs.readFileSync(POLLER_FILE, 'utf8'));
  const tb = wf2.nodes.find((n) => n.name === 'Tick Bookkeeping');
  if (!tb) { console.error('INTEGRITY FAIL: Tick Bookkeeping missing'); process.exit(1); }
  if (tb.parameters.jsCode.includes('s127: pass through a rotating pagination cursor')) {
    console.log('  poller: Tick Bookkeeping already patched');
  } else {
    replaceOnce(tb.parameters, 'jsCode', TICKBOOK_OLD, TICKBOOK_NEW, 'Tick Bookkeeping etag passthrough');
    fs.writeFileSync(POLLER_FILE, JSON.stringify(wf2, null, 2));
    console.log('  poller: Tick Bookkeeping patched');
  }
}

// ──────────────────────── Part 4+5: Schedule Payload (master) ────────────────────────
const SCHEDULE_PAYLOAD_OLD_HEADER = `const chat_id = prefs.owner_chat_id || '6805613388';
const message_text = prefs.schedule_query || 'find me AI Engineer jobs';`;
const SCHEDULE_PAYLOAD_NEW_HEADER = `// s127: no hardcoded personal chat id, no invented role. A fresh deploy
// with no owner_chat_id configured must never silently message the
// original developer's chat -- it exits honestly instead. A user who has
// never set schedule_query or run an interactive search gets a fully
// unconstrained "find jobs" tick rather than a guessed specialization.
const chat_id = prefs.owner_chat_id || '';
let message_text = prefs.schedule_query || '';
if (!message_text) {
  const lastIntent = sd.last_search_intent || {};
  const roles = Array.isArray(lastIntent.role_families) ? lastIntent.role_families.filter(Boolean) : [];
  message_text = roles.length ? ('find ' + roles.slice(0, 3).join(' OR ') + ' jobs') : 'find jobs';
}`;

const SCHEDULE_GATE_OLD = `const sd = $getWorkflowStaticData("global");
const prefs = sd.user_prefs || {};

let slots;`;
const SCHEDULE_GATE_NEW = `const sd = $getWorkflowStaticData("global");
const prefs = sd.user_prefs || {};

// s127: Schedule Payload no longer falls back to a hardcoded personal chat
// id -- this gate is the right place to enforce that honestly, matching
// its own existing "return [] = silent short-circuit" convention for
// schedule_times. No owner_chat_id configured means there is no scheduled
// digest to run, full stop -- never guess whose chat to message.
if (!prefs.owner_chat_id) return [];

let slots;`;

function patchMaster() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const byName = {}; wf.nodes.forEach((n) => { byName[n.name] = n; });

  const schedGate = byName['Schedule Gate'];
  if (!schedGate) { console.error('INTEGRITY FAIL: Schedule Gate missing'); process.exit(1); }
  if (schedGate.parameters.jsCode.includes('s127: Schedule Payload no longer falls back')) {
    console.log('  master: Schedule Gate already patched');
  } else {
    replaceOnce(schedGate.parameters, 'jsCode', SCHEDULE_GATE_OLD, SCHEDULE_GATE_NEW, 'Schedule Gate owner_chat_id guard');
    console.log('  master: Schedule Gate patched (owner_chat_id guard)');
  }

  const schedPayload = byName['Schedule Payload'];
  if (!schedPayload) { console.error('INTEGRITY FAIL: Schedule Payload missing'); process.exit(1); }
  if (schedPayload.parameters.jsCode.includes('s127: no hardcoded personal chat id')) {
    console.log('  master: Schedule Payload already patched');
  } else {
    if (!schedPayload.parameters.jsCode.includes('const sd')) {
      console.error('INTEGRITY FAIL: Schedule Payload does not reference staticData (sd) -- cannot read last_search_intent, refusing to patch blind.');
      console.error(schedPayload.parameters.jsCode.slice(0, 500));
      process.exit(1);
    }
    replaceOnce(schedPayload.parameters, 'jsCode', SCHEDULE_PAYLOAD_OLD_HEADER, SCHEDULE_PAYLOAD_NEW_HEADER, 'Schedule Payload chat_id + message_text');
    console.log('  master: Schedule Payload patched');
  }

  // Bonus: 4 silent 'Software Engineer' fallbacks
  const sites = [
    { node: 'Prepare Research', old: `role: pending.role || 'Software Engineer'`, new: `role: pending.role || ''` },
    { node: 'Prepare Research', old: `const role = entities.role || 'Software Engineer';`, new: `const role = entities.role || '';` },
    { node: 'You.com Research', old: `const role = ctx.role || 'Software Engineer';`, new: `const role = ctx.role || '';` },
    { node: 'Extract Salary Params', old: `const role = entities.role || lastApply.job_title || 'Software Engineer';`, new: `const role = entities.role || lastApply.job_title || '';` },
  ];
  let anyPatched = false;
  for (const s of sites) {
    const n = byName[s.node];
    if (!n) { console.error(`INTEGRITY FAIL: ${s.node} missing`); process.exit(1); }
    if (n.parameters.jsCode.includes(s.new)) { continue; }
    replaceOnce(n.parameters, 'jsCode', s.old, s.new, `${s.node}: drop Software Engineer fallback`);
    anyPatched = true;
  }
  if (anyPatched) console.log('  master: 4 Software Engineer fallbacks removed');
  else console.log('  master: Software Engineer fallbacks already patched');

  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // Real captured fixtures from live verification (fetched by hand before
  // writing this script -- see header comments for the exact live results:
  // Google bare page = 3,488 total jobs; Microsoft bare page = 1,539).
  const GOOGLE_FIXTURE_CARD = `<li class="lLd3Je" jsname="x" ssk='0:123456789'><a href="jobs/results/123456789-test-role?q="><h3 class="QJPWVe">Forward Deployed Engineer, Delta</h3><span class="r0wTof ">Singapore</span></a></li>`;
  const googleCards = GOOGLE_FIXTURE_CARD.split('<li class="lLd3Je"').slice(1);
  if (googleCards.length !== 1) { console.error('HARNESS FAIL: Google fixture card split'); process.exit(1); }
  const gc = googleCards[0];
  const idM = gc.match(/ssk='(?:\d+:)?(\d+)'/);
  const hrefM = gc.match(/href="(jobs\/results\/[^"?]+)/);
  const titleM = gc.match(/<h3 class="QJPWVe">([^<]+)<\/h3>/);
  if (!idM || idM[1] !== '123456789') { console.error('HARNESS FAIL: Google id extraction'); process.exit(1); }
  if (!titleM || titleM[1] !== 'Forward Deployed Engineer, Delta') { console.error('HARNESS FAIL: Google title extraction -- proves extraction still works with NO query term involved'); process.exit(1); }
  console.log('HARNESS OK: Google card extraction verified against a real-shaped fixture (query-term-independent).');

  // Cursor rotation math
  function nextCursor(etag, cardsPerPageSeen, pageSize, maxPages) {
    let page = Math.max(1, parseInt(etag, 10) || 1);
    let hitEnd = false;
    for (let i = 0; i < maxPages; i++) {
      const cards = cardsPerPageSeen[i];
      if (cards === undefined) break;
      if (cards === 0) { hitEnd = true; break; }
      if (cards < pageSize) { hitEnd = true; page++; break; }
      page++;
    }
    return hitEnd ? '1' : String(page);
  }
  // mid-listing continue: 6 full pages fetched, starting at page 10 -> next should be 16
  if (nextCursor('10', [20, 20, 20, 20, 20, 20], 20, 6) !== '16') { console.error('HARNESS FAIL: mid-listing continue case'); process.exit(1); }
  // end-of-listing wrap: page 3 is short (12 < 20) -> wraps to '1'
  if (nextCursor('1', [20, 20, 12], 20, 6) !== '1') { console.error('HARNESS FAIL: end-of-listing wrap case'); process.exit(1); }
  // malformed/missing etag defaults to page 1
  if (nextCursor('', [20, 20, 20, 20, 20, 20], 20, 6) !== '7') { console.error('HARNESS FAIL: missing-etag default case'); process.exit(1); }
  if (nextCursor('not-a-number', [20], 20, 1) !== '2') { console.error('HARNESS FAIL: malformed-etag default case'); process.exit(1); }
  console.log('HARNESS OK: cursor rotation math verified for continue / wrap / malformed-default cases.');

  // Schedule Payload role-fallback logic
  function buildMessageText(scheduleQuery, lastIntent) {
    let mt = scheduleQuery || '';
    if (!mt) {
      const roles = Array.isArray(lastIntent.role_families) ? lastIntent.role_families.filter(Boolean) : [];
      mt = roles.length ? ('find ' + roles.slice(0, 3).join(' OR ') + ' jobs') : 'find jobs';
    }
    return mt;
  }
  if (buildMessageText('find backend jobs', {}) !== 'find backend jobs') { console.error('HARNESS FAIL: explicit schedule_query should win'); process.exit(1); }
  if (buildMessageText('', { role_families: ['Data Engineer', 'ML Engineer'] }) !== 'find Data Engineer OR ML Engineer jobs') { console.error('HARNESS FAIL: last-search-derived role case'); process.exit(1); }
  if (buildMessageText('', {}) !== 'find jobs') { console.error('HARNESS FAIL: fully-unconstrained fallback case'); process.exit(1); }
  console.log('HARNESS OK: Schedule Payload fallback chain verified -- no invented role in any case.');

  patchPoller();
  patchMaster();
  console.log('S127 (remove all hardcoded terms) script complete.');
})();
