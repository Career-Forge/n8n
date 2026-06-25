# CareerForge -- Render Fixes + JobRight-grade Discovery Overhaul

This document covers the full set of changes on the `dev` branch: why each was made,
how it works, and the architecture behind it. Three bodies of work:

1. **Resume / cover render rewrite** -- kill the malformed-LaTeX and dash/company-name bugs.
2. **Matcher microservice** -- replace LLM "score a job /100" with a model-based, explainable match.
3. **Discovery overhaul (Phase 1)** -- fix the *root cause* of bad `find` results: a starved job cache.

The through-line: move correctness-critical work out of prompted LLM calls and into
deterministic, testable code (a LaTeX assembler, a cross-encoder, a typed ingestion
pipeline), and demote the LLM to the few things it is actually good at.

---

## 0. Context

CareerForge is a self-hosted, single-user, clone-and-BYOK Telegram job-search bot built
on n8n. The stack (Docker Compose, `docker/docker-compose.yml`):

| Service | Role |
| --- | --- |
| `n8n` | workflow engine (SQLite for its own state) |
| `postgres` (pgvector pg17) | the app's job cache + embeddings + registry |
| `ollama` (bge-m3) | local 1024-d embeddings |
| `latex` | PDF compile service (resume/cover) |
| `matcher` | cross-encoder rerank + skill graph + **discovery ingestion** (this work) |

The live workflow is `CareerForge Master — Local v6.3` (id `kmQDCNypCfZbqwAW`).

---

## 1. Resume / Cover render rewrite

### The bugs
Live testing produced visibly broken resumes: literal `$•$` bullets, raw LaTeX math
leaking into the PDF (`$\to$`, `$\sim$40\%`), right-margin overflow on project tech
stacks, cramped en/em-dashes in cover letters, `Https://Visa` as a "company name", and
`Invalid Date`.

### Root cause
One bug class dominated: `normalizeLatexForPdflatex` blanket-escaped **every** unescaped
`$` to `\$` across the whole document. That destroyed both the skeleton's nested-bullet
math macro and any math the LLM emitted -- the model was being *asked* to write LaTeX,
and any imperfection corrupted the render.

### The fix -- "LLM writes text, code writes LaTeX"
The decision (locked during brainstorm) was to make the LLM emit **structured text only**
and have a deterministic assembler build 100% of the LaTeX.

- **Pass-1** (`prompts/`/parse nodes) stamps a unique `id` on every position, internship,
  project, and achievement.
- **Pass-2** (`prompts/Pass2_Resume.md`) returns JSON keyed by those ids:
  `{summary, bullets:{<id>:[...]}, achievements:{<id>:"..."}, improvements, resumePlainText}`.
  Hard rule in the prompt: never emit a backslash or `$`; only `**bold**` markup.
- **The assembler** (`scripts/nodes/assemble_resume_latex.js`) builds every section's LaTeX
  via `escapeLatexText` (clean unicode -> escape `# $ % & _ { } ~ ^`), converts `**bold**`
  to `\textbf{}` *after* escaping, and falls back to Pass-1 text verbatim if Pass-2 omits an
  id. The blanket `$`-escape is gone; the right-margin overflow is fixed by wrapping the
  project tech-stack in a `tabularx` `X` column; stacked multi-role entries render
  deterministically from a Pass-1 flag.

Net effect: the math-leak / malformed-LaTeX class is structurally impossible -- the model
never produces a character that needs escaping.

### Cover letter + company name + dates
- **Dashes** (`prompts/Cover_Pass2.md` + `scripts/nodes/build_cover_latex.js`): the prompt
  forbids bare en/em-dashes; the normalizer rewrites `word--word` -> `word -- word` so LaTeX
  renders spaced dashes instead of a glued en-dash.
- **Company name** (`scripts/nodes/build_telegraph_body.js`): a hardened `cleanCompany()` +
  `_brandFromUrl()` derive a brand label from ATS/domain patterns, with a brand-casing map,
  and **never** return anything containing `://` (kills `Https://Visa`).
- **Dates** (`scripts/nodes/_parse_posted_date.js`): `parsePostedDate` normalizes ISO / epoch
  / relative ("3 days ago", "yesterday") to ISO, applied across all normalize lanes (kills
  `Invalid Date` and makes the recency filter actually fire).

Each code node ships with an offline regression harness (`scripts/_harness_s10..s13.js`).

---

## 2. Matcher microservice (`services/matcher/`)

### Why
The old path asked an LLM to score each job out of 100 -- opaque, unstable, and a poor
relevance signal on thin web snippets. JobRight-grade matching needs a trained relevance
model and an explainable skill breakdown, not a prompt.

### What it does
`POST /match` takes `{resume_text, jobs:[{id,title,jd_text,url}], enrich, top_n}` and returns,
per job, a transparent `match_pct` plus a skill breakdown:

- **Cross-encoder rerank** -- `BAAI/bge-reranker-v2-m3` (sentence-transformers `CrossEncoder`,
  CPU by default, baked into the image so the first call isn't a ~2GB download). Scores the
  (resume, JD) pair directly -- far stronger than bi-encoder cosine alone.
- **Skill graph** -- built lazily from **bge-m3 embeddings** of a ~110-skill vocab
  (`skills_vocab.json`), cached to disk. Multi-hop adjacency (<=2 hops, cosine threshold 0.68,
  per-hop decay 0.6, min-credit 0.20) gives partial credit for *adjacent* skills (e.g. a
  resume's "Transfer Learning" partially covers a JD's "Deep Learning"). ESCO was rejected --
  its bulk CSV is portal-gated, and embedding-similarity handles tech-skill synonymy better.
- **Firecrawl validation + JD enrichment** (`enrich:true`) -- scrapes the top-N apply URLs in
  parallel, drops hard-404/410/closed-marker pages, and replaces the thin snippet `jd_text`
  with the full scraped JD before reranking.
- **Score** -- `match_pct = round(100 * (0.65 * rerank + 0.35 * skill_coverage))`, with the
  matched / missing / adjacent skill lists returned for display.

The find pipeline was rewired (`scripts/s13_wire_matcher.js`): the LLM `JobScorer` (+ its model
and output parser) is removed; `IF: Resume Available? -> Build Matcher Request -> Matcher Match
(HTTP) -> Parse Scorer Output -> display`. The digest shows `NN% match` + skill chips + a
`verified` badge + freshness.

---

## 3. Discovery overhaul (Phase 1) -- the main work

### The real problem
Even with a good matcher, `find` returned stale and dead jobs. The measured root cause was
**supply, not scoring**: the job cache was starved.

| Cache metric (before) | Value |
| --- | --- |
| total jobs | 1,815 |
| **missing embeddings** | **1,578 (87%)** -- only 237 searchable |
| companies with any jobs | 20 of 15,532 registered |
| jobs < 7 days old | 4 |
| big companies (Google/Meta/Amazon/NVIDIA/...) | **0** |

So every search fell through to noisy web-snippet lanes (Serper / Firecrawl / You.com =
Google-for-jobs) -> stale, often-dead, low-relevance. No matcher fix can rescue a bad pool.

### The architecture (locked)
**Pluggable, key-gated, multi-source ingestion (in the Python service) -> one normalized +
deduped + embedded Postgres cache -> cache-first `find` + 2-pass matcher -> web search demoted
to discovery/enrichment.** Full plan in `DISCOVERY_PLAN.md`.

Why ingestion lives in the Python service, not n8n: n8n's task runner sandboxes `process.env`,
which makes clean per-provider BYOK key-gating painful in Code nodes (the old poller hit this).
A single Python engine owns ingestion, so embedding, dedup, and trust are uniform across every
lane.

#### 3.1 The `JobRecord` contract + schema (`db/schema.sql`)
The `jobs` table was grown from a single-source registry-poller model into a multi-source
cache. New columns: `source, ats_type, company_name, company_domain, url, employment_type,
seniority, skills[], salary_min/max/currency`, plus the two load-bearing fields:

- **`dedup_key`** (partial `UNIQUE` index, `WHERE dedup_key IS NOT NULL`) -- the upsert conflict
  target. A canonical, *job-specific* apply/posting URL becomes `url:<canonical>`; otherwise a
  content hash `kt:<sha1(company|title|location)>`. Generic URLs (a board's `/search` page used
  as a fallback apply link) are **not** job-specific, so they fall to the content hash -- this
  was found live when two distinct Stripe jobs shared `stripe.com/jobs/search`.
- **`trust`** (smallint) -- 30 direct-ATS / employer site, 25 Workday, 20 aggregator, 10 web.
  On a dedup collision the highest-trust copy wins authoritative fields; nulls are always
  backfilled from the loser, and the richer JD is kept.

The old `UNIQUE(board, external_id)` was retired (kept as a plain index for the per-board
liveness diff). The migration is idempotent (`ALTER ... ADD COLUMN IF NOT EXISTS` + guarded
backfills) so it re-applies by hand and converges both a fresh boot and the live DB. Legacy
rows were backfilled (source/ats_type from `board`, trust 30, dedup_key two-pass: unique URLs
get `url:` keys, the rest fall to `atsid:board:external_id`).

#### 3.2 Provider registry (`services/matcher/providers/`)
Every source is a uniform plugin:

```
Provider { name, kind: 'free'|'keyed', key_env, enabled(), fetch(queries) -> JobRecord[] }
```

- `kind='free'` -> always enabled, no key.
- `kind='keyed'` -> enabled iff `key_env` is set. **Any subset of keys works, and a fully
  keyless run still ingests every free lane and never errors on a missing key.**
- `GET /sources` reports who is live + per-provider cache yield.

**Free lanes shipped (no key required):**

| Provider | Endpoint | Trust | Notes |
| --- | --- | --- | --- |
| `remoteok` | `GET remoteok.com/api` | 20 | ~100 latest; UTF-8 + HTML-entity cleanup |
| `workday` | `POST {tenant}.wdN.myworkdayjobs.com/wday/cxs/.../jobs` | 25 | seeded big-co tenants (NVIDIA proven, 2000 jobs); list view is thin, JD enriched at match time |
| `amazon` | `GET amazon.jobs/en/search.json` | 30 | rich JD; covers Amazon/AWS/etc. |
| `greenhouse` | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | 30 | registry-driven |
| `lever` | `api.lever.co/v0/postings/{slug}?mode=json` | 30 | registry-driven |
| `ashby` | `api.ashbyhq.com/posting-api/job-board/{slug}` | 30 | registry-driven |
| `workable` | `apply.workable.com/api/v1/widget/accounts/{slug}` | 30 | registry-driven |
| `recruitee` | `{slug}.recruitee.com/api/offers` | 30 | registry-driven |

The five ATS providers are **registry-driven**: they read boards due for a poll from the
`companies` table (`is_active AND next_poll_at <= now()`, by `ats_type`), keep only
role-relevant postings via a `TITLE_RX` filter up to a per-board cap (the registry has 15k+
companies, so an unfiltered fetch would flood the cache with junk), and then advance
poll-state (bump `next_poll_at`, reset failures, store etag) / penalize failures
(exponential backoff, deactivate 404/410 boards or after 5 fails). Endpoints, field maps, and
bookkeeping mirror the old n8n poller exactly -- the proven, working logic -- with one fix: the
`TITLE_RX` regex escapes (mangled by JS string literals in n8n) are correct in Python.

**Keyed lanes (BYOK, wired in compose, plugins land in Phase 2):** `FANTASTIC_API_KEY`,
`JSEARCH_API_KEY`, `APIFY_TOKEN`, `ADZUNA_APP_ID/KEY` -- blank vars are silently skipped
(verified: a keyless `docker compose up` logs the blank-var warnings and runs the free lanes
fine).

#### 3.3 Ingestion core (`db.py`, `embed.py`, `skills.py`)
`upsert_jobs(records)`:
1. **Extract skills** from the JD (the matcher vocab) for any record that didn't supply them.
2. **Embed on ingest** -- bge-m3 over `title + company + location + jd_text[:2000]`,
   parallelized (ThreadPoolExecutor) **before** the DB transaction opens so the txn stays short.
   This fixes the 87%-null bug at the source: every new row is embedded.
3. **Trust-gated upsert** -- `INSERT ... ON CONFLICT (dedup_key) DO UPDATE` where the higher/equal
   trust source overwrites display fields, `trust = GREATEST(...)`, nulls backfilled via COALESCE,
   the longer JD wins, and the embedding is recomputed only when a longer JD is adopted.

`skills.py` was factored out of `app.py` (shared by `/match`, `/extract_skills`, and ingestion)
to avoid an `app -> db -> app` import cycle. psycopg is installed in a Dockerfile layer **after**
the cross-encoder bake so adding ingestion deps doesn't bust the ~2GB model cache.

#### 3.4 `/ingest` + background runs
`POST /ingest` runs enabled providers (optionally a subset, optional per-provider `limit`), and
can also upsert an external pre-normalized `jobs` batch. It returns per-source + total stats.

A multi-hundred-job ingest is too long for one synchronous HTTP call -- a client timeout was
observed truncating a provider's batch mid-run. So `background:true` returns `{status:"started"}`
immediately and runs in a FastAPI `BackgroundTask`, single-flight (a second call while one runs
returns `busy`), with last-run state surfaced in `/sources`. A bug where a prior limited call's
env override leaked into a later unlimited (scheduled) call was fixed by restoring configured
defaults when no `limit` is given.

#### 3.5 n8n wiring (`docker/workflows/CareerForge_Discovery_Ingest.json`)
The two old `CareerForge — ATS Poller` workflows (which wrote rows to Postgres with **no
embedding**) were deactivated. A minimal `CareerForge — Discovery Ingest` workflow was added:
**Schedule (every 3h) -> HTTP `POST matcher-service:5680/ingest {background:true}`**. n8n
orchestrates; Python does the work. The matcher-wired master workflow is untouched.

---

## 4. Verification (live)

After the migration + a full ingest across the free lanes:

| Metric | Before | After |
| --- | --- | --- |
| big-co jobs (NVIDIA + Amazon) | 0 | 419+ |
| jobs < 7 days old | 4 | 232 |
| distinct companies | 20 | 200 |
| **active rows lacking an embedding** | most | **0** |
| total cache | 1,815 | 2,710 |

- Every **active** (searchable) row is embedded; remaining NULLs are all closed/stale legacy
  rows that cache-first find ignores.
- Dedup verified across runs and sources (re-ingest UPDATEs, never duplicates; the unique index
  guarantees it).
- Data quality spot-checked: NVIDIA "Senior AI Engineer, Agents and Developer Workflows", Amazon
  GenAI roles, greenhouse "Senior AI Engineer" -- real dates, clean companies, job-specific dedup
  keys, skills extracted.

---

## 5. Operating it

```bash
# one-off / manual ingest (all free lanes), synchronous:
curl -s -X POST localhost:5680/ingest -H 'Content-Type: application/json' -d '{}'

# background (what the schedule does):
curl -s -X POST localhost:5680/ingest -d '{"background":true}'

# a subset / capped, for testing:
curl -s -X POST localhost:5680/ingest -d '{"providers":["greenhouse"],"limit":5}'

# who is live + cache yield + last run:
curl -s localhost:5680/sources | python -m json.tool

# re-apply the (idempotent) schema by hand:
docker exec careerforge_postgres psql -U careerforge -d careerforge \
  -f /docker-entrypoint-initdb.d/01_schema.sql
```

**Add a free provider:** drop a module in `services/matcher/providers/`, implement
`fetch(queries) -> JobRecord[]`, `register()` it, add its name to `_load_plugins()`.
**Add a keyed provider:** same, with `kind='keyed'` + `key_env`, and add the env var to the
matcher service in `docker-compose.yml`. **Add a Workday big-co tenant:** append to
`WORKDAY_TENANTS` in `providers/__init__.py`.

---

## 6. Known limitations / next phases

- **Phase 2 -- keyed backbone:** Fantastic.jobs (primary aggregator), JSearch, Apify, Adzuna
  plugins (env wired, code pending), each with a per-source budget cap + yield backoff.
- **Phase 3 -- cache-first `find` + matcher 2-pass:** point `find` at the now-rich cache
  (semantic + keyword + recency) first; demote web lanes to discovery/enrichment/fallback; feed
  the matcher the full resume text. This is what makes the supply improvements visible in `find`.
- **Phase 4 -- registry growth + freshness:** ATS-dork discovery to auto-add greenhouse/lever/
  ashby tokens + Workday tenants; close-stale liveness.
- **Display polish (Phase 3):** Amazon legal-entity company sprawl ("Amazon.com Services LLC -
  A57"), Workday multi-location ("4 Locations"), RemoteOK off-niche breadth.
- Workday list view has no JD (enriched at match time via Firecrawl); a per-job detail fetch
  could enrich on ingest later.
- ~1,546 closed/stale legacy rows remain NULL-embedded; harmless (not active), could be pruned.

---

## 7. File map

```
db/schema.sql                                  JobRecord contract + dedup/trust (idempotent migration)
services/matcher/
  app.py                                       /health /match /extract_skills /ingest /sources
  db.py                                        canonical_url, dedup_key, trust-gated upsert, poll-state, stats
  embed.py                                     bge-m3 embeddings via Ollama
  skills.py                                    vocab + skill extraction (shared)
  providers/
    __init__.py                                JobRecord, Provider base, REGISTRY, WORKDAY_TENANTS, date parsers
    remoteok.py  workday.py  amazonjobs.py     free query-based lanes
    ats.py                                     registry-driven greenhouse/lever/ashby/workable/recruitee
  Dockerfile  requirements.txt  skills_vocab.json
docker/docker-compose.yml                      matcher PG creds + keyed-provider env
docker/workflows/CareerForge_Discovery_Ingest.json   schedule -> POST /ingest
DISCOVERY_PLAN.md                              the execution plan
scripts/nodes/assemble_resume_latex.js         deterministic LaTeX assembler
scripts/nodes/build_telegraph_body.js          digest UI: match% + skills + company cleanup
scripts/s10..s13_*.js                          workflow patch scripts (render, cover, freshness, matcher wire)
```

---
---

# Part II -- Cache-first find, desirability ranking, quality fixes, coverage + Workday (June 2026)

Part I built the supply (a deduped, embedded, trust-tiered cache). Part II makes it *visible and good* in `find`: cache-first retrieval, a 2-pass matcher, a company **desirability tier** layered on relevance, a batch of result-quality fixes driven by real `find` output, a coverage engine that stops the 15k-board registry from starving the curated companies, and a registry-driven **Workday** provider that unlocks the entire enterprise/pharma/insurance/Fortune-500 world.

## 8. Cache-first `find` + matcher 2-pass (Phase 3)

The LLM `JobScorer` is gone. `find` now retrieves from the cache first and ranks with the model:

- **Hybrid Cache Search** (`scripts/nodes/hybrid_cache_search.sql`) -- RRF of vector kNN (bge-m3 cosine) + tsvector keyword, blended with `trust` and a 14-day recency decay, `LEFT JOIN companies` + `COALESCE(company_name)` so `company_id`-NULL big-co/aggregator rows aren't dropped. Vec/kw scan LIMIT 150 each, final LIMIT 200 (widened so location-matched rows actually surface).
- **Cache Prefilter -> Aggregate Jobs** carry the full `JobRecord` forward (trust/skills/salary/full JD/posted_at), `source_priority:0` so cache outranks web at equal tier; cache-shortfall `count` gates the paid web lanes (skip when cache >= 25).
- **Matcher 2-pass** (`services/matcher/app.py`): PASS1 cross-encoder rerank ALL candidates -> SELECT post-rerank top-N -> PASS2 Firecrawl validate+enrich ONLY those -> PASS3 re-rank survivors on the full JD. Fixes the old "validate-set != display-set" dead-#1 bug. `top_n=15`; rerank inputs truncated (resume 3000 / JD 2000 chars -- the model caps at 512 tokens anyway).
- Patched via `scripts/s14_phase3_cachefirst.js` into all 3 master JSONs; harness `scripts/_harness_s14.js`.

## 9. Desirability tier ranking (Sprint A)

Relevance alone surfaced mediocre-but-keyword-matchy jobs. Added a **per-company desirability tier** (S/A/B/C/D) applied **worldwide**, the user's rubric:

- **MAANGO = always S** (brand = career capital): Meta/Microsoft, Apple/Anthropic, Netflix, Google, Oracle/OpenAI.
- Else **pay x WLB**: S = high pay + good WLB; A = above-avg pay OR great pay + brutal WLB (**Amazon is the A anchor**); B = average; C = market standard; **D = IT body-shop** (TCS/Infosys/Wipro/Cognizant... -- hard downrank, never hidden).
- **Mechanism:** name-keyed `company_tiers(name_norm PK, tier, canonical)` + an IMMUTABLE `cf_name_norm(text)` SQL fn (lower, strip corp suffixes, strip non-alnum) used by BOTH the seed and the ranking JOIN so "Google"/"Google LLC"/"Alphabet" collapse identically. Matched by **name** (not FK) so off-registry + web-lane jobs tier too. `hybrid_cache_search` multiplies `rrf_score` by the tier weight (S 1.0 / A .85 / B .72 / C .62 / D .25); `build_telegraph_body` adds a strong sort booster + visible 🏆/⭐ badges (a great A-match still beats a weak S -- strong multiplier, not a hard sort).
- Schema + `cf_name_norm` + `company_tiers` in `db/schema.sql`; seed in `db/seed_dream_tier.sql`; nodes patched via `scripts/s15_sprintA_tiers.js`; harness `scripts/_harness_s15.js`.

## 10. Result-quality fixes (driven by live `find` output)

Each fix below came from inspecting a real Telegraph results page:

- **Matcher 120s timeouts** -> n8n HTTP node 120s->300s; the matcher **skips Firecrawl for real-time ATS** (`_ATS_LIVE` = greenhouse/lever/ashby/amazon -> marked `live` for free) but **still validates Workday/Workable/Recruitee** (they keep stale/filled jobs for weeks).
- **Dead-listing tail** -> `build_telegraph_body` drops `not_checked` jobs (only Firecrawl-live/unverified or trusted-ATS shown), fallback to all if <6 survive; `top_n` 12->15.
- **Intern/aggregator/staffing junk** -> intern/trainee/hackathon title filter in cache_prefilter + aggregate; **web-junk filter** in `aggregate_jobs` drops aggregator listing pages (BeBee, ProductBased, AmbitionBox, Naukri, "300+ Jobs in X" titles) and staffing/body-shop reposts (Smart Working, Wissen, Jobgether, Infotech...).

## 11. Location binding

`find` for "Pune" was returning Remote-US / not-specified jobs. The `aggregate_jobs` location filter now:
- binds on **all** sources (web no longer bypassed), with a **synonym/region map** (bangalore<->bengaluru<->karnataka, nyc<->new york, india->cities + ", IND"), and **drops jobs with no location evidence** in location+title;
- is **remote-country-aware**: a remote job only matches if it's remote-in-your-country, in-region, or unqualified/global remote -- "Remote - US"/"Remote - Ireland" no longer pollute a Pune/India search (the single biggest mismatch source).

## 12. Coverage engine

Diagnosed root cause of thin India/niche results: the `companies` registry already held **~15,000 bulk-seeded boards** (all `probe`), but ingest polls only `ATS_DUE_LIMIT` boards/type/run oldest-first -> curated companies refreshed ~monthly.

- **Tier-priority polling:** `db.select_due_companies` now `ORDER BY tier (dream>hot>warm>probe>cold), next_poll_at` -- curated boards poll first every cycle, the tail fills behind them. `ATS_DUE_LIMIT` 25->40.
- **Curated promotion:** seeded/promoted ~140 high-value boards to `hot` -- India unicorns (PhonePe/Meesho/Zeta/Postman/Groww...), global big-tech/fintech (OpenAI/Anthropic/Stripe/Databricks/Snowflake/MongoDB/Revolut/N26/...), via `db/seed_top_companies.sql` (+ verified-slug discipline). Result: India AI 7->23+, NYC/London/APAC/EU all populated.
- **GOTCHA fixed:** seed `ON CONFLICT DO UPDATE` must set `tier` (a prior omission left existing rows at `probe`, never promoted).

## 13. Workday provider -- registry-driven (the enterprise unlock)

Pharma/insurance/MedTech/Fortune-500/Adobe/Salesforce/Snap/India-MNC dev centers are **100% Workday** and were unreachable (provider was hardcoded to NVIDIA). Workday exposes a **free CXS JSON API** -- so this was a registry + discovery problem, not scraping. Firecrawl is used only for **tenant discovery**, never the fetch.

- **W1 -- `providers/workday.py` rewritten registry-driven.** Reads `select_due_companies("workday")`; `api_base` = **full CXS base URL** (`https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}`; `_parse_api_base` also accepts legacy `tenant|wd|site`) -- bakes in the unguessable wd-cluster + site path. `slug=tenant` so `board`/`external_id`/`url` stay **byte-identical** to the old provider -> dedup stable (verified: NVIDIA re-ingest = 0 inserted/25 updated). Mirrors `ats.py` ok/failed/gone -> advance/penalize bookkeeping; 404/410->deactivate. Shared `TITLE_RX`+`CAP_PER_BOARD` moved to `providers/__init__.py`. NVIDIA in-code fallback only when registry empty.
- **Two perf bugs fixed** (both were fatal at scale): unbounded pagination (big low-tech tenants paged the whole board hunting 25 matches) -> `WORKDAY_MAX_PAGES=5`/query; sequential fetch (40 tenants >10min) -> `ThreadPoolExecutor` parallel (`WORKDAY_WORKERS=12`).
- **W2 -- discovery + verify + seed.** `scripts/_discover_workday*.py`: Firecrawl `/v2/search "{co} careers myworkdayjobs"` -> parse `*.myworkdayjobs.com/{site}` -> CXS-verify (`total>0`) -> **name-match guard** (auto-flags wrong-company false-positives as REVIEW). `scripts/gen_workday_seed.js` merges batches, drops audited FPs (Teva->Mallinckrodt, BostonSci->BostonDynamics, *->workday/standard), rescues valid ticker tenants (J&J->jj, Cencora->myhrabc, JohnsonControls->jci...). -> `db/seed_workday.sql` = **182 CXS-verified employers** (56 A / 126 B). **Live: 3,079 jobs / 165 employers / 564 India roles, 0 dup keys, all 183 boards polled.**
- **W3 -- full-JD detail-fetch** (flag `WORKDAY_DETAIL_FETCH`, default off): GET CXS detail -> `jobPostingInfo.jobDescription` -> `strip_html`; `externalUrl` == our `url` so dedup unchanged (upsert upgrades the thin row in place). Offline-tested against `wd_detail.json`.

## 14. Methodology notes

- **Verify-first discovery:** every ATS slug / Workday tenant is hit live (greenhouse curl-batch, CXS probe) before it's seeded -- a hallucinated/dead board never enters the registry. The CXS `total>0` and `"jobs"` presence are the gates.
- **Offline harness everything:** node harnesses (`_harness_s14/s15`) for the JS nodes; an in-container `_test_workday.py` (mocks httpx) for the provider -- run before any rebuild/deploy.
- **Idempotent seeds + dedup stability** are the core correctness gates: re-ingest must show `updated >> inserted`, `count(distinct dedup_key) == count(*)`.

## 15. Updated limitations / next

- Workday `searchText` recall is freshness-biased per cycle (page cap 5); huge sparse tenants surface their newest matches first, the rest fill on re-poll.
- Discovery name-guard still lets partial-substring FPs through (Lumen->Lumentum) and stuck a few valid tickers in REVIEW -> a short manual audit remains; the guard + RESCUE/DROP sets in `gen_workday_seed.js` capture it.
- Amazon legal-entity sprawl still misses the tier join (entity-prefix matching = follow-up).
- W3 detail-fetch is off by default (volume); enable per-tenant or globally when match quality on Workday matters more than ingest speed.

## 16. File map additions (Part II)

```
db/seed_dream_tier.sql        MAANGO + pay-WLB tier map + body-shop denylist (cf_name_norm)
db/seed_top_companies.sql     ~40 India/global curated boards promoted to 'hot'
db/seed_workday.sql           182 CXS-verified Workday tenants (full-URL api_base + tiers)
services/matcher/providers/
  __init__.py                 + shared TITLE_RX, CAP_PER_BOARD
  workday.py                  registry-driven CXS provider (parallel, page-capped, W3 detail flag)
scripts/
  s14_phase3_cachefirst.js    cache-first + 2-pass node patch
  s15_sprintA_tiers.js        desirability-tier + location + junk node patch
  gen_workday_seed.js         discovery output -> seed_workday.sql (audit DROP/RESCUE + tiers)
  _harness_s14.js / _harness_s15.js   offline node harnesses
scripts/nodes/                hybrid_cache_search.sql, cache_prefilter.js, aggregate_jobs.js,
                              build_matcher_request.js, build_telegraph_body.js (+ web-query gates)
```

