/**
 * s135_render_redesign.js -- RESUME FORMAT v2 render redesign.
 *
 * Implements the approved plan section "RESUME FORMAT v2" end to end:
 *   1. buildHeaderFromPersonal -- centered header, name at 18pt (no \scshape),
 *      9pt contact line joined by literal ' ~$|$~ ', full visible URLs (no
 *      short "LinkedIn"/"GitHub" labels, no \underline), phone plain text,
 *      email as \href{mailto:...}{visible address}, trailing \vspace{-6pt}.
 *   2. Single-line experience/internship headers -- new \resumeSubheadingOneLine
 *      [3]{title}{company}{dates} (+ compact variant) replaces the 4-arg
 *      \resumeSubheading for these two sections only. \resumeSubheading itself
 *      is left untouched -- education's 4-arg call and the legacy
 *      buildFallbackSlots fragment path both still need it as-is.
 *   3. Stacked multi-position companies -- >=2 CONSECUTIVE (adjacent-by-
 *      construction) same-company entries (case-insensitive, non-alphanumeric-
 *      stripped match) collapse to one \resumeCompanyHeading[1]{Company}
 *      (+ compact) followed by one \resumeSubSubheading[2]{title}{dates}
 *      (+ new compact variant) per position. Non-adjacent "boomerang" same-
 *      company entries never merge across a gap. No derived total date range
 *      is ever computed -- per-position dates already carry the truth.
 *   4. Project header untouched (techStack curation is a later, prompt-side
 *      script).
 *   5. escapeLatexTextV2's blunt /[--]/g -> '--' dash rule becomes 3 ordered
 *      rules (spaced dash -> ' -- ' FIRST, unspaced em dash -> ' -- ', unspaced
 *      en dash -> '-') so date ranges like "2019-2022" keep a bare hyphen
 *      instead of exploding into " -- ". Build Cover LaTeX's own independent
 *      dash rule (inside its normalizeLatexForPdflatex) gets the identical
 *      3-rule mirror so cover-letter prose matches.
 *   6. truncateBullet: sentence-boundary check before the clause scan (mirrors
 *      truncateSummary), clause-scan floor 0.55 -> 0.45, and a bounded
 *      (max 3 passes) trailing-fragment stripper that also eats a dangling
 *      numeric/unit token -- fixes the live Bayer "...121+ behavior..." bug
 *      (see the HARNESS fixture below for the exact reproduction/fix pair).
 *   7. Cover-letter header parity -- Load Skeletons' cover_skeleton collapses
 *      PHONE/EMAIL/LINKEDIN to one {{CONTACT_LINE}} placeholder; Build Cover
 *      LaTeX builds that placeholder the same way as buildHeaderFromPersonal's
 *      contact line, phone/email/linkedin only (no github/portfolio -- not in
 *      the cover letter's locked scope).
 *
 * Applied identically (byte-for-byte) to all 3 LaTeX nodes that share these
 * 11 export_prompts.js-tracked blocks: Assemble Resume LaTeX, Assemble Regen,
 * Build Revised LaTeX. Assemble Resume LaTeX and Assemble Regen must stay
 * byte-identical whole nodes after patching (asserted below).
 *
 * PROBE-CONFIRMED 2026-07-21 (scripts/_s135_calibrate.js --live, real pdflatex
 * via the latex-service container, 11/11 fixtures pass at these values -- see
 * that file's SUMMARY output): the \vspace between name and contact line, and
 * the -7pt compact-vspace values on the 3 brand-new compact macros. Both copy
 * the existing normal/-5pt vs compact/-7pt convention already used elsewhere
 * in this same SKELETON -- probes confirm that convention holds unchanged at
 * every tested tier/shape/stacking combination (incl. a stacked-company run
 * and a deliberately over-stuffed overflow probe that correctly renders 2
 * pages, proving the budget is genuinely binding, not vacuously satisfied).
 *
 * Scope discipline: does NOT touch Assemble Resume LaTeX's own legacy
 * normalizeLatexForPdflatex (isFragments path only, not one of the 11
 * anchor-tracked shared blocks, and not named in the locked decisions).
 * Does NOT touch buildFallbackSlots, mergeContent, or any content-JSON shape.
 * Does NOT run docker or git commands -- writes the patched workflow JSON to
 * disk only (a safe, reversible, git-trackable local file write).
 *
 * Run: node scripts/s135_render_redesign.js   (from the repo root)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];
const LATEX_NODES = ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX'];

// ═══════════════════════════════════════════════════════════════════════
// 1. SKELETON macro additions -- two anchored insertion points, mirroring
//    the file's own existing convention of "normal macro now, compact
//    analog later near the other compact macros".
// ═══════════════════════════════════════════════════════════════════════

// -- insertion point A: right after the existing (zero-caller) \resumeSubSubheading --
const MACRO_BLOCK_A_OLD = [
  '\\newcommand{\\resumeSubSubheading}[2]{',
  '    \\item',
  '    \\begin{tabular*}{0.97\\textwidth}{l@{\\extracolsep{\\fill}}r}',
  '      \\textit{\\small#1} & \\textit{\\small #2} \\\\',
  '    \\end{tabular*}\\vspace{-5pt}',
  '}',
  '\\newcommand{\\resumeProjectHeading}[2]{',
].join('\n');

const MACRO_BLOCK_A_NEW = [
  '\\newcommand{\\resumeSubSubheading}[2]{',
  '    \\item',
  '    \\begin{tabular*}{0.97\\textwidth}{l@{\\extracolsep{\\fill}}r}',
  '      \\textit{\\small#1} & \\textit{\\small #2} \\\\',
  '    \\end{tabular*}\\vspace{-5pt}',
  '}',
  '% s135 RESUME FORMAT v2: single-line entry header for a standalone',
  '% experience/internship position -- \\textbf{Title} $|$ Company (left),',
  '% dates (right). Distinct from \\resumeSubheading (left unchanged --',
  "% still used by education's 4-arg call and the legacy fragment fallback).",
  '\\newcommand{\\resumeSubheadingOneLine}[3]{',
  '  \\vspace{-1pt}\\item',
  '    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}',
  '      \\textbf{#1} $|$ #2 & \\textit{\\small #3} \\\\',
  '    \\end{tabular*}\\vspace{-5pt}',
  '}',
  '% s135: company header for a stacked multi-position run -- name ONLY, no',
  '% derived date range (per-position dates below, via \\resumeSubSubheading,',
  '% already carry the truth; a computed range would fabricate continuity',
  '% across any real gap).',
  '\\newcommand{\\resumeCompanyHeading}[1]{',
  '  \\vspace{-1pt}\\item',
  '    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}',
  '      \\textbf{#1} & \\\\',
  '    \\end{tabular*}\\vspace{-5pt}',
  '}',
  '\\newcommand{\\resumeProjectHeading}[2]{',
].join('\n');

// -- insertion point B: compact analogs, right after \resumeSubheadingCompact --
const MACRO_BLOCK_B_OLD = [
  '\\newcommand{\\resumeSubheadingCompact}[4]{',
  '  \\vspace{-1pt}\\item',
  '    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}',
  '      \\textbf{\\footnotesize #1} & \\footnotesize #2 \\\\',
  '      \\textit{\\footnotesize#3} & \\textit{\\footnotesize #4} \\\\',
  '    \\end{tabular*}\\vspace{-7pt}',
  '}',
  '\\newcommand{\\resumeItemListEndCompact}{\\end{itemize}\\vspace{-6pt}}',
].join('\n');

const MACRO_BLOCK_B_NEW = [
  '\\newcommand{\\resumeSubheadingCompact}[4]{',
  '  \\vspace{-1pt}\\item',
  '    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}',
  '      \\textbf{\\footnotesize #1} & \\footnotesize #2 \\\\',
  '      \\textit{\\footnotesize#3} & \\textit{\\footnotesize #4} \\\\',
  '    \\end{tabular*}\\vspace{-7pt}',
  '}',
  '% s135: probe-confirmed 2026-07-21 (compact-mid fixture, real pdflatex,',
  '% see _s135_calibrate.js) -- these 3 compact variants copy the existing',
  '% normal/-5pt vs compact/-7pt convention already used above; the compile',
  '% confirms it holds unchanged in compact mode too.',
  '\\newcommand{\\resumeSubheadingOneLineCompact}[3]{',
  '  \\vspace{-1pt}\\item',
  '    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}',
  '      \\textbf{\\footnotesize #1} $|$ \\footnotesize #2 & \\textit{\\footnotesize #3} \\\\',
  '    \\end{tabular*}\\vspace{-7pt}',
  '}',
  '\\newcommand{\\resumeCompanyHeadingCompact}[1]{',
  '  \\vspace{-1pt}\\item',
  '    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}',
  '      \\textbf{\\footnotesize #1} & \\\\',
  '    \\end{tabular*}\\vspace{-7pt}',
  '}',
  '\\newcommand{\\resumeSubSubheadingCompact}[2]{',
  '    \\item',
  '    \\begin{tabular*}{0.97\\textwidth}{l@{\\extracolsep{\\fill}}r}',
  '      \\textit{\\footnotesize#1} & \\textit{\\footnotesize #2} \\\\',
  '    \\end{tabular*}\\vspace{-7pt}',
  '}',
  '\\newcommand{\\resumeItemListEndCompact}{\\end{itemize}\\vspace{-6pt}}',
].join('\n');

// ═══════════════════════════════════════════════════════════════════════
// 2. buildHeaderFromPersonal (+ new visibleUrlTextV2 helper, placed BEFORE
//    the start anchor so it never shifts where export_prompts.js's own
//    "function buildHeaderFromPersonal(p) {" ... first-column-0-"}" scan
//    lands).
// ═══════════════════════════════════════════════════════════════════════
const HEADER_OLD = [
  'function normalizeUrl(u) {',
  "  u = String(u == null ? '' : u).trim();",
  "  if (!u) return '';",
  "  return /^https?:\\/\\//i.test(u) ? u : 'https://' + u;",
  '}',
  'function buildHeaderFromPersonal(p) {',
  '  p = p || {};',
  "  const name = escapeLatexTextV2(firstNonEmpty(p.name, 'Candidate'));",
  '  const parts = [];',
  '  const phone = firstNonEmpty(p.phone_display, p.phone);',
  '  if (phone) parts.push(escapeLatexTextV2(phone));',
  "  if (p.email) parts.push('\\\\href{mailto:' + p.email + '}{\\\\underline{' + p.email + '}}');",
  "  if (p.linkedin) parts.push('\\\\href{' + normalizeUrl(p.linkedin) + '}{\\\\underline{LinkedIn}}');",
  "  if (p.github) parts.push('\\\\href{' + normalizeUrl(p.github) + '}{\\\\underline{GitHub}}');",
  "  if (p.portfolio) parts.push('\\\\href{' + normalizeUrl(p.portfolio) + '}{\\\\underline{Portfolio}}');",
  '  if (p.show_location && p.location) parts.push(escapeLatexTextV2(p.location));',
  "  const contact = parts.length ? '\\\\small ' + parts.join(' $|$ ') : '';",
  "  return '\\\\begin{center}\\n  \\\\textbf{\\\\fontsize{20}{20}\\\\selectfont \\\\scshape ' + name + '} \\\\\\\\ \\\\vspace{4pt}\\n  ' + contact + '\\n\\\\end{center}';",
  '}',
].join('\n');

const HEADER_NEW = [
  'function normalizeUrl(u) {',
  "  u = String(u == null ? '' : u).trim();",
  "  if (!u) return '';",
  "  return /^https?:\\/\\//i.test(u) ? u : 'https://' + u;",
  '}',
  '// s135: visible link text -- normalizeUrl(u) with scheme, "www.", and a',
  '// trailing slash all stripped, then escaped. Never fed through',
  '// escapeLatexTextV2 for the href TARGET itself (only for what is shown).',
  'function visibleUrlTextV2(u) {',
  "  const v = normalizeUrl(u).replace(/^https?:\\/\\//i, '').replace(/^www\\./i, '').replace(/\\/+$/, '');",
  '  return escapeLatexTextV2(v);',
  '}',
  'function buildHeaderFromPersonal(p) {',
  '  p = p || {};',
  "  const name = escapeLatexTextV2(firstNonEmpty(p.name, 'Candidate'));",
  '  const parts = [];',
  '  const phone = firstNonEmpty(p.phone_display, p.phone);',
  '  if (phone) parts.push(escapeLatexTextV2(phone));',
  "  if (p.email) parts.push('\\\\href{mailto:' + p.email + '}{' + escapeLatexTextV2(p.email) + '}');",
  "  if (p.linkedin) parts.push('\\\\href{' + normalizeUrl(p.linkedin) + '}{' + visibleUrlTextV2(p.linkedin) + '}');",
  "  if (p.github) parts.push('\\\\href{' + normalizeUrl(p.github) + '}{' + visibleUrlTextV2(p.github) + '}');",
  "  if (p.portfolio) parts.push('\\\\href{' + normalizeUrl(p.portfolio) + '}{' + visibleUrlTextV2(p.portfolio) + '}');",
  '  if (p.show_location && p.location) parts.push(escapeLatexTextV2(p.location));',
  "  // s135 RESUME FORMAT v2: ' ~$|$~ ' is emitted here as literal CODE, never",
  '  // passed through escapeLatexTextV2 (which would mangle the tilde into',
  '  // \\textasciitilde{}).',
  "  const contact = parts.length ? '{\\\\fontsize{9}{9}\\\\selectfont ' + parts.join(' ~$|$~ ') + '}' : '';",
  '  // Probe-confirmed 2026-07-21 (contact-line-6-fields fixture, real',
  '  // pdflatex, see _s135_calibrate.js): 4pt between name and contact line',
  '  // holds cleanly against the new 18pt/9pt sizing, incl. all 6 contact',
  '  // fields present at once -- no overflow of the 0.97\\textwidth line.',
  "  return '\\\\begin{center}\\n  {\\\\fontsize{18}{18}\\\\selectfont \\\\textbf{' + name + '}} \\\\\\\\ \\\\vspace{4pt}\\n  ' + contact + '\\n\\\\end{center}\\\\vspace{-6pt}';",
  '}',
].join('\n');

// ═══════════════════════════════════════════════════════════════════════
// 3. escapeLatexTextV2 dash-rule: blunt /[--]/g -> spaced-dash / em-dash /
//    en-dash, 3 ordered rules (spaced FIRST, or the em-dash rule eats it).
// ═══════════════════════════════════════════════════════════════════════
const ESC_OLD = [
  '  s = s.replace(/[“”]/g, \'"\').replace(/[‘’]/g, "\'").replace(/…/g, \'...\')',
  "       .replace(/[–—]/g, '--').replace(/ /g, ' ')",
  "       .replace(/[→➔➡]/g, '->').replace(/•/g, '-')",
  "       .replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ');",
].join('\n');

const ESC_NEW = [
  '  s = s.replace(/[“”]/g, \'"\').replace(/[‘’]/g, "\'").replace(/…/g, \'...\')',
  '       // s135: spaced en/em dash FIRST (must run before the bare em-dash',
  '       // rule or it never matches), then unspaced em -> spaced double',
  "       // hyphen, then unspaced en -> bare hyphen (protects date ranges).",
  "       .replace(/\\s+[–—]\\s+/g, ' -- ').replace(/—/g, ' -- ').replace(/–/g, '-').replace(/ /g, ' ')",
  "       .replace(/[→➔➡]/g, '->').replace(/•/g, '-')",
  "       .replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ');",
].join('\n');

// ═══════════════════════════════════════════════════════════════════════
// 4. renderResume: experience/internships grouping (stacked-company runs +
//    single-line standalone entries). Education's subheadingCmd usage is
//    untouched.
// ═══════════════════════════════════════════════════════════════════════
const RENDER_OLD = [
  '  slots.experience = (content.experience || []).map((e) =>',
  "    subheadingCmd + '{' + escapeLatexTextV2(e.title) + '}{' + escapeLatexTextV2((e.startDate || '') + ' -- ' + (e.endDate || '')) + '}{' + escapeLatexTextV2(e.company) + '}{' + escapeLatexTextV2(e.location) + '}\\n' + itemStart + '\\n' + bulletRenderV2(e.bullets, isCompact) + '\\n' + itemEnd",
  "  ).join('\\n');",
  '  slots.internships = (content.internships || []).map((e) =>',
  "    subheadingCmd + '{' + escapeLatexTextV2(e.title) + '}{' + escapeLatexTextV2((e.startDate || '') + ' -- ' + (e.endDate || '')) + '}{' + escapeLatexTextV2(e.company) + '}{' + escapeLatexTextV2(e.location) + '}\\n' + itemStart + '\\n' + bulletRenderV2(e.bullets, isCompact) + '\\n' + itemEnd",
  "  ).join('\\n');",
].join('\n');

const RENDER_NEW = [
  "  const companyKeyOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');",
  '  // s135: >=2 CONSECUTIVE (adjacent-by-construction) entries sharing a',
  '  // company (case-insensitive, non-alphanumeric-stripped) render as one',
  '  // \\resumeCompanyHeading + a \\resumeSubSubheading per position (title/',
  '  // dates only -- no derived total date range, per-position dates already',
  '  // carry the truth). Non-adjacent same-company "boomerang" entries never',
  '  // merge across a gap. Everything else (incl. every singleton) renders as',
  '  // one line via \\resumeSubheadingOneLine{title}{company}{dates}. Location',
  '  // is dropped from entry headers entirely (still present on',
  '  // content.experience/internships, just unused by this renderer).',
  '  const renderEntriesV3 = (entries) => {',
  "    const oneLineCmd = isCompact ? '\\\\resumeSubheadingOneLineCompact' : '\\\\resumeSubheadingOneLine';",
  "    const companyCmd = isCompact ? '\\\\resumeCompanyHeadingCompact' : '\\\\resumeCompanyHeading';",
  "    const subSubCmd = isCompact ? '\\\\resumeSubSubheadingCompact' : '\\\\resumeSubSubheading';",
  '    const list = entries || [];',
  '    const out = [];',
  '    let i = 0;',
  '    while (i < list.length) {',
  '      const e = list[i];',
  '      const key = companyKeyOf(e.company);',
  '      let j = i + 1;',
  '      while (j < list.length && key && companyKeyOf(list[j].company) === key) j++;',
  '      const run = list.slice(i, j);',
  '      if (run.length >= 2) {',
  "        out.push(companyCmd + '{' + escapeLatexTextV2(e.company) + '}');",
  '        for (const pos of run) {',
  "          out.push(subSubCmd + '{' + escapeLatexTextV2(pos.title) + '}{' + escapeLatexTextV2((pos.startDate || '') + ' -- ' + (pos.endDate || '')) + '}\\n' + itemStart + '\\n' + bulletRenderV2(pos.bullets, isCompact) + '\\n' + itemEnd);",
  '        }',
  '      } else {',
  "        out.push(oneLineCmd + '{' + escapeLatexTextV2(e.title) + '}{' + escapeLatexTextV2(e.company) + '}{' + escapeLatexTextV2((e.startDate || '') + ' -- ' + (e.endDate || '')) + '}\\n' + itemStart + '\\n' + bulletRenderV2(e.bullets, isCompact) + '\\n' + itemEnd);",
  '      }',
  '      i = j;',
  '    }',
  "    return out.join('\\n');",
  '  };',
  '  slots.experience = renderEntriesV3(content.experience || []);',
  '  slots.internships = renderEntriesV3(content.internships || []);',
].join('\n');

// ═══════════════════════════════════════════════════════════════════════
// 5. truncateBullet: sentence-boundary check, floor 0.55 -> 0.45, bounded
//    (max 3 passes) trailing-fragment stripper w/ numeric-token + extended
//    word list. Signature (t, reserve) and SAFE_TOTAL=210 unchanged.
// ═══════════════════════════════════════════════════════════════════════
const TB_OLD = [
  'function truncateBullet(t, reserve) {',
  "  t = String(t == null ? '' : t).trim();",
  '  const SAFE_TOTAL = 210; // real-pdflatex-verified combined (keyword+body) 2-line ceiling',
  '  const MAX = Math.max(60, SAFE_TOTAL - (reserve || 0));',
  '  if (t.length <= MAX) return t;',
  '  const cut = t.slice(0, MAX);',
  "  const bal = (s) => { let d = 0; for (let k = 0; k < s.length; k++) { if (s[k] === '(') d++; else if (s[k] === ')') d--; } return d === 0; };",
  '  const floor = Math.floor(MAX * 0.55);',
  '  // Prefer a clean clause end (a balanced \')\' or a comma/semicolon OUTSIDE any',
  '  // parenthetical) -- reads as a complete thought, no ellipsis needed.',
  '  for (let i = cut.length - 1; i > floor; i--) {',
  '    const ch = cut[i];',
  "    if (ch === ')' && bal(cut.slice(0, i + 1))) return cut.slice(0, i + 1);",
  "    if ((ch === ',' || ch === ';') && bal(cut.slice(0, i))) {",
  "      return cut.slice(0, i).replace(/\\s+(and|or|with|for|to|of|by|in|on|at|via|across|the|a|an|using)$/i, '').replace(/[,;:.\\s]+$/, '');",
  '    }',
  '  }',
  "  const sp = cut.lastIndexOf(' ');",
  '  let base = cut.slice(0, sp > MAX - 30 ? sp : MAX);',
  "  if (!bal(base) && base.lastIndexOf('(') > 0) base = base.slice(0, base.lastIndexOf('('));",
  "  base = base.replace(/\\s+(and|or|with|for|to|of|by|in|on|at|via|across|the|a|an|using)$/i, '').replace(/[,;:.\\s]+$/, '');",
  "  return base + '...';",
  '}',
].join('\n');

const TB_NEW = [
  'function truncateBullet(t, reserve) {',
  "  t = String(t == null ? '' : t).trim();",
  '  const SAFE_TOTAL = 210; // real-pdflatex-verified combined (keyword+body) 2-line ceiling',
  '  const MAX = Math.max(60, SAFE_TOTAL - (reserve || 0));',
  '  if (t.length <= MAX) return t;',
  '  const cut = t.slice(0, MAX);',
  "  const bal = (s) => { let d = 0; for (let k = 0; k < s.length; k++) { if (s[k] === '(') d++; else if (s[k] === ')') d--; } return d === 0; };",
  '  // s135: sentence-boundary check FIRST, mirroring truncateSummary\'s own',
  '  // pattern -- a complete sentence beats any clause fragment, no ellipsis.',
  "  const period = cut.lastIndexOf('. ');",
  '  if (period > MAX * 0.5) return cut.slice(0, period + 1);',
  '  const floor = Math.floor(MAX * 0.45);',
  '  // s135: bounded (max 3 passes) trailing-fragment stripper -- eats a',
  '  // dangling function word OR a dangling numeric/unit token (e.g. "121+"),',
  '  // re-checking paren balance every pass so it never strips into an',
  '  // unbalanced state. Fixes the live Bayer bug: a bullet cut right after',
  '  // "...121+ behavior" used to render as "...121+ behavior..." (ellipsis',
  '  // mid-noun-phrase, dropping "metrics" and everything after it).',
  '  const stripTrailingFragment = (s) => {',
  '    const wordRe = /\\s+(and|or|with|for|to|of|by|in|on|at|via|across|per|from|into|over|within|the|a|an|using)$/i;',
  '    const numRe = /\\s+\\d[\\d,.]*[+%~]?x?$/i;',
  '    for (let pass = 0; pass < 3; pass++) {',
  "      let next = s.replace(wordRe, '').replace(numRe, '').replace(/[,;:.\\s]+$/, '');",
  '      if (next === s) break;',
  '      if (!bal(next)) break;',
  '      s = next;',
  '    }',
  '    return s;',
  '  };',
  '  // Prefer a clean clause end (a balanced \')\' or a comma/semicolon OUTSIDE any',
  '  // parenthetical) -- reads as a complete thought, no ellipsis needed.',
  '  for (let i = cut.length - 1; i > floor; i--) {',
  '    const ch = cut[i];',
  "    if (ch === ')' && bal(cut.slice(0, i + 1))) return cut.slice(0, i + 1);",
  "    if ((ch === ',' || ch === ';') && bal(cut.slice(0, i))) {",
  '      return stripTrailingFragment(cut.slice(0, i));',
  '    }',
  '  }',
  "  const sp = cut.lastIndexOf(' ');",
  '  let base = cut.slice(0, sp > MAX - 30 ? sp : MAX);',
  "  if (!bal(base) && base.lastIndexOf('(') > 0) base = base.slice(0, base.lastIndexOf('('));",
  '  base = stripTrailingFragment(base);',
  "  return base + '...';",
  '}',
].join('\n');

// ═══════════════════════════════════════════════════════════════════════
// 6. Build Cover LaTeX: PHONE/EMAIL/LINKEDIN chain -> single {{CONTACT_LINE}}.
// ═══════════════════════════════════════════════════════════════════════
const BC_OLD = "fullLatex = fullLatex.replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate')).replace('{{PHONE}}', escapeLatexText(personal.phone_display || personal.phone_primary || '')).replaceAll('{{EMAIL}}', personal.email || '').replace('{{LINKEDIN}}', normalizeUrlCoverV2(personal.linkedin || ''));";

// s135: Build Cover LaTeX has its OWN separate normalizeLatexForPdflatex
// (unrelated to escapeLatexTextV2's) with the same blunt-dash bug --
// –/— (en/em dash) both collapsed unconditionally to '--', which
// explodes an unspaced date range like "2019–2022" into "2019 -- 2022"
// in cover-letter prose. Mirror the identical 3-rule fix here (spaced dash
// FIRST, else the bare em-dash rule below eats it first). This node writes
// dashes as \u-escapes rather than literal glyphs, so the anchor/replacement
// follow that convention instead of escapeLatexTextV2's literal-character one.
const BC_DASH_OLD = ".replace(/[\\u2013\\u2014]/g, '--')";

const BC_DASH_NEW = [
  '',
  '       // s135: mirror of escapeLatexTextV2\'s 3-rule dash split -- spaced',
  '       // en/em dash FIRST (must run before the bare em-dash rule or it',
  '       // never matches), then unspaced em -> \' -- \', then unspaced en ->',
  "       // bare '-' (protects date ranges in cover-letter prose the same",
  '       // way the resume path is protected).',
  "       .replace(/\\s+[\\u2013\\u2014]\\s+/g, ' -- ').replace(/\\u2014/g, ' -- ').replace(/\\u2013/g, '-')",
].join('\n');

const BC_NEW = [
  '// s135: cover-letter header parity -- single {{CONTACT_LINE}} placeholder,',
  '// built the SAME way as the resume\'s buildHeaderFromPersonal contact line',
  '// (visible URL text, mailto with visible address, \' ~$|$~ \' joiner, 9pt),',
  '// but phone/email/linkedin ONLY -- github/portfolio are resume-only fields,',
  '// not part of the cover letter per the locked scope.',
  'function visibleUrlCoverV2(u) {',
  "  const v = normalizeUrlCoverV2(u).replace(/^https?:\\/\\//i, '').replace(/^www\\./i, '').replace(/\\/+$/, '');",
  '  return escapeLatexText(v);',
  '}',
  'const contactPartsV2 = [];',
  "const phoneV2 = personal.phone_display || personal.phone_primary || '';",
  'if (phoneV2) contactPartsV2.push(escapeLatexText(phoneV2));',
  "if (personal.email) contactPartsV2.push('\\\\href{mailto:' + personal.email + '}{' + escapeLatexText(personal.email) + '}');",
  "if (personal.linkedin) contactPartsV2.push('\\\\href{' + normalizeUrlCoverV2(personal.linkedin) + '}{' + visibleUrlCoverV2(personal.linkedin) + '}');",
  "const contactLineV2 = contactPartsV2.length ? '{\\\\fontsize{9}{9}\\\\selectfont ' + contactPartsV2.join(' ~$|$~ ') + '}' : '';",
  "fullLatex = fullLatex.replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate')).replace('{{CONTACT_LINE}}', contactLineV2);",
].join('\n');

// ═══════════════════════════════════════════════════════════════════════
// replaceOnce -- established idiom (grep scripts/applied/s43*.js / s51*.js):
// asserts the anchor appears EXACTLY once before replacing.
// ═══════════════════════════════════════════════════════════════════════
function replaceOnce(container, key, oldStr, newStr, label) {
  const count = container.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`INTEGRITY FAIL ${key}: anchor "${label}" found ${count} times, expected exactly 1`);
    process.exit(1);
  }
  return container.split(oldStr).join(newStr);
}

function patchLatexNode(code, nodeName) {
  code = replaceOnce(code, nodeName, MACRO_BLOCK_A_OLD, MACRO_BLOCK_A_NEW, 'SKELETON macro block A (resumeSubheadingOneLine + resumeCompanyHeading)');
  code = replaceOnce(code, nodeName, MACRO_BLOCK_B_OLD, MACRO_BLOCK_B_NEW, 'SKELETON macro block B (3 compact variants)');
  code = replaceOnce(code, nodeName, HEADER_OLD, HEADER_NEW, 'buildHeaderFromPersonal (RESUME FORMAT v2 header)');
  code = replaceOnce(code, nodeName, ESC_OLD, ESC_NEW, 'escapeLatexTextV2 dash rule (3-way split)');
  code = replaceOnce(code, nodeName, RENDER_OLD, RENDER_NEW, 'renderResume experience/internship grouping (renderEntriesV3)');
  code = replaceOnce(code, nodeName, TB_OLD, TB_NEW, 'truncateBullet sentence-boundary + bounded fragment stripper');
  return code;
}

// Load Skeletons: the cover_skeleton is LaTeX text encoded inside a JS string
// literal (double escaping), so the contact-line anchor is located
// programmatically off plain-ASCII placeholder tokens rather than hand-typed
// (avoids any backslash-count transcription error).
function patchLoadSkeletons(code) {
  const smallPhoneIdx = code.indexOf('small {{PHONE}}');
  if (smallPhoneIdx === -1) { console.error('INTEGRITY FAIL Load Skeletons: "small {{PHONE}}" marker not found'); process.exit(1); }
  let bsStart = smallPhoneIdx;
  while (bsStart > 0 && code[bsStart - 1] === '\\') bsStart--;
  const linkedinIdx = code.indexOf('LinkedIn}}', smallPhoneIdx);
  if (linkedinIdx === -1) { console.error('INTEGRITY FAIL Load Skeletons: "LinkedIn}}" marker not found'); process.exit(1); }
  const endIdx = linkedinIdx + 'LinkedIn}}'.length;
  const oldSegment = code.slice(bsStart, endIdx);
  return replaceOnce(code, 'Load Skeletons', oldSegment, '{{CONTACT_LINE}}', 'cover skeleton PHONE/EMAIL/LINKEDIN line -> {{CONTACT_LINE}}');
}

function patchBuildCoverLatex(code) {
  code = replaceOnce(code, 'Build Cover LaTeX', BC_OLD, BC_NEW, 'PHONE/EMAIL/LINKEDIN replace chain -> single CONTACT_LINE build');
  code = replaceOnce(code, 'Build Cover LaTeX', BC_DASH_OLD, BC_DASH_NEW, 'normalizeLatexForPdflatex dash rule (3-way split mirror)');
  return code;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const need of [...LATEX_NODES, 'Load Skeletons', 'Build Cover LaTeX']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }

  if (N['Assemble Resume LaTeX'].parameters.jsCode.includes('resumeSubheadingOneLine')) {
    console.log(`  ${base}: already patched`);
    return;
  }

  for (const name of LATEX_NODES) {
    N[name].parameters.jsCode = patchLatexNode(N[name].parameters.jsCode, name);
  }
  N['Load Skeletons'].parameters.jsCode = patchLoadSkeletons(N['Load Skeletons'].parameters.jsCode);
  N['Build Cover LaTeX'].parameters.jsCode = patchBuildCoverLatex(N['Build Cover LaTeX'].parameters.jsCode);

  // twin-identity invariant: Assemble Resume LaTeX and Assemble Regen stay byte-identical
  const a = N['Assemble Resume LaTeX'].parameters.jsCode;
  const r = N['Assemble Regen'].parameters.jsCode;
  if (a !== r) { console.error(`INTEGRITY FAIL ${base}: Assemble Resume LaTeX / Assemble Regen diverged after patch`); process.exit(1); }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: RESUME FORMAT v2 render redesign applied (${LATEX_NODES.length} LaTeX nodes + Load Skeletons + Build Cover LaTeX)`);
}

// ═══════════════════════════════════════════════════════════════════════
// HARNESS -- must print all-pass BEFORE any file write. Runs a full dry-run
// patch against the REAL live workflow JSON (anchor-uniqueness assertions
// inside replaceOnce double as the anchor check), then extracts the ACTUAL
// patched function bodies via `new Function` and runs them against real
// fixtures -- including the live Bayer truncateBullet bug reproduction.
// ═══════════════════════════════════════════════════════════════════════
(function harness() {
  const file = TARGETS.find((f) => fs.existsSync(f));
  if (!file) { console.error('HARNESS FAIL: no target file found'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  if (N['Assemble Resume LaTeX'].parameters.jsCode.includes('resumeSubheadingOneLine')) {
    console.log('HARNESS: target already patched (idempotent re-run) -- skipping the dry-run anchor/behavior checks, patch() will no-op too.');
    return;
  }

  const patchedCode = {};
  for (const name of LATEX_NODES) {
    patchedCode[name] = patchLatexNode(N[name].parameters.jsCode, name);
  }
  const patchedLoadSkeletons = patchLoadSkeletons(N['Load Skeletons'].parameters.jsCode);
  const patchedBuildCover = patchBuildCoverLatex(N['Build Cover LaTeX'].parameters.jsCode);
  console.log('HARNESS OK: all 6 anchors unique in all 3 LaTeX nodes + Load Skeletons + Build Cover LaTeX anchors unique (replaceOnce assertions passed)');

  // twin-identity pre-check (dry run)
  if (patchedCode['Assemble Resume LaTeX'] !== patchedCode['Assemble Regen']) {
    console.error('HARNESS FAIL: dry-run patched Assemble Resume LaTeX !== Assemble Regen'); process.exit(1);
  }
  console.log('HARNESS OK: dry-run patched Assemble Resume LaTeX === Assemble Regen (byte-identical)');

  // -- SKELETON brace balance (same check style as s43) --
  for (const name of LATEX_NODES) {
    const code = patchedCode[name];
    const skStart = code.indexOf('const SKELETON = String.raw`');
    const skEnd = code.indexOf('\\end{document}`;', skStart);
    if (skStart === -1 || skEnd === -1) { console.error(`HARNESS FAIL: "${name}" drift-checker SKELETON anchors broken`); process.exit(1); }
    const skeleton = code.slice(skStart, skEnd);
    const body = skeleton.slice(skeleton.indexOf('`') + 1);
    let depth = 0;
    for (const ch of body) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth !== 0) { console.error(`HARNESS FAIL: "${name}" SKELETON brace imbalance after patch: ${depth}`); process.exit(1); }
    if (!code.includes('\\newcommand{\\resumeSubheadingOneLine}[3]{')) { console.error(`HARNESS FAIL: "${name}" missing resumeSubheadingOneLine`); process.exit(1); }
    if (!code.includes('\\newcommand{\\resumeCompanyHeading}[1]{')) { console.error(`HARNESS FAIL: "${name}" missing resumeCompanyHeading`); process.exit(1); }
    if (!code.includes('\\newcommand{\\resumeSubSubheadingCompact}[2]{')) { console.error(`HARNESS FAIL: "${name}" missing resumeSubSubheadingCompact`); process.exit(1); }
    // \resumeSubheading itself must be UNCHANGED (still the old 4-arg macro, byte-for-byte)
    if (!code.includes('\\newcommand{\\resumeSubheading}[4]{\n  \\vspace{-1pt}\\item\n    \\begin{tabular*}{0.97\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}\n      \\textbf{#1} & #2 \\\\\n      \\textit{\\small#3} & \\textit{\\small #4} \\\\\n    \\end{tabular*}\\vspace{-5pt}\n}')) {
      console.error(`HARNESS FAIL: "${name}" \\resumeSubheading (4-arg, education + legacy fragment path) was disturbed`); process.exit(1);
    }
  }
  console.log('HARNESS OK: SKELETON braces balanced, new macros present, \\resumeSubheading (4-arg, education/legacy) untouched -- in all 3 nodes');

  // -- extract the ACTUAL patched function bodies via new Function and run them --
  function buildTestModule(code) {
    const mainMarker = '// ─── Main';
    const idx = code.indexOf(mainMarker);
    const defs = idx === -1 ? code : code.slice(0, idx);
    const fn = new Function(defs + '\nreturn { renderResume, buildHeaderFromPersonal, escapeLatexTextV2, truncateBullet, truncateSummary, normalizeUrl, visibleUrlTextV2 };');
    return fn();
  }
  const mod = buildTestModule(patchedCode['Assemble Resume LaTeX']);

  // 1. buildHeaderFromPersonal -- full fixture (all fields) + portfolio-absent case.
  {
    const personal = {
      name: 'Pranav Kowadkar',
      phone_display: '+91 98765 43210',
      email: 'pk.kowadkar@gmail.com',
      linkedin: 'https://www.linkedin.com/in/pkowadkar/',
      github: 'github.com/pkowadkar',
      portfolio: '',
      show_location: true,
      location: 'Belagavi, Karnataka',
    };
    const h = mod.buildHeaderFromPersonal(personal);
    if (h.includes('\\underline')) { console.error('HARNESS FAIL: header still uses \\underline', h); process.exit(1); }
    if (h.includes('scshape')) { console.error('HARNESS FAIL: header name still uses \\scshape', h); process.exit(1); }
    if (!h.includes('{\\fontsize{18}{18}\\selectfont \\textbf{Pranav Kowadkar}}')) { console.error('HARNESS FAIL: header name not at 18pt \\textbf', h); process.exit(1); }
    if (!h.includes('{\\fontsize{9}{9}\\selectfont')) { console.error('HARNESS FAIL: contact line not at 9pt', h); process.exit(1); }
    if (!h.includes(' ~$|$~ ')) { console.error('HARNESS FAIL: contact line missing literal \' ~$|$~ \' joiner', h); process.exit(1); }
    if (h.includes('\\textasciitilde')) { console.error('HARNESS FAIL: joiner tilde got escaped (mangled by escapeLatexTextV2)', h); process.exit(1); }
    // href TARGET legitimately keeps https://www. -- only the DISPLAY text (2nd brace) must be stripped.
    if (!h.includes('\\href{https://www.linkedin.com/in/pkowadkar/}{linkedin.com/in/pkowadkar}')) { console.error('HARNESS FAIL: linkedin href/visible-text wrong (target keeps scheme+www, display text must strip scheme/www/trailing-slash)', h); process.exit(1); }
    if (!h.includes('\\href{https://github.com/pkowadkar}{github.com/pkowadkar}')) { console.error('HARNESS FAIL: github href/visible-text wrong', h); process.exit(1); }
    if (!h.includes('\\href{mailto:pk.kowadkar@gmail.com}{pk.kowadkar@gmail.com}')) { console.error('HARNESS FAIL: email href/visible-text wrong', h); process.exit(1); }
    if (!h.includes('+91 98765 43210')) { console.error('HARNESS FAIL: phone missing/not plain text', h); process.exit(1); }
    if (h.includes(' ~$|$~  ~$|$~ ')) { console.error('HARNESS FAIL: empty-portfolio produced a double separator', h); process.exit(1); }
    if (!h.trim().endsWith('\\end{center}\\vspace{-6pt}')) { console.error('HARNESS FAIL: missing trailing \\vspace{-6pt}', h); process.exit(1); }
  }
  console.log('HARNESS OK: buildHeaderFromPersonal -- 18pt name (no \\scshape), 9pt contact, literal \' ~$|$~ \' joiner (untouched by escapeLatexTextV2), full visible URLs, no \\underline, mailto visible-address, portfolio-absent skips cleanly, trailing \\vspace{-6pt}');

  // 2. escapeLatexTextV2 dash rules -- date range preserved, spaced/unspaced dashes.
  {
    const dateRange = mod.escapeLatexTextV2('Jan 2019–2022');
    if (dateRange !== 'Jan 2019-2022') { console.error('HARNESS FAIL: unspaced en-dash date range mangled', dateRange); process.exit(1); }
    const spacedEm = mod.escapeLatexTextV2('foo — bar');
    if (spacedEm !== 'foo -- bar') { console.error('HARNESS FAIL: spaced em-dash not normalized to \' -- \'', spacedEm); process.exit(1); }
    const spacedEn = mod.escapeLatexTextV2('foo – bar');
    if (spacedEn !== 'foo -- bar') { console.error('HARNESS FAIL: spaced en-dash not normalized to \' -- \'', spacedEn); process.exit(1); }
    const unspacedEm = mod.escapeLatexTextV2('foo—bar');
    if (unspacedEm !== 'foo -- bar') { console.error('HARNESS FAIL: unspaced em-dash should still become \' -- \'', unspacedEm); process.exit(1); }
    const unspacedEn = mod.escapeLatexTextV2('foo–bar');
    if (unspacedEn !== 'foo-bar') { console.error('HARNESS FAIL: unspaced en-dash should become bare hyphen (no spaces)', unspacedEn); process.exit(1); }
  }
  console.log('HARNESS OK: escapeLatexTextV2 dash rules -- "2019–2022" keeps a bare hyphen, spaced dashes normalize to \' -- \', unspaced em still spaces out, unspaced en stays tight');

  // 3. truncateBullet -- the live Bayer bug, reproduced and fixed.
  {
    const text = 'Drove a solid year-over-year 22 percent ROI boost, leveraging PowerBI dashboards with 121+ behavior metrics tracked across forty regional retail markets for enterprise pricing teams worldwide';
    const out = mod.truncateBullet(text, 105);
    if (/121\+ behavior\.\.\.$/.test(out)) { console.error('HARNESS FAIL: Bayer bug NOT fixed -- still ends in "121+ behavior..."', out); process.exit(1); }
    if (out.endsWith('...')) { console.error('HARNESS FAIL: expected a complete clause (no ellipsis) for this fixture', out); process.exit(1); }
    if (out !== 'Drove a solid year-over-year 22 percent ROI boost') { console.error('HARNESS FAIL: unexpected truncateBullet output for the Bayer fixture', out); process.exit(1); }
  }
  console.log('HARNESS OK: truncateBullet Bayer-bug fixture -- OLD code produced "...121+ behavior..." (dropping "metrics"+); NEW code returns a complete clause via the lowered 0.45 floor');

  // 4. truncateBullet -- sentence-boundary short-circuit (mirrors truncateSummary).
  {
    const reserve = 0;
    const MAX = 210;
    const sentence = 'Shipped a fully redesigned onboarding flow that cut new-user signup drop-off by eighteen percent within the first month of launch. ' + 'x'.repeat(120);
    const out = mod.truncateBullet(sentence, reserve);
    const period = sentence.slice(0, MAX).lastIndexOf('. ');
    if (period <= MAX * 0.5) { console.error('HARNESS SETUP BUG: fixture period not past the 0.5 threshold', period); process.exit(1); }
    if (out !== sentence.slice(0, period + 1)) { console.error('HARNESS FAIL: sentence-boundary short-circuit did not fire as expected', out); process.exit(1); }
    if (out.endsWith('...')) { console.error('HARNESS FAIL: sentence-boundary result should have no ellipsis', out); process.exit(1); }
  }
  console.log('HARNESS OK: truncateBullet sentence-boundary check fires before the clause scan (mirrors truncateSummary, no ellipsis on a real sentence end)');

  // 5. truncateBullet -- bounded stripTrailingFragment never exceeds 3 passes / never unbalances parens.
  {
    // dangling numeric token at the very end should be eaten
    const withNum = mod.truncateBullet('Improved throughput using a brand new distributed caching layer rolled out across every single regional service cluster achieving a sustained 128', 80);
    if (/\d/.test(withNum)) { console.error('HARNESS FAIL: dangling numeric token "128" was not stripped', withNum); process.exit(1); }
    // per/from/into/over/within additions to the word list
    const wordListText = 'Rebuilt the ingestion pipeline over';
    const stripped = mod.truncateBullet(wordListText + ' ' + 'x'.repeat(250), 0);
    if (stripped.toLowerCase().includes('over...')) { console.error('HARNESS FAIL: new word-list entry "over" not stripped', stripped); process.exit(1); }
    // never strip into an unbalanced paren state: a trailing "(unclosed" fragment word must not get eaten if doing so would leave parens unbalanced
    const parenText = 'Led a cross-functional pod (spanning design, data, and eng) to ship the feature for';
    const parenOut = mod.truncateBullet(parenText + ' ' + 'y'.repeat(250), 0);
    let d = 0; for (const ch of parenOut) { if (ch === '(') d++; else if (ch === ')') d--; }
    if (d !== 0) { console.error('HARNESS FAIL: stripTrailingFragment left an unbalanced paren state', parenOut); process.exit(1); }
  }
  console.log('HARNESS OK: stripTrailingFragment eats a dangling numeric/unit token and the new per/from/into/over/within words, and never leaves an unbalanced paren state');

  // 6. renderEntriesV3 (via the real renderResume) -- stacked run, singleton, boomerang.
  {
    const mkEntry = (title, company, start, end) => ({ title, company, startDate: start, endDate: end, location: 'Remote', bullets: [{ keyword: '', text: 'Did a thing.' }] });
    const content = {
      summary: '',
      experience: [
        mkEntry('Senior Engineer', 'Acme Corp', 'Jan 2023', 'Present'),
        mkEntry('Engineer II', 'Acme Corp', 'Jan 2021', 'Dec 2022'),
        mkEntry('Engineer I', 'Acme Corp', 'Jan 2020', 'Dec 2020'),
        mkEntry('Consultant', 'Globex', 'Jun 2018', 'Dec 2019'),
        mkEntry('Intern', 'Acme Corp', 'Jun 2017', 'Aug 2017'), // boomerang -- non-adjacent, must NOT merge with the Acme run above
      ],
      internships: [], projects: [], skills: [], education: [], certifications: [], achievements: [], activities: [],
      sectionOrder: ['experience'],
    };
    const latex = mod.renderResume(content, { name: 'Test' }, false);
    const companyHeadingCount = (latex.match(/\\resumeCompanyHeading\{Acme Corp\}/g) || []).length;
    if (companyHeadingCount !== 1) { console.error(`HARNESS FAIL: expected exactly 1 \\resumeCompanyHeading{Acme Corp} (the 3-position adjacent run), got ${companyHeadingCount}`, latex); process.exit(1); }
    const subSubCount = (latex.match(/\\resumeSubSubheading\{/g) || []).length;
    if (subSubCount !== 3) { console.error(`HARNESS FAIL: expected 3 \\resumeSubSubheading (one per stacked position), got ${subSubCount}`, latex); process.exit(1); }
    if (!latex.includes('\\resumeSubheadingOneLine{Consultant}{Globex}{')) { console.error('HARNESS FAIL: singleton Globex entry should render via \\resumeSubheadingOneLine', latex); process.exit(1); }
    if (!latex.includes('\\resumeSubheadingOneLine{Intern}{Acme Corp}{')) { console.error('HARNESS FAIL: non-adjacent boomerang Acme Corp intern must render standalone (never merge across the Globex gap)', latex); process.exit(1); }
    if (latex.includes('\\textit{\\small Remote}') || latex.includes('{Remote}')) { console.error('HARNESS FAIL: location leaked into the rendered entry header (must be dropped)', latex); process.exit(1); }
  }
  console.log('HARNESS OK: renderEntriesV3 -- 3 consecutive same-company positions collapse to 1 \\resumeCompanyHeading + 3 \\resumeSubSubheading; singleton uses \\resumeSubheadingOneLine; non-adjacent boomerang company never merges across a gap; location dropped from headers');

  // 7. renderEntriesV3 compact mode selects the compact macro names.
  {
    const mkEntry = (title, company, start, end) => ({ title, company, startDate: start, endDate: end, location: '', bullets: [{ keyword: '', text: 'Did a thing.' }] });
    const content = {
      summary: '', experience: [mkEntry('A', 'X', '2020', '2021'), mkEntry('B', 'X', '2019', '2020')],
      internships: [], projects: [], skills: [], education: [], certifications: [], achievements: [], activities: [],
      sectionOrder: ['experience'],
    };
    const latex = mod.renderResume(content, { name: 'Test' }, true);
    if (!latex.includes('\\resumeCompanyHeadingCompact{X}')) { console.error('HARNESS FAIL: compact stacked run should use \\resumeCompanyHeadingCompact', latex); process.exit(1); }
    if (!latex.includes('\\resumeSubSubheadingCompact{')) { console.error('HARNESS FAIL: compact stacked positions should use \\resumeSubSubheadingCompact', latex); process.exit(1); }
  }
  console.log('HARNESS OK: isCompact=true selects the compact macro variants (resumeCompanyHeadingCompact / resumeSubSubheadingCompact) for a stacked run');

  // 8. Build Cover LaTeX's OWN normalizeLatexForPdflatex -- 3-rule dash mirror.
  {
    if (patchedBuildCover.includes(BC_DASH_OLD)) {
      console.error('HARNESS FAIL: Build Cover LaTeX normalizeLatexForPdflatex still has the old blunt single dash rule'); process.exit(1);
    }
    function buildCoverTestModule(code) {
      const marker = 'const coverJson = $input.first()';
      const idx = code.indexOf(marker);
      const defs = idx === -1 ? code : code.slice(0, idx);
      const fn = new Function(defs + '\nreturn { normalizeLatexForPdflatex };');
      return fn();
    }
    const coverMod = buildCoverTestModule(patchedBuildCover);
    const dateRange = coverMod.normalizeLatexForPdflatex('Jan 2019–2022');
    if (dateRange !== 'Jan 2019-2022') { console.error('HARNESS FAIL: Build Cover LaTeX unspaced en-dash date range mangled (dash mirror not applied)', dateRange); process.exit(1); }
    const spacedEm = coverMod.normalizeLatexForPdflatex('foo — bar');
    if (spacedEm !== 'foo -- bar') { console.error('HARNESS FAIL: Build Cover LaTeX spaced em-dash not normalized to \' -- \'', spacedEm); process.exit(1); }
    const spacedEn = coverMod.normalizeLatexForPdflatex('foo – bar');
    if (spacedEn !== 'foo -- bar') { console.error('HARNESS FAIL: Build Cover LaTeX spaced en-dash not normalized to \' -- \'', spacedEn); process.exit(1); }
    const unspacedEm = coverMod.normalizeLatexForPdflatex('foo—bar');
    if (unspacedEm !== 'foo -- bar') { console.error('HARNESS FAIL: Build Cover LaTeX unspaced em-dash should still become \' -- \'', unspacedEm); process.exit(1); }
    const unspacedEn = coverMod.normalizeLatexForPdflatex('foo–bar');
    if (unspacedEn !== 'foo-bar') { console.error('HARNESS FAIL: Build Cover LaTeX unspaced en-dash should become bare hyphen (no spaces)', unspacedEn); process.exit(1); }
  }
  console.log('HARNESS OK: Build Cover LaTeX normalizeLatexForPdflatex dash rule mirrors escapeLatexTextV2 -- "2019–2022" keeps a bare hyphen, spaced dashes normalize to \' -- \', unspaced em still spaces out, unspaced en stays tight');

  // -- Load Skeletons + Build Cover LaTeX: CONTACT_LINE plumbing --
  {
    if (!patchedLoadSkeletons.includes('{{CONTACT_LINE}}')) { console.error('HARNESS FAIL: Load Skeletons cover_skeleton missing {{CONTACT_LINE}} placeholder'); process.exit(1); }
    if (patchedLoadSkeletons.includes('{{PHONE}}') || patchedLoadSkeletons.includes('{{EMAIL}}') || patchedLoadSkeletons.includes('{{LINKEDIN}}')) {
      console.error('HARNESS FAIL: Load Skeletons cover_skeleton still has a leftover PHONE/EMAIL/LINKEDIN placeholder'); process.exit(1);
    }
    if (!patchedLoadSkeletons.includes('{{NAME}}')) { console.error('HARNESS FAIL: Load Skeletons cover_skeleton lost {{NAME}} (must stay, shown separately)'); process.exit(1); }

    if (patchedBuildCover.includes("'{{PHONE}}'") || patchedBuildCover.includes("'{{LINKEDIN}}'") || patchedBuildCover.includes("'{{EMAIL}}'")) {
      console.error('HARNESS FAIL: Build Cover LaTeX still references a PHONE/EMAIL/LINKEDIN placeholder literal'); process.exit(1);
    }
    if (!patchedBuildCover.includes("'{{CONTACT_LINE}}'")) { console.error('HARNESS FAIL: Build Cover LaTeX does not replace {{CONTACT_LINE}}'); process.exit(1); }
    if (patchedBuildCover.includes('personal.github') || patchedBuildCover.includes('personal.portfolio')) {
      console.error('HARNESS FAIL: Build Cover LaTeX contact line must NOT include github/portfolio (resume-only fields)'); process.exit(1);
    }

    // Run the actual patched skeleton-fill + contact-line build end to end.
    const skeletonFn = new Function('personal', 'coverJson', 'ctxJobTitle', 'ctxCompany', `
      ${patchedBuildCover.split('const coverJson = ').slice(1).join('const coverJson = ') ? '' : ''}
      function wrapResumeWithSkeleton(params) {
        const { skeleton, headerLatex, contentLatex } = params;
        if (!skeleton) return contentLatex;
        const lines = skeleton.replace(/\\r\\n/g, '\\n').split('\\n');
        const cs = lines.findIndex(l => l.trim() === '%%% CONTENT_START');
        const ce = lines.findIndex((l, i) => i > cs && l.trim() === '%%% CONTENT_END');
        if (cs !== -1 && ce !== -1) { lines.splice(cs + 1, ce - cs - 1, contentLatex.trim()); return lines.join('\\n'); }
        return lines.join('\\n');
      }
      function escapeLatexText(input) {
        if (typeof input !== 'string') return '';
        return input.replace(/\\\\/g, '\\\\textbackslash{}');
      }
      function normalizeUrlCoverV2(u) { u = String(u == null ? '' : u).trim(); if (!u) return ''; return /^https?:\\/\\//i.test(u) ? u : 'https://' + u; }
      let fullLatex = wrapResumeWithSkeleton({ skeleton: coverJson.skeleton, headerLatex: '', contentLatex: 'BODY' });
      ${BC_NEW}
      return fullLatex;
    `);
    const filled = skeletonFn({ name: 'Jane Doe', phone_display: '555-1234', email: 'jane@example.com', linkedin: 'linkedin.com/in/janedoe' }, { skeleton: patchedLoadSkeletons.match(/const COVER = "([\s\S]*?)";\nconst coverSkeleton/)[1].replace(/\\n/g, '\n').replace(/\\\\/g, '\\').replace(/\\"/g, '"') });
    if (filled.includes('{{CONTACT_LINE}}') || filled.includes('{{PHONE}}') || filled.includes('{{EMAIL}}') || filled.includes('{{LINKEDIN}}')) {
      console.error('HARNESS FAIL: end-to-end cover fill left a placeholder unresolved', filled); process.exit(1);
    }
    if (!filled.includes('linkedin.com/in/janedoe')) { console.error('HARNESS FAIL: end-to-end cover fill missing visible linkedin URL', filled); process.exit(1); }
    if (!filled.includes('{\\fontsize{9}{9}\\selectfont')) { console.error('HARNESS FAIL: end-to-end cover fill missing 9pt contact line wrapper', filled); process.exit(1); }
  }
  console.log('HARNESS OK: Load Skeletons -> single {{CONTACT_LINE}} placeholder (NAME untouched, no leftover PHONE/EMAIL/LINKEDIN tokens); Build Cover LaTeX builds it phone/email/linkedin-only, 9pt, visible URLs, no github/portfolio; end-to-end fill resolves cleanly');

  console.log('HARNESS: ALL CHECKS PASSED');
})();

TARGETS.forEach(patch);
console.log('S135 (RESUME FORMAT v2 render redesign) complete.');
