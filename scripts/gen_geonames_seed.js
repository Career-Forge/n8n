/* Generate db/seed_geonames.sql from a GeoNames "cities" dump.
 *
 * GeoNames ships tab-separated city dumps by minimum population:
 *   cities500.txt (~200k, pop>=500) | cities5000.txt (~50k) | cities15000.txt (~26k)
 * Download + unzip from https://download.geonames.org/export/dump/ . Default input
 * is cities5000.txt -- it covers every real job market worldwide while keeping the
 * seed lean; swap in cities500.txt for finer town-level coverage (bigger seed).
 *
 * Emits batched, idempotent `INSERT ... ON CONFLICT DO NOTHING` for geo_places +
 * geo_aliases (schema in db/schema.sql, L0 section). name_norm/alias_norm are
 * folded the SAME way cf_resolve_location() normalizes a query (unaccent+lower,
 * non-alnum collapsed) so exact lookups compare equal. Mirrors gen_workday_seed.js.
 *
 * Run:  node scripts/gen_geonames_seed.js [path/to/cities5000.txt]
 * Apply: docker exec -i careerforge_postgres psql -U careerforge -d careerforge < db/seed_geonames.sql
 */
const fs = require('fs');
const path = require('path');

const IN = process.argv[2] || path.resolve(__dirname, '..', 'db', 'geonames', 'cities5000.txt');
const OUT = path.resolve(__dirname, '..', 'db', 'seed_geonames.sql');
const BATCH = 800;          // rows per INSERT statement
const MAX_ALIASES = 15;     // cap alt-names per place (kills the long multi-script tail)

// unaccent(lower(s)) with non-alnum collapsed — matches cf_resolve_location's norm CTE
// for Latin scripts (NFKD strips the same diacritics unaccent does).
function norm(s) {
  return (s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip diacritics
    .toLowerCase().replace(/[^a-z0-9]+/g, '');
}
const sq = s => "'" + String(s).replace(/'/g, "''") + "'";

if (!fs.existsSync(IN)) {
  console.error(`MISSING input: ${IN}\nDownload from https://download.geonames.org/export/dump/ (e.g. cities5000.zip), unzip, and pass the .txt path.`);
  process.exit(1);
}

const places = [];   // [geonameid, name, name_norm, cc, admin1, lat, lng, pop, featCode]
const aliases = [];  // [alias_norm, geonameid]
let skipped = 0;

const lines = fs.readFileSync(IN, 'utf8').split('\n');
for (const line of lines) {
  if (!line) continue;
  const c = line.split('\t');
  const geonameid = parseInt(c[0], 10);
  const name = (c[1] || '').trim();
  const asciiname = (c[2] || '').trim();
  const alt = (c[3] || '').trim();
  const lat = parseFloat(c[4]), lng = parseFloat(c[5]);
  const featCode = (c[7] || '').trim();
  const cc = (c[8] || '').trim().toUpperCase();
  const admin1 = (c[10] || '').trim();
  const pop = parseInt(c[14], 10) || 0;

  const nm = norm(name);
  if (!geonameid || !name || cc.length !== 2 || !Number.isFinite(lat) || !Number.isFinite(lng) || !nm) {
    skipped++; continue;
  }
  places.push([geonameid, name, nm, cc, admin1 || null, lat, lng, pop, featCode || null]);

  // aliases: asciiname + alternatenames, ASCII-folded. Short pure-letter abbreviations
  // (NYC, LA, SF, BLR) and short names are the highest-value query forms, so RANK those
  // first and THEN cap -- a blind first-N cut buried "NYC" at position 17. Drop empties /
  // non-Latin (norm->'') / name-identical / over-long noise.
  const cand = new Map();   // alias_norm -> priority (lower kept first)
  for (const raw of [asciiname, ...alt.split(',')]) {
    const r = (raw || '').trim();
    const an = norm(r);
    if (!an || an.length < 2 || an.length > 40 || an === nm) continue;
    const pri = /^[A-Za-z]{2,5}$/.test(r) ? 0 : 1;   // pure-letter abbreviation first
    if (!cand.has(an) || pri < cand.get(an)) cand.set(an, pri);
  }
  [...cand.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
    .slice(0, MAX_ALIASES)
    .forEach(([an]) => aliases.push([an, geonameid]));
}

function batched(header, rows, fmt) {
  const out = [];
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map(fmt).join(',\n');
    out.push(`${header}\n${chunk}\n${header.includes('geo_places') ? 'ON CONFLICT (geonameid) DO NOTHING' : 'ON CONFLICT DO NOTHING'};`);
  }
  return out.join('\n\n');
}

const placesSql = batched(
  'INSERT INTO geo_places (geonameid, name, name_norm, country_iso, admin1, lat, lng, population, feature_code) VALUES',
  places,
  r => `  (${r[0]},${sq(r[1])},${sq(r[2])},${sq(r[3])},${r[4] == null ? 'NULL' : sq(r[4])},${r[5]},${r[6]},${r[7]},${r[8] == null ? 'NULL' : sq(r[8])})`
);
const aliasSql = batched(
  'INSERT INTO geo_aliases (alias_norm, geonameid) VALUES',
  aliases,
  r => `  (${sq(r[0])},${r[1]})`
);

const sql = `-- ═══════════════════════════════════════════════════════════════
--  GeoNames gazetteer seed — ${places.length} places, ${aliases.length} aliases.
--  Generated from ${path.basename(IN)} by scripts/gen_geonames_seed.js (June 2026).
--  Idempotent (ON CONFLICT DO NOTHING). Apply AFTER db/schema.sql:
--    docker exec -i careerforge_postgres psql -U careerforge -d careerforge < db/seed_geonames.sql
-- ═══════════════════════════════════════════════════════════════

${placesSql}

${aliasSql}
`;
fs.writeFileSync(OUT, sql);
console.log(`wrote ${OUT}: ${places.length} places, ${aliases.length} aliases (${skipped} rows skipped)`);
