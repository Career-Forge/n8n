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
