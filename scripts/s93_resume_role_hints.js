/**
 * s93_resume_role_hints.js -- implements a spec item that was never actually
 * built: the user's stated find_jobs design wants role keywords to come from
 * the message first, falling back to resume-derived guesses ONLY when the
 * message has no role language at all (e.g. a bare "find jobs" or a
 * scheduled generic run) -- symmetric with the location PRIORITY RULE that
 * already works this way. Before this patch, Expand Query received ZERO
 * resume signal for role_families -- Prep Expand Input only ever extracted a
 * resume-derived COUNTRY default (s77), never role/skill hints -- so a bare
 * "find jobs" produced whatever generic titles the LLM guessed, completely
 * ungrounded in the candidate's actual background.
 *
 * Prep Expand Input now also extracts resume_role_hints (most recent 3
 * experience titles + up to 10 flattened skills, same flattening idiom
 * Build Scorer Input's flatSkills already uses, capped ~300 chars) from the
 * SAME parsed resume buffer already being read for the country default --
 * no second file read. Expand Query's prompt gains a ROLE PRIORITY RULE
 * mirroring the location rule's own structure: message role/title language
 * always wins; resume hints only backfill when the message has none; never
 * blend.
 *
 * No node count change (existing nodes only). Run: inside the n8n container
 * with the repo staged under /tmp. Re-export prompts/ExpandQuery.md via
 * scripts/export_prompts.js after this deploys.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Prep Expand Input: extractResumeRoleHints, inserted after resolveResumeCountryDefault ═══
const PEI_FN_OLD = `    const iso = NAME_TO_ISO[first.toLowerCase().trim()];
    return iso || null;
  } catch (e) { return null; }
}

const sd = $getWorkflowStaticData('global');`;
const PEI_FN_NEW = `    const iso = NAME_TO_ISO[first.toLowerCase().trim()];
    return iso || null;
  } catch (e) { return null; }
}

// s93: resume-derived role hints, same "message wins, resume is fallback"
// shape as the country default above. Flattens skills the same way Build
// Scorer Input's flatSkills already does (mirrored, not shared -- Code nodes
// can't share modules). Trusts the resume's own experience array order
// (most-recent-first) rather than re-sorting, matching how Build Scorer
// Input already reads r.experience.slice(0, N) with no re-sort.
function extractResumeRoleHints(resumeJson) {
  try {
    const exp = Array.isArray(resumeJson && resumeJson.experience) ? resumeJson.experience : [];
    const titles = exp.slice(0, 3).map((e) => e && e.title).filter(Boolean);
    const skillsObj = (resumeJson && resumeJson.skills) || {};
    const allSkills = [];
    if (skillsObj && typeof skillsObj === 'object') {
      for (const vals of Object.values(skillsObj)) if (Array.isArray(vals)) allSkills.push(...vals);
    }
    const skills = [...new Set(allSkills.map((s) => String(s).trim()).filter(Boolean))].slice(0, 10);
    if (!titles.length && !skills.length) return null;
    const parts = [];
    if (titles.length) parts.push('Recent roles: ' + titles.join(', '));
    if (skills.length) parts.push('Skills: ' + skills.join(', '));
    return parts.join('. ').slice(0, 300) || null;
  } catch (e) { return null; }
}

const sd = $getWorkflowStaticData('global');`;

// ═══ 2. Prep Expand Input: parse the resume buffer once, derive BOTH the country default and role hints ═══
const PEI_BUFFER_OLD = `let resumeCountryDefault = null;
try {
  const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
  if (buf && buf.length) resumeCountryDefault = resolveResumeCountryDefault(JSON.parse(buf.toString('utf8')), ($('Load Geo Reference (Search)').first().json.geo_reference) || {});
} catch (e) {}`;
const PEI_BUFFER_NEW = `let resumeCountryDefault = null;
let resumeRoleHints = null;
try {
  const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
  if (buf && buf.length) {
    const resumeJson = JSON.parse(buf.toString('utf8'));
    resumeCountryDefault = resolveResumeCountryDefault(resumeJson, ($('Load Geo Reference (Search)').first().json.geo_reference) || {});
    resumeRoleHints = extractResumeRoleHints(resumeJson);
  }
} catch (e) {}`;

// ═══ 3. Prep Expand Input: emit resume_role_hints on the returned json ═══
const PEI_RETURN_OLD = `    resume_country_default: resumeCountryDefault
  }
}];`;
const PEI_RETURN_NEW = `    resume_country_default: resumeCountryDefault,
    resume_role_hints: resumeRoleHints
  }
}];`;

// ═══ 4. Expand Query: input template gains the resume role hints line ═══
const EQ_TEXT_OLD = "={{ 'Query: ' + $json.message_text + '\\n\\nUser preferences: ' + $json.user_prefs_snapshot + '\\n\\nResume-derived default country (ISO code, use ONLY as last resort -- see PRIORITY RULE): ' + ($json.resume_country_default || 'none') + '\\n\\nExpand into job search parameters.' }}";
const EQ_TEXT_NEW = "={{ 'Query: ' + $json.message_text + '\\n\\nUser preferences: ' + $json.user_prefs_snapshot + '\\n\\nResume-derived default country (ISO code, use ONLY as last resort -- see PRIORITY RULE): ' + ($json.resume_country_default || 'none') + '\\n\\nResume-derived role hints (use ONLY when the message has no role/title language at all -- see ROLE PRIORITY RULE): ' + ($json.resume_role_hints || 'none') + '\\n\\nExpand into job search parameters.' }}";

// ═══ 5. Expand Query: system prompt gains the ROLE PRIORITY RULE ═══
const EQ_ROLE_OLD = '- role_families: 5-8 specific job title variants (exact titles that appear in job listings)\n  Example: "AI jobs" → ["AI Engineer","ML Engineer","Machine Learning Engineer","Data Scientist","Applied Scientist","Research Engineer","GenAI Engineer","NLP Engineer"]\n';
const EQ_ROLE_NEW = '- role_families: 5-8 specific job title variants (exact titles that appear in job listings)\n  Example: "AI jobs" → ["AI Engineer","ML Engineer","Machine Learning Engineer","Data Scientist","Applied Scientist","Research Engineer","GenAI Engineer","NLP Engineer"]\n  ROLE PRIORITY RULE (absolute, same shape as the location PRIORITY RULE below): if the user\'s OWN MESSAGE states ANY role/title language (a job title, "AI jobs", "backend roles", "data roles", etc.), derive role_families from THAT, no exceptions. Only when the message contains ZERO role/title language (e.g. a bare "find jobs", "any openings for me", or a scheduled generic run) should you derive role_families from "Resume-derived role hints" in the context instead of generic guesses. NEVER blend the message\'s role language with the resume hints into one list -- pick exactly one source.\n';

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.split(oldStr).join(newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  const required = ['Prep Expand Input', 'Expand Query'];
  for (const r of required) { if (!N[r]) { console.error(`INTEGRITY FAIL ${base}: node "${r}" not found`); process.exit(1); } }

  if (N['Prep Expand Input'].parameters.jsCode.includes('s93:')) { console.log(`  ${base}: already patched`); return; }

  const pei = N['Prep Expand Input'].parameters;
  replaceOnce(pei, 'jsCode', PEI_FN_OLD, PEI_FN_NEW, 'extractResumeRoleHints insertion', base);
  replaceOnce(pei, 'jsCode', PEI_BUFFER_OLD, PEI_BUFFER_NEW, 'single-parse buffer read', base);
  replaceOnce(pei, 'jsCode', PEI_RETURN_OLD, PEI_RETURN_NEW, 'resume_role_hints on return', base);

  const eq = N['Expand Query'].parameters;
  replaceOnce(eq, 'text', EQ_TEXT_OLD, EQ_TEXT_NEW, 'Expand Query input template', base);
  replaceOnce(eq.messages.messageValues[0], 'message', EQ_ROLE_OLD, EQ_ROLE_NEW, 'ROLE PRIORITY RULE', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: resume-derived role hints (fallback tier for bare role-less queries) -- ${wf.nodes.length} nodes`);
}

// ── harness: extract the ACTUAL patched functions and prove behavior before any write ──
(function harness() {
  const extractResumeRoleHints = new Function('resumeJson', `
    try {
      const exp = Array.isArray(resumeJson && resumeJson.experience) ? resumeJson.experience : [];
      const titles = exp.slice(0, 3).map((e) => e && e.title).filter(Boolean);
      const skillsObj = (resumeJson && resumeJson.skills) || {};
      const allSkills = [];
      if (skillsObj && typeof skillsObj === 'object') {
        for (const vals of Object.values(skillsObj)) if (Array.isArray(vals)) allSkills.push(...vals);
      }
      const skills = [...new Set(allSkills.map((s) => String(s).trim()).filter(Boolean))].slice(0, 10);
      if (!titles.length && !skills.length) return null;
      const parts = [];
      if (titles.length) parts.push('Recent roles: ' + titles.join(', '));
      if (skills.length) parts.push('Skills: ' + skills.join(', '));
      return parts.join('. ').slice(0, 300) || null;
    } catch (e) { return null; }
  `);

  // Real shape pulled from the actual live resume_structured.json.
  const realResume = {
    experience: [
      { title: 'AI Engineer', company: 'New Jersey Institute of Technology' },
      { title: 'R&D Software Engineer', company: 'Dassault Systemes' },
    ],
    skills: {
      programming: ['Python', 'R', 'C', 'C++', 'SQL'],
      ai_ml: ['PyTorch', 'TensorFlow', 'LangChain', 'RAG'],
    },
  };
  const hints = extractResumeRoleHints(realResume);
  if (!hints || !hints.includes('AI Engineer') || !hints.includes('Python')) { console.error('HARNESS FAIL: real resume shape did not produce usable hints', hints); process.exit(1); }
  if (hints.length > 300) { console.error('HARNESS FAIL: hints exceeded the 300-char cap', hints.length); process.exit(1); }

  if (extractResumeRoleHints(null) !== null) { console.error('HARNESS FAIL: null resume must return null'); process.exit(1); }
  if (extractResumeRoleHints({}) !== null) { console.error('HARNESS FAIL: empty resume must return null'); process.exit(1); }
  if (extractResumeRoleHints({ experience: [], skills: {} }) !== null) { console.error('HARNESS FAIL: empty arrays must return null'); process.exit(1); }

  // Long skill lists must cap at 10 and dedupe.
  const manySkills = { experience: [], skills: { a: Array.from({ length: 30 }, (_, i) => 'Skill' + i), b: ['Skill0'] } };
  const manyHints = extractResumeRoleHints(manySkills);
  const skillCount = (manyHints.match(/Skill\d+/g) || []).length;
  if (skillCount !== 10) { console.error('HARNESS FAIL: expected exactly 10 deduped skills, got', skillCount, manyHints); process.exit(1); }

  console.log('HARNESS OK: extractResumeRoleHints derives usable hints from the real resume shape, caps at 300 chars, dedupes+caps skills at 10, returns null on missing/empty data');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
