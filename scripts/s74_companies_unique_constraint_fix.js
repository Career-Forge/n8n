/**
 * s74_companies_unique_constraint_fix.js -- fixes a real, confirmed-twice
 * data-corruption bug found while seeding GEICO for s73.
 *
 * `companies` had `UNIQUE (ats_type, slug)` -- but for Workday, `slug` is
 * just the site name, and companies routinely reuse generic ones ("External",
 * "External_Career_Site"). Two DIFFERENT real collisions confirmed live in
 * this exact registry: Intel and GEICO both use site "External"; Thomson
 * Reuters and Salesforce both use site "External_Career_Site". Every prior
 * seed script's `ON CONFLICT (ats_type, slug) DO UPDATE SET name = ...`
 * silently renamed the EXISTING company to the NEW one's name while leaving
 * its real tenant (api_base) untouched -- e.g. Salesforce's row has carried
 * Thomson Reuters' real tenant (thomsonreuters.wd5) and served Thomson
 * Reuters' real jobs under the Salesforce label since s68 shipped, and
 * Morgan Stanley (s71) silently renamed that same row again before GEICO
 * (s73) renamed it a third time -- Morgan Stanley never actually got a row
 * of its own. All three now fixed directly in Postgres (Intel and Thomson
 * Reuters restored, Salesforce/GEICO/Morgan Stanley re-inserted as genuinely
 * separate rows) as an immediate data fix, run before this script -- this
 * script is the structural fix so it can't happen again.
 *
 * DB migration (already applied directly, documented here for the record --
 * not re-run by this script, which only patches the two workflow SQL sites):
 *   UPDATE companies SET api_base = '' WHERE api_base IS NULL;
 *   ALTER TABLE companies ALTER COLUMN api_base SET DEFAULT '', SET NOT NULL;
 *   ALTER TABLE companies DROP CONSTRAINT companies_ats_type_slug_key;
 *   ALTER TABLE companies ADD CONSTRAINT companies_ats_type_slug_api_base_key
 *     UNIQUE (ats_type, slug, api_base);
 * Verified safe before applying: zero pre-existing (ats_type, slug) duplicate
 * pairs across the entire table, so widening the key can't violate anything
 * already there -- confirmed via a live COUNT(*) GROUP BY HAVING query.
 * api_base was NULL (not empty string) on 15,559 of 15,588 rows -- backfilled
 * to '' first since the rest of the codebase already treats NULL and '' as
 * equivalent (every read site already does COALESCE(api_base,'')), and a
 * NULL column can't be part of a real uniqueness guarantee (SQL treats every
 * NULL as distinct from every other NULL, which would have silently
 * defeated the constraint for the ~99% of rows -- greenhouse/lever/ashby/etc
 * -- that don't use api_base at all).
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEEDER_TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Registry_Seeder.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Registry_Seeder.json'),
];
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ── Registry Seeder: Upsert Companies ──
const UC_OLD_QUERY = "INSERT INTO companies (name, ats_type, slug, api_base, tier, next_poll_at)\nVALUES ($1, $2, $3, NULLIF($4, '')::text, COALESCE(NULLIF($5, ''), 'probe'), now())\nON CONFLICT (ats_type, slug) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE, tier = CASE WHEN EXCLUDED.tier = 'dream' THEN 'dream' ELSE companies.tier END";
const UC_NEW_QUERY = "INSERT INTO companies (name, ats_type, slug, api_base, tier, next_poll_at)\nVALUES ($1, $2, $3, COALESCE($4, ''), COALESCE(NULLIF($5, ''), 'probe'), now())\nON CONFLICT (ats_type, slug, api_base) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE, tier = CASE WHEN EXCLUDED.tier = 'dream' THEN 'dream' ELSE companies.tier END";

function patchSeeder(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Upsert Companies']) { console.error(`INTEGRITY FAIL ${base}: node "Upsert Companies" not found`); process.exit(1); }
  if (N['Upsert Companies'].parameters.query.includes('ats_type, slug, api_base)')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Upsert Companies'].parameters, 'query', UC_OLD_QUERY, UC_NEW_QUERY, 'widened conflict target', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Upsert Companies now conflicts on (ats_type, slug, api_base) -- can no longer silently rename a different tenant's row -- ${wf.nodes.length} nodes`);
}

// ── Master workflow: Upsert Discovered Companies (S18 auto-discovery) ──
const UDC_OLD_QUERY = "INSERT INTO companies (name, ats_type, slug, api_base, next_poll_at)\nVALUES ($1, $2, $3, NULLIF($4, '')::text, now())\nON CONFLICT (ats_type, slug) DO NOTHING";
const UDC_NEW_QUERY = "INSERT INTO companies (name, ats_type, slug, api_base, next_poll_at)\nVALUES ($1, $2, $3, COALESCE($4, ''), now())\nON CONFLICT (ats_type, slug, api_base) DO NOTHING";

function patchMaster(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Upsert Discovered Companies']) { console.error(`INTEGRITY FAIL ${base}: node "Upsert Discovered Companies" not found`); process.exit(1); }
  if (N['Upsert Discovered Companies'].parameters.query.includes('ats_type, slug, api_base)')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Upsert Discovered Companies'].parameters, 'query', UDC_OLD_QUERY, UDC_NEW_QUERY, 'widened conflict target', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Upsert Discovered Companies now conflicts on (ats_type, slug, api_base) -- S18 auto-discovery can no longer silently rename a different tenant's row -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // The exact bug, reproduced structurally: two different real tenants sharing
  // one (ats_type, slug) pair must NOT collide under the new conflict target.
  const OLD_KEY = (r) => r.ats_type + '|' + r.slug;
  const NEW_KEY = (r) => r.ats_type + '|' + r.slug + '|' + r.api_base;
  const intel = { name: 'Intel', ats_type: 'workday', slug: 'External', api_base: 'intel.wd1' };
  const geico = { name: 'GEICO', ats_type: 'workday', slug: 'External', api_base: 'geico.wd1' };
  if (OLD_KEY(intel) !== OLD_KEY(geico)) throw new Error('HARNESS SETUP WRONG: these two must collide under the OLD key to prove the bug being fixed');
  if (NEW_KEY(intel) === NEW_KEY(geico)) { console.error('HARNESS FAIL: Intel and GEICO must NOT collide under the new (ats_type, slug, api_base) key'); process.exit(1); }
  // A genuine re-seed of the SAME company (same tenant) must still upsert cleanly, not create a duplicate.
  const intelAgain = { name: 'Intel Corp', ats_type: 'workday', slug: 'External', api_base: 'intel.wd1' };
  if (NEW_KEY(intel) !== NEW_KEY(intelAgain)) { console.error('HARNESS FAIL: re-seeding the same real tenant must still match the same key'); process.exit(1); }

  if (!UC_NEW_QUERY.includes('ON CONFLICT (ats_type, slug, api_base)')) { console.error('HARNESS FAIL: Upsert Companies conflict target not widened'); process.exit(1); }
  if (!UDC_NEW_QUERY.includes('ON CONFLICT (ats_type, slug, api_base)')) { console.error('HARNESS FAIL: Upsert Discovered Companies conflict target not widened'); process.exit(1); }
  if (UC_NEW_QUERY.includes('NULLIF($4') || UDC_NEW_QUERY.includes('NULLIF($4')) { console.error('HARNESS FAIL: api_base is NOT NULL now -- NULLIF($4,\'\') would insert NULL and violate the column constraint, must use COALESCE($4,\'\') instead'); process.exit(1); }

  console.log('HARNESS OK: Intel/GEICO (and by the same logic, Thomson Reuters/Salesforce, and any future Workday tenants sharing a generic site name) are structurally distinct under the new 3-column conflict target; a real re-seed of the same tenant still upserts cleanly; api_base insertion no longer risks a NOT NULL violation');
})();

SEEDER_TARGETS.forEach(patchSeeder);
MASTER_TARGETS.forEach(patchMaster);
console.log('S74 (companies unique constraint fix: ats_type+slug+api_base) complete.');
