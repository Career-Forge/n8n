// Auto-generated from the live workflow node "Build Cover LaTeX" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

function escapeLatexText(input) {
  if (typeof input !== 'string') return '';
  input = input.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return input.replace(/\\/g, '\\textbackslash{}').replace(/&/g, '\\&').replace(/%/g, '\\%').replace(/\$/g, '\\$').replace(/#/g, '\\#').replace(/_/g, '\\_').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\^/g, '\\textasciicircum{}').replace(/~/g, '\\textasciitilde{}');
}
function cleanText(str) {
  if (!str) return '';
  return str.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1').replace(/\\[a-zA-Z]+/g, '').replace(/\$[^$]*\$/g, '').trim();
}
function wrapResumeWithSkeleton(params) {
  const { skeleton, headerLatex, contentLatex } = params;
  if (!skeleton) return contentLatex;
  const lines = skeleton.replace(/\r\n/g, '\n').split('\n');
  const hs = lines.findIndex(l => l.trim() === '%%% HEADER_START');
  const he = lines.findIndex((l, i) => i > hs && l.trim() === '%%% HEADER_END');
  if (hs !== -1 && he !== -1) lines.splice(hs + 1, he - hs - 1, headerLatex.trim());
  const cs = lines.findIndex(l => l.trim() === '%%% CONTENT_START');
  const ce = lines.findIndex((l, i) => i > cs && l.trim() === '%%% CONTENT_END');
  if (cs !== -1 && ce !== -1) { lines.splice(cs + 1, ce - cs - 1, contentLatex.trim()); return lines.join('\n'); }
  const endDocIdx = lines.findIndex(l => l.includes('\\end{document}'));
  if (endDocIdx !== -1) lines.splice(endDocIdx, 0, contentLatex.trim());
  else lines.push(contentLatex.trim());
  return lines.join('\n');
}
function normalizeLatexForPdflatex(input) {
  if (!input) return input;
  let s = input.replace(/\r\n/g, '\n');
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\u2026/g, '...')
       // s135: mirror of escapeLatexTextV2's 3-rule dash split -- spaced
       // en/em dash FIRST (must run before the bare em-dash rule or it
       // never matches), then unspaced em -> ' -- ', then unspaced en ->
       // bare '-' (protects date ranges in cover-letter prose the same
       // way the resume path is protected).
       .replace(/\s+[\u2013\u2014]\s+/g, ' -- ').replace(/\u2014/g, ' -- ').replace(/\u2013/g, '-').replace(/\u00A0/g, ' ');
  s = s.replace(/\u20B9/g, 'INR ').replace(/\u20AC/g, 'EUR ').replace(/\u00A3/g, 'GBP ').replace(/(?<!\\)\$/g, '\\$');
  s = s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  return s;
}
const coverJson = $input.first().json.output || $input.first().json;
const ctx = $('Prepare Apply Context').first().json;
const coverSkeleton = ctx.cover_skeleton;
const personal = ctx.personal || {};
const contentLines = [];
contentLines.push('\\begin{lettercontent}');
contentLines.push('\\begin{center}');
contentLines.push('{\\large\\textbf{' + escapeLatexText(coverJson.title || ctx.job_title + ' \\textemdash{} ' + ctx.company) + '}}');
contentLines.push('\\end{center}');
contentLines.push('\\vspace{4mm}');
contentLines.push('');
contentLines.push(escapeLatexText(coverJson.salutation || 'Dear Hiring Team,'));
contentLines.push('');
contentLines.push(escapeLatexText(coverJson.hook || ''));
contentLines.push('');
contentLines.push('\\begin{itemize}[leftmargin=0.2in]');
for (const bullet of (coverJson.bullets || [])) {
  contentLines.push('  \\item \\textbf{' + escapeLatexText(cleanText(bullet.keyword || '')) + ':} ' + escapeLatexText(cleanText(bullet.text || '')));
}
contentLines.push('\\end{itemize}');
contentLines.push('');
contentLines.push(escapeLatexText(coverJson.cta || ''));
contentLines.push('\\end{lettercontent}');
const contentLatex = contentLines.join('\n');
let fullLatex = wrapResumeWithSkeleton({ skeleton: coverSkeleton, headerLatex: '% Header omitted for cover letter', contentLatex });
function normalizeUrlCoverV2(u) { u = String(u == null ? '' : u).trim(); if (!u) return ''; return /^https?:\/\//i.test(u) ? u : 'https://' + u; }
// s135: cover-letter header parity -- single {{CONTACT_LINE}} placeholder,
// built the SAME way as the resume's buildHeaderFromPersonal contact line
// (visible URL text, mailto with visible address, ' ~$|$~ ' joiner, 9pt),
// but phone/email/linkedin ONLY -- github/portfolio are resume-only fields,
// not part of the cover letter per the locked scope.
function visibleUrlCoverV2(u) {
  const v = normalizeUrlCoverV2(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
  return escapeLatexText(v);
}
const contactPartsV2 = [];
const phoneV2 = personal.phone_display || personal.phone_primary || '';
if (phoneV2) contactPartsV2.push(escapeLatexText(phoneV2));
if (personal.email) contactPartsV2.push('\\href{mailto:' + personal.email + '}{' + escapeLatexText(personal.email) + '}');
if (personal.linkedin) contactPartsV2.push('\\href{' + normalizeUrlCoverV2(personal.linkedin) + '}{' + visibleUrlCoverV2(personal.linkedin) + '}');
const contactLineV2 = contactPartsV2.length ? '{\\fontsize{9}{9}\\selectfont ' + contactPartsV2.join(' ~$|$~ ') + '}' : '';
fullLatex = fullLatex.replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate')).replace('{{CONTACT_LINE}}', contactLineV2);
return [{ json: { latex: normalizeLatexForPdflatex(fullLatex).split("\\$|\\$").join("$|$"), chat_id: ctx.chat_id, job_title: ctx.job_title, company: ctx.company } }];
