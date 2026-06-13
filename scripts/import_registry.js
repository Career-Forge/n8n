/**
 * import_registry.js — R3: normalize the job-board-aggregator slug datasets
 * (data/registry_import/*.json — CC BY-NC 4.0, personal use; permission needed
 * for commercial use) into a CSV for bulk-loading the companies registry.
 *
 * Output: data/registry_import/registry_import.csv  (name,ats_type,slug)
 * Load (run by hand):
 *   docker compose exec -T postgres psql -U careerforge -d careerforge <<'SQL'
 *   CREATE TEMP TABLE staging (name TEXT, ats_type TEXT, slug TEXT);
 *   \copy staging FROM '/tmp/registry_import.csv' CSV HEADER
 *   INSERT INTO companies (name, ats_type, slug, poll_interval, next_poll_at, tier)
 *   SELECT name, ats_type, slug, interval '30 days',
 *          now() + (row_number() OVER ()) * interval '36 seconds', 'probe'
 *   FROM staging
 *   ON CONFLICT (ats_type, slug) DO NOTHING;
 *   SQL
 *
 * Run:  node scripts/import_registry.js
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(path.resolve(__dirname, '..'), 'data', 'registry_import');
const SOURCES = [
  { file: 'greenhouse_companies.json', ats: 'greenhouse' },
  { file: 'lever_companies.json', ats: 'lever' },
  { file: 'ashby_companies.json', ats: 'ashby' },
];

const SLUG_RX = /^[a-z0-9][a-z0-9._-]{0,80}$/i;
const csvEscape = (s) => '"' + String(s).replace(/"/g, '""') + '"';

const rows = [];
const seen = new Set();
let skipped = 0;
for (const { file, ats } of SOURCES) {
  const slugs = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  if (!Array.isArray(slugs)) throw new Error(`${file}: expected an array of slugs`);
  for (const raw of slugs) {
    const slug = String(raw).trim();
    if (!SLUG_RX.test(slug)) { skipped++; continue; }
    const key = ats + ':' + slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([slug, ats, slug]);
  }
  console.log(`${file}: ${slugs.length} slugs`);
}

const out = path.join(DIR, 'registry_import.csv');
fs.writeFileSync(out, 'name,ats_type,slug\n' + rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n');
console.log(`wrote ${rows.length} rows (${skipped} skipped as malformed) -> ${out}`);
