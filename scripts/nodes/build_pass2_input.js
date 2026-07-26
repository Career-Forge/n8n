// Auto-generated from the live workflow node "Build Pass2 Input" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// ═══════════════════════════════════════════════════════════════
// Build Pass2 Input — S6b-2
// ═══════════════════════════════════════════════════════════════
// Builds the Pass-2 USER message from Pass-1 decisions + Step-0 JD clusters
// (mirrors command-center handleResumePhase2 pass2Input + antiHallucinationGuard).
// Carries pass1 forward so Parse Pass2 can hand {pass1, pass2} to Assemble.
// Out: { pass2_user, pass1 }

const pass1 = ($('Parse Pass1').first().json || {}).pass1 || {};
let step0 = {};
try { step0 = ($('Parse Step0').first().json || {}).step0 || {}; } catch (e) { step0 = {}; }

const antiHalluc = '\n\nCRITICAL ANTI-HALLUCINATION RULES:\n'
  + '- NEVER mention company values, leadership principles, or culture keywords by name in any bullet\n'
  + '- NEVER write phrases like "demonstrating Customer Obsession", "aligned with LP", or "showing Ownership"\n'
  + '- Bullets must read as natural achievements, not value-signaling statements\n'
  + '- The resume should work equally well for ANY company — no company-specific framing\n'
  + '- Use ONLY the verbatim excerpts from Pass 1 decisions as source material — do NOT invent metrics, technologies, or achievements';

function buildLocaleBlock(profile) {
  if (!profile) return '';
  const hints = Array.isArray(profile.style_hints) ? profile.style_hints.filter(Boolean) : [];
  if (profile.spelling !== 'en-GB' && !hints.length) return '';
  const spelling = profile.spelling === 'en-GB' ? 'British English spelling (e.g. "optimised", "colour", "organisation")' : 'American English spelling';
  let block = '\n\n== LOCALE STYLE ==\nWrite in ' + spelling + '.';
  if (hints.length) block += ' ' + hints.join(' ');
  return block;
}
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
  + antiHalluc + buildLocaleBlock((($('Prepare Apply Context').first().json || {}).locale_profile) || null) + buildBudgetBlock(pass1) + '\n\n' + pass2Input;

return [{ json: { pass2_user, pass1 } }];
