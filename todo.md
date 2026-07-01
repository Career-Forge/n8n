# CareerForge TODO / Handoff

Last updated: 2026-07-01

This file is the working handoff for the local CareerForge n8n project. It captures the product goal, the current implementation state, what has already been validated, what still needs fixing, and the next recommended phases.

## Final Goal

CareerForge should be a local, self-hosted Telegram job-search assistant that finds high-quality company-direct jobs worldwide.

The intended user flow:

1. User sends a natural-language job query to Telegram.
2. Telegram reaches the local n8n instance through ngrok.
3. n8n routes intent, expands the query, searches cache plus direct company/ATS/web lanes, reranks with the matcher, checks liveness, and returns a Telegraph page.
4. The result page should contain fresh, relevant, company-direct jobs with useful JD snippets.
5. The user can reply with a number to generate a tailored resume and cover letter later.

Product principles:

- Global by default, not US-first.
- Company-direct sources first: ATS pages and real company career pages.
- Avoid job boards, aggregators, bodyshops, staffing vendors, consultant spam, and scammy third-party listings.
- Avoid hardcoded location/company behavior where a data source, DB table, config, or LLM intent clarification is the right tool.
- Cities, states, and countries matter now. Region expansion like EU, EMEA, APAC, LATAM, etc. is not a priority yet.
- Local correctness matters more than cloud/security polish for now. The main acceptance test is Telegram via ngrok into local n8n returning excellent results.

## Current Runtime Assumption

The project is currently run locally:

- n8n container: local self-hosted n8n
- matcher service: local container on port 5680
- Postgres: local container
- renderer/latex/ollama: local supporting containers
- Telegram testing: local n8n exposed through ngrok

Do not assume cloud deployment. Do not over-prioritize production credential hardening while the system is still being perfected locally.

## Active Workflow Exports

Only these workflow exports are considered modern/active:

- `docker/workflows/CareerForge_Master_local.json`
- `workflows/CareerForge_Master_local.json`
- `docker/workflows/CareerForge Master Local v6.3.json`

Other workflow JSON files are stale unless explicitly called out. Stale exports may still contain old defaults, old owner chat ID fallbacks, or old lane behavior. Do not use them as the source of truth.

## Validation Guards

Current guard scripts:

- `node scripts/validate_source_policy.js`
- `node scripts/validate_workflow_scrub.js`
- `node scripts/validate_no_us_defaults.js`

Expected status as of this handoff:

- source policy guard: PASS
- workflow scrub guard: PASS
- no-US-defaults guard: PASS

The source-policy guard checks:

- `_source_policy.js` is byte-synced into 5 generated node files.
- The same policy block is synced into the 3 modern workflow exports.
- Workflow parse/integrity remains clean.
- Modern exports have 279 nodes, 0 dangling edges, and `Merge Sources` has 5 inputs.

The workflow scrub guard checks:

- No personal owner chat ID numeric fallback in the 3 modern exports.
- `Schedule Payload` falls back closed: `owner_chat_id || ''`.

The no-US-defaults guard checks tracked runtime config and active modern exports for:

- `TIMEZONE:-America/New_York`
- `prefs.timezone || "America/New_York"`
- `tz || "America/New_York"`
- `N8N_PASSWORD:-demo1234`

## Major Completed Work

### P0 / P0.5 / P0.6 - Removed Silent US Defaults

Completed:

- Serper no longer sends `gl=us` when country is null.
- Firecrawl no longer sends `country=US` when country is null.
- Adzuna no longer defaults to `/jobs/us`.
- Adzuna is default OFF.
- RemoteOK is default OFF.
- Currency no longer silently defaults to USD in country-derived paths.
- Stale patch scripts were updated so rerunning them should not reintroduce US defaults.
- Old `|| 'US'` string anchor in `c1_company_ats.js` was converted into a regex/search-anchor pattern so scans do not treat it as an active fallback.

### P1 - RemoteOK and Remote Boards Gating

Completed:

- RemoteOK provider is gated unless `REMOTEOK_ENABLED == "true"`.
- RemoteOK self-registration is also guarded defensively.
- Matcher compose env includes `REMOTEOK_ENABLED=${REMOTEOK_ENABLED:-false}`.
- Remote job boards were added to the source-policy denylist.
- Firecrawl remote-only no longer widens to remote aggregator domains.

Important caveat:

- Old RemoteOK rows remain in the local DB cache from before gating. They can still appear unless inactivated or filtered.

### P2 / P2.1 - Source Policy Centralization

Completed:

- Added `scripts/nodes/_source_policy.js`.
- Centralized ATS URL recognition, board denial, careers path/subdomain logic, URL tier classification, ATS destination test, and standard ATS domains.
- Inlined source policy into:
  - `scripts/nodes/aggregate_jobs.js`
  - `scripts/nodes/normalize_serper.js`
  - `scripts/nodes/normalize_firecrawl.js`
  - `scripts/nodes/normalize_youcom.js`
  - `scripts/nodes/build_fc_queries.js`
- Added `scripts/p2_source_policy.js` patcher.
- Added `scripts/validate_source_policy.js` drift guard.

### P0.7 - Workflow PII / Chat ID Guard

Completed:

- Removed hardcoded owner Telegram chat ID fallback from the 3 modern exports.
- Added `scripts/validate_workflow_scrub.js`.
- `Schedule Payload` now falls back to empty string if owner chat ID is missing.

### P3a - SmartRecruiters Provider

Completed:

- Added SmartRecruiters provider support in `services/matcher/providers/ats.py`.
- Added `db/seed_smartrecruiters.sql`.
- Initial verified slugs:
  - `BoschGroup`
  - `DeliveryHero`
  - `Experian`
  - `Wise`
  - `Visa`
- Provider uses the public SmartRecruiters API.
- Details endpoint is used for rich JD text.
- Structured remote/hybrid fields are passed through.
- Apply URLs are company-direct `jobs.smartrecruiters.com/...`.

### P3a.2 - TITLE_RX Recall Improvement

Completed:

- Added precise engineering title shapes to `services/matcher/providers/__init__.py`.
- Examples added:
  - `SW Engineer`
  - `Software Development Engineer`
  - `Software Developer`
  - `Frontend Engineer`
  - `Mobile Engineer`
  - `iOS Engineer`
  - `Android Engineer`
- Avoided broad false-positive terms like bare `engineer`, bare `developer`, `sales engineer`, `solutions engineer`, and product/manager-only shapes.
- Visa SmartRecruiters jobs now contribute rows.

### P3b - Personio Provider

Completed:

- Added Personio provider.
- Added `db/seed_personio.sql`.
- Initial verified tenants:
  - `personio`
  - `alasco`
  - `wandelbots`
  - `tado`
- Uses XML feed.
- Tenant seed lives in SQL/config, not Python hardcoding.

### P3c - SmartRecruiters and Personio Liveness

Completed:

- Added SmartRecruiters liveness handler to `services/matcher/liveness.py`.
- Added Personio liveness handler to `services/matcher/liveness.py`.
- SmartRecruiters liveness uses the public detail API and can refresh JD text.
- Personio liveness uses page status and avoids false-dropping on anti-bot 403.

### P3d-a - SmartRecruiters Seed Expansion

Completed:

- Expanded `db/seed_smartrecruiters.sql`.
- Added verified slugs:
  - `WesternDigital`
  - `Continental`
  - `Wabtec`
  - `AveryDennison`
- Rejected many unverified/non-tech candidates.

### P3d-b - Personio Seed Expansion Audit

Completed:

- Audited additional Personio candidates.
- No new tenants accepted.
- High-value candidates hit Personio rate limits.
- `db/seed_personio.sql` got an audit comment only.

### P3e - SmartRecruiters Pagination

Completed:

- Added bounded SmartRecruiters pagination.
- Default max pages: 3.
- Hard cap: 10.
- Stops on empty content, totalFound exhaustion, cap per board, or transient page issue.
- Confirmed Bosch/Continental/DeliveryHero coverage improved.

### P3f - Embedding Skip Optimization

Completed:

- Changed `services/matcher/db.py`.
- Added `_fetch_existing`.
- `upsert_jobs` now batch-fetches existing `dedup_key`, `length(jd_text)`, and `embedding IS NOT NULL`.
- Embeds only if:
  - row is new
  - existing row has no embedding
  - incoming JD text is longer than existing JD text
- Skipped rows pass `embedding=None`.
- Existing SQL preserves old embeddings through `COALESCE(jobs.embedding, EXCLUDED.embedding)`.
- Local smoke reported unchanged SmartRecruiters runs embedding 0 rows.

### P4a - Hardcoding Audit

Completed:

- Static audit identified remaining hardcoding and policy drift risks.
- Confirmed major remaining active issues:
  - `STAFFING` regex only in `aggregate_jobs.js`
  - `LISTING_TITLE` regex only in `aggregate_jobs.js`
  - JS `CC_MAP` duplicates Python/DB country mapping
  - `geo.py COUNTRY_ISO`, DB `geo_countries`, and JS `CC_MAP` can drift
  - active US-state fallback exists in geo resolver logic
  - stale/test scripts contain personal fixture data
  - some stale exports still contain old owner chat ID fallback

### P4b - US Defaults / Weak Tracked Defaults

Completed:

- Tracked runtime timezone defaults changed from `America/New_York` to `UTC`.
- Active workflow schedule timezone fallbacks changed from `America/New_York` to `UTC`.
- Tracked compose weak password fallback removed in favor of fail-closed required var syntax.
- Added `scripts/validate_no_us_defaults.js`.

Note:

- Local `docker/.env` may still contain local testing values like `N8N_PASSWORD=demo1234`. That is acceptable for local-only testing but should not become a cloud/shared deployment default.

### P5 - Local E2E Validation

Completed / observed:

- Local services were reported healthy.
- Guards passed.
- Live n8n workflow was stale at 273 nodes and missing the RemoteOK/Adzuna gate nodes.
- cc merged current repo workflow logic with preserved live `staticData`, imported into local n8n, reactivated, and restarted n8n.
- Post-import live workflow reportedly has 279 nodes and preserves user prefs/static data.
- Actual Telegram/ngrok test was then run by the user, producing Telegraph pages.

Telegraph result pages tested:

- `https://graph.org/CareerForge--13-Jobs--Jul-1-07-01`
- `https://graph.org/CareerForge--4-Jobs--Jul-1-07-01`
- `https://graph.org/CareerForge--7-Jobs--Jul-1-07-01`
- `https://graph.org/CareerForge--4-Jobs--Jul-1-07-01-2`
- `https://graph.org/CareerForge--13-Jobs--Jul-1-07-01-2`
- `https://graph.org/CareerForge--11-Jobs--Jul-1-07-01`
- `https://graph.org/CareerForge--13-Jobs--Jul-1-07-01-3`
- `https://graph.org/CareerForge--15-Jobs--Jul-1-07-01`

## Current Good State

The system is now alive end-to-end:

- Telegram/ngrok/local n8n path works.
- Telegraph pages are generated.
- Result links are mostly company-direct.
- Recognized ATS/company career URLs include:
  - Apple jobs
  - Google careers
  - Workday
  - Greenhouse
  - Lever
  - Ashby
  - SmartRecruiters
  - Workable
- No obvious Naukri/Shine/Indeed/LinkedIn/RemoteOK board junk appeared in the sampled Telegraph pages.
- India and Germany country queries are much better than before.
- SmartRecruiters and Personio additions are working.
- n8n live workflow has been brought back in sync with repo logic.

## Current Issues

These are visible in actual Telegram/Telegraph output and should be addressed before calling local quality "perfect".

### I1 - Explicit City Queries Leak Non-City Jobs

Observed:

- Query: AI engineer in New York
- Result page: `CareerForge--11-Jobs--Jul-1-07-01`
- Problems:
  - Apple jobs shown as `United States of America`, not New York-specific.
  - Google shown as `Sunnyvale, CA, USA`.
  - Reddit shown as `San Francisco, CA`.
  - BetterHelp shown as `US - Remote`.

Why it matters:

- If user asks for a city, results should be in or near that city unless clearly remote-eligible and the user allowed remote.
- Country-level US matching is not enough for city intent.

Likely area:

- `hybrid_cache_search.sql` location/proximity scoring/gating.
- Query intent parsing around `location_canonical`.
- Cache lane gate may be country-only in practice.

Desired behavior:

- For explicit city queries, onsite/hybrid jobs should match the city/proximity radius.
- Country-wide or unrelated-city jobs should be dropped or heavily demoted.
- Remote jobs should only appear if remote preference allows them and should be clearly remote-eligible for that country/location.

### I2 - Remote-Only Results Include Non-Remote-Looking Jobs

Observed:

- Query: remote AI engineer
- Result page includes OpenAI `San Francisco` as #1.
- Query: senior backend engineer remote
- Result page includes Capital One `5 Locations`, Airbyte `San Francisco`, and other entries that do not clearly display remote.

Why it matters:

- If the header says `Remote only`, each result should visibly and structurally be remote or remote-eligible.

Likely area:

- Work-mode classification during ingest.
- Remote preference gate in cache SQL.
- Display may hide remote eligibility even when the DB thinks a job is remote.

Desired behavior:

- For remote-only queries:
  - display should say why each result is remote-eligible
  - onsite-only jobs should be excluded
  - ambiguous multi-location jobs should be demoted or excluded unless remote is explicit

### I3 - Sales / Solutions Role Relevance Is Too Loose

Observed:

- `AI Sales Engineer, EMEA` appears in India and Germany AI-engineer result pages.
- FDE roles in UK returned generic platform/software/applied AI roles, not really FDE.

Why it matters:

- User asking for AI Engineer / ML Engineer usually does not want sales engineering.
- User asking for FDE wants forward-deployed / customer-facing engineering, not generic platform engineering.

Likely area:

- Role intent expansion.
- Title filter / role filter.
- Matcher rerank weighting.
- Sales/solutions demotion unless explicitly requested.

Desired behavior:

- Exclude or strongly demote sales engineer, solutions engineer, customer engineer, support engineer unless the query asks for those.
- FDE queries should prioritize titles/descriptions containing forward deployed, deployment engineer, solutions architect/engineer only when appropriate, field engineering, customer engineering, implementation engineering, etc.

### I4 - Europe / EMEA Remote Scope Is Too Permissive For Country Queries

Observed:

- EMEA/Europe remote jobs appear in Germany/India-style country queries.

Why it matters:

- For Germany, Europe/EMEA can be reasonable if marked eligible for Germany, but it should not be treated as worldwide.
- For India, EMEA should not pass.

Current known behavior:

- Remote jobs with no explicit allowed countries can pass as worldwide.
- Region strings are not modeled as country sets yet.

Desired near-term behavior:

- Do not implement broad region expansion yet.
- But do avoid treating explicit region-scoped strings like `EMEA`, `Europe`, `EU`, `UK/EU`, etc. as worldwide for unrelated country queries.
- For now, ambiguous region-scoped remote jobs can be demoted/excluded in strict country queries unless the queried country is clearly inside the scope or the job has no scope at all.

### I5 - Old RemoteOK Cache Rows Still Exist

Observed/reported:

- 118 active RemoteOK rows with `remoteok.com/remote-jobs/...` remain in cache from older ingests.
- RemoteOK provider is gated for new ingest, but historical rows are still active.

Why it matters:

- Old aggregator rows can leak into cache results.

Possible fix:

```sql
UPDATE jobs SET status = 'inactive' WHERE source = 'remoteok';
```

Do this only after deciding that local DB cleanup is acceptable. This is a local state change, not a repo code change.

### I6 - `cf_resolve_location('IN', NULL)` Can Resolve Badly

Observed/reported:

- `cf_resolve_location('IN', NULL)` resolves to Colombia due gazetteer fuzzy matching on a short string.

Why it matters:

- If the LLM passes bare `IN` as `location_canonical`, the SQL resolver can misread it.
- In normal intended flow, the LLM should set country `IN` and leave location null for India.

Desired behavior:

- Bare ambiguous two-letter tokens should not fuzzy-match places.
- If input is ambiguous, intent router should either set country confidently or ask a clarifying question.

### I7 - Display Polish Is Not Premium Yet

Observed examples:

- `Ro - Senior AI Engineer - Lever`
- `Senior AI Engineer - Myworkdayjobs.com`
- `Job Application for Senior Machine Learning Engineer at OpenTeams`
- `career - Applied AI Engineer`
- Company label issues like `Boomilp`, `Betterhelpcom`, `Bluefishai`, `Hipeople Official`, `Twitter2`.

Why it matters:

- Even if the underlying link is correct, messy titles/company names make the product feel less polished.

Likely area:

- Normalizers and `build_telegraph_body.js`.
- Title cleaning.
- Company display label extraction.

Desired behavior:

- Strip ATS/platform suffixes from titles.
- Improve company display names.
- Avoid adding source host names into job titles.

## Current Challenges

### C1 - Avoiding Over-Generalization

Agents tend to overgeneralize fixes into broad architecture work. Keep future prompts tightly scoped.

Good prompt pattern:

- State exact files allowed.
- State exact files forbidden.
- Require no live/cloud touch unless specifically testing local n8n.
- Require validation output.
- Require no new providers unless that is the task.

### C2 - Workflow Exports vs Live n8n State

The repo exports are not automatically the live local n8n workflow.

Important:

- Live workflow was stale before P5.
- Importing scrubbed exports can wipe staticData.
- Any workflow sync must preserve `staticData.global`, especially:
  - user preferences
  - last search intent
  - resume/profile state

Before future workflow edits:

- Validate exports.
- Sync local n8n safely.
- Preserve staticData.
- Run Telegram test after sync.

### C3 - Cache Can Preserve Old Bad Rows

Code fixes do not automatically remove bad historical cache rows.

Examples:

- Old RemoteOK rows remain active after provider gating.
- Old rows may have weak geo, stale liveness, poor workplace_type, or old source classification.

Need distinguish:

- repo/code bug
- local DB state bug
- stale cache cleanup issue

### C4 - Remote Scope Is Subtle

Remote can mean:

- worldwide
- US only
- country only
- region scoped, e.g. Europe/EMEA/APAC
- unspecified/ambiguous

Current system handles some country-scoped remote logic, but region-scoped strings are not modeled well.

Near-term rule:

- Do not implement full region expansion yet.
- Do avoid treating explicit region-scoped jobs as worldwide for unrelated country queries.

### C5 - City Intent Needs Stronger Semantics Than Country Intent

Country filters now mostly work.

City filters still need:

- city/proximity gate
- display explanation
- explicit remote exception handling
- no unrelated in-country city leakage for strict city queries

## Recommended Next Phase

### P5b - Local Telegram Result-Quality Fixes

Goal:

Fix the actual quality issues seen in Telegraph results, then rerun the same Telegram queries.

Scope:

- Keep changes minimal.
- Do not add providers.
- Do not restart architecture cleanup.
- Focus on city, remote, sales/solutions relevance, old RemoteOK cache, and display polish.

Suggested P5b tasks:

1. Strict city/proximity gating for explicit city queries.
2. Remote-only result validation and display.
3. Sales/solutions/support/customer role demotion/exclusion unless requested.
4. Inactivate old RemoteOK rows in local DB, if approved.
5. Clean title/company display artifacts.
6. Rerun the same Telegram queries and compare outputs.

Test queries to rerun:

- `find AI jobs in India`
- `FDE roles in UK`
- `ML engineer Germany`
- `remote AI engineer`
- `AI engineer in New York`
- `AI engineer IN`
- `senior backend engineer remote`

Acceptance criteria:

- India query: no US leakage, no EMEA-only jobs unless clearly India-eligible.
- UK FDE query: roles should be plausibly FDE/field/customer-deployed, not generic platform jobs.
- Germany ML/AI query: Germany or Germany-eligible remote only.
- Remote AI query: every result is visibly remote or remote-eligible.
- New York AI query: no Sunnyvale/SF/generic-US results unless remote logic explicitly allows them.
- `AI engineer IN`: resolves as India or asks clarification, never Indiana/Colombia by accident.
- Senior backend remote: every result is clearly senior and remote.
- No RemoteOK/aggregator rows.
- Result titles and company names look polished.

## Later Backlog

### Hardcoding Cleanup

Remaining hardcoding to handle carefully:

- JS `CC_MAP` in `aggregate_jobs.js`.
- Python `COUNTRY_ISO` in `geo.py`.
- DB `geo_countries`.
- US state fallback list in Python/SQL.
- `STAFFING` regex in `aggregate_jobs.js`.
- `LISTING_TITLE` regex in `aggregate_jobs.js`.
- Display-only brand map in `build_telegraph_body.js`.
- Workday tenant fallback in provider config.
- Stale harnesses with personal fixtures.

Suggested order:

1. Move `STAFFING` and `LISTING_TITLE` into `_source_policy.js` with guard coverage.
2. Decide how country maps should be generated/shared between DB, Python, and n8n JS.
3. Review whether US state fallback should stay, move to DB, or become LLM clarification.
4. Archive or clearly mark stale exports and stale patchers.

### Provider Expansion

Current proved providers include:

- Workday
- Greenhouse
- Lever
- Ashby
- SmartRecruiters
- Personio
- plus custom provider work for large companies already present in the matcher provider registry

Future provider expansion should be done slowly:

- verify public API/source behavior first
- seed via SQL/config, not Python hardcoding
- smoke locally
- run liveness
- check actual Telegram results

Potential future ATS/provider targets:

- Teamtailor
- iCIMS
- Jobvite
- BambooHR
- Breezy
- Taleo
- SuccessFactors
- Oracle Cloud
- more custom big-tech career APIs/pages

Do not add providers until P5b quality issues are fixed.

### Resume / Cover Letter

Resume and cover letter generation is intentionally later.

The job discovery foundation should be excellent first:

- correct jobs
- direct URLs
- fresh/liveness verified
- good JD snippets
- strong location/remote behavior
- polished display

Then resume/cover/contact flows can be improved.

## Before Git Push Checklist

Run:

```powershell
node scripts/validate_source_policy.js
node scripts/validate_workflow_scrub.js
node scripts/validate_no_us_defaults.js
```

Also verify:

- local n8n workflow is synced to latest intended logic
- local workflow staticData is preserved
- matcher is healthy
- Postgres is healthy
- Telegram/ngrok path works
- the seven test queries above return acceptable output
- no backup files or stale generated junk are staged
- no personal secrets/PII are in tracked files
- stale exports are not accidentally committed as active truth

## Notes For Future Agents

- Do not assume repo workflow export equals live n8n workflow.
- Do not import scrubbed exports without preserving staticData.
- Do not treat old cache rows as evidence that a provider gate is broken.
- Do not broaden a scoped fix into provider expansion or architecture rewrite.
- The user wants practical local quality through Telegram first.
- The phrase "perfect locally" means the Telegram output quality, not just passing static guards.
