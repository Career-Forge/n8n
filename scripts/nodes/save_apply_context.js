// Auto-generated from the live workflow node "Save Apply Context" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Save Apply Context — rewritten in S6c. Stores last-apply state for the "revise"
// feature. The original referenced $('ResumeForge'), which S6b-2 deleted (this was a
// latent crash on the cover path). Now reads the 2-phase pipeline output gracefully
// (try/catch — resume + cover branches run in parallel off Pass Dossier, so the resume
// nodes may not be done when the cover branch reaches here; best-effort, never throws).
const sd = $getWorkflowStaticData('global');
function getJson(n) { try { return ($(n).first() || {}).json || {}; } catch (e) { return {}; } }

const jdCtx = getJson('Prepare Job Context');
let resumeJson = {};
try { resumeJson = ($('Parse Pass2').first().json || {}).pass2 || {}; } catch (e) { resumeJson = {}; }
const seniorityOutput = getJson('SeniorityDetector').output || {};
const forgeScoreOutput = getJson('ForgeScore').output || {};

// last_resume_json now owned by Store Apply Context (merged plain-text content; runs after both apply branches complete)
sd.last_jd = jdCtx.job_description || '';
sd.last_fit_strategy = seniorityOutput.fit_strategy || 'perfect_fit';
sd.last_keyword_gaps = forgeScoreOutput.keyword_gaps || [];

return $input.all();
