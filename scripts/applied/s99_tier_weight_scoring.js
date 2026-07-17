/**
 * s99_tier_weight_scoring.js -- wires the company_tiers.json data (Phase B
 * of the semi-RAG reference-data wave; DB column + registry seed already
 * shipped in 2e2b197) into live scoring and the digest display. This is
 * where the tier data earns its keep for the ~99.4% of companies NOT
 * already in the registry (any company name a web search surfaces gets
 * scored/badged the same way, no registry row required).
 *
 * Parse Scorer Output: score100's company_health dimension was a flat,
 * unconditional 60 for every job (the "S5 company-health feature" this
 * comment referenced was apparently never built) -- now blends toward 100
 * for a tiered company (weight 1.0 -> 100, weight 0.45 -> 72), proportional
 * to company_tiers.json's weight, via the same normalized-name lookup
 * build_reference_data.js/seed_company_tier_weights.js already use.
 * Untiered companies keep the existing neutral 60 baseline unchanged.
 *
 * Build Telegraph Body: a ⭐ prefix on the company name for any job whose
 * company matches company_tiers.json at weight >= 0.9 (MAANGO/top-fintech-
 * quant), in both the top-3 message and the Telegraph appendix.
 *
 * No node count change (2 existing nodes). Run: inside the n8n container
 * with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const TIER_LOOKUP_HELPER = `// s99: normalized-name lookup against company_tiers.json -- mirrored from
// build_reference_data.js/seed_company_tier_weights.js (keep the normalizer
// in sync if any of those change). Fail-open: returns null on any read/parse
// error, callers treat null as "untiered."
const NAME_SUFFIX_RX = /\\b(incorporated|corporation|company|limited|holdings?|group|llc|inc|corp|co|ltd|llp|plc|gmbh|ag|sa|nv|bv)\\b\\.?/g;
function normalizeCompanyName(raw) {
  return String(raw || '').toLowerCase().replace(/&/g, 'and').replace(/[.,'"()]/g, '').replace(NAME_SUFFIX_RX, '').replace(/\\s+/g, ' ').trim();
}
let COMPANY_TIERS = null;
try { COMPANY_TIERS = JSON.parse(require('fs').readFileSync('/home/node/.n8n-files/companies/reference/company_tiers.json', 'utf8')).companies || {}; } catch (e) { COMPANY_TIERS = null; }
function tierLookup(companyName) {
  if (!COMPANY_TIERS) return null;
  return COMPANY_TIERS[normalizeCompanyName(companyName)] || null;
}`;

// ═══ 1. Parse Scorer Output: company_health blends toward 100 for a tiered company ═══
const HEALTH_OLD = `    company_health: 60,`;
const HEALTH_NEW = `    company_health: (() => { const t = tierLookup(job.company); return t ? Math.round(50 + t.w * 50) : 60; })(),`;

// ═══ 2. Build Telegraph Body: ⭐ prefix for tier_weight >= 0.9 companies ═══
const TOP3_OLD = `  top3Msg += '    🏢 ' + clean(job.company) + ' · 📍 ' + displayLocation(job) + '\\n';`;
const TOP3_NEW = `  top3Msg += '    🏢 ' + tierStar(job.company) + clean(job.company) + ' · 📍 ' + displayLocation(job) + '\\n';`;

const APPENDIX_OLD = `const metaParts = [clean(job.company) || 'Unknown', displayLocation(job)];`;
const APPENDIX_NEW = `const metaParts = [(tierStar(job.company) + clean(job.company)) || 'Unknown', displayLocation(job)];`;

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.split(oldStr).join(newStr);
}

// The appendix's metaParts line is byte-identical to the main-content one
// (Build Telegraph Body has two near-duplicate render blocks -- top-30 vs
// appendix) -- both need the star prefix, so this asserts exactly 2 and
// replaces both.
function replaceExactlyTwo(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 2) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 2`); process.exit(1); }
  container[key] = val.split(oldStr).join(newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Parse Scorer Output'] || !N['Build Telegraph Body']) { console.error(`INTEGRITY FAIL ${base}: required node missing`); process.exit(1); }
  if (N['Parse Scorer Output'].parameters.jsCode.includes('s99:')) { console.log(`  ${base}: already patched`); return; }

  const pso = N['Parse Scorer Output'].parameters;
  // Insert the tier-lookup helper right before the sub-scores map (reuses the
  // exact anchor already used by s98's location fix, one line further up).
  replaceOnce(pso, 'jsCode', `const _clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));`,
    `const _clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));\n${TIER_LOOKUP_HELPER}`,
    'tier lookup helper insertion', base);
  replaceOnce(pso, 'jsCode', HEALTH_OLD, HEALTH_NEW, 'company_health tier blend', base);

  const btb = N['Build Telegraph Body'].parameters;
  replaceOnce(btb, 'jsCode', `function clean(slug) { return (slug || '').replace(/-/g,' ').replace(/\\b\\w/g, l => l.toUpperCase()); }`,
    `function clean(slug) { return (slug || '').replace(/-/g,' ').replace(/\\b\\w/g, l => l.toUpperCase()); }\n${TIER_LOOKUP_HELPER}\nfunction tierStar(companyName) { const t = tierLookup(companyName); return (t && t.w >= 0.9) ? '⭐ ' : ''; }`,
    'tier lookup helper insertion', base);
  replaceOnce(btb, 'jsCode', TOP3_OLD, TOP3_NEW, 'top3 star prefix', base);
  replaceExactlyTwo(btb, 'jsCode', APPENDIX_OLD, APPENDIX_NEW, 'appendix star prefix (main + appendix blocks)', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: company_tiers.json wired into score100 + digest ⭐ badge -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // Always read the real committed tier data for harness testing, regardless
  // of which (possibly scratch/dry-run) directory ROOT points at below.
  const tiers = JSON.parse(fs.readFileSync('/Users/pkowadkar/Projects/n8n/data/reference/company_tiers.json', 'utf8')).companies;
  const NAME_SUFFIX_RX = /\b(incorporated|corporation|company|limited|holdings?|group|llc|inc|corp|co|ltd|llp|plc|gmbh|ag|sa|nv|bv)\b\.?/g;
  function normalizeCompanyName(raw) { return String(raw || '').toLowerCase().replace(/&/g, 'and').replace(/[.,'"()]/g, '').replace(NAME_SUFFIX_RX, '').replace(/\s+/g, ' ').trim(); }
  function tierLookup(name) { return tiers[normalizeCompanyName(name)] || null; }
  function companyHealth(name) { const t = tierLookup(name); return t ? Math.round(50 + t.w * 50) : 60; }
  function tierStar(name) { const t = tierLookup(name); return (t && t.w >= 0.9) ? '⭐ ' : ''; }

  if (companyHealth('Google') !== 100) { console.error('HARNESS FAIL: Google (MAANGO, w=1.0) should score company_health 100', companyHealth('Google')); process.exit(1); }
  if (companyHealth('Jane Street') !== 95) { console.error('HARNESS FAIL: Jane Street (w=0.9) should score 95', companyHealth('Jane Street')); process.exit(1); }
  if (companyHealth('Some Random Startup Nobody Has Heard Of') !== 60) { console.error('HARNESS FAIL: untiered company should stay at neutral 60'); process.exit(1); }
  if (tierStar('Google') !== '⭐ ') { console.error('HARNESS FAIL: Google should get the star'); process.exit(1); }
  if (tierStar('Jane Street') !== '⭐ ') { console.error('HARNESS FAIL: Jane Street (w=0.9) should get the star'); process.exit(1); }
  if (tierStar('Walmart') !== '') { console.error('HARNESS FAIL: Walmart (w=0.8, below 0.9) should NOT get the star', tierStar('Walmart')); process.exit(1); }
  if (tierStar('Some Random Startup') !== '') { console.error('HARNESS FAIL: untiered company should not get a star'); process.exit(1); }
  console.log('HARNESS OK: company_health blends toward 100 for tiered companies (Google->100, Jane Street->95), stays at neutral 60 for untiered; ⭐ badge appears only at weight >= 0.9 (Google/Jane Street yes, Walmart at 0.8 no)');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
