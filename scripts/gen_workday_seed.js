/* Generate db/seed_workday.sql from one or more discovery outputs.
 * Includes OK rows + manually-rescued REVIEW rows (valid ticker tenants the
 * name-guard couldn't confirm), drops audited false-positives + denylisted
 * body-shops, dedups by slug, tier-tags, emits companies + company_tiers upserts.
 * Run: node scripts/gen_workday_seed.js <out1> [<out2> ...]
 */
const fs = require('fs');
const path = require('path');
const OUT = path.resolve(__dirname, '..', 'db', 'seed_workday.sql');

// Audited false-positives (search matched a different company) + denylisted body-shops.
const DROP = new Set([
  // batch-1 FPs
  'Teva Pharmaceutical', 'Quest Diagnostics', 'Boston Scientific', 'Bayer', 'MetLife',
  'Lincoln Financial', 'Willis Towers Watson', 'Progressive', 'Splunk', 'AMD', 'ServiceNow',
  'DocuSign', 'Western Digital', 'Discover Financial', 'Ally Financial', 'Chubb',
  'American Express', 'BNY Mellon', 'Emerson Electric', 'John Deere', 'General Mills',
  'Cummins', 'Marriott', 'Aon', 'Horizon Blue Cross Blue Shield',
  // batch-2 OK partial-substring FPs
  'Lumen Technologies', 'Citizens Financial', 'Cooper Companies', 'Roper Technologies',
  // denylisted IT body-shops
  'DXC Technology', 'Cognizant',
]);

// REVIEW rows that are genuinely valid (ticker/abbrev tenant the guard couldn't confirm).
const RESCUE = new Set([
  'Johnson & Johnson', 'Cencora', 'CSL Behring', 'Neurocrine Biosciences', 'Sarepta Therapeutics',
  'VF Corporation', 'Old Dominion', 'Warner Bros Discovery', 'Constellation Brands',
  'Johnson Controls', 'Guidewire Software', 'Cadence Design Systems', 'M&T Bank',
  'Huntington Bancshares', "O'Reilly Automotive", 'Cox Communications', 'Wyndham', 'Las Vegas Sands',
  'Edwards Lifesciences',
]);

// Desirability tier A (strong pay: tech + banks/payments/asset-mgmt); else B.
const A_TIER = new Set([
  // batch 1
  'Adobe', 'Salesforce', 'Snap', 'Intel', 'Cisco', 'Micron Technology', 'Broadcom',
  'Applied Materials', 'KLA', 'Marvell', 'Analog Devices', 'Autodesk', 'PayPal', 'eBay', 'Zoom',
  'Workday', 'Morgan Stanley', 'Bank of America', 'Citi', 'Wells Fargo', 'Capital One', 'Mastercard',
  'BlackRock', 'State Street', 'PNC Financial', 'U.S. Bank', 'Truist', 'Northern Trust', 'Nasdaq',
  'S&P Global', 'FIS', 'Fiserv', 'Global Payments', 'Synchrony',
  // batch 2
  'Visa', 'Vanguard', 'TIAA', 'Ameriprise Financial', 'Raymond James', 'Invesco', 'T. Rowe Price',
  'Franklin Templeton', 'Fifth Third Bank', 'Regions Financial', 'KeyBank', 'Western Union',
  'Worldpay', 'M&T Bank', 'Huntington Bancshares', 'Workiva', 'PTC', 'Zendesk', 'Genesys',
  'Zebra Technologies', 'Guidewire Software', 'Cadence Design Systems',
]);

const files = process.argv.slice(2);
const rows = [];
const seenSlug = new Set();
for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const parts = line.split('\t');
    const tag = parts[0];
    if (tag !== 'OK' && tag !== 'REVIEW') continue;
    const [, name, tenant, wd, site, total, cxs] = parts;
    if (!name || !cxs) continue;
    if (DROP.has(name)) continue;
    if (tag === 'REVIEW' && !RESCUE.has(name)) continue;   // REVIEW kept only if rescued
    if (seenSlug.has(tenant)) continue;                    // dedup by tenant (UNIQUE ats_type,slug)
    seenSlug.add(tenant);
    rows.push({ name, tenant, cxs: cxs.trim(), total: parseInt(total, 10) || 0,
                tier: A_TIER.has(name) ? 'A' : 'B' });
  }
}
rows.sort((a, b) => a.name.localeCompare(b.name));

const sq = s => "'" + String(s).replace(/'/g, "''") + "'";
const companies = rows.map(r =>
  `  (${sq(r.name)},'workday',${sq(r.tenant)},${sq(r.cxs)},'hot',true,now(),'6 hours')`).join(',\n');
const tiers = rows.map(r =>
  `  (cf_name_norm(${sq(r.name)}),${sq(r.tier)},${sq(r.name)},'workday')`).join(',\n');
const A = rows.filter(r => r.tier === 'A').length;
const sql = `-- ═══════════════════════════════════════════════════════════════
--  Workday tenant seed (W2 + expand) — ${rows.length} CXS-VERIFIED employers (June 2026).
--  Firecrawl /search -> myworkdayjobs URL -> CXS-verified (total>0) -> name-match
--  guard + manual audit (dropped wrong-company FPs, rescued valid ticker tenants).
--  api_base = full CXS base URL. companies.tier='hot' (poll priority); desirability
--  tier in company_tiers (${A} A / ${rows.length - A} B — re-tier freely). Idempotent.
--  Apply: docker exec -i careerforge_postgres psql -U careerforge -d careerforge < db/seed_workday.sql
-- ═══════════════════════════════════════════════════════════════

INSERT INTO companies (name, ats_type, slug, api_base, tier, is_active, next_poll_at, poll_interval) VALUES
${companies}
ON CONFLICT (ats_type, slug) DO UPDATE SET
  name=EXCLUDED.name, api_base=EXCLUDED.api_base, tier='hot', is_active=true, next_poll_at=now();

INSERT INTO company_tiers (name_norm, tier, canonical, notes) VALUES
${tiers}
ON CONFLICT (name_norm) DO UPDATE SET tier=EXCLUDED.tier, canonical=EXCLUDED.canonical, notes=EXCLUDED.notes, updated_at=now();
`;
fs.writeFileSync(OUT, sql);
console.log(`wrote ${OUT}: ${rows.length} tenants (${A} A / ${rows.length - A} B)`);
