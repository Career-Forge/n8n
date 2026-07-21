// Auto-generated from the live workflow node "Build Pass1 Context" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// ═══════════════════════════════════════════════════════════════
// Build Pass1 Context — S6b-2
// ═══════════════════════════════════════════════════════════════
// Assembles the Pass-1 (selection) + Step-0 (JD analysis) USER messages from the
// consolidated apply context. REUSES upstream signals (SeniorityDetector tier +
// ForgeScore gaps/keyword_gaps are already merged into Prepare Apply Context) —
// Pass-1 does NOT re-derive them. Dossier bias rules (S6b-3) are injected when a
// "Pass Dossier" node exists upstream; absent => empty (graceful).
// Out: { pass1_user, step0_user, tier }

function buildBiasRules(dossier) {
  const b = (dossier && dossier.bullet_selection_biases) || {};
  const rules = [];
  if (b.prioritize_metrics) rules.push('SELECT bullets with quantified metrics and measurable outcomes');
  if (b.prioritize_ownership) rules.push('SELECT bullets demonstrating end-to-end ownership and autonomous decisions');
  if (b.prioritize_scale) rules.push('SELECT bullets involving large-scale systems, high user counts, or big data volumes');
  if (b.prioritize_customer_impact) rules.push('SELECT bullets where the result directly benefited users or customers');
  if (b.prioritize_research_rigor) rules.push('SELECT bullets showing research rigor, experimentation, and technical depth');
  if (b.prioritize_speed) rules.push('SELECT bullets showing shipping velocity and bias for action');
  const vals = (dossier && dossier.culture && Array.isArray(dossier.culture.values)) ? dossier.culture.values : [];
  const mv = (dossier && dossier.mission_vision) || '';
  let s = '';
  if (rules.length) {
    s += '\n\n== BULLET SELECTION BIASES (influence WHICH bullets to select, NOT their wording; never name-drop values in bullets) ==\n'
      + rules.map((r, i) => (i + 1) + '. ' + r).join('\n');
  }
  if (vals.length) s += '\n\nCompany values to resonate with (selection only): ' + vals.join(', ') + '.';
  if (mv) s += '\nCompany mission/vision: ' + mv;
  return s;
}

const c = $('Prepare Apply Context').first().json || {};
// F3: identity passthrough -- SeniorityDetector now outputs the same 4-bucket
// taxonomy Pass1 uses. 'experienced' kept only as a fallback for pre-F3 static
// data; the old map collapsed it into 'mid' unconditionally, making Pass1's
// own 'junior' tier unreachable.
const tierMap = { fresher: 'fresher', junior: 'junior', mid: 'mid', senior: 'senior', experienced: 'mid' };
const tier = tierMap[c.seniority_mode] || 'mid';

// ═══ TIER CONTENT PLANS -- single source of truth (v7) ═══
// lineBudget = PRINTED LINES, not bullets: a 2-line bullet costs 2. Numbers
// empirically calibrated via real pdflatex compiles against the s43-tightened
// skeleton (single-page verified per tier; overflow probe verified binding).
const STYLE_2LINE = {
  linesPerBullet: 2, targetChars: [130, 155],
  directive: 'Impact-and-scope style: each bullet 130-155 characters BEFORE the bold keyword lead-in (~2 printed lines total including the keyword): action verb + system/scope + technology + quantified outcome. Do not write bullets under 110 characters.'
};
const STYLE_1LINE = {
  linesPerBullet: 1, targetChars: [70, 110],
  directive: 'Skills-evidence style: each bullet 70-110 characters (~1 printed line): one skill/tool demonstrated + a concrete artifact or result. Never exceed 110 characters.'
};
const TIER_PLANS = {
  senior: {
    sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
    summaryLines: 3,
    bulletStyle: STYLE_2LINE,
    sections: {
      experience: { maxEntries: 4, lineBudget: 24, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 },
      projects: { maxEntries: 3, lineBudget: 8, minBulletsPerEntry: 2, maxBulletsPerEntry: 3 },
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
      projects: { maxEntries: 2, lineBudget: 10, minBulletsPerEntry: 1, maxBulletsPerEntry: 3 },
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
      experience: { maxEntries: 3, lineBudget: 16, minBulletsPerEntry: 3, maxBulletsPerEntry: 4, mostRecentMinBullets: 4 },
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
const COUNT_PLANS = {"senior":{"experience":{"maxEntries":4,"shapes":{"1":[4],"2":[4,4],"3":[4,4,3],"4":[4,3,3,2],"5":[4,3,2,2,2]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[2,2],"1":[2,2],"2":[2,2],"3":[2,2,2],"4":[2,2],"5":[]}},"summaryLines":3,"achievementsMax":3},"mid":{"experience":{"maxEntries":4,"shapes":{"1":[4],"2":[4,4],"3":[4,3,3],"4":[3,3,2,2]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[3,3,3],"1":[3,3,3],"2":[3,3,2],"3":[2,2,2],"4":[3,2]}},"summaryLines":2,"achievementsMax":2},"junior":{"experience":{"maxEntries":3,"shapes":{"1":[4],"2":[4,4],"3":[4,4,3]}},"internships":null,"projects":{"keyedOn":"experience","byCount":{"0":[4,4,3,3],"1":[4,4,3],"2":[4,3,3],"3":[3,3]}},"summaryLines":0,"achievementsMax":0},"fresher":{"experience":null,"internships":{"maxEntries":2,"shapes":{"1":[4],"2":[3,3]}},"projects":{"keyedOn":"internships","byCount":{"0":[4,4,3,3,3],"1":[4,4,3,3],"2":[4,3,3]}},"summaryLines":0,"achievementsMax":0}};
const plan = JSON.parse(JSON.stringify(TIER_PLANS[tier] || TIER_PLANS.mid));
plan.countPlan = JSON.parse(JSON.stringify(COUNT_PLANS[tier] || COUNT_PLANS.mid));
const planBlock = '\n\n== TIER CONTENT PLAN (tier: ' + tier + ') =='
  + '\nDefault sectionOrder (user overrides take priority): ' + JSON.stringify(plan.sectionOrder)
  + '\nEntry caps: experience ' + plan.sections.experience.maxEntries
  + ', projects ' + plan.sections.projects.maxEntries
  + ', internships ' + plan.sections.internships.maxEntries
  + ', achievements ' + plan.sections.achievements.maxEntries
  + ', certifications ' + plan.sections.certifications.maxEntries
  + ', education ' + plan.sections.education.maxEntries + '.'
  + '\nBullet style: ' + plan.bulletStyle.directive
  + '\nBullet counts: a deterministic allocator recomputes every bulletCount AFTER your selection -- your bulletCount values are advisory. Extract AT LEAST ' + plan.sections[plan.primaryPool].maxBulletsPerEntry + ' VERBATIM keyAchievements for recent/relevant positions so the allocator has material to work with.';

const masterResume = (c.resume_text && String(c.resume_text).trim())
  ? c.resume_text
  : JSON.stringify(c.selected_resume_bubbles || c.candidate_context_for_generation || []);
const jd = c.job_description || '';

let dossier = null;
try { dossier = ($('Pass Dossier').first().json || {}).dossier || null; } catch (e) { dossier = null; }
const bias = dossier ? buildBiasRules(dossier) : '';

const kg = Array.isArray(c.keyword_gaps) ? c.keyword_gaps : [];
const gaps = Array.isArray(c.gaps) ? c.gaps : [];
let feedback = '';
if (kg.length || gaps.length) {
  feedback = '\n\n== UPSTREAM FIT FEEDBACK (strengthen these; weave keywords only if truthful) ==';
  if (kg.length) feedback += '\nMissing keywords to weave in: ' + kg.join(', ');
  if (gaps.length) feedback += '\nGaps to address: ' + gaps.join('; ');
}
if (c._ats_feedback) feedback += '\n\n== ATS RETRY: the previous resume scored low. Specifically fix: ' + c._ats_feedback;

const tierHint = '\n\n== UPSTREAM CLASSIFIER ==\nDetected tier: ' + tier
  + ' (candidate YOE ~' + (c.candidate_yoe != null ? c.candidate_yoe : '?')
  + '). Use this tier unless the resume clearly contradicts it.';

const _prefs = $getWorkflowStaticData('global').user_prefs || {};
let sectionOverride = '';
if (Array.isArray(_prefs.section_order) && _prefs.section_order.length) {
  sectionOverride = '\n\n== USER SECTION ORDER OVERRIDE (HIGHEST PRIORITY) ==\nThe user has explicitly chosen the EXACT section order. You MUST set sectionOrder to EXACTLY: ' + JSON.stringify(_prefs.section_order) + '. Do NOT reorder, add, or remove any sections. This order is FINAL.';
} else if (Array.isArray(_prefs.enabled_sections) && _prefs.enabled_sections.length) {
  sectionOverride = '\n\n== USER SECTION OVERRIDE (HIGHEST PRIORITY) ==\nThe user has explicitly selected which sections to include. You MUST use ONLY these sections in sectionOrder (in the best order for the tier): ' + _prefs.enabled_sections.join(', ') + '. Do NOT include any section not in this list, regardless of tier rules.';
}

const pass1_user = 'Master Resume:\n' + masterResume + '\n\nJob Description:\n' + jd + tierHint + bias + feedback + sectionOverride + planBlock;
const step0_user = 'Job Description:\n' + jd;

return [{ json: { pass1_user, step0_user, tier, plan } }];
