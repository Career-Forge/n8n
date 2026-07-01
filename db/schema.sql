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

-- ═══════════════════════════════════════════════════════════════
--  L0 (June 2026) — dynamic, WORLDWIDE location resolution
--  Kills the hardcoded 13-city LOC_SYN map in the find pipeline. Location
--  becomes a runtime query axis resolved against a GeoNames gazetteer:
--    free-text place  --cf_resolve_location()-->  (lat, lng, country_iso)
--  then an earthdistance radius gate does the geography. Work-mode
--  (onsite|hybrid|remote + allowed_countries) is the SECOND, independent
--  axis, classified at ingest. All additive + idempotent. Gazetteer rows
--  load from db/seed_geonames.sql (generated by scripts/gen_geonames_seed.js;
--  apply after this file). See plan: dynamic location + seniority, L0.
-- ═══════════════════════════════════════════════════════════════

-- earthdistance (built on cube) gives ll_to_earth / earth_box / earth_distance
-- — a GiST-indexable spherical radius with NO PostGIS image dependency. unaccent
-- folds diacritics so "São Paulo"/"Zürich" resolve from ASCII input. All three
-- ship in the standard pgvector/pgvector:pg17 contrib set (same clone story as
-- vector/pg_trgm above — if any CREATE EXTENSION fails, the image lacks contrib).
CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- ── geo_places — GeoNames gazetteer (the worldwide place index) ──
--  One row per populated place. name_norm is the lookup key: unaccent+lower,
--  non-alnum collapsed (same shape cf_resolve_location computes for a query, so
--  they compare equal). Loaded via db/seed_geonames.sql.
CREATE TABLE IF NOT EXISTS geo_places (
  geonameid    BIGINT PRIMARY KEY,
  name         TEXT NOT NULL,             -- canonical display name
  name_norm    TEXT NOT NULL,             -- unaccent(lower(name)) alnum-collapsed
  country_iso  CHAR(2) NOT NULL,
  admin1       TEXT,                       -- state/region code (disambiguation/display)
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  population   BIGINT NOT NULL DEFAULT 0,  -- ties resolve to the most-populous place
  feature_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_geo_places_norm      ON geo_places (name_norm);
CREATE INDEX IF NOT EXISTS idx_geo_places_norm_trgm ON geo_places USING gin (name_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_geo_places_pop       ON geo_places (population DESC);

-- ── geo_aliases — alternate names ("Bengaluru"->Bangalore, "NYC"->New York) ──
--  Many alias rows per place (from the GeoNames alternatenames column, folded
--  to ASCII; non-Latin / empty / name-identical aliases are dropped at gen time).
CREATE TABLE IF NOT EXISTS geo_aliases (
  alias_norm TEXT   NOT NULL,
  geonameid  BIGINT NOT NULL REFERENCES geo_places(geonameid) ON DELETE CASCADE,
  PRIMARY KEY (alias_norm, geonameid)
);
CREATE INDEX IF NOT EXISTS idx_geo_aliases_norm      ON geo_aliases (alias_norm);
CREATE INDEX IF NOT EXISTS idx_geo_aliases_norm_trgm ON geo_aliases USING gin (alias_norm gin_trgm_ops);

-- ── geo_countries — country name/code -> ISO-2 ──
--  Jobs whose location is a bare country ("United Kingdom", "Remote, US") have no
--  city to resolve; this lets cf_resolve_location still return the right country
--  (country-level, no coords). Mirrors services/matcher/geo.py COUNTRY_ISO. Small +
--  static, so seeded inline here (idempotent).
CREATE TABLE IF NOT EXISTS geo_countries (name_norm TEXT PRIMARY KEY, iso CHAR(2) NOT NULL);
-- Full country names + ONLY the safe short forms (us/gb/uk). Bare 2-letter ISO codes are
-- deliberately excluded -- they collide with US state codes ("CA"=California vs Canada,
-- "IN"=Indiana vs India, "DE"=Delaware vs Germany), which would mis-country US jobs.
INSERT INTO geo_countries (name_norm, iso) VALUES
  ('usa','US'),('unitedstates','US'),('unitedstatesofamerica','US'),('america','US'),('us','US'),
  ('uk','GB'),('unitedkingdom','GB'),('england','GB'),('britain','GB'),('greatbritain','GB'),
  ('scotland','GB'),('wales','GB'),('gb','GB'),
  ('india','IN'),('bharat','IN'),
  ('canada','CA'),('australia','AU'),('germany','DE'),('deutschland','DE'),
  ('france','FR'),('ireland','IE'),('netherlands','NL'),('holland','NL'),
  ('spain','ES'),('italy','IT'),('poland','PL'),('portugal','PT'),
  ('sweden','SE'),('switzerland','CH'),('singapore','SG'),
  ('japan','JP'),('china','CN'),('brazil','BR'),('mexico','MX'),
  ('israel','IL'),('uae','AE'),('unitedarabemirates','AE'),
  ('newzealand','NZ'),('southafrica','ZA'),('philippines','PH'),
  ('indonesia','ID'),('vietnam','VN'),('argentina','AR'),
  ('colombia','CO'),('chile','CL'),('nigeria','NG'),('egypt','EG'),
  ('turkey','TR'),('ukraine','UA'),('romania','RO'),('austria','AT'),
  ('belgium','BE'),('denmark','DK'),('finland','FI'),('norway','NO'),
  ('greece','GR'),('czechia','CZ'),('czechrepublic','CZ'),('hungary','HU'),
  ('southkorea','KR'),('korea','KR'),('hongkong','HK'),('taiwan','TW'),
  ('malaysia','MY'),('thailand','TH'),('saudiarabia','SA'),
  ('kenya','KE'),('pakistan','PK'),('bangladesh','BD'),('srilanka','LK'),
  -- ISO-3 alpha codes (Workday "USA"/"IND"/"GBR" location strings). SAFE: 3 letters
  -- never collide with US state codes. Word-like ones (can/are/nor) omitted -- those
  -- countries still resolve via full name / 2-letter safe form.
  ('ind','IN'),('gbr','GB'),('aus','AU'),('deu','DE'),('fra','FR'),('irl','IE'),
  ('nld','NL'),('esp','ES'),('ita','IT'),('pol','PL'),('prt','PT'),('swe','SE'),
  ('che','CH'),('sgp','SG'),('jpn','JP'),('chn','CN'),('bra','BR'),('mex','MX'),
  ('isr','IL'),('nzl','NZ'),('zaf','ZA'),('phl','PH'),('idn','ID'),('vnm','VN'),
  ('arg','AR'),('col','CO'),('chl','CL'),('nga','NG'),('egy','EG'),('tur','TR'),
  ('ukr','UA'),('rou','RO'),('aut','AT'),('bel','BE'),('dnk','DK'),('fin','FI'),
  ('grc','GR'),('cze','CZ'),('hun','HU'),('kor','KR'),('hkg','HK'),('twn','TW'),
  ('mys','MY'),('tha','TH'),('sau','SA'),('ken','KE'),('pak','PK'),('bgd','BD'),
  ('lka','LK')
ON CONFLICT (name_norm) DO NOTHING;

-- ── cf_resolve_location — free-text place -> canonical place ──
--  Mirrors cf_name_norm's normalize-then-match discipline, but reads tables so
--  it is STABLE (not IMMUTABLE) — it cannot be indexed; we index ll_to_earth()
--  on the RESOLVED jobs columns instead. Resolution order (best wins; population
--  breaks ties at every step): exact name_norm -> alias -> trigram-fuzzy.
--  country_hint (the query's parsed country) disambiguates same-name places
--  (Cambridge US vs UK, the many Springfields). Returns 0 or 1 row.
CREATE OR REPLACE FUNCTION cf_resolve_location(q text, country_hint text DEFAULT NULL)
RETURNS TABLE(geonameid bigint, lat double precision, lng double precision,
              country_iso char(2), matched text, population bigint) AS $$
  WITH cseg AS (
    -- country candidate segments: split on delimiters [,;/|>:()-] (Workday "United
    -- States-Arizona-Chandler", "United States > Austin", "United States (Remote)")
    -- UNION whitespace tokens (3-letter ISO "IND BNGL FL2-3 TWR 3"). Bare 2-letter
    -- codes stay excluded (per geo_countries) so "Menlo Park, CA" doesn't -> Canada.
    SELECT unnest(regexp_split_to_array(coalesce(q,''), '[,;/|>:()-]')) AS seg
    UNION ALL
    SELECT unnest(regexp_split_to_array(coalesce(q,''), '\s+')) AS seg
  ),
  norm AS (
    SELECT regexp_replace(unaccent(lower(coalesce(split_part(q, ',', 1), ''))),
                          '[^a-z0-9]+', '', 'g') AS k,
           COALESCE(
             nullif(upper(trim(coalesce(country_hint, ''))), ''),
             (SELECT gc.iso FROM cseg s
              JOIN geo_countries gc ON gc.name_norm = regexp_replace(unaccent(lower(trim(s.seg))), '[^a-z0-9]+', '', 'g')
              LIMIT 1)
           ) AS cc
  ),
  cand AS (
    SELECT p.geonameid, p.lat, p.lng, p.country_iso, p.name AS matched, p.population,
           1 AS pri, 1.0::real AS sim
    FROM geo_places p, norm n
    WHERE p.name_norm = n.k AND n.k <> '' AND (n.cc IS NULL OR p.country_iso = n.cc)
    UNION ALL
    SELECT p.geonameid, p.lat, p.lng, p.country_iso, p.name, p.population,
           2 AS pri, 1.0::real AS sim
    FROM geo_aliases a JOIN geo_places p ON p.geonameid = a.geonameid, norm n
    WHERE a.alias_norm = n.k AND n.k <> '' AND (n.cc IS NULL OR p.country_iso = n.cc)
    UNION ALL
    SELECT p.geonameid, p.lat, p.lng, p.country_iso, p.name, p.population,
           3 AS pri, similarity(p.name_norm, n.k) AS sim
    FROM geo_places p, norm n
    WHERE n.k <> '' AND p.name_norm % n.k AND similarity(p.name_norm, n.k) >= 0.45
      AND (n.cc IS NULL OR p.country_iso = n.cc)
    UNION ALL
    -- fuzzy over aliases too, so a typo of an aliased name ("Banglore"->bangalore) resolves.
    -- 0.45 floor: keeps real typos (banglore~bangalore 0.58) but rejects junk input
    -- ("remote","anywhere" peak ~0.33 against random places) so non-places resolve to NULL.
    SELECT p.geonameid, p.lat, p.lng, p.country_iso, p.name, p.population,
           3 AS pri, similarity(a.alias_norm, n.k) AS sim
    FROM geo_aliases a JOIN geo_places p ON p.geonameid = a.geonameid, norm n
    WHERE n.k <> '' AND a.alias_norm % n.k AND similarity(a.alias_norm, n.k) >= 0.45
      AND (n.cc IS NULL OR p.country_iso = n.cc)
    UNION ALL
    -- country-name fallback (no city matched): scans the delimiter + whitespace segments
    SELECT NULL::bigint, NULL::double precision, NULL::double precision, gc.iso, gc.name_norm, 0::bigint,
           4 AS pri, 1.0::real AS sim
    FROM cseg s
    JOIN geo_countries gc ON gc.name_norm = regexp_replace(unaccent(lower(trim(s.seg))), '[^a-z0-9]+', '', 'g'), norm n
    WHERE (n.cc IS NULL OR gc.iso = n.cc)
    UNION ALL
    -- pri 5: bare US state code -> US ("IN - Work from home" = Indiana). BELOW city/country matches
    -- (so "Bangalore, IN" -> India via pri1). COLLISION: bare "IN"/"TN" -> US, not India/Tamil Nadu;
    -- India jobs carry a city or the full name "India". country_hint overrides when needed.
    SELECT NULL::bigint, NULL::double precision, NULL::double precision, 'US'::char(2), 'us-state'::text, 0::bigint,
           5 AS pri, 1.0::real AS sim
    FROM cseg s, norm n
    WHERE n.cc IS NULL
      AND upper(trim(s.seg)) IN ('AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN',
        'IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC',
        'ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC')
  )
  SELECT geonameid, lat, lng, country_iso, matched, population
  FROM cand
  ORDER BY pri, sim DESC, population DESC
  LIMIT 1
$$ LANGUAGE sql STABLE;

-- ── jobs: geo columns (resolved at ingest by services/matcher/db.py) ──
--  STRICTLY ADDITIVE. Raw `location` is UNTOUCHED — it feeds dedup_key and the
--  embedding blob, so re-normalizing it there would fork dedup / churn vectors.
--  axis 1 (place): lat/lng/country_iso/geonameid. axis 2 (work-mode):
--  workplace_type + allowed_countries ([] = worldwide-remote, bypasses radius).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lat               DOUBLE PRECISION;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lng               DOUBLE PRECISION;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS country_iso       CHAR(2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS geonameid         BIGINT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS workplace_type    TEXT;     -- onsite | hybrid | remote
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS allowed_countries TEXT[];   -- remote eligibility; [] = worldwide

-- radius gate: GiST over the earth-point of the resolved coords (ll_to_earth is
-- IMMUTABLE, so it is index-safe). earth_box(center,r) @> ll_to_earth(j.lat,j.lng)
-- becomes an index scan; earth_distance() gives the exact post-filter + proximity.
CREATE INDEX IF NOT EXISTS idx_jobs_geo
  ON jobs USING gist (ll_to_earth(lat, lng))
  WHERE lat IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_country   ON jobs (country_iso);
CREATE INDEX IF NOT EXISTS idx_jobs_workplace ON jobs (workplace_type);

-- ── cf_close_stale_jobs — per-board job-level liveness diff ──
--  Closes active jobs that dropped out of their board's feed. The board's most
--  recent last_seen = its latest successful poll; a job trailing that by > rel_grace
--  (and itself > abs_floor old) was dropped -> close. hard_age closes jobs on boards
--  that stopped polling entirely. SELF-HEALING: a reappearing job is reactivated by
--  the upsert ON CONFLICT (status='active'). Called after every ingest (db.close_stale_jobs).
CREATE OR REPLACE FUNCTION cf_close_stale_jobs(
  rel_grace interval DEFAULT interval '18 hours',   -- trail board's latest poll by this -> dropped (~3 missed polls on a 6h board)
  abs_floor interval DEFAULT interval '12 hours',   -- never close anything younger than this
  hard_age  interval DEFAULT interval '21 days'     -- absolute backstop for boards that stopped polling
) RETURNS integer AS $$
  WITH grp AS (
    SELECT COALESCE(board, source) AS g, max(last_seen) AS gmax
    FROM jobs WHERE status='active' GROUP BY COALESCE(board, source)
  ),
  upd AS (
    UPDATE jobs j SET status='closed', closed_at=now()
    FROM grp
    WHERE COALESCE(j.board, j.source) = grp.g AND j.status='active'
      AND (
        (j.last_seen < grp.gmax - rel_grace AND j.last_seen < now() - abs_floor)
        OR j.last_seen < now() - hard_age
      )
    RETURNING 1
  )
  SELECT count(*)::int FROM upd;
$$ LANGUAGE sql;
