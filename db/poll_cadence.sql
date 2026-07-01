-- poll_cadence.sql -- tighten registry poll cadence for freshness (idempotent).
-- Problem: 14.6k "probe" boards had a 30-DAY poll_interval and 111 "hot" boards were
-- mis-set to 30 days too, so the freshness-critical registry tail refreshed monthly and
-- dead jobs lingered for weeks. With the per-board liveness diff now closing dropped reqs
-- on each re-poll, the binding constraint is HOW OFTEN a board re-polls.
--
-- Tier interval scheme (select_due_companies polls dream>hot>warm>probe>cold first):
--   dream 3h | hot 6h | warm 12h | probe 3d | cold 30d
-- Matched to throughput: ATS_DUE_LIMIT=120/type x ~24 registry runs/day ~= 2880/type/day,
-- so greenhouse's ~7.8k probe boards fully cover in ~3 days (probe interval), lever/ashby faster.

UPDATE companies SET poll_interval = interval '3 hours'  WHERE tier = 'dream';
UPDATE companies SET poll_interval = interval '6 hours'  WHERE tier = 'hot';
UPDATE companies SET poll_interval = interval '12 hours' WHERE tier = 'warm';
UPDATE companies SET poll_interval = interval '3 days'   WHERE tier = 'probe';
UPDATE companies SET poll_interval = interval '30 days'  WHERE tier = 'cold';

-- Make every active board due now so the tightened cadence takes effect immediately;
-- the tier-ordered LIMIT drains the backlog (curated first, probe behind).
UPDATE companies SET next_poll_at = now() WHERE is_active;
