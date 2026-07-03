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

const pass1_user = 'Master Resume:\n' + masterResume + '\n\nJob Description:\n' + jd + tierHint + bias + feedback;
const step0_user = 'Job Description:\n' + jd;

return [{ json: { pass1_user, step0_user, tier } }];
