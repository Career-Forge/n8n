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
