/**
 * s134_last_jobs_score100.js -- the Mini App's Jobs list showed match
 * percentages that visibly disagreed with the bot's own digest text for
 * the exact same jobs (e.g. Wisdom-AI showed 100% in the app, 89/100 in
 * the Telegraph digest). Root cause, confirmed against real execution
 * data (execution 966, the "22 Jobs" digest the user was looking at):
 * every job carries TWO different score fields --
 *   - fit_score: a coarse 0-10 integer bucket
 *   - score100: JobScorer's fine-grained 0-100 score
 * The bot's own digest text (Build Telegraph Body's top3_msg, "📊 X/100")
 * already uses score100. `Record Matches` (the existing Postgres write of
 * search scores) already prefers score100 over fit_score*10 too
 * (`COALESCE((s->>'score100')::real, (s->>'fit_score')::real*10)`) --
 * this fix brings the Mini App in line with that SAME established
 * precedent, not a new convention.
 *
 * The gap: `Assemble Digest` (the sole writer of staticData.last_jobs,
 * which the Mini App bridge reads) only ever persisted fit_score into the
 * map -- score100 was computed upstream and used for the Telegraph text,
 * but never carried into the one place the app can see. Two-part fix:
 * 1. Assemble Digest -- add score100 to the persisted last_jobs entry.
 * 2. miniapp/api/app/shapes.py -- match_pct prefers score100, falls back
 *    to fit_score*10 only for legacy last_jobs entries (already in
 *    staticData memory) written before this fix lands.
 *
 * Run: harness (real anchor text + the match_pct precedence logic against
 * fixtures matching the real execution-966 numbers) + deploy (master +
 * miniapp) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const SHAPES_FILE = path.join(ROOT, 'miniapp', 'api', 'app', 'shapes.py');
const API_TS_FILE = path.join(ROOT, 'miniapp', 'web', 'src', 'lib', 'api.ts');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}

// ──────────────────────── Part 1: Assemble Digest ────────────────────────
const AD_OLD = `const last_jobs = {};
rankedJobs.slice(0, 40).forEach((job, i) => {
  last_jobs[i+1] = {
    job_id: job.job_id, title: job.title, company: job.company,
    location: job.location, url: job.url, fit_score: job.fit_score,
    description_snippet: job.description_snippet || '', source: job.source || '', source_tier: job.source_tier || null
  };
});`;
const AD_NEW = `const last_jobs = {};
rankedJobs.slice(0, 40).forEach((job, i) => {
  last_jobs[i+1] = {
    job_id: job.job_id, title: job.title, company: job.company,
    location: job.location, url: job.url, fit_score: job.fit_score,
    // s134: the fine-grained 0-100 score (what the digest text itself
    // shows, "📊 X/100") -- fit_score alone is a coarse 0-10 bucket and
    // made the Mini App's match % visibly disagree with the bot's own
    // digest for the same job.
    score100: (typeof job.score100 === 'number' ? job.score100 : null),
    description_snippet: job.description_snippet || '', source: job.source || '', source_tier: job.source_tier || null
  };
});`;

function patchMaster() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Assemble Digest');
  if (!node) { console.error('INTEGRITY FAIL: Assemble Digest missing'); process.exit(1); }
  if (node.parameters.jsCode.includes('score100: (typeof job.score100')) {
    console.log('  master: already patched');
    return;
  }
  replaceOnce(node.parameters, 'jsCode', AD_OLD, AD_NEW, 'last_jobs score100 field');
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log('  master: Assemble Digest patched');
}

// ──────────────────────── Part 2: miniapp shapes.py ────────────────────────
const PY_OLD = `def match_pct(fit_score) -> int | None:
    """fit_score is 0-10 (Record Matches uses the same *10 conversion)."""
    if fit_score is None:
        return None
    try:
        return round(float(fit_score) * 10)
    except (TypeError, ValueError):
        return None`;
const PY_NEW = `def match_pct(score100, fit_score) -> int | None:
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

const RESHAPE_OLD = `            "fit_score": job.get("fit_score"),
            "match_pct": match_pct(job.get("fit_score")),`;
const RESHAPE_NEW = `            "fit_score": job.get("fit_score"),
            "score100": job.get("score100"),
            "match_pct": match_pct(job.get("score100"), job.get("fit_score")),`;

function patchShapes() {
  let src = fs.readFileSync(SHAPES_FILE, 'utf8');
  if (src.includes('def match_pct(score100, fit_score)')) {
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

// ──────────────────────── Part 3: frontend JobItem type (parity, optional field) ────────────────────────
const TS_OLD = `  fit_score: number | null;
  match_pct: number | null;`;
const TS_NEW = `  fit_score: number | null;
  score100: number | null;
  match_pct: number | null;`;

function patchApiTs() {
  let src = fs.readFileSync(API_TS_FILE, 'utf8');
  if (src.includes('score100: number | null;')) {
    console.log('  api.ts: already patched');
    return;
  }
  const c = src.split(TS_OLD).length - 1;
  if (c !== 1) { console.error(`INTEGRITY FAIL: anchor "JobItem fit_score/match_pct" found ${c} times, expected 1`); process.exit(1); }
  src = src.replace(TS_OLD, () => TS_NEW);
  fs.writeFileSync(API_TS_FILE, src);
  console.log('  api.ts: patched');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  // 1. Real numbers from execution 966 -- the exact mismatch reported.
  function pyMatchPct(score100, fitScore) {
    if (typeof score100 === 'number') return Math.round(score100);
    if (fitScore === null || fitScore === undefined) return null;
    return Math.round(fitScore * 10);
  }
  const realFixtures = [
    { company: 'Wisdom-AI', fit_score: 10, score100: 89, expect: 89 },
    { company: 'credo.ai', fit_score: 9, score100: 87, expect: 87 },
    { company: 'genpact', fit_score: 8, score100: 86, expect: 86 },
    { company: 'bjakcareer', fit_score: 9, score100: 85, expect: 85 },
    { company: 'commerceiq', fit_score: 8, score100: 85, expect: 85 },
  ];
  for (const f of realFixtures) {
    const got = pyMatchPct(f.score100, f.fit_score);
    check(`${f.company}: match_pct uses score100 (${f.expect}), not fit_score*10 (${f.fit_score * 10})`, got === f.expect);
  }

  // 2. Legacy fallback -- last_jobs entries written before this fix (no score100 key at all).
  check('legacy entry (no score100) falls back to fit_score*10', pyMatchPct(undefined, 7) === 70);
  check('no score at all -> null, not a throw', pyMatchPct(undefined, null) === null);

  // 3. score100 = 0 is a real, legitimate score -- must not be treated as falsy/missing.
  check('score100 of 0 is honored, not treated as missing', pyMatchPct(0, 5) === 0);

  // 4. Anchor integrity, checked for real before any write.
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const adNode = wf.nodes.find((n) => n.name === 'Assemble Digest');
  check('Assemble Digest anchor present exactly once', adNode.parameters.jsCode.split(AD_OLD).length - 1 === 1);

  // Idempotency fix (2026-07-21): these two anchor checks unconditionally
  // assumed shapes.py was still pre-patch. That's true the first time this
  // script runs, but not on a re-run after shapes.py/api.ts already landed
  // while the workflow JSON's patch got separately discarded (a real
  // git-checkout mistake in this same session) -- mirror patchShapes()'s own
  // "already patched" guard so the harness doesn't fail on a step that's
  // legitimately already done.
  const shapesSrc = fs.readFileSync(SHAPES_FILE, 'utf8');
  if (!shapesSrc.includes('def match_pct(score100, fit_score)')) {
    check('shapes.py match_pct anchor present exactly once', shapesSrc.split(PY_OLD).length - 1 === 1);
    check('shapes.py reshape_last_jobs anchor present exactly once', shapesSrc.split(RESHAPE_OLD).length - 1 === 1);
  } else {
    console.log('  shapes.py: already patched, skipping pre-patch anchor checks');
  }

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: match_pct now reproduces the real digest score100 values (89/87/86/85/85) for the exact jobs that mismatched, legacy fit_score-only entries still fall back correctly, score100=0 is not mistaken for missing.');

  patchMaster();
  patchShapes();
  patchApiTs();
  console.log('S134 (last_jobs score100 propagation) script complete.');
})();
