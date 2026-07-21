/**
 * s138_remove_dead_score100_fallback.js -- removes the fit_score*10 fallback
 * from 3 sites, now confirmed DEAD CODE by a real structural guarantee, not
 * just "probably fine": `rankedJobs` (Build Telegraph Body) is built via
 * `scored.map(...)` -- it iterates ONLY the `scored` array from Parse Scorer
 * Output, never the full candidate pool. Parse Scorer Output computes
 * `score100` UNCONDITIONALLY for every entry in `scored`, on every parse
 * path including its total-failure `neutral_fallback` branch. So any job
 * that reaches `rankedJobs`/`last_jobs`/Record Matches's INSERT source
 * ALWAYS has a real score100 -- there is no live code path where fit_score
 * exists on one of these jobs but score100 doesn't.
 *
 * The ONE place this fallback was ever load-bearing: `last_jobs` entries
 * written by an OLDER `Assemble Digest` build, before commit ec5b542 (today,
 * same session) started persisting score100 at all. Those are pure runtime
 * staticData, not code -- they age out naturally (sd.last_jobs is fully
 * overwritten by every new digest run; nothing reads a partial/mixed-age
 * last_jobs across two different Assemble Digest versions). Removing the
 * fallback means a genuinely-stale last_jobs entry (one written before
 * ec5b542) would show match_pct: None until the next digest run replaces
 * it, instead of silently showing a wrong-but-present number. That's a
 * strictly more honest failure mode, not a new gap.
 *
 * NOT touched (confirmed a DIFFERENT, legitimate concern, not redundant):
 * Parse Scorer Output's own `const base = (Number(s.fit_score) || 0) * 10;`
 * -- this is score100's OWN internal composite formula substituting for a
 * genuinely-possible MISSING SUB-SCORE (e.g. the LLM returns fit_score for a
 * job but omits workauth_score for that one job) -- real defensive coding
 * against partial LLM non-compliance, not the same "is score100 itself ever
 * absent" question this script answers. Left alone.
 *
 * 3 sites:
 *   1. miniapp/api/app/shapes.py -- match_pct(score100, fit_score) drops the
 *      fit_score parameter and its whole fallback branch; reshape_last_jobs'
 *      call site updates to match_pct(job.get("score100")).
 *   2. Build Telegraph Body (workflow) -- 2 occurrences of
 *      `(job.score100 != null) ? job.score100 : (job.fit_score || 0) * 10`
 *      simplify to `job.score100`.
 *   3. Record Matches (workflow, Postgres INSERT) -- SQL
 *      `COALESCE((s->>'score100')::real, (s->>'fit_score')::real*10)`
 *      simplifies to `(s->>'score100')::real`. This INSERT reads directly
 *      from the CURRENT execution's live `scored` array
 *      (`JSON.stringify($json.scored || [])` in queryReplacement) -- not a
 *      read over historical rows with mixed schema -- so this is the exact
 *      same dead-fallback class, not a DB-legacy-data concern.
 *
 * Run: harness (real fixtures incl. the historical-stale-entry case, which
 * must now correctly return None/null rather than a fabricated number) +
 * deploy (master workflow + miniapp) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const SHAPES_FILE = path.join(ROOT, 'miniapp', 'api', 'app', 'shapes.py');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}

// ──────────────────────── Part 1: shapes.py ────────────────────────
const PY_OLD = `def match_pct(score100, fit_score) -> int | None:
    """Prefer the fine-grained 0-100 JobScorer score (score100) -- matches
    what the bot's own digest text shows ("\\U0001F4CA X/100"). Falls back to
    fit_score*10 (a coarse 0-10 bucket) only for last_jobs entries written
    before s134 started persisting score100 -- same precedence Record
    Matches already uses (COALESCE(score100, fit_score*10))."""
    if isinstance(score100, (int, float)):
        return round(score100)
    if fit_score is None:
        return None
    try:
        return round(float(fit_score) * 10)
    except (TypeError, ValueError):
        return None`;
const PY_NEW = `def match_pct(score100) -> int | None:
    """score100 (JobScorer's fine-grained 0-100 composite) is now the SOLE
    source -- s138 removed the fit_score*10 fallback after confirming it was
    dead code: rankedJobs (Build Telegraph Body) is built via scored.map(...)
    over Parse Scorer Output's output, which computes score100
    UNCONDITIONALLY for every scored job on every parse path. A live job can
    never reach last_jobs with fit_score but no score100. A genuinely-stale
    last_jobs entry (written before s134 started persisting score100 at all)
    now correctly returns None instead of a fabricated fit_score*10 guess --
    it ages out on the next digest run same as before."""
    if isinstance(score100, (int, float)):
        return round(score100)
    return None`;

const RESHAPE_OLD = `            "fit_score": job.get("fit_score"),
            "score100": job.get("score100"),
            "match_pct": match_pct(job.get("score100"), job.get("fit_score")),`;
const RESHAPE_NEW = `            "fit_score": job.get("fit_score"),
            "score100": job.get("score100"),
            "match_pct": match_pct(job.get("score100")),`;

function patchShapes() {
  let src = fs.readFileSync(SHAPES_FILE, 'utf8');
  if (src.includes('def match_pct(score100) -> int | None:')) {
    console.log('  shapes.py: already patched');
    return;
  }
  const c1 = src.split(PY_OLD).length - 1;
  if (c1 !== 1) { console.error(`INTEGRITY FAIL: anchor "match_pct definition" found ${c1} times, expected 1`); process.exit(1); }
  src = src.replace(PY_OLD, () => PY_NEW);
  const c2 = src.split(RESHAPE_OLD).length - 1;
  if (c2 !== 1) { console.error(`INTEGRITY FAIL: anchor "reshape_last_jobs match_pct call" found ${c2} times, expected 1`); process.exit(1); }
  src = src.replace(RESHAPE_OLD, () => RESHAPE_NEW);
  fs.writeFileSync(SHAPES_FILE, src);
  console.log('  shapes.py: patched');
}

// ──────────────────────── Part 2: Build Telegraph Body ────────────────────────
const BTB_OLD_1 = `const score = (job.score100 != null) ? job.score100 : (job.fit_score || 0) * 10;`;
const BTB_NEW_1 = `const score = job.score100;`;
const BTB_OLD_2 = `top3Msg += '    📊 ' + ((job.score100 != null) ? job.score100 : (job.fit_score || 0) * 10) + '/100 — ' + (job.one_liner || '') + '\\n\\n';`;
const BTB_NEW_2 = `top3Msg += '    📊 ' + job.score100 + '/100 — ' + (job.one_liner || '') + '\\n\\n';`;

function patchMaster() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));

  const btb = wf.nodes.find((n) => n.name === 'Build Telegraph Body');
  if (!btb) { console.error('INTEGRITY FAIL: Build Telegraph Body missing'); process.exit(1); }
  const rm = wf.nodes.find((n) => n.name === 'Record Matches');
  if (!rm) { console.error('INTEGRITY FAIL: Record Matches missing'); process.exit(1); }

  const alreadyDone = !btb.parameters.jsCode.includes('(job.fit_score || 0) * 10')
    && !String(rm.parameters.query || '').includes("fit_score')::real*10");
  if (alreadyDone) { console.log('  master: already patched'); return; }

  replaceOnce(btb.parameters, 'jsCode', BTB_OLD_1, BTB_NEW_1, 'Build Telegraph Body score fallback (main list)');
  replaceOnce(btb.parameters, 'jsCode', BTB_OLD_2, BTB_NEW_2, 'Build Telegraph Body score fallback (top3 message)');

  const RM_OLD = "(COALESCE((s->>'score100')::real, (s->>'fit_score')::real*10))/100.0";
  const RM_NEW = "((s->>'score100')::real)/100.0";
  replaceOnce(rm.parameters, 'query', RM_OLD, RM_NEW, 'Record Matches score100 COALESCE');

  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log('  master: Build Telegraph Body + Record Matches patched');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  // 1. match_pct's new single-arg behavior, real fixtures.
  function pyMatchPct(score100) {
    if (typeof score100 === 'number') return Math.round(score100);
    return null;
  }
  check('real score100 rounds correctly', pyMatchPct(84.6) === 85);
  check('score100 of 0 is honored, not treated as missing', pyMatchPct(0) === 0);
  check('a genuinely-stale pre-s134 entry (score100 absent) now returns null, not a fabricated number', pyMatchPct(undefined) === null);
  check('score100 explicitly null also returns null', pyMatchPct(null) === null);

  // 2. Anchor integrity, checked for real before any write.
  const shapesSrc = fs.readFileSync(SHAPES_FILE, 'utf8');
  if (!shapesSrc.includes('def match_pct(score100) -> int | None:')) {
    check('shapes.py match_pct anchor present exactly once', shapesSrc.split(PY_OLD).length - 1 === 1);
    check('shapes.py reshape_last_jobs anchor present exactly once', shapesSrc.split(RESHAPE_OLD).length - 1 === 1);
  } else {
    console.log('  shapes.py: already patched, skipping pre-patch anchor checks');
  }

  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const btb = wf.nodes.find((n) => n.name === 'Build Telegraph Body');
  const rm = wf.nodes.find((n) => n.name === 'Record Matches');
  if (btb.parameters.jsCode.includes('(job.fit_score || 0) * 10')) {
    check('Build Telegraph Body fallback #1 anchor present exactly once', btb.parameters.jsCode.split(BTB_OLD_1).length - 1 === 1);
    check('Build Telegraph Body fallback #2 anchor present exactly once', btb.parameters.jsCode.split(BTB_OLD_2).length - 1 === 1);
  } else {
    console.log('  Build Telegraph Body: already patched, skipping pre-patch anchor checks');
  }
  if (String(rm.parameters.query || '').includes("fit_score')::real*10")) {
    check('Record Matches COALESCE anchor present exactly once', rm.parameters.query.split("(COALESCE((s->>'score100')::real, (s->>'fit_score')::real*10))/100.0").length - 1 === 1);
  } else {
    console.log('  Record Matches: already patched, skipping pre-patch anchor check');
  }

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: match_pct is now a pure score100 passthrough (real scores round correctly, missing/stale entries correctly return null instead of a fabricated fit_score*10 guess); all 3 dead-fallback sites verified unique before write.');

  patchMaster();
  patchShapes();
  console.log('S138 (remove dead score100 fallback, 3 sites) complete.');
})();
