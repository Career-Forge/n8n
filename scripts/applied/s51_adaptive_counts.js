/**
 * s51_adaptive_counts.js -- adaptive count-table allocator (user-designed).
 *
 * Replaces v7's line-budget POOL allocator (Parse Pass1) with deterministic
 * per-tier SHAPE tables keyed on how many entries are actually available.
 * Page-FILL is now the target, not just page-fit -- the GitHub live apply
 * rendered SHORT of a full page because the line-budget pools under-filled.
 *
 * User's spec (mid tier, 3-6yr), extended per tier:
 *   4 experiences -> [3,3,2,2] bullets (most recent + next most significant
 *     get 3), 2 projects x [2,2]
 *   3 experiences -> [4,3,3], 3 projects x [2,2,2]
 *   2 experiences -> [4,4], 3 projects x [3,2,2]
 * Fewer experiences -> more bullets each AND more projects (the tables encode
 * both compensations). "Next most significant" = highest relevanceScore among
 * the non-most-recent entries -- already deterministic Pass1 data.
 *
 * What changes: only the allocation FUNCTION. Ranking (most-recent-then-
 * significance), entry caps, material capping (can't write more bullets than
 * keyAchievements extracted), deselection, and the _contentPlan output shape
 * (alloc + pos.bulletCount stamps) are preserved -- so Build Pass2 Input's
 * "write exactly N bullets" directive and mergeContent's per-entry trim need
 * ZERO changes. Self-disabling when a plan carries no countPlan (old
 * executions -> pre-v7 behavior, no crash).
 *
 * Shapes tuned against REAL pdflatex compiles per tier (see the calibration
 * harness in scripts/_s51_calibrate.js, run before deploy): each tier's
 * max-availability shape must render 1 page and near-full fill.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ Count tables (single source, injected into Build Pass1 Context) ═══
// experience/internships: shapes[N] = bullet counts for N kept entries, index
//   0 = highest rank (most recent). projects.byCount[K] keyed on the primary
//   pool's kept count (K = experience count, or internship count for fresher).
const COUNT_PLANS = {
  senior: {
    experience: { maxEntries: 5, shapes: { 1: [4], 2: [4, 4], 3: [4, 4, 3], 4: [4, 3, 3, 2], 5: [4, 3, 2, 2, 2] } },
    internships: null,
    projects: { keyedOn: 'experience', byCount: { 5: [], 4: [2], 3: [2, 2], 2: [3, 2], 1: [3, 2], 0: [3, 2] } },
    summaryLines: 3, achievementsMax: 3,
  },
  mid: {
    experience: { maxEntries: 4, shapes: { 1: [4], 2: [4, 4], 3: [4, 3, 3], 4: [3, 3, 2, 2] } },
    internships: null,
    projects: { keyedOn: 'experience', byCount: { 4: [2, 2], 3: [2, 2, 2], 2: [3, 2, 2], 1: [3, 3, 2], 0: [3, 3, 2] } },
    summaryLines: 2, achievementsMax: 2,
  },
  junior: {
    experience: { maxEntries: 3, shapes: { 1: [5], 2: [5, 4], 3: [5, 4, 4] } },
    internships: null,
    projects: { keyedOn: 'experience', byCount: { 3: [3, 3], 2: [4, 3, 3], 1: [4, 4, 3], 0: [4, 4, 3, 3] } },
    summaryLines: 0, achievementsMax: 0,
  },
  fresher: {
    experience: null,
    internships: { maxEntries: 2, shapes: { 1: [4], 2: [3, 3] } },
    projects: { keyedOn: 'internships', byCount: { 2: [4, 3, 3], 1: [4, 4, 3, 3], 0: [4, 4, 3, 3, 3] } },
    summaryLines: 0, achievementsMax: 0,
  },
};

const PLAN_ANCHOR = "const plan = JSON.parse(JSON.stringify(TIER_PLANS[tier] || TIER_PLANS.mid));";
const PLAN_NEW =
  "const COUNT_PLANS = " + JSON.stringify(COUNT_PLANS) + ";\n" +
  "const plan = JSON.parse(JSON.stringify(TIER_PLANS[tier] || TIER_PLANS.mid));\n" +
  "plan.countPlan = JSON.parse(JSON.stringify(COUNT_PLANS[tier] || COUNT_PLANS.mid));";

// ═══ New allocator block (replaces the whole old pool allocator in Parse Pass1) ═══
const ALLOC_START = "if (_plan && _plan.sections && _plan.bulletStyle) {";
const ALLOC_END = "return [{json:{pass1:pass1}}];";

const NEW_ALLOC =
  "if (_plan && _plan.countPlan) {\n" +
  "  // v7.3 s51: adaptive count-table allocator. Deterministic per-tier shapes\n" +
  "  // keyed on available entries -- page-FILL target. Ranking / entry caps /\n" +
  "  // material caps / deselection / _contentPlan shape all preserved.\n" +
  "  const cp = _plan.countPlan;\n" +
  "  const bs = _plan.bulletStyle || {};\n" +
  "  const lpb = bs.linesPerBullet || 2;\n" +
  "  const alloc = {}, deselected = [];\n" +
  "  const effectiveOrder = (Array.isArray(pass1.sectionOrder) && pass1.sectionOrder.length) ? pass1.sectionOrder : _plan.sectionOrder;\n" +
  "  const _endTs = (e) => { const s = String(e || ''); if (/present|current/i.test(s)) return Date.now(); const t = Date.parse(s); return isNaN(t) ? null : t; };\n" +
  "  // most recent first (mandatory), then by significance (relevance), then date, then tenure\n" +
  "  const rankItems = (items) => items.slice().sort((a, b) =>\n" +
  "    (b.mostRecentFlag - a.mostRecentFlag)\n" +
  "    || (b.relevance - a.relevance)\n" +
  "    || ((b.endTs == null ? -Infinity : b.endTs) - (a.endTs == null ? -Infinity : a.endTs))\n" +
  "    || (b.tenure - a.tenure));\n" +
  "  const shapeAt = (table, n) => {\n" +
  "    if (!table) return [];\n" +
  "    if (table[n]) return table[n];\n" +
  "    const keys = Object.keys(table).map(Number).filter((k) => !isNaN(k)).sort((a, b) => a - b);\n" +
  "    if (!keys.length) return [];\n" +
  "    let pick = keys[0]; for (const k of keys) { if (k <= n) pick = k; }\n" +
  "    return table[pick] || [];\n" +
  "  };\n" +
  "  // select top maxEntries (mandatory first), deselect rest, apply shape positionally, cap by material\n" +
  "  const selectAndShape = (items, cfg, shapeResolver) => {\n" +
  "    if (!cfg || !items.length) { items.forEach((i) => { alloc[i.id] = 0; if (i.ref) i.ref.bulletCount = 0; }); return 0; }\n" +
  "    const ranked = rankItems(items);\n" +
  "    const maxEntries = typeof cfg.maxEntries === 'number' ? cfg.maxEntries : ranked.length;\n" +
  "    let kept = ranked.filter((i) => i.mandatory);\n" +
  "    for (const i of ranked) { if (kept.length >= maxEntries) break; if (kept.indexOf(i) === -1) kept.push(i); }\n" +
  "    for (const i of ranked) { if (kept.indexOf(i) === -1) { alloc[i.id] = 0; deselected.push(i.id); if (i.ref) { i.ref.isSelected = false; i.ref.bulletCount = 0; } } }\n" +
  "    kept = rankItems(kept);\n" +
  "    const shape = shapeResolver(kept.length) || [];\n" +
  "    kept.forEach((i, idx) => {\n" +
  "      const want = shape[idx] != null ? shape[idx] : (shape.length ? shape[shape.length - 1] : 1);\n" +
  "      const c = Math.max(0, Math.min(want, Math.max(1, i.material)));\n" +
  "      alloc[i.id] = c; if (i.ref) i.ref.bulletCount = c;\n" +
  "      if (c === 0 && i.ref) { i.ref.isSelected = false; deselected.push(i.id); }\n" +
  "    });\n" +
  "    return kept.filter((i) => alloc[i.id] > 0).length;\n" +
  "  };\n" +
  "  const expItems = [];\n" +
  "  for (const comp of (pass1.companies || [])) {\n" +
  "    for (const pos of (comp.positions || [])) {\n" +
  "      if (!pos || pos.isSelected === false) continue;\n" +
  "      expItems.push({ id: pos.id, ref: pos, material: (pos.keyAchievements || []).length, mandatory: pos.isMostRecent === true || pos.isLongestTenure === true, relevance: typeof pos.relevanceScore === 'number' ? pos.relevanceScore : 50, endTs: _endTs(pos.endDate), tenure: pos.tenureMonths || 0, mostRecentFlag: pos.isMostRecent === true ? 1 : 0 });\n" +
  "    }\n" +
  "  }\n" +
  "  const internItems = (pass1.selectedInternships || []).map((it, idx) => it && ({ id: it.id || ('intern_' + idx), ref: it, material: (it.keyAchievements || []).length, mandatory: idx === 0, relevance: typeof it.relevanceScore === 'number' ? it.relevanceScore : 50, endTs: _endTs(it.endDate), tenure: it.tenureMonths || 0, mostRecentFlag: 0 })).filter(Boolean);\n" +
  "  const projItems = (pass1.selectedProjects || []).map((pj, idx) => pj && ({ id: pj.id || ('proj_' + idx), ref: pj, material: (pj.descriptionPoints || []).length, mandatory: false, relevance: typeof pj.relevanceScore === 'number' ? pj.relevanceScore : (90 - idx * 10), endTs: null, tenure: 0, mostRecentFlag: 0 })).filter(Boolean);\n" +
  "  let primaryCount = 0, internCount = 0;\n" +
  "  if (cp.experience && effectiveOrder.indexOf('experience') !== -1) {\n" +
  "    primaryCount = selectAndShape(expItems, cp.experience, (n) => shapeAt(cp.experience.shapes, n));\n" +
  "  } else { expItems.forEach((i) => { alloc[i.id] = 0; if (i.ref) i.ref.bulletCount = 0; }); }\n" +
  "  if (cp.internships && effectiveOrder.indexOf('internships') !== -1) {\n" +
  "    internCount = selectAndShape(internItems, cp.internships, (n) => shapeAt(cp.internships.shapes, n));\n" +
  "  } else { internItems.forEach((i) => { alloc[i.id] = 0; if (i.ref) i.ref.bulletCount = 0; }); }\n" +
  "  if (cp.projects && effectiveOrder.indexOf('projects') !== -1) {\n" +
  "    const key = cp.projects.keyedOn === 'internships' ? internCount : primaryCount;\n" +
  "    const projShape = shapeAt(cp.projects.byCount, key);\n" +
  "    selectAndShape(projItems, { maxEntries: projShape.length }, () => projShape);\n" +
  "  } else { projItems.forEach((i) => { alloc[i.id] = 0; if (i.ref) i.ref.bulletCount = 0; }); }\n" +
  "  let maxB = 1;\n" +
  "  const scan = (tbl) => { if (!tbl) return; for (const k of Object.keys(tbl)) { for (const v of (tbl[k] || [])) { if (v > maxB) maxB = v; } } };\n" +
  "  if (cp.experience) scan(cp.experience.shapes);\n" +
  "  if (cp.internships) scan(cp.internships.shapes);\n" +
  "  if (cp.projects) scan(cp.projects.byCount);\n" +
  "  pass1._contentPlan = {\n" +
  "    tier: _tier,\n" +
  "    linesPerBullet: lpb,\n" +
  "    targetChars: bs.targetChars,\n" +
  "    directive: bs.directive,\n" +
  "    alloc: alloc,\n" +
  "    deselected: deselected,\n" +
  "    maxBulletsPerEntry: maxB,\n" +
  "    achievementsMax: cp.achievementsMax || 0,\n" +
  "    experienceKept: primaryCount,\n" +
  "  };\n" +
  "}\n";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const need of ['Build Pass1 Context', 'Parse Pass1']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Build Pass1 Context'].parameters.jsCode.includes('COUNT_PLANS')) { console.log(`  ${base}: already patched`); return; }

  // 1. Build Pass1 Context: inject COUNT_PLANS + plan.countPlan
  {
    const code = N['Build Pass1 Context'].parameters.jsCode;
    if (code.split(PLAN_ANCHOR).length - 1 !== 1) { console.error(`INTEGRITY FAIL ${base}: Build Pass1 Context plan anchor count wrong`); process.exit(1); }
    N['Build Pass1 Context'].parameters.jsCode = code.replace(PLAN_ANCHOR, PLAN_NEW);
  }

  // 2. Parse Pass1: replace the whole allocator block via index slice
  {
    const code = N['Parse Pass1'].parameters.jsCode;
    if (code.split(ALLOC_START).length - 1 !== 1) { console.error(`INTEGRITY FAIL ${base}: Parse Pass1 allocator start anchor count wrong`); process.exit(1); }
    const si = code.indexOf(ALLOC_START);
    const ei = code.indexOf('\n' + ALLOC_END);
    if (si === -1 || ei === -1 || ei < si) { console.error(`INTEGRITY FAIL ${base}: Parse Pass1 allocator bounds not found`); process.exit(1); }
    N['Parse Pass1'].parameters.jsCode = code.slice(0, si) + NEW_ALLOC + code.slice(ei + 1);
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: adaptive count-table allocator installed`);
}

// ── harness ──
(function harness() {
  // Extract the new allocator as a runnable function by wrapping it.
  // We reproduce the exact allocator behavior against fixtures.
  function runAllocator(tier, pass1) {
    const _plan = { countPlan: JSON.parse(JSON.stringify(COUNT_PLANS[tier])), bulletStyle: { linesPerBullet: tier === 'junior' || tier === 'fresher' ? 1 : 2, targetChars: [130, 165], directive: 'x' }, sectionOrder: pass1.sectionOrder };
    const _tier = tier;
    // eval the NEW_ALLOC body with pass1/_plan/_tier in scope
    const fn = new Function('pass1', '_plan', '_tier', NEW_ALLOC + '\nreturn pass1._contentPlan;');
    return fn(pass1, _plan, _tier);
  }
  function pos(id, opts) {
    return Object.assign({ id, isSelected: true, isMostRecent: false, isLongestTenure: false, relevanceScore: 50, endDate: 'Dec 2022', tenureMonths: 24, keyAchievements: ['a', 'b', 'c', 'd', 'e'] }, opts);
  }

  // 1. MID, 4 experiences -> [3,3,2,2] by (most-recent, then significance).
  {
    const pass1 = {
      sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 70 })] },
        { company: 'B', positions: [pos('p2', { endDate: 'Jan 2023', relevanceScore: 95 })] }, // next most significant
        { company: 'C', positions: [pos('p3', { endDate: 'Jan 2022', relevanceScore: 60 })] },
        { company: 'D', positions: [pos('p4', { endDate: 'Jan 2020', relevanceScore: 55 })] },
      ],
      selectedProjects: [{ id: 'pr1', relevanceScore: 95, descriptionPoints: ['x', 'y', 'z'] }, { id: 'pr2', relevanceScore: 90, descriptionPoints: ['x', 'y'] }],
      selectedInternships: [],
    };
    const cpn = runAllocator('mid', pass1);
    // most recent p1 = 3; next most significant p2 (rel 95) = 3; p3,p4 = 2
    if (cpn.alloc.p1 !== 3 || cpn.alloc.p2 !== 3 || cpn.alloc.p3 !== 2 || cpn.alloc.p4 !== 2) {
      console.error('HARNESS FAIL: mid 4-exp shape wrong', cpn.alloc); process.exit(1);
    }
    // 4 exp -> 2 projects x [2,2]
    if (cpn.alloc.pr1 !== 2 || cpn.alloc.pr2 !== 2) { console.error('HARNESS FAIL: mid 4-exp projects wrong', cpn.alloc); process.exit(1); }
    if (cpn.experienceKept !== 4) { console.error('HARNESS FAIL: experienceKept', cpn.experienceKept); process.exit(1); }
  }
  console.log('HARNESS OK: mid 4-exp -> [3,3,2,2] (most-recent + highest-relevance get 3), 2 projects x [2,2]');

  // 2. MID, 3 experiences -> [4,3,3], 3 projects x [2,2,2].
  {
    const pass1 = {
      sectionOrder: ['summary', 'experience', 'projects', 'skills', 'education'],
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 80 })] },
        { company: 'B', positions: [pos('p2', { endDate: 'Jan 2022', relevanceScore: 70 })] },
        { company: 'C', positions: [pos('p3', { endDate: 'Jan 2021', relevanceScore: 65 })] },
      ],
      selectedProjects: [{ id: 'pr1', relevanceScore: 95, descriptionPoints: ['x', 'y', 'z'] }, { id: 'pr2', relevanceScore: 90, descriptionPoints: ['x', 'y'] }, { id: 'pr3', relevanceScore: 85, descriptionPoints: ['x', 'y'] }],
      selectedInternships: [],
    };
    const cpn = runAllocator('mid', pass1);
    if (cpn.alloc.p1 !== 4 || cpn.alloc.p2 !== 3 || cpn.alloc.p3 !== 3) { console.error('HARNESS FAIL: mid 3-exp shape', cpn.alloc); process.exit(1); }
    if (cpn.alloc.pr1 !== 2 || cpn.alloc.pr2 !== 2 || cpn.alloc.pr3 !== 2) { console.error('HARNESS FAIL: mid 3-exp projects', cpn.alloc); process.exit(1); }
  }
  console.log('HARNESS OK: mid 3-exp -> [4,3,3], 3 projects x [2,2,2] (fewer exp -> more bullets AND more projects)');

  // 3. Material cap: shape wants 3 but only 2 keyAchievements available.
  {
    const pass1 = {
      sectionOrder: ['experience', 'projects', 'skills', 'education'],
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 80, keyAchievements: ['only', 'two'] })] },
        { company: 'B', positions: [pos('p2', { endDate: 'Jan 2022', relevanceScore: 70 })] },
        { company: 'C', positions: [pos('p3', { endDate: 'Jan 2021', relevanceScore: 65 })] },
      ],
      selectedProjects: [], selectedInternships: [],
    };
    const cpn = runAllocator('mid', pass1);
    if (cpn.alloc.p1 !== 2) { console.error('HARNESS FAIL: material cap should hold p1 to 2, got', cpn.alloc.p1); process.exit(1); }
  }
  console.log('HARNESS OK: material cap holds a shape-3 slot to 2 when only 2 keyAchievements exist');

  // 4. Entry cap + deselection: 6 experiences, mid maxEntries 4 -> 2 deselected, mandatory kept.
  {
    const pass1 = {
      sectionOrder: ['experience', 'projects', 'skills', 'education'],
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 40 })] }, // mandatory despite low relevance
        { company: 'B', positions: [pos('p2', { isLongestTenure: true, endDate: 'Jan 2019', relevanceScore: 30, tenureMonths: 60 })] }, // mandatory
        { company: 'C', positions: [pos('p3', { endDate: 'Jan 2023', relevanceScore: 95 })] },
        { company: 'D', positions: [pos('p4', { endDate: 'Jan 2022', relevanceScore: 90 })] },
        { company: 'E', positions: [pos('p5', { endDate: 'Jan 2021', relevanceScore: 20 })] },
        { company: 'F', positions: [pos('p6', { endDate: 'Jan 2020', relevanceScore: 10 })] },
      ],
      selectedProjects: [], selectedInternships: [],
    };
    const cpn = runAllocator('mid', pass1);
    const kept = Object.keys(cpn.alloc).filter((k) => cpn.alloc[k] > 0);
    if (kept.length !== 4) { console.error('HARNESS FAIL: entry cap should keep 4, kept', kept); process.exit(1); }
    if (!kept.includes('p1') || !kept.includes('p2')) { console.error('HARNESS FAIL: mandatory (most-recent p1, longest-tenure p2) must survive', kept); process.exit(1); }
    if (cpn.deselected.length !== 2) { console.error('HARNESS FAIL: expected 2 deselected, got', cpn.deselected); process.exit(1); }
  }
  console.log('HARNESS OK: entry cap keeps 4 (mandatory most-recent + longest-tenure survive even at low relevance), 2 deselected');

  // 5. FRESHER: no experience, internships shape + projects keyed on internship count.
  {
    const pass1 = {
      sectionOrder: ['education', 'projects', 'internships', 'skills', 'activities'],
      companies: [],
      selectedInternships: [{ id: 'in1', relevanceScore: 80, endDate: 'Aug 2024', keyAchievements: ['a', 'b', 'c', 'd'] }, { id: 'in2', relevanceScore: 70, endDate: 'Aug 2023', keyAchievements: ['a', 'b', 'c'] }],
      selectedProjects: [{ id: 'pr1', relevanceScore: 95, descriptionPoints: ['a', 'b', 'c', 'd'] }, { id: 'pr2', relevanceScore: 90, descriptionPoints: ['a', 'b', 'c'] }, { id: 'pr3', relevanceScore: 85, descriptionPoints: ['a', 'b', 'c'] }],
    };
    const cpn = runAllocator('fresher', pass1);
    // 2 internships -> [3,3]
    if (cpn.alloc.in1 !== 3 || cpn.alloc.in2 !== 3) { console.error('HARNESS FAIL: fresher internships [3,3]', cpn.alloc); process.exit(1); }
    // projects keyed on internCount=2 -> [4,3,3]
    if (cpn.alloc.pr1 !== 4 || cpn.alloc.pr2 !== 3 || cpn.alloc.pr3 !== 3) { console.error('HARNESS FAIL: fresher projects keyed on internships', cpn.alloc); process.exit(1); }
  }
  console.log('HARNESS OK: fresher uses internship shapes + projects keyed on internship count (2 internships -> [4,3,3] projects)');

  // 6. Section-order override removes projects -> project items zeroed, exp unchanged.
  {
    const pass1 = {
      sectionOrder: ['experience', 'skills', 'education'], // no projects
      companies: [{ company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 80 })] }],
      selectedProjects: [{ id: 'pr1', relevanceScore: 95, descriptionPoints: ['x', 'y'] }],
      selectedInternships: [],
    };
    const cpn = runAllocator('mid', pass1);
    if (cpn.alloc.pr1 !== 0) { console.error('HARNESS FAIL: projects not in sectionOrder should be zeroed', cpn.alloc); process.exit(1); }
    if (cpn.alloc.p1 !== 4) { console.error('HARNESS FAIL: single mid exp should get shape[1]=[4]', cpn.alloc); process.exit(1); }
  }
  console.log('HARNESS OK: a section dropped from sectionOrder (user prefs) zeroes its entries; single-exp mid gets [4]');

  // 7. maxBulletsPerEntry reflects the tier's largest shape value (for the revise soft-cap).
  {
    const cpn = runAllocator('junior', { sectionOrder: ['education', 'experience', 'projects', 'skills'], companies: [{ company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 80 })] }], selectedProjects: [], selectedInternships: [] });
    if (cpn.maxBulletsPerEntry !== 5) { console.error('HARNESS FAIL: junior maxBulletsPerEntry should be 5', cpn.maxBulletsPerEntry); process.exit(1); }
  }
  console.log('HARNESS OK: maxBulletsPerEntry = tier max shape value (junior=5) for the revise-flow soft cap');

  // 8. No-countPlan safety: allocator no-ops (old executions).
  {
    const fn = new Function('pass1', '_plan', '_tier', NEW_ALLOC + '\nreturn pass1._contentPlan;');
    const pass1 = { companies: [{ company: 'A', positions: [pos('p1', { bulletCount: 9 })] }] };
    const r = fn(pass1, { bulletStyle: {} } /* no countPlan */, 'mid');
    if (r !== undefined || pass1.companies[0].positions[0].bulletCount !== 9) { console.error('HARNESS FAIL: no-countPlan should no-op', r); process.exit(1); }
  }
  console.log('HARNESS OK: allocator no-ops when the plan carries no countPlan (old-execution safety, pre-v7 behavior)');
})();

TARGETS.forEach(patch);
console.log('S51 (adaptive count-table allocator) complete.');
