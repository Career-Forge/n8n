-- liveness_diff.sql -- the missing per-board job-level liveness diff (idempotent).
-- Problem: nothing ever closed a job that dropped out of its board's feed. penalize_boards
-- only deactivates whole boards (404). So filled reqs (FIS, CVS) sat as status='active'
-- forever, and Firecrawl can't see a Workday JS-shell is dead -> expired jobs got shown.
--
-- Fix: a RELATIVE freshness diff. For each board (or source, when board is null) the most
-- recent last_seen = that board's latest successful poll. An active job whose last_seen
-- trails its board's latest poll by > rel_grace (and is itself > abs_floor old) was dropped
-- from the feed -> close it. Plus a hard absolute backstop for boards that stopped polling.
--
-- SAFE + self-healing: closures are reversible -- the upsert (db.py ON CONFLICT) flips a job
-- back to status='active', closed_at=NULL if it reappears in any later poll. A false closure
-- (e.g. a per-board CAP truncated a still-live job this cycle) auto-corrects next poll.

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
        (j.last_seen < grp.gmax - rel_grace AND j.last_seen < now() - abs_floor)  -- dropped from a still-polled board
        OR j.last_seen < now() - hard_age                                          -- absurdly stale (board stopped polling)
      )
    RETURNING 1
  )
  SELECT count(*)::int FROM upd;
$$ LANGUAGE sql;

-- one-time cleanup now (also runs after every ingest via db.close_stale_jobs()).
SELECT cf_close_stale_jobs() AS closed_now;
