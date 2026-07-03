// Auto-generated from the live workflow node "Build Cover LaTeX" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

function escapeLatexText(input) {
  if (typeof input !== 'string') return '';
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
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\u2026/g, '...').replace(/[\u2013\u2014]/g, '--').replace(/\u00A0/g, ' ');
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
fullLatex = fullLatex.replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate')).replace('{{PHONE}}', escapeLatexText(personal.phone_display || personal.phone_primary || '')).replaceAll('{{EMAIL}}', personal.email || '').replace('{{LINKEDIN}}', personal.linkedin || '');
return [{ json: { latex: normalizeLatexForPdflatex(fullLatex).split("\\$|\\$").join("$|$"), chat_id: ctx.chat_id, job_title: ctx.job_title, company: ctx.company } }];
