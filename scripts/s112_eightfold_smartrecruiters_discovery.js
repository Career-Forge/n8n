/**
 * s112_eightfold_smartrecruiters_discovery.js -- manual/WebSearch discovery
 * batch for the 38 F500 companies tagged Eightfold/SmartRecruiters in
 * data/reference/raw/f500_ats_2026.csv (s109 deliberately routes these here
 * rather than guessing -- their identifiers are opaque, not derivable from
 * a brand name; the v9 wave's own finding: guessed ids return "well-formed-
 * but-empty" responses, worse than a clean 404 because nothing flags them
 * as wrong).
 *
 * Method per candidate: WebSearch for the real careers-portal URL, extract
 * the real tenant host / companyIdentifier, then a live HTTP probe against
 * the exact endpoint the poller itself calls -- confirmation = a real,
 * non-empty postings/positions response. 11 of 38 confirmed this pass
 * (this is a partial batch, not the full 38 -- see MISSES below for exactly
 * what's still open, disclosed rather than silently incomplete):
 *
 *   ServiceNow       smartrecruiters  servicenow        (419 real postings)
 *   AbbVie           smartrecruiters  abbvie            (1636 real postings)
 *   VMware           smartrecruiters  Vmware2           (11 real postings)
 *   NBCUniversal     smartrecruiters  NBCUniversal3     (441 real postings)
 *   Booking.com      smartrecruiters  Bookingcom1       (4 real postings)
 *   H&M              smartrecruiters  hmgroup           (1710 real postings)
 *   PayPal           eightfold        paypal.eightfold.ai      (pcsx tier)
 *   Starbucks        eightfold        starbucks.eightfold.ai   (pcsx tier)
 *   Liberty Mutual    eightfold        libertymutual.eightfold.ai (smartapply)
 *   Boston Scientific eightfold        bostonscientific.eightfold.ai (pcsx tier)
 *   AstraZeneca      workday (!)      astrazeneca.wd3 / Careers -- the F500
 *                    CSV mistagged this one Eightfold; astrazeneca.eightfold.ai
 *                    exists but returns zero positions on both tiers, while
 *                    astrazeneca.wd3.myworkdayjobs.com/wday/cxs/astrazeneca/
 *                    Careers/jobs returns 1294 real jobs, live-verified.
 *                    Corrected here rather than force-seeded on the wrong vendor.
 *
 * REJECTED, not force-guessed (both tiers tried, genuinely empty):
 *   Microsoft         microsoftai.eightfold.ai (0 positions, blank+"engineer"
 *                     query both tried) AND microsoft.eightfold.ai (403 "Not
 *                     authorized for PCSX" on both tiers) -- Microsoft's REAL
 *                     backend is still unconfirmed. NOT seeded on a guess.
 *   American Express  aexp.eightfold.ai -- 0 positions on smartapply AND pcsx.
 *
 * EXCLUDED (same category as the user's TCS/Infosys/Wipro exclusion --
 * WNS Global Services is a BPO/outsourcing firm found while researching
 * this batch, not a product company):
 *   WNS
 *
 * NOT YET RESEARCHED (24 remaining, honestly disclosed for a future
 * continuation of this same batch, not silently dropped):
 *   Eightfold: BNY Mellon, Johns Hopkins, Bayer, Mercado Libre, Estee
 *     Lauder, Deere & Company, Eaton, Whirlpool, Schlumberger, Vodafone,
 *     Fluor, Lam Research, NetApp
 *   SmartRecruiters: Wise, Intuitive Surgical, Roland Berger, Abercrombie,
 *     Accor, Wynn Resorts, McDonald's, Domino's, Expeditors, AECOM, Freshworks
 *
 * BONUS FIX, found because 3 of the 4 real Eightfold hits needed it:
 * fetchEightfold()'s pcsx fallback only ever triggered on a 403 from the
 * smartapply tier. PayPal, Starbucks, and Boston Scientific all instead
 * return HTTP 200 with a genuinely empty `positions: []` from smartapply --
 * a real, working tenant that the OLD code would have silently ingested
 * ZERO jobs from forever, with no error, nothing to notice. Now falls back
 * to pcsx on EITHER signal (403, or a 200 with zero positions), but only
 * ever on page 0 -- a later page legitimately running out of results across
 * a real, already-working tier must not re-trigger a tier switch.
 *
 * Run: dry-run harness first (structural, no network -- probes were already
 * done by hand this session, this script just codifies + deploys the
 * verified results), then inside the n8n container with the repo staged
 * under /tmp for the workflow patch, direct SQL for the live seed.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POLLER_FILE = path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json');
const SEEDER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ── Confirmed rows, live-verified this session (see header) ──
const CONFIRMED = [
  { name: 'ServiceNow', ats_type: 'smartrecruiters', slug: 'servicenow', api_base: '' },
  { name: 'AbbVie', ats_type: 'smartrecruiters', slug: 'abbvie', api_base: '' },
  { name: 'VMware', ats_type: 'smartrecruiters', slug: 'Vmware2', api_base: '' },
  { name: 'NBCUniversal', ats_type: 'smartrecruiters', slug: 'NBCUniversal3', api_base: '' },
  { name: 'Booking.com', ats_type: 'smartrecruiters', slug: 'Bookingcom1', api_base: '' },
  { name: 'H&M', ats_type: 'smartrecruiters', slug: 'hmgroup', api_base: '' },
  { name: 'PayPal', ats_type: 'eightfold', slug: 'paypal.com', api_base: 'paypal.eightfold.ai' },
  { name: 'Starbucks', ats_type: 'eightfold', slug: 'starbucks.com', api_base: 'starbucks.eightfold.ai' },
  { name: 'Liberty Mutual', ats_type: 'eightfold', slug: 'libertymutual.com', api_base: 'libertymutual.eightfold.ai' },
  { name: 'Boston Scientific', ats_type: 'eightfold', slug: 'bostonscientific.com', api_base: 'bostonscientific.eightfold.ai' },
  { name: 'AstraZeneca', ats_type: 'workday', slug: 'Careers', api_base: 'astrazeneca.wd3' },
];

// ── fetchEightfold pcsx-fallback fix ──
const FE_OLD = "async function fetchEightfold(company) {\n      const host = company.api_base, domain = company.slug;\n      if (!host || !domain) return { rows: [], ok: false };\n      const LIMIT = 10, MAX_PAGES = 5;\n      let tier = 'smartapply';\n      const rows = [];\n      let ok = false;\n      for (let page = 0; page < MAX_PAGES; page++) {\n        const start = page * LIMIT;\n        const qs = 'domain=' + encodeURIComponent(domain) + '&start=' + start + '&num=' + LIMIT;\n        let path = (tier === 'pcsx' ? '/api/pcsx/search?' : '/api/apply/v2/jobs?') + qs;\n        let res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });\n        if (tier === 'smartapply' && res.status === 403) {\n          tier = 'pcsx';\n          path = '/api/pcsx/search?' + qs;\n          res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });\n        }\n        if (res.status !== 200) break;\n        let data; try { data = JSON.parse(res.body); } catch (e) { break; }\n        ok = true;\n        const positions = (tier === 'pcsx' ? ((data.data && data.data.positions) || []) : (data.positions || []));\n        if (!positions.length) break;";
const FE_NEW = "async function fetchEightfold(company) {\n      const host = company.api_base, domain = company.slug;\n      if (!host || !domain) return { rows: [], ok: false };\n      const LIMIT = 10, MAX_PAGES = 5;\n      let tier = 'smartapply';\n      const rows = [];\n      let ok = false;\n      for (let page = 0; page < MAX_PAGES; page++) {\n        const start = page * LIMIT;\n        const qs = 'domain=' + encodeURIComponent(domain) + '&start=' + start + '&num=' + LIMIT;\n        let path = (tier === 'pcsx' ? '/api/pcsx/search?' : '/api/apply/v2/jobs?') + qs;\n        let res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });\n        let data; try { data = JSON.parse(res.body); } catch (e) { data = null; }\n        // s112: smartapply can return 200 with a genuinely EMPTY positions array\n        // instead of a 403 (confirmed live: PayPal/Starbucks/Boston Scientific are\n        // all real, working tenants smartapply reports as empty while pcsx returns\n        // real jobs) -- the OLD code only ever fell back to pcsx on a 403, so these\n        // tenants would silently ingest zero jobs forever. Falls back on EITHER\n        // signal now, but only on page 0 -- a later page legitimately running out\n        // of results on an already-working tier must not re-trigger a switch.\n        const smartapplyEmpty = tier === 'smartapply' && page === 0 && res.status === 200 && data && Array.isArray(data.positions) && data.positions.length === 0;\n        if (tier === 'smartapply' && (res.status === 403 || smartapplyEmpty)) {\n          tier = 'pcsx';\n          path = '/api/pcsx/search?' + qs;\n          res = await httpFetch(host, path, 'GET', { Accept: 'application/json' });\n          try { data = JSON.parse(res.body); } catch (e) { data = null; }\n        }\n        if (res.status !== 200 || !data) break;\n        ok = true;\n        const positions = (tier === 'pcsx' ? ((data.data && data.data.positions) || []) : (data.positions || []));\n        if (!positions.length) break;";

function patchPoller() {
  if (!fs.existsSync(POLLER_FILE)) { console.error('INTEGRITY FAIL: poller file missing'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(POLLER_FILE, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  if (!N['Parse Jobs']) { console.error('INTEGRITY FAIL: Parse Jobs node not found'); process.exit(1); }
  if (N['Parse Jobs'].parameters.jsCode.includes('smartapplyEmpty')) { console.log('  poller: already patched'); return; }
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', FE_OLD, FE_NEW, 'fetchEightfold pcsx fallback');
  fs.writeFileSync(POLLER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: fetchEightfold pcsx-fallback fix applied -- ${wf.nodes.length} nodes`);
}

// ── Registry Seeder SEED array: append confirmed rows for fresh-clone reproducibility ──
const SEED_ANCHOR_OLD = "  // s111: Google's own careers site, self-fetch HTML adapter (no public API).\n  { name: 'Google', ats_type: 'google', slug: 'google', api_base: '', tier: 'dream' },\n];";
function buildSeedAddition() {
  const lines = CONFIRMED.map((c) => `  { name: '${c.name.replace(/'/g, "\\'")}', ats_type: '${c.ats_type}', slug: '${c.slug}', api_base: '${c.api_base}', tier: 'dream' },`);
  return "  // s111: Google's own careers site, self-fetch HTML adapter (no public API).\n  { name: 'Google', ats_type: 'google', slug: 'google', api_base: '', tier: 'dream' },\n  // s112: F500 Eightfold/SmartRecruiters manual-discovery batch (11 of 38 --\n  // partial, see the script header for what's confirmed vs still open).\n" + lines.join('\n') + "\n];";
}

function patchSeeder() {
  if (!fs.existsSync(SEEDER_FILE)) { console.error('INTEGRITY FAIL: seeder file missing'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(SEEDER_FILE, 'utf8'));
  const buildNode = wf.nodes.find((n) => n.name === 'Build Seed List');
  if (!buildNode) { console.error('INTEGRITY FAIL: Build Seed List node not found'); process.exit(1); }
  if (buildNode.parameters.jsCode.includes("name: 'ServiceNow'")) { console.log('  seeder: already patched'); return; }
  replaceOnce(buildNode.parameters, 'jsCode', SEED_ANCHOR_OLD, buildSeedAddition(), 'append s112 confirmed rows');
  fs.writeFileSync(SEEDER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: Registry Seeder SEED array gained ${CONFIRMED.length} s112 rows`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. simulate the OLD vs NEW fetchEightfold logic against 3 real-shaped
  //    response fixtures (smartapply-200-empty then pcsx-real, matching the
  //    ACTUAL PayPal/Starbucks/Boston Scientific responses captured live).
  async function simulate(src, responses) {
    let call = 0;
    async function httpFetch() { return responses[call++]; }
    const factory = new Function('httpFetch', `return (${src});`);
    const fetchEightfold = factory(httpFetch);
    return fetchEightfold({ company_id: 1, board: 'eightfold:test', api_base: 'test.eightfold.ai', slug: 'test.com' });
  }
  const FIXTURE_RESPONSES = [
    { status: 200, body: JSON.stringify({ positions: [] }) }, // smartapply page 0: real tenant, empty
    { status: 200, body: JSON.stringify({ data: { positions: [{ name: 'Real Job', id: 1, ats_job_id: '1' }] } }) }, // pcsx page 0: real data
    { status: 200, body: JSON.stringify({ data: { positions: [] } }) }, // pcsx page 1: no more results (NEW path only -- OLD breaks after page 0)
  ];
  // wrap FE_OLD/FE_NEW into complete standalone functions for the harness (they're mid-file fragments in the real patch)
  const OLD_FULL = FE_OLD + "\n        for (const j of positions) { rows.push({ external_id: String(j.id||''), title: j.name||'' }); }\n        if (rows.length >= 25) break;\n      }\n      return { rows, ok };\n    }";
  const NEW_FULL = FE_NEW + "\n        for (const j of positions) { rows.push({ external_id: String(j.id||''), title: j.name||'' }); }\n        if (rows.length >= 25) break;\n      }\n      return { rows, ok };\n    }";

  return Promise.all([simulate(OLD_FULL, FIXTURE_RESPONSES.slice()), simulate(NEW_FULL, FIXTURE_RESPONSES.slice())]).then(([oldResult, newResult]) => {
    if (oldResult.rows.length !== 0) { console.error('HARNESS SANITY FAIL: expected the OLD code to get zero rows from this fixture (proving the bug is real)'); process.exit(1); }
    if (newResult.rows.length !== 1 || newResult.rows[0].title !== 'Real Job') {
      console.error('HARNESS FAIL: NEW fetchEightfold should recover the real pcsx job, got', JSON.stringify(newResult)); process.exit(1);
    }

    // 2. CONFIRMED rows are well-formed and match the seeder's row shape.
    for (const c of CONFIRMED) {
      if (!c.name || !c.ats_type || !c.slug) { console.error('HARNESS FAIL: malformed CONFIRMED row', JSON.stringify(c)); process.exit(1); }
    }
    const names = new Set(CONFIRMED.map((c) => c.name));
    if (names.size !== CONFIRMED.length) { console.error('HARNESS FAIL: duplicate name in CONFIRMED'); process.exit(1); }

    console.log(`HARNESS OK: reproduced the real smartapply-empty bug against the OLD code (0 rows), confirmed the NEW code recovers via pcsx (1 real row); all ${CONFIRMED.length} CONFIRMED rows well-formed and unique.`);

    patchPoller();
    patchSeeder();
    console.log('S112 (Eightfold/SmartRecruiters discovery batch) script complete.');
  });
})();
