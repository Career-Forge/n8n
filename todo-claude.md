# CareerForge -- Deep Technical Handoff for Claude

Last written: 2026-07-01. This file is meant to be loaded by a future Claude session that has no prior context. It is intentionally exhaustive. The user-facing status summary lives in `todo.md`. This file covers the internals, decisions, bugs, session findings, and the full active plan.

---

## Who This Is For

Pranav Kowadkar, AI engineer, 30, Jersey City NJ. His handle in code and commits is first-person -- no AI attribution ever appears. He runs n8n locally on an Asus Zenbook Pro Duo (Win11, 32GB RAM, RTX 2060Ti). Stack: Python, n8n self-hosted, LLM calls via OpenRouter.

Primary repo: `d:\My-Projects\Career_Forge_Development\careerforge_n8n`

---

## What This Project Does

CareerForge is a Telegram-to-Telegraph job search pipeline. The user sends a natural-language message to a Telegram bot. n8n receives it via a webhook exposed through ngrok, expands the query via an LLM (Expand Query), runs the query against a local Postgres job cache and three web search lanes (Serper, Firecrawl, You.com), reranks results through a local Python matcher service, verifies liveness, and renders a Telegraph page the user can read.

The matcher service also handles ingest: it polls ATS providers (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Personio, plus custom providers for Amazon/Apple/Google/Netflix/Meta/Microsoft/Uber/ByteDance) and populates the Postgres job cache with embeddings (via local bge-m3 through Ollama).

Design principles that must not be violated:
- Company-direct sources only. No aggregators, job boards, staffing companies, bodyshops.
- Global by default. No hardcoded US-first behavior in defaults.
- Source of truth for company tiers is the DB. Source of truth for source policy is `_source_policy.js`.
- Ingest data changes: matcher image rebuild + docker compose up. Node body changes: patch script -> docker cp -> n8n import + restart. SQL changes: docker exec psql.

---

## Runtime Stack (Local Only)

```
careerforge_n8n        -- n8n workflow engine, port 5678
careerforge_matcher    -- Python matcher + ATS ingest, port 5680
careerforge_postgres   -- pgvector/pg17, port 5433 (host) / 5432 (internal)
careerforge_ollama     -- Ollama bge-m3 embeddings, port 11434
careerforge_latex      -- LaTeX PDF renderer, port 5679
careerforge_renderer   -- Headless Chromium liveness (optional), port 5681
```

Live workflow ID: `kmQDCNypCfZbqwAW` ("CareerForge Master -- Local v6.3")
Live n8n port: 5678 (localhost, basic auth via `docker/.env`)

ngrok exposes localhost:5678 for Telegram webhook. ngrok config is in `~/.config/ngrok/ngrok.yml`. The WEBHOOK_URL in `docker/.env` must be updated whenever ngrok assigns a new domain (or use a reserved domain).

---

## Repository Structure

```
careerforge_n8n/
  docker/
    docker-compose.yml           -- main local compose stack
    docker-compose.render.yml    -- cloud Render deploy (secondary)
    render.yaml                  -- Render service manifest
    .env                         -- LOCAL ONLY, never commit, actual keys
    .env.example                 -- committed example, UTC defaults, no keys
    workflows/
      CareerForge_Master_local.json      -- ACTIVE modern export
      CareerForge Master Local v6.3.json -- ACTIVE modern export (space in name)
      [everything else]                  -- STALE, do not use as source of truth
  workflows/
    CareerForge_Master_local.json        -- ACTIVE modern export (root-level copy)
    README.md                            -- notes on export conventions
  scripts/
    nodes/
      _source_policy.js          -- CANONICAL source policy (ATS recognition, denylist, board checks, URL tier)
      aggregate_jobs.js          -- merges cache + web lanes, applies source policy, country/location filter
      cache_prefilter.js         -- pre-filters SQL cache results before matcher
      build_matcher_request.js   -- assembles /match payload from scored candidates
      build_scorer_input.js      -- prepares job + resume input for scorer
      build_telegraph_body.js    -- renders Telegraph page body
      build_serper_queries.js    -- constructs Serper search queries from expand context
      build_fc_queries.js        -- constructs Firecrawl search queries
      build_youcom_queries.js    -- constructs You.com queries
      normalize_serper.js        -- normalizes Serper raw results (applies source policy)
      normalize_firecrawl.js     -- normalizes Firecrawl raw results (applies source policy)
      normalize_youcom.js        -- normalizes You.com results (applies source policy)
      normalize_adzuna.js        -- Adzuna normalizer (Adzuna default-OFF)
      normalize_remoteok.js      -- RemoteOK normalizer (RemoteOK default-OFF)
      hybrid_cache_search.sql    -- core SQL: vector + keyword + RRF + country gate
      parse_matcher_output.js    -- parses /match response into display format
      [other nodes]              -- resume/cover/contact, less relevant to find flow
    c1_company_ats.js            -- patcher: splices node bodies into live workflow
    c2_liveness_threading.js     -- patcher: wires source/board/external_id through the pipeline
    p2_source_policy.js          -- patcher: syncs _source_policy.js into 5 consumer nodes + 3 exports
    s14_phase3_cachefirst.js     -- earlier patcher (cache-first find flow)
    s15_sprintA_tiers.js         -- earlier patcher (tier rubric)
    sN1_intern_intent.js         -- patcher stub: intern/seniority intent (plan S1, not yet applied)
    lN2_geo_filter.js            -- patcher stub: geo SQL filter (plan L2, not yet applied)
    validate_source_policy.js    -- guard: source policy byte-sync + workflow integrity
    validate_workflow_scrub.js   -- guard: no owner chat ID fallback in modern exports
    validate_no_us_defaults.js   -- guard: no America/New_York defaults in tracked files
    gen_geonames_seed.js         -- generates db/seed_geonames.sql from cities500.txt
    gen_workday_seed.js          -- generates Workday tenant seed
    import_registry.js           -- imports company registry CSV into Postgres
  services/
    matcher/
      app.py                     -- FastAPI: /match, /ingest, /health, /find, /sources
      db.py                      -- upsert_jobs, embed skip logic (_fetch_existing), PG conn
      geo.py                     -- cf_resolve_location wrapper, COUNTRY_ISO map, classify_workplace
      liveness.py                -- per-source liveness checks (Lever, Greenhouse, Ashby, Workday, SR, Personio)
      embed.py                   -- bge-m3 embedding via Ollama
      skills.py                  -- skill graph (bge-m3 edge embedding, multi-hop adjacency)
      providers/
        __init__.py              -- JobRecord base class, TITLE_RX, provider registry
        ats.py                   -- Greenhouse, Lever, Ashby, Workable, SmartRecruiters
        workday.py               -- Workday CXS API (curated tenant list)
        personio.py              -- Personio XML feed
        remoteok.py              -- RemoteOK (guarded off by default)
        amazonjobs.py            -- Amazon Jobs (Class-2 custom)
        applejobs.py             -- Apple Jobs (Class-2 custom)
        googlejobs.py            -- Google Careers (Class-2 custom)
        microsoftjobs.py         -- Microsoft Careers
        netflixjobs.py           -- Netflix Jobs
        metajobs.py              -- Meta Careers
        uberjobs.py              -- Uber Jobs
        bytedancejobs.py         -- ByteDance Jobs
    latex/app.py                 -- LaTeX PDF renderer service
    renderer/app.py              -- Playwright/Chromium liveness (optional)
  db/
    schema.sql                   -- canonical DB schema (extensions, tables, functions, indexes)
    geo_state_fallback.sql       -- (planned L0/1c) US state code fallback for cf_resolve_location
    seed_smartrecruiters.sql     -- SmartRecruiters company slugs
    seed_personio.sql            -- Personio tenant slugs
    seed_geonames.sql            -- GeoNames cities500 gazetteer (large, generated)
  data/
    companies.json               -- company registry (ATS slugs, tiers, trust scores)
  templates/                     -- LaTeX resume/cover templates
  prompts/                       -- LLM system prompts (IntentRouter, ExpandQuery, ForgeScore etc.)
  user-data/                     -- user's resume JSON, profile preferences (not committed)
```

---

## Active Workflow Exports

These three are the ONLY canonical modern exports. Everything else is stale.

1. `docker/workflows/CareerForge_Master_local.json`
2. `workflows/CareerForge_Master_local.json`
3. `docker/workflows/CareerForge Master Local v6.3.json`

As of P5 sync (2026-07-01):
- Verified 279 nodes
- `Merge Sources` has 5 inputs (confirmed, not 6 or 4)
- `staticData` in repo exports is `null` -- that is correct for the committed version
- Live n8n instance (`kmQDCNypCfZbqwAW`) has real staticData with user prefs + last search intent

---

## Workflow Sync Protocol (Critical -- Read Before Touching n8n)

The repo exports have `staticData: null`. The live n8n instance has populated staticData that includes:

- `node:Schedule Tick` -- recurrenceRules (schedule configuration)
- `global.last_search_intent` -- the last search context object (location, roles, country, etc.)
- `global.user_prefs` -- user preferences object (may include resume path, preferences)

**Never import a raw repo export into live n8n.** It wipes staticData, including the user's resume path and preferences.

Safe sync protocol:
```javascript
// 1. Export live workflow
// docker exec careerforge_n8n n8n export:workflow --id=kmQDCNypCfZbqwAW --output=/home/node/live_wf.json
// docker cp careerforge_n8n:/home/node/live_wf.json ./live_wf.json

// 2. Merge repo nodes + live staticData
const repo = JSON.parse(fs.readFileSync('docker/workflows/CareerForge_Master_local.json'));
const live = JSON.parse(fs.readFileSync('live_wf.json'));
const liveWf = Array.isArray(live) ? live.find(w => w.id === 'kmQDCNypCfZbqwAW') : live;
repo.staticData = liveWf.staticData;
const merged = [repo];
fs.writeFileSync('merged_import.json', JSON.stringify(merged));

// 3. Import and reactivate
// docker cp merged_import.json careerforge_n8n:/home/node/merged_import.json
// docker exec careerforge_n8n n8n import:workflow --input=/home/node/merged_import.json
// docker exec careerforge_n8n n8n update:workflow --id=kmQDCNypCfZbqwAW --active=true
// docker restart careerforge_n8n
```

**Shell note**: Use PowerShell tool for `docker exec`, not Git Bash. Git Bash converts `/home/node/...` paths to Windows paths. Docker exec paths are inside the Linux container -- must be passed via PowerShell to avoid path mangling.

---

## Core SQL: hybrid_cache_search.sql

This runs as a Postgres node parameter in n8n. It is the cache find query. Parameters:
- `$1` -- embedding vector (1024-dim bge-m3)
- `$2` -- keyword text for `websearch_to_tsquery`
- `$3` -- location_canonical string (passed to `cf_resolve_location`)
- `$4` -- country ISO2 hint (passed as fallback in `gc` CTE)

The query structure:
```sql
WITH q AS (SELECT $1::vector AS qvec, websearch_to_tsquery('english', COALESCE($2,'')) AS qtext),
loc AS (SELECT * FROM cf_resolve_location($3, $4) LIMIT 1),
gc AS (SELECT COALESCE((SELECT country_iso FROM loc), NULLIF(upper($4), '')) AS ci),
vec AS (
  -- vector similarity top 150, filtered by country gate
  SELECT j.id, row_number() OVER (...) AS rnk
  FROM jobs j WHERE status='active' AND embedding IS NOT NULL
    AND (
      (SELECT ci FROM gc) IS NULL              -- worldwide (no location in query)
      OR (j.workplace_type = 'remote' AND (    -- remote job: pass if worldwide OR country-eligible
            ((j.allowed_countries IS NULL OR cardinality(j.allowed_countries) = 0)
               AND (j.country_iso IS NULL OR j.country_iso = (SELECT ci FROM gc)))
            OR (SELECT ci FROM gc) = ANY(j.allowed_countries)))
      OR (j.workplace_type IS DISTINCT FROM 'remote'
            AND j.country_iso = (SELECT ci FROM gc))
    )
  ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 150),
kw AS ( -- keyword match top 150, same country gate ),
rrf AS ( -- Reciprocal Rank Fusion: 1/(60+vec_rnk) + 1/(60+kw_rnk) weighted )
SELECT ... FROM rrf JOIN jobs j ON j.id=rrf.id
ORDER BY rrf_score DESC LIMIT 200
```

Key behavior:
- Remote jobs with `allowed_countries IS NULL` pass any country query (worldwide-remote fail-open).
- Remote jobs with non-empty `allowed_countries` must contain the queried country.
- Onsite/hybrid jobs must exactly match `country_iso`.
- If gc.ci is NULL (no location in query), all country gates pass.

Known bug: `cf_resolve_location('IN', NULL)` can return Colombia/Medellín due to trigram fuzzy match on short 2-char string. In practice, the LLM sets country='IN' (not location_canonical='IN'), so the gc CTE uses the `NULLIF(upper($4), '')` fallback, which correctly returns 'IN'. Not currently blocking but should be noted.

---

## cf_resolve_location Bug

`cf_resolve_location('IN', NULL)` returns Medellín (Colombia) because 'IN' trigram-matches 'Colombia/Medellín' in the gazetteer better than 'India'. This would only matter if someone passed the bare string 'IN' as the location_canonical parameter. In the current flow, the LLM sets `country: 'IN'` separately, so $4='IN' and the `gc` CTE correctly uses 'IN' as the country. Non-blocking but worth documenting.

---

## Key Python Services

### services/matcher/app.py

Main FastAPI application. Key endpoints:
- `POST /ingest` -- triggers ATS polling + cache upsert + embedding. Body: `{providers: [], limit: N}`
- `POST /match` -- reranks job candidates against resume. Body has jobs array + resume text + optional location/skills
- `POST /find` -- convenience: embeds query + runs hybrid_cache_search + passes to /match
- `GET /health` -- liveness probe
- `GET /sources` -- lists registered providers

`/match` flow (PASS 1 -> 2 -> 3):
1. PASS 1: cross-encoder rerank of all candidates (bge-reranker-v2-m3), up to ~200 jobs
2. PASS 2: validate top-N (default 12 via `VALIDATE_TOP_N`) -- liveness.check_alive cascade, optional JD refresh
3. PASS 3: final re-rank of validated candidates, build `results` array

Response fields per result: `id, match_pct, verdict, why, rerank_score, validated, skill_match, components`.
**Not**: `title`, `url`, `company` -- those must be joined from the original job list by `id`.

### services/matcher/db.py

`upsert_jobs()` is the single choke point for all ingest. Key optimization added in P3f:
- `_fetch_existing(conn, dedup_keys)` batch-fetches `dedup_key, length(jd_text), embedding IS NOT NULL`
- Skips re-embedding if: row exists AND has embedding AND incoming JD is not longer
- The SQL COALESCE preserves old embeddings: `COALESCE(jobs.embedding, EXCLUDED.embedding)`
- dedup_key formula includes raw location string (never change this or existing rows fork)

### services/matcher/liveness.py

`check_alive(job) -> (alive: bool|None, jd: str|None, note)`.
- `True` = live, may return fresh JD
- `False` = dead, job should be dropped from results
- `None` = undetermined (falls through to Firecrawl)

Per-source dispatch:
- **Workday**: derives CXS detail URL from public URL, GET with JSON headers. 200+`jobPostingInfo` = live. Any non-200 = dead. (Do not use public page URL -- Workday SPA returns 200 even for filled reqs.)
- **Lever**: `GET api.lever.co/v0/postings/{slug}/{id}` -- 200 = live, 404 = dead
- **Greenhouse**: boards-api by-id check
- **Ashby/Workable**: list membership by id
- **SmartRecruiters**: detail API check (added P3c)
- **Personio**: page status check, anti-bot 403 = undetermined not dead (added P3c)

### services/matcher/geo.py

Python-side location utilities. Key: `COUNTRY_ISO` dict maps country names/variants to ISO2. Used by `classify_workplace()` to parse `allowed_countries` from free-text location strings.

**Important**: `COUNTRY_ISO` in geo.py, the `geo_countries` DB table, and the JS `CC_MAP` in `aggregate_jobs.js` are three separate maps that must be kept in sync. Currently they are not synchronized -- this is a known technical debt (P4c/P4d backlog).

### services/matcher/providers/ats.py

Contains Greenhouse, Lever, Ashby, Workable, SmartRecruiters provider classes. SmartRecruiters added in P3a:
- Public SR API, paginated (max 3 pages default, hard cap 10, added P3e)
- Detail endpoint for rich JD text
- Verified slugs in `db/seed_smartrecruiters.sql`: BoschGroup, DeliveryHero, Experian, Wise, Visa, WesternDigital, Continental, Wabtec, AveryDennison

---

## Patcher Architecture

Node body changes are made via patcher scripts that:
1. Read the live n8n workflow JSON via `docker exec n8n export:workflow`
2. Find target nodes by name (MAP lookup, checked for drift)
3. Replace the `jsCode` / `parameters.jsCode` field with the updated source from `scripts/nodes/*.js`
4. Validate with `new Function(body)` (syntax check)
5. Write merged JSON + `docker cp` + `n8n import:workflow --id=...` + `n8n update:workflow --active=true` + `docker restart`

Key patchers in use:
- `c1_company_ats.js` -- wires `hybrid_cache_search.sql`, `cache_prefilter.js`, `build_scorer_input.js`, `build_matcher_request.js`, `parse_matcher_output.js`, `build_telegraph_body.js` and others
- `c2_liveness_threading.js` -- wires `source`, `board`, `external_id`, `apply_url` fields end-to-end
- `p2_source_policy.js` -- syncs `_source_policy.js` into 5 consumers + 3 exports

**After any patcher run**: always run the three guards before considering the session done.

```powershell
node scripts/validate_source_policy.js
node scripts/validate_workflow_scrub.js
node scripts/validate_no_us_defaults.js
```

---

## Guard Scripts

### validate_source_policy.js

Checks:
- `_source_policy.js` body byte-for-byte matches injected copy in `aggregate_jobs.js`, `normalize_serper.js`, `normalize_firecrawl.js`, `normalize_youcom.js`, `build_fc_queries.js`
- Same policy synced into the 3 modern workflow exports
- Workflow JSON parses cleanly
- 279 nodes
- 0 dangling edges
- `Merge Sources` node has exactly 5 inputs

### validate_workflow_scrub.js

Checks:
- No hardcoded owner Telegram chat ID (numeric fallback) in the 3 modern exports
- `Schedule Payload` falls back closed: `owner_chat_id || ''`

### validate_no_us_defaults.js

Checks tracked files for:
- `TIMEZONE:-America/New_York` (compose timezone default)
- `prefs.timezone || "America/New_York"` (workflow Schedule Gate runtime fallback)
- `tz || "America/New_York"` (workflow renderSchedule display fallback)
- `N8N_PASSWORD:-demo1234` (weak password default in compose)
- `value: America/New_York` (render.yaml literal)

Expected status: PASS for all three guards as of 2026-07-01.

---

## Complete Work History (All Phases)

### P0 / P0.5 / P0.6 -- Silent US Defaults Removed

- Serper: removed `gl=us` when country is null
- Firecrawl: removed `country=US` when country is null
- Adzuna: removed `/jobs/us` default, now default-OFF (`ADZUNA_ENABLED=${ADZUNA_ENABLED:-false}`)
- RemoteOK: default-OFF (`REMOTEOK_ENABLED=${REMOTEOK_ENABLED:-false}`)
- Currency: no longer silently USD in country-derived paths
- Stale patch scripts updated to not reintroduce US defaults on rerun
- Old `|| 'US'` string anchor in c1_company_ats.js converted to regex/search-anchor

### P0.7 -- Workflow PII / Chat ID Guard

- Removed hardcoded owner Telegram chat ID fallback from 3 modern exports
- Added `scripts/validate_workflow_scrub.js`
- `Schedule Payload` now falls back to empty string

### P1 -- RemoteOK and Remote Boards Gating

- RemoteOK gated behind `REMOTEOK_ENABLED == "true"` in both matcher compose and provider registry
- Remote job board domains added to source-policy denylist
- Firecrawl remote-only lane no longer widens to remote aggregator domains
- **Caveat**: 118 old RemoteOK rows remain active in local Postgres cache (source='remoteok'). They don't surface in results currently (score too low) but do exist. Deactivation query: `UPDATE jobs SET status='inactive' WHERE source='remoteok';` -- awaiting user approval.

### P2 / P2.1 -- Source Policy Centralization

- `scripts/nodes/_source_policy.js` added as canonical source policy
- Inlined into: aggregate_jobs, normalize_serper, normalize_firecrawl, normalize_youcom, build_fc_queries
- `scripts/p2_source_policy.js` patcher added
- `scripts/validate_source_policy.js` guard added

### P3a -- SmartRecruiters Provider

- Provider class in `services/matcher/providers/ats.py`
- `db/seed_smartrecruiters.sql` with verified slugs (BoschGroup, DeliveryHero, Experian, Wise, Visa)

### P3a.2 -- TITLE_RX Recall Improvement

- Added precision shapes to `providers/__init__.py` TITLE_RX
- Added: SW Engineer, Software Development Engineer, Software Developer, Frontend/Mobile/iOS/Android Engineer
- Did not add: bare "engineer", "developer", "sales engineer", "solutions engineer" (too broad)
- This enabled Visa SmartRecruiters jobs to contribute rows

### P3b -- Personio Provider

- `services/matcher/providers/personio.py` added
- `db/seed_personio.sql` with initial tenants: personio, alasco, wandelbots, tado
- XML feed-based, tenant seed in SQL

### P3c -- SmartRecruiters + Personio Liveness

- SmartRecruiters liveness handler in `liveness.py` (detail API, refreshes JD)
- Personio liveness handler (page status, 403 = undetermined not dead)

### P3d-a -- SmartRecruiters Seed Expansion

- Added to `db/seed_smartrecruiters.sql`: WesternDigital, Continental, Wabtec, AveryDennison
- Rejected many other candidates as unverified or non-tech

### P3d-b -- Personio Seed Expansion

- Audited additional Personio candidates (deepl, komoot, enpal etc.)
- All hit rate limits during probe
- No new tenants added; audit comment added to seed SQL
- Status: re-probe after cooldown (still pending)

### P3e -- SmartRecruiters Pagination

- Bounded pagination in SmartRecruiters provider
- Default max_pages=3, hard cap=10
- Stops on: empty content, totalFound exhaustion, per-board cap, transient page error
- Improved Bosch/Continental/DeliveryHero coverage

### P3f -- Embedding Skip Optimization

- `db.py` now batch-fetches existing rows before embedding
- Embeds only: new rows, rows with null embedding, rows where incoming JD text is longer
- `COALESCE(jobs.embedding, EXCLUDED.embedding)` preserves old embeddings
- Confirmed locally: unchanged SR runs embed 0 rows (previously re-embedded all)

### P4a -- Hardcoding Audit (Read-Only)

Identified remaining risks:
- JS `CC_MAP` duplicates Python/DB country maps -- can drift
- `STAFFING` and `LISTING_TITLE` regexes only in aggregate_jobs.js (not in _source_policy.js)
- Stale/test scripts contain personal fixture data
- Some non-modern exports still have old owner chat ID fallback

### P4b -- UTC Migration / Weak Credential Cleanup

Changed in docker/docker-compose.yml:
- `GENERIC_TIMEZONE=${TIMEZONE:-UTC}` (was America/New_York)
- `TZ=${TIMEZONE:-UTC}` (was America/New_York)
- `N8N_BASIC_AUTH_PASSWORD=${N8N_PASSWORD:?set N8N_PASSWORD in docker/.env}` (fail-closed, was `:-demo1234`)

Changed in docker/docker-compose.render.yml:
- Same TIMEZONE defaults to UTC

Changed in docker/render.yaml:
- Both GENERIC_TIMEZONE and TZ values changed to UTC

Changed in docker/.env.example:
- `TIMEZONE=UTC` (was America/New_York)

Changed in 3 modern workflow exports:
- `tz || "UTC"` (was `tz || "America/New_York"` in renderSchedule display)
- `prefs.timezone || "UTC"` (was `prefs.timezone || "America/New_York"` in Schedule Gate)
- Code comment updated to say `"UTC"` as default

Note: local `docker/.env` still has `TIMEZONE=America/New_York` -- that is correct, it's the user's intentional local override, not committed.

Two replace_all passes were required: `tz ||` pattern and `prefs.timezone ||` are different strings. The third occurrence (code comment) required a unique match string.

Added `scripts/validate_no_us_defaults.js`.

### P5 -- Local E2E Validation

- Confirmed all 6 services healthy via health endpoint checks
- All 3 guards passed
- Live workflow was stale (273 nodes, missing RemoteOK/Adzuna gate nodes)
- Safe sync performed: merged repo export nodes + live staticData, imported, reactivated
- Post-sync: 279 nodes confirmed, staticData preserved
- User ran Telegram queries through ngrok
- 7 queries + Germany bonus test = 8 Telegraph result pages analyzed

---

## P5 Telegram E2E Results -- Full Analysis (2026-07-01)

All 8 Telegraph pages were analyzed. Here is the complete per-query breakdown.

### Q1: "AI jobs in India" -- 13 results -- STRONG

Telegraph: `https://graph.org/CareerForge--13-Jobs--Jul-1-07-01`

Results: Apple (Workday), State Street (Workday), Autodesk (Workday), Lever (Egen), SmartRecruiters x3 (Western Digital, Experian, Bosch), Ashby (TRM Labs), Amgen (Workday). Scores 77-95%. All company-direct URLs.

Issues: Arize AI "EMEA Remote" (#8) appears. EMEA is not India. This is the worldwide-remote fail-open: allowed_countries is null so it passes any country gate. Known gap (B-class), not a blocker.

### Q2: "FDE roles in UK" -- 4 results -- WEAK

Telegraph: `https://graph.org/CareerForge--4-Jobs--Jul-1-07-01`

Header shows Expand Query correctly identified FDE = "Forward Deployed Engineer, Forward Deployed Software Engineer, Solutions Engineer". Country correctly resolved to UK.

Results shown: Google "Software Engineer, Applied AI, Agent Building" (84%), Bridgeway "Senior Platform Engineer" (87%), Zilch "Senior Platform Engineer" (82%), Wise "Senior Software Engineer -- Marketing Platform" (74%). None are FDE roles.

Root cause confirmed by keyword simulation:
```
1 | Forward Deployed Software Engineer | ameba    | 0.9625 | GB
2 | Forward Deployed Software Engineer | Palantir | 0.7481 | GB
3 | Forward Deployed Software Engineer | intercom | 0.7204 | GB
4 | Forward Deployed Infrastructure Engineer UK | Palantir | 0.6575 | GB
5 | Forward Deployed AI Engineer | Palantir | 0.6060 | GB
```

Palantir and Intercom FDE jobs ARE in the cache, ARE active, DO have embeddings, DO have GB country_iso, ARE verified live (Lever API returns 200 for Palantir). The keyword search ranks them correctly.

The problem is the matcher's PASS 1 semantic reranker (bge-reranker-v2-m3). FDE roles involve customer deployment, solutions work, and field engineering -- these don't overlap well with an AI engineer resume. So the reranker scores Palantir FDE below Google Applied AI, and they fall below the display threshold.

Root cause: **matcher intent overridden by resume fit**. The system is technically correct (best resume match) but ignores explicit role type intent (user asked for FDE). This is the planned M arc (explainable hard-cap scoring).

Short-term workaround for user: type "Forward Deployed Engineer roles in UK" -- the longer form makes the embedding closer to FDE JDs. The abbreviation "FDE" was correctly expanded by Expand Query, but the resulting query embedding may still not be close enough to FDE JDs in vector space.

### Germany bonus: "AI roles in Germany" -- 7 results -- STRONG

Telegraph: `https://graph.org/CareerForge--7-Jobs--Jul-1-07-01`

Pfizer, Bluefishai, Synthesia, Arize AI (EMEA Remote), D One/Munich (Workable), KLA, HiPeople. All company-direct. Scores 80-86%. Workable provider contributing (D One Munich). Three web lanes all firing.

### Q3: "ML engineer Germany" (first run) -- 4 results -- CACHE ONLY

Results from cache only (web lane didn't fire). Bluefishai, Synthesia, Arize AI (EMEA), KLA. Scores 80-85%. Clean but thin. Germany has ~26 AI/ML jobs in cache -- thin coverage. The richer Germany query above got more by using "AI roles" (broader) and triggering You.com.

### Q4: "remote AI engineer" -- 13 results -- GOOD

Telegraph: `https://graph.org/CareerForge--13-Jobs--Jul-1-07-01-2`

OpenAI, Ro, AIFund, BetterHelp, Voya (Workday), Sun Life (Workday), OpenTeams (Greenhouse), Bluefish AI, Twilio, Humana, Mistral, Vestiaire, Edwards. All company-direct. Scores 81-90%. All 3 web lanes firing.

Web title artifact issue: several job titles carry the source platform name. Examples:
- "Ro - Senior AI Engineer - Lever" (should be: "Senior AI Engineer")
- "career - Applied AI Engineer" (should be: "Applied AI Engineer")
- "Lead Applied AI Software Engineer (AI) - Myworkdayjobs.com" (should be: "Lead Applied AI Software Engineer")
- "Mistral AI - Applied AI Engineer, Fullstack - Lever" (should be: "Applied AI Engineer, Fullstack")

These are Firecrawl/Serper page-title artifacts -- the scraper is picking up the browser `<title>` tag which includes the ATS platform suffix. Fix needed in `normalize_serper.js` and `normalize_firecrawl.js` title cleaning. (Bug B3)

### Q5: "AI engineer in New York" -- 11 results -- CITY LEAK

Telegraph: `https://graph.org/CareerForge--11-Jobs--Jul-1-07-01`

Results breakdown:
- Apple x5 -- "United States of America" -- NOT New York
- Google -- "Sunnyvale, CA, USA" -- NOT New York
- Celonis -- "New York, US" -- CORRECT
- Reddit -- "San Francisco, CA" -- NOT New York
- BetterHelp -- "US - Remote" -- might be acceptable
- City of New York -- CORRECT
- Cortex / Twitter2 -- "New York, NY" -- CORRECT

Only 3/11 are actually in New York. Apple dominates (5 results) because: Apple has many ML jobs in the US cache, Apple is S-tier, and the embedding similarity is high for AI engineer queries. The proximity score penalizes non-NY but does NOT gate them out at the country level.

Root cause: the SQL has a country gate (US passes for any US job) but NO city-level proximity gate. Apple's S-tier boost + strong vector similarity overcomes the soft proximity penalty. This is the known L2 city-level proximity gap in the active plan.

### Q6: "AI engineer IN" -- 13 results -- INDIA CORRECT

Telegraph: `https://graph.org/CareerForge--13-Jobs--Jul-1-07-01-3`

Expand Query LLM correctly resolved "IN" to India, set `country: 'IN'`. Results are nearly identical to Q1. The `cf_resolve_location('IN', NULL)` Colombia bug does NOT trigger because the LLM uses the country field, not location_canonical, for bare country codes. Confirmed non-blocking.

### Q7: "senior backend engineer remote" -- 15 results -- GOOD

Telegraph: `https://graph.org/CareerForge--15-Jobs--Jul-1-07-01`

Outsight, Capital One, Teleport, GitLab x2, NVIDIA, Airbyte x2, Andercore, Coinbase, Medal, Workday, Paytm, Vida Health. Powered by Serper + cache + Firecrawl. Scores 69-90%. All company-direct.

Minor dedup issue: Airbyte appears twice (#8 "Platform Fullstack" and #10 "Platform"). These are different roles so not technically wrong, but two results from one company could be limited.

---

## Known Bugs (as of 2026-07-01)

### B1 -- 118 active RemoteOK rows in local cache

Status: awaiting user approval to deactivate.
Fix: `UPDATE jobs SET status='inactive' WHERE source='remoteok';`
Not currently impacting results (they score too low to surface), but they exist and could surface for weak queries.

### B2 -- cf_resolve_location('IN', NULL) returns Colombia

Status: non-blocking. LLM never passes bare 'IN' as location_canonical for India queries (it uses country='IN' separately).
Fix: add a short-token exclusion to the SQL resolver function to skip trigram matching for strings under 3 chars. Also documented in the active plan under 1c.

### B3 -- Web-lane job titles carry ATS/platform name

Status: not yet fixed. Visible in actual Telegram results.
Root cause: Serper and Firecrawl normalizers use the HTML `<title>` tag which includes the ATS platform name ("- Lever", "- Myworkdayjobs.com").
Fix needed: in `normalize_serper.js` and `normalize_firecrawl.js`, strip common ATS suffix patterns from job titles. Patterns to strip: ` - Lever`, ` - Myworkdayjobs.com`, `career - `, ` - Greenhouse`, ` - Workday`, `Job Application for ... at `, ` | Greenhouse`, ` | Lever`, etc.
Files: `scripts/nodes/normalize_serper.js`, `scripts/nodes/normalize_firecrawl.js`

### B4 -- FDE intent suppressed by resume semantic scoring

Status: known architectural gap, planned in M arc.
Root cause: matcher PASS 1 reranker uses resume-to-JD similarity as the primary signal. For role types that don't match the user's resume (FDE for an AI engineer), the reranker deprioritizes them even when the user explicitly asked for them.
Fix: explainable hard-cap scoring that forces results for explicitly requested role types. This is the M arc in the active plan (after L2).
Short-term mitigation: if the user specifically asks for a role they don't have resume history in, they should specify it very explicitly in the query and possibly set a role pref.

---

## Active Plan (Full Verbatim)

This is the current active implementation plan. It has multiple tiers. As of 2026-07-01, no tier below has been implemented yet (they are planned, not done).

### Context from the plan

The current system has two classes of bugs:

1. Location leaks -- US/Canada-remote and US-state "Work from home" jobs appear for non-US country queries.
   - SQL gate short-circuit: `j.country_iso IS NULL` is OR'd at the top of the remote branch, so remote jobs with unknown base country pass for any queried country
   - Web-lane blanket-keep: `isBareRemote()` and empty-location arms in aggregate_jobs.js keep jobs without checking country
   - US-state codes like "IN - Work from home" (Indiana) unresolved

2. Dead jobs shown -- filled Workday reqs can still appear in the list feed while their CXS detail returns 404/403.

Note: as of P5 the SQL gate has ALREADY been updated to the correct form (the plan described a fix that matches what was deployed in the P5 sync -- the gc CTE with `COALESCE((SELECT country_iso FROM loc), NULLIF(upper($4),''))` is now live). The web-lane country guard in aggregate_jobs.js and the US-state-code resolver fix are still pending.

### Tier 1 -- Location Accuracy

**1a. SQL gate remote branch** -- DONE (deployed, live in kmQDCNypCfZbqwAW as confirmed in P5 analysis)

**1b. Web-lane country guard** -- PENDING
File: `scripts/nodes/aggregate_jobs.js`
Add JS country-token scanner: scan job `location` field for country mentions (full country names + safe short forms us/usa/uk/uae only, NO bare 2-letter codes). If `wantCountry` is set and the job's location names any country, keep only when the queried country is among them ("Remote USA" for India query -> drops). Bare "Remote"/empty still passes (worldwide). Do not scan title field. The CC_MAP here must stay in lockstep with geo.py COUNTRY_ISO.

**1c. US-state-code resolution** -- PENDING
File: `db/schema.sql` and new `db/geo_state_fallback.sql`
Add pri-5 UNION arm to `cf_resolve_location` CTE that maps bare US state code -> 'US', BELOW city matches. "IN - Work from home" (Indiana) -> US. "Bangalore, IN" still -> India via pri1 city match.
Mirror in `services/matcher/geo.py`: add US_STATE_CODES set + last-resort branch in `location_country_hint`.
Then re-run the null-country backfill for existing rows.

**1d. allowed_countries backfill** -- PENDING
One-time SQL UPDATE that scans each remote job's `location` for country names and sets `allowed_countries` where currently NULL and at least one country named. "Remote USA" -> `{US}`, bare "Remote" stays NULL (worldwide). Run as part of the same migration as 1c.

### Tier 2 -- Find-Time Per-Source Liveness

**2.1 liveness.py** -- PARTIALLY DONE
File: `services/matcher/liveness.py`
Already has Lever, Greenhouse, Ashby, SmartRecruiters, Personio handlers.
Still needed: Workday CXS detail check (the key fix -- derive CXS from public URL, GET, 200=live/non-200=dead).

**2.2 Rewrite validate_and_enrich in app.py** -- PENDING
Cascade: (A) run liveness.check_alive for all candidates concurrently. (B) undetermined falls through to Tier 3 headless -> Firecrawl. Delete the blanket `_ATS_LIVE` skip.

**2.3 Thread routing fields end-to-end** -- PARTIALLY DONE (via c2_liveness_threading.js)
SQL SELECT: add `j.source, j.board, j.external_id`
cache_prefilter.js: add `ats_source, board, external_id, apply_url` carry fields
build_scorer_input.js: forward those fields
build_matcher_request.js: pass them in payload
app.py Job model: add optional source/board/external_id/apply_url

### Tier 3 -- Headless Renderer

**renderer service** -- EXISTS but limited
File: `services/renderer/app.py`
The renderer service is already in docker-compose.yml (port 5681:8080). It exists. The matcher env includes `RENDERER_URL=${RENDERER_URL:-http://renderer-service:8080}`.
The cascade in app.py for undetermined jobs to fall through to headless -> Firecrawl is the Tier 2 piece.

### Sprints (Location + Seniority)

**L0 -- Gazetteer + geo schema foundation** -- DONE (geo_places, cf_resolve_location, cube/earthdistance extensions already in schema.sql, seed_geonames.sql exists)

**L1 -- Geocode-at-ingest + replace LOC_SYN** -- PENDING
This is the big one. Delete the 13-city LOC_SYN map in aggregate_jobs.js. Geocode at ingest in db.py via geo.py. Classify workplace_type + allowed_countries from provider structured fields and regex.

**S1 -- Intent-driven intern/seniority** -- PENDING
Stub patcher exists at `scripts/sN1_intern_intent.js`. Parse `include_interns`/`level_intent` in Expand Query. Gate unconditional intern drops in cache_prefilter.js and aggregate_jobs.js on `include_interns`. Add intern clarifier to build_telegraph_body.js.

**L2 -- Geo filter in SQL + matcher hard-gate** -- PENDING
Stub patcher exists at `scripts/lN2_geo_filter.js`. Move location filtering into the cache SQL. Add proximity scoring in rrf_score. Add matcher hard country/mode gate + location sub-score + "why".

**L3 -- Class-2 server-side location injection** -- PENDING
Lever: append `?location=<resolved>`. Workday: add facet to CXS POST body. SmartRecruiters: `country` + `locationType` filter.

**G -- Custom-ATS giants** -- PENDING
One module per vendor mirroring amazonjobs.py. Google, MS, Meta, Apple each need per-vendor location resolver. Depends on L3-style injection and L0.

**M -- Explainable hard-cap scoring** -- PENDING
Field/function/credential/YOE/location hard-caps + grounded "why". Fixes FDE intent suppression (B4). Pairs with L2's `W_LOC` + "why" logic.

**I -- India quality layer** -- PENDING
New BYOK providers: Instahyre, Cutshort, Wellfound (skip noisy Naukri). Auto-benefit from L0/L1/L2. Note: cutshort/hirist/foundit are in the current web-junk AGG_HOST blocklist in aggregate_jobs.js -- promoting them requires removing them from the blocklist first.

---

## Deferred Backlog Items

### P4c -- STAFFING/LISTING_TITLE Centralization
Move STAFFING and LISTING_TITLE regexes from aggregate_jobs.js into _source_policy.js. Currently they drift independently. Add guard coverage.

### P4d -- CC_MAP Consolidation
geo.py COUNTRY_ISO, DB geo_countries, and JS CC_MAP in aggregate_jobs.js are three separate country maps. Decide canonical source. Either generate JS map from DB, or generate both from a shared file, or document the maintenance protocol clearly. CC_MAP and web-lane country guard (1b above) must stay in sync.

### P4e -- Stale Script Cleanup
- `scripts/_harness_s*.js` contain personal fixture data (JD text, resume snippets). Archive or sanitize.
- `backfill_embeddings.py` contains `localhost:11434` (Ollama URL should come from env). Fix or delete.
- Old patchers (r1-r8, s1-s14, session*.js) are historical -- mark clearly as archived.

### Personio Re-probe (P3d-b)
deepl, komoot, enpal all hit rate limits during audit. Re-probe after cooldown. If successful, add to `db/seed_personio.sql`.

---

## Display Quality Issues (B3 and Related)

Job title artifacts in web lane results:
- Pattern: `{Company} - {Title} - {ATS}` (Lever format)
- Pattern: `{Title} - Myworkdayjobs.com`
- Pattern: `career - {Title}`
- Pattern: `Job Application for {Title} at {Company}`

Company display label issues:
- `Boomilp` (should be: Boom)
- `Betterhelpcom` (should be: BetterHelp)
- `Bluefishai` (should be: Blue Fish AI or similar)
- `Hipeople Official` (should be: HiPeople)
- `Twitter2` (should be: X / Twitter -- this is likely Cortex, which is a different company)

Fix location: `scripts/nodes/build_telegraph_body.js` for company display labels. `scripts/nodes/normalize_serper.js` and `normalize_firecrawl.js` for title cleaning.

Title cleaning approach: strip trailing ` - {ATS_PLATFORM}` suffixes from a known list. ATS platforms to strip: Lever, Greenhouse, Workday, Ashby, Workable, SmartRecruiters, Bamboohr, Myworkdayjobs.com. Also strip leading `career - ` prefix. Also match `Job Application for .* at ` opening pattern and extract just the title.

---

## Environment Notes

Local `docker/.env` (never commit):
- `TIMEZONE=America/New_York` -- intentional local override, correct
- `N8N_PASSWORD=demo1234` -- local-only, acceptable for local testing
- `FIRECRAWL_API_KEY=fc-...` -- stale key may cause Firecrawl to fail silently (verify if Firecrawl results stop appearing)
- `OPENROUTER_API_KEY`, `SERPER_API_KEY`, `YOUCOM_API_KEY`, `TELEGRAM_BOT_TOKEN` -- all set

Firecrawl key caveat (noted in discovery overhaul memory): the key starting `fc-...` in `.env` may be stale. If Firecrawl results disappear from Telegraph pages, check the key first.

GEN_MODEL default: `google/gemini-3.5-flash` (in docker-compose.yml line 64). This is used for the LLM inference nodes (Expand Query, Parse Expand Query, etc.) inside n8n. Verify this model ID is still current on OpenRouter if behavior seems off -- model naming moves fast.

---

## Before Any Git Push

Must pass:
```powershell
node scripts/validate_source_policy.js
node scripts/validate_workflow_scrub.js
node scripts/validate_no_us_defaults.js
```

Also verify manually:
- Live n8n workflow synced to latest repo logic (import with staticData preserved)
- matcher healthy (`curl localhost:5680/health`)
- Postgres healthy (`docker exec careerforge_postgres pg_isready`)
- Telegram/ngrok path live (ngrok running, WEBHOOK_URL set correctly in docker/.env)
- The 7 test queries return acceptable output via Telegram
- No backup files (`*.bak`, `merged_import.json`, `live_wf.json`) staged
- No secrets or PII in tracked files (use `git diff --staged` to scan before committing)
- `docker/.env` is in `.gitignore` and NOT staged
- Stale workflow exports in `docker/workflows/` other than the 3 canonical ones are not being falsely treated as active

---

## Rules for Future Claude Sessions (Critical)

1. **Never import a workflow export without preserving staticData.** Export live first, inject staticData, then import merged JSON.

2. **Never assume the live n8n workflow matches the repo export.** They diverge. The repo is the source of code truth; the live instance has the working staticData. Always check node count (should be 279 as of P5).

3. **Never use Git Bash for `docker exec` commands.** Use PowerShell. Git Bash mangles Linux paths.

4. **Never touch `dedup_key` or `_embed_text_for` in db.py.** These determine whether existing embeddings are preserved. Changing them forks all existing rows.

5. **Do not overgeneralize a bug fix.** A title cleanup is a title cleanup. It does not become a source policy rewrite.

6. **Run the 3 guards after any patch script.** Source policy guard is particularly strict (byte-exact match in 5 consumers + 3 exports).

7. **Old cache rows do not prove a provider gate is broken.** 118 RemoteOK rows exist from before the gate. The gate works. The rows are historical state.

8. **The primary acceptance test is Telegram output quality.** Passing static guards is necessary but not sufficient. Always re-run the 7 test queries after significant changes.

9. **Never commit `docker/.env`.** It contains real API keys and `demo1234` password. It's in .gitignore. Verify it stays there.

10. **Firecrawl key may be stale.** If Firecrawl results vanish from Telegraph pages, check the key in docker/.env.

11. **GEN_MODEL and model IDs in prompts may be stale.** OpenRouter model strings change. If LLM nodes behave oddly, verify the model ID at openrouter.ai/models.

12. **The plan tiers (L0-L3, S1, G, M, I) are pre-approved architecture.** Do not redesign them without Pranav's input. Implement them in sprint order, not all at once.

13. **Do not add "Co-authored-by: Claude" or any AI attribution to commits.** Commit messages look like Pranav's. This is a hard rule from CLAUDE.md.
