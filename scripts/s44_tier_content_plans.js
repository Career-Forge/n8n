/**
 * s44_tier_content_plans.js -- v7 sprint, part 3: the per-tier content plan
 * table (single source of truth, lives ONLY in Build Pass1 Context) plus all
 * LLM-facing prompt alignment. No enforcement yet -- s45 adds the
 * deterministic allocator, s46 the render backstop; this script makes the
 * plan exist, ride the pass1 context, and be described to the LLMs.
 *
 * lineBudget numbers are EMPIRICALLY CALIBRATED from s43's real pdflatex
 * compiles against the tightened skeleton (all verified single-page, and a
 * 26+-line probe verified to overflow): senior exp 22 two-line bullet-lines;
 * mid exp 16 + proj 6 (worst-case 6 entry headings verified); junior exp 16
 * + proj 12 one-line; fresher proj 16 + internships 10 one-line.
 *
 * User decisions baked in: accomplishments UPLOADED-ONLY (Pass1 told to
 * select exclusively from the master's ## ACHIEVEMENTS section, empty array
 * otherwise); summary for MID+SENIOR only; bullet length TIER-DEPENDENT
 * (fresher/junior 70-110ch 1-line skills-evidence, mid/senior 150-200ch
 * 2-line impact/scope; render ceiling stays 240).
 *
 * Nodes touched: Build Pass1 Context (Code), Pass1 Selection / Pass2
 * Generate / ReviseForge (chainLlm system messages). Re-run
 * export_prompts.js after deploy (prompt mirrors change).
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

// ═══ 1. Build Pass1 Context: TIER_PLANS + plan + planBlock + output ═══

const BP1_TIER_ANCHOR =
  "const tierMap = { fresher: 'fresher', junior: 'junior', mid: 'mid', senior: 'senior', experienced: 'mid' };\n" +
  "const tier = tierMap[c.seniority_mode] || 'mid';";

const TIER_PLANS_CODE = `
// ═══ TIER CONTENT PLANS -- single source of truth (v7) ═══
// lineBudget = PRINTED LINES, not bullets: a 2-line bullet costs 2. Numbers
// empirically calibrated via real pdflatex compiles against the s43-tightened
// skeleton (single-page verified per tier; overflow probe verified binding).
const STYLE_2LINE = {
  linesPerBullet: 2, targetChars: [150, 200],
  directive: 'Impact-and-scope style: each bullet 150-200 characters (~2 printed lines): action verb + system/scope + technology + quantified outcome. Do not write bullets under 120 characters.'
};
const STYLE_1LINE = {
  linesPerBullet: 1, targetChars: [70, 110],
  directive: 'Skills-evidence style: each bullet 70-110 characters (~1 printed line): one skill/tool demonstrated + a concrete artifact or result. Never exceed 110 characters.'
};
const TIER_PLANS = {
  senior: {
    sectionOrder: ['summary', 'experience', 'skills', 'achievements', 'certifications', 'education'],
    summaryLines: 3,
    bulletStyle: STYLE_2LINE,
    sections: {
      experience: { maxEntries: 5, lineBudget: 22, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 },
      projects: { maxEntries: 0, lineBudget: 0 },
      internships: { maxEntries: 0, lineBudget: 0 },
      achievements: { maxEntries: 3 },
      skills: { maxCategories: 4 },
      certifications: { maxEntries: 2 },
      education: { maxEntries: 1 }
    },
    primaryPool: 'experience'
  },
  mid: {
    sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
    summaryLines: 2,
    bulletStyle: STYLE_2LINE,
    sections: {
      experience: { maxEntries: 4, lineBudget: 16, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 },
      projects: { maxEntries: 2, lineBudget: 6, minBulletsPerEntry: 1, maxBulletsPerEntry: 2 },
      internships: { maxEntries: 0, lineBudget: 0 },
      achievements: { maxEntries: 2 },
      skills: { maxCategories: 4 },
      certifications: { maxEntries: 2 },
      education: { maxEntries: 2 }
    },
    primaryPool: 'experience'
  },
  junior: {
    sectionOrder: ['education', 'experience', 'projects', 'skills', 'certifications'],
    summaryLines: 0,
    bulletStyle: STYLE_1LINE,
    sections: {
      experience: { maxEntries: 3, lineBudget: 16, minBulletsPerEntry: 3, maxBulletsPerEntry: 5, mostRecentMinBullets: 4 },
      projects: { maxEntries: 3, lineBudget: 12, minBulletsPerEntry: 2, maxBulletsPerEntry: 4 },
      internships: { maxEntries: 0, lineBudget: 0 },
      achievements: { maxEntries: 0 },
      skills: { maxCategories: 4 },
      certifications: { maxEntries: 2 },
      education: { maxEntries: 2 }
    },
    primaryPool: 'experience'
  },
  fresher: {
    sectionOrder: ['education', 'projects', 'internships', 'skills', 'activities'],
    summaryLines: 0,
    bulletStyle: STYLE_1LINE,
    sections: {
      experience: { maxEntries: 0, lineBudget: 0 },
      projects: { maxEntries: 4, lineBudget: 16, minBulletsPerEntry: 2, maxBulletsPerEntry: 4 },
      internships: { maxEntries: 2, lineBudget: 10, minBulletsPerEntry: 2, maxBulletsPerEntry: 3, mostRecentMinBullets: 3 },
      achievements: { maxEntries: 0 },
      skills: { maxCategories: 4 },
      certifications: { maxEntries: 3 },
      education: { maxEntries: 2 },
      activities: { maxEntries: 2 }
    },
    primaryPool: 'projects'
  }
};
const plan = JSON.parse(JSON.stringify(TIER_PLANS[tier] || TIER_PLANS.mid));
const planBlock = '\\n\\n== TIER CONTENT PLAN (tier: ' + tier + ') =='
  + '\\nDefault sectionOrder (user overrides take priority): ' + JSON.stringify(plan.sectionOrder)
  + '\\nEntry caps: experience ' + plan.sections.experience.maxEntries
  + ', projects ' + plan.sections.projects.maxEntries
  + ', internships ' + plan.sections.internships.maxEntries
  + ', achievements ' + plan.sections.achievements.maxEntries
  + ', certifications ' + plan.sections.certifications.maxEntries
  + ', education ' + plan.sections.education.maxEntries + '.'
  + '\\nBullet style: ' + plan.bulletStyle.directive
  + '\\nBullet counts: a deterministic allocator recomputes every bulletCount AFTER your selection -- your bulletCount values are advisory. Extract AT LEAST ' + plan.sections[plan.primaryPool].maxBulletsPerEntry + ' VERBATIM keyAchievements for recent/relevant positions so the allocator has material to work with.';`;

const BP1_USER_OLD = "const pass1_user = 'Master Resume:\\n' + masterResume + '\\n\\nJob Description:\\n' + jd + tierHint + bias + feedback + sectionOverride;";
const BP1_USER_NEW = "const pass1_user = 'Master Resume:\\n' + masterResume + '\\n\\nJob Description:\\n' + jd + tierHint + bias + feedback + sectionOverride + planBlock;";

const BP1_RETURN_OLD = 'return [{ json: { pass1_user, step0_user, tier } }];';
const BP1_RETURN_NEW = 'return [{ json: { pass1_user, step0_user, tier, plan } }];';

// ═══ 2. Pass1 Selection prompt edits ═══
const H = '═'.repeat(63);

const P1_EDITS = [
  [
    'SENIOR section order',
    '- SENIOR: ["summary", "experience", "skills", "certifications", "education"]',
    '- SENIOR: ["summary", "experience", "skills", "achievements", "certifications", "education"] — include "achievements" ONLY if the master resume has an ## ACHIEVEMENTS section',
  ],
  [
    'MID section order',
    '- MID: ["experience", "projects", "skills", "certifications", "education"]',
    '- MID: ["summary", "experience", "projects", "skills", "achievements", "certifications", "education"] — summary is 2-3 sentences for mid; include "achievements" ONLY if the master resume has an ## ACHIEVEMENTS section',
  ],
  [
    'summary schema line',
    '"summary": "<3-4 sentence professional summary — ONLY for senior tier, null/empty for others>",',
    '"summary": "<professional summary for SENIOR (3-4 sentences) and MID (2-3 sentences) tiers, composed ONLY from the master resume\'s ## SUMMARY bullets and headline; empty string for junior/fresher OR when no ## SUMMARY/headline material exists (then also omit \'summary\' from sectionOrder)>",',
  ],
  [
    'bullet count rules block',
    '- SENIOR: Most recent role = 4 bullets, others = 2-3 bullets.\n- MID: Most recent role = 3-4 bullets, others = 2-3 bullets.\n- JUNIOR: Each role = 3-4 bullets (fewer roles, so more bullets each).\n- FRESHER: Internships = 2-3 bullets each.\n- Projects: 2-3 bullets each across all tiers.\n\nAdjust bullet counts dynamically to ensure SINGLE PAGE fit. If content overflows, reduce bullet counts starting from oldest/least relevant entries.',
    'Bullet counts are ADVISORY — the == TIER CONTENT PLAN == block in the user message is the target shape, and a deterministic allocator recomputes every bulletCount after your selection. Your real job is EXTRACTION: for every selected position, extract AT LEAST the plan\'s max bullets per entry as VERBATIM keyAchievements (especially for recent/relevant roles) — an under-extracted position caps what the allocator can give it, and the allocator can never invent material you did not extract.',
  ],
  [
    'tier capacity lines',
    '- SENIOR: Include up to 4-5 experiences (enough to fill 60% of the page).\n- MID: Include up to 3-4 experiences.',
    '- SENIOR: Include up to 5 experiences (the TIER CONTENT PLAN entry caps are authoritative).\n- MID: Include up to 4 experiences (the TIER CONTENT PLAN entry caps are authoritative).',
  ],
  [
    'selectedAchievements uploaded-only rule',
    '"description": "<VERBATIM text from resume — copy exact original text including all details>",',
    '"description": "<VERBATIM text copied from the master resume\'s ## ACHIEVEMENTS section ONLY — NEVER derive achievements from experience bullets or invent them; return an empty selectedAchievements array if the resume has no ## ACHIEVEMENTS section>",',
  ],
];

// ═══ 3. Pass2 Generate prompt edits ═══
const P2_EDITS = [
  [
    'length policy sentence',
    'Every bullet\'s "text" field is hard-capped at 110 characters; write concisely, since anything longer gets truncated at a word boundary downstream.',
    'Bullet length is TIER-DEPENDENT — follow the == BULLET BUDGET == block in the user message when present: senior/mid bullets are 150-200 characters (impact/scope style, ~2 printed lines); junior/fresher bullets are 70-110 characters (skills-evidence style, ~1 printed line). Absolute hard ceiling 240 characters — anything longer gets truncated at a word boundary downstream.',
  ],
  [
    'schema text line',
    '"text": "<STAR bullet, plain text, MAX 110 characters>"',
    '"text": "<STAR bullet, plain text, length per the tier target above>"',
  ],
  [
    'STAR length line',
    'Every bullet MUST follow the STAR method: Action verb + Context + Technology + Metric + Impact, in ≤110 characters.',
    'Every bullet MUST follow the STAR method: Action verb + Context + Technology + Metric + Impact, within the tier\'s length target.',
  ],
  [
    'summary schema line',
    '"summary": "<3-4 sentence plain-text professional summary — ONLY if tier is senior, otherwise empty string>",',
    '"summary": "<plain-text professional summary — 3-4 sentences if tier is senior, 2-3 sentences if tier is mid, otherwise empty string; compose ONLY from Pass 1\'s summary and decisions>",',
  ],
  [
    'bullet count mandate (appended)',
    'Dates are entirely owned by Pass 1 (which already applies year-only formatting across a >2-year gap) — Pass 2 never emits dates and has nothing to do here.',
    'Dates are entirely owned by Pass 1 (which already applies year-only formatting across a >2-year gap) — Pass 2 never emits dates and has nothing to do here.\n\n' + H + '\nBULLET COUNT (MANDATORY)\n' + H + '\n\nWhen the user message contains a == BULLET BUDGET == block, it lists an EXACT bullet count per position_id. Write EXACTLY that many bullets for each listed position — extras are deleted from the end by the assembler, and shortfalls are backfilled with raw Pass-1 excerpts (which read worse than your writing). When no budget block is present, default to 3-4 bullets per position.',
  ],
];

// ═══ 4. ReviseForge prompt edits ═══
const RF_EDITS = [
  [
    'schema bullets line',
    '"bullets": [{"keyword","text" (MAX 110 chars)}]',
    '"bullets": [{"keyword","text" (keep each bullet\'s length close to the original\'s style; hard ceiling 240 chars)}]',
  ],
  [
    'length rule line',
    '- Every bullet\'s "text" stays plain text, MAX 110 characters.',
    '- Every bullet\'s "text" stays plain text. Keep each revised bullet\'s length close to the original\'s (1-line ~110 chars vs 2-line ~200 chars style); hard ceiling 240 characters. Do NOT increase a section\'s total bullet count unless the instruction explicitly asks for it.',
  ],
];

function applyEdits(get, set, edits, label, base) {
  let text = get();
  for (const [name, oldStr, newStr] of edits) {
    const count = text.split(oldStr).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: ${label} anchor "${name}" found ${count} times, expected exactly 1`); process.exit(1); }
    text = text.replace(oldStr, newStr);
  }
  set(text);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const need of ['Build Pass1 Context', 'Pass1 Selection', 'Pass2 Generate', 'ReviseForge']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }

  if (N['Build Pass1 Context'].parameters.jsCode.includes('TIER_PLANS')) {
    console.log(`  ${base}: already patched`);
    return;
  }

  // 1. Build Pass1 Context
  {
    let code = N['Build Pass1 Context'].parameters.jsCode;
    for (const [name, anchor] of [['tier anchor', BP1_TIER_ANCHOR], ['pass1_user line', BP1_USER_OLD], ['return line', BP1_RETURN_OLD]]) {
      const count = code.split(anchor).length - 1;
      if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: Build Pass1 Context anchor "${name}" found ${count} times`); process.exit(1); }
    }
    code = code.replace(BP1_TIER_ANCHOR, BP1_TIER_ANCHOR + '\n' + TIER_PLANS_CODE);
    code = code.replace(BP1_USER_OLD, BP1_USER_NEW);
    code = code.replace(BP1_RETURN_OLD, BP1_RETURN_NEW);
    N['Build Pass1 Context'].parameters.jsCode = code;
  }

  // 2-4. Prompt edits
  applyEdits(
    () => N['Pass1 Selection'].parameters.messages.messageValues[0].message,
    (v) => { N['Pass1 Selection'].parameters.messages.messageValues[0].message = v; },
    P1_EDITS, 'Pass1 Selection', base
  );
  applyEdits(
    () => N['Pass2 Generate'].parameters.messages.messageValues[0].message,
    (v) => { N['Pass2 Generate'].parameters.messages.messageValues[0].message = v; },
    P2_EDITS, 'Pass2 Generate', base
  );
  applyEdits(
    () => N['ReviseForge'].parameters.messages.messageValues[0].message,
    (v) => { N['ReviseForge'].parameters.messages.messageValues[0].message = v; },
    RF_EDITS, 'ReviseForge', base
  );

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: TIER_PLANS + planBlock in Build Pass1 Context, ${P1_EDITS.length}+${P2_EDITS.length}+${RF_EDITS.length} prompt edits applied`);
}

// ── harness ──
(function harness() {
  const file = TARGETS.find((f) => fs.existsSync(f));
  if (!file) { console.error('HARNESS FAIL: no target file'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  // 1. Build the patched Build Pass1 Context in memory and behaviorally prove it per tier.
  let code = N['Build Pass1 Context'].parameters.jsCode;
  const already = code.includes('TIER_PLANS');
  if (!already) {
    for (const [name, anchor] of [['tier anchor', BP1_TIER_ANCHOR], ['pass1_user line', BP1_USER_OLD], ['return line', BP1_RETURN_OLD]]) {
      const count = code.split(anchor).length - 1;
      if (count !== 1) { console.error(`HARNESS FAIL: Build Pass1 Context live anchor "${name}" found ${count}x, expected 1`); process.exit(1); }
    }
    code = code.replace(BP1_TIER_ANCHOR, BP1_TIER_ANCHOR + '\n' + TIER_PLANS_CODE);
    code = code.replace(BP1_USER_OLD, BP1_USER_NEW);
    code = code.replace(BP1_RETURN_OLD, BP1_RETURN_NEW);
  }

  function runNode(ctxFixture, prefs) {
    const $mock = (name) => {
      if (name === 'Prepare Apply Context') return { first: () => ({ json: ctxFixture }) };
      throw new Error('no_execution_data: ' + name); // Pass Dossier etc. -- node's try/catch handles it
    };
    const sd = { user_prefs: prefs || {} };
    const fn = new Function('$', '$getWorkflowStaticData', code);
    return fn($mock, () => sd)[0].json;
  }

  const baseCtx = { seniority_mode: 'mid', candidate_yoe: 5, resume_text: 'RESUME TEXT HERE', job_description: 'JD TEXT HERE', keyword_gaps: [], gaps: [] };

  for (const [mode, expTier] of [['fresher', 'fresher'], ['junior', 'junior'], ['mid', 'mid'], ['senior', 'senior'], ['experienced', 'mid'], [undefined, 'mid']]) {
    const out = runNode({ ...baseCtx, seniority_mode: mode });
    if (!out.plan) { console.error(`HARNESS FAIL: tier ${mode} -- no plan in output`); process.exit(1); }
    if (out.tier !== expTier) { console.error(`HARNESS FAIL: tier ${mode} -> expected ${expTier}, got ${out.tier}`); process.exit(1); }
    const p = out.plan;
    if (!Array.isArray(p.sectionOrder) || !p.sections || !p.bulletStyle || !p.primaryPool) { console.error(`HARNESS FAIL: tier ${mode} plan shape invalid`); process.exit(1); }
    for (const sec of ['experience', 'projects', 'internships', 'achievements', 'certifications', 'education']) {
      if (!p.sections[sec] || typeof p.sections[sec].maxEntries !== 'number') { console.error(`HARNESS FAIL: tier ${mode} plan missing section ${sec}`); process.exit(1); }
    }
    if (!out.pass1_user.includes('== TIER CONTENT PLAN (tier: ' + expTier + ') ==')) { console.error(`HARNESS FAIL: tier ${mode} planBlock missing from pass1_user`); process.exit(1); }
    if (!out.pass1_user.includes('== UPSTREAM CLASSIFIER ==')) { console.error(`HARNESS FAIL: tier ${mode} tierHint lost`); process.exit(1); }
  }

  // calibrated budgets present exactly
  const senior = runNode({ ...baseCtx, seniority_mode: 'senior' }).plan;
  if (senior.sections.experience.lineBudget !== 22 || senior.sections.education.maxEntries !== 1) { console.error('HARNESS FAIL: senior calibrated budgets wrong'); process.exit(1); }
  const mid = runNode({ ...baseCtx, seniority_mode: 'mid' }).plan;
  if (mid.sections.experience.lineBudget !== 16 || mid.sections.projects.lineBudget !== 6) { console.error('HARNESS FAIL: mid calibrated budgets wrong'); process.exit(1); }
  const jr = runNode({ ...baseCtx, seniority_mode: 'junior' }).plan;
  if (jr.sections.experience.lineBudget !== 16 || jr.sections.projects.lineBudget !== 12 || jr.bulletStyle.linesPerBullet !== 1) { console.error('HARNESS FAIL: junior calibrated budgets wrong'); process.exit(1); }
  const fr = runNode({ ...baseCtx, seniority_mode: 'fresher' }).plan;
  if (fr.sections.projects.lineBudget !== 16 || fr.sections.internships.lineBudget !== 10 || fr.primaryPool !== 'projects') { console.error('HARNESS FAIL: fresher calibrated budgets wrong'); process.exit(1); }

  // prefs overrides still injected alongside the plan block
  const withPrefs = runNode(baseCtx, { section_order: ['experience', 'skills'] });
  if (!withPrefs.pass1_user.includes('== USER SECTION ORDER OVERRIDE (HIGHEST PRIORITY) ==')) { console.error('HARNESS FAIL: prefs override text lost'); process.exit(1); }
  if (!withPrefs.pass1_user.includes('== TIER CONTENT PLAN')) { console.error('HARNESS FAIL: plan block missing when prefs set'); process.exit(1); }

  // plans are deep-copied -- mutating one run's plan must not leak into the next
  const a = runNode({ ...baseCtx, seniority_mode: 'senior' }).plan;
  a.sections.experience.lineBudget = 999;
  const b = runNode({ ...baseCtx, seniority_mode: 'senior' }).plan;
  if (b.sections.experience.lineBudget !== 22) { console.error('HARNESS FAIL: TIER_PLANS table mutated across runs -- deep copy broken'); process.exit(1); }

  console.log('HARNESS OK: Build Pass1 Context patched code proven per tier via real eval (plan shape, calibrated budgets 22/16+6/16+12/16+10, tier fallbacks experienced->mid + unknown->mid, planBlock + tierHint + prefs-override coexistence, deep-copy isolation)');

  // 2. Prompt anchors: each found exactly once in the live prompts.
  const promptChecks = [
    ['Pass1 Selection', P1_EDITS],
    ['Pass2 Generate', P2_EDITS],
    ['ReviseForge', RF_EDITS],
  ];
  for (const [nodeName, edits] of promptChecks) {
    const msg = N[nodeName].parameters.messages.messageValues[0].message;
    const alreadyP = msg.includes('TIER CONTENT PLAN') || msg.includes('BULLET BUDGET') || msg.includes('hard ceiling 240');
    if (alreadyP) continue;
    for (const [name, oldStr] of edits) {
      const count = msg.split(oldStr).length - 1;
      if (count !== 1) { console.error(`HARNESS FAIL: ${nodeName} anchor "${name}" found ${count}x in live prompt, expected 1`); process.exit(1); }
    }
  }
  console.log('HARNESS OK: all 13 prompt anchors verified unique in the live Pass1/Pass2/ReviseForge system messages');
})();

TARGETS.forEach(patch);
console.log('S44 (tier content plans + prompt alignment) complete.');
