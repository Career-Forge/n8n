/**
 * s109_ats_discovery.js -- probes candidate ATS boards for Fortune 500 +
 * Forbes Global 2000 companies not already in the registry, live-verifying
 * each before it's ever written anywhere (the s61/s68 discipline: guessed
 * slug + real HTTP probe + non-empty-jobs confirmation, never a blind
 * insert). Feeds s110's bulk seed.
 *
 * THREE candidate sources, deduped against the live registry by normalized
 * name BEFORE probing (no wasted probes on companies already covered):
 *
 * A. data/reference/raw/f500_ats_2026.csv -- 743 Fortune 500 employers,
 *    portal-verified June 2026, EACH ROW ALREADY NAMES ITS REAL ATS VENDOR.
 *    This is the high-value source: for a reachable vendor (workday/
 *    greenhouse/lever/ashby/eightfold/smartrecruiters/avature/workable) we
 *    already know WHICH adapter to probe -- only the slug is unknown. Rows
 *    on an unreachable vendor (SuccessFactors/Oracle/iCIMS/Taleo/internal/
 *    etc, no adapter in this codebase) are skipped, logged in the misses
 *    report as "vendor unreachable" (honest, not silently dropped).
 *
 * B. data/reference/raw/forbes_global2000_2021.csv -- 2000 largest public
 *    companies globally (2021 vintage -- disclosed staleness, ~10%/yr
 *    membership churn is acceptable for a seed list; F500 above is the
 *    fresher, higher-confidence source and is tried first). Vendor
 *    UNKNOWN per row here, so every candidate tries ALL supported ATS
 *    types. User instruction: this is about PRODUCT/tech companies, not
 *    every bank/oil major/regional bank Forbes ranks by pure revenue --
 *    filtered to the 5 tech-native `industry` values (IT Software &
 *    Services, Technology Hardware & Equipment, Semiconductors,
 *    Telecommunications Services, Media), ~253 of the 2000 rows. This
 *    filter is a judgment call, disclosed here and in the misses report
 *    rather than silently applied.
 *
 * C. data/reference/company_tiers.json's non-fortune500 overlay (89 rows,
 *    hand-curated maango/top_fintech_quant/other_dream/etc names) -- small,
 *    vendor unknown, tries all types. This is the SAME file s99 already
 *    wired into scoring, now doing double duty as a seed candidate source.
 *
 * EXCLUSION (user instruction, verbatim: skip Indian consultancies that
 * "pay below minimum wage at top product companies"): TCS, Infosys, Wipro
 * -- exact-name filtered out of all 3 sources before probing.
 *
 * PROBE METHOD (exact URL shapes from Build Requests / Parse Jobs in
 * CareerForge_ATS_Poller.json, confirmed by this session's own Explore
 * agent -- these are the SAME endpoints the poller itself calls at
 * runtime, so a probe hit is a guarantee the poller can fetch it too):
 *   greenhouse       GET  boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 *   lever            GET  api.lever.co/v0/postings/{slug}?mode=json
 *   ashby            GET  api.ashbyhq.com/posting-api/job-board/{slug}
 *   workable         GET  apply.workable.com/api/v1/widget/accounts/{slug}?details=true
 *   recruitee        GET  {slug}.recruitee.com/api/offers
 *   smartrecruiters  GET  api.smartrecruiters.com/v1/companies/{slug}/postings?limit=5
 *   workday          POST {tenant}.{wdN}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 *                    (tenant x wdN x site is a real grid -- see WORKDAY_SITES/
 *                    WORKDAY_WDN below; bounded, first hit wins, most
 *                    companies resolve in the first few tries or not at all)
 *   avature/eightfold/smartrecruiters-opaque-id: NOT blind-guessed here --
 *    Eightfold's api_base and SmartRecruiters' companyIdentifier are opaque
 *    per-tenant values that don't derive from a company name (confirmed by
 *    the v9 wave: guessed values return "well-formed-but-empty" responses,
 *    worse than a clean 404 because nothing ever flags it as wrong). Those
 *    go to s112's manual-discovery batch instead, per the F500 CSV's own
 *    vendor tag routing them there.
 *
 * CONFIRMATION = a real, non-empty jobs response (s61/s68 discipline).
 * Clean 404 / network error / empty-but-well-formed = try the next
 * candidate; all exhausted = miss, logged with a reason, never guessed.
 *
 * Mechanics: rate-limited (250ms between requests, global), checkpointed
 * to scratchpad every 25 companies processed (resumable after interrupt),
 * meant to run in the background for the full multi-hour candidate set.
 * Output: data/registry_import/seed_f500_f2000_2026-07.json (seeder-shape
 * rows: name/ats_type/slug/api_base/tier) + a misses report alongside it,
 * both git-tracked for reproducibility (small, unlike the raw sources).
 *
 * Run: node scripts/s109_ats_discovery.js [--limit N] [--only workday|...]
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RAW_F500 = path.join(ROOT, 'data', 'reference', 'raw', 'f500_ats_2026.csv');
const RAW_F2000 = path.join(ROOT, 'data', 'reference', 'raw', 'forbes_global2000_2021.csv');
const TIERS_FILE = path.join(ROOT, 'data', 'reference', 'company_tiers.json');
const OUT_DIR = path.join(ROOT, 'data', 'registry_import');
const OUT_SEED = path.join(OUT_DIR, 'seed_f500_f2000_2026-07.json');
const OUT_MISSES = path.join(OUT_DIR, 'seed_f500_f2000_2026-07_misses.json');
const CHECKPOINT = '/private/tmp/claude-501/-Users-pkowadkar-Projects-n8n/6dc5b079-e107-4f4e-8eb3-64387ca20be1/scratchpad/s109_checkpoint.json';

const EXCLUDE_NAMES = new Set(['tcs', 'tataconsultancyservices', 'infosys', 'wipro']);

const RATE_LIMIT_MS = 250;
const REQUEST_TIMEOUT_MS = 8000;

// ── name normalization (same convention as s67's slug normalize + this
//    session's own dedup queries) ──
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(inc|incorporated|corp|corporation|co|company|group|holdings|plc|ltd|limited|llc|the)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function slugVariants(name) {
  const base = String(name || '').trim();
  const stripped = base.replace(/\b(Inc|Incorporated|Corp|Corporation|Co|Company|Group|Holdings|plc|Ltd|Limited|LLC|The)\b\.?/gi, '').trim();
  const lower = stripped.toLowerCase();
  const nospace = lower.replace(/[^a-z0-9]/g, '');
  const hyphen = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const firstWord = lower.split(/\s+/)[0].replace(/[^a-z0-9]/g, '');
  const variants = [nospace, hyphen];
  if (firstWord && firstWord !== nospace && firstWord.length >= 3) variants.push(firstWord);
  return [...new Set(variants.filter(Boolean))];
}

// ── ATS vendor string (from f500_ats_2026.csv) -> our ats_type + whether reachable ──
const VENDOR_MAP = {
  'workday': 'workday',
  'greenhouse': 'greenhouse',
  'lever': 'lever',
  'ashby': 'ashby',
  'workable': 'workable',
  'avature': 'avature',
  // opaque-id types -- routed to s112, not probed here (see header)
  'eightfold': null,
  'smartrecruiters': null,
};
function mapVendor(raw) {
  const key = String(raw || '').toLowerCase().trim();
  for (const k of Object.keys(VENDOR_MAP)) { if (key.includes(k)) return VENDOR_MAP[k]; }
  return undefined; // unrecognized/unreachable vendor (successfactors, oracle, icims, taleo, internal, etc)
}

// ── Forbes Global 2000: tech-native industries only (see header rationale) ──
const F2000_INDUSTRIES = new Set([
  'IT Software & Services',
  'Technology Hardware & Equipment',
  'Semiconductors',
  'Telecommunications Services',
  'Media',
]);

// ── Workday probe grid -- bounded, first-hit-wins. Expanded from the
//    ORIGINAL 6-pattern grid after a live validation run showed real
//    Workday site slugs are far more idiosyncratic than name-derived
//    guessing can reliably predict (Disney: "disneycareer" singular,
//    Dentsu Aegis: "dan_global", Genpact: "external_careers", Walmart:
//    "walmartexternal") -- widened to the union of every real pattern
//    observed in this registry (post s108 dedup) plus this validation
//    round, but Workday's hit rate will still be meaningfully lower than
//    Greenhouse/Lever/Ashby's name=slug convention. Real misses here are
//    disclosed in the output misses report, not silently forced with a
//    wrong guess -- s112-style manual/WebSearch discovery is the correct
//    follow-up for whatever this grid doesn't catch, not a bigger grid
//    chasing diminishing returns. ──
const WORKDAY_WDN = ['wd1', 'wd2', 'wd3', 'wd5', 'wd12'];
const WORKDAY_SITES = (tenant) => {
  const cap = tenant.charAt(0).toUpperCase() + tenant.slice(1);
  return [
    tenant, 'External', 'external', 'External_Career_Site', 'external_career_site',
    'Careers', 'careers', 'CorporateCareers', 'corporatecareers',
    'ExternalCareerSite', tenant + 'external', tenant + 'career', tenant + 'careers',
    cap + 'Careers', cap + 'External', 'external_careers', 'ExternalCareers',
  ];
};

function loadCsv(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l && !l.startsWith('#'));
  const header = lines[0].split(',').map((h) => h.replace(/^"|"$/g, ''));
  // naive CSV split is unsafe for these files (quoted fields with commas) --
  // use a small proper parser.
  function parseLine(line) {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQ = false; }
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    out.push(cur);
    return out;
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = parseLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => { row[h] = cells[idx]; });
    rows.push(row);
  }
  return row => rows; // (kept as a function-return for parity w/ earlier draft; simplifies to rows)
}
function loadCsvRows(file) {
  return loadCsv(file)();
}

function getRegistryNames() {
  const out = execSync(
    `docker exec careerforge_postgres psql -U careerforge -d careerforge -t -A -c "SELECT lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')) FROM companies"`,
    { maxBuffer: 1024 * 1024 * 32 }
  ).toString();
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}

// ════════════════════════ candidate assembly ════════════════════════
function buildCandidates() {
  const registryNames = getRegistryNames();
  const seen = new Set(); // dedup across all 3 sources by normalized name
  const candidates = [];
  const skipped = [];

  function tryAdd(name, forcedType, tierHint) {
    const n = normName(name);
    if (!n || EXCLUDE_NAMES.has(n)) { if (n) skipped.push({ name, reason: 'excluded (consultancy)' }); return; }
    if (registryNames.has(n)) { skipped.push({ name, reason: 'already in registry' }); return; }
    if (seen.has(n)) { skipped.push({ name, reason: 'duplicate across sources' }); return; }
    seen.add(n);
    candidates.push({ name, forcedType: forcedType || null, tierHint: tierHint || 'probe' });
  }

  // Source A: F500 with known vendor
  const f500 = loadCsvRows(RAW_F500);
  let f500UnreachableCount = 0;
  for (const r of f500) {
    const type = mapVendor(r.ats_system);
    if (type === undefined) { skipped.push({ name: r.name, reason: `unrecognized vendor: ${r.ats_system}` }); continue; }
    if (type === null) { skipped.push({ name: r.name, reason: `opaque-id vendor (${r.ats_system}) -- routed to s112` }); continue; }
    tryAdd(r.name, type, 'probe');
  }

  // Source B: Forbes 2000, tech-native industries, vendor unknown -> try all types
  const f2000 = loadCsvRows(RAW_F2000);
  for (const r of f2000) {
    if (!F2000_INDUSTRIES.has(r.industry)) continue;
    tryAdd(r.organizationName, null, 'probe');
  }

  // Source C: curated overlay (company_tiers.json non-fortune500 entries)
  const tiersData = JSON.parse(fs.readFileSync(TIERS_FILE, 'utf8')).companies;
  for (const [, v] of Object.entries(tiersData)) {
    if (v.tier === 'fortune500') continue; // already covered by source A/B at large
    tryAdd(v.name, null, 'dream');
  }

  return { candidates, skipped };
}

// ════════════════════════ probing ════════════════════════
async function fetchJson(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const text = await res.text();
    try { return { ok: true, status: res.status, json: JSON.parse(text) }; }
    catch (e) { return { ok: false, status: res.status, parseError: true }; }
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e) };
  } finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeGreenhouse(slug) {
  const r = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`);
  if (r.ok && Array.isArray(r.json.jobs) && r.json.jobs.length > 0) return { hit: true, api_base: '' };
  return { hit: false };
}
async function probeLever(slug) {
  const r = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (r.ok && Array.isArray(r.json) && r.json.length > 0) return { hit: true, api_base: '' };
  return { hit: false };
}
async function probeAshby(slug) {
  const r = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
  if (r.ok && Array.isArray(r.json.jobs) && r.json.jobs.length > 0) return { hit: true, api_base: '' };
  return { hit: false };
}
async function probeWorkable(slug) {
  const r = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`);
  if (r.ok && Array.isArray(r.json.jobs) && r.json.jobs.length > 0) return { hit: true, api_base: '' };
  return { hit: false };
}
async function probeRecruitee(slug) {
  const r = await fetchJson(`https://${slug}.recruitee.com/api/offers`);
  if (r.ok && Array.isArray(r.json.offers) && r.json.offers.length > 0) return { hit: true, api_base: '' };
  return { hit: false };
}
async function probeSmartrecruiters(slug) {
  const r = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=5`);
  if (r.ok && Array.isArray(r.json.content) && r.json.content.length > 0) return { hit: true, api_base: '' };
  return { hit: false };
}
async function probeWorkday(tenantSlug) {
  for (const wdN of WORKDAY_WDN) {
    for (const site of WORKDAY_SITES(tenantSlug)) {
      await sleep(RATE_LIMIT_MS);
      const host = `${tenantSlug}.${wdN}.myworkdayjobs.com`;
      const r = await fetchJson(`https://${host}/wday/cxs/${tenantSlug}/${site}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 5, offset: 0, searchText: '' }),
      });
      if (r.ok && Array.isArray(r.json.jobPostings) && (r.json.total || 0) > 0) {
        return { hit: true, slug: site, api_base: `${tenantSlug}.${wdN}` };
      }
    }
  }
  return { hit: false };
}

const PROBERS = {
  greenhouse: probeGreenhouse, lever: probeLever, ashby: probeAshby,
  workable: probeWorkable, recruitee: probeRecruitee, smartrecruiters: probeSmartrecruiters,
};
const NON_WORKDAY_TYPES = Object.keys(PROBERS);

async function probeCompany(candidate) {
  const { name, forcedType } = candidate;
  const variants = slugVariants(name);
  const typesToTry = forcedType ? [forcedType] : [...NON_WORKDAY_TYPES, 'workday'];

  for (const type of typesToTry) {
    if (type === 'workday') {
      for (const v of variants) {
        const res = await probeWorkday(v);
        if (res.hit) return { name, ats_type: 'workday', slug: res.slug, api_base: res.api_base, tier: candidate.tierHint };
      }
    } else {
      const prober = PROBERS[type];
      if (!prober) continue;
      for (const v of variants) {
        await sleep(RATE_LIMIT_MS);
        const res = await prober(v);
        if (res.hit) return { name, ats_type: type, slug: v, api_base: res.api_base, tier: candidate.tierHint };
      }
    }
  }
  return null;
}

// ════════════════════════ HARNESS (structural, no network) ════════════════════════
(function harness() {
  if (normName('Mastercard Inc.') !== 'mastercard') { console.error('HARNESS FAIL: normName suffix strip'); process.exit(1); }
  if (normName('JPMorgan Chase & Co.') !== 'jpmorganchaseco' && normName('JPMorgan Chase & Co.') !== 'jpmorganchase') {
    // '&' strips to nothing, 'co' matches the suffix regex only as a whole word -- accept either shape, just prove it's deterministic and non-empty
    if (!normName('JPMorgan Chase & Co.')) { console.error('HARNESS FAIL: normName produced empty string'); process.exit(1); }
  }
  const variants = slugVariants('Bank of America Corporation');
  if (!variants.includes('bankofamerica')) { console.error('HARNESS FAIL: slugVariants nospace form', variants); process.exit(1); }
  if (!variants.includes('bank-of-america')) { console.error('HARNESS FAIL: slugVariants hyphen form', variants); process.exit(1); }
  if (mapVendor('Workday') !== 'workday') { console.error('HARNESS FAIL: mapVendor workday'); process.exit(1); }
  if (mapVendor('SAP SuccessFactors') !== undefined) { console.error('HARNESS FAIL: mapVendor should not recognize SuccessFactors'); process.exit(1); }
  if (mapVendor('Eightfold') !== null) { console.error('HARNESS FAIL: mapVendor Eightfold should route to s112 (null)'); process.exit(1); }
  if (EXCLUDE_NAMES.has(normName('Tata Consultancy Services')) === false && normName('Tata Consultancy Services') !== 'tataconsultancyservices') {
    console.error('HARNESS FAIL: TCS normalization mismatch, got', normName('Tata Consultancy Services')); process.exit(1);
  }
  console.log('HARNESS OK: normName/slugVariants/mapVendor verified against real-shaped fixtures.');
})();

// ════════════════════════ MAIN ════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;
  const dryRun = args.includes('--dry-run');

  const { candidates, skipped } = buildCandidates();
  let pool = only ? candidates.filter((c) => c.forcedType === only) : candidates;
  if (limit !== null && !Number.isNaN(limit)) pool = pool.slice(0, limit);
  if (dryRun) {
    console.log(`--dry-run: ${candidates.length} candidates assembled (${skipped.length} skipped before probe). No network calls made.`);
    console.log('Sample skipped reasons:', [...new Set(skipped.map((s) => s.reason))]);
    console.log('First 10 candidates:', pool.slice(0, 10).map((c) => `${c.name} (${c.forcedType || 'unknown vendor'})`));
    return;
  }

  console.log(`Candidates to probe: ${pool.length} (skipped ${skipped.length}: already-in-registry / excluded / duplicate / unreachable-vendor)`);

  let hits = [];
  let misses = [];
  let startIdx = 0;
  if (fs.existsSync(CHECKPOINT)) {
    const cp = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
    hits = cp.hits; misses = cp.misses; startIdx = cp.nextIdx;
    console.log(`Resuming from checkpoint: ${startIdx}/${pool.length} already processed`);
  }

  for (let i = startIdx; i < pool.length; i++) {
    const c = pool[i];
    try {
      const result = await probeCompany(c);
      if (result) { hits.push(result); console.log(`HIT  [${i + 1}/${pool.length}] ${c.name} -> ${result.ats_type}:${result.slug}${result.api_base ? ' (' + result.api_base + ')' : ''}`); }
      else { misses.push({ name: c.name, reason: 'no candidate slug resolved' }); console.log(`miss [${i + 1}/${pool.length}] ${c.name}`); }
    } catch (e) {
      misses.push({ name: c.name, reason: `error: ${e.message}` });
    }
    if ((i + 1) % 25 === 0 || i === pool.length - 1) {
      fs.writeFileSync(CHECKPOINT, JSON.stringify({ hits, misses, nextIdx: i + 1 }, null, 2));
    }
  }

  const seedRows = hits.map((h) => ({ name: h.name, ats_type: h.ats_type, slug: h.slug, api_base: h.api_base || '', tier: h.tier }));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_SEED, JSON.stringify({ generated_at: new Date().toISOString(), source: 's109_ats_discovery.js', count: seedRows.length, rows: seedRows }, null, 2));
  fs.writeFileSync(OUT_MISSES, JSON.stringify({ generated_at: new Date().toISOString(), skipped_before_probe: skipped, misses_after_probe: misses }, null, 2));

  console.log(`\nDone. ${seedRows.length} verified hits -> ${OUT_SEED}`);
  console.log(`${misses.length} probed-but-no-hit + ${skipped.length} skipped-before-probe -> ${OUT_MISSES}`);
  if (fs.existsSync(CHECKPOINT)) fs.unlinkSync(CHECKPOINT);
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
}
