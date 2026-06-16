// ═══════════════════════════════════════════════════════════════
// Assemble Resume LaTeX — S6b-1 (node jsCode source of truth)
// ═══════════════════════════════════════════════════════════════
// Deterministic LaTeX assembly. Adopts the command-center slot mechanism
// (SECTION_LATEX + buildFallbackSlots = the reliability net: renders a real
// resume from Pass-1 VERBATIM data even if Pass-2 produced nothing) onto the
// bot's proven Lato/ATS-parsable skeleton + macros.
//
// Ported from careerforge-command-center/supabase/functions/document-ai/index.ts:
//   buildFallbackSlots 1409-1455, assembly loop 1457-1497, SECTION_LATEX 124-173,
//   sanitizeLatexContent/escapeLatexText/firstNonEmpty 1368-1407.
// Plus the bot's normalizeLatexForPdflatex + the s6a $|$ restore + empty-body throw.
//
// IMPORTANT: the upstream Pass-1/Pass-2 LLM nodes emit RAW text (no structured
// output parser — that path failed on LaTeX-heavy JSON in S2b). Parse* Code nodes
// run the ported parseJSON before this node. We still defensively parseJSON here
// if a string slips through.
//
// Header is built DETERMINISTICALLY from ctx.personal (not the LLM) — this kills
// the entire {{EMAIL}}/$|$ render-bug class at the source.
//
// In:  $input.first().json = { pass1, pass2 }   (pass2 optional; fallback covers it)
//      $('Prepare Apply Context').first().json = { personal, chat_id, job_title, company, ... }
// Out: [{ json: { latex, chat_id, job_title, company, resumePlainText } }]   (matches
//      the old Build Resume LaTeX output shape so Compile/Send are untouched)

// ─── ONE skeleton (bot preamble + macros, retrofitted to command-center slots) ───
// The 3 seniority .tex skeletons were byte-identical except header placeholders
// (now code-built) and section-order comments (now driven by pass1.sectionOrder),
// so they collapse to one. Tier still drives selection/order via Pass-1, not here.
const SKELETON = String.raw`\documentclass[letterpaper,11pt]{article}

\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\input{glyphtounicode}

\usepackage[default]{lato}
\usepackage[T1]{fontenc}

\usepackage[top=0.45in, bottom=0.45in, left=0.55in, right=0.55in]{geometry}

\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

\titleformat{\section}{
  \vspace{-5pt}\scshape\raggedright\large
}{}{0em}{}[\color{black}\titlerule \vspace{-4pt}]

\pdfgentounicode=1

\newcommand{\resumeItem}[1]{
  \item\small{
    {#1}
  }
}
\newcommand{\resumeSubheading}[4]{
  \vspace{-1pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & #2 \\
      \textit{\small#3} & \textit{\small #4} \\
    \end{tabular*}\vspace{-5pt}
}
\newcommand{\resumeSubSubheading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \textit{\small#1} & \textit{\small #2} \\
    \end{tabular*}\vspace{-5pt}
}
\newcommand{\resumeProjectHeading}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \small#1 & #2 \\
    \end{tabular*}\vspace{-5pt}
}
\newcommand{\resumeSubItem}[1]{\resumeItem{#1}\vspace{-4pt}}
\renewcommand\labelitemi{\textbullet}
\renewcommand\labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}{\begin{itemize}[noitemsep, topsep=0pt, parsep=0pt, partopsep=0pt]}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-4pt}}

\begin{document}

%%% SLOT: header

%%% CONTENT_SECTIONS

\end{document}`;

// ─── SECTION_LATEX (command-center 124-173; uses bot-compatible macros) ───
const SECTION_LATEX = {
  summary: String.raw`\section{Summary}
\resumeSubHeadingListStart
  \small{\item{
%%% SLOT: summary_content
  }}
\resumeSubHeadingListEnd`,
  experience: String.raw`\section{Experience}
\resumeSubHeadingListStart
%%% SLOT: experience_entries
\resumeSubHeadingListEnd`,
  internships: String.raw`\section{Internships}
\resumeSubHeadingListStart
%%% SLOT: internship_entries
\resumeSubHeadingListEnd`,
  projects: String.raw`\section{Projects}
\resumeSubHeadingListStart
%%% SLOT: project_entries
\resumeSubHeadingListEnd`,
  skills: String.raw`\section{Technical Skills}
\resumeSubHeadingListStart
  \small{\item{
%%% SLOT: skills_content
  }}
\resumeSubHeadingListEnd`,
  education: String.raw`\section{Education}
\resumeSubHeadingListStart
%%% SLOT: education_entries
\resumeSubHeadingListEnd`,
  certifications: String.raw`\section{Certifications}
\resumeSubHeadingListStart
%%% SLOT: certification_entries
\resumeSubHeadingListEnd`,
  achievements: String.raw`\section{Achievements}
\resumeSubHeadingListStart
%%% SLOT: achievement_entries
\resumeSubHeadingListEnd`,
  activities: String.raw`\section{Activities \& Leadership}
\resumeSubHeadingListStart
%%% SLOT: activity_entries
\resumeSubHeadingListEnd`,
};

const SLOT_MARKER = {
  summary: '%%% SLOT: summary_content',
  experience: '%%% SLOT: experience_entries',
  internships: '%%% SLOT: internship_entries',
  projects: '%%% SLOT: project_entries',
  skills: '%%% SLOT: skills_content',
  education: '%%% SLOT: education_entries',
  certifications: '%%% SLOT: certification_entries',
  achievements: '%%% SLOT: achievement_entries',
  activities: '%%% SLOT: activity_entries',
};

// ─── Helpers ───
function escapeLatexText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function sanitizeLatexContent(content) {
  if (!content) return content;
  let s = content;
  s = s.replace(/(?<!\\)#(?!\{)/g, '\\#');
  s = s.replace(/(?<!\\)%/g, '\\%');
  s = s.replace(/(?<!\\)&/g, '\\&');
  s = s.replace(/(?<!\\)_(?![a-zA-Z]*\})/g, '\\_');
  s = s.replace(/\\begin\{document\}/g, '');
  s = s.replace(/\\end\{document\}/g, '');
  s = s.replace(/\\documentclass[^{]*\{[^}]*\}/g, '');
  s = s.replace(/\\usepackage(\[[^\]]*\])?\{[^}]*\}/g, '');
  return s;
}

function firstNonEmpty(...values) {
  return values.find((v) => String(v == null ? '' : v).trim().length > 0) ?? '';
}

function bulletItems(items) {
  return (items || [])
    .filter(Boolean)
    .slice(0, 4)
    .map((item) => '    \\resumeItem{' + escapeLatexText(item) + '}')
    .join('\n');
}

// Deterministic header from the parsed master resume (NOT the LLM).
function buildHeaderFromPersonal(p) {
  p = p || {};
  const name = escapeLatexText(firstNonEmpty(p.name, 'Candidate'));
  const parts = [];
  const phone = firstNonEmpty(p.phone_display, p.phone);
  if (phone) parts.push(escapeLatexText(phone));
  if (p.email) parts.push('\\href{mailto:' + p.email + '}{\\underline{' + p.email + '}}');
  if (p.linkedin) parts.push('\\href{' + p.linkedin + '}{\\underline{LinkedIn}}');
  if (p.github) parts.push('\\href{' + p.github + '}{\\underline{GitHub}}');
  if (p.portfolio) parts.push('\\href{' + p.portfolio + '}{\\underline{Portfolio}}');
  if (p.show_location && p.location) parts.push(escapeLatexText(p.location));
  const contact = parts.length ? '\\small ' + parts.join(' $|$ ') : '';
  return '\\begin{center}\n  \\textbf{\\Huge \\scshape ' + name + '} \\\\ \\vspace{4pt}\n  ' + contact + '\n\\end{center}';
}

// command-center buildFallbackSlots 1409-1455 (non-compact only; bot has no compact template)
function buildFallbackSlots(pass1) {
  const slots = {};
  const itemEnd = '\\resumeItemListEnd';
  const itemStart = '\\resumeItemListStart';
  const subheading = '\\resumeSubheading';
  slots.summary = pass1.summary ? escapeLatexText(pass1.summary) : '';

  slots.experience = (pass1.companies || []).flatMap((company) =>
    (company.positions || []).filter((pos) => pos.isSelected !== false).map((pos) => {
      const bullets = bulletItems(pos.keyAchievements || []);
      if (!bullets) return '';
      return subheading + '{' + escapeLatexText(pos.title) + '}{' + escapeLatexText((pos.startDate || '') + ' -- ' + (pos.endDate || '')) + '}{' + escapeLatexText(company.company) + '}{' + escapeLatexText(pos.location) + '}\n' + itemStart + '\n' + bullets + '\n' + itemEnd;
    })
  ).filter(Boolean).join('\n');

  slots.internships = (pass1.selectedInternships || []).map((intern) => {
    const bullets = bulletItems(intern.keyAchievements || []);
    if (!bullets) return '';
    return subheading + '{' + escapeLatexText(intern.title) + '}{' + escapeLatexText((intern.startDate || '') + ' -- ' + (intern.endDate || '')) + '}{' + escapeLatexText(intern.company) + '}{' + escapeLatexText(intern.location) + '}\n' + itemStart + '\n' + bullets + '\n' + itemEnd;
  }).filter(Boolean).join('\n');

  slots.projects = (pass1.selectedProjects || []).map((project) => {
    const bullets = bulletItems(project.descriptionPoints || []);
    if (!bullets) return '';
    return '\\resumeProjectHeading{\\textbf{' + escapeLatexText(project.name) + '} $|$ \\emph{' + escapeLatexText(project.techStack) + '}}{' + escapeLatexText(project.date) + '}\n' + itemStart + '\n' + bullets + '\n' + itemEnd;
  }).filter(Boolean).join('\n');

  slots.skills = (pass1.skillsCategories || []).map((cat) => {
    const skills = Array.isArray(cat.skills) ? cat.skills.join(', ') : '';
    return skills ? '\\textbf{' + escapeLatexText(cat.category) + ':} ' + escapeLatexText(skills) + ' \\\\' : '';
  }).filter(Boolean).join('\n');

  slots.education = (pass1.education || []).slice(0, 2).map((edu) =>
    '\\resumeSubheading{' + escapeLatexText([edu.degree, edu.major].filter(Boolean).join(' -- ')) + '}{' + escapeLatexText(edu.graduationDate) + '}{' + escapeLatexText(edu.institution) + '}{' + escapeLatexText(edu.gpa ? 'GPA: ' + edu.gpa : '') + '}'
  ).join('\n');

  slots.certifications = (pass1.certifications || []).filter((cert) => cert.qualityTier !== 'completion_only').map((cert) =>
    '\\resumeProjectHeading{\\textbf{' + escapeLatexText(cert.name) + '} $|$ \\emph{' + escapeLatexText(cert.issuer) + '}}{' + escapeLatexText(cert.date) + '}'
  ).join('\n');

  slots.achievements = (pass1.selectedAchievements || []).map((a) => '\\resumeItem{' + escapeLatexText(firstNonEmpty(a.description, a.title)) + '}').join('\n');

  slots.activities = (pass1.activities || []).map((act) =>
    '\\resumeProjectHeading{\\textbf{' + escapeLatexText(act.name) + '} $|$ \\emph{' + escapeLatexText(act.organization) + '}}{' + escapeLatexText(act.date) + '}\n' + itemStart + '\n    \\resumeItem{' + escapeLatexText(act.description) + '}\n' + itemEnd
  ).join('\n');

  return slots;
}

function normalizeLatexForPdflatex(input) {
  if (!input) return input;
  let s = input.replace(/\r\n/g, '\n');
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/…/g, '...').replace(/[–—]/g, '--').replace(/ /g, ' ');
  s = s.replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ')
    .replace(/(?<!\\)\$/g, '\\$');
  s = s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  return s;
}

// Defensive: parse LaTeX-heavy JSON if a raw string reached us (escapes literal
// \n\r\t inside string values only). Ported from index.ts 319-378.
function parseJSON(content) {
  if (content && typeof content === 'object') return content;
  let cleaned = String(content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    let extracted = cleaned.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(extracted); } catch (e) {}
    let fixed = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < extracted.length; i++) {
      const ch = extracted[i];
      if (escape) { fixed += ch; escape = false; continue; }
      if (ch === '\\' && inString) { fixed += ch; escape = true; continue; }
      if (ch === '"') { inString = !inString; fixed += ch; continue; }
      if (inString) {
        if (ch === '\n') { fixed += '\\n'; continue; }
        if (ch === '\r') { fixed += '\\r'; continue; }
        if (ch === '\t') { fixed += '\\t'; continue; }
      }
      fixed += ch;
    }
    fixed = fixed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(fixed); } catch (e) {}
  }
  return {};
}

function derivePlainText(pass1) {
  const L = [];
  for (const comp of (pass1.companies || [])) {
    for (const pos of (comp.positions || [])) {
      if (pos.isSelected === false) continue;
      L.push((pos.title || '') + ' at ' + (comp.company || '') + ' (' + (pos.startDate || '') + ' - ' + (pos.endDate || '') + ')');
      for (const a of (pos.keyAchievements || [])) L.push('- ' + a);
      L.push('');
    }
  }
  for (const intern of (pass1.selectedInternships || [])) {
    L.push((intern.title || '') + ' at ' + (intern.company || ''));
    for (const a of (intern.keyAchievements || [])) L.push('- ' + a);
    L.push('');
  }
  for (const proj of (pass1.selectedProjects || [])) {
    L.push('Project: ' + (proj.name || '') + ' | ' + (proj.techStack || ''));
    for (const d of (proj.descriptionPoints || [])) L.push('- ' + d);
    L.push('');
  }
  if ((pass1.skillsCategories || []).length) {
    L.push('Skills:');
    for (const cat of pass1.skillsCategories) L.push((cat.category || '') + ': ' + ((cat.skills || []).join(', ')));
    L.push('');
  }
  for (const edu of (pass1.education || [])) {
    L.push((edu.degree || '') + ' in ' + (edu.major || '') + ' - ' + (edu.institution || '') + ' (' + (edu.graduationDate || '') + ')');
  }
  return L.join('\n');
}

// ─── Main ───
const data = $input.first().json || {};
const pass1 = parseJSON(data.pass1 || {});
const pass2 = parseJSON(data.pass2 || {});
const ctx = $('Prepare Apply Context').first().json || {};
const personal = ctx.personal || {};

const sectionOrder = (Array.isArray(pass1.sectionOrder) && pass1.sectionOrder.length)
  ? pass1.sectionOrder
  : ['experience', 'projects', 'skills', 'education'];

const fallbackSlots = buildFallbackSlots(pass1);

const slotMap = {
  summary: pass2.summary_content || fallbackSlots.summary || '',
  experience: pass2.experience_entries || fallbackSlots.experience || '',
  internships: pass2.internship_entries || fallbackSlots.internships || '',
  projects: pass2.project_entries || fallbackSlots.projects || '',
  skills: pass2.skills_content || fallbackSlots.skills || '',
  education: pass2.education_entries || fallbackSlots.education || '',
  certifications: pass2.certification_entries || fallbackSlots.certifications || '',
  achievements: pass2.achievement_entries || fallbackSlots.achievements || '',
  activities: pass2.activity_entries || fallbackSlots.activities || '',
};

const contentSections = sectionOrder.map((section) => {
  const tpl = SECTION_LATEX[section];
  if (!tpl) return '';
  const slotContent = slotMap[section];
  if (slotContent === undefined || slotContent === '') return '';
  // split/join (never String.replace — slot content carries $ and \, which the
  // replacement-string parser would mangle: the $-in-replace footgun)
  return tpl.split(SLOT_MARKER[section]).join(sanitizeLatexContent(slotContent));
}).filter(Boolean).join('\n\n');

const headerLatex = buildHeaderFromPersonal(personal);

const finalLatex = SKELETON
  .split('%%% SLOT: header').join(headerLatex)
  .split('%%% CONTENT_SECTIONS').join(contentSections);

// normalize, then restore the intentional $|$ separators normalize over-escapes (s6a)
const normalized = normalizeLatexForPdflatex(finalLatex).split('\\$|\\$').join('$|$');

// never ship a blank resume — guard the assembled body
const body = (normalized.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/) || [])[1] || '';
const bodyClean = body.replace(/%.*$/gm, '').replace(/\\(begin|end)\{center\}/g, '').trim();
if (!bodyClean || contentSections.trim().length === 0) {
  throw new Error('Assemble Resume LaTeX produced an empty body (sections=' + sectionOrder.join(',') + '). Refusing to compile a blank resume.');
}

return [{
  json: {
    latex: normalized,
    chat_id: ctx.chat_id,
    job_title: ctx.job_title,
    company: ctx.company,
    resumePlainText: pass2.resumePlainText || derivePlainText(pass1),
  },
}];
