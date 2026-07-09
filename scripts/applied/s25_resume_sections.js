/**
 * s25_resume_sections.js -- Phase 4.2a (Roadmap v4): resume section/order customization.
 *
 * Ports the section-toggle/reorder mechanism from careerforge-command-center (the
 * original implementation) into text-command form for Telegram: `sections: experience,
 * projects, skills` (which sections to include) and `order: experience, projects,
 * skills` (exact order -- implies membership too, matching command-center's "USER
 * SECTION ORDER OVERRIDE" semantics: highest priority, no LLM discretion). Both are
 * enforced twice -- once as a prompt instruction to Pass1 Selection, and again as a
 * code-level backstop in Parse Pass1 that filters/reorders the LLM's own output --
 * because trusting the LLM alone to honor a toggle is exactly the kind of silent-
 * failure class this project has been fixing all session (F1-F4).
 *
 * v1 scope, explicitly deferred (not silently dropped):
 * - No "detect sections at upload" LLM call / auto-discovery UX -- the `sections:`
 *   command's own help text lists the 9 canonical ids directly, so it's usable
 *   without needing bot-detection first. A real, separate, nice-to-have.
 * - No compact-vs-normal template density pref. That axis needs changes to the
 *   SHARED renderResume logic (Assemble Resume LaTeX / Assemble Regen / Build
 *   Revised LaTeX all use the same skeleton) -- real blast-radius on the single
 *   highest-stakes code path in the whole bot (resume PDF generation for every
 *   user, every apply). Not worth rushing given this session's explicit "resume
 *   generation must be flawless" directive. Deliberately NOT even accepting the
 *   `template:` pref yet -- accepting a preference that silently has no effect
 *   would be its own dishonest-partial-feature bug, the same failure class this
 *   whole roadmap has been about fixing, not reintroducing.
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

const CANONICAL_SECTIONS = ['summary', 'experience', 'internships', 'education', 'projects', 'skills', 'certifications', 'achievements', 'activities'];

// ═══════════════════════════════════════════════════════════════
// 1. Handle Prefs Update -- sections:/order: regex handlers
// ═══════════════════════════════════════════════════════════════

const HPU_ANCHOR_OLD = `// ── Timezone ──────────────────────────────────────────────────────────────`;
const HPU_NEW_BLOCK = `// ── Resume sections (which sections to include in generated resumes) ────
// Canonical ids: summary, experience, internships, education, projects, skills,
// certifications, achievements, activities. Requires an explicit colon (like
// schedule_query:) to avoid false-positive matches on ordinary sentences.
const CANONICAL_SECTIONS = ['summary', 'experience', 'internships', 'education', 'projects', 'skills', 'certifications', 'achievements', 'activities'];
if ((m = msg.match(/\\bsections\\s*:\\s*([a-z, ]+?)(?:[.!]|$)/i))) {
  const list = m[1].split(',').map((s) => s.trim().toLowerCase()).filter((s) => CANONICAL_SECTIONS.includes(s));
  if (list.length) delta.enabled_sections = [...new Set(list)];
}

// ── Resume section order (exact order + membership -- highest priority) ──
if ((m = msg.match(/\\border\\s*:\\s*([a-z, ]+?)(?:[.!]|$)/i))) {
  const list = m[1].split(',').map((s) => s.trim().toLowerCase()).filter((s) => CANONICAL_SECTIONS.includes(s));
  if (list.length) delta.section_order = [...new Set(list)];
}

// ── Timezone ──────────────────────────────────────────────────────────────`;

// ═══════════════════════════════════════════════════════════════
// 2. Build Pass1 Context -- inject the section override as a prompt instruction
// ═══════════════════════════════════════════════════════════════

const BP1_ANCHOR_OLD = `const pass1_user = 'Master Resume:\\n' + masterResume + '\\n\\nJob Description:\\n' + jd + tierHint + bias + feedback;`;
const BP1_NEW_BLOCK = `const _prefs = $getWorkflowStaticData('global').user_prefs || {};
let sectionOverride = '';
if (Array.isArray(_prefs.section_order) && _prefs.section_order.length) {
  sectionOverride = '\\n\\n== USER SECTION ORDER OVERRIDE (HIGHEST PRIORITY) ==\\nThe user has explicitly chosen the EXACT section order. You MUST set sectionOrder to EXACTLY: ' + JSON.stringify(_prefs.section_order) + '. Do NOT reorder, add, or remove any sections. This order is FINAL.';
} else if (Array.isArray(_prefs.enabled_sections) && _prefs.enabled_sections.length) {
  sectionOverride = '\\n\\n== USER SECTION OVERRIDE (HIGHEST PRIORITY) ==\\nThe user has explicitly selected which sections to include. You MUST use ONLY these sections in sectionOrder (in the best order for the tier): ' + _prefs.enabled_sections.join(', ') + '. Do NOT include any section not in this list, regardless of tier rules.';
}

const pass1_user = 'Master Resume:\\n' + masterResume + '\\n\\nJob Description:\\n' + jd + tierHint + bias + feedback + sectionOverride;`;

// ═══════════════════════════════════════════════════════════════
// 3. Parse Pass1 -- code-level backstop (never trust the LLM alone)
// ═══════════════════════════════════════════════════════════════

const PP1_OLD = `const t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);return [{json:{pass1:parseJSON(raw)}}];`;
const PP1_NEW = `const t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);
const pass1 = parseJSON(raw);
// Phase 4.2a: code-level backstop for the section override -- enforce it even if
// the LLM ignored the prompt instruction (see Build Pass1 Context).
const _prefs = $getWorkflowStaticData('global').user_prefs || {};
if (Array.isArray(_prefs.section_order) && _prefs.section_order.length) {
  pass1.sectionOrder = _prefs.section_order.slice();
} else if (Array.isArray(_prefs.enabled_sections) && _prefs.enabled_sections.length) {
  pass1.sectionOrder = (Array.isArray(pass1.sectionOrder) ? pass1.sectionOrder : []).filter((s) => _prefs.enabled_sections.includes(s));
}
return [{json:{pass1:pass1}}];`;

function replaceExact(node, base, label, oldStr, newStr, getField, setField) {
  const cur = getField(node);
  if (typeof cur !== 'string') { console.error(`INTEGRITY FAIL ${base}: ${label} -- getField() returned ${typeof cur}`); process.exit(1); }
  if (cur === newStr) return false;
  if (cur.indexOf(oldStr) === -1) { console.error(`INTEGRITY FAIL ${base}: ${label} does not contain expected old value.\nGot (first 300 chars): ${cur.slice(0, 300)}`); process.exit(1); }
  setField(cur.split(oldStr).join(newStr));
  return true;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of ['Handle Prefs Update', 'Build Pass1 Context', 'Parse Pass1']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  {
    const n = N['Handle Prefs Update'];
    if (replaceExact(n, base, 'Handle Prefs Update sections/order block', HPU_ANCHOR_OLD, HPU_NEW_BLOCK, () => n.parameters.jsCode, (v) => { n.parameters.jsCode = v; })) edits++;
  }
  {
    const n = N['Build Pass1 Context'];
    if (replaceExact(n, base, 'Build Pass1 Context section override injection', BP1_ANCHOR_OLD, BP1_NEW_BLOCK, () => n.parameters.jsCode, (v) => { n.parameters.jsCode = v; })) edits++;
  }
  {
    const n = N['Parse Pass1'];
    if (replaceExact(n, base, 'Parse Pass1 section backstop', PP1_OLD, PP1_NEW, () => n.parameters.jsCode, (v) => { n.parameters.jsCode = v; })) edits++;
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: resume section customization applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  const failures = [];
  function check(name, cond) { if (!cond) failures.push(name); }

  // 1. Handle Prefs Update: sections:/order: extraction, including false-positive guard.
  function extractDelta(msg) {
    const delta = {}; let m;
    const lower = msg.toLowerCase();
    if ((m = lower.match(/\bsections\s*:\s*([a-z, ]+?)(?:[.!]|$)/i))) {
      const list = m[1].split(',').map((s) => s.trim().toLowerCase()).filter((s) => CANONICAL_SECTIONS.includes(s));
      if (list.length) delta.enabled_sections = [...new Set(list)];
    }
    if ((m = lower.match(/\border\s*:\s*([a-z, ]+?)(?:[.!]|$)/i))) {
      const list = m[1].split(',').map((s) => s.trim().toLowerCase()).filter((s) => CANONICAL_SECTIONS.includes(s));
      if (list.length) delta.section_order = [...new Set(list)];
    }
    return delta;
  }
  {
    const d = extractDelta('sections: experience, projects, skills, education');
    check('Handle Prefs Update: sections: extracts valid canonical ids', JSON.stringify(d.enabled_sections) === JSON.stringify(['experience', 'projects', 'skills', 'education']));
  }
  {
    const d = extractDelta('sections: experience, banana, projects');
    check('Handle Prefs Update: sections: drops non-canonical terms', JSON.stringify(d.enabled_sections) === JSON.stringify(['experience', 'projects']));
  }
  {
    const d = extractDelta('order: education, skills, experience');
    check('Handle Prefs Update: order: preserves exact given order', JSON.stringify(d.section_order) === JSON.stringify(['education', 'skills', 'experience']));
  }
  {
    const d = extractDelta("in order to get this job I'll need to relocate");
    check('Handle Prefs Update: "in order to..." does not false-positive match', d.section_order === undefined);
  }

  // 2. Build Pass1 Context: section override injection, both priority branches + neither-set case.
  function buildOverride(prefs) {
    const $getWorkflowStaticData = () => ({ user_prefs: prefs });
    const src = `
      const _prefs = $getWorkflowStaticData('global').user_prefs || {};
      let sectionOverride = '';
      if (Array.isArray(_prefs.section_order) && _prefs.section_order.length) {
        sectionOverride = 'ORDER:' + JSON.stringify(_prefs.section_order);
      } else if (Array.isArray(_prefs.enabled_sections) && _prefs.enabled_sections.length) {
        sectionOverride = 'ENABLED:' + _prefs.enabled_sections.join(', ');
      }
      return sectionOverride;
    `;
    return new Function('$getWorkflowStaticData', src)($getWorkflowStaticData);
  }
  check('Build Pass1 Context: order takes priority over enabled_sections', buildOverride({ section_order: ['skills', 'experience'], enabled_sections: ['education'] }) === "ORDER:" + JSON.stringify(['skills', 'experience']));
  check('Build Pass1 Context: enabled_sections used when no order set', buildOverride({ enabled_sections: ['experience', 'projects'] }) === 'ENABLED:experience, projects');
  check('Build Pass1 Context: no override when neither pref set', buildOverride({}) === '');

  // 3. Parse Pass1 backstop: filters LLM's sectionOrder against enabled_sections; full
  // override when section_order is set; no-op when neither pref is set.
  function applyBackstop(llmSectionOrder, prefs) {
    const $getWorkflowStaticData = () => ({ user_prefs: prefs });
    const src = `
      const pass1 = { sectionOrder: ${JSON.stringify(llmSectionOrder)} };
      const _prefs = $getWorkflowStaticData('global').user_prefs || {};
      if (Array.isArray(_prefs.section_order) && _prefs.section_order.length) {
        pass1.sectionOrder = _prefs.section_order.slice();
      } else if (Array.isArray(_prefs.enabled_sections) && _prefs.enabled_sections.length) {
        pass1.sectionOrder = (Array.isArray(pass1.sectionOrder) ? pass1.sectionOrder : []).filter((s) => _prefs.enabled_sections.includes(s));
      }
      return pass1.sectionOrder;
    `;
    return new Function('$getWorkflowStaticData', src)($getWorkflowStaticData);
  }
  check('Parse Pass1 backstop: LLM ignoring enabled_sections gets corrected', JSON.stringify(applyBackstop(['experience', 'certifications', 'skills'], { enabled_sections: ['experience', 'skills'] })) === JSON.stringify(['experience', 'skills']));
  check('Parse Pass1 backstop: section_order fully overrides regardless of LLM output', JSON.stringify(applyBackstop(['experience', 'skills'], { section_order: ['education', 'projects'] })) === JSON.stringify(['education', 'projects']));
  check('Parse Pass1 backstop: no-op when neither pref set', JSON.stringify(applyBackstop(['experience', 'projects'], {})) === JSON.stringify(['experience', 'projects']));

  if (failures.length) { console.error('HARNESS FAIL:', failures.join(', ')); process.exit(1); }
  console.log('HARNESS OK: sections:/order: extraction (incl. false-positive guard + non-canonical filtering), Build Pass1 Context override priority (order > enabled > none), Parse Pass1 backstop (corrects/overrides/no-ops correctly) -- all verified');
})();

TARGETS.forEach(patch);
console.log('S25 (resume section customization) complete.');
