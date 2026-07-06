// Auto-generated from the live workflow node "Build Pass2 Regen Input" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Build Pass2 Regen Input — S6b-4. On a low ATS score, rebuild the Pass-2 user
// message reusing the existing Pass-1 selection + Step-0 clusters, plus the ATS
// gaps as targeted (truthful, no-fabrication) strengthening guidance. Out: {pass2_user, pass1}.
const pass1 = ($('Parse Pass1').first().json || {}).pass1 || {};
let step0 = {};
try { step0 = ($('Parse Step0').first().json || {}).step0 || {}; } catch (e) { step0 = {}; }
const ats = ($('Calculate ATS Score').first().json || {}).ats || {};
const gaps = (ats.gaps || []).slice(0, 5);

const antiHalluc = '\n\nCRITICAL ANTI-HALLUCINATION RULES:\n'
  + '- NEVER mention company values, leadership principles, or culture keywords by name in any bullet\n'
  + '- Bullets must read as natural achievements, not value-signaling statements\n'
  + '- Use ONLY the verbatim excerpts from Pass 1 decisions as source material — do NOT invent metrics, technologies, or achievements';
const atsGuidance = '\n\n== ATS RETRY ==\nThe previous resume scored ' + (ats.overall_score || 0) + '/100. '
  + 'Without fabricating anything, surface TRUTHFUL coverage of these weak/missing areas by choosing wording and emphasis from the existing excerpts that legitimately addresses them: '
  + (gaps.length ? gaps.join('; ') : 'overall keyword alignment') + '. '
  + 'If an excerpt genuinely covers a gap, make that coverage explicit; if no excerpt covers it, leave it out (do not invent).'
  + ' NEVER change dates, employment durations, job titles, companies, or education facts — those are fixed by Pass 1 and must be byte-identical to the previous attempt.';

function buildBudgetBlock(p1) {
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
  return '\n\n== BULLET BUDGET (MANDATORY) ==\nTier: ' + (cp.tier || 'unknown') + '. Style: ' + (cp.directive || '') + '\nWrite EXACTLY these bullet counts per entry:\n' + lines.join('\n');
}
const pass2Input = JSON.stringify({ decisions: pass1, jdRequirements: step0.clusters || [] });
const pass2_user = 'Generate plain-text resume content based on selection decisions. The decisions contain VERBATIM resume excerpts — use them as the SOLE source for STAR bullets.'
  + antiHalluc + atsGuidance + buildBudgetBlock(pass1) + '\n\n' + pass2Input;

return [{ json: { pass2_user, pass1 } }];
