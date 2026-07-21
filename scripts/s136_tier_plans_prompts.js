/**
 * s136_tier_plans_prompts.js -- senior-tier "projects" section + prompt sync.
 *
 * SECOND of a three-script sequence (s135 done -- LaTeX render layer; s136
 * this one; s137 next -- Parse Pass1 allocator, NOT in scope here). Touches
 * ONLY: Build Pass1 Context (TIER_PLANS + COUNT_PLANS constants), Pass1
 * Selection (prompt), Pass2 Generate (prompt), Pass2 Regen (prompt),
 * ReviseForge (prompt). Does NOT touch Parse Pass1 or any LaTeX node.
 *
 * Implements the approved plan's locked decisions:
 *   1. TIER_PLANS.senior reshape -- 'projects' inserted into sectionOrder
 *      right after 'experience'; experience.maxEntries 5->4, lineBudget
 *      22->24; projects goes from the old {0,0} no-op shape to a real
 *      {maxEntries:3, lineBudget:8, minBulletsPerEntry:2, maxBulletsPerEntry:3}
 *      slot (3 because COUNT_PLANS.senior.projects.byCount needs a row for
 *      the 3+3 escape hatch; lineBudget 8 assumes the default 2-project
 *      [2,2] shape at STYLE_2LINE's 2 lines/bullet).
 *   2. COUNT_PLANS rerange -- senior.projects.byCount and mid.projects.byCount
 *      get richer shapes per tier; junior.experience.shapes drops its 5-bullet
 *      cap to 4 (matching the universal 2-4 range); TIER_PLANS.junior's
 *      maxBulletsPerEntry follows (5->4); TIER_PLANS.mid.projects widens
 *      (maxBulletsPerEntry 2->3, lineBudget 6->10).
 *      NOTE (judgment call, flagged): live COUNT_PLANS.senior.experience.shapes
 *      ALREADY carries a "4":[4,3,3,2] key (verified against the live file --
 *      the plan's authors were apparently working from what became this same
 *      value, so there's nothing to add there; only the byCount/junior/mid
 *      pieces actually need edits).
 *      CORRECTION (post-draft adversarial catch, 2026-07-21): the FIRST draft
 *      of this script left COUNT_PLANS.senior.experience.maxEntries at 5,
 *      reasoning that the locked decisions only named `.shapes` for that
 *      edit. That reasoning was wrong -- Parse Pass1's allocator reads
 *      maxEntries from COUNT_PLANS (cp.experience.maxEntries), NOT from
 *      TIER_PLANS.sections.experience.maxEntries (which only feeds the
 *      prompt text + trimToLineBudget's lineBudget lookup). Left at 5, any
 *      senior candidate with 5+ real positions would still get kept up to 5,
 *      hit the untouched shapes["5"]=[4,3,2,2,2], and get ZERO projects
 *      (projects.byCount["5"] is now []) -- silently defeating the entire
 *      senior 4+2 extension for exactly the long-career candidates it exists
 *      for. Fixed: COUNT_PLANS.senior.experience.maxEntries is now 4,
 *      matching TIER_PLANS. The "5" shapes/byCount rows stay in the tables
 *      as inert fallback data for the disclosed edge case (a senior user who
 *      has excluded 'projects' from their section-order pref) -- restoring
 *      maxEntries to 5 conditionally for that case needs effectiveOrder,
 *      which only Parse Pass1 has, so that conditional restoration (not the
 *      base default) is what genuinely stays s137's job.
 *   3. STYLE_2LINE / STYLE_1LINE -- confirmed UNCHANGED (regression guard
 *      only, no edit).
 *   4. Pass1 Selection prompt -- 5 independently-anchored edits: techStack
 *      curation guidance, SENIOR section-order line (+projects), SENIOR space
 *      allocation line (+15% Projects), SENIOR tier-capacity line (5->4
 *      experiences), and one new MULTI-ROLE/PROGRESSION bullet about
 *      reflecting only resume-structure-native position splits (never
 *      inventing a split from tenure alone).
 *   5. Pass2 Generate + Pass2 Regen -- byte-identical system prompts, one
 *      substring edit each ("130-165" -> "130-155", aligning the prompt's
 *      stated senior/mid bullet range with STYLE_2LINE.targetChars=[130,155]).
 *      Asserted byte-identical post-patch.
 *   6. ReviseForge prompt -- one line's "2-line ~200 chars" -> "2-line ~155
 *      chars" (matches STYLE_2LINE's upper target) and "hard ceiling 240
 *      characters" -> "hard ceiling 210 characters" (matches truncateBullet's
 *      real SAFE_TOTAL=210, confirmed unchanged by s135). The OTHER "hard
 *      ceiling 240 chars" mention (in the bullets-array schema note, a
 *      different line) is deliberately left untouched -- not named in the
 *      locked decision.
 *
 * Run: node scripts/s136_tier_plans_prompts.js   (from the repo root)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

const LATEX_NODES = ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX', 'Load Skeletons', 'Build Cover LaTeX'];
const OUT_OF_SCOPE_NODES = [...LATEX_NODES, 'Parse Pass1'];

// ═══════════════════════════════════════════════════════════════════════
// replaceOnce -- established idiom (s135/s51): asserts the anchor appears
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
// 1+2. Build Pass1 Context -- TIER_PLANS (5 targeted line edits) + COUNT_PLANS
//      (1 single-line literal edit).
// ═══════════════════════════════════════════════════════════════════════

// -- TIER_PLANS.senior: sectionOrder gains 'projects' right after 'experience' --
const TP_SENIOR_ORDER_OLD = "sectionOrder: ['summary', 'experience', 'skills', 'achievements', 'certifications', 'education'],";
const TP_SENIOR_ORDER_NEW = "sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],";

// -- TIER_PLANS.senior.sections.experience: maxEntries 5->4, lineBudget 22->24 --
const TP_SENIOR_EXP_OLD = 'experience: { maxEntries: 5, lineBudget: 22, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 },';
const TP_SENIOR_EXP_NEW = 'experience: { maxEntries: 4, lineBudget: 24, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 },';

// -- TIER_PLANS.senior.sections.projects: {0,0} no-op -> real 3-entry slot --
const TP_SENIOR_PROJ_OLD = 'projects: { maxEntries: 0, lineBudget: 0 },';
const TP_SENIOR_PROJ_NEW = 'projects: { maxEntries: 3, lineBudget: 8, minBulletsPerEntry: 2, maxBulletsPerEntry: 3 },';

// -- TIER_PLANS.mid.sections.projects: maxBulletsPerEntry 2->3, lineBudget 6->10 --
const TP_MID_PROJ_OLD = 'projects: { maxEntries: 2, lineBudget: 6, minBulletsPerEntry: 1, maxBulletsPerEntry: 2 },';
const TP_MID_PROJ_NEW = 'projects: { maxEntries: 2, lineBudget: 10, minBulletsPerEntry: 1, maxBulletsPerEntry: 3 },';

// -- TIER_PLANS.junior.sections.experience: maxBulletsPerEntry 5->4 --
const TP_JUNIOR_EXP_OLD = 'experience: { maxEntries: 3, lineBudget: 16, minBulletsPerEntry: 3, maxBulletsPerEntry: 5, mostRecentMinBullets: 4 },';
const TP_JUNIOR_EXP_NEW = 'experience: { maxEntries: 3, lineBudget: 16, minBulletsPerEntry: 3, maxBulletsPerEntry: 4, mostRecentMinBullets: 4 },';

// -- COUNT_PLANS: single-line JSON.stringify'd literal. OLD captured verbatim
//    from the live file (do not hand-retype -- see harness section 0 below,
//    which re-derives it from the live file and asserts it matches this
//    constant before ever using it as a replaceOnce anchor).
const COUNT_PLANS_OLD = 'const COUNT_PLANS = {"senior":{"experience":{"maxEntries":5,"shapes":{"1":[4],"2":[4,4],"3":[4,4,3],"4":[4,3,3,2],"5":[4,3,2,2,2]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[3,2],"1":[3,2],"2":[3,2],"3":[2,2],"4":[2],"5":[]}},"summaryLines":3,"achievementsMax":3},"mid":{"experience":{"maxEntries":4,"shapes":{"1":[4],"2":[4,4],"3":[4,3,3],"4":[3,3,2,2]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[3,3,2],"1":[3,3,2],"2":[3,2,2],"3":[2,2,2],"4":[2,2]}},"summaryLines":2,"achievementsMax":2},"junior":{"experience":{"maxEntries":3,"shapes":{"1":[5],"2":[5,4],"3":[5,4,4]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[4,4,3,3],"1":[4,4,3],"2":[4,3,3],"3":[3,3]}},"summaryLines":0,"achievementsMax":0},"fresher":{"experience":null,"internships":{"maxEntries":2,"shapes":{"1":[4],"2":[3,3]}},"projects":{"keyedOn":"internships","byCount":{"0":[4,4,3,3,3],"1":[4,4,3,3],"2":[4,3,3]}},"summaryLines":0,"achievementsMax":0}};';

// -- COUNT_PLANS NEW: only senior.projects.byCount, mid.projects.byCount, and
//    junior.experience.shapes change value. senior.experience.shapes already
//    carries the "4":[4,3,3,2] key live (see the class-level comment above) --
//    left byte-identical here. Same key order / no added whitespace throughout.
const COUNT_PLANS_NEW = 'const COUNT_PLANS = {"senior":{"experience":{"maxEntries":4,"shapes":{"1":[4],"2":[4,4],"3":[4,4,3],"4":[4,3,3,2],"5":[4,3,2,2,2]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[2,2],"1":[2,2],"2":[2,2],"3":[2,2,2],"4":[2,2],"5":[]}},"summaryLines":3,"achievementsMax":3},"mid":{"experience":{"maxEntries":4,"shapes":{"1":[4],"2":[4,4],"3":[4,3,3],"4":[3,3,2,2]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[3,3,3],"1":[3,3,3],"2":[3,3,2],"3":[2,2,2],"4":[3,2]}},"summaryLines":2,"achievementsMax":2},"junior":{"experience":{"maxEntries":3,"shapes":{"1":[4],"2":[4,4],"3":[4,4,3]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[4,4,3,3],"1":[4,4,3],"2":[4,3,3],"3":[3,3]}},"summaryLines":0,"achievementsMax":0},"fresher":{"experience":null,"internships":{"maxEntries":2,"shapes":{"1":[4],"2":[3,3]}},"projects":{"keyedOn":"internships","byCount":{"0":[4,4,3,3,3],"1":[4,4,3,3],"2":[4,3,3]}},"summaryLines":0,"achievementsMax":0}};';

// -- regression-guard text (item 3): must be byte-identical before AND after. --
const STYLE_2LINE_TEXT = "const STYLE_2LINE = {\n  linesPerBullet: 2, targetChars: [130, 155],\n  directive: 'Impact-and-scope style: each bullet 130-155 characters BEFORE the bold keyword lead-in (~2 printed lines total including the keyword): action verb + system/scope + technology + quantified outcome. Do not write bullets under 110 characters.'\n};";
const STYLE_1LINE_TEXT = "const STYLE_1LINE = {\n  linesPerBullet: 1, targetChars: [70, 110],\n  directive: 'Skills-evidence style: each bullet 70-110 characters (~1 printed line): one skill/tool demonstrated + a concrete artifact or result. Never exceed 110 characters.'\n};";

function patchBuildPass1Context(code) {
  code = replaceOnce(code, 'Build Pass1 Context', TP_SENIOR_ORDER_OLD, TP_SENIOR_ORDER_NEW, 'TIER_PLANS.senior.sectionOrder (+projects after experience)');
  code = replaceOnce(code, 'Build Pass1 Context', TP_SENIOR_EXP_OLD, TP_SENIOR_EXP_NEW, 'TIER_PLANS.senior.sections.experience (maxEntries 5->4, lineBudget 22->24)');
  code = replaceOnce(code, 'Build Pass1 Context', TP_SENIOR_PROJ_OLD, TP_SENIOR_PROJ_NEW, 'TIER_PLANS.senior.sections.projects ({0,0} -> real 3-entry slot)');
  code = replaceOnce(code, 'Build Pass1 Context', TP_MID_PROJ_OLD, TP_MID_PROJ_NEW, 'TIER_PLANS.mid.sections.projects (maxBulletsPerEntry 2->3, lineBudget 6->10)');
  code = replaceOnce(code, 'Build Pass1 Context', TP_JUNIOR_EXP_OLD, TP_JUNIOR_EXP_NEW, 'TIER_PLANS.junior.sections.experience (maxBulletsPerEntry 5->4)');
  code = replaceOnce(code, 'Build Pass1 Context', COUNT_PLANS_OLD, COUNT_PLANS_NEW, 'COUNT_PLANS (senior.projects.byCount, mid.projects.byCount, junior.experience.shapes rerange)');
  return code;
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Pass1 Selection -- 5 independently-anchored edits.
// ═══════════════════════════════════════════════════════════════════════
const P1_TECHSTACK_OLD = '"techStack": "<tech used>",';
const P1_TECHSTACK_NEW = '"techStack": "<the 3-4 technologies from this project MOST relevant to THIS JD, comma-separated, in JD-priority order -- not just an exhaustive tech list>",';

const P1_SECTIONORDER_SENIOR_OLD = '- SENIOR: ["summary", "experience", "skills", "achievements", "certifications", "education"] — include "achievements" ONLY if the master resume has an ## ACHIEVEMENTS section';
const P1_SECTIONORDER_SENIOR_NEW = '- SENIOR: ["summary", "experience", "projects", "skills", "achievements", "certifications", "education"] — include "projects" if the candidate has any real projects worth showing (side projects, OSS, notable technical work outside employment); include "achievements" ONLY if the master resume has an ## ACHIEVEMENTS section';

const P1_SPACEALLOC_SENIOR_OLD = '- SENIOR: 60% Experience, 15% Skills, 10% Certs, 10% Education, 5% Summary';
const P1_SPACEALLOC_SENIOR_NEW = '- SENIOR: 45% Experience, 15% Projects, 15% Skills, 10% Certs, 10% Education, 5% Summary';

const P1_TIERCAP_SENIOR_OLD = '- SENIOR: Include up to 5 experiences (the TIER CONTENT PLAN entry caps are authoritative).';
const P1_TIERCAP_SENIOR_NEW = '- SENIOR: Include up to 4 experiences (the TIER CONTENT PLAN entry caps are authoritative).';

const P1_MULTIROLE_OLD = 'If a candidate held MULTIPLE positions at the SAME company:\n- Count the entire company tenure for "longest tenure" calculation';
const P1_MULTIROLE_NEW = 'If a candidate held MULTIPLE positions at the SAME company:\n- Count the entire company tenure for "longest tenure" calculation\n- If the master resume LISTS these as separate, dated positions (distinct titles and/or date ranges under the same company), keep them as SEPARATE entries in the companies[].positions[] array, most-recent-first -- this lets the resume show a real promotion/transfer as a stacked block. NEVER split ONE listed role into multiple invented titles/positions just because the tenure was long -- only reflect splits that are ALREADY present in the master resume\'s own structure.';

function patchPass1Selection(msg) {
  msg = replaceOnce(msg, 'Pass1 Selection', P1_TECHSTACK_OLD, P1_TECHSTACK_NEW, 'selectedProjects.techStack schema line (JD-priority curation guidance)');
  msg = replaceOnce(msg, 'Pass1 Selection', P1_SECTIONORDER_SENIOR_OLD, P1_SECTIONORDER_SENIOR_NEW, 'SECTION ORDER BY TIER -- SENIOR line (+projects)');
  msg = replaceOnce(msg, 'Pass1 Selection', P1_SPACEALLOC_SENIOR_OLD, P1_SPACEALLOC_SENIOR_NEW, 'SPACE ALLOCATION BY TIER -- SENIOR line (45/15/15/10/10/5)');
  msg = replaceOnce(msg, 'Pass1 Selection', P1_TIERCAP_SENIOR_OLD, P1_TIERCAP_SENIOR_NEW, 'Tier capacity -- SENIOR line (up to 5 -> up to 4 experiences)');
  msg = replaceOnce(msg, 'Pass1 Selection', P1_MULTIROLE_OLD, P1_MULTIROLE_NEW, 'MULTI-ROLE / PROGRESSION DETECTION -- new stacked-block bullet');
  return msg;
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Pass2 Generate + Pass2 Regen -- identical edit applied to both (must
//    remain byte-identical after patching).
// ═══════════════════════════════════════════════════════════════════════
const P2_BULLETLEN_OLD = 'senior/mid bullets are 130-165 characters BEFORE the keyword lead-in';
const P2_BULLETLEN_NEW = 'senior/mid bullets are 130-155 characters BEFORE the keyword lead-in';

function patchPass2Message(msg, nodeLabel) {
  return replaceOnce(msg, nodeLabel, P2_BULLETLEN_OLD, P2_BULLETLEN_NEW, 'bullet-length sentence: 130-165 -> 130-155 (aligns with STYLE_2LINE.targetChars)');
}

// ═══════════════════════════════════════════════════════════════════════
// 6. ReviseForge -- one line's two numbers change; the OTHER "hard ceiling
//    240 chars" mention (schema note, different line) is untouched by design.
// ═══════════════════════════════════════════════════════════════════════
const RF_LINE_OLD = '- Every bullet\'s "text" stays plain text. Keep each revised bullet\'s length close to the original\'s (1-line ~110 chars vs 2-line ~200 chars style); hard ceiling 240 characters. Do NOT increase a section\'s total bullet count unless the instruction explicitly asks for it.';
const RF_LINE_NEW = '- Every bullet\'s "text" stays plain text. Keep each revised bullet\'s length close to the original\'s (1-line ~110 chars vs 2-line ~155 chars style); hard ceiling 210 characters. Do NOT increase a section\'s total bullet count unless the instruction explicitly asks for it.';

function patchReviseForge(msg) {
  return replaceOnce(msg, 'ReviseForge', RF_LINE_OLD, RF_LINE_NEW, 'revised-bullet-length line: 2-line ~200->~155 chars, hard ceiling 240->210');
}

// ═══════════════════════════════════════════════════════════════════════
// patch() -- applies all edits to a freshly-read copy of the live workflow,
// verifies invariants, writes the file.
// ═══════════════════════════════════════════════════════════════════════
function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  const NEEDED = ['Build Pass1 Context', 'Pass1 Selection', 'Pass2 Generate', 'Pass2 Regen', 'ReviseForge', ...OUT_OF_SCOPE_NODES];
  for (const need of NEEDED) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }

  if (N['Build Pass1 Context'].parameters.jsCode.includes("maxEntries: 3, lineBudget: 8")) {
    console.log(`  ${base}: already patched`);
    return;
  }

  // snapshot out-of-scope nodes so we can prove they never moved
  const beforeOutOfScope = {};
  for (const name of OUT_OF_SCOPE_NODES) beforeOutOfScope[name] = JSON.stringify(N[name]);

  N['Build Pass1 Context'].parameters.jsCode = patchBuildPass1Context(N['Build Pass1 Context'].parameters.jsCode);
  N['Pass1 Selection'].parameters.messages.messageValues[0].message = patchPass1Selection(N['Pass1 Selection'].parameters.messages.messageValues[0].message);
  N['Pass2 Generate'].parameters.messages.messageValues[0].message = patchPass2Message(N['Pass2 Generate'].parameters.messages.messageValues[0].message, 'Pass2 Generate');
  N['Pass2 Regen'].parameters.messages.messageValues[0].message = patchPass2Message(N['Pass2 Regen'].parameters.messages.messageValues[0].message, 'Pass2 Regen');
  N['ReviseForge'].parameters.messages.messageValues[0].message = patchReviseForge(N['ReviseForge'].parameters.messages.messageValues[0].message);

  // twin-identity invariant: Pass2 Generate / Pass2 Regen system prompts stay byte-identical
  const g = N['Pass2 Generate'].parameters.messages.messageValues[0].message;
  const r = N['Pass2 Regen'].parameters.messages.messageValues[0].message;
  if (g !== r) { console.error(`INTEGRITY FAIL ${base}: Pass2 Generate / Pass2 Regen prompts diverged after patch`); process.exit(1); }

  // out-of-scope invariant: LaTeX nodes + Parse Pass1 must be untouched
  for (const name of OUT_OF_SCOPE_NODES) {
    if (JSON.stringify(N[name]) !== beforeOutOfScope[name]) {
      console.error(`INTEGRITY FAIL ${base}: out-of-scope node "${name}" was modified -- this script must not touch it`); process.exit(1);
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: TIER_PLANS/COUNT_PLANS reshape + 4-node prompt sync applied`);
}

// ═══════════════════════════════════════════════════════════════════════
// HARNESS -- must print all-pass BEFORE any file write. Dry-runs every patch
// against a byte-exact snapshot of the REAL live workflow JSON.
// ═══════════════════════════════════════════════════════════════════════
(function harness() {
  if (!fs.existsSync(TARGET)) { console.error('HARNESS FAIL: target file not found'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  if (N['Build Pass1 Context'].parameters.jsCode.includes('maxEntries: 3, lineBudget: 8')) {
    console.log('HARNESS: target already patched (idempotent re-run) -- skipping dry-run checks, patch() will no-op too.');
    return;
  }

  // -- 0. COUNT_PLANS_OLD anchor must match the live literal EXACTLY (byte-for-byte,
  //    re-derived from the file, not hand-retyped) before it's trusted as a replaceOnce anchor. --
  {
    const liveCode = N['Build Pass1 Context'].parameters.jsCode;
    const si = liveCode.indexOf('const COUNT_PLANS = ');
    const ei = liveCode.indexOf(';', si) + 1;
    const liveLine = liveCode.slice(si, ei);
    if (liveLine !== COUNT_PLANS_OLD) {
      console.error('HARNESS FAIL: COUNT_PLANS_OLD constant does not byte-match the live COUNT_PLANS literal -- re-derive it from the live file.');
      console.error('LIVE :', liveLine);
      console.error('CONST:', COUNT_PLANS_OLD);
      process.exit(1);
    }
  }
  console.log('HARNESS OK: COUNT_PLANS_OLD anchor byte-matches the live literal');

  // -- 1. dry-run Build Pass1 Context patch; all 6 anchors unique (replaceOnce asserts this) --
  const patchedB1C = patchBuildPass1Context(N['Build Pass1 Context'].parameters.jsCode);
  console.log('HARNESS OK: all 6 Build Pass1 Context anchors (5 TIER_PLANS lines + COUNT_PLANS literal) unique and replaced');

  // -- 2. TIER_PLANS: extract + eval the patched object literal, assert exact shapes. --
  {
    const si = patchedB1C.indexOf('const TIER_PLANS = ');
    const ei = patchedB1C.indexOf('\n};', si) + 3;
    const tierPlansSrc = patchedB1C.slice(si, ei);
    // STYLE_2LINE/STYLE_1LINE are referenced by TIER_PLANS -- pull them in too.
    const styleSi = patchedB1C.indexOf('const STYLE_2LINE');
    const stylesSrc = patchedB1C.slice(styleSi, si);
    const fn = new Function(stylesSrc + '\n' + tierPlansSrc + '\nreturn TIER_PLANS;');
    const TP = fn();

    const s = TP.senior.sections;
    if (JSON.stringify(TP.senior.sectionOrder) !== JSON.stringify(['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'])) {
      console.error('HARNESS FAIL: TIER_PLANS.senior.sectionOrder wrong', TP.senior.sectionOrder); process.exit(1);
    }
    if (s.experience.maxEntries !== 4 || s.experience.lineBudget !== 24) { console.error('HARNESS FAIL: TIER_PLANS.senior.sections.experience wrong', s.experience); process.exit(1); }
    if (s.projects.maxEntries !== 3 || s.projects.lineBudget !== 8 || s.projects.minBulletsPerEntry !== 2 || s.projects.maxBulletsPerEntry !== 3) {
      console.error('HARNESS FAIL: TIER_PLANS.senior.sections.projects wrong', s.projects); process.exit(1);
    }
    // achievements/skills/certifications/education must stay UNCHANGED
    if (s.achievements.maxEntries !== 3 || s.skills.maxCategories !== 4 || s.certifications.maxEntries !== 2 || s.education.maxEntries !== 1) {
      console.error('HARNESS FAIL: TIER_PLANS.senior other sections were disturbed', s); process.exit(1);
    }

    const m = TP.mid.sections;
    if (m.projects.maxEntries !== 2 || m.projects.lineBudget !== 10 || m.projects.minBulletsPerEntry !== 1 || m.projects.maxBulletsPerEntry !== 3) {
      console.error('HARNESS FAIL: TIER_PLANS.mid.sections.projects wrong', m.projects); process.exit(1);
    }
    if (m.experience.maxEntries !== 4 || m.experience.lineBudget !== 16) { console.error('HARNESS FAIL: TIER_PLANS.mid.sections.experience was disturbed', m.experience); process.exit(1); }

    const j = TP.junior.sections;
    if (j.experience.maxBulletsPerEntry !== 4 || j.experience.mostRecentMinBullets !== 4 || j.experience.maxEntries !== 3 || j.experience.lineBudget !== 16) {
      console.error('HARNESS FAIL: TIER_PLANS.junior.sections.experience wrong', j.experience); process.exit(1);
    }

    if (TP.fresher.sections.experience.maxEntries !== 0) { console.error('HARNESS FAIL: TIER_PLANS.fresher was disturbed'); process.exit(1); }
  }
  console.log('HARNESS OK: patched TIER_PLANS evaluates cleanly -- senior (+projects sectionOrder, exp 4/24, projects 3/8/2/3), mid.projects (2/10/1/3, exp untouched), junior.experience (maxBulletsPerEntry 4, mostRecentMinBullets 4), senior achievements/skills/certifications/education + fresher untouched');

  // -- 3. COUNT_PLANS: JSON.parse the patched literal for real, assert exact shapes. --
  {
    const si = patchedB1C.indexOf('const COUNT_PLANS = ');
    const ei = patchedB1C.indexOf(';', si);
    const jsonText = patchedB1C.slice(si + 'const COUNT_PLANS = '.length, ei);
    const CP = JSON.parse(jsonText);

    if (JSON.stringify(CP.senior.experience.shapes) !== JSON.stringify({ '1': [4], '2': [4, 4], '3': [4, 4, 3], '4': [4, 3, 3, 2], '5': [4, 3, 2, 2, 2] })) {
      console.error('HARNESS FAIL: COUNT_PLANS.senior.experience.shapes wrong', CP.senior.experience.shapes); process.exit(1);
    }
    // Adversarial-verify catch (2026-07-21): the ORIGINAL spec only named
    // TIER_PLANS.senior.sections.experience.maxEntries (5->4) and never said
    // COUNT_PLANS.senior.experience.maxEntries needed the same change -- but
    // Parse Pass1's allocator reads maxEntries from COUNT_PLANS, not
    // TIER_PLANS (TIER_PLANS.sections.experience.maxEntries only feeds the
    // PROMPT TEXT and trimToLineBudget's lineBudget lookup). Left at 5, any
    // senior candidate with 5+ real positions would still get kept up to 5,
    // hit the untouched shapes["5"]=[4,3,2,2,2], and -- since
    // projects.byCount["5"] is now [] -- get ZERO projects, silently
    // defeating the entire senior 4+2 extension for exactly the candidates
    // (long careers, many roles) it exists for. Fixed to 4, matching
    // TIER_PLANS's new default. The "5" shapes/byCount rows stay in the
    // tables as inert fallback data -- s137 (Parse Pass1, effectiveOrder-
    // aware) may later restore maxEntries to 5 for the disclosed edge case
    // of a senior user who has explicitly excluded 'projects' from their
    // section-order pref; until then every senior candidate caps at 4,
    // which is the accepted interim simplification.
    if (CP.senior.experience.maxEntries !== 4) { console.error('HARNESS FAIL: COUNT_PLANS.senior.experience.maxEntries should be 4 (synced to TIER_PLANS -- Parse Pass1 reads THIS field as the real keep-cap, not TIER_PLANS.sections.experience.maxEntries)', CP.senior.experience.maxEntries); process.exit(1); }
    if (JSON.stringify(CP.senior.projects.byCount) !== JSON.stringify({ '0': [2, 2], '1': [2, 2], '2': [2, 2], '3': [2, 2, 2], '4': [2, 2], '5': [] })) {
      console.error('HARNESS FAIL: COUNT_PLANS.senior.projects.byCount wrong', CP.senior.projects.byCount); process.exit(1);
    }
    if (JSON.stringify(CP.mid.projects.byCount) !== JSON.stringify({ '0': [3, 3, 3], '1': [3, 3, 3], '2': [3, 3, 2], '3': [2, 2, 2], '4': [3, 2] })) {
      console.error('HARNESS FAIL: COUNT_PLANS.mid.projects.byCount wrong', CP.mid.projects.byCount); process.exit(1);
    }
    if (JSON.stringify(CP.mid.experience.shapes) !== JSON.stringify({ '1': [4], '2': [4, 4], '3': [4, 3, 3], '4': [3, 3, 2, 2] })) {
      console.error('HARNESS FAIL: COUNT_PLANS.mid.experience.shapes was disturbed', CP.mid.experience.shapes); process.exit(1);
    }
    if (JSON.stringify(CP.junior.experience.shapes) !== JSON.stringify({ '1': [4], '2': [4, 4], '3': [4, 4, 3] })) {
      console.error('HARNESS FAIL: COUNT_PLANS.junior.experience.shapes wrong', CP.junior.experience.shapes); process.exit(1);
    }
    if (JSON.stringify(CP.junior.projects.byCount) !== JSON.stringify({ '0': [4, 4, 3, 3], '1': [4, 4, 3], '2': [4, 3, 3], '3': [3, 3] })) {
      console.error('HARNESS FAIL: COUNT_PLANS.junior.projects.byCount was disturbed', CP.junior.projects.byCount); process.exit(1);
    }
    if (JSON.stringify(CP.fresher) !== JSON.stringify({ experience: null, internships: { maxEntries: 2, shapes: { '1': [4], '2': [3, 3] } }, projects: { keyedOn: 'internships', byCount: { '0': [4, 4, 3, 3, 3], '1': [4, 4, 3, 3], '2': [4, 3, 3] } }, summaryLines: 0, achievementsMax: 0 })) {
      console.error('HARNESS FAIL: COUNT_PLANS.fresher was disturbed', CP.fresher); process.exit(1);
    }
  }
  console.log('HARNESS OK: patched COUNT_PLANS JSON.parses cleanly -- senior.projects.byCount, mid.projects.byCount, junior.experience.shapes match spec exactly; senior.experience.maxEntries synced to 4 (Parse Pass1\'s real keep-cap -- see inline comment); senior.experience.shapes, mid.experience, junior.projects, fresher all untouched');

  // -- 4. regression guard (item 3): STYLE_2LINE/STYLE_1LINE byte-identical before/after. --
  {
    const before = N['Build Pass1 Context'].parameters.jsCode;
    if (!before.includes(STYLE_2LINE_TEXT)) { console.error('HARNESS FAIL: STYLE_2LINE_TEXT constant does not match the live file -- re-derive it'); process.exit(1); }
    if (!before.includes(STYLE_1LINE_TEXT)) { console.error('HARNESS FAIL: STYLE_1LINE_TEXT constant does not match the live file -- re-derive it'); process.exit(1); }
    if (!patchedB1C.includes(STYLE_2LINE_TEXT) || !patchedB1C.includes(STYLE_1LINE_TEXT)) {
      console.error('HARNESS FAIL: STYLE_2LINE/STYLE_1LINE were disturbed by patching (regression guard tripped)'); process.exit(1);
    }
  }
  console.log('HARNESS OK: STYLE_2LINE/STYLE_1LINE byte-identical before and after patching (regression guard, item 3 confirmed NO-OP)');

  // -- 5. Pass1 Selection: all 5 anchors found exactly once BEFORE patching, dry-run patch succeeds. --
  const p1Before = N['Pass1 Selection'].parameters.messages.messageValues[0].message;
  for (const [label, anchor] of [
    ['techStack schema line', P1_TECHSTACK_OLD],
    ['SECTION ORDER BY TIER senior line', P1_SECTIONORDER_SENIOR_OLD],
    ['SPACE ALLOCATION BY TIER senior line', P1_SPACEALLOC_SENIOR_OLD],
    ['Tier capacity senior line', P1_TIERCAP_SENIOR_OLD],
    ['MULTI-ROLE/PROGRESSION block', P1_MULTIROLE_OLD],
  ]) {
    const count = p1Before.split(anchor).length - 1;
    if (count !== 1) { console.error(`HARNESS FAIL: Pass1 Selection anchor "${label}" found ${count} times pre-patch, expected 1`); process.exit(1); }
  }
  const p1After = patchPass1Selection(p1Before);
  if (!p1After.includes('"projects", "skills", "achievements", "certifications", "education"] — include "projects" if the candidate has any real projects worth showing')) { console.error('HARNESS FAIL: Pass1 Selection SENIOR section-order edit did not land'); process.exit(1); }
  if (!p1After.includes('45% Experience, 15% Projects, 15% Skills, 10% Certs, 10% Education, 5% Summary')) { console.error('HARNESS FAIL: Pass1 Selection SENIOR space-allocation edit did not land'); process.exit(1); }
  if (!p1After.includes('Include up to 4 experiences')) { console.error('HARNESS FAIL: Pass1 Selection SENIOR tier-capacity edit did not land'); process.exit(1); }
  if (!p1After.includes('NEVER split ONE listed role into multiple invented titles/positions')) { console.error('HARNESS FAIL: Pass1 Selection MULTI-ROLE bullet did not land'); process.exit(1); }
  if (!p1After.includes('MOST relevant to THIS JD, comma-separated, in JD-priority order')) { console.error('HARNESS FAIL: Pass1 Selection techStack edit did not land'); process.exit(1); }
  console.log('HARNESS OK: Pass1 Selection -- all 5 anchors unique pre-patch, all 5 edits land correctly in the dry-run patch');

  // -- 6. Pass2 Generate / Pass2 Regen: byte-identical pre-patch, edit applies to both, byte-identical post-patch. --
  {
    const g0 = N['Pass2 Generate'].parameters.messages.messageValues[0].message;
    const r0 = N['Pass2 Regen'].parameters.messages.messageValues[0].message;
    if (g0 !== r0) { console.error('HARNESS FAIL: Pass2 Generate / Pass2 Regen are not byte-identical BEFORE patching -- precondition violated'); process.exit(1); }
    const g1 = patchPass2Message(g0, 'Pass2 Generate');
    const r1 = patchPass2Message(r0, 'Pass2 Regen');
    if (g1 !== r1) { console.error('HARNESS FAIL: Pass2 Generate / Pass2 Regen diverged after the dry-run patch'); process.exit(1); }
    if (!g1.includes('130-155 characters BEFORE the keyword lead-in')) { console.error('HARNESS FAIL: Pass2 bullet-length edit did not land'); process.exit(1); }
    if (!g1.includes('HARD ceiling 210 combined characters') || !g1.includes('145-character bullet beats a cut-off 200-character one')) {
      console.error('HARNESS FAIL: Pass2 sentence lost an untouched number (210 ceiling / 145 / 200 examples must stay exactly as-is)'); process.exit(1);
    }
  }
  console.log('HARNESS OK: Pass2 Generate === Pass2 Regen before AND after patching; 130-165 -> 130-155 landed; the 210/145/200 numbers in the same sentence stayed untouched');

  // -- 7. ReviseForge: line change lands correctly; the OTHER "240 chars" schema mention is untouched. --
  {
    const rfBefore = N['ReviseForge'].parameters.messages.messageValues[0].message;
    const rfAfter = patchReviseForge(rfBefore);
    if (!rfAfter.includes('2-line ~155 chars style); hard ceiling 210 characters.')) { console.error('HARNESS FAIL: ReviseForge line edit did not land correctly'); process.exit(1); }
    if (!rfAfter.includes('1-line ~110 chars vs 2-line ~155 chars')) { console.error('HARNESS FAIL: ReviseForge "1-line ~110 chars" portion was disturbed'); process.exit(1); }
    // the OTHER "hard ceiling 240 chars" mention (schema note) must survive untouched
    if (!rfAfter.includes('(keep each bullet\'s length close to the original\'s style; hard ceiling 240 chars)')) {
      console.error('HARNESS FAIL: ReviseForge schema-note "hard ceiling 240 chars" mention was disturbed -- only the OTHER line was meant to change'); process.exit(1);
    }
  }
  console.log('HARNESS OK: ReviseForge -- targeted line\'s "~200 chars"->"~155 chars" and "240"->"210" ceiling land; the untouched schema-note "240 chars" mention survives exactly as-is');

  // -- 8. out-of-scope nodes untouched by any patch function (sanity: none of the patch
  //    functions above were even called against them, but assert their raw content is
  //    identical to what a fresh read produces, catching any accidental aliasing bug). --
  {
    const wf2 = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
    const N2 = {}; wf2.nodes.forEach((n) => { N2[n.name] = n; });
    for (const name of OUT_OF_SCOPE_NODES) {
      if (JSON.stringify(N[name]) !== JSON.stringify(N2[name])) { console.error(`HARNESS FAIL: out-of-scope node "${name}" differs between two fresh reads (should be impossible)`); process.exit(1); }
    }
  }
  console.log('HARNESS OK: out-of-scope nodes (3 LaTeX nodes + Load Skeletons + Build Cover LaTeX + Parse Pass1) confirmed untouched');

  console.log('HARNESS: ALL CHECKS PASSED');
})();

patch(TARGET);
console.log('S136 (TIER_PLANS/COUNT_PLANS reshape + Pass1 Selection/Pass2 Generate/Pass2 Regen/ReviseForge prompt sync) complete.');
