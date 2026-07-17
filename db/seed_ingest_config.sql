-- db/seed_ingest_config.sql -- one-time seed for the ATS Poller's ingest
-- title filter (see scripts/applied/s91_ingest_title_filter.js). Editable
-- anytime with a plain UPDATE afterward -- this is the STARTING vocabulary,
-- not a fixed list. ON CONFLICT DO NOTHING: seeds once, never clobbers a
-- later manual edit if this file is re-run.
-- NOT auto-run on boot (only schema.sql is mounted to docker-entrypoint-initdb.d).
-- Run manually: docker cp db/seed_ingest_config.sql careerforge_postgres:/tmp/seed.sql
--   && docker exec careerforge_postgres psql -U careerforge -d careerforge -f /tmp/seed.sql
--
-- mode: 'keywords' (filter by this list) | 'all' (disable filtering entirely).
-- cap_per_board: max jobs ingested per board per poll tick.
INSERT INTO app_settings (key, value) VALUES (
  'ingest_title_filter',
  '{
    "mode": "keywords",
    "cap_per_board": 50,
    "keywords": [
      "software engineer", "software developer", "swe", "sde", "developer",
      "frontend", "front end", "backend", "back end", "full stack", "fullstack",
      "mobile engineer", "ios", "android", "web engineer",
      "forward deployed", "solutions engineer", "solutions architect", "implementation engineer",
      "customer engineer", "deployment engineer", "field engineer", "sales engineer",
      "machine learning", "ml engineer", "ml", "ai", "artificial intelligence", "deep learning",
      "nlp", "llm", "gen ai", "genai", "generative", "computer vision",
      "data scientist", "data engineer", "data analyst", "data platform", "analytics engineer", "applied scientist",
      "research engineer", "research scientist",
      "devops", "mlops", "sre", "site reliability", "platform engineer", "infrastructure", "cloud engineer",
      "security engineer", "application security", "appsec",
      "qa engineer", "test engineer", "sdet",
      "embedded", "firmware", "systems engineer", "distributed systems",
      "database", "dba", "architect", "principal engineer", "staff engineer", "engineering manager", "tech lead"
    ]
  }'
) ON CONFLICT (key) DO NOTHING;
