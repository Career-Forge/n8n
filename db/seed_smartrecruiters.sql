-- ═══════════════════════════════════════════════════════════════
--  SmartRecruiters cache-provider seed (P3a) — company-direct coverage.
--  Apply:  docker exec -i careerforge_postgres psql -U careerforge -d careerforge < db/seed_smartrecruiters.sql
--  Then run ingest (providers/ats.py SmartRecruiters() polls ats_type='smartrecruiters').
--
--  Every slug below is the public SmartRecruiters `companyIdentifier`, API-VERIFIED
--  live on 2026-06-28 via:
--    GET https://api.smartrecruiters.com/v1/companies/<slug>/postings?limit=1   (HTTP 200, totalFound>0)
--  and confirmed to carry engineering/tech roles (TITLE_RX targets) via ?q=engineer.
--  A bogus control slug returned HTTP 200 + totalFound=0, so totalFound>0 == real board.
--  No staffing firms / bodyshops. No company_tiers rows (this is coverage, not ranking).
--
--  P3a (verified 2026-06-28, ?q=engineer counts):
--    slug             totalFound   tech   notes
--    BoschGroup       4620         1494   global engineering (DE/IN/CN/US/…)
--    DeliveryHero     1117          165   global tech/product (EU/APAC/LATAM)
--    Experian          591          179   data/AI/cloud, worldwide
--    Wise              358          192   fintech eng/product, worldwide
--    Visa                5            3   small SR board, US software eng
--  P3d-a (verified 2026-06-30, first-page TITLE_RX matches on ?limit=100&offset=0):
--    WesternDigital    273            6   storage tech; "Senior AI & Automation Engineer","Principal AI Program Manager"
--    Continental      1047            8   automotive/software; "Backend Developer - Digital","Frontend Developer - Digital"
--    Wabtec            695            5   rail/industrial; "Electrical & Software Engineer","Designer, web fullstack"
--    AveryDennison     396            4   materials/labeling; "Principal Software Engineer","Data Analyst - Demand & Capacity"
--  Rejected this pass (probed, not seeded): Square/Wolt/Zalando/Celonis/Statkraft/PublicisSapient/Glovo/
--    Bolt/FlixBus/Scout24/HelloFresh/Trivago/Mollie/Criteo/Block/Equinix/Biogen/... -> totalFound=0
--    (not on SR / wrong identifier);  ASICS(30) & PublicStorage(613) -> 0 TITLE_RX matches (retail/storage).
-- ═══════════════════════════════════════════════════════════════

INSERT INTO companies (name, ats_type, slug, tier, is_active, next_poll_at, poll_interval) VALUES
  ('Bosch',         'smartrecruiters', 'BoschGroup',   'hot', true, now(), '6 hours'),
  ('Delivery Hero', 'smartrecruiters', 'DeliveryHero', 'hot', true, now(), '6 hours'),
  ('Experian',      'smartrecruiters', 'Experian',     'hot', true, now(), '6 hours'),
  ('Wise',          'smartrecruiters', 'Wise',         'hot', true, now(), '6 hours'),
  ('Visa',          'smartrecruiters', 'Visa',         'hot', true, now(), '6 hours'),
  -- P3d-a additions (verified 2026-06-30; global product/industrial-tech direct employers, no bodyshops)
  ('Western Digital', 'smartrecruiters', 'WesternDigital', 'hot', true, now(), '6 hours'),
  ('Continental',     'smartrecruiters', 'Continental',    'hot', true, now(), '6 hours'),
  ('Wabtec',          'smartrecruiters', 'Wabtec',         'hot', true, now(), '6 hours'),
  ('Avery Dennison',  'smartrecruiters', 'AveryDennison',  'hot', true, now(), '6 hours')
ON CONFLICT (ats_type, slug) DO UPDATE SET name=EXCLUDED.name, is_active=true, next_poll_at=now();
