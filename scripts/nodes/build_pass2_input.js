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

const pass2Input = JSON.stringify({ decisions: pass1, jdRequirements: step0.clusters || [] });
const pass2_user = 'Generate LaTeX content based on selection decisions. The decisions contain VERBATIM resume excerpts — use them as the SOLE source for STAR bullets.'
  + antiHalluc + '\n\n' + pass2Input;

return [{ json: { pass2_user, pass1 } }];
