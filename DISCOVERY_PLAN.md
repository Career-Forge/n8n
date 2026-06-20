# CareerForge -- Discovery Overhaul (JobRight-grade sourcing)

## Why

Live testing showed `find` returns stale/garbage jobs. Measured root cause: the pool is starved, not the scorer.
- `jobs` cache: **1,815 total, 87% missing embeddings (only 237 searchable), 20 of 15,532 companies have jobs, 4 jobs <7 days old, zero big companies.**
- So every search falls through to noisy web-snippet lanes (Serper/Firecrawl/You.com = Google) -> stale, often-dead, low-relevance. The matcher scores noise.

**Goal (non-negotiable):** JobRight-grade *for this user's niche* -- fresh, broad, deduped, mostly-live recommendations spanning startups AND big-co (Google/Meta/Amazon/Apple/Microsoft/NVIDIA), US AND India/remote.

## Architecture (locked)

**Pluggable, key-gated, multi-source ingestion (in the Python service) -> one normalized + deduped + embedded Postgres cache -> cache-first `find` + 2-pass matcher -> web search demoted to discovery/enrichment.**

- Grow the existing `matcher` container into a **discovery+matcher service** (add Postgres write access). It owns ingestion because n8n's task runner sandboxes `process.env`, which makes clean BYOK key-gating painful in Code nodes (the current poller already hit this).
- **Source registry** -- every provider is a uniform plugin:
  `{ name, kind: free|keyed, key_env, enabled(), fetch(query|schedule) -> rawJobs[], normalize(raw) -> JobRecord }`
  - **Free (always on, no key):** RemoteOK, Workday CXS (seeded big-co tenants -- proven: NVIDIA 2,000 jobs incl. Bengaluru), amazon.jobs, greenhouse/lever/ashby/smartrecruiters board APIs.
  - **Keyed (active iff key present):** Fantastic.jobs (primary backbone), JSearch (RapidAPI), Apify actors, Adzuna, later TheirStack/Coresignal.
  - Each plugin self-checks its key at run time: present = active, absent = silently skipped. **>=1 key or even zero -> still runs the free lanes, never errors on missing keys.** A `/sources` endpoint reports who's live.
- **Cache-first `find`:** semantic (bge-m3) + keyword + recency over the cache -> matcher 2-pass rerank -> display. Web lanes drop to discovery + enrichment + zero-result fallback, never the primary source.

## Load-bearing contracts (define these first)

1. **`JobRecord` (normalized schema)** every plugin maps to: `source, source_job_id, company, company_domain, ats_type, title, location, remote, employment_type, seniority, skills[], salary_min/max/currency, description_md, url, apply_url, posted_at, first_seen_at, last_seen_at, closed_at, is_active`.
2. **Dedup key + trust order:** canonical apply-URL OR `hash(company_norm + title_norm + location_norm)`. On collision keep the highest-trust copy: **direct ATS/Workday > aggregator > web snippet** (extends the existing source-tier idea); backfill missing fields from dropped dups.
3. **Embed-on-ingest:** every upserted job gets a bge-m3 embedding in the same step (fixes the 87%-null bug at the source).
4. **Service endpoints:** `POST /ingest` (run enabled providers; called by an n8n schedule trigger), `GET /sources` (live providers + yield), `POST /match` (existing, now reads the enriched cache).
5. **Per-provider env keys (BYOK):** `FANTASTIC_API_KEY`, `JSEARCH_API_KEY` (RapidAPI), `APIFY_TOKEN`, `ADZUNA_APP_ID/KEY`, … ; free lanes need none.

## Phases

### Phase 1 -- Foundation (free, critical)
- DB: finalize the `JobRecord` schema + dedup/trust + `is_active`/freshness columns; **fix embed-on-ingest** (100% embedded).
- Service: provider-registry scaffold + the **free plugins** (RemoteOK, Workday CXS with a seeded big-co tenant list, amazon.jobs, greenhouse/lever/ashby/smartrecruiters) + `/ingest` + `/sources`. Service gets PG creds via env.
- n8n: replace the ATS Poller's logic with a thin **schedule trigger -> `POST /ingest`** (n8n orchestrates, Python does the work).
- **Checkpoint:** cache fills with big-co + startups, every row embedded, `/sources` shows free lanes live, no key required.

### Phase 2 -- Keyed backbone (BYOK)
- Add keyed plugins: **Fantastic.jobs** (primary), **JSearch**, **Apify**, **Adzuna** -- each key-gated, with a **per-source budget cap** (e.g. Fantastic.jobs <= N jobs/run) and **yield tracking** (reuse `relevant_yield` / `consecutive_failures` so low-value providers auto-back-off).
- **Checkpoint:** with a Fantastic.jobs key, breadth/freshness jump (global + India + big-co + dedup); with zero keys, free lanes still fill -- graceful either way.

### Phase 3 -- Cache-first `find` + matcher 2-pass
- `find` queries the cache first (semantic + keyword + recency); the **matcher 2-pass fix** (rerank all -> validate + enrich the *actual* top-N -> re-rank survivors) so everything shown is verified + full-JD-matched. Feed the matcher the **full resume text**, not a thin summary.
- Demote You.com/Serper/Firecrawl `/search` to discovery/enrichment/fallback.
- **Checkpoint:** `find` returns fresh, deduped, validated, well-matched results; no dead #1; no snippet-only mush.

### Phase 4 -- Registry growth + ongoing freshness
- **ATS-dork discovery** (Firecrawl/You.com `/search` on `site:boards.greenhouse.io "AI Engineer" "Bengaluru"` etc.) -> auto-discover greenhouse/lever/ashby tokens + Workday tenants -> add to the poll registry. Firecrawl enrichment/liveness on the shown top-N (already built).
- Scheduled ingest cadence + expiry (`close-stale` when unseen N runs / page shows closed).
- **Checkpoint:** registry grows itself; pool stays fresh without manual seeding.

## Verification
- Per phase: offline plugin unit tests (mocked provider payloads) -> live `/ingest` fills the cache -> `/sources` health -> end-to-end `find` in Telegram.
- Dedup test: same job from Fantastic + Workday + web collapses to one canonical record.
- Cost guard: per-source caps + spend logging; confirm zero-key run uses only free lanes.

## Risks
- **Provider API churn** -> isolate per plugin; one breakage can't sink ingestion.
- **Workday bot-management** -> use the CXS JSON API (free, proven); protected tenants fall back to the aggregator, not scraping.
- **Dedup correctness across sources** -> the contract + trust order + tests.
- **Cost creep** -> per-source caps + yield backoff; free lanes are the floor.
- **n8n env sandbox** -> exactly why ingestion lives in the Python service.

## Critical files / components
- Service: `services/matcher/` (grows into discovery+matcher): `app.py` + new `providers/` (one module per source) + `db.py` (PG upsert/dedup/embed).
- DB: `db/schema.sql` (`jobs`, `companies` -- extend to the `JobRecord` contract).
- n8n master `kmQDCNypCfZbqwAW`: replace the ATS Poller logic with a schedule -> `/ingest` trigger; rewire `find` to cache-first + matcher (Sprint-6 wiring already in place).
- `docker/docker-compose.yml`: service env (PG creds + provider keys), schedule.
