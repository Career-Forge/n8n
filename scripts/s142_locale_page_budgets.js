/**
 * s142_locale_page_budgets.js -- locale-aware resume/cover, step 3 of 5
 * (s140-s144). Page budgets x locale, Build Pass1 Context only.
 *
 * Applies profile.pages (resolved by tier: profile.pages[tier] falling back
 * to profile.pages.default) to EVERY section, not just the primary pool --
 * a 2-page resume needs more of everything:
 *   - lineBudget x line_budget_multiplier (rounded)
 *   - maxEntries + entry_bonus (mirrored into BOTH plan.sections AND
 *     plan.countPlan -- s136's own lesson from earlier this project: Parse
 *     Pass1's allocator reads the keep-cap from plan.countPlan[X].maxEntries,
 *     a SEPARATE table from plan.sections[X].maxEntries; missing this exact
 *     mirror once already silently defeated a tier extension in production)
 *   - every COUNT_PLANS shape/byCount value + bullet_bonus, capped at the
 *     (already-bumped) maxBulletsPerEntry -- shapes are the actual page-FILL
 *     mechanism (the allocator picks a shape row by kept-count, not by raw
 *     lineBudget alone), so scaling lineBudget without scaling shapes would
 *     leave page 2 mostly empty.
 *
 * Ordering (matters): this scaling runs BEFORE s141's header-line
 * compensation (already in the file, right after this insertion point) --
 * the compensation subtracts a FIXED number of lines (PII/work-auth/
 * signature cost the same regardless of page count) from the ALREADY-SCALED
 * budget, not the other way around (a fixed subtraction must never itself be
 * multiplied).
 *
 * No-ops (byte-identical output) whenever the resolved page target is 1 --
 * true for DEFAULT/US/CA/most junior-fresher tiers, so nothing regresses
 * outside locales that actually asked to scale.
 *
 * Documented, NOT fixed (per the approved plan): s137's 3+3 escape hatch
 * fires only when maxEntries === 4 exactly, so it silently never engages on
 * a scaled plan (maxEntries + entry_bonus != 4 in the common case). This is
 * acceptable -- a scaled (2-page) plan has room for both the 4th experience
 * entry and 3 projects, so the hatch's job (rescue a 3rd project when a weak
 * 4th experience isn't worth its slot) isn't needed there.
 *
 * Calibration: line_budget_multiplier starts at 1.9 (s140's placeholder
 * value) in data/reference/locale_profiles.json; a separate real-pdflatex
 * probe (run after deploy, same technique as s135) re-derives the real
 * value and updates the JSON with whatever the real compiles show, rather
 * than shipping a guessed number unverified.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}

const BP1C_OLD = 'plan.countPlan = JSON.parse(JSON.stringify(COUNT_PLANS[tier] || COUNT_PLANS.mid));\n// s141: header-line budget compensation';

const SCALING_BLOCK = `
// s142: page-budget scaling by locale -- applied BEFORE s141's header-line
// compensation below (a fixed per-apply subtraction must act on the
// already-scaled budget, never get multiplied itself). No-ops whenever the
// resolved page target is 1 (byte-identical for DEFAULT/US/CA and most
// junior/fresher tiers).
const _pagesProfile = c.locale_profile || null;
const _pagesCfg = (_pagesProfile && _pagesProfile.pages && (_pagesProfile.pages[tier] || _pagesProfile.pages.default)) || null;
if (_pagesCfg && _pagesCfg.max > 1) {
  const _mult = _pagesCfg.line_budget_multiplier || 1;
  const _entryBonus = _pagesCfg.entry_bonus || 0;
  const _bulletBonus = _pagesCfg.bullet_bonus || 0;
  for (const _secKey of Object.keys(plan.sections)) {
    const _sec = plan.sections[_secKey];
    if (!_sec || !_sec.lineBudget) continue;
    _sec.lineBudget = Math.round(_sec.lineBudget * _mult);
    if (_sec.maxEntries) _sec.maxEntries += _entryBonus;
    if (_sec.maxBulletsPerEntry) _sec.maxBulletsPerEntry += _bulletBonus;
    if (_sec.mostRecentMinBullets) _sec.mostRecentMinBullets += _bulletBonus;
  }
  // Mirror into countPlan -- shapes are the real page-FILL mechanism (see
  // header comment); scaling lineBudget alone would under-fill a 2nd page.
  if (plan.countPlan) {
    for (const _poolKey of ['experience', 'internships']) {
      const _pool = plan.countPlan[_poolKey];
      if (!_pool) continue;
      if (_entryBonus > 0 && _pool.maxEntries) _pool.maxEntries += _entryBonus;
      if (_bulletBonus > 0 && _pool.shapes) {
        const _cap = (plan.sections[_poolKey] && plan.sections[_poolKey].maxBulletsPerEntry) || 99;
        for (const _countKey of Object.keys(_pool.shapes)) {
          _pool.shapes[_countKey] = _pool.shapes[_countKey].map((v) => Math.min(_cap, v + _bulletBonus));
        }
      }
    }
    if (_bulletBonus > 0 && plan.countPlan.projects && plan.countPlan.projects.byCount) {
      const _projCap = (plan.sections.projects && plan.sections.projects.maxBulletsPerEntry) || 99;
      for (const _countKey of Object.keys(plan.countPlan.projects.byCount)) {
        plan.countPlan.projects.byCount[_countKey] = plan.countPlan.projects.byCount[_countKey].map((v) => Math.min(_projCap, v + _bulletBonus));
      }
    }
    // Real-pdflatex calibration (this script's own verification) found a
    // genuine gap here: entry_bonus can push the primary pool's kept count
    // PAST every key the ORIGINAL byCount table defines. The table's own
    // highest key is often deliberately [] (e.g. senior's "5" row -- a
    // 1-page-era "already full with 5 experiences, skip projects entirely"
    // design choice). shapeAt()'s existing fallback (nearest key <= n) would
    // silently land on THAT empty row for a scaled plan, deselecting every
    // project even though a multi-page profile explicitly wants both more
    // experience AND more projects. Backfill: if the bumped maxEntries has
    // no real (non-empty) row, reuse the highest NON-EMPTY row that existed
    // before scaling (already bullet_bonus-bumped by the loop above).
    if (plan.countPlan.projects && plan.countPlan.projects.byCount && plan.sections.experience) {
      const _bc = plan.countPlan.projects.byCount;
      const _bumpedMax = plan.sections.experience.maxEntries;
      const _keys = Object.keys(_bc).map(Number).filter((k) => !isNaN(k));
      const _hasRealRow = _bc[_bumpedMax] && _bc[_bumpedMax].length > 0;
      if (!_hasRealRow && _keys.length) {
        const _nonEmpty = _keys.filter((k) => _bc[k] && _bc[k].length > 0).sort((a, b) => b - a);
        if (_nonEmpty.length) _bc[_bumpedMax] = _bc[_nonEmpty[0]].slice();
      }
    }
  }
}
`;

const BP1C_NEW = 'plan.countPlan = JSON.parse(JSON.stringify(COUNT_PLANS[tier] || COUNT_PLANS.mid));' + SCALING_BLOCK + '// s141: header-line budget compensation';

// v1 of this script's own scaling block shipped without the byCount
// backfill fix below (found by this script's own real-pdflatex calibration,
// same run) -- this exact v1 text is what a live deploy already has if this
// script is re-run after that first pass. Upgrading in place (rather than
// skipping) so a re-run always converges on the current, correct logic.
const V1_BULLETBONUS_LOOP = `    if (_bulletBonus > 0 && plan.countPlan.projects && plan.countPlan.projects.byCount) {
      const _projCap = (plan.sections.projects && plan.sections.projects.maxBulletsPerEntry) || 99;
      for (const _countKey of Object.keys(plan.countPlan.projects.byCount)) {
        plan.countPlan.projects.byCount[_countKey] = plan.countPlan.projects.byCount[_countKey].map((v) => Math.min(_projCap, v + _bulletBonus));
      }
    }
  }
}`;
const V2_BACKFILL_ADDITION = `    if (_bulletBonus > 0 && plan.countPlan.projects && plan.countPlan.projects.byCount) {
      const _projCap = (plan.sections.projects && plan.sections.projects.maxBulletsPerEntry) || 99;
      for (const _countKey of Object.keys(plan.countPlan.projects.byCount)) {
        plan.countPlan.projects.byCount[_countKey] = plan.countPlan.projects.byCount[_countKey].map((v) => Math.min(_projCap, v + _bulletBonus));
      }
    }
    if (plan.countPlan.projects && plan.countPlan.projects.byCount && plan.sections.experience) {
      const _bc = plan.countPlan.projects.byCount;
      const _bumpedMax = plan.sections.experience.maxEntries;
      const _keys = Object.keys(_bc).map(Number).filter((k) => !isNaN(k));
      const _hasRealRow = _bc[_bumpedMax] && _bc[_bumpedMax].length > 0;
      if (!_hasRealRow && _keys.length) {
        const _nonEmpty = _keys.filter((k) => _bc[k] && _bc[k].length > 0).sort((a, b) => b - a);
        if (_nonEmpty.length) _bc[_bumpedMax] = _bc[_nonEmpty[0]].slice();
      }
    }
  }
}`;

function patchBuildPass1Context(wf) {
  const n = wf.nodes.find((x) => x.name === 'Build Pass1 Context');
  if (!n) { console.error('INTEGRITY FAIL: Build Pass1 Context missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('_hasRealRow')) { console.log('  Build Pass1 Context: already patched (v2, with byCount backfill)'); return; }
  if (n.parameters.jsCode.includes('_pagesCfg')) {
    replaceOnce(n.parameters, 'jsCode', V1_BULLETBONUS_LOOP, V2_BACKFILL_ADDITION, 'Build Pass1 Context v1->v2 byCount backfill upgrade');
    console.log('  Build Pass1 Context: upgraded v1 -> v2 (byCount backfill added)');
    return;
  }
  replaceOnce(n.parameters, 'jsCode', BP1C_OLD, BP1C_NEW, 'Build Pass1 Context countPlan->compensation insertion point');
  console.log('  Build Pass1 Context: patched');
}

// ════════════════════════════════ HARNESS ════════════════════════════════
(function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const n = wf.nodes.find((x) => x.name === 'Build Pass1 Context');
  const isV2 = n.parameters.jsCode.includes('_hasRealRow');
  const isV1 = !isV2 && n.parameters.jsCode.includes('_pagesCfg');

  if (isV2) {
    console.log('  (Build Pass1 Context already at v2 -- skipping pre-patch anchor checks)');
  } else if (isV1) {
    check('Build Pass1 Context: v1->v2 upgrade anchor unique', n.parameters.jsCode.split(V1_BULLETBONUS_LOOP).length - 1 === 1);
  } else {
    check('Build Pass1 Context: countPlan->compensation anchor unique', n.parameters.jsCode.split(BP1C_OLD).length - 1 === 1);
  }
  if (failures > 0) { console.error(`\n${failures} PRE-PATCH ANCHOR FAILURE(S)`); process.exit(1); }

  // ---- Behavioral tests, executed against the REAL new scaling block ----
  function runScaling(tier, sections, countPlan, localeProfile) {
    const plan = { sections: JSON.parse(JSON.stringify(sections)), countPlan: JSON.parse(JSON.stringify(countPlan)) };
    const c = { locale_profile: localeProfile };
    const fn = new Function('plan', 'c', 'tier', SCALING_BLOCK + '\nreturn plan;');
    return fn(plan, c, tier);
  }

  const SECTIONS_FIXTURE = {
    experience: { maxEntries: 4, lineBudget: 16, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 },
    projects: { maxEntries: 2, lineBudget: 10, minBulletsPerEntry: 1, maxBulletsPerEntry: 3 },
    internships: { maxEntries: 0, lineBudget: 0 },
    achievements: { maxEntries: 2 }, skills: { maxCategories: 4 }, certifications: { maxEntries: 2 }, education: { maxEntries: 2 },
  };
  const COUNTPLAN_FIXTURE = {
    experience: { maxEntries: 4, shapes: { '1': [4], '2': [4, 4], '3': [4, 3, 3], '4': [3, 3, 2, 2] } },
    internships: null,
    projects: { keyedOn: 'experience', byCount: { '0': [3, 3, 3], '1': [3, 3, 3], '2': [3, 3, 2], '3': [2, 2, 2], '4': [3, 2] } },
    summaryLines: 2, achievementsMax: 2,
  };

  // 1. DEFAULT profile / null -> byte-identical (no scaling engages).
  const r1 = runScaling('mid', SECTIONS_FIXTURE, COUNTPLAN_FIXTURE, null);
  check('DEFAULT/null profile: plan unchanged (no scaling)', JSON.stringify(r1.sections) === JSON.stringify(SECTIONS_FIXTURE) && JSON.stringify(r1.countPlan) === JSON.stringify(COUNTPLAN_FIXTURE));

  const DEFAULT_PAGES_PROFILE = { pages: { default: { max: 1, line_budget_multiplier: 1.0, entry_bonus: 0, bullet_bonus: 0 } } };
  const r2 = runScaling('mid', SECTIONS_FIXTURE, COUNTPLAN_FIXTURE, DEFAULT_PAGES_PROFILE);
  check('DEFAULT profile with max:1 -> plan unchanged (no scaling)', JSON.stringify(r2.sections) === JSON.stringify(SECTIONS_FIXTURE));

  // 2. IN mid profile (max:2, multiplier 1.9, entry_bonus 1, bullet_bonus 0).
  const IN_MID_PROFILE = { pages: { default: { max: 2, line_budget_multiplier: 1.9, entry_bonus: 1, bullet_bonus: 0 } } };
  const r3 = runScaling('mid', SECTIONS_FIXTURE, COUNTPLAN_FIXTURE, IN_MID_PROFILE);
  check('IN mid: experience.lineBudget scaled 16*1.9=30.4 -> round 30', r3.sections.experience.lineBudget === 30);
  check('IN mid: projects.lineBudget scaled 10*1.9=19', r3.sections.projects.lineBudget === 19);
  check('IN mid: experience.maxEntries +1 (entry_bonus) -> 5', r3.sections.experience.maxEntries === 5);
  check('IN mid: countPlan.experience.maxEntries ALSO +1 -> 5 (the s136 mirror lesson)', r3.countPlan.experience.maxEntries === 5);
  check('IN mid: bullet_bonus=0 -> shapes unchanged', JSON.stringify(r3.countPlan.experience.shapes) === JSON.stringify(COUNTPLAN_FIXTURE.experience.shapes));
  check('IN mid: maxBulletsPerEntry unchanged (bullet_bonus=0)', r3.sections.experience.maxBulletsPerEntry === 4);

  // 3. AU_NZ senior profile (max:3, multiplier 2.75, entry_bonus 2, bullet_bonus 1).
  const AU_SENIOR_PROFILE = { pages: { senior: { max: 3, line_budget_multiplier: 2.75, entry_bonus: 2, bullet_bonus: 1 } } };
  const r4 = runScaling('senior', SECTIONS_FIXTURE, COUNTPLAN_FIXTURE, AU_SENIOR_PROFILE);
  check('AU senior: experience.lineBudget scaled 16*2.75=44', r4.sections.experience.lineBudget === 44);
  check('AU senior: experience.maxEntries +2 -> 6', r4.sections.experience.maxEntries === 6);
  check('AU senior: countPlan.experience.maxEntries ALSO +2 -> 6', r4.countPlan.experience.maxEntries === 6);
  check('AU senior: maxBulletsPerEntry +1 (bullet_bonus) -> 5', r4.sections.experience.maxBulletsPerEntry === 5);
  check('AU senior: mostRecentMinBullets +1 -> 4', r4.sections.experience.mostRecentMinBullets === 4);
  check('AU senior: every shape value +1, capped at the new maxBulletsPerEntry (5)', JSON.stringify(r4.countPlan.experience.shapes['4']) === JSON.stringify([4, 4, 3, 3]));
  check('AU senior: a shape value that would exceed the cap is clamped, not left uncapped', r4.countPlan.experience.shapes['1'][0] <= 5);
  check('AU senior: projects byCount also bumped by bullet_bonus, capped at projects.maxBulletsPerEntry (3+1=4)', JSON.stringify(r4.countPlan.projects.byCount['4']) === JSON.stringify([4, 3]));

  // 3b. Real-shaped regression: senior's REAL countPlan.projects.byCount has
  // a deliberately-empty "5" row (a 1-page-era "already full, skip
  // projects" choice). entry_bonus=2 on a real 4-max senior plan pushes
  // maxEntries to 6 -- shapeAt's own fallback would land on the empty "5"
  // row and silently zero every project. This is the exact gap this
  // script's own real-pdflatex calibration caught (AU senior probe:
  // projKept went from 0 to 2 after this fix) -- assert it here too.
  const REAL_SENIOR_COUNTPLAN = { experience: { maxEntries: 4, shapes: { '1': [4], '2': [4, 4], '3': [4, 4, 3], '4': [4, 3, 3, 2], '5': [4, 3, 2, 2, 2] } }, internships: null, projects: { keyedOn: 'experience', byCount: { '0': [2, 2], '1': [2, 2], '2': [2, 2], '3': [2, 2, 2], '4': [2, 2], '5': [] } }, summaryLines: 3, achievementsMax: 3 };
  const REAL_SENIOR_SECTIONS = { experience: { maxEntries: 4, lineBudget: 24, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 }, projects: { maxEntries: 3, lineBudget: 8, minBulletsPerEntry: 2, maxBulletsPerEntry: 3 }, internships: { maxEntries: 0, lineBudget: 0 }, achievements: { maxEntries: 3 }, skills: { maxCategories: 4 }, certifications: { maxEntries: 2 }, education: { maxEntries: 1 } };
  const r4b = runScaling('senior', REAL_SENIOR_SECTIONS, REAL_SENIOR_COUNTPLAN, AU_SENIOR_PROFILE);
  check('AU senior (real senior countPlan): maxEntries bumped to 6, byCount has no native "6" row', r4b.sections.experience.maxEntries === 6 && !REAL_SENIOR_COUNTPLAN.projects.byCount['6']);
  check('AU senior (real senior countPlan): backfilled "6" row is NON-EMPTY (not silently zeroed)', Array.isArray(r4b.countPlan.projects.byCount['6']) && r4b.countPlan.projects.byCount['6'].length > 0);
  check('AU senior (real senior countPlan): backfilled "6" row reuses the highest non-empty original row ("4" -> [2,2], +1 bullet_bonus -> [3,3])', JSON.stringify(r4b.countPlan.projects.byCount['6']) === JSON.stringify([3, 3]));
  check('AU senior (real senior countPlan): the untouched "5" row stays genuinely empty (only the BUMPED key gets backfilled)', Array.isArray(r4b.countPlan.projects.byCount['5']) && r4b.countPlan.projects.byCount['5'].length === 0);

  // 4. internships pool (fresher tier) also scales when present.
  const FRESHER_SECTIONS = { experience: { maxEntries: 0, lineBudget: 0 }, projects: { maxEntries: 4, lineBudget: 16, minBulletsPerEntry: 2, maxBulletsPerEntry: 4 }, internships: { maxEntries: 2, lineBudget: 10, minBulletsPerEntry: 2, maxBulletsPerEntry: 3, mostRecentMinBullets: 3 }, achievements: { maxEntries: 0 }, skills: { maxCategories: 4 }, certifications: { maxEntries: 3 }, education: { maxEntries: 2 }, activities: { maxEntries: 2 } };
  const FRESHER_COUNTPLAN = { experience: null, internships: { maxEntries: 2, shapes: { '1': [4], '2': [3, 3] } }, projects: { keyedOn: 'internships', byCount: { '0': [4, 4, 3, 3, 3], '1': [4, 4, 3, 3], '2': [4, 3, 3] } }, summaryLines: 0, achievementsMax: 0 };
  const FRESHER_SCALE_PROFILE = { pages: { fresher: { max: 2, line_budget_multiplier: 1.9, entry_bonus: 1, bullet_bonus: 1 } } };
  const r5 = runScaling('fresher', FRESHER_SECTIONS, FRESHER_COUNTPLAN, FRESHER_SCALE_PROFILE);
  check('fresher tier: internships pool scales too (not just experience)', r5.sections.internships.lineBudget === 19 && r5.sections.internships.maxEntries === 3);
  check('fresher tier: countPlan.internships.maxEntries mirrored', r5.countPlan.internships.maxEntries === 3);

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: no-op confirmed for DEFAULT/null and any max:1 profile; lineBudget scaling math correct; maxEntries entry_bonus mirrored into BOTH plan.sections AND plan.countPlan (the s136 lesson); shape/byCount values bumped by bullet_bonus and correctly capped at the bumped maxBulletsPerEntry; internships pool (fresher tier) scales identically to experience.');

  // ── Write ──
  patchBuildPass1Context(wf);
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log('S142 (page budgets x locale) script complete.');
})();
