-- ═══════════════════════════════════════════════════════════════
--  Big-tech on STANDARD ATS -- registry seed (June 2026). These companies run
--  on Greenhouse/Ashby (already handled by services/matcher/providers/ats.py),
--  so they need rows here, not code. Slugs + counts CXS-verified live. Mirrors
--  seed_top_companies.sql. Idempotent. Apply:
--    docker exec -i careerforge_postgres psql -U careerforge -d careerforge < db/seed_bigtech.sql
--  (Netflix/Uber/ByteDance/TikTok are CUSTOM ATS -> their own providers, not here.
--   Tesla/Wellfound are bot-walled -> skipped. Snowflake already in seed_top_companies.sql.)
-- ═══════════════════════════════════════════════════════════════

INSERT INTO companies (name, ats_type, slug, tier, is_active, next_poll_at, poll_interval) VALUES
  ('SpaceX','greenhouse','spacex','hot',true,now(),'6 hours'),
  ('Databricks','greenhouse','databricks','hot',true,now(),'6 hours'),
  ('Stripe','greenhouse','stripe','hot',true,now(),'6 hours'),
  ('Airbnb','greenhouse','airbnb','hot',true,now(),'6 hours')
ON CONFLICT (ats_type, slug) DO UPDATE SET name=EXCLUDED.name, tier='hot', is_active=true, next_poll_at=now();

INSERT INTO company_tiers (name_norm, tier, canonical, notes) VALUES
  (cf_name_norm('SpaceX'),'S','SpaceX','aerospace dream-tier'),
  (cf_name_norm('Databricks'),'A','Databricks','data/AI platform'),
  (cf_name_norm('Stripe'),'S','Stripe','fintech dream-tier'),
  (cf_name_norm('Airbnb'),'A','Airbnb',NULL)
ON CONFLICT (name_norm) DO UPDATE SET tier=EXCLUDED.tier, canonical=EXCLUDED.canonical, notes=EXCLUDED.notes, updated_at=now();
