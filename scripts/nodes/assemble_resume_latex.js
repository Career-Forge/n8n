// ═══════════════════════════════════════════════════════════════
// Assemble Resume LaTeX — S10 (deterministic-only rewrite)
// ═══════════════════════════════════════════════════════════════
// DECISION (S10): the LLM (Pass-2) emits structured TEXT ONLY — never LaTeX.
// This node builds 100% of the LaTeX deterministically from Pass-1's structure
// (the source of truth for WHICH entities + their titles/dates/company/skills)
// with Pass-2's REFINED bullet/summary text slotted in by entity id (Pass-1
// stamps a unique `id` on every position/internship/project/achievement).
// Every piece of human/LLM text passes through escapeLatexText, so a stray `$`,
// `%`, `&`, `\`, etc. is impossible — this permanently kills the math-leak and
// malformed-LaTeX bug classes that the old "emit-LaTeX + blanket-$-escape" path
// produced ($$•$$ bullets, $\to \$pgvectorRAG\$, right-margin overflow).
//
// Pass-2 output contract (all plain text, no LaTeX, no $, no backslashes):
//   { summary, bullets: { "<entity id>": ["bullet text", ...] },
//     achievements: { "<achievement id>": "one-line text" },
//     improvements: [...], resumePlainText }
// Inline emphasis: **bold** is the ONLY markup allowed; converted AFTER escaping.
//
// In:  $input.first().json = { pass1, pass2 }   (pass2 optional; verbatim fallback)
//      $('Prepare Apply Context').first().json = { personal, chat_id, job_title, company, ... }
// Out: [{ json: { latex, chat_id, job_title, company, resumePlainText } }]
// Same node serves "Assemble Resume LaTeX" and "Assemble Regen" (reads $input,
// not a hardcoded source node).

// ─── Skeleton (bot preamble + macros; \resumeProjectHeading wraps via tabularx) ──
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
    \begin{tabularx}{0.97\textwidth}{@{}>{\small\raggedright\arraybackslash}X r@{}}
      #1 & #2 \\
    \end{tabularx}\vspace{-5pt}
}
\newcommand{\resumeSubItem}[1]{\resumeItem{#1}\vspace{-4pt}}
\renewcommand\labelitemi{\textbullet}
\renewcommand\labelitemii{\textbullet}
\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0.15in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}{\begin{itemize}[noitemsep, topsep=0pt, parsep=0pt, partopsep=0pt]}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{-4pt}}

\begin{document}

%%% SLOT: header

%%% CONTENT_SECTIONS

\end{document}`;

// ─── Section wrappers (command-center 124-173; bot-compatible macros) ───
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

// ─── Text → safe LaTeX ───
// 1) cleanText: unicode → ascii BEFORE escaping (smart quotes, dashes, symbols).
function cleanText(value) {
  let s = String(value == null ? '' : value);
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
       .replace(/…/g, '...').replace(/[–—]/g, '--').replace(/ /g, ' ');
  s = s.replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ');
  s = s.replace(/[^\x09\x0A\x20-\x7E]/g, ''); // drop any remaining non-ascii
  return s;
}
// 2) escapeLatexText: neutralize every LaTeX-special char. After this the text
//    cannot break compilation — a literal $, %, &, \, etc. is fully escaped.
function escapeLatexText(value) {
  return cleanText(value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}
// 3) esc + the ONE allowed markup: **bold** → \textbf{...} (applied post-escape,
//    so the bold content is already safe; group ref $1 is intentional, not data).
function rich(value) {
  let s = escapeLatexText(value);
  s = s.replace(/\*\*([^*]+?)\*\*/g, '\\textbf{$1}');
  s = s.replace(/\*\*/g, ''); // drop any unpaired ** markers
  return s;
}

function firstNonEmpty(...values) {
  return values.find((v) => String(v == null ? '' : v).trim().length > 0) ?? '';
}

function nonEmptyArr(a) {
  return Array.isArray(a) && a.filter((x) => String(x == null ? '' : x).trim().length).length > 0;
}

// Refined bullets for an entity id, else the Pass-1 verbatim fallback.
function refinedBullets(pass2, id, fallbackArr) {
  const m = pass2 && pass2.bullets && id != null ? pass2.bullets[id] : null;
  if (nonEmptyArr(m)) return m;
  return Array.isArray(fallbackArr) ? fallbackArr : [];
}

function bulletList(items, cap) {
  return (items || [])
    .filter((x) => String(x == null ? '' : x).trim().length)
    .slice(0, cap || 5)
    .map((item) => '    \\resumeItem{' + rich(item) + '}')
    .join('\n');
}

const subheading = (title, date, company, loc) =>
  '\\resumeSubheading{' + escapeLatexText(title) + '}{' + escapeLatexText(date) + '}{' + escapeLatexText(company) + '}{' + escapeLatexText(loc) + '}';
const subsub = (title, date) =>
  '\\resumeSubSubheading{' + escapeLatexText(title) + '}{' + escapeLatexText(date) + '}';
const itemStart = '\\resumeItemListStart';
const itemEnd = '\\resumeItemListEnd';

function dateRange(start, end) {
  return [start, end].map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join(' -- ');
}

// Deterministic header from the parsed master resume (NOT the LLM).
function buildHeaderFromPersonal(p) {
  p = p || {};
  const name = escapeLatexText(firstNonEmpty(p.name, 'Candidate'));
  const parts = [];
  const phone = firstNonEmpty(p.phone_display, p.phone);
  if (phone) parts.push(escapeLatexText(phone));
  if (p.email) parts.push('\\href{mailto:' + p.email + '}{\\underline{' + escapeLatexText(p.email) + '}}');
  if (p.linkedin) parts.push('\\href{' + p.linkedin + '}{\\underline{LinkedIn}}');
  if (p.github) parts.push('\\href{' + p.github + '}{\\underline{GitHub}}');
  if (p.portfolio) parts.push('\\href{' + p.portfolio + '}{\\underline{Portfolio}}');
  if (p.show_location && p.location) parts.push(escapeLatexText(p.location));
  // $|$ separators are SKELETON-owned LaTeX (never escaped) — safe now that no
  // blanket $-escape runs over the document.
  const contact = parts.length ? '\\small ' + parts.join(' $|$ ') : '';
  return '\\begin{center}\n  \\textbf{\\Huge \\scshape ' + name + '} \\\\ \\vspace{4pt}\n  ' + contact + '\n\\end{center}';
}

// ─── Section builders (Pass-1 structure + Pass-2 refined text) ───
function buildExperience(pass1, pass2) {
  return (pass1.companies || []).map((company) => {
    const selected = (company.positions || []).filter((pos) => pos.isSelected !== false);
    if (!selected.length) return '';
    const blocks = [];
    if (company.renderAsStacked && selected.length > 1) {
      const starts = selected.map((p) => p.startDate).filter(Boolean);
      const ends = selected.map((p) => p.endDate).filter(Boolean);
      const range = dateRange(starts[starts.length - 1], ends[0]);
      blocks.push(subheading(company.company, range, '', selected[0].location));
      for (const pos of selected) {
        const bullets = bulletList(refinedBullets(pass2, pos.id, pos.keyAchievements));
        blocks.push(subsub(pos.title, dateRange(pos.startDate, pos.endDate)));
        if (bullets) blocks.push(itemStart + '\n' + bullets + '\n' + itemEnd);
      }
    } else {
      for (const pos of selected) {
        const bullets = bulletList(refinedBullets(pass2, pos.id, pos.keyAchievements));
        if (!bullets) continue;
        blocks.push(subheading(pos.title, dateRange(pos.startDate, pos.endDate), company.company, pos.location)
          + '\n' + itemStart + '\n' + bullets + '\n' + itemEnd);
      }
    }
    return blocks.join('\n');
  }).filter(Boolean).join('\n');
}

function buildInternships(pass1, pass2) {
  return (pass1.selectedInternships || []).map((intern) => {
    const bullets = bulletList(refinedBullets(pass2, intern.id, intern.keyAchievements));
    if (!bullets) return '';
    return subheading(intern.title, dateRange(intern.startDate, intern.endDate), intern.company, intern.location)
      + '\n' + itemStart + '\n' + bullets + '\n' + itemEnd;
  }).filter(Boolean).join('\n');
}

function buildProjects(pass1, pass2) {
  return (pass1.selectedProjects || []).map((project) => {
    const bullets = bulletList(refinedBullets(pass2, project.id, project.descriptionPoints));
    if (!bullets) return '';
    return '\\resumeProjectHeading{\\textbf{' + escapeLatexText(project.name) + '} $|$ \\emph{' + escapeLatexText(project.techStack) + '}}{' + escapeLatexText(project.date) + '}'
      + '\n' + itemStart + '\n' + bullets + '\n' + itemEnd;
  }).filter(Boolean).join('\n');
}

function buildSkills(pass1) {
  return (pass1.skillsCategories || []).map((cat) => {
    const skills = Array.isArray(cat.skills) ? cat.skills.join(', ') : '';
    return skills ? '\\textbf{' + escapeLatexText(cat.category) + ':} ' + escapeLatexText(skills) + ' \\\\' : '';
  }).filter(Boolean).join('\n');
}

function buildEducation(pass1) {
  return (pass1.education || []).slice(0, 3).map((edu) =>
    subheading([edu.degree, edu.major].filter(Boolean).join(' -- '), edu.graduationDate, edu.institution, edu.gpa ? 'GPA: ' + edu.gpa : '')
  ).join('\n');
}

function buildCertifications(pass1) {
  return (pass1.certifications || []).filter((c) => c.qualityTier !== 'completion_only').map((cert) =>
    '\\resumeProjectHeading{\\textbf{' + escapeLatexText(cert.name) + '} $|$ \\emph{' + escapeLatexText(cert.issuer) + '}}{' + escapeLatexText(cert.date) + '}'
  ).join('\n');
}

function buildAchievements(pass1, pass2) {
  return (pass1.selectedAchievements || []).map((a) => {
    const refined = pass2 && pass2.achievements && a.id != null ? pass2.achievements[a.id] : null;
    const text = firstNonEmpty(refined, a.description, a.title);
    return text ? '\\resumeItem{' + rich(text) + '}' : '';
  }).filter(Boolean).join('\n');
}

function buildActivities(pass1) {
  return (pass1.activities || []).map((act) => {
    const head = '\\resumeProjectHeading{\\textbf{' + escapeLatexText(act.name) + '} $|$ \\emph{' + escapeLatexText(act.organization) + '}}{' + escapeLatexText(act.date) + '}';
    const desc = String(act.description || '').trim();
    return desc ? head + '\n' + itemStart + '\n    \\resumeItem{' + rich(desc) + '}\n' + itemEnd : head;
  }).join('\n');
}

function derivePlainText(pass1, pass2) {
  const L = [];
  const bl = (id, fb) => refinedBullets(pass2, id, fb);
  for (const comp of (pass1.companies || [])) {
    for (const pos of (comp.positions || [])) {
      if (pos.isSelected === false) continue;
      L.push((pos.title || '') + ' at ' + (comp.company || '') + ' (' + dateRange(pos.startDate, pos.endDate) + ')');
      for (const a of bl(pos.id, pos.keyAchievements)) L.push('- ' + a);
      L.push('');
    }
  }
  for (const intern of (pass1.selectedInternships || [])) {
    L.push((intern.title || '') + ' at ' + (intern.company || ''));
    for (const a of bl(intern.id, intern.keyAchievements)) L.push('- ' + a);
    L.push('');
  }
  for (const proj of (pass1.selectedProjects || [])) {
    L.push('Project: ' + (proj.name || '') + ' | ' + (proj.techStack || ''));
    for (const d of bl(proj.id, proj.descriptionPoints)) L.push('- ' + d);
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

// Defensive parseJSON (handles a raw string slipping through). index.ts 319-378.
function parseJSON(content) {
  if (content && typeof content === 'object') return content;
  let cleaned = String(content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    let extracted = cleaned.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(extracted); } catch (e) {}
    let fixed = ''; let inString = false; let escapec = false;
    for (let i = 0; i < extracted.length; i++) {
      const ch = extracted[i];
      if (escapec) { fixed += ch; escapec = false; continue; }
      if (ch === '\\' && inString) { fixed += ch; escapec = true; continue; }
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

// ─── Main ───
const data = $input.first().json || {};
const pass1 = parseJSON(data.pass1 || {});
const pass2 = parseJSON(data.pass2 || {});
const ctx = $('Prepare Apply Context').first().json || {};
const personal = ctx.personal || {};

const sectionOrder = (Array.isArray(pass1.sectionOrder) && pass1.sectionOrder.length)
  ? pass1.sectionOrder
  : ['experience', 'projects', 'skills', 'education'];

const slotMap = {
  summary: rich(firstNonEmpty(pass2.summary, pass1.summary)),
  experience: buildExperience(pass1, pass2),
  internships: buildInternships(pass1, pass2),
  projects: buildProjects(pass1, pass2),
  skills: buildSkills(pass1),
  education: buildEducation(pass1),
  certifications: buildCertifications(pass1),
  achievements: buildAchievements(pass1, pass2),
  activities: buildActivities(pass1),
};

const contentSections = sectionOrder.map((section) => {
  const tpl = SECTION_LATEX[section];
  if (!tpl) return '';
  const slotContent = slotMap[section];
  if (!slotContent || !String(slotContent).trim()) return '';
  // split/join (content is already safe LaTeX; split/join avoids the $-in-replace footgun)
  return tpl.split(SLOT_MARKER[section]).join(slotContent);
}).filter(Boolean).join('\n\n');

const headerLatex = buildHeaderFromPersonal(personal);

let finalLatex = SKELETON
  .split('%%% SLOT: header').join(headerLatex)
  .split('%%% CONTENT_SECTIONS').join(contentSections);

// final defensive ascii-only pass (does NOT touch $ or \ — content is pre-escaped,
// skeleton is hand-written ascii; this only strips any stray unicode)
finalLatex = finalLatex.replace(/\r\n/g, '\n').replace(/[^\x09\x0A\x20-\x7E]/g, '');

// never ship a blank resume
const body = (finalLatex.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/) || [])[1] || '';
const bodyClean = body.replace(/%.*$/gm, '').replace(/\\(begin|end)\{center\}/g, '').trim();
if (!bodyClean || contentSections.trim().length === 0) {
  throw new Error('Assemble Resume LaTeX produced an empty body (sections=' + sectionOrder.join(',') + '). Refusing to compile a blank resume.');
}

return [{
  json: {
    latex: finalLatex,
    chat_id: ctx.chat_id,
    job_title: ctx.job_title,
    company: ctx.company,
    resumePlainText: firstNonEmpty(pass2.resumePlainText, derivePlainText(pass1, pass2)),
  },
}];
