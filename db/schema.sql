-- ═══════════════════════════════════════════════════════════════
--  CareerForge ATS engine — Postgres + pgvector schema
--  Auto-runs on first boot via /docker-entrypoint-initdb.d/01_schema.sql
--  Idempotent (IF NOT EXISTS) so it is safe to re-apply by hand:
--    docker compose exec postgres psql -U careerforge -d careerforge -f /docker-entrypoint-initdb.d/01_schema.sql
--
--  Embedding model: Ollama bge-m3 → vector(1024). If you change the
--  embedding model, change EVERY vector(1024) below to match its dims
--  and rebuild the HNSW indexes.
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── companies — the polling registry ──────────────────────────
--  One row per (ats_type, slug) board. The poller selects rows whose
--  next_poll_at has passed, fetches that board, then advances next_poll_at.
CREATE TABLE IF NOT EXISTS companies (
  id                    BIGSERIAL PRIMARY KEY,
  name                  TEXT        NOT NULL,
  ats_type              TEXT        NOT NULL,   -- greenhouse|lever|ashby|workable|recruitee|personio|smartrecruiters|workday|...
  slug                  TEXT        NOT NULL,   -- board token / site / account id
  api_base              TEXT,                   -- optional override (smartrecruiters company id; workday "tenant|wdN|site")
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  poll_interval         INTERVAL    NOT NULL DEFAULT '6 hours',
  next_poll_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at        TIMESTAMPTZ,
  etag                  TEXT,                   -- HTTP caching where supported
  last_modified         TEXT,
  consecutive_failures  INT         NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ats_type, slug)
);

-- "which boards are due to poll" — the poller's hot query
CREATE INDEX IF NOT EXISTS idx_companies_due
  ON companies (next_poll_at)
  WHERE is_active;

-- ── jobs — the live cache (snapshot/diff target) ──────────────
--  board = ats_type:slug is denormalized here so the per-board liveness
--  close is a single  WHERE board = $1  with no join.
CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL PRIMARY KEY,
  company_id   BIGINT      REFERENCES companies(id) ON DELETE CASCADE,
  board        TEXT        NOT NULL,            -- ats_type:slug — scopes the liveness diff
  external_id  TEXT        NOT NULL,            -- ATS-native job id
  title        TEXT        NOT NULL,
  jd_text      TEXT        NOT NULL DEFAULT '',
  location     TEXT,
  remote       BOOLEAN,
  apply_url    TEXT        NOT NULL,
  posted_at    TIMESTAMPTZ,
  status       TEXT        NOT NULL DEFAULT 'active',  -- active | closed
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ,
  embedding    vector(1024),                    -- bge-m3, precomputed on ingest
  jd_tsv       tsvector GENERATED ALWAYS AS (
                 to_tsvector('english',
                   coalesce(title, '') || ' ' || coalesce(jd_text, ''))
               ) STORED,
  UNIQUE (board, external_id)                   -- upsert conflict target
);

CREATE INDEX IF NOT EXISTS idx_jobs_board_status   ON jobs (board, status);
CREATE INDEX IF NOT EXISTS idx_jobs_board_lastseen ON jobs (board, last_seen);   -- liveness diff
CREATE INDEX IF NOT EXISTS idx_jobs_posted         ON jobs (posted_at DESC);     -- recency
CREATE INDEX IF NOT EXISTS idx_jobs_active_posted  ON jobs (posted_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_jobs_tsv            ON jobs USING gin (jd_tsv);   -- keyword
CREATE INDEX IF NOT EXISTS idx_jobs_embedding                                    -- semantic (cosine)
  ON jobs USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── users / resumes / matches ─────────────────────────────────
--  Single-user today; these tables exist so the per-user swap later
--  is a query change, not a schema change.
CREATE TABLE IF NOT EXISTS users (
  tg_user_id  BIGINT      PRIMARY KEY,          -- Telegram user id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resumes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT      REFERENCES users(tg_user_id) ON DELETE CASCADE,
  doc_text    TEXT        NOT NULL DEFAULT '',  -- compact_views.scoring_profile
  embedding   vector(1024),
  is_primary  BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one primary résumé per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_resume_primary
  ON resumes (user_id)
  WHERE is_primary;

CREATE TABLE IF NOT EXISTS matches (
  user_id    BIGINT,
  job_id     BIGINT      REFERENCES jobs(id) ON DELETE CASCADE,
  resume_id  BIGINT      REFERENCES resumes(id) ON DELETE SET NULL,
  score      REAL,                              -- hybrid 0..1
  kw_score   REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_matches_user_score ON matches (user_id, score DESC);

-- ── tool_cost_log — per-tool-call cost visibility (Grafana) ───
--  One row per external API/LLM call; a Grafana Postgres datasource
--  dashboards spend by provider/day. Populated by Code nodes later.
CREATE TABLE IF NOT EXISTS tool_cost_log (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  workflow_id   TEXT,
  execution_id  TEXT,
  provider      TEXT NOT NULL,                  -- firecrawl | serper | openrouter | ollama | ...
  action        TEXT,                           -- scrape | search | llm:<model> | embed | ...
  units         NUMERIC,                        -- credits / queries / tokens
  unit_cost_usd NUMERIC,
  est_cost_usd  NUMERIC,
  meta          JSONB
);
CREATE INDEX IF NOT EXISTS idx_cost_ts       ON tool_cost_log (ts);
CREATE INDEX IF NOT EXISTS idx_cost_provider ON tool_cost_log (provider, ts);

-- ── R3 additions: probe funnel ─────────────────────────────────
--  tier: dream | probe | hot | warm | cold (promotion by match yield)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'probe';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS relevant_yield INT NOT NULL DEFAULT 0;

-- ── R7: company_intel — cached dossiers + health for match penalty ──
CREATE TABLE IF NOT EXISTS company_intel (
  company_key  TEXT PRIMARY KEY,
  dossier      JSONB NOT NULL,
  health_score INT,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── R8: company_writing_profiles — per-company resume/cover guidance ──
CREATE TABLE IF NOT EXISTS company_writing_profiles (
  company_key TEXT PRIMARY KEY,
  guidance    TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'seed',
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── S1: app_settings — generic single-user key/value config ──
--  Deterministic, out-of-git settings store (read by Code nodes via an
--  upstream Postgres node, since $env is unreliable in the JS task runner).
--  Holds: telegraph_token (S1), and the Apollo/Hunter daily call budget (S8).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════
--  Discovery overhaul (June 2026) — JobRecord contract + dedup/trust
--  Grows `jobs` from the registry-poller model (UNIQUE board:external_id,
--  every row tied to a companies row) into a multi-source cache: pluggable
--  providers (direct ATS, Workday CXS, aggregators, web) all upsert here,
--  deduped by a canonical key — highest-trust copy wins. Embeddings are
--  computed on ingest (kills the NULL-embedding pool starvation).
--  Idempotent: ADD COLUMN IF NOT EXISTS + guarded (WHERE … IS NULL) backfills.
-- ═══════════════════════════════════════════════════════════════

-- provider identity + denormalized company (off-registry sources have no companies row)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source          TEXT;    -- plugin: remoteok|workday|amazon|greenhouse|lever|ashby|fantastic|jsearch|...
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ats_type        TEXT;    -- greenhouse|lever|ashby|workday|… (NULL for pure aggregators)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_name    TEXT;    -- denormalized; company_id may be NULL for off-registry sources
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_domain  TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS url             TEXT;    -- canonical posting URL (apply_url may differ / redirect)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS employment_type TEXT;    -- full-time|contract|intern|…
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS seniority       TEXT;    -- intern|junior|mid|senior|staff|…
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS skills          TEXT[];  -- extracted on ingest (matcher vocab)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min      NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max      NUMERIC;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_currency TEXT;

-- dedup + trust: canonical key collapses the same job across sources; on a
-- collision the highest-trust copy wins (direct ATS/Workday > aggregator > web).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dedup_key TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS trust     SMALLINT NOT NULL DEFAULT 10;  -- 30 direct ATS, 25 workday, 20 aggregator, 10 web

-- off-registry sources carry no company_id (older schema already allows NULL; assert it)
ALTER TABLE jobs ALTER COLUMN company_id DROP NOT NULL;

-- the new global uniqueness is the dedup key; retire the board-scoped UNIQUE so the
-- same job from two sources collapses to one canonical row. Keep (board, external_id)
-- as a plain index — the per-board liveness diff still needs it.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_board_external_id_key;
CREATE INDEX        IF NOT EXISTS idx_jobs_board_external ON jobs (board, external_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedup          ON jobs (dedup_key) WHERE dedup_key IS NOT NULL;  -- upsert conflict target
CREATE INDEX        IF NOT EXISTS idx_jobs_source         ON jobs (source);

-- backfill existing rows: today's cache came entirely from the direct-ATS poller.
UPDATE jobs SET source   = split_part(board, ':', 1) WHERE source   IS NULL AND board IS NOT NULL;
UPDATE jobs SET ats_type = split_part(board, ':', 1) WHERE ats_type IS NULL AND board IS NOT NULL;
UPDATE jobs SET trust    = 30 WHERE board IS NOT NULL AND trust = 10;   -- existing = direct ATS
UPDATE jobs SET url      = apply_url WHERE url IS NULL AND apply_url IS NOT NULL;
UPDATE jobs j SET company_name = c.name
  FROM companies c WHERE j.company_id = c.id AND j.company_name IS NULL;
-- dedup_key backfill (collision-safe, two pass). Mirrors db.canonical_url():
-- strip scheme/www, query/fragment, trailing slash. Some legacy rows share a
-- GENERIC apply_url (e.g. a board search page) — those are NOT real dups, so
-- only URL keys that are unique across the table become 'url:' keys; the rest
-- fall back to the always-unique 'atsid:board:external_id'.
WITH canon AS (
  SELECT id, 'url:' || rtrim(regexp_replace(regexp_replace(lower(apply_url), '^https?://(www\.)?', ''), '[#?].*$', ''), '/') AS k
  FROM jobs WHERE apply_url IS NOT NULL AND apply_url <> ''
), uniq AS (
  SELECT k FROM canon GROUP BY k HAVING count(*) = 1
)
UPDATE jobs j SET dedup_key = c.k
  FROM canon c JOIN uniq u ON u.k = c.k
  WHERE j.id = c.id AND j.dedup_key IS NULL;

UPDATE jobs SET dedup_key = 'atsid:' || coalesce(board, '') || ':' || external_id
  WHERE dedup_key IS NULL;

-- ═══════════════════════════════════════════════════════════════
--  Sprint A (June 2026) — company DESIRABILITY tier for ranking
--  "How much do I want to work here", applied WORLDWIDE: MAANGO=S
--  override + pay×WLB (S best → D body-shop floor). Distinct from
--  companies.tier (the R3 probe-funnel promotion tier above).
--  Matched by company NAME — off-registry + web-lane jobs have no
--  companies FK — so it tiers EVERY job regardless of source. The
--  ranking multiplies rrf_score by the tier weight, so S surfaces
--  first among comparable matches (strong multiplier, not a hard sort).
--  Seed data lives in db/seed_dream_tier.sql (apply after this file).
-- ═══════════════════════════════════════════════════════════════

-- shared name normalizer — the seed and the ranking join BOTH call this, so
-- "Google", "Google LLC", "Alphabet Inc." collapse to the same key on both sides.
CREATE OR REPLACE FUNCTION cf_name_norm(s text) RETURNS text AS $$
  SELECT regexp_replace(
           regexp_replace(lower(coalesce(s,'')),
             '\y(inc|llc|ltd|limited|corp|corporation|plc|company|technologies|holdings|group|pbc|the)\y', '', 'g'),
           '[^a-z0-9]+', '', 'g')
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS company_tiers (
  name_norm  TEXT PRIMARY KEY,        -- cf_name_norm(company or alias)
  tier       CHAR(1) NOT NULL,        -- S | A | B | C | D (D = body-shop downrank)
  canonical  TEXT NOT NULL,           -- display name
  notes      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
