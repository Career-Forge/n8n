// Auto-generated from the live workflow node "Build Revised LaTeX" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Build Revised LaTeX -- WS4 rewrite (SKELETON/SECTION_LATEX/SLOT_MARKER copied verbatim from Assemble Resume LaTeX)
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
\usepackage{graphicx}
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


function firstNonEmpty(...values) {
  return values.find((v) => String(v == null ? '' : v).trim().length > 0) ?? '';
}
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
  const __headerLatexBase = '\\begin{center}\n  {\\fontsize{18}{18}\\selectfont \\textbf{' + name + '}} \\\\ \\vspace{4pt}\n  ' + contact + __piiLine + __workAuthLine + '\n\\end{center}\\vspace{-6pt}' + __signatureBlock;
    const __photoPath = '/data/user-data/profile_photo.jpg';
    let __headerLatex = __headerLatexBase;
    if (localeGateAllows(__locFields, 'photo') && p.photo && require('fs').existsSync(__photoPath)) {
      __headerLatex = "\\noindent\\begin{minipage}[c]{0.78\\textwidth}\n" + __headerLatexBase + "\n\\end{minipage}\\hfill\\begin{minipage}[c]{0.18\\textwidth}\\includegraphics[height=2.5cm]{" + __photoPath + "}\\end{minipage}";
    }
    return __headerLatex;
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

// ─── Main -- WS4 rewrite. Renders the ReviseForge-edited content JSON (same
// schema Assemble Resume LaTeX/Regen produce) via the identical renderResume --
// no separate skeleton-marker mechanism, no dependency on ctx.last_apply.resume_skeleton.
// The old node consumed the dead ResumeForge {sections:[]} schema and had an
// unreachable cover branch (revise_type was never set anywhere) -- both dropped;
// cover-revise is a separate future feature. ───
const ctx = $('Load Revise Context').first().json || {};
const revised = $input.first().json.output || {};
// s57: ReviseForge's schema doesn't carry _budget through -- backfill it from
// the prior persisted state so the tier soft cap survives revise round-trips.
const _priorBudget = (ctx.last_apply && ctx.last_apply.resume_json && ctx.last_apply.resume_json._budget) || null;
if (_priorBudget && !revised._budget) revised._budget = _priorBudget;
const personal = (ctx.last_apply && ctx.last_apply.personal) || {};
__localeProfile = (ctx.last_apply && ctx.last_apply.locale_profile) || null;
__jobCountryCode = (ctx.last_apply && ctx.last_apply.locale && ctx.last_apply.locale.code) || null;

if (!revised || !Array.isArray(revised.experience)) {
  return [{ json: { chat_id: ctx.chat_id, error: "That revision came back in an unexpected shape -- nothing was changed. Try rephrasing, or apply again to refresh." } }];
}

// v7 s46: soft per-entry cap from the stored budget (fallback 4 = old cap).
// Deliberately NOT a hard line-budget -- that would fight explicit user
// revision intent; ReviseForge's prompt guard handles count growth.
const _revCap = (revised._budget && revised._budget.maxBulletsPerEntry) || 4;
for (const _sec of ['experience', 'internships', 'projects']) {
  for (const _e of (Array.isArray(revised[_sec]) ? revised[_sec] : [])) {
    if (_e && Array.isArray(_e.bullets) && _e.bullets.length > _revCap) _e.bullets = _e.bullets.slice(0, _revCap);
  }
}
const isCompact = ((($getWorkflowStaticData('global').user_prefs) || {}).template) === 'compact';
const latex = applyLocaleLatex(renderResume(revised, personal, isCompact), __localeProfile);
const body = (latex.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/) || [])[1] || '';
const bodyClean = body.replace(/%.*$/gm, '').replace(/\\(begin|end)\{center\}/g, '').trim();
if (!bodyClean) {
  return [{ json: { chat_id: ctx.chat_id, error: 'The revised resume came back empty -- nothing was changed.' } }];
}

return [{ json: {
  latex,
  chat_id: ctx.chat_id,
  job_title: (ctx.last_apply && ctx.last_apply.job_title) || '',
  company: (ctx.last_apply && ctx.last_apply.company) || '',
  revise_type: 'resume',
  changes_summary: revised.changes_summary || '',
} }];
