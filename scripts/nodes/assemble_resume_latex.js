// Auto-generated from the live workflow node "Assemble Resume LaTeX" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

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
const SKELETON = String.raw`\documentclass[{{PAPER}},11pt]{article}

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

\usepackage[top=0.3in, bottom=0.3in, left=0.4in, right=0.4in]{geometry}

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
  \vspace{-12pt}\scshape\raggedright\large\bfseries
}{}{0em}{}[\color{black}\titlerule \vspace{-5pt}]

\pdfgentounicode=1

\newcommand{\resumeItem}[1]{
  \item\small{
    {#1 \vspace{-2pt}}
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
% s135 RESUME FORMAT v2: single-line entry header for a standalone
% experience/internship position -- \textbf{Title} $|$ Company (left),
% dates (right). Distinct from \resumeSubheading (left unchanged --
% still used by education's 4-arg call and the legacy fragment fallback).
\newcommand{\resumeSubheadingOneLine}[3]{
  \vspace{-1pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} $|$ #2 & \textit{\small #3} \\
    \end{tabular*}\vspace{-5pt}
}
% s135: company header for a stacked multi-position run -- name ONLY, no
% derived date range (per-position dates below, via \resumeSubSubheading,
% already carry the truth; a computed range would fabricate continuity
% across any real gap).
\newcommand{\resumeCompanyHeading}[1]{
  \vspace{-1pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{#1} & \\
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
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-5pt}}
\newcommand{\resumeItemCompact}[1]{
  \item\footnotesize{
    {#1}
  }
}
\newcommand{\resumeSubheadingCompact}[4]{
  \vspace{-1pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{\footnotesize #1} & \footnotesize #2 \\
      \textit{\footnotesize#3} & \textit{\footnotesize #4} \\
    \end{tabular*}\vspace{-7pt}
}
% s135: probe-confirmed 2026-07-21 (compact-mid fixture, real pdflatex,
% see _s135_calibrate.js) -- these 3 compact variants copy the existing
% normal/-5pt vs compact/-7pt convention already used above; the compile
% confirms it holds unchanged in compact mode too.
\newcommand{\resumeSubheadingOneLineCompact}[3]{
  \vspace{-1pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{\footnotesize #1} $|$ \footnotesize #2 & \textit{\footnotesize #3} \\
    \end{tabular*}\vspace{-7pt}
}
\newcommand{\resumeCompanyHeadingCompact}[1]{
  \vspace{-1pt}\item
    \begin{tabular*}{0.97\textwidth}[t]{l@{\extracolsep{\fill}}r}
      \textbf{\footnotesize #1} & \\
    \end{tabular*}\vspace{-7pt}
}
\newcommand{\resumeSubSubheadingCompact}[2]{
    \item
    \begin{tabular*}{0.97\textwidth}{l@{\extracolsep{\fill}}r}
      \textit{\footnotesize#1} & \textit{\footnotesize #2} \\
    \end{tabular*}\vspace{-7pt}
}
\newcommand{\resumeItemListEndCompact}{\end{itemize}\vspace{-6pt}}

\begin{document}

%%% SLOT: header

%%% CONTENT_SECTIONS

\end{document}`;

// ─── SECTION_LATEX (command-center 124-173; uses bot-compatible macros) ───
const SECTION_LATEX = {
  summary: String.raw`\section{{{TITLE:summary}}}
\resumeSubHeadingListStart
  \small{\item{
%%% SLOT: summary_content
  }}
\resumeSubHeadingListEnd`,
  experience: String.raw`\section{{{TITLE:experience}}}
\resumeSubHeadingListStart
%%% SLOT: experience_entries
\resumeSubHeadingListEnd`,
  internships: String.raw`\section{{{TITLE:internships}}}
\resumeSubHeadingListStart
%%% SLOT: internship_entries
\resumeSubHeadingListEnd`,
  projects: String.raw`\section{{{TITLE:projects}}}
\resumeSubHeadingListStart
%%% SLOT: project_entries
\resumeSubHeadingListEnd`,
  skills: String.raw`\section{{{TITLE:skills}}}
\resumeSubHeadingListStart
  \small{\item{
%%% SLOT: skills_content
  }}
\resumeSubHeadingListEnd`,
  education: String.raw`\section{{{TITLE:education}}}
\resumeSubHeadingListStart
%%% SLOT: education_entries
\resumeSubHeadingListEnd`,
  certifications: String.raw`\section{{{TITLE:certifications}}}
\resumeSubHeadingListStart
%%% SLOT: certification_entries
\resumeSubHeadingListEnd`,
  achievements: String.raw`\section{{{TITLE:achievements}}}
\resumeSubHeadingListStart
%%% SLOT: achievement_entries
\resumeSubHeadingListEnd`,
  activities: String.raw`\section{{{TITLE:activities}}}
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
function normalizeUrl(u) {
  u = String(u == null ? '' : u).trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
}
// s135: visible link text -- normalizeUrl(u) with scheme, "www.", and a
// trailing slash all stripped, then escaped. Never fed through
// escapeLatexTextV2 for the href TARGET itself (only for what is shown).
function visibleUrlTextV2(u) {
  const v = normalizeUrl(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  return escapeLatexTextV2(v);
}
function buildHeaderFromPersonal(p) {
  p = p || {};
  const name = escapeLatexTextV2(firstNonEmpty(p.name, 'Candidate'));
  const parts = [];
  const phone = firstNonEmpty(p.phone_display, p.phone);
  if (phone) parts.push(escapeLatexTextV2(phone));
  if (p.email) parts.push('\\href{mailto:' + p.email + '}{' + escapeLatexTextV2(p.email) + '}');
  if (p.linkedin) parts.push('\\href{' + normalizeUrl(p.linkedin) + '}{' + visibleUrlTextV2(p.linkedin) + '}');
  if (p.github) parts.push('\\href{' + normalizeUrl(p.github) + '}{' + visibleUrlTextV2(p.github) + '}');
  if (p.portfolio) parts.push('\\href{' + normalizeUrl(p.portfolio) + '}{' + visibleUrlTextV2(p.portfolio) + '}');
  if (p.show_location && p.location) parts.push(escapeLatexTextV2(p.location));
  // s135 RESUME FORMAT v2: ' ~$|$~ ' is emitted here as literal CODE, never
  // passed through escapeLatexTextV2 (which would mangle the tilde into
  // \textasciitilde{}).
  const contact = parts.length ? '{\\fontsize{9}{9}\\selectfont ' + parts.join(' ~$|$~ ') + '}' : '';
  // Probe-confirmed 2026-07-21 (contact-line-6-fields fixture, real
  // pdflatex, see _s135_calibrate.js): 4pt between name and contact line
  // holds cleanly against the new 18pt/9pt sizing, incl. all 6 contact
  // fields present at once -- no overflow of the 0.97\textwidth line.

  // s141: locale disclosure gate. A field renders ONLY IF the resolved
  // locale profile allows it (optional|expected, never forbidden) AND the
  // candidate explicitly provided a real value -- never inferred, never
  // LLM-decided. __localeProfile/__jobCountryCode are glue set OUTSIDE this
  // tracked block (see the Main section) so this function's own signature
  // stays a stable drift anchor; localeGateAllows is a new shared block,
  // deliberately duplicated in Build Pass1 Context for budget estimation.
  const __locFields = (__localeProfile && __localeProfile.fields) || {};
  const __piiBits = [];
  if (localeGateAllows(__locFields, 'dob') && p.dob) __piiBits.push('DOB: ' + escapeLatexTextV2(p.dob));
  if (localeGateAllows(__locFields, 'nationality') && p.nationality) __piiBits.push('Nationality: ' + escapeLatexTextV2(p.nationality));
  if (localeGateAllows(__locFields, 'marital_status') && p.marital_status) __piiBits.push('Marital Status: ' + escapeLatexTextV2(p.marital_status));
  const __piiLine = __piiBits.length ? (" \\\\ {\\\\fontsize{9}{9}\\\\selectfont " + __piiBits.join(' ~$|$~ ') + '}') : '';
  let __workAuthLine = '';
  if (localeGateAllows(__locFields, 'work_authorization_status') && __jobCountryCode && p.work_authorization_status && typeof p.work_authorization_status === 'object') {
    const __wa = p.work_authorization_status[__jobCountryCode];
    if (__wa) __workAuthLine = " \\\\ {\\\\fontsize{9}{9}\\\\selectfont " + escapeLatexTextV2(String(__wa)) + '}';
  }
  let __signatureBlock = '';
  if (localeGateAllows(__locFields, 'signature_line') && p.signature === true) {
    const __sigBits = [name];
    if (p.show_location && p.location) __sigBits.push(escapeLatexTextV2(p.location));
    __signatureBlock = "\\vspace{6pt}\\\\ " + "{\\\\fontsize{9}{9}\\\\selectfont " + __sigBits.join(', ') + '}';
  }
  return '\\begin{center}\n  {\\fontsize{18}{18}\\selectfont \\textbf{' + name + '}} \\\\ \\vspace{4pt}\n  ' + contact + __piiLine + __workAuthLine + '\n\\end{center}\\vspace{-6pt}' + __signatureBlock;
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

  slots.achievements = (function () {
    // s76: grouped fallback -- mirrors the V2 renderer, fixed 3-line budget.
    const stripLinks = (s) => String(s || '').replace(/\s*\|?\s*(?:https?:\/\/)?(?:www\.)?github\.com\/\S*/gi, '').trim().replace(/[|\s]+$/, '');
    const catOf = (s) => /\b(?:\d+(?:st|nd|rd|th)\s+place|winner|prize|champion)\b/i.test(s) ? 'Hackathon Wins'
      : /\b(?:meetup|conference|talk|presentation|speaker|keynote|demo(?:ed)?)\b/i.test(s) || /llm day/i.test(s) ? 'Speaking'
      : 'Highlights';
    const groups = { 'Hackathon Wins': [], 'Speaking': [], 'Highlights': [] };
    for (const a of (pass1.selectedAchievements || [])) {
      const txt = stripLinks(firstNonEmpty(a.description, a.title));
      if (txt) groups[catOf(txt)].push(txt);
    }
    const rows = [];
    for (const cat of ['Hackathon Wins', 'Speaking', 'Highlights']) {
      if (!groups[cat].length) continue;
      rows.push('\\resumeItem{\\textbf{' + escapeLatexText(cat) + ':} ' + groups[cat].map((t) => escapeLatexText(t)).join(' $|$ ') + '}');
    }
    return rows.slice(0, 3).join('\n');
  })();

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

function escapeLatexTextV2(value) {
  let s = String(value == null ? '' : value);
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...')
       // s135: spaced en/em dash FIRST (must run before the bare em-dash
       // rule or it never matches), then unspaced em -> spaced double
       // hyphen, then unspaced en -> bare hyphen (protects date ranges).
       .replace(/\s+[–—]\s+/g, ' -- ').replace(/—/g, ' -- ').replace(/–/g, '-').replace(/ /g, ' ')
       .replace(/[→➔➡]/g, '->').replace(/•/g, '-')
       .replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ');
  s = s.replace(/\\/g, ' ')
       .replace(/([#$%&_{}])/g, '\\$1')
       .replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}')
       .replace(/ /g, '\\textbackslash{}')
       .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  return s;
}
function truncateBullet(t, reserve) {
  t = String(t == null ? '' : t).trim();
  const SAFE_TOTAL = 210; // real-pdflatex-verified combined (keyword+body) 2-line ceiling
  const MAX = Math.max(60, SAFE_TOTAL - (reserve || 0));
  if (t.length <= MAX) return t;
  const cut = t.slice(0, MAX);
  const bal = (s) => { let d = 0; for (let k = 0; k < s.length; k++) { if (s[k] === '(') d++; else if (s[k] === ')') d--; } return d === 0; };
  // s135: sentence-boundary check FIRST, mirroring truncateSummary's own
  // pattern -- a complete sentence beats any clause fragment, no ellipsis.
  const period = cut.lastIndexOf('. ');
  if (period > MAX * 0.5) return cut.slice(0, period + 1);
  const floor = Math.floor(MAX * 0.45);
  // s135: bounded (max 3 passes) trailing-fragment stripper -- eats a
  // dangling function word OR a dangling numeric/unit token (e.g. "121+"),
  // re-checking paren balance every pass so it never strips into an
  // unbalanced state. Fixes the live Bayer bug: a bullet cut right after
  // "...121+ behavior" used to render as "...121+ behavior..." (ellipsis
  // mid-noun-phrase, dropping "metrics" and everything after it).
  const stripTrailingFragment = (s) => {
    const wordRe = /\s+(and|or|with|for|to|of|by|in|on|at|via|across|per|from|into|over|within|the|a|an|using)$/i;
    const numRe = /\s+\d[\d,.]*[+%~]?x?$/i;
    for (let pass = 0; pass < 3; pass++) {
      let next = s.replace(wordRe, '').replace(numRe, '').replace(/[,;:.\s]+$/, '');
      if (next === s) break;
      if (!bal(next)) break;
      s = next;
    }
    return s;
  };
  // Prefer a clean clause end (a balanced ')' or a comma/semicolon OUTSIDE any
  // parenthetical) -- reads as a complete thought, no ellipsis needed.
  for (let i = cut.length - 1; i > floor; i--) {
    const ch = cut[i];
    if (ch === ')' && bal(cut.slice(0, i + 1))) return cut.slice(0, i + 1);
    if ((ch === ',' || ch === ';') && bal(cut.slice(0, i))) {
      return stripTrailingFragment(cut.slice(0, i));
    }
  }
  const sp = cut.lastIndexOf(' ');
  let base = cut.slice(0, sp > MAX - 30 ? sp : MAX);
  if (!bal(base) && base.lastIndexOf('(') > 0) base = base.slice(0, base.lastIndexOf('('));
  base = stripTrailingFragment(base);
  return base + '...';
}
function truncateSummary(t) {
  t = String(t == null ? '' : t).trim();
  const MAX = 190; // real-pdflatex-verified: holds at exactly 2 lines up to ~206 chars
  if (t.length <= MAX) return t;
  const cut = t.slice(0, MAX);
  const period = cut.lastIndexOf('. ');
  if (period > MAX * 0.5) return cut.slice(0, period + 1);
  const bal = (s) => { let d = 0; for (let k = 0; k < s.length; k++) { if (s[k] === '(') d++; else if (s[k] === ')') d--; } return d === 0; };
  const floor = Math.floor(MAX * 0.55);
  for (let i = cut.length - 1; i > floor; i--) {
    const ch = cut[i];
    if ((ch === ',' || ch === ';') && bal(cut.slice(0, i))) return cut.slice(0, i).replace(/[,;:.\s]+$/, '') + '.';
  }
  const sp = cut.lastIndexOf(' ');
  const base = (sp > MAX - 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '');
  return base + '...';
}
function bulletRenderV2(bullets, isCompact) {
  const cmd = isCompact ? '\\resumeItemCompact' : '\\resumeItem';
  return (bullets || []).slice(0, isCompact ? 4 : 6).map((b) => {
    const kwText = (b.keyword || '').replace(/[:;,.]+\s*$/, '');
    const reserve = kwText ? kwText.length + 2 : 0;
    const text = truncateBullet(b.text, reserve);
    const kw = kwText ? '\\textbf{' + escapeLatexTextV2(kwText) + ':} ' : '';
    return '    ' + cmd + '{' + kw + escapeLatexTextV2(text) + '}';
  }).join('\n');
}
function indexByPositionIdV2(arr) {
  const m = {};
  for (const e of (Array.isArray(arr) ? arr : [])) { if (e && e.position_id) m[e.position_id] = Array.isArray(e.bullets) ? e.bullets : []; }
  return m;
}
function resolveBulletsV2(pass2Bullets, pass1Achievements) {
  if (Array.isArray(pass2Bullets) && pass2Bullets.length) {
    return pass2Bullets.map((b) => (typeof b === 'string' ? { keyword: '', text: b } : { keyword: (b && b.keyword) || '', text: (b && b.text) || '' })).filter((b) => b.text);
  }
  return (pass1Achievements || []).map((a) => ({ keyword: '', text: String(a) }));
}
function normKeyV2(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function normTextV2(value) {
  return normKeyV2(value).replace(/\s+/g, ' ');
}
function dateKeyV2(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  if (/present|current/.test(s)) return 'present';
  const ym = s.match(/\b((?:19|20)\d{2})[-/](0?[1-9]|1[0-2])\b/);
  if (ym) return ym[1] + '-' + String(Number(ym[2])).padStart(2, '0');
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };
  const my = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+((?:19|20)\d{2})\b/);
  if (my) return my[2] + '-' + months[my[1]];
  const y = s.match(/\b((?:19|20)\d{2})\b/);
  return y ? y[1] : '';
}
function datesCompatibleV2(a, b) {
  return !!(a && b && (a === b || (a.length === 4 && b.startsWith(a)) || (b.length === 4 && a.startsWith(b))));
}
function masterExperienceRowsV2() {
  let r = {};
  try { r = ($('Prepare Apply Context').first().json || {}).resume_structured || {}; } catch (e) { r = {}; }
  return (Array.isArray(r.experience) ? r.experience : []).map((e) => ({
    title: e.title || '',
    company: e.company || e.organization || '',
    companyKey: normKeyV2(e.company || e.organization || ''),
    startKey: dateKeyV2(e.start_date || e.startDate),
    endKey: dateKeyV2(e.is_current ? 'present' : (e.end_date || e.endDate)),
    bullets: Array.isArray(e.bullets) ? e.bullets : [],
  })).filter((e) => e.title);
}
function achievementOverlapV2(pos, row) {
  const pass1 = (Array.isArray(pos.keyAchievements) ? pos.keyAchievements : []).map(normTextV2).filter((s) => s.length > 30);
  const master = (Array.isArray(row.bullets) ? row.bullets : []).map(normTextV2).filter((s) => s.length > 30);
  let score = 0;
  for (const a of pass1) {
    for (const b of master) {
      const as = a.slice(0, Math.min(90, a.length));
      const bs = b.slice(0, Math.min(90, b.length));
      if (a.includes(bs) || b.includes(as)) score++;
    }
  }
  return score;
}
function resolveMasterExperienceTitleV2(pos, companyName, rows) {
  const fallback = pos.title || '';
  if (!rows.length) return fallback;
  const companyKey = normKeyV2(companyName || pos.company || pos.organization || '');
  const start = dateKeyV2(pos.startDate || pos.start_date);
  const end = dateKeyV2(pos.endDate || pos.end_date);
  const scored = rows.map((row) => {
    const companyMatch = companyKey && row.companyKey && (row.companyKey === companyKey || row.companyKey.includes(companyKey) || companyKey.includes(row.companyKey));
    const dateMatch = datesCompatibleV2(start, row.startKey) || datesCompatibleV2(end, row.endKey);
    const ach = achievementOverlapV2(pos, row);
    return { row, score: (ach * 10) + (companyMatch ? 4 : 0) + (dateMatch ? 3 : 0) + (normKeyV2(fallback) === normKeyV2(row.title) ? 1 : 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return fallback;
  if (scored[0].score >= 10) return scored[0].row.title || fallback;
  if (scored[0].score >= 7 && (!scored[1] || scored[0].score > scored[1].score)) return scored[0].row.title || fallback;
  return fallback;
}
function mergeContent(pass1, pass2) {
  pass1 = pass1 || {}; pass2 = pass2 || {};
  const sectionOrder = (Array.isArray(pass1.sectionOrder) && pass1.sectionOrder.length) ? pass1.sectionOrder.slice() : ['experience', 'projects', 'skills', 'education'];

  const p2exp = indexByPositionIdV2(pass2.experience_bullets);
  const p2int = indexByPositionIdV2(pass2.internship_bullets);
  const p2proj = indexByPositionIdV2(pass2.project_bullets);
  const masterRows = masterExperienceRowsV2();
  // s59: education-date backstop, same idiom as the title-integrity backstop
  // above -- Pass1's LLM invented "2024" for a real end_date of 2023-12 on a
  // real live apply. resume_structured.education (threaded in since s50) has
  // the correct raw date; resolve graduationDate from it instead of trusting
  // Pass1's own text output.
  function masterEducationRowsV2() {
    let r = {};
    try { r = ($('Prepare Apply Context').first().json || {}).resume_structured || {}; } catch (e) { r = {}; }
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const fmt = (e) => {
      const src = e.end_date || e.start_date;
      if (!src) return '';
      const m = String(src).match(/^(\d{4})-(\d{2})/);
      if (!m) return String(src);
      const mon = MONTHS[parseInt(m[2], 10) - 1] || '';
      return (mon ? mon + ' ' : '') + m[1] + (e.is_current ? ' (Expected)' : '');
    };
    return (Array.isArray(r.education) ? r.education : []).map((e) => ({ institutionKey: normKeyV2(e.institution || ''), formattedDate: fmt(e) }));
  }
  function resolveMasterGraduationDateV2(edu, rows) {
    const fallback = edu.graduationDate || '';
    if (!rows.length) return fallback;
    const key = normKeyV2(edu.institution || '');
    const match = rows.find((row) => row.institutionKey && key && row.institutionKey === key);
    return (match && match.formattedDate) || fallback;
  }
  const masterEduRows = masterEducationRowsV2();

  const experience = [];
  for (const comp of (pass1.companies || [])) {
    for (const pos of (comp.positions || [])) {
      if (pos.isSelected === false) continue;
      const expCap = (typeof pos.bulletCount === 'number' && pos.bulletCount >= 0) ? pos.bulletCount : Infinity;
      const bullets = resolveBulletsV2(p2exp[pos.id], pos.keyAchievements).slice(0, expCap);
      if (!bullets.length) continue;
      experience.push({ title: resolveMasterExperienceTitleV2(pos, comp.company, masterRows), company: comp.company || '', startDate: pos.startDate || '', endDate: pos.endDate || '', location: pos.location || '', bullets });
    }
  }
  const internships = (pass1.selectedInternships || []).map((intern) => {
    const intCap = (typeof intern.bulletCount === 'number' && intern.bulletCount >= 0) ? intern.bulletCount : Infinity;
    const bullets = resolveBulletsV2(p2int[intern.id], intern.keyAchievements).slice(0, intCap);
    if (!bullets.length) return null;
    return { title: intern.title || '', company: intern.company || '', startDate: intern.startDate || '', endDate: intern.endDate || '', location: intern.location || '', bullets };
  }).filter(Boolean);
  const projects = (pass1.selectedProjects || []).map((proj) => {
    const projCap = (typeof proj.bulletCount === 'number' && proj.bulletCount >= 0) ? proj.bulletCount : Infinity;
    const bullets = resolveBulletsV2(p2proj[proj.id], proj.descriptionPoints).slice(0, projCap);
    if (!bullets.length) return null;
    return { name: proj.name || '', techStack: proj.techStack || '', date: proj.date || '', bullets };
  }).filter(Boolean);

  // Iterate Pass1's categories (never Pass2's) so a category Pass2 forgot to mention
  // is never silently dropped -- it falls back to Pass1's own list for that category.
  // Only skills Pass1 actually listed survive the whitelist (no invented skills).
  const pass2CatMap = {};
  if (Array.isArray(pass2.skills)) {
    for (const cat of pass2.skills) { if (cat && cat.category) pass2CatMap[cat.category] = Array.isArray(cat.skills) ? cat.skills : []; }
  }
  const skills = (pass1.skillsCategories || []).map((cat) => {
    const allow = new Set((cat.skills || []).map((s) => String(s).toLowerCase()));
    if (Object.prototype.hasOwnProperty.call(pass2CatMap, cat.category)) {
      const filtered = pass2CatMap[cat.category].filter((s) => allow.has(String(s).toLowerCase()));
      return { category: cat.category || '', skills: filtered.length ? filtered : (cat.skills || []) };
    }
    return { category: cat.category || '', skills: cat.skills || [] };
  }).filter((cat) => cat.skills.length);

  return {
    summary: (sectionOrder.indexOf('summary') !== -1 && pass2.summary) ? String(pass2.summary) : (pass1.summary || ''),
    experience, internships, projects, skills,
    education: (pass1.education || []).map((edu) => Object.assign({}, edu, { graduationDate: resolveMasterGraduationDateV2(edu, masterEduRows) })),
    certifications: pass1.certifications || [],
    achievements: (pass1.selectedAchievements || []).slice(0, 8),
    activities: pass1.activities || [],
    sectionOrder,
    _budget: pass1._contentPlan ? { tier: pass1._contentPlan.tier, maxBulletsPerEntry: pass1._contentPlan.maxBulletsPerEntry, linesPerBullet: pass1._contentPlan.linesPerBullet, achievementsLines: pass1._contentPlan.achievementsMax || 3 } : null,
  };
}
function derivePlainTextFromContent(content) {
  const L = [];
  if (content.summary) { L.push(content.summary); L.push(''); }
  for (const e of (content.experience || [])) {
    L.push((e.title || '') + ' at ' + (e.company || '') + ' (' + (e.startDate || '') + ' - ' + (e.endDate || '') + ')');
    for (const b of (e.bullets || [])) L.push('- ' + (b.keyword ? b.keyword + ': ' : '') + b.text);
    L.push('');
  }
  for (const e of (content.internships || [])) {
    L.push((e.title || '') + ' at ' + (e.company || ''));
    for (const b of (e.bullets || [])) L.push('- ' + (b.keyword ? b.keyword + ': ' : '') + b.text);
    L.push('');
  }
  for (const p of (content.projects || [])) {
    L.push('Project: ' + (p.name || '') + ' | ' + (p.techStack || ''));
    for (const b of (p.bullets || [])) L.push('- ' + (b.keyword ? b.keyword + ': ' : '') + b.text);
    L.push('');
  }
  if ((content.skills || []).length) {
    L.push('Skills:');
    for (const cat of content.skills) L.push((cat.category || '') + ': ' + ((cat.skills || []).join(', ')));
    L.push('');
  }
  for (const edu of (content.education || [])) {
    L.push((edu.degree || '') + ' in ' + (edu.major || '') + ' - ' + (edu.institution || '') + ' (' + (edu.graduationDate || '') + ')');
  }
  return L.join('\n');
}
function hasAnyContent(content) {
  return !!(content.summary || content.experience.length || content.internships.length || content.projects.length ||
    content.education.length || content.certifications.length || content.achievements.length || content.activities.length ||
    content.skills.some((c) => c.skills && c.skills.length));
}
function capTechStackV2(name, stack) {
  // s76: the project header line is name + stack + right-aligned date; an
  // unbounded stack collides with the date and truncates mid-word. Cap at the
  // last full comma boundary within the width budget.
  const budget = Math.max(30, 92 - String(name || '').length);
  let s = String(stack || '');
  if (s.length <= budget) return s;
  let cut = s.lastIndexOf(',', budget);
  if (cut < 15) cut = budget;
  return s.slice(0, cut).replace(/[\s,]+$/, '');
}
function renderResume(content, personal, isCompact) {
  const itemStart = '\\resumeItemListStart';
  const itemEnd = isCompact ? '\\resumeItemListEndCompact' : '\\resumeItemListEnd';
  const subheadingCmd = isCompact ? '\\resumeSubheadingCompact' : '\\resumeSubheading';
  const itemCmd = isCompact ? '\\resumeItemCompact' : '\\resumeItem';
  const slots = {};
  slots.summary = content.summary ? escapeLatexTextV2(truncateSummary(content.summary)) : '';
  const companyKeyOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // s135: >=2 CONSECUTIVE (adjacent-by-construction) entries sharing a
  // company (case-insensitive, non-alphanumeric-stripped) render as one
  // \resumeCompanyHeading + a \resumeSubSubheading per position (title/
  // dates only -- no derived total date range, per-position dates already
  // carry the truth). Non-adjacent same-company "boomerang" entries never
  // merge across a gap. Everything else (incl. every singleton) renders as
  // one line via \resumeSubheadingOneLine{title}{company}{dates}. Location
  // is dropped from entry headers entirely (still present on
  // content.experience/internships, just unused by this renderer).
  const renderEntriesV3 = (entries) => {
    const oneLineCmd = isCompact ? '\\resumeSubheadingOneLineCompact' : '\\resumeSubheadingOneLine';
    const companyCmd = isCompact ? '\\resumeCompanyHeadingCompact' : '\\resumeCompanyHeading';
    const subSubCmd = isCompact ? '\\resumeSubSubheadingCompact' : '\\resumeSubSubheading';
    const list = entries || [];
    const out = [];
    let i = 0;
    while (i < list.length) {
      const e = list[i];
      const key = companyKeyOf(e.company);
      let j = i + 1;
      while (j < list.length && key && companyKeyOf(list[j].company) === key) j++;
      const run = list.slice(i, j);
      if (run.length >= 2) {
        out.push(companyCmd + '{' + escapeLatexTextV2(e.company) + '}');
        for (const pos of run) {
          out.push(subSubCmd + '{' + escapeLatexTextV2(pos.title) + '}{' + escapeLatexTextV2((pos.startDate || '') + ' -- ' + (pos.endDate || '')) + '}\n' + itemStart + '\n' + bulletRenderV2(pos.bullets, isCompact) + '\n' + itemEnd);
        }
      } else {
        out.push(oneLineCmd + '{' + escapeLatexTextV2(e.title) + '}{' + escapeLatexTextV2(e.company) + '}{' + escapeLatexTextV2((e.startDate || '') + ' -- ' + (e.endDate || '')) + '}\n' + itemStart + '\n' + bulletRenderV2(e.bullets, isCompact) + '\n' + itemEnd);
      }
      i = j;
    }
    return out.join('\n');
  };
  slots.experience = renderEntriesV3(content.experience || []);
  slots.internships = renderEntriesV3(content.internships || []);
  slots.projects = (content.projects || []).map((p) =>
    '\\resumeProjectHeading{\\textbf{' + escapeLatexTextV2(p.name) + '} $|$ \\emph{' + escapeLatexTextV2(capTechStackV2(p.name, p.techStack)) + '}}{' + escapeLatexTextV2(p.date) + '}\n' + itemStart + '\n' + bulletRenderV2(p.bullets, isCompact) + '\n' + itemEnd
  ).join('\n');
  slots.skills = (content.skills || []).map((cat) => (cat.skills && cat.skills.length) ? '\\textbf{' + escapeLatexTextV2(cat.category) + ':} ' + escapeLatexTextV2(cat.skills.join(', ')) + ' \\\\' : '').filter(Boolean).join('\n');
  slots.education = (content.education || []).slice(0, isCompact ? 1 : 2).map((edu) =>
    subheadingCmd + '{' + escapeLatexTextV2([edu.degree, edu.major].filter(Boolean).join(' -- ')) + '}{' + escapeLatexTextV2(edu.graduationDate) + '}{' + escapeLatexTextV2(edu.institution) + '}{' + escapeLatexTextV2(edu.gpa ? 'GPA: ' + edu.gpa : '') + '}'
  ).join('\n');
  slots.certifications = (content.certifications || []).filter((c) => c.qualityTier !== 'completion_only').map((c) =>
    '\\resumeProjectHeading{\\textbf{' + escapeLatexTextV2(c.name) + '} $|$ \\emph{' + escapeLatexTextV2(c.issuer) + '}}{' + escapeLatexTextV2(c.date) + '}'
  ).join('\n');
  slots.achievements = (function () {
    // s76: compact grouped achievements -- one \resumeItem per CATEGORY,
    // pipe-separated, links stripped, line-budgeted against the tier plan.
    const stripLinks = (s) => String(s || '').replace(/\s*\|?\s*(?:https?:\/\/)?(?:www\.)?github\.com\/\S*/gi, '').trim().replace(/[|\s]+$/, '');
    const catOf = (s) => /\b(?:\d+(?:st|nd|rd|th)\s+place|winner|prize|champion)\b/i.test(s) ? 'Hackathon Wins'
      : /\b(?:meetup|conference|talk|presentation|speaker|keynote|demo(?:ed)?)\b/i.test(s) || /llm day/i.test(s) ? 'Speaking'
      : 'Highlights';
    const groups = { 'Hackathon Wins': [], 'Speaking': [], 'Highlights': [] };
    for (const a of (content.achievements || [])) {
      const txt = stripLinks(firstNonEmpty(a.description, a.title));
      if (txt) groups[catOf(txt)].push(txt);
    }
    const lineBudget = ((content._budget || {}).achievementsLines) || 3;
    const CHARS_PER_LINE = 105;
    const est = (cat, items) => Math.ceil((cat.length + 2 + items.join(' | ').length) / CHARS_PER_LINE);
    // Balanced allocation: every non-empty category keeps >=1 line so a big
    // wins list can never evict Speaking entirely; remainder lines go to the
    // earliest category (wins first).
    const order = ['Hackathon Wins', 'Speaking', 'Highlights'].filter((c) => groups[c].length);
    const per = Math.max(1, Math.floor(lineBudget / Math.max(1, order.length)));
    let extra = Math.max(0, lineBudget - per * order.length);
    const rows = [];
    for (const cat of order) {
      let myBudget = per + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      const items = groups[cat].slice();
      while (items.length > 1 && est(cat, items) > myBudget) items.pop();
      rows.push(itemCmd + '{\\textbf{' + escapeLatexTextV2(cat) + ':} ' + items.map((t) => escapeLatexTextV2(t)).join(' $|$ ') + '}');
    }
    return rows.join('\n');
  })();
  slots.activities = (content.activities || []).map((act) =>
    '\\resumeProjectHeading{\\textbf{' + escapeLatexTextV2(act.name) + '} $|$ \\emph{' + escapeLatexTextV2(act.organization) + '}}{' + escapeLatexTextV2(act.date) + '}\n' + itemStart + '\n    ' + itemCmd + '{' + escapeLatexTextV2(act.description) + '}\n' + itemEnd
  ).join('\n');

  const order = (Array.isArray(content.sectionOrder) && content.sectionOrder.length) ? content.sectionOrder : ['experience', 'projects', 'skills', 'education'];
  const contentSections = order.map((section) => {
    const tpl = SECTION_LATEX[section];
    if (!tpl) return '';
    const s = slots[section];
    if (!s) return '';
    return tpl.split(SLOT_MARKER[section]).join(s);
  }).filter(Boolean).join('\n\n');

  const headerLatex = buildHeaderFromPersonal(personal);
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
  const survivor = out.match(/\{\{(PAPER|TITLE:[a-z_]+)\}\}/);
  if (survivor) throw new Error('applyLocaleLatex: unsubstituted locale token survived: ' + survivor[0]);
  return out;
}
// s141: per-node glue for locale profile source -- kept OUTSIDE the tracked
// blocks above so buildHeaderFromPersonal's own signature never changes (a
// drift anchor). Assigned in the Main section below, before any render
// call, so buildHeaderFromPersonal's closure sees the real value.
let __localeProfile = null;
let __jobCountryCode = null;

// ─── Main (WS4: dual-shape -- plain-text Pass2 content, or legacy LaTeX fragments) ───
const data = $input.first().json || {};
const pass1 = parseJSON(data.pass1 || {});
const pass2 = parseJSON(data.pass2 || {});
const ctx = $('Prepare Apply Context').first().json || {};
const personal = ctx.personal || {};
__localeProfile = ctx.locale_profile || null;
__jobCountryCode = (ctx.locale && ctx.locale.code) || null;

// Fragment-shaped pass2 (old prompt, or a stale/replayed execution) still renders
// via the original LaTeX-slot path below; plain-text/empty pass2 uses the new
// merge+render path. Detection is on the presence of any of the old string-valued
// LaTeX slots -- real plain-text Pass2 output never sets these.
const isFragments = !!(pass2 && (
  (typeof pass2.experience_entries === 'string' && pass2.experience_entries) ||
  (typeof pass2.skills_content === 'string' && pass2.skills_content) ||
  (typeof pass2.header === 'string' && pass2.header)
));

let latex, resumePlainTextOut, content = null;

if (isFragments) {
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
    return tpl.split(SLOT_MARKER[section]).join(sanitizeLatexContent(slotContent));
  }).filter(Boolean).join('\n\n');

  const headerLatex = buildHeaderFromPersonal(personal);

  const finalLatex = SKELETON
    .split('%%% SLOT: header').join(headerLatex)
    .split('%%% CONTENT_SECTIONS').join(contentSections);

  let normalized = normalizeLatexForPdflatex(finalLatex).split('\\$|\\$').join('$|$');
  normalized = normalized.split('\\$\\vcenter{\\hbox{\\tiny\\$\\bullet\\$}}\\$').join('$\\vcenter{\\hbox{\\tiny$\\bullet$}}$');
  normalized = normalized.split('\\$\\rightarrow\\$').join('->').split('\\rightarrow').join('->').split('→').join('->');

  if (contentSections.trim().length === 0) {
    throw new Error('Assemble Resume LaTeX produced an empty body (fragment path, sections=' + sectionOrder.join(',') + '). Refusing to compile a blank resume.');
  }
  latex = normalized;
  resumePlainTextOut = pass2.resumePlainText || derivePlainText(pass1);
} else {
  content = mergeContent(pass1, pass2);
  if (!hasAnyContent(content)) {
    throw new Error('Assemble Resume LaTeX produced an empty body (content path). Refusing to compile a blank resume.');
  }
  const isCompact = ((($getWorkflowStaticData('global').user_prefs) || {}).template) === 'compact';
  latex = renderResume(content, personal, isCompact);
  resumePlainTextOut = pass2.resumePlainText || derivePlainTextFromContent(content) || derivePlainText(pass1);
}
latex = applyLocaleLatex(latex, __localeProfile);

// belt-and-suspenders: also guard on the actually-rendered document body (both paths)
const body = (latex.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/) || [])[1] || '';
const bodyClean = body.replace(/%.*$/gm, '').replace(/\\(begin|end)\{center\}/g, '').trim();
if (!bodyClean) {
  throw new Error('Assemble Resume LaTeX produced an empty rendered body. Refusing to compile a blank resume.');
}

return [{
  json: {
    latex,
    content,
    chat_id: ctx.chat_id,
    job_title: ctx.job_title,
    company: ctx.company,
    resumePlainText: resumePlainTextOut,
  },
}];
