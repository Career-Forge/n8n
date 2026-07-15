/**
 * build_reference_data.js -- builds the 3 local JSON reference corpora that
 * back the "semi-RAG" gazetteer/tier/H1B wave (see
 * ~/.claude/plans/semi-rag-reference-data-wave.md). Runs on the HOST (node
 * v26.5.0 confirmed present) -- this is a one-time/occasional regeneration
 * script, not something n8n ever executes. Reads raw source files staged
 * under data/reference/raw/ (gitignored -- see raw/README below), writes
 * the 3 slimmed JSONs to data/reference/ (git-tracked, public, same spirit
 * as the existing 15k registry_import snapshot).
 *
 * Why these files live on disk instead of app_settings/Postgres: n8n
 * serializes every node's OUTPUT into execution_data on every run -- a
 * multi-MB blob emitted from a Load-Geo-Reference-style node would bloat the
 * already-4.4GB SQLite on every single search. Code nodes CAN require('fs')
 * (NODE_FUNCTION_ALLOW_BUILTIN=fs,https), and the existing docker-compose
 * mount `../data:/home/node/.n8n-files/companies:ro` ALREADY exposes this
 * entire directory read-only inside the container -- confirmed live,
 * data/backups and data/registry_import both appear at
 * /home/node/.n8n-files/companies/{backups,registry_import}. So
 * data/reference/*.json lands at
 * /home/node/.n8n-files/companies/reference/*.json inside the container with
 * ZERO docker-compose changes and NO container recreate needed.
 *
 * Sources (see data/reference/README.md for full attribution):
 * - GeoNames cities15000 + countryInfo (CC BY 4.0, download.geonames.org)
 * - Fortune 500 2025 (Salt Technologies AI, CC BY 4.0, salttechno.ai) --
 *   NOTE: this is Fortune 500 (US, revenue-ranked), not Forbes Global 2000 --
 *   the original plan wanted Global 2000 for international public-company
 *   breadth, but no auth-free bulk download was found for it this session
 *   (Kaggle requires an account). This is a real scope reduction, not
 *   silently substituted -- flagged here and in the README.
 * - USCIS H-1B Employer Data Hub, FY2021-2023 (public domain) -- the "archive"
 *   CSVs are the last statically-downloadable years; the live tool page is a
 *   Tableau-embedded interactive dashboard with no bulk CSV link found.
 * - data/reference/company_tier_overrides.json -- hand-curated, NEEDS USER
 *   REVIEW, not derived from any dataset.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'reference', 'raw');
const OUT = path.join(ROOT, 'data', 'reference');

// ═══════════════════════════════════════════════════════════════
// Shared normalizer -- MUST stay byte-identical to the mirrored copy that
// will be embedded in every consumer Code node in Phase B/C (companies +
// H1B lookups). Keep in sync if either changes.
// ═══════════════════════════════════════════════════════════════
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

function log(msg) { console.log(`[build_reference_data] ${msg}`); }

// ═══════════════════════════════════════════════════════════════
// 1. GeoNames gazetteer
// ═══════════════════════════════════════════════════════════════
function buildGazetteer() {
  const citiesPath = path.join(RAW, 'cities15000.txt');
  const countryPath = path.join(RAW, 'countryInfo.txt');
  const oldGeoPath = path.join(RAW, 'old_geo_reference.json');
  if (!fs.existsSync(citiesPath) || !fs.existsSync(countryPath)) {
    log('SKIP gazetteer -- raw GeoNames files not found in data/reference/raw/');
    return;
  }

  // Latin-script filter for alternate names -- GeoNames' alternatenames column
  // includes transliterations in every script (Cyrillic, Arabic, CJK,
  // Devanagari, Amharic, ...); job titles/locations in this system are almost
  // always Latin-script, so keeping non-Latin alternates only bloats the file.
  const LATIN_RX = /^[A-Za-z0-9À-ɏḀ-ỿ\s\-'.,()]+$/;

  const countryLines = fs.readFileSync(countryPath, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const countryNames = {}; // ISO2 -> official name
  const countries = {}; // ISO2 -> [aliases lowercase]
  for (const line of countryLines) {
    const cols = line.split('\t');
    const iso2 = cols[0];
    const name = cols[4];
    if (!iso2 || !name) continue;
    countryNames[iso2] = name;
    countries[iso2] = [name.toLowerCase()];
  }
  // Merge in the existing hand-curated aliases (richer alias sets for the 12
  // countries this project has actually seen in real searches so far).
  if (fs.existsSync(oldGeoPath)) {
    const old = JSON.parse(fs.readFileSync(oldGeoPath, 'utf8'));
    for (const [iso2, aliases] of Object.entries(old.countries || {})) {
      countries[iso2] = [...new Set([...(countries[iso2] || []), ...aliases.map((a) => a.toLowerCase())])];
    }
  }

  const cityLines = fs.readFileSync(citiesPath, 'utf8').split('\n').filter(Boolean);
  const cities = [];
  for (const line of cityLines) {
    const cols = line.split('\t');
    // geonameid, name, asciiname, alternatenames, lat, lon, featClass, featCode,
    // countryCode, cc2, admin1, admin2, admin3, admin4, population, elevation, dem, tz, modDate
    const name = cols[1], asciiname = cols[2], altRaw = cols[3] || '';
    const lat = parseFloat(cols[4]), lon = parseFloat(cols[5]);
    const cc = cols[8], admin1 = cols[10] || '';
    const population = parseInt(cols[14], 10) || 0;
    if (!name || !cc) continue;

    const altCandidates = altRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const seen = new Set([name.toLowerCase(), asciiname.toLowerCase()]);
    const alt = [];
    for (const a of altCandidates) {
      if (alt.length >= 8) break;
      const low = a.toLowerCase();
      if (seen.has(low) || !LATIN_RX.test(a) || a.length > 60) continue;
      seen.add(low);
      alt.push(a);
    }

    cities.push({ n: name, a: asciiname, alt, cc, a1: admin1, p: population, lat, lon });
  }
  // Sort by population descending -- disambiguation (Paris FR vs Paris TX)
  // picks the first match, so bigger cities should win ties.
  cities.sort((x, y) => y.p - x.p);

  const out = {
    generated_at: new Date().toISOString(),
    source: 'GeoNames.org (CC BY 4.0) -- cities15000 + countryInfo, https://download.geonames.org/export/dump/',
    country_names: countryNames,
    countries,
    cities,
  };
  const outPath = path.join(OUT, 'geonames_cities.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  log(`geonames_cities.json: ${cities.length} cities, ${Object.keys(countries).length} countries, ${sizeMB}MB`);
}

// ═══════════════════════════════════════════════════════════════
// 2. Company tiers (Fortune 500 base + hand-curated overlay)
// ═══════════════════════════════════════════════════════════════
function buildCompanyTiers() {
  const f500Path = path.join(RAW, 'fortune500_2025.json');
  const overridesPath = path.join(OUT, 'company_tier_overrides.json');
  if (!fs.existsSync(f500Path)) {
    log('SKIP company tiers -- fortune500_2025.json not found in data/reference/raw/');
    return;
  }

  const f500 = JSON.parse(fs.readFileSync(f500Path, 'utf8'));
  const companies = {};

  // Base layer: Fortune 500 rank -> weight bands.
  for (const row of f500.data || []) {
    const key = normalizeCompanyName(row.company);
    if (!key) continue;
    const w = row.rank <= 100 ? 0.65 : row.rank <= 500 ? 0.55 : 0.45;
    companies[key] = { name: row.company, w, tier: 'fortune500', rank: row.rank, hq: row.headquarters || null };
  }

  // Overlay: hand-curated, always wins over the Fortune 500 base for the same key.
  if (fs.existsSync(overridesPath)) {
    const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    for (const [tierName, tierDef] of Object.entries(overrides.tiers || {})) {
      for (const name of tierDef.companies || []) {
        const key = normalizeCompanyName(name);
        if (!key) continue;
        companies[key] = { name, w: tierDef.weight, tier: tierName, rank: null, hq: null };
      }
    }
  } else {
    log('WARNING: company_tier_overrides.json not found -- shipping Fortune-500-only tiers, no MAANGO/fintech/startup overlay');
  }

  const out = {
    generated_at: new Date().toISOString(),
    sources: [
      'Fortune 500 2025 (Salt Technologies AI, CC BY 4.0) -- US, revenue-ranked, NOT Forbes Global 2000',
      'data/reference/company_tier_overrides.json (hand-curated, needs user review)',
    ],
    companies,
  };
  const outPath = path.join(OUT, 'company_tiers.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(0);
  log(`company_tiers.json: ${Object.keys(companies).length} companies, ${sizeKB}KB`);
}

// ═══════════════════════════════════════════════════════════════
// 3. H1B sponsors (USCIS Employer Data Hub, last 3 available fiscal years)
// ═══════════════════════════════════════════════════════════════
function parseCsvLine(line) {
  // Minimal RFC4180-ish parser -- handles quoted fields with embedded commas,
  // sufficient for the USCIS export's shape (no embedded newlines observed).
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function buildH1bSponsors() {
  const years = ['2021', '2022', '2023'];
  const files = years.map((y) => path.join(RAW, `h1b_datahubexport-${y}.csv`)).filter((p) => fs.existsSync(p));
  if (!files.length) {
    log('SKIP H1B sponsors -- no h1b_datahubexport-*.csv found in data/reference/raw/');
    return;
  }

  const sponsors = {}; // normalized name -> { name, appr, fy }
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const idxYear = header.indexOf('fiscal year');
    const idxEmployer = header.indexOf('employer');
    const idxInitApp = header.indexOf('initial approval');
    const idxContApp = header.indexOf('continuing approval');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = parseCsvLine(line);
      const employer = (cols[idxEmployer] || '').trim();
      if (!employer) continue;
      const fy = parseInt(cols[idxYear], 10) || 0;
      const appr = (parseInt(cols[idxInitApp], 10) || 0) + (parseInt(cols[idxContApp], 10) || 0);
      const key = normalizeCompanyName(employer);
      if (!key) continue;
      const existing = sponsors[key];
      if (!existing) {
        sponsors[key] = { name: employer, appr, fy };
      } else {
        // Accumulate approvals across all 3 fiscal years for this employer;
        // keep the most-recent fy/display-name as the "as filed" label.
        existing.appr += appr;
        if (fy > existing.fy) { existing.fy = fy; existing.name = employer; }
      }
    }
  }

  const out = {
    generated_at: new Date().toISOString(),
    source: 'USCIS H-1B Employer Data Hub (public domain), FY2021-2023 archive CSVs, https://www.uscis.gov/archive/h-1b-employer-data-hub-files',
    sponsors,
  };
  const outPath = path.join(OUT, 'h1b_sponsors.json');
  fs.writeFileSync(outPath, JSON.stringify(out));
  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  log(`h1b_sponsors.json: ${Object.keys(sponsors).length} employers, ${sizeMB}MB`);
}

buildGazetteer();
buildCompanyTiers();
buildH1bSponsors();
log('Done.');
