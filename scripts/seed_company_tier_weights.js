/**
 * seed_company_tier_weights.js -- Phase B of the semi-RAG reference-data
 * wave. Matches every company already in the poller's registry against
 * data/reference/company_tiers.json (normalized-name lookup, same shared
 * normalizer as build_reference_data.js) and bulk-applies the resulting
 * tier_weight via one jsonb_to_recordset UPDATE -- same proven pattern as
 * s95's company-name backfill, verified in a rolled-back transaction before
 * that shipped.
 *
 * Also promotes any company that matched at weight >= 0.9 (MAANGO/top-
 * fintech-quant tier) into the poller's 'dream' priority lane, UNLESS it's
 * already there -- this is the ONLY place tier gets touched; every other
 * tier value the row already has is left alone. No new registry ROWS are
 * created from the tier list here (a company not already in the registry
 * has no ats_type/slug to poll with -- that's the Adapter Expansion doc's
 * job, not this script's).
 *
 * One-time/occasional script, run directly against the live Postgres via
 * `docker exec`. Not an n8n workflow patch -- no deploy/restart needed.
 *
 * Run: node scripts/seed_company_tier_weights.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = path.resolve(__dirname, '..');

// Mirrored from build_reference_data.js -- keep in sync if either changes.
const NAME_SUFFIX_RX = /\b(incorporated|corporation|company|limited|holdings?|group|llc|inc|corp|co|ltd|llp|plc|gmbh|ag|sa|nv|bv)\b\.?/g;
function normalizeCompanyName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[.,'"()]/g, '')
    .replace(NAME_SUFFIX_RX, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function psql(sql) {
  // execFileSync with an args array (not a shell command string) avoids the
  // shell re-escaping a literal tab character would otherwise go through --
  // real bug hit while writing this: a string-command execSync call with
  // -F'\\t' came back with the literal 4-char sequence "\\t" in the output
  // instead of a real tab, silently breaking every split('\t') downstream.
  return execFileSync(
    'docker',
    ['exec', '-i', 'careerforge_postgres', 'psql', '-U', 'careerforge', '-d', 'careerforge', '-t', '-A', '-F', '\t'],
    { input: sql, encoding: 'utf8' }
  );
}

function main() {
  const tiers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reference', 'company_tiers.json'), 'utf8'));
  const companiesRaw = psql('SELECT id, name, tier FROM companies;').trim();
  const rows = companiesRaw ? companiesRaw.split('\n').map((l) => {
    const [id, name, tier] = l.split('\t');
    return { id: Number(id), name, tier };
  }) : [];

  const updates = [];
  const promotions = [];
  for (const row of rows) {
    const key = normalizeCompanyName(row.name);
    const match = tiers.companies[key];
    if (!match) continue;
    updates.push({ company_id: row.id, tier_weight: match.w });
    if (match.w >= 0.9 && row.tier !== 'dream') promotions.push(row.id);
  }

  console.log(`Matched ${updates.length} of ${rows.length} companies (${(100 * updates.length / (rows.length || 1)).toFixed(1)}%) against company_tiers.json.`);
  console.log(`${promotions.length} companies will be promoted to the 'dream' poller lane (tier_weight >= 0.9, not already dream).`);

  if (DRY_RUN) {
    console.log('--dry-run: no database changes made. Sample matches:');
    console.log(updates.slice(0, 10));
    return;
  }
  if (!updates.length) { console.log('Nothing to update.'); return; }

  const updateSql = `
UPDATE companies c
SET tier_weight = v.tier_weight
FROM jsonb_to_recordset('${JSON.stringify(updates).replace(/'/g, "''")}'::jsonb) AS v(company_id bigint, tier_weight numeric)
WHERE c.id = v.company_id;
`;
  console.log(psql(updateSql));

  if (promotions.length) {
    const promoteSql = `UPDATE companies SET tier = 'dream' WHERE id = ANY(ARRAY[${promotions.join(',')}]::bigint[]) AND tier <> 'dream';`;
    console.log(psql(promoteSql));
  }

  const verify = psql("SELECT count(*) FILTER (WHERE tier_weight IS NOT NULL) AS tiered, count(*) FILTER (WHERE tier = 'dream') AS dream_count, count(*) AS total FROM companies;");
  console.log('Post-seed state (tiered / dream / total):', verify.trim());
}

main();
