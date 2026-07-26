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
// s141: header-line budget compensation -- interim measure until s142
// scales page budgets by locale. localeGateAllows is DELIBERATELY
// duplicated from the LaTeX render nodes (Code nodes can't share modules;
// tracked in export_prompts.js's HELPER_SETS) so this stays a real ESTIMATE
// of what buildHeaderFromPersonal will actually render, not a guess.
function localeGateAllows(fields, key) {
  return !!fields && (fields[key] === 'optional' || fields[key] === 'expected');
}
const _locProfile = c.locale_profile || null;
const _personal = c.personal || {};
let _extraHeaderLines = 0;
if (_locProfile && _locProfile.fields) {
  const _costs = _locProfile.header_line_costs || { pii_line: 1, work_auth_line: 1, photo: 5, signature_block: 3 };
  const _hasPii = (localeGateAllows(_locProfile.fields, 'dob') && _personal.dob) || (localeGateAllows(_locProfile.fields, 'nationality') && _personal.nationality) || (localeGateAllows(_locProfile.fields, 'marital_status') && _personal.marital_status);
  if (_hasPii) _extraHeaderLines += _costs.pii_line || 1;
  const _jobCountryCode = (c.locale && c.locale.code) || null;
  if (localeGateAllows(_locProfile.fields, 'work_authorization_status') && _jobCountryCode && _personal.work_authorization_status && _personal.work_authorization_status[_jobCountryCode]) _extraHeaderLines += _costs.work_auth_line || 1;
  if (localeGateAllows(_locProfile.fields, 'signature_line') && _personal.signature === true) _extraHeaderLines += _costs.signature_block || 3;
  if (localeGateAllows(_locProfile.fields, 'photo') && _personal.photo) _extraHeaderLines += _costs.photo || 5;
}
if (_extraHeaderLines > 0 && plan.sections[plan.primaryPool]) {
  plan.sections[plan.primaryPool].lineBudget = Math.max(4, plan.sections[plan.primaryPool].lineBudget - _extraHeaderLines);
}
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
