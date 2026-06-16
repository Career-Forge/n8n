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
  + 'If an excerpt genuinely covers a gap, make that coverage explicit; if no excerpt covers it, leave it out (do not invent).';

const pass2Input = JSON.stringify({ decisions: pass1, jdRequirements: step0.clusters || [] });
const pass2_user = 'Generate LaTeX content based on selection decisions. The decisions contain VERBATIM resume excerpts — use them as the SOLE source for STAR bullets.'
  + antiHalluc + atsGuidance + '\n\n' + pass2Input;

return [{ json: { pass2_user, pass1 } }];
