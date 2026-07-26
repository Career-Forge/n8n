/**
 * s141_locale_render.js -- locale-aware resume/cover, step 2 of 5 (s140-s144).
 * Deterministic render localization. Builds on s140's resolveLocale()
 * (ctx.locale/ctx.locale_profile, already threading through every apply).
 *
 * This script:
 *  1. Master-data schema: adds 6 optional, RENDER-ONLY personal fields (dob,
 *     nationality, marital_status, work_authorization_status [ISO-keyed map],
 *     photo [filename], signature [bool -- the AND-gate opt-in for
 *     signature_line]) to Ingest Resume JSON's whitelist, Send Resume
 *     Template, scripts/resume_template.json, docs/MASTER_RESUME_GUIDE.md.
 *     The EXISTING free-text personal.work_authorization stays untouched and
 *     LLM-context-only -- these are a different, new set of fields that
 *     NEVER enter any LLM prompt (linesFromBubbles/linesFromStructured are
 *     not touched by this script).
 *  2. Parse Personal Info: personalFromStructured() copies the 6 new fields
 *     from resume_structured.json into ctx.personal (the runtime object
 *     buildHeaderFromPersonal actually reads) -- without this the schema
 *     extension above would be silently inert.
 *  3. The 3 LaTeX render nodes (Assemble Resume LaTeX, Assemble Regen, Build
 *     Revised LaTeX -- all 11 shared blocks confirmed byte-identical across
 *     all 3 this session): SKELETON gets a {{PAPER}} token; SECTION_LATEX
 *     gets a {{TITLE:<slotKey>}} token per section; a new shared
 *     applyLocaleLatex(latex, profile) function substitutes both (throws on
 *     a surviving token) as the FINAL step of every render path; a new
 *     shared localeGateAllows(fields, key) predicate backs the disclosure
 *     gate added inside buildHeaderFromPersonal (PII line, work-auth line,
 *     signature block -- each renders ONLY if the locale profile allows the
 *     field AND a real value exists, never inferred/never LLM-decided).
 *     Per-node glue (__localeProfile/__jobCountryCode) lives OUTSIDE the
 *     tracked blocks so renderResume/buildHeaderFromPersonal's own
 *     signatures -- both drift anchors -- never change.
 *  4. Cover letter: Load Skeletons' COVER template gets {{PAPER}}+{{CLOSING}}
 *     tokens (replacing the hardcoded "Warm regards,"); Build Cover LaTeX
 *     substitutes both from ctx.locale_profile. Absent-token substitution is
 *     a plain no-op (graceful degrade -- no throw on the cover path, unlike
 *     the resume path, since a persisted/legacy cover_skeleton could lack
 *     the tokens).
 *  5. Build Pass1 Context: header-line budget compensation -- an interim
 *     measure until s142 scales page budgets by locale. Duplicates the
 *     disclosure-gate predicate (localeGateAllows, same function body,
 *     tracked via export_prompts.js's HELPER_SETS) to estimate how many
 *     extra header lines this apply will render, and subtracts that from
 *     the primary pool's lineBudget so a DACH/Gulf apply with real PII still
 *     fits the SAME page count as before rather than silently overflowing.
 *  6. export_prompts.js: registers applyLocaleLatex as a 12th tracked
 *     LATEX_HELPER_BLOCKS entry, and localeGateAllows as a new HELPER_SETS
 *     copy-set (3 LaTeX nodes + Build Pass1 Context).
 *
 * Regression contract: DEFAULT profile (paper=letterpaper, all 6 fields
 * forbidden, no section_titles overrides) must render BYTE-IDENTICAL LaTeX
 * to the pre-patch code. Verified in the harness by running the OLD
 * (pre-patch) buildHeaderFromPersonal/renderResume against the NEW
 * (post-patch) buildHeaderFromPersonal/renderResume+applyLocaleLatex(DEFAULT)
 * for the same fixture, via new Function against the REAL literal source
 * text -- not a reimplementation.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const RESUME_TEMPLATE_FILE = path.join(ROOT, 'scripts', 'resume_template.json');
const GUIDE_FILE = path.join(ROOT, 'docs', 'MASTER_RESUME_GUIDE.md');
const EXPORT_PROMPTS_FILE = path.join(ROOT, 'scripts', 'export_prompts.js');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}
function replaceOnceStr(str, oldStr, newStr, label) {
  const count = str.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  return str.replace(oldStr, () => newStr);
}
function extractBlock(code, start, end, label) {
  const si = code.indexOf(start);
  if (si === -1) { console.error(`INTEGRITY FAIL: block start "${label}" not found`); process.exit(1); }
  const ei = code.indexOf(end, si + start.length);
  if (ei === -1) { console.error(`INTEGRITY FAIL: block end for "${label}" not found`); process.exit(1); }
  return { text: code.slice(si, ei + end.length), si, ei: ei + end.length };
}
function replaceBlock(code, start, end, label, transform) {
  const found = extractBlock(code, start, end, label);
  const newBlock = transform(found.text);
  return code.slice(0, found.si) + newBlock + code.slice(found.ei);
}

// ════════════════════ shared transforms (used identically on all 3 LaTeX nodes) ════════════════════
function transformSkeleton(block) {
  const old = '\\documentclass[letterpaper,11pt]{article}';
  const cnt = block.split(old).length - 1;
  if (cnt !== 1) { console.error('INTEGRITY FAIL: SKELETON documentclass anchor count', cnt); process.exit(1); }
  return block.split(old).join('\\documentclass[{{PAPER}},11pt]{article}');
}

const SECTION_TITLE_ANCHORS = [
  ['summary', '\\section{Summary}'],
  ['experience', '\\section{Experience}'],
  ['internships', '\\section{Internships}'],
  ['projects', '\\section{Projects}'],
  ['skills', '\\section{Technical Skills}'],
  ['education', '\\section{Education}'],
  ['certifications', '\\section{Certifications}'],
  ['achievements', '\\section{Achievements}'],
  ['activities', '\\section{Activities \\& Leadership}'],
];
function transformSectionLatex(block) {
  let out = block;
  for (const [key, old] of SECTION_TITLE_ANCHORS) {
    const cnt = out.split(old).length - 1;
    if (cnt !== 1) { console.error(`INTEGRITY FAIL: SECTION_LATEX title anchor for "${key}" count ${cnt}`); process.exit(1); }
    out = out.split(old).join('\\section{{{TITLE:' + key + '}}}');
  }
  return out;
}

// NOTE: buildHeaderFromPersonal's return statement is a REGULAR (non-raw)
// string literal containing LaTeX backslash commands -- hand-typing an
// anchor for it means getting TWO nested layers of JS string-escaping right
// (this patch script's own source, then the target's own source). That's
// exactly what went wrong on the first attempt. Instead this transform:
// (1) extracts the EXISTING '{\fontsize{9}{9}\selectfont ' prefix verbatim
//     from the block's own contact-line construction (never retyped), and
// (2) locates safe, backslash-free anchors ("  return '", " + contact",
//     the final ";") to splice new code around the untouched original text,
// (3) uses JSON.stringify() to safely re-embed any REUSED/NEW string VALUE
//     as correctly-escaped target source -- so no manual double-escaping
//     is needed anywhere in this function.
function transformBuildHeaderFromPersonal(block) {
  const CONTACT_ANCHOR = "const contact = parts.length ? '";
  const contactStart = block.indexOf(CONTACT_ANCHOR);
  if (contactStart === -1) { console.error('INTEGRITY FAIL: buildHeaderFromPersonal contact-line anchor not found'); process.exit(1); }
  const afterQuote = contactStart + CONTACT_ANCHOR.length;
  const joinIdx = block.indexOf("' + parts.join", afterQuote);
  if (joinIdx === -1) { console.error('INTEGRITY FAIL: buildHeaderFromPersonal contact-line join anchor not found'); process.exit(1); }
  const fontsize9Prefix = block.slice(afterQuote, joinIdx); // real VALUE, e.g. "{\fontsize{9}{9}\selectfont " (1 real backslash each) -- extracted, never retyped

  const returnIdx = block.indexOf("  return '");
  if (returnIdx === -1) { console.error('INTEGRITY FAIL: buildHeaderFromPersonal return anchor not found'); process.exit(1); }
  const head = block.slice(0, returnIdx);
  let tail = block.slice(returnIdx);

  const contactPlusAnchor = " + contact + '";
  const cIdx = tail.indexOf(contactPlusAnchor);
  if (cIdx === -1) { console.error('INTEGRITY FAIL: buildHeaderFromPersonal return "+ contact" anchor not found'); process.exit(1); }
  tail = tail.slice(0, cIdx + ' + contact'.length) + ' + __piiLine + __workAuthLine' + tail.slice(cIdx + ' + contact'.length);

  const lastSemi = tail.lastIndexOf(';');
  if (lastSemi === -1) { console.error('INTEGRITY FAIL: buildHeaderFromPersonal return statement has no terminating ";"'); process.exit(1); }
  tail = tail.slice(0, lastSemi) + ' + __signatureBlock' + tail.slice(lastSemi);

  const LINEBREAK = '\\\\ '; // real VALUE: 2 backslash chars + space (LaTeX "\\" linebreak) -- normal 1-level JS escaping
  const lineOpen = ' ' + LINEBREAK + fontsize9Prefix; // real VALUE: ' \\ {\fontsize{9}{9}\selectfont '
  const sigVspace = '\\vspace{6pt}' + LINEBREAK; // real VALUE: '\vspace{6pt}\\ '

  const gateLogic = [
    '',
    '  // s141: locale disclosure gate. A field renders ONLY IF the resolved',
    '  // locale profile allows it (optional|expected, never forbidden) AND the',
    '  // candidate explicitly provided a real value -- never inferred, never',
    '  // LLM-decided. __localeProfile/__jobCountryCode are glue set OUTSIDE this',
    '  // tracked block (see the Main section) so this function\'s own signature',
    '  // stays a stable drift anchor; localeGateAllows is a new shared block,',
    '  // deliberately duplicated in Build Pass1 Context for budget estimation.',
    '  const __locFields = (__localeProfile && __localeProfile.fields) || {};',
    '  const __piiBits = [];',
    "  if (localeGateAllows(__locFields, 'dob') && p.dob) __piiBits.push('DOB: ' + escapeLatexTextV2(p.dob));",
    "  if (localeGateAllows(__locFields, 'nationality') && p.nationality) __piiBits.push('Nationality: ' + escapeLatexTextV2(p.nationality));",
    "  if (localeGateAllows(__locFields, 'marital_status') && p.marital_status) __piiBits.push('Marital Status: ' + escapeLatexTextV2(p.marital_status));",
    '  const __piiLine = __piiBits.length ? (' + JSON.stringify(lineOpen) + " + __piiBits.join(' ~$|$~ ') + '}') : '';",
    "  let __workAuthLine = '';",
    "  if (localeGateAllows(__locFields, 'work_authorization_status') && __jobCountryCode && p.work_authorization_status && typeof p.work_authorization_status === 'object') {",
    '    const __wa = p.work_authorization_status[__jobCountryCode];',
    '    if (__wa) __workAuthLine = ' + JSON.stringify(lineOpen) + " + escapeLatexTextV2(String(__wa)) + '}';",
    '  }',
    "  let __signatureBlock = '';",
    "  if (localeGateAllows(__locFields, 'signature_line') && p.signature === true) {",
    '    const __sigBits = [name];',
    "    if (p.show_location && p.location) __sigBits.push(escapeLatexTextV2(p.location));",
    '    __signatureBlock = ' + JSON.stringify(sigVspace) + ' + ' + JSON.stringify(fontsize9Prefix) + " + __sigBits.join(', ') + '}';",
    '  }',
    '',
  ].join('\n');

  return head + gateLogic + tail;
}

// Glue + new shared functions inserted right after renderResume's closing
// brace (i.e., OUTSIDE every tracked block) -- identical text in all 3 nodes.
const GLUE_ANCHOR_OLD = "const headerLatex = buildHeaderFromPersonal(personal);\n  return SKELETON.split('%%% SLOT: header').join(headerLatex).split('%%% CONTENT_SECTIONS').join(contentSections);\n}";
const GLUE_ANCHOR_NEW = `const headerLatex = buildHeaderFromPersonal(personal);
  return SKELETON.split('%%% SLOT: header').join(headerLatex).split('%%% CONTENT_SECTIONS').join(contentSections);
}

// s141: locale disclosure-gate predicate -- DELIBERATELY duplicated in Build
// Pass1 Context for header-line budget estimation (Code nodes can't share
// modules); keep both copies in sync (tracked in export_prompts.js's
// HELPER_SETS).
function localeGateAllows(fields, key) {
  return !!fields && (fields[key] === 'optional' || fields[key] === 'expected');
}
// s141: applies {{PAPER}}/{{TITLE:<slotKey>}} tokens as the FINAL step of
// every render path. Throws on a surviving token -- a real bug (missing
// profile data), never silently shipped. New tracked block
// (LATEX_HELPER_BLOCKS in export_prompts.js).
function applyLocaleLatex(latex, profile) {
  const DEFAULT_SECTION_TITLES = { summary: 'Summary', experience: 'Experience', internships: 'Internships', projects: 'Projects', skills: 'Technical Skills', education: 'Education', certifications: 'Certifications', achievements: 'Achievements', activities: 'Activities & Leadership' };
  const paper = (profile && profile.paper) || 'letterpaper';
  let out = latex.split('{{PAPER}}').join(paper);
  const overrides = (profile && profile.section_titles) || {};
  for (const key of Object.keys(DEFAULT_SECTION_TITLES)) {
    const token = '{{TITLE:' + key + '}}';
    const title = overrides[key] || DEFAULT_SECTION_TITLES[key];
    out = out.split(token).join(escapeLatexTextV2(title));
  }
  const survivor = out.match(/\\{\\{(PAPER|TITLE:[a-z_]+)\\}\\}/);
  if (survivor) throw new Error('applyLocaleLatex: unsubstituted locale token survived: ' + survivor[0]);
  return out;
}
// s141: per-node glue for locale profile source -- kept OUTSIDE the tracked
// blocks above so buildHeaderFromPersonal's own signature never changes (a
// drift anchor). Assigned in the Main section below, before any render
// call, so buildHeaderFromPersonal's closure sees the real value.
let __localeProfile = null;
let __jobCountryCode = null;`;

// ════════════════════ Part 1: Assemble Resume LaTeX / Assemble Regen ════════════════════
const ASSEMBLE_CTX_OLD = "const ctx = $('Prepare Apply Context').first().json || {};\nconst personal = ctx.personal || {};";
const ASSEMBLE_CTX_NEW = `const ctx = $('Prepare Apply Context').first().json || {};
const personal = ctx.personal || {};
__localeProfile = ctx.locale_profile || null;
__jobCountryCode = (ctx.locale && ctx.locale.code) || null;`;

const ASSEMBLE_LATEX_OLD = 'resumePlainTextOut = pass2.resumePlainText || derivePlainTextFromContent(content) || derivePlainText(pass1);\n}';
const ASSEMBLE_LATEX_NEW = `resumePlainTextOut = pass2.resumePlainText || derivePlainTextFromContent(content) || derivePlainText(pass1);
}
latex = applyLocaleLatex(latex, __localeProfile);`;

function patchAssembleNode(nodeName, wf) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) { console.error(`INTEGRITY FAIL: ${nodeName} missing`); process.exit(1); }
  if (n.parameters.jsCode.includes('function applyLocaleLatex(')) { console.log(`  ${nodeName}: already patched`); return; }
  let code = n.parameters.jsCode;
  code = replaceBlock(code, 'const SKELETON = String.raw`', '\\end{document}`;', `${nodeName} SKELETON`, transformSkeleton);
  code = replaceBlock(code, 'const SECTION_LATEX = {', '\n};', `${nodeName} SECTION_LATEX`, transformSectionLatex);
  code = replaceBlock(code, 'function buildHeaderFromPersonal(p) {', '\n}', `${nodeName} buildHeaderFromPersonal`, transformBuildHeaderFromPersonal);
  code = replaceOnceStr(code, GLUE_ANCHOR_OLD, GLUE_ANCHOR_NEW, `${nodeName} glue insertion point`);
  code = replaceOnceStr(code, ASSEMBLE_CTX_OLD, ASSEMBLE_CTX_NEW, `${nodeName} ctx/personal (glue assignment)`);
  code = replaceOnceStr(code, ASSEMBLE_LATEX_OLD, ASSEMBLE_LATEX_NEW, `${nodeName} latex= applyLocaleLatex call`);
  n.parameters.jsCode = code;
  console.log(`  ${nodeName}: patched`);
}

// ════════════════════ Part 2: Build Revised LaTeX ════════════════════
const BRL_CTX_OLD = "const personal = (ctx.last_apply && ctx.last_apply.personal) || {};";
const BRL_CTX_NEW = `const personal = (ctx.last_apply && ctx.last_apply.personal) || {};
__localeProfile = (ctx.last_apply && ctx.last_apply.locale_profile) || null;
__jobCountryCode = (ctx.last_apply && ctx.last_apply.locale && ctx.last_apply.locale.code) || null;`;

const BRL_LATEX_OLD = 'const latex = renderResume(revised, personal, isCompact);';
const BRL_LATEX_NEW = 'const latex = applyLocaleLatex(renderResume(revised, personal, isCompact), __localeProfile);';

function patchBuildRevisedLatex(wf) {
  const n = wf.nodes.find((x) => x.name === 'Build Revised LaTeX');
  if (!n) { console.error('INTEGRITY FAIL: Build Revised LaTeX missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('function applyLocaleLatex(')) { console.log('  Build Revised LaTeX: already patched'); return; }
  let code = n.parameters.jsCode;
  code = replaceBlock(code, 'const SKELETON = String.raw`', '\\end{document}`;', 'Build Revised LaTeX SKELETON', transformSkeleton);
  code = replaceBlock(code, 'const SECTION_LATEX = {', '\n};', 'Build Revised LaTeX SECTION_LATEX', transformSectionLatex);
  code = replaceBlock(code, 'function buildHeaderFromPersonal(p) {', '\n}', 'Build Revised LaTeX buildHeaderFromPersonal', transformBuildHeaderFromPersonal);
  code = replaceOnceStr(code, GLUE_ANCHOR_OLD, GLUE_ANCHOR_NEW, 'Build Revised LaTeX glue insertion point');
  code = replaceOnceStr(code, BRL_CTX_OLD, BRL_CTX_NEW, 'Build Revised LaTeX personal (glue assignment)');
  code = replaceOnceStr(code, BRL_LATEX_OLD, BRL_LATEX_NEW, 'Build Revised LaTeX latex= applyLocaleLatex call');
  n.parameters.jsCode = code;
  console.log('  Build Revised LaTeX: patched');
}

// ════════════════════ Part 3: Load Skeletons (cover PAPER/CLOSING tokens) ════════════════════
const LS_DOC_OLD = '\\\\documentclass[letterpaper,11pt]{article}';
const LS_DOC_NEW = '\\\\documentclass[{{PAPER}},11pt]{article}';
const LS_WARM_OLD = 'Warm regards, \\\\\\\\ \\\\vspace{10pt}';
const LS_WARM_NEW = '{{CLOSING}} \\\\\\\\ \\\\vspace{10pt}';

function patchLoadSkeletons(wf) {
  const n = wf.nodes.find((x) => x.name === 'Load Skeletons');
  if (!n) { console.error('INTEGRITY FAIL: Load Skeletons missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('{{PAPER}},11pt')) { console.log('  Load Skeletons: already patched'); return; }
  replaceOnce(n.parameters, 'jsCode', LS_DOC_OLD, LS_DOC_NEW, 'Load Skeletons COVER documentclass');
  replaceOnce(n.parameters, 'jsCode', LS_WARM_OLD, LS_WARM_NEW, 'Load Skeletons COVER closing');
  console.log('  Load Skeletons: patched');
}

// ════════════════════ Part 4: Build Cover LaTeX ════════════════════
const BCL_OLD = "fullLatex = fullLatex.replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate')).replace('{{CONTACT_LINE}}', contactLineV2);";
const BCL_NEW = `const __localeProfile = ctx.locale_profile || null;
const __paper = (__localeProfile && __localeProfile.paper) || 'letterpaper';
const __closing = (__localeProfile && __localeProfile.cover && __localeProfile.cover.closing) || 'Warm regards,';
fullLatex = fullLatex.replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate')).replace('{{CONTACT_LINE}}', contactLineV2).replace('{{PAPER}}', __paper).replace('{{CLOSING}}', __closing);`;

function patchBuildCoverLatex(wf) {
  const n = wf.nodes.find((x) => x.name === 'Build Cover LaTeX');
  if (!n) { console.error('INTEGRITY FAIL: Build Cover LaTeX missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('__closing')) { console.log('  Build Cover LaTeX: already patched'); return; }
  replaceOnce(n.parameters, 'jsCode', BCL_OLD, BCL_NEW, 'Build Cover LaTeX final substitution');
  console.log('  Build Cover LaTeX: patched');
}

// ════════════════════ Part 5: Ingest Resume JSON (master-data whitelist) ════════════════════
const IRJ_OLD = "  work_authorization: clean(personalIn.work_authorization),\n  show_location: !!(locIn && locIn.show_on_resume)\n};";
const IRJ_NEW = `  work_authorization: clean(personalIn.work_authorization),
  show_location: !!(locIn && locIn.show_on_resume),
  // s141: render-only locale fields -- distinct from work_authorization
  // above (which stays free-text/LLM-context-only). These NEVER enter any
  // LLM prompt; buildHeaderFromPersonal renders each ONLY if the resolved
  // locale profile's disclosure gate allows it AND a real value exists here.
  dob: clean(personalIn.dob),
  nationality: clean(personalIn.nationality),
  marital_status: clean(personalIn.marital_status),
  work_authorization_status: normWorkAuthStatus(personalIn.work_authorization_status),
  photo: clean(personalIn.photo),
  signature: personalIn.signature === true
};`;
const IRJ_HELPER_OLD = "function needTemplate(reason) { return [{ json: { chat_id: chatId, _error: reason, _needs_template: true } }]; }";
const IRJ_HELPER_NEW = `function needTemplate(reason) { return [{ json: { chat_id: chatId, _error: reason, _needs_template: true } }]; }
function normWorkAuthStatus(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    const code = asStr(k).toUpperCase().trim();
    const text = clean(val);
    if (/^[A-Z]{2}$/.test(code) && text) out[code] = text;
  }
  return out;
}`;

function patchIngestResumeJson(wf) {
  const n = wf.nodes.find((x) => x.name === 'Ingest Resume JSON');
  if (!n) { console.error('INTEGRITY FAIL: Ingest Resume JSON missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('normWorkAuthStatus')) { console.log('  Ingest Resume JSON: already patched'); return; }
  replaceOnce(n.parameters, 'jsCode', IRJ_HELPER_OLD, IRJ_HELPER_NEW, 'Ingest Resume JSON needTemplate (helper insertion point)');
  replaceOnce(n.parameters, 'jsCode', IRJ_OLD, IRJ_NEW, 'Ingest Resume JSON profile object');
  console.log('  Ingest Resume JSON: patched');
}

// ════════════════════ Part 6: Parse Personal Info (personalFromStructured) ════════════════════
const PFS_OLD = "    location: loc,\n    show_location: false,\n    work_authorization: typeof p.work_authorization === 'string' ? p.work_authorization : JSON.stringify(p.work_authorization || {})\n  };\n}";
const PFS_NEW = `    location: loc,
    show_location: false,
    work_authorization: typeof p.work_authorization === 'string' ? p.work_authorization : JSON.stringify(p.work_authorization || {}),
    // s141: render-only locale fields -- distinct from work_authorization
    // above (which stays free-text/LLM-context-only). These NEVER enter any
    // LLM prompt (linesFromBubbles/linesFromStructured don't read them);
    // buildHeaderFromPersonal renders each ONLY if the resolved locale
    // profile's disclosure gate allows it AND a real value exists here.
    dob: clean(p.dob),
    nationality: clean(p.nationality),
    marital_status: clean(p.marital_status),
    work_authorization_status: (p.work_authorization_status && typeof p.work_authorization_status === 'object' && !Array.isArray(p.work_authorization_status)) ? p.work_authorization_status : {},
    photo: clean(p.photo),
    signature: p.signature === true
  };
}`;

function patchParsePersonalInfo(wf) {
  const n = wf.nodes.find((x) => x.name === 'Parse Personal Info');
  if (!n) { console.error('INTEGRITY FAIL: Parse Personal Info missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('signature: p.signature === true')) { console.log('  Parse Personal Info: already patched'); return; }
  replaceOnce(n.parameters, 'jsCode', PFS_OLD, PFS_NEW, 'Parse Personal Info personalFromStructured return');
  console.log('  Parse Personal Info: patched');
}

// ════════════════════ Part 7: Build Pass1 Context (header-line compensation) ════════════════════
const BP1C_OLD = 'plan.countPlan = JSON.parse(JSON.stringify(COUNT_PLANS[tier] || COUNT_PLANS.mid));';
const BP1C_NEW = `plan.countPlan = JSON.parse(JSON.stringify(COUNT_PLANS[tier] || COUNT_PLANS.mid));
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
}
if (_extraHeaderLines > 0 && plan.sections[plan.primaryPool]) {
  plan.sections[plan.primaryPool].lineBudget = Math.max(4, plan.sections[plan.primaryPool].lineBudget - _extraHeaderLines);
}`;

function patchBuildPass1Context(wf) {
  const n = wf.nodes.find((x) => x.name === 'Build Pass1 Context');
  if (!n) { console.error('INTEGRITY FAIL: Build Pass1 Context missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('_extraHeaderLines')) { console.log('  Build Pass1 Context: already patched'); return; }
  replaceOnce(n.parameters, 'jsCode', BP1C_OLD, BP1C_NEW, 'Build Pass1 Context countPlan (insertion point)');
  console.log('  Build Pass1 Context: patched');
}

// ════════════════════ Part 8: Send Resume Template (Telegram text) ════════════════════
const SRT_OLD = '"work_authorization": ""\n  },';
const SRT_NEW = `"work_authorization": "",\n    \"dob\": \"\",\n    \"nationality\": \"\",\n    \"marital_status\": \"\",\n    \"work_authorization_status\": {},\n    \"photo\": \"\",\n    \"signature\": false\n  },`;
const SRT_NOTE_OLD = 'You are filling a r\u00e9sum\u00e9 JSON template. Copy facts VERBATIM from the r\u00e9sum\u00e9 below \u2014 never invent, embellish, or drop anything. Keep every job, project, and bullet. Use \\"YYYY-MM\\" (or \\"YYYY\\") for dates and \\"Present\\" for current roles. Output ONLY the filled JSON.';
const SRT_NOTE_NEW = SRT_NOTE_OLD + ' The personal.dob/nationality/marital_status/work_authorization_status/photo/signature fields are OPTIONAL and locale-specific (only some countries expect them on a resume) -- leave them blank/empty/false unless the r\u00e9sum\u00e9 below explicitly states them.';

function patchSendResumeTemplate(wf) {
  const n = wf.nodes.find((x) => x.name === 'Send Resume Template');
  if (!n) { console.error('INTEGRITY FAIL: Send Resume Template missing'); process.exit(1); }
  if (n.parameters.text.includes('work_authorization_status')) { console.log('  Send Resume Template: already patched'); return; }
  replaceOnce(n.parameters, 'text', SRT_OLD, SRT_NEW, 'Send Resume Template personal object');
  const noteCount = n.parameters.text.split(SRT_NOTE_OLD).length - 1;
  if (noteCount === 1) {
    replaceOnce(n.parameters, 'text', SRT_NOTE_OLD, SRT_NOTE_NEW, 'Send Resume Template instruction note');
  } else {
    console.log('  Send Resume Template: instruction-note anchor not matched exactly once (' + noteCount + '), skipping cosmetic note (non-fatal)');
  }
  console.log('  Send Resume Template: patched');
}

// ════════════════════ Part 9: scripts/resume_template.json ════════════════════
function patchResumeTemplateFile() {
  const tpl = JSON.parse(fs.readFileSync(RESUME_TEMPLATE_FILE, 'utf8'));
  if ('dob' in tpl.personal) { console.log('  resume_template.json: already patched'); return; }
  tpl.personal.dob = '';
  tpl.personal.nationality = '';
  tpl.personal.marital_status = '';
  tpl.personal.work_authorization_status = {};
  tpl.personal.photo = '';
  tpl.personal.signature = false;
  fs.writeFileSync(RESUME_TEMPLATE_FILE, JSON.stringify(tpl, null, 2) + '\n');
  console.log('  resume_template.json: patched');
}

// ════════════════════ Part 10: docs/MASTER_RESUME_GUIDE.md ════════════════════
const GUIDE_TEMPLATE_OLD = `    "location": { "city": "", "region": "", "country": "", "show_on_resume": false },
    "work_authorization": ""
  },`;
const GUIDE_TEMPLATE_NEW = `    "location": { "city": "", "region": "", "country": "", "show_on_resume": false },
    "work_authorization": "",
    "dob": "", "nationality": "", "marital_status": "",
    "work_authorization_status": {}, "photo": "", "signature": false
  },`;
const GUIDE_SECTION_ANCHOR = '## What If Fields Are Missing?';
const GUIDE_NEW_SECTION = `## Locale-Specific Fields (Optional)

Six \`personal\` fields (\`dob\`, \`nationality\`, \`marital_status\`, \`work_authorization_status\`, \`photo\`, \`signature\`) exist purely for locale correctness -- most countries (US, India, UK, Canada...) forbid all of them on a resume, and they're never invented or inferred. A field only ever renders if BOTH are true: the job's resolved locale allows it (e.g. DACH expects a DOB/nationality/signature; Gulf countries expect a work-authorization line) AND you've explicitly provided a real value here. Leave them blank/empty/false unless you know you need them.

\`work_authorization_status\` is an ISO-country-keyed map, e.g. \`{"AE": "Employment Visa (Transferable)"}\` -- it renders only when the job's country matches a key in the map exactly, and is a different field from the free-text \`work_authorization\` above (which stays internal context, never printed on the document itself).

None of these six ever reach any LLM prompt -- they're read directly at render time, nowhere else.

${GUIDE_SECTION_ANCHOR}`;

function patchMasterResumeGuide() {
  let doc = fs.readFileSync(GUIDE_FILE, 'utf8');
  if (doc.includes('Locale-Specific Fields (Optional)')) { console.log('  MASTER_RESUME_GUIDE.md: already patched'); return; }
  doc = replaceOnceStr(doc, GUIDE_TEMPLATE_OLD, GUIDE_TEMPLATE_NEW, 'MASTER_RESUME_GUIDE.md template block');
  doc = replaceOnceStr(doc, GUIDE_SECTION_ANCHOR, GUIDE_NEW_SECTION, 'MASTER_RESUME_GUIDE.md section-insertion anchor');
  fs.writeFileSync(GUIDE_FILE, doc);
  console.log('  MASTER_RESUME_GUIDE.md: patched');
}

// ════════════════════ Part 11: export_prompts.js drift-checker registration ════════════════════
const EP_LATEX_BLOCKS_OLD = "  { block: 'renderResume',            start: 'function renderResume(content, personal, isCompact) {', end: '\\n}\\n' },";
const EP_LATEX_BLOCKS_NEW = EP_LATEX_BLOCKS_OLD + "\n  { block: 'applyLocaleLatex',        start: 'function applyLocaleLatex(latex, profile) {', end: '\\n}' },";
const EP_HELPER_SETS_OLD = "      ['normalizePass2', ['Parse Pass2', 'Parse Pass2 Regen']],\n    ];";
const EP_HELPER_SETS_NEW = "      ['normalizePass2', ['Parse Pass2', 'Parse Pass2 Regen']],\n      ['localeGateAllows', ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX', 'Build Pass1 Context']],\n    ];";

function patchExportPrompts() {
  let src = fs.readFileSync(EXPORT_PROMPTS_FILE, 'utf8');
  if (src.includes("block: 'applyLocaleLatex'")) { console.log('  export_prompts.js: already patched'); return; }
  src = replaceOnceStr(src, EP_LATEX_BLOCKS_OLD, EP_LATEX_BLOCKS_NEW, 'export_prompts.js LATEX_HELPER_BLOCKS renderResume entry');
  src = replaceOnceStr(src, EP_HELPER_SETS_OLD, EP_HELPER_SETS_NEW, 'export_prompts.js HELPER_SETS normalizePass2 entry');
  fs.writeFileSync(EXPORT_PROMPTS_FILE, src);
  console.log('  export_prompts.js: patched');
}

// ════════════════════════════════ HARNESS ════════════════════════════════
(function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const N = {};
  for (const n of wf.nodes) N[n.name] = n;

  // ---- Pre-patch anchor integrity (dry check, no mutation) ----
  const dryPatchProbe = (nodeName, marker) => !N[nodeName].parameters.jsCode.includes(marker);
  const needsAssemble = dryPatchProbe('Assemble Resume LaTeX', 'function applyLocaleLatex(');
  if (needsAssemble) {
    for (const nodeName of ['Assemble Resume LaTeX', 'Assemble Regen']) {
      const code = N[nodeName].parameters.jsCode;
      check(`${nodeName}: SKELETON documentclass anchor unique`, code.split('\\documentclass[letterpaper,11pt]{article}').length - 1 === 1);
      for (const [key, old] of SECTION_TITLE_ANCHORS) check(`${nodeName}: SECTION_LATEX "${key}" anchor unique`, code.split(old).length - 1 === 1);
      // buildHeaderFromPersonal's own internal anchors ("const contact = ...",
      // "  return '", " + contact + '", trailing ";") are validated by
      // transformBuildHeaderFromPersonal itself (process.exit(1) on any
      // mismatch) when the regression harness below calls it -- no
      // redundant check needed here.
      check(`${nodeName}: glue insertion anchor unique`, code.split(GLUE_ANCHOR_OLD).length - 1 === 1);
      check(`${nodeName}: ctx/personal anchor unique`, code.split(ASSEMBLE_CTX_OLD).length - 1 === 1);
      check(`${nodeName}: latex= anchor unique`, code.split(ASSEMBLE_LATEX_OLD).length - 1 === 1);
    }
    const brlCode = N['Build Revised LaTeX'].parameters.jsCode;
    check('Build Revised LaTeX: SKELETON documentclass anchor unique', brlCode.split('\\documentclass[letterpaper,11pt]{article}').length - 1 === 1);
    for (const [key, old] of SECTION_TITLE_ANCHORS) check(`Build Revised LaTeX: SECTION_LATEX "${key}" anchor unique`, brlCode.split(old).length - 1 === 1);
    // (buildHeaderFromPersonal's internal anchors are validated by the
    // transform function itself, see the note above.)
    check('Build Revised LaTeX: glue insertion anchor unique', brlCode.split(GLUE_ANCHOR_OLD).length - 1 === 1);
    check('Build Revised LaTeX: personal anchor unique', brlCode.split(BRL_CTX_OLD).length - 1 === 1);
    check('Build Revised LaTeX: latex= anchor unique', brlCode.split(BRL_LATEX_OLD).length - 1 === 1);
  } else {
    console.log('  (Assemble/Build Revised LaTeX already patched -- skipping pre-patch anchor checks)');
  }
  if (dryPatchProbe('Load Skeletons', '{{PAPER}},11pt')) {
    const lsCode = N['Load Skeletons'].parameters.jsCode;
    check('Load Skeletons: documentclass anchor unique', lsCode.split(LS_DOC_OLD).length - 1 === 1);
    check('Load Skeletons: Warm regards anchor unique', lsCode.split(LS_WARM_OLD).length - 1 === 1);
  }
  if (!N['Build Cover LaTeX'].parameters.jsCode.includes('__closing')) {
    check('Build Cover LaTeX: final substitution anchor unique', N['Build Cover LaTeX'].parameters.jsCode.split(BCL_OLD).length - 1 === 1);
  }
  if (!N['Ingest Resume JSON'].parameters.jsCode.includes('normWorkAuthStatus')) {
    check('Ingest Resume JSON: profile anchor unique', N['Ingest Resume JSON'].parameters.jsCode.split(IRJ_OLD).length - 1 === 1);
    check('Ingest Resume JSON: helper insertion anchor unique', N['Ingest Resume JSON'].parameters.jsCode.split(IRJ_HELPER_OLD).length - 1 === 1);
  }
  if (!N['Parse Personal Info'].parameters.jsCode.includes('signature: p.signature === true')) {
    check('Parse Personal Info: personalFromStructured anchor unique', N['Parse Personal Info'].parameters.jsCode.split(PFS_OLD).length - 1 === 1);
  }
  if (!N['Build Pass1 Context'].parameters.jsCode.includes('_extraHeaderLines')) {
    check('Build Pass1 Context: countPlan anchor unique', N['Build Pass1 Context'].parameters.jsCode.split(BP1C_OLD).length - 1 === 1);
  }
  if (!N['Send Resume Template'].parameters.text.includes('work_authorization_status')) {
    check('Send Resume Template: personal-object anchor unique', N['Send Resume Template'].parameters.text.split(SRT_OLD).length - 1 === 1);
  }

  if (failures > 0) { console.error(`\n${failures} PRE-PATCH ANCHOR FAILURE(S) -- fix before proceeding`); process.exit(1); }

  // ---- Regression + behavior tests, executed against the REAL literal
  // source text (old vs new), not a reimplementation ----

  // Build the OLD (pre-patch) renderResume+buildHeaderFromPersonal+SKELETON+
  // SECTION_LATEX+SLOT_MARKER+helpers as one runnable unit.
  const rawCode = N['Assemble Resume LaTeX'].parameters.jsCode;
  if (needsAssemble) {
    function extract(code, start, end) {
      const si = code.indexOf(start);
      const ei = code.indexOf(end, si + start.length);
      return code.slice(si, ei + end.length);
    }
    const oldSkeleton = extract(rawCode, 'const SKELETON = String.raw`', '\\end{document}`;');
    const oldSectionLatex = extract(rawCode, 'const SECTION_LATEX = {', '\n};');
    const oldSlotMarker = extract(rawCode, 'const SLOT_MARKER = {', '\n};');
    const oldFirstNonEmpty = extract(rawCode, 'function firstNonEmpty(...values) {', '\n}');
    const oldNormalizeUrl = extract(rawCode, 'function normalizeUrl(u) {', '\n}');
    const oldVisibleUrlV2 = extract(rawCode, 'function visibleUrlTextV2(u) {', '\n}');
    const oldBuildHeader = extract(rawCode, 'function buildHeaderFromPersonal(p) {', '\n}');
    const oldEscapeV2 = extract(rawCode, 'function escapeLatexTextV2(value) {', '\n  return s;\n}');
    const oldTruncateBullet = extract(rawCode, 'function truncateBullet(t, reserve) {', '\n}');
    const oldTruncateSummary = extract(rawCode, 'function truncateSummary(t) {', '\n}');
    const oldBulletRenderV2 = extract(rawCode, 'function bulletRenderV2(bullets, isCompact) {', '\n}');
    const oldCapTechStack = extract(rawCode, 'function capTechStackV2(name, stack) {', '\n}');
    const oldRenderResume = extract(rawCode, 'function renderResume(content, personal, isCompact) {', '\n}\n');
    const oldUnitSrc = [oldSkeleton, oldSectionLatex, oldSlotMarker, oldFirstNonEmpty, oldNormalizeUrl, oldVisibleUrlV2, oldBuildHeader, oldEscapeV2, oldTruncateBullet, oldTruncateSummary, oldBulletRenderV2, oldCapTechStack, oldRenderResume].join('\n');
    const oldRun = new Function('content', 'personal', 'isCompact', oldUnitSrc + '\nreturn renderResume(content, personal, isCompact);');

    // Now build the NEW (post-patch) unit by applying the same in-memory
    // transforms this script will write, run with __localeProfile=DEFAULT
    // (all fields forbidden) and __jobCountryCode=null -- must byte-match.
    const newSkeleton = transformSkeleton(oldSkeleton);
    const newSectionLatex = transformSectionLatex(oldSectionLatex);
    const newBuildHeader = transformBuildHeaderFromPersonal(oldBuildHeader);
    const newHelpersSrc = `
function localeGateAllows(fields, key) { return !!fields && (fields[key] === 'optional' || fields[key] === 'expected'); }
function applyLocaleLatex(latex, profile) {
  const DEFAULT_SECTION_TITLES = { summary: 'Summary', experience: 'Experience', internships: 'Internships', projects: 'Projects', skills: 'Technical Skills', education: 'Education', certifications: 'Certifications', achievements: 'Achievements', activities: 'Activities & Leadership' };
  const paper = (profile && profile.paper) || 'letterpaper';
  let out = latex.split('{{PAPER}}').join(paper);
  const overrides = (profile && profile.section_titles) || {};
  for (const key of Object.keys(DEFAULT_SECTION_TITLES)) {
    const token = '{{TITLE:' + key + '}}';
    const title = overrides[key] || DEFAULT_SECTION_TITLES[key];
    out = out.split(token).join(escapeLatexTextV2(title));
  }
  const survivor = out.match(/\\{\\{(PAPER|TITLE:[a-z_]+)\\}\\}/);
  if (survivor) throw new Error('applyLocaleLatex: unsubstituted locale token survived: ' + survivor[0]);
  return out;
}`;
    const newUnitSrc = [newSkeleton, newSectionLatex, oldSlotMarker, oldFirstNonEmpty, oldNormalizeUrl, oldVisibleUrlV2, newBuildHeader, oldEscapeV2, oldTruncateBullet, oldTruncateSummary, oldBulletRenderV2, oldCapTechStack, oldRenderResume, newHelpersSrc].join('\n');
    const DEFAULT_PROFILE = { paper: 'letterpaper', fields: { photo: 'forbidden', dob: 'forbidden', nationality: 'forbidden', marital_status: 'forbidden', signature_line: 'forbidden', work_authorization_status: 'forbidden' }, header_line_costs: { pii_line: 1, work_auth_line: 1, photo: 5, signature_block: 3 }, section_titles: {} };
    const DACH_PROFILE = { paper: 'a4paper', fields: { photo: 'expected', dob: 'expected', nationality: 'expected', marital_status: 'expected', signature_line: 'expected', work_authorization_status: 'forbidden' }, header_line_costs: { pii_line: 1, work_auth_line: 1, photo: 5, signature_block: 3 }, section_titles: {} };
    const GULF_PROFILE = { paper: 'a4paper', fields: { photo: 'optional', dob: 'optional', nationality: 'expected', marital_status: 'optional', signature_line: 'forbidden', work_authorization_status: 'expected' }, header_line_costs: { pii_line: 1, work_auth_line: 1, photo: 5, signature_block: 3 }, section_titles: {} };
    const UK_PROFILE = { paper: 'a4paper', fields: DEFAULT_PROFILE.fields, header_line_costs: DEFAULT_PROFILE.header_line_costs, section_titles: { summary: 'Personal Statement' } };

    function newRun(content, personal, isCompact, localeProfile, jobCountryCode) {
      const fn = new Function('content', 'personal', 'isCompact', '__localeProfile', '__jobCountryCode',
        newUnitSrc + '\nconst latex = renderResume(content, personal, isCompact);\nreturn applyLocaleLatex(latex, __localeProfile);');
      return fn(content, personal, isCompact, localeProfile || null, jobCountryCode || null);
    }

    // Real-shaped fixture covering header + all rendered sections + a
    // stacked 2-position company run (renderEntriesV3's grouping path).
    const fixtureContent = {
      summary: 'Multimodal AI engineer shipping production LLM pipelines end to end.',
      sectionOrder: ['summary', 'experience', 'projects', 'skills', 'education', 'achievements'],
      experience: [
        { title: 'Senior AI Engineer', company: 'Acme Corp', startDate: '2024-01', endDate: 'Present', bullets: ['Shipped a 28-agent production platform serving 10k users.'] },
        { title: 'AI Engineer', company: 'Acme Corp', startDate: '2022-06', endDate: '2023-12', bullets: ['Built the initial RAG pipeline with 30% relevance lift.'] },
        { title: 'Data Scientist', company: 'Globex', startDate: '2020-01', endDate: '2022-05', bullets: ['Trained a fMRI classifier reaching 94% accuracy.'] },
      ],
      projects: [{ name: 'Quorum', techStack: 'Python, ElevenLabs', date: '2026', bullets: ['Won an n8n sponsor prize at a hackathon.'] }],
      skills: [{ category: 'Languages', skills: ['Python', 'TypeScript'] }],
      education: [{ degree: 'MS', major: 'Data Science', institution: 'NJIT', graduationDate: '2022', gpa: '' }],
      achievements: [{ description: '1st place, Pulse NYC Hackathon' }],
      internships: [], certifications: [], activities: [],
    };
    const fixturePersonal = { name: 'Alex Candidate', phone_display: '+1 555 123 4567', email: 'alex@example.com', linkedin: 'linkedin.com/in/alex', github: 'github.com/alex', show_location: false, location: 'Remote' };

    const oldLatex = oldRun(fixtureContent, fixturePersonal, false);
    const newLatexDefault = newRun(fixtureContent, fixturePersonal, false, DEFAULT_PROFILE, null);
    check('DEFAULT-profile regression: new render is BYTE-IDENTICAL to pre-patch render', oldLatex === newLatexDefault);
    check('DEFAULT-profile regression: null profile (legacy pre-s140 apply) also byte-identical', oldRun(fixtureContent, fixturePersonal, false) === newRun(fixtureContent, fixturePersonal, false, null, null));

    // UK_IE section-title override.
    const ukLatex = newRun(fixtureContent, fixturePersonal, false, UK_PROFILE, 'GB');
    check('UK profile: "Personal Statement" title renders in place of "Summary"', ukLatex.includes('\\section{Personal Statement}') && !ukLatex.includes('\\section{Summary}'));
    check('UK profile: a4paper substituted', ukLatex.includes('\\documentclass[a4paper,11pt]{article}'));

    // DACH: PII line + signature block render when real values + opt-in are present.
    const dachPersonal = { ...fixturePersonal, dob: '1994-03-12', nationality: 'German', marital_status: 'Single', signature: true };
    const dachLatex = newRun(fixtureContent, dachPersonal, false, DACH_PROFILE, 'DE');
    check('DACH profile: PII line renders (DOB/Nationality/Marital Status)', dachLatex.includes('DOB: 1994-03-12') && dachLatex.includes('Nationality: German') && dachLatex.includes('Marital Status: Single'));
    check('DACH profile: signature block renders (signature:true opt-in)', dachLatex.includes('Alex Candidate') && (dachLatex.match(/Alex Candidate/g) || []).length >= 2);
    check('DACH profile: a4paper substituted', dachLatex.includes('\\documentclass[a4paper,11pt]{article}'));
    // Control: same DACH profile, but signature:false (no opt-in) -> no signature block, PII still renders.
    const dachNoSigLatex = newRun(fixtureContent, { ...dachPersonal, signature: false }, false, DACH_PROFILE, 'DE');
    check('DACH profile control: signature:false suppresses the signature block', (dachNoSigLatex.match(/Alex Candidate/g) || []).length === 1);
    // Control: DEFAULT profile with the SAME PII data present -> nothing renders (gate blocks it).
    const defaultWithPiiLatex = newRun(fixtureContent, dachPersonal, false, DEFAULT_PROFILE, null);
    check('DEFAULT profile control: real DOB/nationality/signature data present but gate forbids -> nothing renders', !defaultWithPiiLatex.includes('DOB:') && !defaultWithPiiLatex.includes('Nationality:') && (defaultWithPiiLatex.match(/Alex Candidate/g) || []).length === 1);

    // Gulf: work-auth line renders ONLY on exact job-country match.
    const gulfPersonal = { ...fixturePersonal, work_authorization_status: { AE: 'Employment Visa (Transferable)', SA: 'Iqama (Transferable)' } };
    const gulfLatexAE = newRun(fixtureContent, gulfPersonal, false, GULF_PROFILE, 'AE');
    check('Gulf profile: work-auth line renders the AE entry on an AE job', gulfLatexAE.includes('Employment Visa (Transferable)'));
    const gulfLatexUS = newRun(fixtureContent, gulfPersonal, false, GULF_PROFILE, 'US');
    check('Gulf profile: work-auth line does NOT render on a non-matching job country', !gulfLatexUS.includes('Employment Visa') && !gulfLatexUS.includes('Iqama'));
    // Control: candidate has NO work_authorization_status data at all -> AND-gate blocks even though profile allows it.
    const gulfNoDataLatex = newRun(fixtureContent, fixturePersonal, false, GULF_PROFILE, 'AE');
    check('Gulf profile control: profile allows work-auth but candidate provided none -> nothing renders', !gulfNoDataLatex.includes('Visa') && !gulfNoDataLatex.includes('Iqama'));

    // Diacritics: a Zurich/Sao Paulo-style value in a gated PII field must not
    // crash -- same NFKD transliteration escapeLatexTextV2 already applies
    // everywhere else (v7.2 precedent), not a new/different path.
    const diacriticsPersonal = { ...dachPersonal, nationality: 'Zürich, Switzerland' };
    let diacriticsOk = true, diacriticsLatex = '';
    try { diacriticsLatex = newRun(fixtureContent, diacriticsPersonal, false, DACH_PROFILE, 'DE'); } catch (e) { diacriticsOk = false; }
    check('Diacritics: Zürich-style value renders without throwing', diacriticsOk);
    check('Diacritics: transliterated consistently with escapeLatexTextV2 elsewhere (Zurich, no combining marks survive)', diacriticsLatex.includes('Nationality: Zurich, Switzerland'));

    // Surviving-token guard: a profile object missing 'paper' entirely still
    // resolves via the 'letterpaper' fallback -- never throws for a
    // legitimately-partial profile.
    let partialProfileOk = true;
    try { newRun(fixtureContent, fixturePersonal, false, { fields: {} }, null); } catch (e) { partialProfileOk = false; }
    check('applyLocaleLatex: a profile with no .paper field falls back to letterpaper, does not throw', partialProfileOk);
  } else {
    console.log('  (already patched -- skipping the old-vs-new regression harness; safe to re-run after a real revert if ever needed)');
  }

  // ---- Build Pass1 Context header-line compensation, tested against the
  // real (to-be-patched) countPlan insertion text ----
  {
    const bp1cCode = N['Build Pass1 Context'].parameters.jsCode;
    if (!bp1cCode.includes('_extraHeaderLines')) {
      // Strip the untouched original countPlan line (references COUNT_PLANS/
      // tier, not in scope here) -- test ONLY the new compensation logic
      // this script actually adds, via the real literal source text.
      const compensationOnly = BP1C_NEW.slice(BP1C_OLD.length);
      function budgetFor(locale_profile, personal, locale, startBudget) {
        const c = { locale_profile, personal, locale };
        const plan = { sections: { experience: { lineBudget: startBudget != null ? startBudget : 22 } }, primaryPool: 'experience' };
        const fn = new Function('plan', 'c', compensationOnly + '\nreturn plan.sections.experience.lineBudget;');
        return fn(plan, c);
      }
      check('header-line compensation: DEFAULT profile (no PII) -> budget unchanged', budgetFor(DEFAULT_PROFILE_FOR_BP1C(), {}, null) === 22);
      check('header-line compensation: DACH + real PII + signature -> budget reduced by pii(1)+signature(3)=4', budgetFor(DACH_PROFILE_FOR_BP1C(), { dob: '1994-01-01', signature: true }, { code: 'DE' }) === 18);
      check('header-line compensation: Gulf + real work-auth match -> budget reduced by work_auth_line(1)', budgetFor(GULF_PROFILE_FOR_BP1C(), { work_authorization_status: { AE: 'x' } }, { code: 'AE' }) === 21);
      check('header-line compensation: floor never goes below 4', budgetFor(DACH_PROFILE_FOR_BP1C(), { dob: '1', nationality: '1', marital_status: '1', signature: true }, { code: 'DE' }, 5) === 4);
    } else {
      console.log('  (Build Pass1 Context already patched -- skipping compensation harness)');
    }
  }
  function DEFAULT_PROFILE_FOR_BP1C() { return { fields: { dob: 'forbidden', nationality: 'forbidden', marital_status: 'forbidden', signature_line: 'forbidden', work_authorization_status: 'forbidden' }, header_line_costs: { pii_line: 1, work_auth_line: 1, photo: 5, signature_block: 3 } }; }
  function DACH_PROFILE_FOR_BP1C() { return { fields: { dob: 'expected', nationality: 'expected', marital_status: 'expected', signature_line: 'expected', work_authorization_status: 'forbidden' }, header_line_costs: { pii_line: 1, work_auth_line: 1, photo: 5, signature_block: 3 } }; }
  function GULF_PROFILE_FOR_BP1C() { return { fields: { dob: 'optional', nationality: 'expected', marital_status: 'optional', signature_line: 'forbidden', work_authorization_status: 'expected' }, header_line_costs: { pii_line: 1, work_auth_line: 1, photo: 5, signature_block: 3 } }; }

  // ---- Cover-letter token substitution + graceful no-op ----
  {
    function runCoverSubst(coverSkeleton, localeProfile) {
      const ctx = { locale_profile: localeProfile, personal: {}, chat_id: 1, job_title: 'X', company: 'Y' };
      const __localeProfile = ctx.locale_profile || null;
      const __paper = (__localeProfile && __localeProfile.paper) || 'letterpaper';
      const __closing = (__localeProfile && __localeProfile.cover && __localeProfile.cover.closing) || 'Warm regards,';
      return coverSkeleton.replace('{{NAME}}', 'Alex').replace('{{CONTACT_LINE}}', 'contact').replace('{{PAPER}}', __paper).replace('{{CLOSING}}', __closing);
    }
    const freshSkeleton = '\\documentclass[{{PAPER}},11pt]{article}\n...{{CLOSING}}...{{NAME}}...{{CONTACT_LINE}}';
    const staleSkeleton = '\\documentclass[letterpaper,11pt]{article}\n...Warm regards,...{{NAME}}...{{CONTACT_LINE}}';
    check('cover: fresh skeleton substitutes PAPER+CLOSING for a DACH profile', runCoverSubst(freshSkeleton, { paper: 'a4paper', cover: { closing: 'Kind regards,' } }).includes('a4paper') && runCoverSubst(freshSkeleton, { paper: 'a4paper', cover: { closing: 'Kind regards,' } }).includes('Kind regards,'));
    check('cover: fresh skeleton defaults cleanly with no profile at all', runCoverSubst(freshSkeleton, null) === '\\documentclass[letterpaper,11pt]{article}\n...Warm regards,...Alex...contact');
    let staleOk = true, staleResult = '';
    try { staleResult = runCoverSubst(staleSkeleton, { paper: 'a4paper', cover: { closing: 'Kind regards,' } }); } catch (e) { staleOk = false; }
    check('cover: a STALE persisted skeleton (no tokens) never throws -- graceful no-op', staleOk && staleResult.includes('letterpaper') && staleResult.includes('Warm regards,'));
  }

  // ---- Ingest Resume JSON's normWorkAuthStatus, tested standalone ----
  {
    function normWorkAuthStatus(v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        const code = String(k || '').toUpperCase().trim();
        const text = String(val == null ? '' : val).trim();
        if (/^[A-Z]{2}$/.test(code) && text) out[code] = text;
      }
      return out;
    }
    check('normWorkAuthStatus: valid ISO-keyed map passes through', JSON.stringify(normWorkAuthStatus({ AE: 'Employment Visa' })) === JSON.stringify({ AE: 'Employment Visa' }));
    check('normWorkAuthStatus: lowercase key normalized to uppercase', JSON.stringify(normWorkAuthStatus({ ae: 'x' })) === JSON.stringify({ AE: 'x' }));
    check('normWorkAuthStatus: a 3-letter key is rejected (not real ISO-2)', JSON.stringify(normWorkAuthStatus({ USA: 'x' })) === '{}');
    check('normWorkAuthStatus: an array input returns {}', JSON.stringify(normWorkAuthStatus(['x'])) === '{}');
    check('normWorkAuthStatus: null/undefined returns {}', JSON.stringify(normWorkAuthStatus(null)) === '{}' && JSON.stringify(normWorkAuthStatus(undefined)) === '{}');
  }

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: DEFAULT-profile regression byte-identical to pre-patch (incl. the null/legacy-profile case); UK section-title override + A4 paper; DACH PII line + signature-opt-in (with both positive and negative controls); Gulf work-auth exact-country-match gate (with both positive and negative controls); diacritics transliterate without crashing; header-line budget compensation math correct incl. the floor; cover-letter token substitution works and gracefully no-ops on a stale/tokenless skeleton; normWorkAuthStatus validated.');

  // ── Writes ──
  patchAssembleNode('Assemble Resume LaTeX', wf);
  patchAssembleNode('Assemble Regen', wf);
  patchBuildRevisedLatex(wf);
  patchLoadSkeletons(wf);
  patchBuildCoverLatex(wf);
  patchIngestResumeJson(wf);
  patchParsePersonalInfo(wf);
  patchBuildPass1Context(wf);
  patchSendResumeTemplate(wf);
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));

  patchResumeTemplateFile();
  patchMasterResumeGuide();
  patchExportPrompts();

  // Twin-identity re-check post-write (Assemble Resume LaTeX === Assemble Regen).
  const wf2 = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const arCode = wf2.nodes.find((n) => n.name === 'Assemble Resume LaTeX').parameters.jsCode;
  const agCode = wf2.nodes.find((n) => n.name === 'Assemble Regen').parameters.jsCode;
  if (arCode !== agCode) { console.error('INTEGRITY FAIL: Assemble Resume LaTeX and Assemble Regen diverged post-patch!'); process.exit(1); }
  console.log('  post-write check: Assemble Resume LaTeX === Assemble Regen (still byte-identical twins)');

  console.log('S141 (deterministic render localization) script complete.');
})();
