# registry_import/ — provenance

**This is the original bulk seed from 2026-06-12 (commit `d00f81f`), not the live
registry.** Read this before trusting any number in here.

- `registry_import.csv` — 15,532 companies across **3 of the registry's 12 ATS
  types** (greenhouse 8,179 / lever 4,368 / ashby 2,985). It was the one-time
  bulk import that founded the registry. It carries no `api_base`, no `tier`,
  no `is_active` — those columns didn't exist in the import path yet.
- `*_companies.json` — the raw per-platform scrapes the CSV was merged from.
- `metadata.json` — the *discovery run's* own stats from June 12, *not* registry
  state: its 47,881 "total companies" includes platforms that were scraped,
  evaluated, and **never built into adapters** (`bamboohr_api`,
  `icims_sitemap` — iCIMS was independently re-researched and rejected again in
  July 2026). Do not reconcile these numbers against the live DB; they describe
  a wider net cast once.

**Where current truth lives:**
- Live registry: the `companies` table in Postgres (all 12 ATS types, tiers,
  api_base tenants, poll state). Point-in-time snapshots land in
  `data/backups/` (gitignored — deliberately not published).
- Curated rows (Workday/Avature/etc. tenants, dream tier): the Registry
  Seeder's `Build Seed List` node — the git-tracked source of truth since s78.

**Fresh-install recipe:** `db/schema.sql` → bulk-import this CSV
(`scripts/import_registry.js`) → run the Registry Seeder once. That reproduces
the full registry shape including the dream tier; only per-company poll
history/yield state is legitimately unreproducible.
