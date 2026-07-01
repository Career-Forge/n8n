-- ═══════════════════════════════════════════════════════════════
--  Personio cache-provider seed (P3b) -- EU/DACH company-direct coverage.
--  Apply:  docker exec -i careerforge_postgres psql -U careerforge -d careerforge < db/seed_personio.sql
--  Then run ingest (providers/personio.py polls ats_type='personio').
--
--  Every tenant below is FEED-VERIFIED live on 2026-06-30 via:
--    GET {api_base}/xml?language=en   (HTTP 200, XML root <workzag-jobs>, positions>0)
--  api_base is the VERIFIED origin -- we never guess .de vs .com (provider fails a row
--  with no usable api_base rather than guessing). Company-direct employers only; no
--  staffing/bodyshops/consultancies. No company_tiers rows (coverage, not ranking).
--
--    tenant        api_base                               positions   sample title
--    personio      https://personio.jobs.personio.de      ~1          "Staff Software Engineer, Data Platform"
--    alasco        https://alasco.jobs.personio.de         ~11         "Backend Engineer"
--    wandelbots    https://wandelbots.jobs.personio.de     ~5          "Backend Engineer (gn) with Cloud Know-How"
--    tado          https://tado.jobs.personio.de           ~1          (verified feed; smart-home employer)
--
--  P3d-b expansion audit (2026-06-30): NO new tenants added -- none cleared the bar.
--    Reachable feeds were non-tech (0 TITLE_RX matches): finway(1 pos), everphone(6), gridfuse(2);
--    getsafe -> 404 on both .de/.com (not on Personio).
--    High-value tech candidates (deepl, komoot, enpal, urban-sports-club, forto, taxfix,
--    cargoone, scoutbee) returned HTTP 429 on the shared *.jobs.personio.* feed across
--    multiple spaced attempts -> INCONCLUSIVE, so NOT seeded (verify-or-skip; never guess).
--    Re-probe slowly in a later pass (or via the deferred discovery step).
-- ═══════════════════════════════════════════════════════════════

INSERT INTO companies (name, ats_type, slug, api_base, tier, is_active, next_poll_at, poll_interval) VALUES
  ('Personio',   'personio', 'personio',   'https://personio.jobs.personio.de',   'hot', true, now(), '6 hours'),
  ('Alasco',     'personio', 'alasco',     'https://alasco.jobs.personio.de',     'hot', true, now(), '6 hours'),
  ('Wandelbots', 'personio', 'wandelbots', 'https://wandelbots.jobs.personio.de', 'hot', true, now(), '6 hours'),
  ('tado',       'personio', 'tado',       'https://tado.jobs.personio.de',       'hot', true, now(), '6 hours')
ON CONFLICT (ats_type, slug) DO UPDATE SET name=EXCLUDED.name, api_base=EXCLUDED.api_base, is_active=true, next_poll_at=now();
