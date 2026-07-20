-- ═══════════════════════════════════════════════════════════════
--  Migration 001 — applications (Mini App tracker)
--  Idempotent (IF NOT EXISTS / CREATE OR REPLACE), safe to re-apply.
--  Apply to the LIVE db by hand (schema.sql's auto-run is first-boot-only):
--    docker cp db/migrations/001_applications.sql careerforge_postgres:/tmp/m001.sql
--    docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/m001.sql
--  Also appended verbatim to db/schema.sql so a fresh install matches.
-- ═══════════════════════════════════════════════════════════════

-- ── cf_url_norm — the ONE cross-source dedup normalizer ────────
--  Shared by the miniapp API and the n8n "Record Tracked Application"
--  Postgres node (s132) so there is exactly one implementation, never a
--  JS/Python mirror pair to drift (the s99 lesson). Strips fragment,
--  scheme, "www.", default ports, trailing slash, and tracking params;
--  lowercases the host only (paths stay case-preserving — Lever/Ashby
--  ids are case-sensitive); keeps only sorted identity-bearing params.
CREATE OR REPLACE FUNCTION cf_url_norm(u TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE s TEXT; hostpart TEXT; pathpart TEXT; qs TEXT; kept TEXT[]; kv TEXT;
BEGIN
  IF u IS NULL OR btrim(u) = '' THEN RETURN NULL; END IF;
  s := regexp_replace(btrim(u), '#.*$', '');                    -- 1. strip fragment
  s := regexp_replace(s, '^[a-zA-Z][a-zA-Z0-9+.-]*://', '');    -- 2. strip scheme
  s := regexp_replace(s, '^www\.', '', 'i');                     -- 3. strip www.
  qs := NULLIF(split_part(s, '?', 2), '');
  s  := split_part(s, '?', 1);
  hostpart := lower(split_part(s, '/', 1));                      -- 4. lowercase host only
  hostpart := regexp_replace(hostpart, ':(80|443)$', '');        -- 5. strip default ports
  pathpart := CASE WHEN position('/' in s) > 0
              THEN regexp_replace(substr(s, position('/' in s)), '/+$', '')
              ELSE '' END;                                       -- 6. strip trailing slash
  kept := ARRAY[]::TEXT[];                                       -- 7. keep identity params only
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

-- ── applications — miniapp-owned tracker ────────────────────────
--  FastAPI (miniapp) writes directly; n8n's "Track Application" node
--  dual-writes on the bot-side `track` intent (s132) so both surfaces
--  land in the same table. user_id is the Telegram user id (owner) —
--  single-user today; the per-user swap later is a query change only,
--  same pattern as users/resumes/matches above.
CREATE TABLE IF NOT EXISTS applications (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT      NOT NULL,
  job_id         TEXT,                          -- CareerForge id ('<slug>-<ats_id>' | 'cache_<n>' | 'direct-…' | 'jdpaste-…') | NULL for a manual log
  url            TEXT,
  url_norm       TEXT,                          -- cf_url_norm(url) — the dedup key
  job_title      TEXT        NOT NULL DEFAULT '',
  company        TEXT        NOT NULL DEFAULT '',
  location       TEXT,
  source         TEXT        NOT NULL DEFAULT 'miniapp',  -- miniapp | bot | migration
  status         TEXT        NOT NULL DEFAULT 'saved'
                   CHECK (status IN ('saved','applied','interviewing','offer','rejected')),
  forge_score    NUMERIC,                       -- overall_score (0–10) at apply time
  score_detail   JSONB,                         -- full forge_score object, when available
  notes          TEXT,
  status_history JSONB       NOT NULL DEFAULT '[]'::jsonb,  -- [{from, to, at, via}]
  applied_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique indexes (not a table constraint) so a NULL job_id/url_norm
-- — a bare manual log with neither — never collides with anything.
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_jobid
  ON applications (user_id, job_id) WHERE job_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_urlnorm
  ON applications (user_id, url_norm) WHERE url_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_applications_user_status
  ON applications (user_id, status, updated_at DESC);
