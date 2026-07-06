/**
 * s46_render_budget_enforcement.js -- v7 sprint, part 5 (final): the render-
 * side backstop. s44 described the plan to the LLMs, s45 computed exact
 * per-position bullet counts -- this script makes the assembler ENFORCE them,
 * so an overshooting Pass2 (or a keyAchievements fallback) can never blow the
 * page budget. The prompts ask; the code decides.
 *
 * 1. mergeContent (Assemble Resume LaTeX + Assemble Regen, identical strings,
 *    twin identity preserved): trim each experience/internship/project
 *    entry's bullets to its bulletCount whenever that's a non-negative
 *    number (allocator-stamped OR the LLM's own advisory value; absent ->
 *    untrimmed legacy behavior). bulletCount 0 empties the entry, which the
 *    existing !bullets.length guards then drop -- this is how allocator-
 *    deselected projects/internships disappear (experience already has an
 *    isSelected check). Achievements sliced to _contentPlan.achievementsMax
 *    (default 3). The returned content gains _budget {tier,
 *    maxBulletsPerEntry, linesPerBullet}, which rides through Pick Resume
 *    LaTeX into last_resume_json so the revise flow knows the budget.
 *
 * 2. bulletRenderV2 (shared block, ALL 3 LaTeX nodes): the flat per-entry
 *    render cap rises 3/4 -> 4/6 (compact/normal) -- it becomes a pure
 *    runaway guard, since exact trimming now happens in mergeContent, and
 *    junior/fresher allocations legitimately reach 5. Signature unchanged,
 *    so the drift-checker's bulletRenderV2 anchors stay valid.
 *
 * 3. Build Revised LaTeX (revise flow, deliberately SOFT): trim revised
 *    entries to _budget.maxBulletsPerEntry (fallback 4 = the old cap) --
 *    hard line-budget enforcement here would fight explicit user revision
 *    intent; ReviseForge's s44 prompt guard is the intent-respecting control.
 *
 * Verification beyond the harness: full-chain per-tier fixtures through the
 * patched mergeContent + renderResume -> real pdflatex -> 1 page x4 tiers,
 * plus an overflow probe (allocation bypassed with oversized counts) -> 2
 * pages, proving the budget is the binding constraint. Runs post-dry-run.
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

const ASSEMBLE_NODES = ['Assemble Resume LaTeX', 'Assemble Regen'];
const ALL_LATEX_NODES = ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX'];

// ═══ 1. mergeContent trims (Assemble twins only -- Build Revised LaTeX has no mergeContent) ═══
const MERGE_EDITS = [
  [
    'experience trim',
    "      const bullets = resolveBulletsV2(p2exp[pos.id], pos.keyAchievements);\n      if (!bullets.length) continue;",
    "      const expCap = (typeof pos.bulletCount === 'number' && pos.bulletCount >= 0) ? pos.bulletCount : Infinity;\n      const bullets = resolveBulletsV2(p2exp[pos.id], pos.keyAchievements).slice(0, expCap);\n      if (!bullets.length) continue;",
  ],
  [
    'internship trim',
    "    const bullets = resolveBulletsV2(p2int[intern.id], intern.keyAchievements);\n    if (!bullets.length) return null;",
    "    const intCap = (typeof intern.bulletCount === 'number' && intern.bulletCount >= 0) ? intern.bulletCount : Infinity;\n    const bullets = resolveBulletsV2(p2int[intern.id], intern.keyAchievements).slice(0, intCap);\n    if (!bullets.length) return null;",
  ],
  [
    'project trim',
    "    const bullets = resolveBulletsV2(p2proj[proj.id], proj.descriptionPoints);\n    if (!bullets.length) return null;",
    "    const projCap = (typeof proj.bulletCount === 'number' && proj.bulletCount >= 0) ? proj.bulletCount : Infinity;\n    const bullets = resolveBulletsV2(p2proj[proj.id], proj.descriptionPoints).slice(0, projCap);\n    if (!bullets.length) return null;",
  ],
  [
    'achievements slice',
    "    achievements: pass1.selectedAchievements || [],",
    "    achievements: (pass1.selectedAchievements || []).slice(0, ((pass1._contentPlan || {}).achievementsMax) || 3),",
  ],
  [
    '_budget stamp',
    "    sectionOrder,\n  };",
    "    sectionOrder,\n    _budget: pass1._contentPlan ? { tier: pass1._contentPlan.tier, maxBulletsPerEntry: pass1._contentPlan.maxBulletsPerEntry, linesPerBullet: pass1._contentPlan.linesPerBullet } : null,\n  };",
  ],
];

// ═══ 2. bulletRenderV2 runaway-guard cap (all 3 nodes) ═══
const CAP_OLD = '.slice(0, isCompact ? 3 : 4)';
const CAP_NEW = '.slice(0, isCompact ? 4 : 6)';

// ═══ 3. Build Revised LaTeX soft trim ═══
const BRL_ANCHOR = "const isCompact = ((($getWorkflowStaticData('global').user_prefs) || {}).template) === 'compact';";
const BRL_TRIM =
  "// v7 s46: soft per-entry cap from the stored budget (fallback 4 = old cap).\n" +
  "// Deliberately NOT a hard line-budget -- that would fight explicit user\n" +
  "// revision intent; ReviseForge's prompt guard handles count growth.\n" +
  "const _revCap = (revised._budget && revised._budget.maxBulletsPerEntry) || 4;\n" +
  "for (const _sec of ['experience', 'internships', 'projects']) {\n" +
  "  for (const _e of (Array.isArray(revised[_sec]) ? revised[_sec] : [])) {\n" +
  "    if (_e && Array.isArray(_e.bullets) && _e.bullets.length > _revCap) _e.bullets = _e.bullets.slice(0, _revCap);\n" +
  "  }\n" +
  "}\n";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const need of ALL_LATEX_NODES) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Assemble Resume LaTeX'].parameters.jsCode.includes('_budget')) { console.log(`  ${base}: already patched`); return; }

  for (const name of ASSEMBLE_NODES) {
    let code = N[name].parameters.jsCode;
    for (const [label, oldStr] of MERGE_EDITS) {
      const count = code.split(oldStr).length - 1;
      if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: "${name}" anchor "${label}" found ${count} times`); process.exit(1); }
    }
    for (const [, oldStr, newStr] of MERGE_EDITS) code = code.replace(oldStr, newStr);
    N[name].parameters.jsCode = code;
  }

  for (const name of ALL_LATEX_NODES) {
    let code = N[name].parameters.jsCode;
    const count = code.split(CAP_OLD).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: "${name}" bulletRenderV2 cap anchor found ${count} times`); process.exit(1); }
    N[name].parameters.jsCode = code.replace(CAP_OLD, CAP_NEW);
  }

  {
    let code = N['Build Revised LaTeX'].parameters.jsCode;
    const count = code.split(BRL_ANCHOR).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: Build Revised LaTeX isCompact anchor found ${count} times`); process.exit(1); }
    N['Build Revised LaTeX'].parameters.jsCode = code.replace(BRL_ANCHOR, BRL_TRIM + BRL_ANCHOR);
  }

  const a = N['Assemble Resume LaTeX'].parameters.jsCode;
  const r = N['Assemble Regen'].parameters.jsCode;
  if (a !== r) { console.error(`INTEGRITY FAIL ${base}: Assemble twins diverged after patch`); process.exit(1); }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: mergeContent trims + bulletRenderV2 cap 4/6 + revise soft cap applied`);
}

// ── harness ──
(function harness() {
  const file = TARGETS.find((f) => fs.existsSync(f));
  if (!file) { console.error('HARNESS FAIL: no target file'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('fn not found: ' + name);
    let depth = 0, i = src.indexOf('{', start), j = i;
    for (;;) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; if (depth === 0) break; j++; }
    return src.slice(start, j + 1);
  }

  // Patch the Assemble code in memory.
  let code = N['Assemble Resume LaTeX'].parameters.jsCode;
  const already = code.includes('_budget');
  if (!already) {
    for (const [label, oldStr] of MERGE_EDITS) {
      const count = code.split(oldStr).length - 1;
      if (count !== 1) { console.error(`HARNESS FAIL: live anchor "${label}" found ${count}x`); process.exit(1); }
    }
    for (const [, oldStr, newStr] of MERGE_EDITS) code = code.replace(oldStr, newStr);
    if (code.split(CAP_OLD).length - 1 !== 1) { console.error('HARNESS FAIL: cap anchor not unique'); process.exit(1); }
    code = code.replace(CAP_OLD, CAP_NEW);
  }

  // OLD-behavior sanity check first (proves the new junior-5 test is discriminating):
  {
    const oldSrc = [extractFn(N['Assemble Resume LaTeX'].parameters.jsCode, 'truncateBullet'), extractFn(N['Assemble Resume LaTeX'].parameters.jsCode, 'bulletRenderV2')].join('\n');
    if (!already) {
      const oldRender = new Function('escapeLatexTextV2', oldSrc + '\nreturn bulletRenderV2;')((s) => s);
      const five = Array.from({ length: 5 }, (_, i) => ({ keyword: '', text: 'bullet ' + i }));
      if (oldRender(five, false).split('\n').length !== 4) { console.error('HARNESS FAIL: old cap sanity check -- expected 4'); process.exit(1); }
    }
  }

  const fns = new Function(
    [
      extractFn(code, 'truncateBullet'),
      extractFn(code, 'bulletRenderV2'),
      extractFn(code, 'indexByPositionIdV2'),
      extractFn(code, 'resolveBulletsV2'),
      extractFn(code, 'mergeContent'),
    ].join('\n') + '\nreturn { bulletRenderV2, mergeContent };'
  )();
  // bulletRenderV2 references escapeLatexTextV2 lazily inside its body -- bind a global for the eval scope
  global.escapeLatexTextV2 = (s) => s;

  const P2 = (id, n) => ({ position_id: id, bullets: Array.from({ length: n }, (_, i) => ({ keyword: 'K' + i, text: 'Text ' + i })) });

  // 1. Overshoot trim: allocator said 3, Pass2 wrote 6 -> content carries 3.
  {
    const pass1 = {
      sectionOrder: ['experience', 'skills'],
      companies: [{ company: 'A', positions: [{ id: 'p1', title: 'T', startDate: '', endDate: '', location: '', isSelected: true, bulletCount: 3, keyAchievements: ['a'] }] }],
      _contentPlan: { tier: 'mid', maxBulletsPerEntry: 4, linesPerBullet: 2, achievementsMax: 2 },
      selectedAchievements: [{ t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }],
      skillsCategories: [],
    };
    const content = fns.mergeContent(pass1, { experience_bullets: [P2('p1', 6)] });
    if (content.experience[0].bullets.length !== 3) { console.error('HARNESS FAIL: overshoot trim -- expected 3, got', content.experience[0].bullets.length); process.exit(1); }
    if (content.achievements.length !== 2) { console.error('HARNESS FAIL: achievements slice to achievementsMax -- expected 2'); process.exit(1); }
    if (!content._budget || content._budget.tier !== 'mid' || content._budget.maxBulletsPerEntry !== 4) { console.error('HARNESS FAIL: _budget stamp wrong', content._budget); process.exit(1); }
  }

  // 2. Fallback trim: Pass2 omitted the entry -> keyAchievements fallback also trimmed.
  {
    const pass1 = {
      sectionOrder: ['experience'],
      companies: [{ company: 'A', positions: [{ id: 'p1', title: 'T', isSelected: true, bulletCount: 2, keyAchievements: ['a', 'b', 'c', 'd', 'e'] }] }],
      _contentPlan: { tier: 'senior', maxBulletsPerEntry: 4, linesPerBullet: 2, achievementsMax: 3 },
      skillsCategories: [],
    };
    const content = fns.mergeContent(pass1, {});
    if (content.experience[0].bullets.length !== 2) { console.error('HARNESS FAIL: fallback trim -- expected 2, got', content.experience[0].bullets.length); process.exit(1); }
  }

  // 3. Deselected project (bulletCount 0) disappears; untouched project remains.
  {
    const pass1 = {
      sectionOrder: ['projects'],
      companies: [],
      selectedProjects: [
        { id: 'pr1', name: 'Kept', bulletCount: 2, descriptionPoints: ['a', 'b', 'c'] },
        { id: 'pr2', name: 'Dropped', bulletCount: 0, isSelected: false, descriptionPoints: ['a', 'b'] },
      ],
      _contentPlan: { tier: 'fresher', maxBulletsPerEntry: 4, linesPerBullet: 1, achievementsMax: 0 },
      skillsCategories: [],
    };
    const content = fns.mergeContent(pass1, { project_bullets: [P2('pr1', 4), P2('pr2', 4)] });
    if (content.projects.length !== 1 || content.projects[0].name !== 'Kept') { console.error('HARNESS FAIL: deselected project should vanish, got', content.projects.map((p) => p.name)); process.exit(1); }
    if (content.projects[0].bullets.length !== 2) { console.error('HARNESS FAIL: kept project trim -- expected 2'); process.exit(1); }
  }

  // 4. Legacy pass1 (no numeric bulletCount, no _contentPlan): untrimmed, achievements default cap 3, _budget null.
  {
    const pass1 = {
      sectionOrder: ['experience'],
      companies: [{ company: 'A', positions: [{ id: 'p1', title: 'T', isSelected: true, keyAchievements: ['a'] }] }],
      selectedAchievements: [{ t: 1 }, { t: 2 }, { t: 3 }, { t: 4 }],
      skillsCategories: [],
    };
    const content = fns.mergeContent(pass1, { experience_bullets: [P2('p1', 5)] });
    if (content.experience[0].bullets.length !== 5) { console.error('HARNESS FAIL: legacy must stay untrimmed, got', content.experience[0].bullets.length); process.exit(1); }
    if (content.achievements.length !== 3) { console.error('HARNESS FAIL: legacy achievements default cap 3'); process.exit(1); }
    if (content._budget !== null) { console.error('HARNESS FAIL: legacy _budget must be null'); process.exit(1); }
  }

  // 5. bulletRenderV2 new caps: normal renders 5 of 5 (old rendered 4), 6 max; compact 4.
  {
    const six = Array.from({ length: 6 }, (_, i) => ({ keyword: '', text: 'bullet ' + i }));
    const five = six.slice(0, 5);
    if (fns.bulletRenderV2(five, false).split('\n').length !== 5) { console.error('HARNESS FAIL: junior 5-bullet entry must render 5 lines now'); process.exit(1); }
    if (fns.bulletRenderV2(six.concat(six), false).split('\n').length !== 6) { console.error('HARNESS FAIL: runaway guard must cap at 6'); process.exit(1); }
    if (fns.bulletRenderV2(six, true).split('\n').length !== 4) { console.error('HARNESS FAIL: compact runaway guard must cap at 4'); process.exit(1); }
  }

  // 6. Build Revised LaTeX soft trim: eval the patched revise main.
  {
    let brl = N['Build Revised LaTeX'].parameters.jsCode;
    if (!brl.includes('_revCap')) {
      if (brl.split(BRL_ANCHOR).length - 1 !== 1) { console.error('HARNESS FAIL: BRL anchor not unique'); process.exit(1); }
      brl = brl.replace(BRL_ANCHOR, BRL_TRIM + BRL_ANCHOR);
    }
    const revised = {
      experience: [{ title: 'T', company: 'C', startDate: '', endDate: '', location: '', bullets: Array.from({ length: 7 }, (_, i) => ({ keyword: '', text: 'b' + i })) }],
      internships: [], projects: [],
      skills: [], education: [], certifications: [], achievements: [], activities: [],
      sectionOrder: ['experience'],
      _budget: { tier: 'mid', maxBulletsPerEntry: 4, linesPerBullet: 2 },
      changes_summary: 'x',
    };
    const $mock = (name) => {
      if (name === 'Load Revise Context') return { first: () => ({ json: { chat_id: 1, last_apply: { personal: { name: 'X' }, job_title: 'JT', company: 'CO' } } }) };
      throw new Error('no_execution_data: ' + name);
    };
    const $input = { first: () => ({ json: { output: revised } }) };
    const out = new Function('$input', '$', '$getWorkflowStaticData', brl)($input, $mock, () => ({ user_prefs: {} }))[0].json;
    if (out.error) { console.error('HARNESS FAIL: revise eval errored:', out.error); process.exit(1); }
    if (revised.experience[0].bullets.length !== 4) { console.error('HARNESS FAIL: revise soft cap -- expected 4, got', revised.experience[0].bullets.length); process.exit(1); }
    if (!out.latex || !out.latex.includes('\\resumeItem')) { console.error('HARNESS FAIL: revise render produced no bullets'); process.exit(1); }
    // no _budget round-trip -> old cap 4 still applies
    const revised2 = JSON.parse(JSON.stringify(revised)); delete revised2._budget;
    revised2.experience[0].bullets = Array.from({ length: 7 }, (_, i) => ({ keyword: '', text: 'b' + i }));
    const out2 = new Function('$input', '$', '$getWorkflowStaticData', brl)({ first: () => ({ json: { output: revised2 } }) }, $mock, () => ({ user_prefs: {} }))[0].json;
    if (out2.error || revised2.experience[0].bullets.length !== 4) { console.error('HARNESS FAIL: revise without _budget must fall back to cap 4'); process.exit(1); }
  }

  console.log('HARNESS OK: mergeContent trims (overshoot 6->3, fallback 5->2, deselected project vanishes, legacy untrimmed + _budget null), achievements sliced to plan max, _budget stamped, bulletRenderV2 caps 4/6 as pure runaway guards (old-cap sanity-checked first), revise soft cap 4 both with and without a _budget round-trip -- all via real eval of the actual patched code');
})();

TARGETS.forEach(patch);
console.log('S46 (render budget enforcement) complete.');
