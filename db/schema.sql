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
  ats_type              TEXT        NOT NULL,   -- greenhouse|lever|ashby|workable|recruitee|personio|smartrecruiters|workday|avature|...
  slug                  TEXT        NOT NULL,   -- board token / site / account id -- NOT globally unique on its own (see below)
  api_base              TEXT        NOT NULL DEFAULT '', -- tenant/override, e.g. workday "tenant.wdN", avature portal[/listing page]
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  poll_interval         INTERVAL    NOT NULL DEFAULT '6 hours',
  next_poll_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at        TIMESTAMPTZ,
  etag                  TEXT,                   -- HTTP caching where supported
  last_modified         TEXT,
  consecutive_failures  INT         NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Poller priority lane (dream/hot/warm/probe/cold/never_polled, see Select
  -- Due Companies) and self-growth yield tracking (Extract Registry
  -- Candidates) -- present in the live DB via earlier migrations, added here
  -- too so a fresh install matches observed reality.
  tier                  TEXT        NOT NULL DEFAULT 'probe',
  relevant_yield        INT         NOT NULL DEFAULT 0,
  -- s98/Phase B: 0-1 company-quality weight from data/reference/company_tiers.json
  -- (Fortune 500 + hand-curated MAANGO/fintech/startup overlay), seeded by
  -- scripts/seed_company_tier_weights.js. NULL = no match found (untiered).
  tier_weight           NUMERIC,
  -- s74: (ats_type, slug) alone is NOT enough -- Workday tenants routinely reuse
  -- generic site slugs ("External", "External_Career_Site"); api_base (the real
  -- tenant) is the actual disambiguator. A 2-column key here let 2 real seeds
  -- silently rename a different company's row in production before this fix.
  UNIQUE (ats_type, slug, api_base)
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
--  Holds: telegraph_token (S1), the Apollo/Hunter daily call budget (S8),
--  geo_reference (s86) — a JSON blob {countries:{ISO:[aliases]}, cities:{name:ISO}}
--  read via `value::jsonb` by "Load Geo Reference (Search/Apply)". Single source
--  of truth for country/city detection across the whole pipeline — grow
--  coverage by editing this row, never by adding a new hardcoded list in code.
--  Also: ingest_title_filter (s91) — the ATS Poller's title-relevance keyword
--  list + per-board cap, seeded by db/seed_ingest_config.sql (run once,
--  editable anytime via a plain UPDATE afterward).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings (key, value) VALUES ('geo_reference', '{"countries":{"US":["usa","u.s.a","u.s.a.","u.s.","united states","united states of america","america","new mexico"],"IN":["india"],"GB":["uk","u.k.","united kingdom","britain","england","scotland","wales","northern ireland"],"CA":["canada"],"AU":["australia"],"DE":["germany","deutschland"],"SG":["singapore"],"AE":["uae","united arab emirates","dubai","abu dhabi"],"NL":["netherlands","holland"],"FR":["france"],"IE":["ireland"],"NZ":["new zealand"],"BR":["brazil","brasil"],"MX":["mexico","méxico"],"SA":["saudi arabia","ksa","kingdom of saudi arabia"],"HK":["hong kong"],"NO":["norway"],"SE":["sweden"],"DK":["denmark"],"FI":["finland"],"CH":["switzerland","swiss"],"AT":["austria"]},"cities":{"new york":"US","san francisco":"US","seattle":"US","austin":"US","boston":"US","chicago":"US","los angeles":"US","san jose":"US","denver":"US","atlanta":"US","dallas":"US","houston":"US","washington":"US","miami":"US","portland":"US","hyderabad":"IN","bangalore":"IN","bengaluru":"IN","mumbai":"IN","pune":"IN","delhi":"IN","new delhi":"IN","gurgaon":"IN","gurugram":"IN","chennai":"IN","noida":"IN","kolkata":"IN","ahmedabad":"IN","london":"GB","manchester":"GB","edinburgh":"GB","birmingham":"GB","toronto":"CA","vancouver":"CA","montreal":"CA","ottawa":"CA","berlin":"DE","munich":"DE","frankfurt":"DE","hamburg":"DE","singapore":"SG","dublin":"IE","amsterdam":"NL","paris":"FR","sydney":"AU","melbourne":"AU","auckland":"NZ","sao paulo":"BR","são paulo":"BR","rio de janeiro":"BR","brasilia":"BR","belo horizonte":"BR","mexico city":"MX","guadalajara":"MX","monterrey":"MX","riyadh":"SA","jeddah":"SA","dammam":"SA","hong kong":"HK","oslo":"NO","stockholm":"SE","gothenburg":"SE","copenhagen":"DK","helsinki":"FI","zurich":"CH","zürich":"CH","geneva":"CH","basel":"CH","vienna":"AT"}}')
  ON CONFLICT (key) DO NOTHING;

-- ── Migration 001: applications (Mini App tracker) + cf_url_norm ──
-- See db/migrations/001_applications.sql for the full comment/rationale.
-- Kept byte-identical here so a fresh install matches a migrated one.
CREATE OR REPLACE FUNCTION cf_url_norm(u TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s TEXT; hostpart TEXT; pathpart TEXT; qs TEXT; kept TEXT[]; kv TEXT;
BEGIN
  IF u IS NULL OR btrim(u) = '' THEN RETURN NULL; END IF;
  s := regexp_replace(btrim(u), '#.*$', '');
  s := regexp_replace(s, '^[a-zA-Z][a-zA-Z0-9+.-]*://', '');
  s := regexp_replace(s, '^www\.', '', 'i');
  qs := NULLIF(split_part(s, '?', 2), '');
  s  := split_part(s, '?', 1);
  hostpart := lower(split_part(s, '/', 1));
  hostpart := regexp_replace(hostpart, ':(80|443)$', '');
  pathpart := CASE WHEN position('/' in s) > 0
              THEN regexp_replace(substr(s, position('/' in s)), '/+$', '')
              ELSE '' END;
  kept := ARRAY[]::TEXT[];
  IF qs IS NOT NULL THEN
    FOREACH kv IN ARRAY string_to_array(qs, '&') LOOP
      IF lower(split_part(kv, '=', 1)) IN
         ('gh_jid','jid','job_id','jobid','id','requisitionid','req_id','rid') THEN
        kept := kept || (lower(split_part(kv, '=', 1)) || '=' || split_part(kv, '=', 2));
      END IF;
    END LOOP;
    kept := (SELECT array_agg(x ORDER BY x) FROM unnest(kept) x);
  END IF;
  RETURN hostpart || pathpart ||
         CASE WHEN kept IS NOT NULL AND array_length(kept, 1) > 0
              THEN '?' || array_to_string(kept, '&') ELSE '' END;
END $$;

CREATE TABLE IF NOT EXISTS applications (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT      NOT NULL,
  job_id         TEXT,
  url            TEXT,
  url_norm       TEXT,
  job_title      TEXT        NOT NULL DEFAULT '',
  company        TEXT        NOT NULL DEFAULT '',
  location       TEXT,
  source         TEXT        NOT NULL DEFAULT 'miniapp',
  status         TEXT        NOT NULL DEFAULT 'saved'
                   CHECK (status IN ('saved','applied','interviewing','offer','rejected')),
  forge_score    NUMERIC,
  score_detail   JSONB,
  notes          TEXT,
  status_history JSONB       NOT NULL DEFAULT '[]'::jsonb,
  applied_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_jobid
  ON applications (user_id, job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_urlnorm
  ON applications (user_id, url_norm) WHERE url_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_applications_user_status
  ON applications (user_id, status, updated_at DESC);
