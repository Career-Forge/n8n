# Reference data — the "semi-RAG" corpora

Local JSON reference data backing the geo/company-tier/H1B accuracy wave
(see `~/.claude/plans/semi-rag-reference-data-wave.md`). Built by
`scripts/build_reference_data.js` from public sources, consumed by n8n Code
nodes via `fs.readFileSync` — the existing docker-compose mount
(`../data:/home/node/.n8n-files/companies:ro`) already exposes this whole
directory read-only inside the container at
`/home/node/.n8n-files/companies/reference/`, confirmed live, no compose
changes needed.

Regenerate with `node scripts/build_reference_data.js` after re-staging raw
source files under `data/reference/raw/` (gitignored — see below).

## Files

- **`geonames_cities.json`** (~4.9MB, 34,006 cities, 252 countries) — GeoNames
  `cities15000` (every city with population >15,000 or a national capital)
  plus `countryInfo`. **License: CC BY 4.0** — attribution required in any
  public redistribution: "Contains data from GeoNames.org, CC BY 4.0."
  Source: https://download.geonames.org/export/dump/. Alternate names are
  filtered to Latin-script only (job search text in this system is
  overwhelmingly Latin-script; non-Latin transliterations only bloat the
  file) and capped at 8 per city. Cities are sorted by population descending
  so disambiguation (e.g. Paris, FR vs Paris, TX) picks the bigger city by
  default. The 12 countries this project has actually seen in live searches
  keep their pre-existing hand-curated alias lists (usa/u.s.a/america, uk/
  britain/england/scotland/wales, etc.) merged on top of GeoNames' single
  official name.

- **`company_tiers.json`** (~57KB, 572 companies) — Fortune 500 2025 (Salt
  Technologies AI, **CC BY 4.0**, https://www.salttechno.ai/datasets/fortune-500-companies-2025/)
  as the base layer, rank-banded into weights (top 100 → 0.65, 101-500 →
  0.55), with `company_tier_overrides.json` (hand-curated, **needs product
  review**) layered on top — an override always wins for the same normalized
  name. **Known scope reduction**: the original research wanted Forbes
  Global 2000 for international public-company breadth; no auth-free bulk
  download was found this session (Kaggle requires an account). Fortune 500
  is US-only and revenue-ranked, not the same thing. International coverage
  beyond the hand-curated overlay (MAANGO, fintech/quant, hot AI startups,
  Big 4) is thin until a Global 2000 source is found or the overlay grows.

- **`h1b_sponsors.json`** (~6.4MB, 84,925 employers) — USCIS H-1B Employer
  Data Hub, FY2021-2023 archive CSVs. **Public domain** (US government
  work). Source: https://www.uscis.gov/archive/h-1b-employer-data-hub-files
  — this is the last statically-downloadable range; the live tool page is a
  Tableau-embedded interactive dashboard with no bulk CSV link found this
  session, so FY2024/2025 aren't included. Approvals are summed across all 3
  years per normalized employer name. **Known limitation**: matching is
  exact-normalized-name only, no subsidiary/alias mapping — "Amazon" alone
  won't match H1B filings under "Amazon.com Services LLC" or "Amazon Web
  Services Inc." A small manual alias overlay (like `company_tier_overrides.json`)
  would close this for the handful of companies that matter most, but isn't
  built yet.

- **`company_tier_overrides.json`** (git-tracked, hand-authored, NOT
  generated) — the only file in this directory that's a product decision
  rather than a data transform. Review/edit directly; re-run the build
  script afterward to fold changes into `company_tiers.json`.

## Shared normalizer

Every consumer must use the byte-identical `normalizeCompanyName()` from
`scripts/build_reference_data.js` (lowercase, `&`→`and`, strip punctuation,
strip legal-suffix tokens via a shared regex, collapse whitespace) — Code
nodes can't share modules, so this is mirrored per-node with keep-in-sync
comments, same convention as every other cross-node helper in this codebase.

## `raw/` (gitignored)

Downloaded source files staged for the build script — large (~22MB) and
trivially re-downloadable from the URLs above, so not committed. `old_geo_reference.json`
in there is a one-time pull of the pre-wave hand-curated `geo_reference`
app_settings row, kept only so alias-merging is reproducible.
