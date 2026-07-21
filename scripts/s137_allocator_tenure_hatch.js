/**
 * s137_allocator_tenure_hatch.js -- Parse Pass1 allocator: countPriority
 * shape-slot ordering + the 3+3 experience/project escape hatch.
 *
 * THIRD and FINAL of a three-script sequence (s135 done -- LaTeX render
 * layer; s136 done -- TIER_PLANS/COUNT_PLANS reshape + 4 prompt edits, incl.
 * the post-draft fix that set COUNT_PLANS.senior.experience.maxEntries to 4
 * to match COUNT_PLANS.mid, since Parse Pass1 reads THAT field, not
 * TIER_PLANS.sections.experience.maxEntries, as the real keep-cap). Touches
 * ONLY: Parse Pass1 (Code node jsCode). Does NOT touch Build Pass1 Context,
 * any LaTeX node, or any prompt node.
 *
 * Implements the approved plan's locked decisions:
 *   1. countPriority(items) -- a NEW function, added alongside (not
 *      replacing) rankItems. A SECOND ordering applied ONLY to the KEPT set
 *      (post rankItems keep/deselect decision), deciding who gets the bigger
 *      shape slots among survivors. Placed immediately after shapeAt, before
 *      selectAndShape. Formula (verbatim from the locked spec): relevance
 *      (0-100, defensively clamped) /100 weight 0.55; tenureMonths capped at
 *      60 (unbounded/LLM-supplied) weight 0.30; recency as ORDINAL RANK
 *      within the current item set (fixture-stable, never calls Date.now()
 *      itself -- reuses each item's pre-resolved .endTs) weight 0.15.
 *      mostRecentFlag stays the primary sort key so shape[0] (biggest slot)
 *      always lands on the most-recent entry, preserving each tier's
 *      mostRecentMinBullets floor. Final .id tiebreak makes it a total order.
 *   2. countPriority wired into exactly TWO call sites (both operate on an
 *      already-computed subset, NOT the top-of-function keep/deselect
 *      ranking):
 *        a. selectAndShape's "kept = rankItems(kept);" -> countPriority --
 *           reorders survivors before shape-slot assignment.
 *        b. trimToLineBudget's "const lowestFirst = rankItems(live)..." ->
 *           countPriority -- makes trim order consistent with shape-
 *           assignment order (last-in-line for a big slot is first to lose
 *           a bullet when trimming).
 *      The THIRD (and only other) rankItems( call site --
 *      "const ranked = rankItems(items);" at the top of selectAndShape,
 *      which governs the actual keep/deselect decision -- is untouched.
 *   3. The 3+3 escape hatch -- fires for ANY tier whose
 *      COUNT_PLANS.<tier>.experience.maxEntries === 4 (tier-agnostic
 *      predicate; currently true for both mid and senior per s136). When
 *      exactly 4 experiences would be kept but the 4th-ranked one is
 *      decisively weaker (margin >= 15, real relevanceScore vs real
 *      relevanceScore) than the 3rd-best project, and neither score is a
 *      fabricated default, swaps 3 richer projects in for the marginal 4th
 *      experience by capping expCfg.maxEntries to 3 for that
 *      selectAndShape() call only. Never evicts a mandatory
 *      (isMostRecent/isLongestTenure) entry. shapeAt(cp.experience.shapes, n)
 *      is UNCHANGED -- it still reads from the tier's real shapes table
 *      (cp.experience.shapes), never from expCfg (which carries no .shapes
 *      of its own); shapeAt(shapes, 3) naturally resolves to shapes["3"].
 *      CRITICAL correctness point (the thing s136 got bitten by, on the
 *      COUNT_PLANS/TIER_PLANS field-source distinction -- same class of bug
 *      guarded against here): the hatch-firing predicate checks REAL-SCORE-
 *      PRESENCE via ".ref.relevanceScore" (typeof === 'number'), the RAW,
 *      unfabricated field straight off the Pass1 LLM JSON -- NEVER
 *      ".relevance" (the pre-computed field baked into expItems/projItems at
 *      construction time, which ALWAYS holds a number by construction: a
 *      real score OR a fabricated default of 50 for experience/interns or
 *      90-idx*10 for projects). Checking typeof i.relevance === 'number'
 *      would ALWAYS be true and could never distinguish real data from a
 *      coin-flip default -- firing the hatch on missing data would silently
 *      evict a real experience for no real reason. realProj's filter already
 *      guarantees every candidate proj3 could be has a real ref.relevanceScore,
 *      so the explicit check in the final "if" only needs to additionally
 *      cover exp4 (ranked.slice()[3] from the full unfiltered expItems list,
 *      never pre-filtered for real-score-presence).
 *   4. Everything else (parseJSON, the 4.2a section-override backstop,
 *      expItems/internItems/projItems construction, the internships
 *      selectAndShape call, the projects selectAndShape call,
 *      trimToLineBudget's own internal floor logic (mandatory ? 2 : 1), the
 *      maxB scan, pass1._contentPlan assembly, the final return statement)
 *      stays COMPLETELY UNCHANGED.
 *
 * Run: node scripts/s137_allocator_tenure_hatch.js   (from the repo root)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

const LATEX_NODES = ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX', 'Load Skeletons', 'Build Cover LaTeX'];
const OUT_OF_SCOPE_NODES = [...LATEX_NODES, 'Build Pass1 Context', 'Pass1 Selection', 'Pass2 Generate', 'Pass2 Regen', 'ReviseForge'];

// ═══════════════════════════════════════════════════════════════════════
// replaceOnce -- established idiom (s135/s136): asserts the anchor appears
// EXACTLY once in the container before replacing.
// ═══════════════════════════════════════════════════════════════════════
function replaceOnce(container, key, oldStr, newStr, label) {
  const count = container.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`INTEGRITY FAIL ${key}: anchor "${label}" found ${count} times, expected exactly 1`);
    process.exit(1);
  }
  return container.split(oldStr).join(newStr);
}

// ═══════════════════════════════════════════════════════════════════════
// 1. countPriority insertion -- anchored on shapeAt's closing brace + the
//    "select top maxEntries..." comment that immediately precedes
//    selectAndShape's definition (byte-for-byte captured from the live file).
// ═══════════════════════════════════════════════════════════════════════
const SHAPEAT_TAIL_OLD = `    return table[pick] || [];
  };
  // select top maxEntries (mandatory first), deselect rest, apply shape positionally, cap by material`;

const COUNT_PRIORITY_FN = `  // s137: countPriority -- second ordering, applied ONLY to the KEPT set (the
  // set rankItems already decided to keep/deselect), to decide who gets the
  // bigger shape slots among survivors. Does NOT participate in the
  // keep/deselect decision itself (see "const ranked = rankItems(items);"
  // inside selectAndShape, untouched).
  const countPriority = (items) => {
    const n = items.length;
    const byRecency = items.slice().sort((a, b) => ((b.endTs == null ? -Infinity : b.endTs) - (a.endTs == null ? -Infinity : a.endTs)));
    const recRank = new Map(byRecency.map((it, idx) => [it.id, n > 1 ? (n - 1 - idx) / (n - 1) : 1]));
    const score = (i) => 0.55 * (Math.max(0, Math.min(100, i.relevance)) / 100)
                       + 0.30 * (Math.min(i.tenure || 0, 60) / 60)
                       + 0.15 * (recRank.get(i.id) || 0);
    return items.slice().sort((a, b) =>
      (b.mostRecentFlag - a.mostRecentFlag)
      || (score(b) - score(a))
      || ((b.endTs == null ? -Infinity : b.endTs) - (a.endTs == null ? -Infinity : a.endTs))
      || (b.tenure - a.tenure)
      || String(a.id).localeCompare(String(b.id)));
  };`;

const SHAPEAT_TAIL_NEW = `    return table[pick] || [];
  };
${COUNT_PRIORITY_FN}
  // select top maxEntries (mandatory first), deselect rest, apply shape positionally, cap by material`;

// ═══════════════════════════════════════════════════════════════════════
// 2a. selectAndShape's "kept = rankItems(kept);" -> countPriority. Sole
//     occurrence of this exact line in the file.
// ═══════════════════════════════════════════════════════════════════════
const KEPT_RANK_OLD = '    kept = rankItems(kept);';
const KEPT_RANK_NEW = '    kept = countPriority(kept);';

// ═══════════════════════════════════════════════════════════════════════
// 2b. trimToLineBudget's "const lowestFirst = rankItems(live)..." ->
//     countPriority. Sole occurrence of this exact line in the file.
// ═══════════════════════════════════════════════════════════════════════
const LOWESTFIRST_OLD = '    const lowestFirst = rankItems(live).slice().reverse();';
const LOWESTFIRST_NEW = '    const lowestFirst = countPriority(live).slice().reverse();';

// ═══════════════════════════════════════════════════════════════════════
// 3. The 3+3 escape hatch -- full-block replace of the cp.experience
//    if/else (byte-for-byte captured from the live file; the trailing
//    trimToLineBudget call on the same "if (cp.experience && ..." predicate
//    text is a DIFFERENT, single-line statement further down and is not
//    part of this anchor -- confirmed unique via count-check in the harness).
// ═══════════════════════════════════════════════════════════════════════
const EXP_BLOCK_OLD = `  if (cp.experience && effectiveOrder.indexOf('experience') !== -1) {
    primaryCount = selectAndShape(expItems, cp.experience, (n) => shapeAt(cp.experience.shapes, n));
  } else { expItems.forEach((i) => { alloc[i.id] = 0; if (i.ref) i.ref.bulletCount = 0; }); }`;

const EXP_BLOCK_NEW = `  if (cp.experience && effectiveOrder.indexOf('experience') !== -1) {
    // s137: 3+3 escape hatch -- when exactly 4 experiences would be kept but
    // the 4th-ranked one is decisively weaker than the 3rd-best project
    // (and neither score is a fabricated default), swap 3 richer projects
    // in for a 4th marginal experience. Never evicts a mandatory
    // (isMostRecent/isLongestTenure) entry -- that would contradict Pass1's
    // own "always included" contract for those two.
    const HATCH_MARGIN = 15;
    let expCfg = cp.experience;
    if (expCfg && expCfg.maxEntries === 4 && cp.projects && effectiveOrder.indexOf('projects') !== -1) {
      const ranked = rankItems(expItems);
      let sim = ranked.filter((i) => i.mandatory);
      for (const i of ranked) { if (sim.length >= 4) break; if (sim.indexOf(i) === -1) sim.push(i); }
      if (sim.length === 4) {
        const exp4 = rankItems(sim)[3];
        const realProj = projItems.filter((i) => i.ref && typeof i.ref.relevanceScore === 'number' && i.material >= 1);
        const proj3 = rankItems(realProj)[2];
        if (exp4 && proj3 && !exp4.mandatory
            && exp4.ref && typeof exp4.ref.relevanceScore === 'number'
            && (proj3.relevance - exp4.relevance) >= HATCH_MARGIN) {
          expCfg = Object.assign({}, cp.experience, { maxEntries: 3 });
        }
      }
    }
    primaryCount = selectAndShape(expItems, expCfg, (n) => shapeAt(cp.experience.shapes, n));
  } else { expItems.forEach((i) => { alloc[i.id] = 0; if (i.ref) i.ref.bulletCount = 0; }); }`;

function patchParsePass1(code) {
  code = replaceOnce(code, 'Parse Pass1', SHAPEAT_TAIL_OLD, SHAPEAT_TAIL_NEW, 'shapeAt tail / selectAndShape comment (countPriority insertion point)');
  code = replaceOnce(code, 'Parse Pass1', KEPT_RANK_OLD, KEPT_RANK_NEW, 'selectAndShape "kept = rankItems(kept);" -> countPriority');
  code = replaceOnce(code, 'Parse Pass1', LOWESTFIRST_OLD, LOWESTFIRST_NEW, 'trimToLineBudget "const lowestFirst = rankItems(live)..." -> countPriority');
  code = replaceOnce(code, 'Parse Pass1', EXP_BLOCK_OLD, EXP_BLOCK_NEW, 'cp.experience if/else block -> 3+3 escape hatch');
  return code;
}

// ═══════════════════════════════════════════════════════════════════════
// patch() -- applies the edit to a freshly-read copy of the live workflow,
// verifies invariants, writes the file.
// ═══════════════════════════════════════════════════════════════════════
function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  const NEEDED = ['Parse Pass1', ...OUT_OF_SCOPE_NODES];
  for (const need of NEEDED) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }

  if (N['Parse Pass1'].parameters.jsCode.includes('const countPriority = (items) => {')) {
    console.log(`  ${base}: already patched`);
    return;
  }

  // snapshot out-of-scope nodes so we can prove they never moved
  const beforeOutOfScope = {};
  for (const name of OUT_OF_SCOPE_NODES) beforeOutOfScope[name] = JSON.stringify(N[name]);

  N['Parse Pass1'].parameters.jsCode = patchParsePass1(N['Parse Pass1'].parameters.jsCode);

  // out-of-scope invariant
  for (const name of OUT_OF_SCOPE_NODES) {
    if (JSON.stringify(N[name]) !== beforeOutOfScope[name]) {
      console.error(`INTEGRITY FAIL ${base}: out-of-scope node "${name}" was modified -- this script must not touch it`); process.exit(1);
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Parse Pass1 countPriority + 3+3 escape hatch applied`);
}

// ═══════════════════════════════════════════════════════════════════════
// Test-fixture helpers shared by the harness. Fixtures build RAW pass1-
// shaped input (companies[].positions[], selectedProjects[]) so the real,
// unmodified expItems/internItems/projItems construction code (item 4,
// untouched) runs for real too -- not just the allocator's inner logic.
// ═══════════════════════════════════════════════════════════════════════
const DAY = 24 * 60 * 60 * 1000;
const msDaysAgo = (n) => Date.now() - n * DAY;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

function rawPos(id, { relevanceScore, tenureMonths = 0, endDate, isMostRecent = false, isLongestTenure = false, achievements = 3, isSelected = true } = {}) {
  return { id, isSelected, keyAchievements: Array(achievements).fill('x'), isMostRecent, isLongestTenure, relevanceScore, endDate, tenureMonths };
}
function rawProj(id, { relevanceScore, descriptionPoints = 2 } = {}) {
  return { id, descriptionPoints: Array(descriptionPoints).fill('x'), relevanceScore };
}

// ═══════════════════════════════════════════════════════════════════════
// HARNESS -- must print all-pass BEFORE any file write. Dry-runs the patch
// against a byte-exact snapshot of the REAL live workflow JSON, and
// extracts+evals the patched functions via new Function against real
// fixture data to assert real behavior, not just string presence.
// ═══════════════════════════════════════════════════════════════════════
(function harness() {
  if (!fs.existsSync(TARGET)) { console.error('HARNESS FAIL: target file not found'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  const liveCode = N['Parse Pass1'].parameters.jsCode;
  const alreadyPatched = liveCode.includes('const countPriority = (items) => {');

  // -- 0. Pull the REAL live COUNT_PLANS.{senior,mid,junior}.experience.maxEntries
  //    from Build Pass1 Context (independent confirmation, not hardcoded) --
  //    needed for harness fixtures (e)/(f) below.
  const bp1Code = N['Build Pass1 Context'].parameters.jsCode;
  let LIVE_COUNT_PLANS;
  {
    const si = bp1Code.indexOf('const COUNT_PLANS = ');
    const ei = bp1Code.indexOf(';', si);
    if (si === -1 || ei === -1) { console.error('HARNESS FAIL: could not locate COUNT_PLANS in Build Pass1 Context'); process.exit(1); }
    const jsonText = bp1Code.slice(si + 'const COUNT_PLANS = '.length, ei);
    LIVE_COUNT_PLANS = JSON.parse(jsonText);
  }
  const SENIOR_MAX = LIVE_COUNT_PLANS.senior.experience.maxEntries;
  const MID_MAX = LIVE_COUNT_PLANS.mid.experience.maxEntries;
  const JUNIOR_MAX = LIVE_COUNT_PLANS.junior.experience.maxEntries;
  if (SENIOR_MAX !== 4 || MID_MAX !== 4) { console.error('HARNESS FAIL: expected s136 to have set senior/mid experience.maxEntries to 4 -- live values are', SENIOR_MAX, MID_MAX); process.exit(1); }
  if (JUNIOR_MAX !== 3) { console.error('HARNESS FAIL: expected junior experience.maxEntries to be 3 -- live value is', JUNIOR_MAX); process.exit(1); }
  console.log(`HARNESS OK: live COUNT_PLANS pulled fresh -- senior.experience.maxEntries=${SENIOR_MAX}, mid.experience.maxEntries=${MID_MAX}, junior.experience.maxEntries=${JUNIOR_MAX}`);

  // -- 1. dry-run Parse Pass1 patch when the target is still unpatched (all 4
  //    anchors unique, replaceOnce asserts this). When the target is ALREADY
  //    patched, the pre-patch anchors no longer exist in the live code (they
  //    were replaced the last time this ran), so replaying patchParsePass1
  //    against it would legitimately fail. Rather than skip checks (a)-(h)
  //    wholesale in that case (which made every re-run after the first a
  //    silent no-op that never re-validated the on-disk code -- caught by
  //    adversarial review), validate the ALREADY-PATCHED on-disk code
  //    directly: same checks, same fixtures, just sourced from what's really
  //    on disk instead of a fresh dry-run. This keeps the harness a genuine
  //    ongoing check instead of one that only ever proved anything once. --
  let patched;
  if (alreadyPatched) {
    patched = liveCode;
    console.log('HARNESS: target already patched -- validating the ON-DISK patched code directly (anchor-replay dry-run skipped since pre-patch anchors are gone; checks a-h below still run for real against the live file).');
  } else {
    patched = patchParsePass1(liveCode);
    console.log('HARNESS OK: all 4 Parse Pass1 anchors (countPriority insertion, 2 wiring sites, escape-hatch block) unique and replaced');
  }

  // -- extract the allocator's inner statements (from "const _endTs" through the
  //    end of the "pass1._contentPlan = {...};" assignment, i.e. everything
  //    inside "if (_plan && _plan.countPlan) { ... }" MINUS the two declarations
  //    that live before _endTs (cp, bs, lpb, alloc/deselected, effectiveOrder --
  //    all supplied as Function parameters/locals in the wrapper below instead)
  //    and MINUS the if-block's own wrapping braces. --
  const blockStart = patched.indexOf('const _endTs = (e) =>');
  const CLOSE_MARKER = '\n}\nreturn [{json:{pass1:pass1}}];';
  const blockEnd = patched.indexOf(CLOSE_MARKER);
  if (blockStart === -1 || blockEnd === -1) { console.error('HARNESS FAIL: could not locate allocator block bounds in patched code'); process.exit(1); }
  const allocatorInnerSrc = patched.slice(blockStart, blockEnd);

  // `expCfg` is declared with `let` INSIDE the "if (cp.experience && ...) {...}"
  // block, so it's out of scope by the time our wrapper's `return` statement
  // runs -- there is no way to read it from outside that block without either
  // (a) instrumenting the slice with a no-op observability hook, or (b)
  // inferring it indirectly from primaryCount, which is ambiguous for the
  // junior no-fire case (junior's real cap is already 3, so primaryCount==3
  // regardless of whether the -- structurally inapplicable, maxEntries!==4 --
  // hatch logic ran). JUDGMENT CALL (flagged in the final report): we splice
  // one inert probe line into the HARNESS's own in-memory copy of the slice
  // (never into the code that gets WRITTEN to the workflow file) immediately
  // after the real "primaryCount = selectAndShape(expItems, expCfg, ...)"
  // call, capturing expCfg into a variable the wrapper declares. The probe
  // changes zero computation/branching in the tested logic -- it only makes
  // an already-computed local visible to the test harness.
  const PROBE_ANCHOR = '    primaryCount = selectAndShape(expItems, expCfg, (n) => shapeAt(cp.experience.shapes, n));';
  if (allocatorInnerSrc.split(PROBE_ANCHOR).length - 1 !== 1) {
    console.error('HARNESS FAIL: probe anchor for expCfg capture not found exactly once in the patched slice'); process.exit(1);
  }
  const probedInnerSrc = allocatorInnerSrc.split(PROBE_ANCHOR).join(`${PROBE_ANCHOR}\n    __probeExpCfg = expCfg;`);

  // Build a standalone harness function: takes cp/effectiveOrder/_plan/_tier/
  // pass1/lpb/bs pre-supplied (mirroring what's already resolved above _endTs
  // in the real code), runs the REAL selectAndShape/trimToLineBudget/
  // countPriority/escape-hatch logic (probedInnerSrc == allocatorInnerSrc plus
  // the one inert probe line above), returns enough state to assert on.
  function runAllocator({ pass1, cp, effectiveOrder, sections, lpb = 2 }) {
    const bs = { linesPerBullet: lpb, targetChars: [1, 2], directive: 'test' };
    const _plan = { countPlan: cp, sections: sections || {}, bulletStyle: bs };
    const src = `
      const alloc = {}, deselected = [];
      let __probeExpCfg;
      ${probedInnerSrc}
      return { alloc, deselected, primaryCount, internCount, expCfgMaxEntries: (__probeExpCfg ? __probeExpCfg.maxEntries : undefined) };
    `;
    const fn = new Function('cp', 'effectiveOrder', '_plan', '_tier', 'pass1', 'lpb', 'bs', src);
    return fn(cp, effectiveOrder, _plan, 'test-tier', pass1, lpb, bs);
  }

  // -- (a) countPriority ordering: fixture where naive rankItems order would
  //    differ from countPriority's order. Assert countPriority's output order
  //    matches the hand-computed expected order, and mostRecentFlag=1 always
  //    sorts first regardless of score. --
  {
    // items: A = mostRecent, low relevance/tenure (must still sort first)
    //        B = high relevance(90), low tenure(0), old recency
    //        C = mid relevance(70), high tenure(60+, capped), recent-ish
    //        D = low relevance(40), mid tenure(30), most recent among non-A
    const A = { id: 'A', relevance: 30, tenure: 2, endTs: msDaysAgo(10), mostRecentFlag: 1 };
    const B = { id: 'B', relevance: 90, tenure: 0, endTs: msDaysAgo(3000), mostRecentFlag: 0 };
    const C = { id: 'C', relevance: 70, tenure: 80, endTs: msDaysAgo(1500), mostRecentFlag: 0 };
    const D = { id: 'D', relevance: 40, tenure: 30, endTs: msDaysAgo(100), mostRecentFlag: 0 };
    const items = [B, C, D, A]; // deliberately scrambled input order
    // Extract countPriority standalone via new Function for a pure unit test.
    const cpSrc = patched.slice(patched.indexOf('const countPriority = (items) => {'), patched.indexOf('  // select top maxEntries'));
    const cpFn = new Function(`${cpSrc}\nreturn countPriority;`)();
    const out = cpFn(items).map((i) => i.id);
    // hand-computed: n=4, recRank computed over ALL FOUR items by endTs desc
    // (most recent=1.0, val=(n-1-idx)/(n-1)): A(idx0,val=1), D(idx1,val=2/3),
    // C(idx2,val=1/3), B(idx3,val=0).
    // score(A) = 0.55*(30/100) + 0.30*(2/60)  + 0.15*(1)   = 0.165+0.01+0.15  = 0.325
    // score(B) = 0.55*(90/100) + 0.30*(0/60)  + 0.15*(0)   = 0.495
    // score(C) = 0.55*(70/100) + 0.30*(60/60, tenure 80 capped) + 0.15*(1/3) = 0.385+0.3+0.05 = 0.735
    // score(D) = 0.55*(40/100) + 0.30*(30/60) + 0.15*(2/3) = 0.22+0.15+0.1   = 0.47
    // mostRecentFlag primary key -> A first regardless of score. Remaining sorted
    // by score desc: C(0.735) > B(0.495) > D(0.47).
    const expected = ['A', 'C', 'B', 'D'];
    if (JSON.stringify(out) !== JSON.stringify(expected)) {
      console.error('HARNESS FAIL (a): countPriority ordering mismatch. Got', out, 'expected', expected); process.exit(1);
    }
    // naive rankItems order (mostRecentFlag, then relevance, then endTs, then tenure)
    // would be: A(flag=1) first, then by relevance desc: B(90), C(70), D(40) -- DIFFERENT from countPriority's C,B,D.
    const naiveOrder = ['A', 'B', 'C', 'D'];
    if (JSON.stringify(naiveOrder) === JSON.stringify(out)) {
      console.error('HARNESS FAIL (a): fixture did not actually differentiate countPriority from naive rankItems ordering -- fixture is not adversarial enough'); process.exit(1);
    }
  }
  console.log('HARNESS OK (a): countPriority ordering matches hand-computed formula output (A,C,B,D) and differs from naive rankItems order (A,B,C,D); mostRecentFlag=1 sorts first regardless of score');

  // -- (b) mostRecentMinBullets preservation: run the REAL selectAndShape-equivalent
  //    logic (via runAllocator, executing the actual patched allocator source) and
  //    confirm shape[0] (biggest slot) lands on the mostRecentFlag=1 item after the
  //    countPriority swap, even though it has the lowest relevance/tenure score. --
  {
    const cp = {
      experience: { maxEntries: 4, shapes: { '4': [4, 3, 3, 2] } },
      projects: null,
    };
    const positions = [
      rawPos('mostrecent', { relevanceScore: 40, tenureMonths: 2, endDate: isoDaysAgo(10), isMostRecent: true, achievements: 5 }),
      rawPos('e2', { relevanceScore: 95, tenureMonths: 50, endDate: isoDaysAgo(2000), achievements: 5 }),
      rawPos('e3', { relevanceScore: 90, tenureMonths: 45, endDate: isoDaysAgo(1800), achievements: 5 }),
      rawPos('e4', { relevanceScore: 85, tenureMonths: 40, endDate: isoDaysAgo(1600), achievements: 5 }),
    ];
    const pass1 = { companies: [{ positions }], selectedProjects: [], selectedInternships: [] };
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience'] });
    if (result.alloc['mostrecent'] !== 4) {
      console.error('HARNESS FAIL (b): mostRecentFlag=1 item did not receive the biggest shape slot (4). Got alloc:', result.alloc); process.exit(1);
    }
  }
  console.log('HARNESS OK (b): after countPriority swap, shape[0]=4 (the biggest slot) still lands on the mostRecentFlag=1 item despite it having the lowest relevance/tenure score among kept survivors');

  // -- (c) escape hatch fires: mid-tier fixture, 4 non-mandatory-4th experiences,
  //    4th-ranked has real relevanceScore well below a real 3rd project's score
  //    (margin >= 15), >=3 real projects. Assert expCfg.maxEntries becomes 3 and
  //    final kept experience count is 3. --
  function firingFixture(maxEntries, margin) {
    const cp = {
      experience: { maxEntries, shapes: { '3': [4, 4, 3], '4': [4, 3, 3, 2] } },
      projects: { byCount: { '3': [3, 3, 3] } },
    };
    const positions = [
      rawPos('e1', { relevanceScore: 90, tenureMonths: 40, endDate: isoDaysAgo(30), isMostRecent: true, achievements: 5 }),
      rawPos('e2', { relevanceScore: 85, tenureMonths: 36, endDate: isoDaysAgo(800), achievements: 5 }),
      rawPos('e3', { relevanceScore: 80, tenureMonths: 30, endDate: isoDaysAgo(1600), achievements: 5 }),
      rawPos('e4', { relevanceScore: 75 - margin, tenureMonths: 12, endDate: isoDaysAgo(2400), achievements: 5 }), // real score, weak; proj3.relevance(75) - exp4.relevance == margin exactly
    ];
    const projects = [
      rawProj('p1', { relevanceScore: 88, descriptionPoints: 3 }),
      rawProj('p2', { relevanceScore: 82, descriptionPoints: 3 }),
      rawProj('p3', { relevanceScore: 75, descriptionPoints: 3 }),
    ];
    const pass1 = { companies: [{ positions }], selectedProjects: projects, selectedInternships: [] };
    return { cp, pass1 };
  }
  {
    const { cp, pass1 } = firingFixture(4, 15);
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience', 'projects'] });
    if (result.expCfgMaxEntries !== 3) { console.error('HARNESS FAIL (c): hatch did not fire (margin=15, real scores) -- expCfgMaxEntries =', result.expCfgMaxEntries); process.exit(1); }
    if (result.primaryCount !== 3) { console.error('HARNESS FAIL (c): final kept experience count is not 3 -- primaryCount =', result.primaryCount, 'alloc=', result.alloc); process.exit(1); }
  }
  console.log('HARNESS OK (c): escape hatch fires on mid-shaped fixture (exp scores 90/85/80/60 real, proj scores 88/82/75 real, margin=15) -- expCfg.maxEntries=3, final kept experience count=3');

  // -- (d1) mandatory 4th -- hatch must NOT fire, maxEntries stays 4. --
  {
    const cp = {
      experience: { maxEntries: 4, shapes: { '3': [4, 4, 3], '4': [4, 3, 3, 2] } },
      projects: { byCount: { '3': [3, 3, 3], '4': [4, 3, 3, 2] } },
    };
    const positions = [
      rawPos('e1', { relevanceScore: 90, tenureMonths: 40, endDate: isoDaysAgo(30), isMostRecent: true, achievements: 5 }),
      rawPos('e2', { relevanceScore: 85, tenureMonths: 36, endDate: isoDaysAgo(800), achievements: 5 }),
      rawPos('e3', { relevanceScore: 80, tenureMonths: 30, endDate: isoDaysAgo(1600), achievements: 5 }),
      rawPos('e4', { relevanceScore: 45, tenureMonths: 90, endDate: isoDaysAgo(2400), isLongestTenure: true, achievements: 5 }), // mandatory, weak score
    ];
    const pass1 = { companies: [{ positions }], selectedProjects: [rawProj('p1', { relevanceScore: 88, descriptionPoints: 3 }), rawProj('p2', { relevanceScore: 82, descriptionPoints: 3 }), rawProj('p3', { relevanceScore: 75, descriptionPoints: 3 })], selectedInternships: [] };
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience', 'projects'] });
    if (result.expCfgMaxEntries !== 4) { console.error('HARNESS FAIL (d1): hatch fired despite 4th-ranked entry being mandatory -- expCfgMaxEntries =', result.expCfgMaxEntries); process.exit(1); }
  }
  console.log('HARNESS OK (d1): 4th-ranked entry is mandatory (isLongestTenure) -- hatch does NOT fire, maxEntries stays 4');

  // -- (d2) exp4 has NO relevanceScore field at all (undefined) -- hatch must NOT fire. --
  {
    const cp = {
      experience: { maxEntries: 4, shapes: { '3': [4, 4, 3], '4': [4, 3, 3, 2] } },
      projects: { byCount: { '3': [3, 3, 3] } },
    };
    const positions = [
      rawPos('e1', { relevanceScore: 90, tenureMonths: 40, endDate: isoDaysAgo(30), isMostRecent: true, achievements: 5 }),
      rawPos('e2', { relevanceScore: 85, tenureMonths: 36, endDate: isoDaysAgo(800), achievements: 5 }),
      rawPos('e3', { relevanceScore: 80, tenureMonths: 30, endDate: isoDaysAgo(1600), achievements: 5 }),
      rawPos('e4', { relevanceScore: undefined, tenureMonths: 12, endDate: isoDaysAgo(2400), achievements: 5 }), // NO real score -- fabricated .relevance=50 only
    ];
    const pass1 = { companies: [{ positions }], selectedProjects: [rawProj('p1', { relevanceScore: 88, descriptionPoints: 3 }), rawProj('p2', { relevanceScore: 82, descriptionPoints: 3 }), rawProj('p3', { relevanceScore: 75, descriptionPoints: 3 })], selectedInternships: [] };
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience', 'projects'] });
    if (result.expCfgMaxEntries !== 4) { console.error('HARNESS FAIL (d2): hatch fired despite exp4 having no real relevanceScore (fabricated-default trap) -- expCfgMaxEntries =', result.expCfgMaxEntries); process.exit(1); }
  }
  console.log('HARNESS OK (d2): 4th-ranked entry has NO ref.relevanceScore (undefined; only the fabricated .relevance=50 default exists) -- hatch does NOT fire, missing data never triggers eviction');

  // -- (d3) only 2 real projects exist (not 3) -- hatch must NOT fire. --
  {
    const cp = {
      experience: { maxEntries: 4, shapes: { '3': [4, 4, 3], '4': [4, 3, 3, 2] } },
      projects: { byCount: { '2': [3, 3], '4': [4, 3, 3, 2] } },
    };
    const positions = [
      rawPos('e1', { relevanceScore: 90, tenureMonths: 40, endDate: isoDaysAgo(30), isMostRecent: true, achievements: 5 }),
      rawPos('e2', { relevanceScore: 85, tenureMonths: 36, endDate: isoDaysAgo(800), achievements: 5 }),
      rawPos('e3', { relevanceScore: 80, tenureMonths: 30, endDate: isoDaysAgo(1600), achievements: 5 }),
      rawPos('e4', { relevanceScore: 45, tenureMonths: 12, endDate: isoDaysAgo(2400), achievements: 5 }),
    ];
    const pass1 = { companies: [{ positions }], selectedProjects: [rawProj('p1', { relevanceScore: 88, descriptionPoints: 3 }), rawProj('p2', { relevanceScore: 82, descriptionPoints: 3 })], selectedInternships: [] }; // only 2 real projects
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience', 'projects'] });
    if (result.expCfgMaxEntries !== 4) { console.error('HARNESS FAIL (d3): hatch fired despite only 2 real projects existing (proj3 is undefined) -- expCfgMaxEntries =', result.expCfgMaxEntries); process.exit(1); }
  }
  console.log('HARNESS OK (d3): only 2 real projects exist (proj3 undefined) -- hatch does NOT fire');

  // -- (d4) margin=14 (just under threshold) does NOT fire; margin=15 (boundary, inclusive) DOES fire. --
  {
    const { cp, pass1 } = firingFixture(4, 14);
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience', 'projects'] });
    if (result.expCfgMaxEntries !== 4) { console.error('HARNESS FAIL (d4): hatch fired at margin=14 (should require >=15) -- expCfgMaxEntries =', result.expCfgMaxEntries); process.exit(1); }
  }
  {
    const { cp, pass1 } = firingFixture(4, 15);
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience', 'projects'] });
    if (result.expCfgMaxEntries !== 3) { console.error('HARNESS FAIL (d4): hatch did NOT fire at margin=15 (boundary should be inclusive) -- expCfgMaxEntries =', result.expCfgMaxEntries); process.exit(1); }
  }
  console.log('HARNESS OK (d4): margin=14 does NOT fire (below threshold); margin=15 DOES fire (boundary inclusive, >=15)');

  // -- (e) senior tier fixture (cp.experience.maxEntries === SENIOR_MAX, pulled
  //    live, not hardcoded) fires identically to the mid case. --
  {
    const { cp, pass1 } = firingFixture(SENIOR_MAX, 15);
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience', 'projects'] });
    if (result.expCfgMaxEntries !== 3) { console.error(`HARNESS FAIL (e): senior-tier fixture (maxEntries=${SENIOR_MAX}) did not fire the hatch -- expCfgMaxEntries =`, result.expCfgMaxEntries); process.exit(1); }
    if (result.primaryCount !== 3) { console.error('HARNESS FAIL (e): senior-tier final kept experience count is not 3 -- primaryCount =', result.primaryCount); process.exit(1); }
  }
  console.log(`HARNESS OK (e): senior-tier fixture (cp.experience.maxEntries=${SENIOR_MAX}, pulled live from COUNT_PLANS) fires the hatch identically to mid -- expCfg.maxEntries=3, primaryCount=3`);

  // -- (f) junior tier (cp.experience.maxEntries === JUNIOR_MAX === 3, pulled live)
  //    NEVER triggers the hatch -- the predicate requires maxEntries===4 exactly. --
  {
    const cp = {
      experience: { maxEntries: JUNIOR_MAX, shapes: { '3': [4, 4, 3] } },
      projects: { byCount: { '3': [3, 3, 3] } },
    };
    const positions = [
      rawPos('e1', { relevanceScore: 90, tenureMonths: 40, endDate: isoDaysAgo(30), isMostRecent: true, achievements: 5 }),
      rawPos('e2', { relevanceScore: 85, tenureMonths: 36, endDate: isoDaysAgo(800), achievements: 5 }),
      rawPos('e3', { relevanceScore: 20, tenureMonths: 12, endDate: isoDaysAgo(2400), achievements: 5 }), // weak, but junior only has 3 to begin with
    ];
    const pass1 = { companies: [{ positions }], selectedProjects: [rawProj('p1', { relevanceScore: 88, descriptionPoints: 3 }), rawProj('p2', { relevanceScore: 82, descriptionPoints: 3 }), rawProj('p3', { relevanceScore: 75, descriptionPoints: 3 })], selectedInternships: [] };
    const result = runAllocator({ pass1, cp, effectiveOrder: ['experience', 'projects'] });
    if (result.expCfgMaxEntries !== JUNIOR_MAX) { console.error(`HARNESS FAIL (f): junior-tier hatch fired (maxEntries !== ${JUNIOR_MAX} predicate should block it) -- expCfgMaxEntries =`, result.expCfgMaxEntries); process.exit(1); }
  }
  console.log(`HARNESS OK (f): junior-tier fixture (cp.experience.maxEntries=${JUNIOR_MAX}, pulled live) never triggers the hatch -- maxEntries===4 predicate correctly excludes it, value stays ${JUNIOR_MAX}`);

  // -- (g) legacy/no-plan passthrough: no _plan.countPlan at all -- pass1 passes
  //    through byte-identical. Run the REAL patched top-level code (not just the
  //    inner allocator slice) via new Function against a stub $input/$-style env. --
  {
    const fakeInputJson = { text: JSON.stringify({ companies: [{ positions: [{ id: 'x', keyAchievements: ['a'] }] }], someOtherField: 'unchanged' }) };
    const env = {
      $input: { first: () => ({ json: fakeInputJson }) },
      $getWorkflowStaticData: () => ({}),
      $: (name) => ({ first: () => ({ json: {} }) }), // Build Pass1 Context lookup returns {} -> no .plan -> _plan stays null
    };
    const fn = new Function('$input', '$getWorkflowStaticData', '$', patched);
    const result = fn(env.$input, env.$getWorkflowStaticData, env.$);
    const pass1Out = result[0].json.pass1;
    const expectedPass1 = JSON.parse(fakeInputJson.text);
    if (JSON.stringify(pass1Out) !== JSON.stringify(expectedPass1)) {
      console.error('HARNESS FAIL (g): legacy no-plan passthrough is not byte-identical. Got', JSON.stringify(pass1Out), 'expected', JSON.stringify(expectedPass1)); process.exit(1);
    }
    if (pass1Out._contentPlan !== undefined) { console.error('HARNESS FAIL (g): pass1._contentPlan should not exist when there is no countPlan'); process.exit(1); }
  }
  console.log('HARNESS OK (g): no _plan.countPlan -- pass1 passes through completely unmodified (byte-identical in/out), whole allocator block (incl. new hatch logic) stays inertly self-disabling');

  // -- (h) regression: no fixture throws; trimToLineBudget's own floor values
  //    (mandatory ? 2 : 1) are unchanged, re-derived fresh from the patched code. --
  {
    const floorLine = patched.match(/const floor = i\.mandatory \? (\d+) : (\d+);/);
    if (!floorLine || floorLine[1] !== '2' || floorLine[2] !== '1') {
      console.error('HARNESS FAIL (h): trimToLineBudget floor values changed -- expected "i.mandatory ? 2 : 1", got', floorLine && floorLine[0]); process.exit(1);
    }
    // s51/s59-era spirit: mid 6-position fixture (more positions than maxEntries),
    // with one position carrying no endDate at all (missing-date fixture spirit).
    // Confirm nothing throws and alloc is non-empty.
    const cp6 = {
      experience: { maxEntries: 4, shapes: { '4': [4, 3, 3, 2] } },
      projects: { byCount: { '4': [2, 2] } },
    };
    const positions6 = [
      rawPos('p1', { relevanceScore: 90, tenureMonths: 12, endDate: isoDaysAgo(10), isMostRecent: true, achievements: 4 }),
      rawPos('p2', { relevanceScore: 85, tenureMonths: 24, endDate: isoDaysAgo(400), achievements: 4 }),
      rawPos('p3', { relevanceScore: 80, tenureMonths: 36, endDate: isoDaysAgo(800), achievements: 4 }),
      rawPos('p4', { relevanceScore: 75, tenureMonths: 48, endDate: isoDaysAgo(1200), achievements: 4 }),
      rawPos('p5', { relevanceScore: 70, tenureMonths: 60, endDate: isoDaysAgo(1600), achievements: 4 }),
      rawPos('p6', { relevanceScore: 65, tenureMonths: 90, endDate: undefined, achievements: 4 }), // missing date
    ];
    const projects6 = [rawProj('pr1', { relevanceScore: 60, descriptionPoints: 2 }), rawProj('pr2', { relevanceScore: 55, descriptionPoints: 2 })];
    const pass1_6 = { companies: [{ positions: positions6 }], selectedProjects: projects6, selectedInternships: [] };
    let threw = false;
    try {
      const result = runAllocator({ pass1: pass1_6, cp: cp6, effectiveOrder: ['experience', 'projects'], sections: { experience: { lineBudget: 12 } } });
      if (Object.keys(result.alloc).length === 0) throw new Error('empty alloc');
    } catch (e) { threw = true; console.error('HARNESS FAIL (h): regression fixture threw:', e.message); }
    if (threw) process.exit(1);
  }
  console.log('HARNESS OK (h): no fixture throws (6-position + missing-date regression fixture); trimToLineBudget floor values re-derived from patched code are literally 2 (mandatory) and 1 (other), unchanged');

  // -- 9. out-of-scope nodes untouched (sanity: catches accidental aliasing). --
  {
    const wf2 = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
    const N2 = {}; wf2.nodes.forEach((n) => { N2[n.name] = n; });
    for (const name of OUT_OF_SCOPE_NODES) {
      if (JSON.stringify(N[name]) !== JSON.stringify(N2[name])) { console.error(`HARNESS FAIL: out-of-scope node "${name}" differs between two fresh reads (should be impossible)`); process.exit(1); }
    }
  }
  console.log('HARNESS OK: out-of-scope nodes (5 LaTeX-family nodes + Build Pass1 Context + Pass1 Selection + Pass2 Generate + Pass2 Regen + ReviseForge) confirmed untouched');

  console.log('HARNESS: ALL CHECKS PASSED');
})();

patch(TARGET);
console.log('S137 (Parse Pass1 countPriority + 3+3 experience/project escape hatch) complete.');
