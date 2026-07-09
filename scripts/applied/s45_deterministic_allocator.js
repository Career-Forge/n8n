/**
 * s45_deterministic_allocator.js -- v7 sprint, part 4: the deterministic
 * content-budget allocator. Until now every bullet count in the pipeline was
 * a soft LLM instruction ("ensure SINGLE PAGE fit") that nothing enforced --
 * Pass2 was never even told to honor Pass1's bulletCount. This script makes
 * the counts a code decision:
 *
 * 1. Parse Pass1 gains an allocator (after the 4.2a section backstop, same
 *    never-trust-the-LLM idiom): reads the tier plan from Build Pass1
 *    Context, allocates each section's calibrated line budget across
 *    positions by relevance + recency (using Pass1's own tenureMonths /
 *    isMostRecent / relevanceScore signals), enforces entry caps and
 *    per-entry floors (most-recent gets more), reclaims budget from
 *    disabled/empty sections into the primary pool, spills leftovers to the
 *    next bullet-bearing section, and OVERWRITES every bulletCount.
 *    Deselected low-value entries get isSelected=false + bulletCount=0.
 *    Results stamped as pass1._contentPlan. Self-disabling: no plan (old
 *    executions) -> byte-identical legacy behavior.
 *
 * 2. Build Pass2 Input + Build Pass2 Regen Input gain an identical (byte-
 *    for-byte, drift-checkable) buildBudgetBlock() that renders
 *    pass1._contentPlan as a == BULLET BUDGET (MANDATORY) == block in
 *    pass2_user -- the block Pass2's s44 prompt mandate points at. Empty
 *    string when no _contentPlan (legacy safe).
 *
 * Enforcement at render time (trim to the allocation even if Pass2
 * overshoots) is s46 -- the prompts ask, the assembler enforces.
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Parse Pass1: allocator inserted before the return ═══

const PP1_RETURN_OLD = 'return [{json:{pass1:pass1}}];';

const ALLOCATOR_CODE = `// v7 s45: deterministic content-budget allocator -- trusts the plan, never the
// LLM (same idiom as the 4.2a backstop above). Self-disabling: when Build
// Pass1 Context carries no plan (old executions), nothing below changes pass1.
let _plan = null, _tier = null;
try {
  const _bp1 = $('Build Pass1 Context').first().json || {};
  _plan = _bp1.plan || null; _tier = _bp1.tier || null;
} catch (e) { _plan = null; }
if (_plan && _plan.sections && _plan.bulletStyle) {
  const POOL_SECTIONS = ['experience', 'projects', 'internships'];
  const lpb = _plan.bulletStyle.linesPerBullet || 2;
  const effectiveOrder = (Array.isArray(pass1.sectionOrder) && pass1.sectionOrder.length) ? pass1.sectionOrder : _plan.sectionOrder;
  const primary = POOL_SECTIONS.indexOf(_plan.primaryPool) !== -1 ? _plan.primaryPool : 'experience';

  const pools = {};
  for (const s of POOL_SECTIONS) pools[s] = (_plan.sections[s] && _plan.sections[s].lineBudget) || 0;
  for (const s of POOL_SECTIONS) {
    if (effectiveOrder.indexOf(s) === -1 && pools[s] > 0) { pools[primary] += pools[s]; pools[s] = 0; }
  }
  if (effectiveOrder.indexOf('summary') !== -1 && !(pass1.summary && String(pass1.summary).trim())) pools[primary] += _plan.summaryLines || 0;
  const achMax = (_plan.sections.achievements && _plan.sections.achievements.maxEntries) || 0;
  if (achMax > 0 && !(Array.isArray(pass1.selectedAchievements) && pass1.selectedAchievements.length)) pools[primary] += achMax;

  const _endTs = (e) => {
    const s = String(e || '');
    if (/present|current/i.test(s)) return Date.now();
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  };
  const DECAY = [1, 0.7, 0.5, 0.35, 0.25];
  const alloc = {}, deselected = [];

  // items: [{ id, ref, material, mandatory, relevance, endTs, tenure, mostRecentFlag }]
  function allocatePool(items, cfg, linesAvail, sectionName) {
    if (!cfg) { items.forEach((i) => { alloc[i.id] = 0; }); return linesAvail; }
    // rank by recency: mostRecent flag, end date, relevance, tenure
    const ranked = items.slice().sort((a, b) =>
      (b.mostRecentFlag - a.mostRecentFlag)
      || ((b.endTs == null ? -Infinity : b.endTs) - (a.endTs == null ? -Infinity : a.endTs))
      || (b.relevance - a.relevance)
      || (b.tenure - a.tenure));
    ranked.forEach((i, r) => { i.weight = 0.6 * (i.relevance / 100) + 0.4 * (DECAY[Math.min(r, 4)]); });
    const mostRecentId = (ranked.find((i) => i.mostRecentFlag) || ranked[0] || {}).id;

    // entry cap: keep mandatory + best-weight others
    const maxEntries = typeof cfg.maxEntries === 'number' ? cfg.maxEntries : ranked.length;
    let kept = ranked.filter((i) => i.mandatory);
    for (const i of ranked.slice().sort((a, b) => b.weight - a.weight)) {
      if (kept.length >= maxEntries) break;
      if (kept.indexOf(i) === -1) kept.push(i);
    }
    for (const i of ranked) {
      if (kept.indexOf(i) === -1) { alloc[i.id] = 0; deselected.push(i.id); if (i.ref) { i.ref.isSelected = false; i.ref.bulletCount = 0; } }
    }
    if (!kept.length || linesAvail <= 0) { kept.forEach((i) => { alloc[i.id] = 0; if (i.ref) i.ref.bulletCount = 0; }); return linesAvail; }

    let bullets = Math.floor(linesAvail / lpb);
    const minB = cfg.minBulletsPerEntry || 1, maxB = cfg.maxBulletsPerEntry || 4;
    const capFor = (i) => Math.min(maxB, Math.max(1, i.material)); // material-capped, floor 1
    const floorOverride = {};
    const floorFor = (i) => floorOverride[i.id] != null ? floorOverride[i.id]
      : Math.min(i.id === mostRecentId ? (cfg.mostRecentMinBullets || minB) : minB, capFor(i));

    for (let guard = 0; guard < 50; guard++) {
      const sum = kept.reduce((a, i) => a + floorFor(i), 0);
      if (sum <= bullets) break;
      const droppable = kept.filter((i) => !i.mandatory).sort((a, b) => a.weight - b.weight);
      if (droppable.length) {
        const d = droppable[0];
        kept = kept.filter((i) => i !== d);
        alloc[d.id] = 0; deselected.push(d.id);
        if (d.ref) { d.ref.isSelected = false; d.ref.bulletCount = 0; }
        continue;
      }
      const reducible = kept.filter((i) => i.id !== mostRecentId && floorFor(i) > 1).sort((a, b) => a.weight - b.weight);
      if (reducible.length) { floorOverride[reducible[0].id] = 1; continue; }
      floorOverride[mostRecentId] = Math.max(1, bullets - (kept.length - 1)); // last resort
      break;
    }

    const counts = {};
    kept.forEach((i) => { counts[i.id] = floorFor(i); });
    let remaining = bullets - kept.reduce((a, i) => a + counts[i.id], 0);
    const byWeight = kept.slice().sort((a, b) => b.weight - a.weight);
    let changed = true;
    while (remaining > 0 && changed) {
      changed = false;
      for (const i of byWeight) {
        if (remaining <= 0) break;
        if (counts[i.id] < capFor(i)) { counts[i.id]++; remaining--; changed = true; }
      }
    }
    let used = 0;
    kept.forEach((i) => { alloc[i.id] = counts[i.id]; used += counts[i.id]; if (i.ref) i.ref.bulletCount = counts[i.id]; });
    return linesAvail - used * lpb;
  }

  const sectionItems = {
    experience: () => {
      const items = [];
      for (const comp of (pass1.companies || [])) {
        for (const pos of (comp.positions || [])) {
          if (!pos || pos.isSelected === false) continue;
          items.push({ id: pos.id, ref: pos, material: (pos.keyAchievements || []).length, mandatory: pos.isMostRecent === true || pos.isLongestTenure === true, relevance: typeof pos.relevanceScore === 'number' ? pos.relevanceScore : 50, endTs: _endTs(pos.endDate), tenure: pos.tenureMonths || 0, mostRecentFlag: pos.isMostRecent === true ? 1 : 0 });
        }
      }
      return items;
    },
    projects: () => (pass1.selectedProjects || []).map((pj, idx) => pj && ({ id: pj.id || ('proj_' + idx), ref: pj, material: (pj.descriptionPoints || []).length, mandatory: idx === 0, relevance: typeof pj.relevanceScore === 'number' ? pj.relevanceScore : (90 - idx * 10), endTs: null, tenure: 0, mostRecentFlag: 0 })).filter(Boolean),
    internships: () => (pass1.selectedInternships || []).map((it, idx) => it && ({ id: it.id || ('intern_' + idx), ref: it, material: (it.keyAchievements || []).length, mandatory: idx === 0, relevance: typeof it.relevanceScore === 'number' ? it.relevanceScore : 50, endTs: _endTs(it.endDate), tenure: it.tenureMonths || 0, mostRecentFlag: 0 })).filter(Boolean),
  };

  let carry = 0;
  const finalPools = {};
  for (const s of effectiveOrder) {
    if (POOL_SECTIONS.indexOf(s) === -1) continue;
    const linesAvail = pools[s] + carry;
    finalPools[s] = linesAvail;
    carry = Math.max(0, allocatePool(sectionItems[s](), _plan.sections[s], linesAvail, s));
  }

  const maxBOverPools = Math.max.apply(null, POOL_SECTIONS.map((s) => (_plan.sections[s] && _plan.sections[s].maxBulletsPerEntry) || 0).concat([1]));
  pass1._contentPlan = {
    tier: _tier,
    linesPerBullet: lpb,
    targetChars: _plan.bulletStyle.targetChars,
    directive: _plan.bulletStyle.directive,
    budgets: finalPools,
    alloc: alloc,
    deselected: deselected,
    maxBulletsPerEntry: maxBOverPools,
    achievementsMax: achMax,
  };
}
return [{json:{pass1:pass1}}];`;

// ═══ 2. budgetBlock builder -- byte-identical in both Build Pass2 nodes ═══

const BUDGET_BLOCK_FN = `function buildBudgetBlock(p1) {
  const cp = p1 && p1._contentPlan;
  if (!cp || !cp.alloc) return '';
  const lines = [];
  for (const comp of (p1.companies || [])) {
    for (const pos of (comp.positions || [])) {
      if (!pos || pos.isSelected === false) continue;
      if (cp.alloc[pos.id] != null) lines.push('- position ' + pos.id + ' (' + (pos.title || '') + '): ' + cp.alloc[pos.id] + ' bullets');
    }
  }
  for (const it of (p1.selectedInternships || [])) { if (it && it.isSelected !== false && cp.alloc[it.id] != null) lines.push('- internship ' + it.id + ' (' + (it.title || '') + '): ' + cp.alloc[it.id] + ' bullets'); }
  for (const pj of (p1.selectedProjects || [])) { if (pj && pj.isSelected !== false && cp.alloc[pj.id] != null) lines.push('- project ' + pj.id + ' (' + (pj.name || '') + '): ' + cp.alloc[pj.id] + ' bullets'); }
  if (!lines.length) return '';
  return '\\n\\n== BULLET BUDGET (MANDATORY) ==\\nTier: ' + (cp.tier || 'unknown') + '. Style: ' + (cp.directive || '') + '\\nWrite EXACTLY these bullet counts per entry:\\n' + lines.join('\\n');
}
`;

const BP2_INPUT_ANCHOR = 'const pass2Input = JSON.stringify({ decisions: pass1, jdRequirements: step0.clusters || [] });';

const BP2_CONCAT_OLD = "+ antiHalluc + '\\n\\n' + pass2Input;";
const BP2_CONCAT_NEW = "+ antiHalluc + buildBudgetBlock(pass1) + '\\n\\n' + pass2Input;";

const BP2R_CONCAT_OLD = "+ antiHalluc + atsGuidance + '\\n\\n' + pass2Input;";
const BP2R_CONCAT_NEW = "+ antiHalluc + atsGuidance + buildBudgetBlock(pass1) + '\\n\\n' + pass2Input;";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const need of ['Parse Pass1', 'Build Pass2 Input', 'Build Pass2 Regen Input']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Parse Pass1'].parameters.jsCode.includes('_contentPlan')) { console.log(`  ${base}: already patched`); return; }

  // 1. Parse Pass1
  {
    const code = N['Parse Pass1'].parameters.jsCode;
    const count = code.split(PP1_RETURN_OLD).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: Parse Pass1 return anchor found ${count} times`); process.exit(1); }
    N['Parse Pass1'].parameters.jsCode = code.replace(PP1_RETURN_OLD, ALLOCATOR_CODE);
  }

  // 2. Build Pass2 Input
  {
    let code = N['Build Pass2 Input'].parameters.jsCode;
    for (const [name, a] of [['pass2Input line', BP2_INPUT_ANCHOR], ['concat', BP2_CONCAT_OLD]]) {
      const count = code.split(a).length - 1;
      if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: Build Pass2 Input anchor "${name}" found ${count} times`); process.exit(1); }
    }
    code = code.replace(BP2_INPUT_ANCHOR, BUDGET_BLOCK_FN + BP2_INPUT_ANCHOR);
    code = code.replace(BP2_CONCAT_OLD, BP2_CONCAT_NEW);
    N['Build Pass2 Input'].parameters.jsCode = code;
  }

  // 3. Build Pass2 Regen Input
  {
    let code = N['Build Pass2 Regen Input'].parameters.jsCode;
    for (const [name, a] of [['pass2Input line', BP2_INPUT_ANCHOR], ['concat', BP2R_CONCAT_OLD]]) {
      const count = code.split(a).length - 1;
      if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: Build Pass2 Regen Input anchor "${name}" found ${count} times`); process.exit(1); }
    }
    code = code.replace(BP2_INPUT_ANCHOR, BUDGET_BLOCK_FN + BP2_INPUT_ANCHOR);
    code = code.replace(BP2R_CONCAT_OLD, BP2R_CONCAT_NEW);
    N['Build Pass2 Regen Input'].parameters.jsCode = code;
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: allocator in Parse Pass1, budgetBlock in both Build Pass2 nodes`);
}

// ── harness ──
(function harness() {
  const file = TARGETS.find((f) => fs.existsSync(f));
  if (!file) { console.error('HARNESS FAIL: no target file'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  // Build patched Parse Pass1 in memory.
  let pp1 = N['Parse Pass1'].parameters.jsCode;
  if (!pp1.includes('_contentPlan')) {
    const count = pp1.split(PP1_RETURN_OLD).length - 1;
    if (count !== 1) { console.error(`HARNESS FAIL: Parse Pass1 return anchor found ${count}x live`); process.exit(1); }
    pp1 = pp1.replace(PP1_RETURN_OLD, ALLOCATOR_CODE);
  }

  // plan fixtures mirroring s44's calibrated TIER_PLANS
  const PLANS = {
    senior: { sectionOrder: ['summary', 'experience', 'skills', 'achievements', 'certifications', 'education'], summaryLines: 3, bulletStyle: { linesPerBullet: 2, targetChars: [150, 200], directive: 'impact' }, primaryPool: 'experience', sections: { experience: { maxEntries: 5, lineBudget: 22, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 }, projects: { maxEntries: 0, lineBudget: 0 }, internships: { maxEntries: 0, lineBudget: 0 }, achievements: { maxEntries: 3 }, skills: { maxCategories: 4 }, certifications: { maxEntries: 2 }, education: { maxEntries: 1 } } },
    mid: { sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'], summaryLines: 2, bulletStyle: { linesPerBullet: 2, targetChars: [150, 200], directive: 'impact' }, primaryPool: 'experience', sections: { experience: { maxEntries: 4, lineBudget: 16, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 }, projects: { maxEntries: 2, lineBudget: 6, minBulletsPerEntry: 1, maxBulletsPerEntry: 2 }, internships: { maxEntries: 0, lineBudget: 0 }, achievements: { maxEntries: 2 }, skills: { maxCategories: 4 }, certifications: { maxEntries: 2 }, education: { maxEntries: 2 } } },
    junior: { sectionOrder: ['education', 'experience', 'projects', 'skills', 'certifications'], summaryLines: 0, bulletStyle: { linesPerBullet: 1, targetChars: [70, 110], directive: 'skills' }, primaryPool: 'experience', sections: { experience: { maxEntries: 3, lineBudget: 16, minBulletsPerEntry: 3, maxBulletsPerEntry: 5, mostRecentMinBullets: 4 }, projects: { maxEntries: 3, lineBudget: 12, minBulletsPerEntry: 2, maxBulletsPerEntry: 4 }, internships: { maxEntries: 0, lineBudget: 0 }, achievements: { maxEntries: 0 }, skills: { maxCategories: 4 }, certifications: { maxEntries: 2 }, education: { maxEntries: 2 } } },
    fresher: { sectionOrder: ['education', 'projects', 'internships', 'skills', 'activities'], summaryLines: 0, bulletStyle: { linesPerBullet: 1, targetChars: [70, 110], directive: 'skills' }, primaryPool: 'projects', sections: { experience: { maxEntries: 0, lineBudget: 0 }, projects: { maxEntries: 4, lineBudget: 16, minBulletsPerEntry: 2, maxBulletsPerEntry: 4 }, internships: { maxEntries: 2, lineBudget: 10, minBulletsPerEntry: 2, maxBulletsPerEntry: 3, mostRecentMinBullets: 3 }, achievements: { maxEntries: 0 }, skills: { maxCategories: 4 }, certifications: { maxEntries: 3 }, education: { maxEntries: 2 }, activities: { maxEntries: 2 } } },
  };

  function runParsePass1(pass1Fixture, plan, tier, prefs) {
    const $mock = (name) => {
      if (name === 'Build Pass1 Context') {
        if (plan === undefined) throw new Error('no_execution_data');
        return { first: () => ({ json: { plan, tier } }) };
      }
      throw new Error('no_execution_data: ' + name);
    };
    const $input = { first: () => ({ json: { text: JSON.stringify(pass1Fixture) } }) };
    const fn = new Function('$input', '$', '$getWorkflowStaticData', pp1);
    return fn($input, $mock, () => ({ user_prefs: prefs || {} }))[0].json.pass1;
  }

  function pos(id, opts) {
    return Object.assign({ id, title: 'T' + id, startDate: 'Jan 2018', endDate: 'Dec 2020', tenureMonths: 24, isMostRecent: false, isLongestTenure: false, isSelected: true, relevanceScore: 50, bulletCount: 3, keyAchievements: ['a', 'b', 'c', 'd', 'e'] }, opts);
  }

  // 1. senior 6-position fixture: entry cap 5, most-recent floor 3, budget 22 lines (11 bullets)
  {
    const fixture = {
      sectionOrder: ['summary', 'experience', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'A real senior summary.',
      selectedAchievements: [{ title: 'x' }],
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 95 })] },
        { company: 'B', positions: [pos('p2', { isLongestTenure: true, endDate: 'Dec 2022', tenureMonths: 60, relevanceScore: 70 })] },
        { company: 'C', positions: [pos('p3', { endDate: 'Jun 2021', relevanceScore: 60 })] },
        { company: 'D', positions: [pos('p4', { endDate: 'Jan 2020', relevanceScore: 55 })] },
        { company: 'E', positions: [pos('p5', { endDate: 'Mar 2019', relevanceScore: 40 })] },
        { company: 'F', positions: [pos('p6', { endDate: 'Feb 2018', relevanceScore: 20 })] },
      ],
      selectedProjects: [], selectedInternships: [],
    };
    const out = runParsePass1(fixture, PLANS.senior, 'senior');
    const cp = out._contentPlan;
    if (!cp) { console.error('HARNESS FAIL: senior -- no _contentPlan stamped'); process.exit(1); }
    const positions = out.companies.flatMap((c) => c.positions);
    const kept = positions.filter((p) => p.isSelected !== false);
    if (kept.length !== 5) { console.error('HARNESS FAIL: senior entry cap -- expected 5 kept, got', kept.length); process.exit(1); }
    const dropped = positions.find((p) => p.isSelected === false);
    if (!dropped || dropped.id !== 'p6') { console.error('HARNESS FAIL: senior -- expected lowest-value p6 deselected, got', dropped && dropped.id); process.exit(1); }
    if (dropped.bulletCount !== 0) { console.error('HARNESS FAIL: senior -- deselected position bulletCount must be 0'); process.exit(1); }
    const p1c = kept.find((p) => p.id === 'p1').bulletCount;
    if (p1c < 3) { console.error('HARNESS FAIL: senior -- most-recent floor 3 violated, got', p1c); process.exit(1); }
    const totalLines = kept.reduce((a, p) => a + p.bulletCount, 0) * 2;
    if (totalLines > 22) { console.error('HARNESS FAIL: senior -- total', totalLines, 'lines exceeds 22 budget'); process.exit(1); }
    if (totalLines < 18) { console.error('HARNESS FAIL: senior -- budget badly underused:', totalLines, 'of 22'); process.exit(1); }
    for (const p of kept) { if (p.bulletCount === 99) { console.error('HARNESS FAIL: LLM bulletCount not overwritten'); process.exit(1); } }
  }

  // 2. mid 1-position fixture: cap 4, leftover spills into projects
  {
    const fixture = {
      sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'Mid summary.',
      selectedAchievements: [{ title: 'x' }],
      companies: [{ company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 90, bulletCount: 99 })] }],
      selectedProjects: [
        { id: 'pr1', name: 'P1', descriptionPoints: ['a', 'b', 'c'], relevanceScore: 80 },
        { id: 'pr2', name: 'P2', descriptionPoints: ['a', 'b'], relevanceScore: 60 },
      ],
      selectedInternships: [],
    };
    const out = runParsePass1(fixture, PLANS.mid, 'mid');
    const p1 = out.companies[0].positions[0];
    if (p1.bulletCount !== 4) { console.error('HARNESS FAIL: mid 1-pos -- expected cap 4, got', p1.bulletCount); process.exit(1); }
    // exp pool 16 lines - 8 used = 8 leftover; projects pool 6 + 8 = 14 lines = 7 two-line bullets, capped by maxB 2/entry * 2 entries = 4
    const prAlloc = (out._contentPlan.alloc.pr1 || 0) + (out._contentPlan.alloc.pr2 || 0);
    if (prAlloc !== 4) { console.error('HARNESS FAIL: mid 1-pos -- expected spillover to fill projects to 2+2=4, got', prAlloc, out._contentPlan.alloc); process.exit(1); }
  }

  // 3. junior missing dates: no throw, sane allocation
  {
    const fixture = {
      sectionOrder: ['education', 'experience', 'projects', 'skills', 'certifications'],
      summary: '',
      companies: [
        { company: 'A', positions: [pos('j1', { endDate: 'garbage-date', relevanceScore: 70, keyAchievements: ['a', 'b', 'c', 'd', 'e', 'f'] })] },
        { company: 'B', positions: [pos('j2', { endDate: '', relevanceScore: 60, keyAchievements: ['a', 'b', 'c', 'd'] })] },
      ],
      selectedProjects: [{ id: 'jp1', name: 'JP', descriptionPoints: ['a', 'b', 'c'] }],
      selectedInternships: [],
    };
    const out = runParsePass1(fixture, PLANS.junior, 'junior');
    if (!out._contentPlan) { console.error('HARNESS FAIL: junior missing-dates -- no _contentPlan'); process.exit(1); }
    const total = out.companies.flatMap((c) => c.positions).reduce((a, p) => a + p.bulletCount, 0);
    if (total < 7 || total > 16) { console.error('HARNESS FAIL: junior missing-dates -- weird total allocation', total); process.exit(1); }
  }

  // 4. fresher: no experience, internships + projects allocated
  {
    const fixture = {
      sectionOrder: ['education', 'projects', 'internships', 'skills', 'activities'],
      summary: '',
      companies: [],
      selectedProjects: [
        { id: 'f1', name: 'F1', descriptionPoints: ['a', 'b', 'c', 'd', 'e'] },
        { id: 'f2', name: 'F2', descriptionPoints: ['a', 'b', 'c', 'd'] },
        { id: 'f3', name: 'F3', descriptionPoints: ['a', 'b', 'c'] },
        { id: 'f4', name: 'F4', descriptionPoints: ['a', 'b'] },
      ],
      selectedInternships: [
        { id: 'i1', title: 'Intern 1', endDate: 'Aug 2025', keyAchievements: ['a', 'b', 'c'] },
        { id: 'i2', title: 'Intern 2', endDate: 'Aug 2024', keyAchievements: ['a', 'b'] },
      ],
    };
    const out = runParsePass1(fixture, PLANS.fresher, 'fresher');
    const cp = out._contentPlan;
    const projTotal = ['f1', 'f2', 'f3', 'f4'].reduce((a, id) => a + (cp.alloc[id] || 0), 0);
    const intTotal = ['i1', 'i2'].reduce((a, id) => a + (cp.alloc[id] || 0), 0);
    if (projTotal < 12 || projTotal > 16) { console.error('HARNESS FAIL: fresher projects allocation', projTotal, 'not in [12,16]'); process.exit(1); }
    if (intTotal < 4 || intTotal > 10) { console.error('HARNESS FAIL: fresher internships allocation', intTotal, 'not in [4,10]'); process.exit(1); }
  }

  // 5. prefs enabled_sections reclaim: projects disabled -> its lines flow into experience
  {
    const fixture = {
      sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'Mid summary.',
      selectedAchievements: [{ title: 'x' }],
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 90 })] },
        { company: 'B', positions: [pos('p2', { endDate: 'Dec 2022', relevanceScore: 70 })] },
        { company: 'C', positions: [pos('p3', { endDate: 'Jun 2021', relevanceScore: 60 })] },
      ],
      selectedProjects: [{ id: 'pr1', name: 'P1', descriptionPoints: ['a', 'b'] }],
      selectedInternships: [],
    };
    const out = runParsePass1(fixture, PLANS.mid, 'mid', { enabled_sections: ['experience', 'skills'] });
    // backstop filters sectionOrder to [experience, skills]; projects' 6 lines reclaim into experience: 16+6=22 -> 11 bullets, capped by capFor 4/entry x3 = 11? min(11, 12)=11 -> 4/4/3
    const total = out.companies.flatMap((c) => c.positions).reduce((a, p) => a + p.bulletCount, 0);
    if (total !== 11) { console.error('HARNESS FAIL: prefs reclaim -- expected 11 bullets (22 lines), got', total, out._contentPlan); process.exit(1); }
    if (JSON.stringify(out.sectionOrder) !== JSON.stringify(['experience', 'skills'])) { console.error('HARNESS FAIL: 4.2a backstop regressed'); process.exit(1); }
  }

  // 6. material-scarce position: 1 keyAchievement -> alloc clamped to 1
  {
    const fixture = {
      sectionOrder: ['summary', 'experience', 'skills', 'achievements', 'certifications', 'education'],
      summary: 's', selectedAchievements: [{ title: 'x' }],
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 90 })] },
        { company: 'B', positions: [pos('p2', { endDate: 'Dec 2022', relevanceScore: 70, keyAchievements: ['only-one'] })] },
      ],
      selectedProjects: [], selectedInternships: [],
    };
    const out = runParsePass1(fixture, PLANS.senior, 'senior');
    const p2 = out.companies[1].positions[0];
    if (p2.bulletCount !== 1) { console.error('HARNESS FAIL: material-scarce -- expected 1, got', p2.bulletCount); process.exit(1); }
  }

  // 7. no-plan legacy passthrough: pass1 byte-identical
  {
    const fixture = { sectionOrder: ['experience', 'skills'], companies: [{ company: 'A', positions: [pos('p1', { bulletCount: 99 })] }] };
    const out = runParsePass1(fixture, undefined, undefined);
    if (out._contentPlan) { console.error('HARNESS FAIL: legacy -- _contentPlan must be absent'); process.exit(1); }
    if (out.companies[0].positions[0].bulletCount !== 99) { console.error('HARNESS FAIL: legacy -- bulletCount must be untouched'); process.exit(1); }
  }

  // 8. idempotence: allocator over its own output yields identical counts
  {
    const fixture = {
      sectionOrder: ['summary', 'experience', 'skills', 'achievements', 'certifications', 'education'],
      summary: 's', selectedAchievements: [{ title: 'x' }],
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 90 })] },
        { company: 'B', positions: [pos('p2', { endDate: 'Dec 2022', relevanceScore: 70 })] },
        { company: 'C', positions: [pos('p3', { endDate: 'Jun 2021', relevanceScore: 30 })] },
      ],
      selectedProjects: [], selectedInternships: [],
    };
    const once = runParsePass1(fixture, PLANS.senior, 'senior');
    const twice = runParsePass1(JSON.parse(JSON.stringify(once)), PLANS.senior, 'senior');
    const c1 = once.companies.flatMap((c) => c.positions).map((p) => p.bulletCount).join(',');
    const c2 = twice.companies.flatMap((c) => c.positions).map((p) => p.bulletCount).join(',');
    if (c1 !== c2) { console.error('HARNESS FAIL: idempotence --', c1, 'vs', c2); process.exit(1); }
  }

  console.log('HARNESS OK: allocator proven via real eval of the full patched Parse Pass1 -- senior 6-pos (cap 5, p6 dropped, most-recent floor, <=22 lines, >=18 used), mid 1-pos (cap 4 + spillover fills projects), junior garbage dates (no throw), fresher pools, prefs-reclaim (projects lines flow to experience, 4.2a backstop intact), material-scarce clamp to 1, legacy no-plan passthrough untouched, idempotent');

  // 9. Build Pass2 Input budgetBlock: eval both patched nodes
  for (const nodeName of ['Build Pass2 Input', 'Build Pass2 Regen Input']) {
    let code = N[nodeName].parameters.jsCode;
    const isRegen = nodeName.includes('Regen');
    if (!code.includes('buildBudgetBlock')) {
      code = code.replace(BP2_INPUT_ANCHOR, BUDGET_BLOCK_FN + BP2_INPUT_ANCHOR);
      code = code.replace(isRegen ? BP2R_CONCAT_OLD : BP2_CONCAT_OLD, isRegen ? BP2R_CONCAT_NEW : BP2_CONCAT_NEW);
    }
    const stamped = {
      companies: [{ company: 'A', positions: [{ id: 'p1', title: 'Engineer', isSelected: true }] }],
      selectedProjects: [{ id: 'pr1', name: 'Proj' }], selectedInternships: [],
      _contentPlan: { tier: 'mid', directive: 'impact', alloc: { p1: 3, pr1: 2 } },
    };
    const legacy = { companies: [{ company: 'A', positions: [{ id: 'p1' }] }] };
    const $mock = (data) => (name) => {
      if (name === 'Parse Pass1') return { first: () => ({ json: { pass1: data } }) };
      if (name === 'Parse Step0') return { first: () => ({ json: { step0: { clusters: [] } } }) };
      if (name === 'Calculate ATS Score') return { first: () => ({ json: { ats: { overall_score: 40, gaps: ['x'] } } }) };
      throw new Error('no_execution_data: ' + name);
    };
    const fn = new Function('$', code);
    const out1 = fn($mock(stamped))[0].json.pass2_user;
    if (!out1.includes('== BULLET BUDGET (MANDATORY) ==') || !out1.includes('- position p1 (Engineer): 3 bullets') || !out1.includes('- project pr1 (Proj): 2 bullets')) {
      console.error(`HARNESS FAIL: ${nodeName} budget block wrong:`, out1.slice(0, 400)); process.exit(1);
    }
    const out2 = fn($mock(legacy))[0].json.pass2_user;
    if (out2.includes('BULLET BUDGET')) { console.error(`HARNESS FAIL: ${nodeName} legacy pass1 must produce no budget block`); process.exit(1); }
    if (isRegen && !out1.includes('== ATS RETRY ==')) { console.error('HARNESS FAIL: regen atsGuidance lost'); process.exit(1); }
  }
  console.log('HARNESS OK: budgetBlock proven in both Build Pass2 nodes via real eval -- exact per-id counts rendered, legacy pass1 yields no block, regen ATS guidance preserved');
})();

TARGETS.forEach(patch);
console.log('S45 (deterministic allocator + bullet budget blocks) complete.');
