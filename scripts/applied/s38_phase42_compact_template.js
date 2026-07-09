/**
 * s38_phase42_compact_template.js -- Phase 4.2 remainder: compact-vs-normal
 * resume template, the REAL "different templates" axis (user-chosen density,
 * not seniority-inferred -- see F3's finding that the old 3 seniority-named
 * .tex skeletons had no basis in the original command-center design, which
 * uses exactly this axis instead).
 *
 * New pref: `template: compact` / `template: normal` (default normal, same
 * colon-required convention as sections:/order: to avoid false-positive
 * matches). Threads through the three nodes that share the LaTeX-render
 * helper blocks tracked by export_prompts.js's R3-4 drift-checker (Assemble
 * Resume LaTeX, Assemble Regen, Build Revised LaTeX) -- so all three stay
 * byte-identical on these blocks after this patch, same as before it.
 *
 * Compact mode: bullet cap 3 (vs 4), one fewer education entry (1 vs 2),
 * and tighter macros (\resumeItemCompact / \resumeSubheadingCompact /
 * \resumeItemListEndCompact -- smaller font, reduced vspace) instead of the
 * normal-density ones. Cover letters are unaffected -- Build Cover LaTeX is a
 * separate, independently-written renderer, out of scope per the original
 * plan (this axis is resume-only).
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

const LATEX_NODES = ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX'];

// ── 1. SKELETON: add compact macro variants (shared across all 3 nodes) ──
const SKELETON_OLD_REAL = `\\newcommand{\\resumeItemListStart}{\\begin{itemize}[noitemsep, topsep=0pt, parsep=0pt, partopsep=0pt]}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-4pt}}

\\begin{document}`;
const SKELETON_NEW = `\\newcommand{\\resumeItemListStart}{\\begin{itemize}[noitemsep, topsep=0pt, parsep=0pt, partopsep=0pt]}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-4pt}}
\\newcommand{\\resumeItemCompact}[1]{
  \\item\\footnotesize{
    {#1}
  }
}
\\newcommand{\\resumeSubheadingCompact}[4]{
  \\vspace{-1pt}\\item
    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
      \\textbf{\\footnotesize #1} & \\footnotesize #2 \\\\
      \\textit{\\footnotesize#3} & \\textit{\\footnotesize #4} \\\\
    \\end{tabular*}\\vspace{-7pt}
}
\\newcommand{\\resumeItemListEndCompact}{\\end{itemize}\\vspace{-6pt}}

\\begin{document}`;

// ── 2. bulletRenderV2: cap 3 (compact) vs 4 (normal), macro name switch ──
const BULLET_OLD = `function bulletRenderV2(bullets) {
  return (bullets || []).slice(0, 4).map((b) => {
    const text = truncate110(b.text);
    const kw = b.keyword ? '\\\\textbf{' + escapeLatexTextV2(b.keyword) + ':} ' : '';
    return '    \\\\resumeItem{' + kw + escapeLatexTextV2(text) + '}';
  }).join('\\n');
}`;
const BULLET_NEW = `function bulletRenderV2(bullets, isCompact) {
  const cmd = isCompact ? '\\\\resumeItemCompact' : '\\\\resumeItem';
  return (bullets || []).slice(0, isCompact ? 3 : 4).map((b) => {
    const text = truncate110(b.text);
    const kw = b.keyword ? '\\\\textbf{' + escapeLatexTextV2(b.keyword) + ':} ' : '';
    return '    ' + cmd + '{' + kw + escapeLatexTextV2(text) + '}';
  }).join('\\n');
}`;

// ── 3. renderResume: thread isCompact through subheading/item macro choice,
// itemEnd, education slice ──
const RENDER_OLD = `function renderResume(content, personal) {
  const itemStart = '\\\\resumeItemListStart', itemEnd = '\\\\resumeItemListEnd';
  const slots = {};
  slots.summary = content.summary ? escapeLatexTextV2(content.summary) : '';
  slots.experience = (content.experience || []).map((e) =>
    '\\\\resumeSubheading{' + escapeLatexTextV2(e.title) + '}{' + escapeLatexTextV2((e.startDate || '') + ' -- ' + (e.endDate || '')) + '}{' + escapeLatexTextV2(e.company) + '}{' + escapeLatexTextV2(e.location) + '}\\n' + itemStart + '\\n' + bulletRenderV2(e.bullets) + '\\n' + itemEnd
  ).join('\\n');
  slots.internships = (content.internships || []).map((e) =>
    '\\\\resumeSubheading{' + escapeLatexTextV2(e.title) + '}{' + escapeLatexTextV2((e.startDate || '') + ' -- ' + (e.endDate || '')) + '}{' + escapeLatexTextV2(e.company) + '}{' + escapeLatexTextV2(e.location) + '}\\n' + itemStart + '\\n' + bulletRenderV2(e.bullets) + '\\n' + itemEnd
  ).join('\\n');
  slots.projects = (content.projects || []).map((p) =>
    '\\\\resumeProjectHeading{\\\\textbf{' + escapeLatexTextV2(p.name) + '} $|$ \\\\emph{' + escapeLatexTextV2(p.techStack) + '}}{' + escapeLatexTextV2(p.date) + '}\\n' + itemStart + '\\n' + bulletRenderV2(p.bullets) + '\\n' + itemEnd
  ).join('\\n');
  slots.skills = (content.skills || []).map((cat) => (cat.skills && cat.skills.length) ? '\\\\textbf{' + escapeLatexTextV2(cat.category) + ':} ' + escapeLatexTextV2(cat.skills.join(', ')) + ' \\\\\\\\' : '').filter(Boolean).join('\\n');
  slots.education = (content.education || []).slice(0, 2).map((edu) =>
    '\\\\resumeSubheading{' + escapeLatexTextV2([edu.degree, edu.major].filter(Boolean).join(' -- ')) + '}{' + escapeLatexTextV2(edu.graduationDate) + '}{' + escapeLatexTextV2(edu.institution) + '}{' + escapeLatexTextV2(edu.gpa ? 'GPA: ' + edu.gpa : '') + '}'
  ).join('\\n');
  slots.certifications = (content.certifications || []).filter((c) => c.qualityTier !== 'completion_only').map((c) =>
    '\\\\resumeProjectHeading{\\\\textbf{' + escapeLatexTextV2(c.name) + '} $|$ \\\\emph{' + escapeLatexTextV2(c.issuer) + '}}{' + escapeLatexTextV2(c.date) + '}'
  ).join('\\n');
  slots.achievements = (content.achievements || []).map((a) => '\\\\resumeItem{' + escapeLatexTextV2(firstNonEmpty(a.description, a.title)) + '}').join('\\n');
  slots.activities = (content.activities || []).map((act) =>
    '\\\\resumeProjectHeading{\\\\textbf{' + escapeLatexTextV2(act.name) + '} $|$ \\\\emph{' + escapeLatexTextV2(act.organization) + '}}{' + escapeLatexTextV2(act.date) + '}\\n' + itemStart + '\\n    \\\\resumeItem{' + escapeLatexTextV2(act.description) + '}\\n' + itemEnd
  ).join('\\n');

  const order = (Array.isArray(content.sectionOrder) && content.sectionOrder.length) ? content.sectionOrder : ['experience', 'projects', 'skills', 'education'];
  const contentSections = order.map((section) => {
    const tpl = SECTION_LATEX[section];
    if (!tpl) return '';
    const s = slots[section];
    if (!s) return '';
    return tpl.split(SLOT_MARKER[section]).join(s);
  }).filter(Boolean).join('\\n\\n');

  const headerLatex = buildHeaderFromPersonal(personal);
  return SKELETON.split('%%% SLOT: header').join(headerLatex).split('%%% CONTENT_SECTIONS').join(contentSections);
}`;

const RENDER_NEW = `function renderResume(content, personal, isCompact) {
  const itemStart = '\\\\resumeItemListStart';
  const itemEnd = isCompact ? '\\\\resumeItemListEndCompact' : '\\\\resumeItemListEnd';
  const subheadingCmd = isCompact ? '\\\\resumeSubheadingCompact' : '\\\\resumeSubheading';
  const itemCmd = isCompact ? '\\\\resumeItemCompact' : '\\\\resumeItem';
  const slots = {};
  slots.summary = content.summary ? escapeLatexTextV2(content.summary) : '';
  slots.experience = (content.experience || []).map((e) =>
    subheadingCmd + '{' + escapeLatexTextV2(e.title) + '}{' + escapeLatexTextV2((e.startDate || '') + ' -- ' + (e.endDate || '')) + '}{' + escapeLatexTextV2(e.company) + '}{' + escapeLatexTextV2(e.location) + '}\\n' + itemStart + '\\n' + bulletRenderV2(e.bullets, isCompact) + '\\n' + itemEnd
  ).join('\\n');
  slots.internships = (content.internships || []).map((e) =>
    subheadingCmd + '{' + escapeLatexTextV2(e.title) + '}{' + escapeLatexTextV2((e.startDate || '') + ' -- ' + (e.endDate || '')) + '}{' + escapeLatexTextV2(e.company) + '}{' + escapeLatexTextV2(e.location) + '}\\n' + itemStart + '\\n' + bulletRenderV2(e.bullets, isCompact) + '\\n' + itemEnd
  ).join('\\n');
  slots.projects = (content.projects || []).map((p) =>
    '\\\\resumeProjectHeading{\\\\textbf{' + escapeLatexTextV2(p.name) + '} $|$ \\\\emph{' + escapeLatexTextV2(p.techStack) + '}}{' + escapeLatexTextV2(p.date) + '}\\n' + itemStart + '\\n' + bulletRenderV2(p.bullets, isCompact) + '\\n' + itemEnd
  ).join('\\n');
  slots.skills = (content.skills || []).map((cat) => (cat.skills && cat.skills.length) ? '\\\\textbf{' + escapeLatexTextV2(cat.category) + ':} ' + escapeLatexTextV2(cat.skills.join(', ')) + ' \\\\\\\\' : '').filter(Boolean).join('\\n');
  slots.education = (content.education || []).slice(0, isCompact ? 1 : 2).map((edu) =>
    subheadingCmd + '{' + escapeLatexTextV2([edu.degree, edu.major].filter(Boolean).join(' -- ')) + '}{' + escapeLatexTextV2(edu.graduationDate) + '}{' + escapeLatexTextV2(edu.institution) + '}{' + escapeLatexTextV2(edu.gpa ? 'GPA: ' + edu.gpa : '') + '}'
  ).join('\\n');
  slots.certifications = (content.certifications || []).filter((c) => c.qualityTier !== 'completion_only').map((c) =>
    '\\\\resumeProjectHeading{\\\\textbf{' + escapeLatexTextV2(c.name) + '} $|$ \\\\emph{' + escapeLatexTextV2(c.issuer) + '}}{' + escapeLatexTextV2(c.date) + '}'
  ).join('\\n');
  slots.achievements = (content.achievements || []).map((a) => itemCmd + '{' + escapeLatexTextV2(firstNonEmpty(a.description, a.title)) + '}').join('\\n');
  slots.activities = (content.activities || []).map((act) =>
    '\\\\resumeProjectHeading{\\\\textbf{' + escapeLatexTextV2(act.name) + '} $|$ \\\\emph{' + escapeLatexTextV2(act.organization) + '}}{' + escapeLatexTextV2(act.date) + '}\\n' + itemStart + '\\n    ' + itemCmd + '{' + escapeLatexTextV2(act.description) + '}\\n' + itemEnd
  ).join('\\n');

  const order = (Array.isArray(content.sectionOrder) && content.sectionOrder.length) ? content.sectionOrder : ['experience', 'projects', 'skills', 'education'];
  const contentSections = order.map((section) => {
    const tpl = SECTION_LATEX[section];
    if (!tpl) return '';
    const s = slots[section];
    if (!s) return '';
    return tpl.split(SLOT_MARKER[section]).join(s);
  }).filter(Boolean).join('\\n\\n');

  const headerLatex = buildHeaderFromPersonal(personal);
  return SKELETON.split('%%% SLOT: header').join(headerLatex).split('%%% CONTENT_SECTIONS').join(contentSections);
}`;

// ── 4. Per-node call-site edits (different surrounding code in each node) ──
const CALLSITE_EDITS = {
  'Assemble Resume LaTeX': [
    [
      `  latex = renderResume(content, personal);\n  resumePlainTextOut = pass2.resumePlainText || derivePlainTextFromContent(content) || derivePlainText(pass1);`,
      `  const isCompact = ((($getWorkflowStaticData('global').user_prefs) || {}).template) === 'compact';\n  latex = renderResume(content, personal, isCompact);\n  resumePlainTextOut = pass2.resumePlainText || derivePlainTextFromContent(content) || derivePlainText(pass1);`,
    ],
  ],
  'Assemble Regen': [
    [
      `  latex = renderResume(content, personal);\n  resumePlainTextOut = pass2.resumePlainText || derivePlainTextFromContent(content) || derivePlainText(pass1);`,
      `  const isCompact = ((($getWorkflowStaticData('global').user_prefs) || {}).template) === 'compact';\n  latex = renderResume(content, personal, isCompact);\n  resumePlainTextOut = pass2.resumePlainText || derivePlainTextFromContent(content) || derivePlainText(pass1);`,
    ],
  ],
  'Build Revised LaTeX': [
    [
      `const latex = renderResume(revised, personal);`,
      `const isCompact = ((($getWorkflowStaticData('global').user_prefs) || {}).template) === 'compact';\nconst latex = renderResume(revised, personal, isCompact);`,
    ],
  ],
};

// ── 5. Handle Prefs Update: new `template:` command ──
const PREFS_ANCHOR_OLD = `// ── Timezone ──────────────────────────────────────────────────────────────`;
const PREFS_TEMPLATE_BLOCK = `// ── Resume template density (compact = fewer bullets/education entries, ──
// tighter spacing; normal = default). Colon required, same convention as
// sections:/order:, to avoid false-positive matches on ordinary sentences.
if ((m = msg.match(/\\btemplate\\s*:\\s*(compact|normal)\\b/i))) {
  delta.template = m[1].toLowerCase();
}

`;
const PREFS_NEW_BLOCK = PREFS_TEMPLATE_BLOCK + PREFS_ANCHOR_OLD;

function replaceExact(getField, setField, oldStr, newStr, label, base) {
  const cur = getField();
  if (cur === newStr) return false;
  if (cur.indexOf(oldStr) === -1) { console.error(`INTEGRITY FAIL ${base}: ${label} does not contain expected old value.\nGot (first 200 chars around expected location): ...`); process.exit(1); }
  setField(cur.split(oldStr).join(newStr));
  return true;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of [...LATEX_NODES, 'Handle Prefs Update']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  for (const nodeName of LATEX_NODES) {
    const n = N[nodeName];
    const get = () => n.parameters.jsCode;
    const set = (v) => { n.parameters.jsCode = v; };

    if (replaceExact(get, set, SKELETON_OLD_REAL, SKELETON_NEW, `${nodeName}: SKELETON compact macros`, base)) edits++;
    if (replaceExact(get, set, BULLET_OLD, BULLET_NEW, `${nodeName}: bulletRenderV2`, base)) edits++;
    if (replaceExact(get, set, RENDER_OLD, RENDER_NEW, `${nodeName}: renderResume`, base)) edits++;

    for (const [oldStr, newStr] of CALLSITE_EDITS[nodeName]) {
      if (replaceExact(get, set, oldStr, newStr, `${nodeName}: renderResume call site`, base)) edits++;
    }
  }

  if (replaceExact(
    () => N['Handle Prefs Update'].parameters.jsCode,
    (v) => { N['Handle Prefs Update'].parameters.jsCode = v; },
    PREFS_ANCHOR_OLD, PREFS_NEW_BLOCK, 'Handle Prefs Update: template command', base
  )) edits++;

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: compact/normal template feature applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. bulletRenderV2 real behavior: cap + macro switch for both modes.
  const escapeLatexTextV2 = (v) => String(v == null ? '' : v);
  const truncate110 = (t) => String(t == null ? '' : t).trim();
  const firstNonEmpty = (...vs) => vs.find((v) => String(v == null ? '' : v).trim().length > 0) ?? '';
  const bulletRenderV2 = new Function('escapeLatexTextV2', 'truncate110', 'return ' + BULLET_NEW)(escapeLatexTextV2, truncate110);

  const bullets6 = Array.from({ length: 6 }, (_, i) => ({ text: 'bullet ' + i }));
  const normalOut = bulletRenderV2(bullets6, false);
  const compactOut = bulletRenderV2(bullets6, true);
  if ((normalOut.match(/\\resumeItem\{/g) || []).length !== 4) { console.error('HARNESS FAIL: normal mode should cap at 4 bullets, got', JSON.stringify(normalOut)); process.exit(1); }
  if ((compactOut.match(/\\resumeItemCompact\{/g) || []).length !== 3) { console.error('HARNESS FAIL: compact mode should cap at 3 bullets using resumeItemCompact, got', JSON.stringify(compactOut)); process.exit(1); }
  if (compactOut.includes('\\resumeItem{') && !compactOut.includes('\\resumeItemCompact{')) { console.error('HARNESS FAIL: compact mode should never emit bare \\resumeItem{'); process.exit(1); }

  // 2. renderResume real behavior: education slice, subheading/item macro switch, itemEnd switch.
  const SECTION_LATEX = {
    experience: '\\section{Experience}\n%%% SLOT: experience_entries',
    education: '\\section{Education}\n%%% SLOT: education_entries',
    projects: '\\section{Projects}\n%%% SLOT: project_entries',
    skills: '\\section{Skills}\n%%% SLOT: skills_content',
  };
  const SLOT_MARKER = {
    experience: '%%% SLOT: experience_entries',
    education: '%%% SLOT: education_entries',
    projects: '%%% SLOT: project_entries',
    skills: '%%% SLOT: skills_content',
  };
  const SKELETON = '%%% SLOT: header\n%%% CONTENT_SECTIONS';
  function buildHeaderFromPersonal(p) { return 'HEADER:' + (p && p.name || ''); }
  const renderResume = new Function(
    'escapeLatexTextV2', 'firstNonEmpty', 'bulletRenderV2', 'SECTION_LATEX', 'SLOT_MARKER', 'SKELETON', 'buildHeaderFromPersonal',
    'return ' + RENDER_NEW
  )(escapeLatexTextV2, firstNonEmpty, bulletRenderV2, SECTION_LATEX, SLOT_MARKER, SKELETON, buildHeaderFromPersonal);

  const content = {
    experience: [{ title: 'Eng', company: 'Acme', startDate: '2020', endDate: 'Present', location: 'NYC', bullets: bullets6 }],
    education: [{ degree: 'BS', major: 'CS', institution: 'MIT', graduationDate: '2019' }, { degree: 'MS', major: 'CS', institution: 'CMU', graduationDate: '2021' }, { degree: 'PhD', major: 'CS', institution: 'Stanford', graduationDate: '2025' }],
    projects: [], skills: [], internships: [], certifications: [], achievements: [{ description: 'Won a thing' }], activities: [],
    sectionOrder: ['experience', 'education'],
  };
  const personal = { name: 'Test Person' };

  const normalLatex = renderResume(content, personal, false);
  const compactLatex = renderResume(content, personal, true);

  if ((normalLatex.match(/\\resumeSubheading\{/g) || []).length === 0) { console.error('HARNESS FAIL: normal mode should use \\resumeSubheading'); process.exit(1); }
  if (normalLatex.includes('\\resumeSubheadingCompact')) { console.error('HARNESS FAIL: normal mode should never emit the compact subheading macro'); process.exit(1); }
  if ((compactLatex.match(/\\resumeSubheadingCompact\{/g) || []).length === 0) { console.error('HARNESS FAIL: compact mode should use \\resumeSubheadingCompact'); process.exit(1); }

  // education slice: normal = 2 entries, compact = 1
  const normalEduCount = (normalLatex.match(/\\resumeSubheading(?:Compact)?\{BS/g) || []).length + (normalLatex.match(/\\resumeSubheading(?:Compact)?\{MS/g) || []).length;
  if (normalEduCount !== 2) { console.error('HARNESS FAIL: normal mode should include 2 education entries (BS, MS), got count', normalEduCount, 'in', normalLatex); process.exit(1); }
  const compactHasBS = compactLatex.includes('{BS');
  const compactHasMS = compactLatex.includes('{MS');
  if (!(compactHasBS && !compactHasMS)) { console.error('HARNESS FAIL: compact mode should include only the first education entry (BS), got hasBS=', compactHasBS, 'hasMS=', compactHasMS); process.exit(1); }

  if (!normalLatex.includes('\\resumeItemListEnd') || normalLatex.includes('\\resumeItemListEndCompact')) { console.error('HARNESS FAIL: normal mode itemEnd should be the plain macro, not Compact'); process.exit(1); }
  if (!compactLatex.includes('\\resumeItemListEndCompact')) { console.error('HARNESS FAIL: compact mode should use \\resumeItemListEndCompact'); process.exit(1); }

  // 3. Handle Prefs Update template regex, matches the sections:/order: convention (colon required).
  {
    function extractDelta(msg) {
      const delta = {}; let m;
      const lower = msg.toLowerCase();
      if ((m = lower.match(/\btemplate\s*:\s*(compact|normal)\b/i))) delta.template = m[1].toLowerCase();
      return delta;
    }
    if (extractDelta('template: compact').template !== 'compact') { console.error('HARNESS FAIL: "template: compact" not captured'); process.exit(1); }
    if (extractDelta('template:normal').template !== 'normal') { console.error('HARNESS FAIL: "template:normal" (no space) not captured'); process.exit(1); }
    if (extractDelta('give me a compact template please').template) { console.error('HARNESS FAIL: colon-less sentence should NOT match (matches sections:/order: convention of requiring an explicit colon)'); process.exit(1); }
    if (extractDelta('template: chunky').template) { console.error('HARNESS FAIL: an invalid value should not match'); process.exit(1); }
  }

  // 4. SKELETON: new macros are syntactically sane LaTeX-macro-definition shape (balanced braces,
  // each is a \newcommand -- a real pdflatex compile check happens post-deploy, separately).
  {
    const opens = (SKELETON_NEW.match(/\{/g) || []).length;
    const closes = (SKELETON_NEW.match(/\}/g) || []).length;
    if (opens !== closes) { console.error(`HARNESS FAIL: SKELETON_NEW has unbalanced braces (${opens} open vs ${closes} close)`); process.exit(1); }
    if ((SKELETON_NEW.match(/\\newcommand/g) || []).length !== (SKELETON_OLD_REAL.match(/\\newcommand/g) || []).length + 3) {
      console.error('HARNESS FAIL: expected exactly 3 new \\newcommand definitions added'); process.exit(1);
    }
  }

  console.log('HARNESS OK: bulletRenderV2 (cap 4/3, macro switch, never mixes modes), renderResume (subheading/item macro switch, itemEnd switch, education slice 2/1, real content rendered both ways), Handle Prefs Update template: regex (both spacings captured, colon-less sentence correctly rejected, invalid value rejected), SKELETON new macros balanced-brace sane -- all verified against real logic');
})();

TARGETS.forEach(patch);
console.log('S38 (Phase 4.2: compact/normal resume template) complete.');
