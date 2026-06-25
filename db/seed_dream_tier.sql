-- ═══════════════════════════════════════════════════════════════
--  Sprint A seed — desirability tier map + verified dream-tier boards
--  Apply AFTER db/schema.sql (needs cf_name_norm + company_tiers + companies).
--  This file is NOT mounted into the container, so pipe it over stdin:
--    docker exec -i careerforge_postgres psql -U careerforge -d careerforge < db/seed_dream_tier.sql
--  Idempotent: ON CONFLICT upserts, so re-applying is safe.
--
--  Tier rubric (user-owned — edit freely):
--   S = MAANGO (always, brand=career capital) OR high pay + good WLB
--   A = above-avg pay, OR great pay + brutal WLB (Amazon is the anchor)
--   B = average pay        C = market standard
--   D = IT body-shop (downranked hard, never hidden)
--  name_norm is computed by cf_name_norm() so every alias collapses correctly.
-- ═══════════════════════════════════════════════════════════════

-- ── S-tier ────────────────────────────────────────────────────
INSERT INTO company_tiers (name_norm, tier, canonical, notes) VALUES
  -- MAANGO (pinned S regardless of WLB)
  (cf_name_norm('Google'),'S','Google','MAANGO'),
  (cf_name_norm('Alphabet'),'S','Google','MAANGO'),
  (cf_name_norm('Google DeepMind'),'S','Google','MAANGO'),
  (cf_name_norm('DeepMind'),'S','Google','MAANGO'),
  (cf_name_norm('Waymo'),'S','Google','MAANGO'),
  (cf_name_norm('Verily'),'S','Google','MAANGO'),
  (cf_name_norm('Meta'),'S','Meta','MAANGO'),
  (cf_name_norm('Meta Platforms'),'S','Meta','MAANGO'),
  (cf_name_norm('Facebook'),'S','Meta','MAANGO'),
  (cf_name_norm('Instagram'),'S','Meta','MAANGO'),
  (cf_name_norm('Reality Labs'),'S','Meta','MAANGO'),
  (cf_name_norm('Microsoft'),'S','Microsoft','MAANGO'),
  (cf_name_norm('Apple'),'S','Apple','MAANGO'),
  (cf_name_norm('Anthropic'),'S','Anthropic','MAANGO'),
  (cf_name_norm('Netflix'),'S','Netflix','MAANGO'),
  (cf_name_norm('Oracle'),'S','Oracle','MAANGO'),
  (cf_name_norm('OpenAI'),'S','OpenAI','MAANGO'),
  -- high pay + good WLB
  (cf_name_norm('LinkedIn'),'S','LinkedIn','high pay + strong WLB'),
  (cf_name_norm('Airbnb'),'S','Airbnb','top-of-market pay + good WLB'),
  (cf_name_norm('Jane Street'),'S','Jane Street','elite pay + good WLB for finance')
ON CONFLICT (name_norm) DO UPDATE SET tier=EXCLUDED.tier, canonical=EXCLUDED.canonical, notes=EXCLUDED.notes, updated_at=now();

-- ── A-tier ────────────────────────────────────────────────────
INSERT INTO company_tiers (name_norm, tier, canonical, notes) VALUES
  (cf_name_norm('Amazon'),'A','Amazon','great pay, brutal WLB (the A anchor)'),
  (cf_name_norm('Amazon Web Services'),'A','Amazon',NULL),
  (cf_name_norm('AWS'),'A','Amazon',NULL),
  (cf_name_norm('Stripe'),'A','Stripe',NULL),
  (cf_name_norm('Databricks'),'A','Databricks',NULL),
  (cf_name_norm('D.E. Shaw'),'A','D.E. Shaw',NULL),
  (cf_name_norm('DESCO'),'A','D.E. Shaw',NULL),
  (cf_name_norm('Citadel'),'A','Citadel',NULL),
  (cf_name_norm('Citadel Securities'),'A','Citadel',NULL),
  (cf_name_norm('Citadel Investment Group'),'A','Citadel',NULL),
  (cf_name_norm('Two Sigma'),'A','Two Sigma',NULL),
  (cf_name_norm('Two Sigma Investments'),'A','Two Sigma',NULL),
  (cf_name_norm('Palantir'),'A','Palantir',NULL),
  (cf_name_norm('Coinbase'),'A','Coinbase',NULL),
  (cf_name_norm('Coinbase Global'),'A','Coinbase',NULL),
  (cf_name_norm('Spotify'),'A','Spotify',NULL),
  (cf_name_norm('Datadog'),'A','Datadog',NULL),
  (cf_name_norm('NVIDIA'),'A','NVIDIA','seed default — re-tier if you disagree'),
  (cf_name_norm('Salesforce'),'A','Salesforce','seed default'),
  (cf_name_norm('Uber'),'A','Uber','seed default'),
  (cf_name_norm('Snap'),'A','Snap','seed default'),
  (cf_name_norm('Snapchat'),'A','Snap',NULL),
  (cf_name_norm('DoorDash'),'A','DoorDash','seed default'),
  (cf_name_norm('Tesla'),'A','Tesla','great pay, brutal WLB'),
  (cf_name_norm('ByteDance'),'A','ByteDance','seed default'),
  (cf_name_norm('TikTok'),'A','ByteDance',NULL)
ON CONFLICT (name_norm) DO UPDATE SET tier=EXCLUDED.tier, canonical=EXCLUDED.canonical, notes=EXCLUDED.notes, updated_at=now();

-- ── B-tier ────────────────────────────────────────────────────
INSERT INTO company_tiers (name_norm, tier, canonical, notes) VALUES
  (cf_name_norm('Cloudflare'),'B','Cloudflare',NULL),
  (cf_name_norm('Lyft'),'B','Lyft',NULL)
ON CONFLICT (name_norm) DO UPDATE SET tier=EXCLUDED.tier, canonical=EXCLUDED.canonical, notes=EXCLUDED.notes, updated_at=now();

-- ── D-tier — IT body-shops (downranked, never hidden) ─────────
INSERT INTO company_tiers (name_norm, tier, canonical, notes) VALUES
  (cf_name_norm('Tata Consultancy Services'),'D','TCS','body-shop'),
  (cf_name_norm('TCS'),'D','TCS','body-shop'),
  (cf_name_norm('Infosys'),'D','Infosys','body-shop'),
  (cf_name_norm('Infosys BPM'),'D','Infosys','body-shop'),
  (cf_name_norm('Wipro'),'D','Wipro','body-shop'),
  (cf_name_norm('Cognizant'),'D','Cognizant','body-shop'),
  (cf_name_norm('CTS'),'D','Cognizant','body-shop'),
  (cf_name_norm('Capgemini'),'D','Capgemini','body-shop'),
  (cf_name_norm('HCL Technologies'),'D','HCLTech','body-shop'),
  (cf_name_norm('HCLTech'),'D','HCLTech','body-shop'),
  (cf_name_norm('Tech Mahindra'),'D','Tech Mahindra','body-shop'),
  (cf_name_norm('Accenture'),'D','Accenture','body-shop'),
  (cf_name_norm('LTIMindtree'),'D','LTIMindtree','body-shop'),
  (cf_name_norm('Mindtree'),'D','LTIMindtree','body-shop'),
  (cf_name_norm('L&T Infotech'),'D','LTIMindtree','body-shop'),
  (cf_name_norm('Mphasis'),'D','Mphasis','body-shop'),
  (cf_name_norm('Hexaware'),'D','Hexaware','body-shop'),
  (cf_name_norm('Coforge'),'D','Coforge','body-shop'),
  (cf_name_norm('NIIT Technologies'),'D','Coforge','body-shop'),
  (cf_name_norm('Persistent Systems'),'D','Persistent','body-shop'),
  (cf_name_norm('Zensar'),'D','Zensar','body-shop'),
  (cf_name_norm('Syntel'),'D','Syntel','body-shop'),
  (cf_name_norm('EPAM'),'D','EPAM','body-shop'),
  (cf_name_norm('Virtusa'),'D','Virtusa','body-shop'),
  (cf_name_norm('Conduent'),'D','Conduent','body-shop'),
  (cf_name_norm('DXC Technology'),'D','DXC','body-shop'),
  (cf_name_norm('CGI'),'D','CGI','body-shop'),
  (cf_name_norm('ManpowerGroup'),'D','ManpowerGroup','staffing'),
  (cf_name_norm('Randstad'),'D','Randstad','staffing'),
  (cf_name_norm('Kforce'),'D','Kforce','staffing'),
  (cf_name_norm('TEKsystems'),'D','TEKsystems','staffing')
ON CONFLICT (name_norm) DO UPDATE SET tier=EXCLUDED.tier, canonical=EXCLUDED.canonical, notes=EXCLUDED.notes, updated_at=now();

-- ── verified dream-tier boards → polling registry (worldwide) ──
--  Only slugs VERIFIED live on 2026-06-20 (Greenhouse 10, Lever 2, Ashby 1).
--  companies.tier='dream' marks them priority in the R3 probe funnel.
--  next_poll_at=now() so the next /ingest picks them up immediately.
INSERT INTO companies (name, ats_type, slug, tier, is_active, next_poll_at, poll_interval) VALUES
  ('Jane Street','greenhouse','janestreet','dream',true,now(),'6 hours'),
  ('Stripe','greenhouse','stripe','dream',true,now(),'6 hours'),
  ('Cloudflare','greenhouse','cloudflare','dream',true,now(),'6 hours'),
  ('Coinbase','greenhouse','coinbase','dream',true,now(),'6 hours'),
  ('Databricks','greenhouse','databricks','dream',true,now(),'6 hours'),
  ('Anthropic','greenhouse','anthropic','dream',true,now(),'6 hours'),
  ('Airbnb','greenhouse','airbnb','dream',true,now(),'6 hours'),
  ('Datadog','greenhouse','datadog','dream',true,now(),'6 hours'),
  ('LinkedIn','greenhouse','linkedin','dream',true,now(),'6 hours'),
  ('Lyft','greenhouse','lyft','dream',true,now(),'6 hours'),
  ('Spotify','lever','spotify','dream',true,now(),'6 hours'),
  ('Palantir','lever','palantir','dream',true,now(),'6 hours'),
  ('OpenAI','ashby','openai','dream',true,now(),'6 hours')
ON CONFLICT (ats_type, slug) DO UPDATE SET
  name=EXCLUDED.name, tier='dream', is_active=true, next_poll_at=now();
