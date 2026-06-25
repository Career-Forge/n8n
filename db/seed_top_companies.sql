-- ═══════════════════════════════════════════════════════════════
--  Coverage seed (June 21 2026) — 39 top companies, slugs VERIFIED live.
--  India-weighted to fix thin India/Bangalore coverage + global top names.
--  Apply:  docker exec -i careerforge_postgres psql -U careerforge -d careerforge < db/seed_top_companies.sql
--  Then run ingest (a few passes — ATS_DUE_LIMIT polls 25 boards/type/run).
--  Idempotent (ON CONFLICT). Tiers are seed defaults — edit company_tiers freely.
-- ═══════════════════════════════════════════════════════════════

-- ── registry boards (next_poll_at=now() so the next ingest polls them) ──
INSERT INTO companies (name, ats_type, slug, tier, is_active, next_poll_at, poll_interval) VALUES
  -- India-hiring (the coverage gap)
  ('PhonePe','greenhouse','phonepe','hot',true,now(),'6 hours'),
  ('Groww','greenhouse','groww','hot',true,now(),'6 hours'),
  ('Postman','greenhouse','postman','hot',true,now(),'6 hours'),
  ('Druva','greenhouse','druva','hot',true,now(),'6 hours'),
  ('Turing','greenhouse','turing','hot',true,now(),'6 hours'),
  ('slice','greenhouse','slice','hot',true,now(),'6 hours'),
  ('Meesho','lever','meesho','hot',true,now(),'6 hours'),
  ('CRED','lever','cred','hot',true,now(),'6 hours'),
  ('Zeta','lever','zeta','hot',true,now(),'6 hours'),
  ('MindTickle','lever','mindtickle','hot',true,now(),'6 hours'),
  ('Porter','lever','porter','hot',true,now(),'6 hours'),
  ('Navi','ashby','navi','hot',true,now(),'6 hours'),
  -- global top names
  ('Reddit','greenhouse','reddit','hot',true,now(),'6 hours'),
  ('Pinterest','greenhouse','pinterest','hot',true,now(),'6 hours'),
  ('Figma','greenhouse','figma','hot',true,now(),'6 hours'),
  ('Brex','greenhouse','brex','hot',true,now(),'6 hours'),
  ('Robinhood','greenhouse','robinhood','hot',true,now(),'6 hours'),
  ('Discord','greenhouse','discord','hot',true,now(),'6 hours'),
  ('Instacart','greenhouse','instacart','hot',true,now(),'6 hours'),
  ('GitLab','greenhouse','gitlab','hot',true,now(),'6 hours'),
  ('MongoDB','greenhouse','mongodb','hot',true,now(),'6 hours'),
  ('Elastic','greenhouse','elastic','hot',true,now(),'6 hours'),
  ('Twilio','greenhouse','twilio','hot',true,now(),'6 hours'),
  ('Dropbox','greenhouse','dropbox','hot',true,now(),'6 hours'),
  ('Affirm','greenhouse','affirm','hot',true,now(),'6 hours'),
  ('Rubrik','greenhouse','rubrik','hot',true,now(),'6 hours'),
  ('Gusto','greenhouse','gusto','hot',true,now(),'6 hours'),
  ('Asana','greenhouse','asana','hot',true,now(),'6 hours'),
  ('Samsara','greenhouse','samsara','hot',true,now(),'6 hours'),
  ('Verkada','greenhouse','verkada','hot',true,now(),'6 hours'),
  ('Snowflake','ashby','snowflake','hot',true,now(),'6 hours'),
  ('Notion','ashby','notion','hot',true,now(),'6 hours'),
  ('Plaid','ashby','plaid','hot',true,now(),'6 hours'),
  ('Confluent','ashby','confluent','hot',true,now(),'6 hours'),
  ('Ramp','ashby','ramp','hot',true,now(),'6 hours'),
  ('Cohere','ashby','cohere','hot',true,now(),'6 hours'),
  ('Perplexity','ashby','perplexity','hot',true,now(),'6 hours'),
  ('Harvey','ashby','harvey','hot',true,now(),'6 hours'),
  ('Mistral','lever','mistral','hot',true,now(),'6 hours')
ON CONFLICT (ats_type, slug) DO UPDATE SET name=EXCLUDED.name, tier='hot', is_active=true, next_poll_at=now();

-- ── desirability tiers (seed defaults — re-tier freely) ──
INSERT INTO company_tiers (name_norm, tier, canonical, notes) VALUES
  (cf_name_norm('PhonePe'),'A','PhonePe','India unicorn'),
  (cf_name_norm('Meesho'),'A','Meesho','India unicorn'),
  (cf_name_norm('CRED'),'A','CRED','India unicorn'),
  (cf_name_norm('Groww'),'A','Groww','India unicorn'),
  (cf_name_norm('Postman'),'A','Postman','India, global SaaS'),
  (cf_name_norm('Zeta'),'B','Zeta','India fintech'),
  (cf_name_norm('MindTickle'),'B','MindTickle','India SaaS'),
  (cf_name_norm('Druva'),'B','Druva','India/US SaaS'),
  (cf_name_norm('Turing'),'B','Turing','India/US'),
  (cf_name_norm('Navi'),'B','Navi','India fintech'),
  (cf_name_norm('slice'),'B','slice','India fintech'),
  (cf_name_norm('Porter'),'B','Porter','India logistics'),
  (cf_name_norm('Reddit'),'A','Reddit',NULL),
  (cf_name_norm('Pinterest'),'A','Pinterest',NULL),
  (cf_name_norm('Snowflake'),'A','Snowflake',NULL),
  (cf_name_norm('Figma'),'A','Figma',NULL),
  (cf_name_norm('Notion'),'A','Notion',NULL),
  (cf_name_norm('Plaid'),'A','Plaid',NULL),
  (cf_name_norm('Brex'),'A','Brex',NULL),
  (cf_name_norm('Robinhood'),'A','Robinhood',NULL),
  (cf_name_norm('Discord'),'A','Discord',NULL),
  (cf_name_norm('Instacart'),'A','Instacart',NULL),
  (cf_name_norm('GitLab'),'A','GitLab',NULL),
  (cf_name_norm('Confluent'),'A','Confluent',NULL),
  (cf_name_norm('MongoDB'),'A','MongoDB',NULL),
  (cf_name_norm('Elastic'),'A','Elastic',NULL),
  (cf_name_norm('Twilio'),'A','Twilio',NULL),
  (cf_name_norm('Dropbox'),'A','Dropbox',NULL),
  (cf_name_norm('Affirm'),'A','Affirm',NULL),
  (cf_name_norm('Ramp'),'A','Ramp',NULL),
  (cf_name_norm('Cohere'),'A','Cohere','AI lab'),
  (cf_name_norm('Perplexity'),'A','Perplexity','AI lab'),
  (cf_name_norm('Mistral'),'A','Mistral','AI lab'),
  (cf_name_norm('Harvey'),'A','Harvey','AI'),
  (cf_name_norm('Rubrik'),'A','Rubrik',NULL),
  (cf_name_norm('Gusto'),'A','Gusto',NULL),
  (cf_name_norm('Asana'),'A','Asana',NULL),
  (cf_name_norm('Samsara'),'A','Samsara',NULL),
  (cf_name_norm('Verkada'),'A','Verkada',NULL)
ON CONFLICT (name_norm) DO UPDATE SET tier=EXCLUDED.tier, canonical=EXCLUDED.canonical, notes=EXCLUDED.notes, updated_at=now();
