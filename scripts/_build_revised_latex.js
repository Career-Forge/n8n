// ═══════════════════════════════════════════════════════════════
// Build Revised LaTeX — Handles BOTH resume and cover letter
// Checks revise_type from upstream Detect Revise Type node
// ═══════════════════════════════════════════════════════════════

// ─── Shared Helpers ───

function escapeLatexText(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

function extractBetweenMarkers(text, startMarker, endMarker) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const startIdx = lines.findIndex(l => l.trim() === startMarker);
  if (startIdx === -1) return null;
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === endMarker);
  if (endIdx === -1) return null;
  return lines.slice(startIdx + 1, endIdx).join('\n').trim();
}

function wrapResumeWithSkeleton(params) {
  const { skeleton, headerLatex, contentLatex } = params;
  if (!skeleton) {
    return '\\documentclass[letterpaper,11pt]{article}\n\\begin{document}\n' + headerLatex + '\n\n' + contentLatex + '\n\\end{document}\n';
  }
  const lines = skeleton.replace(/\r\n/g, '\n').split('\n');
  const hs = lines.findIndex(l => l.trim() === '%%% HEADER_START');
  const he = lines.findIndex((l, i) => i > hs && l.trim() === '%%% HEADER_END');
  if (hs !== -1 && he !== -1) {
    lines.splice(hs + 1, he - hs - 1, headerLatex.trim());
  }
  const cs = lines.findIndex(l => l.trim() === '%%% CONTENT_START');
  const ce = lines.findIndex((l, i) => i > cs && l.trim() === '%%% CONTENT_END');
  if (cs !== -1 && ce !== -1) {
    lines.splice(cs + 1, ce - cs - 1, contentLatex.trim());
    return lines.join('\n');
  }
  const endDocIdx = lines.findIndex(l => l.includes('\\end{document}'));
  if (endDocIdx !== -1) {
    lines.splice(endDocIdx, 0, contentLatex.trim());
  } else {
    lines.push(contentLatex.trim());
  }
  return lines.join('\n');
}

function sanitizeResumeContentBlock(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const banned = [
    '\\documentclass', '\\usepackage', '\\begin{document}', '\\end{document}',
    '\\ResumeHeader', '\\setlength', '\\addtolength', '\\pagestyle',
    '\\urlstyle', '\\geometry', '\\begin{center}', '\\end{center}',
    '\\begin{tabularx}', '\\end{tabularx}', '%%% HEADER_START', '%%% HEADER_END'
  ];
  const bannedRe = new RegExp(
    '(' + banned.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')'
  );
  let cleaned = lines.filter(l => !bannedRe.test(l)).join('\n').trim();

  function normalizeSkillsBlock(tex) {
    const ls = tex.replace(/\r\n/g, '\n').split('\n');
    const isSkillsHeader = l => /\\section\{(?:Skills|Technical Skills)\}/.test(l);
    for (let i = 0; i < ls.length; i++) {
      if (!isSkillsHeader(ls[i])) continue;
      let j = i + 1;
      while (j < ls.length && !/\\section\{/.test(ls[j])) j++;
      const block = ls.slice(i + 1, j);
      const hasStart = block.some(l => l.trim() === '\\resumeSkillsStart');
      const hasEnd = block.some(l => l.trim() === '\\resumeSkillsEnd');
      const rewritten = [];
      if (!hasStart) rewritten.push('\\resumeSkillsStart');
      for (const raw of block) {
        const line = raw.trim();
        if (!line) continue;
        if (line === '\\resumeSubHeadingListStart') continue;
        if (line === '\\resumeSubHeadingListEnd') continue;
        const noItem = line.replace(/^\\item\s+/, '');
        const m = noItem.match(/^\\textbf\{([^}]+):\}\s*(.+?)(?:\\\\)?$/);
        if (m) { rewritten.push('\\resumeSkillLine{' + m[1].trim() + '}{' + m[2].trim() + '}'); continue; }
        if (noItem.startsWith('\\resumeSkillLine{')) { rewritten.push(noItem); continue; }
        rewritten.push(noItem);
      }
      if (!hasEnd) rewritten.push('\\resumeSkillsEnd');
      ls.splice(i + 1, j - (i + 1), ...rewritten);
      i = i + rewritten.length;
    }
    return ls.join('\n');
  }

  function balanceSimpleMacroPairs(tex) {
    const starts = (tex.match(/\\resumeSkillsStart\b/g) || []).length;
    const ends = (tex.match(/\\resumeSkillsEnd\b/g) || []).length;
    if (starts > ends) return tex + '\n' + '\\resumeSkillsEnd\n'.repeat(starts - ends);
    if (ends > starts) {
      let out = tex; let extra = ends - starts;
      while (extra > 0) { out = out.replace(/\\resumeSkillsEnd\b/, ''); extra--; }
      return out;
    }
    return tex;
  }

  const normalized = cleaned
    .replace(/\\rupee\s*/g, 'INR~')
    .replace(/\$\s*\\rightarrow\s*\$/g, '\\(\\rightarrow\\)')
    .replace(/\$\s*\\to\s*\$/g, '\\(\\to\\)')
    .trim();

  return balanceSimpleMacroPairs(normalizeSkillsBlock(normalized)).trim();
}

function normalizeLatexForPdflatex(input) {
  if (!input) return input;
  let s = input.replace(/\r\n/g, '\n');
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
    .replace(/\u2026/g, '...').replace(/[\u2013\u2014]/g, '--').replace(/\u00A0/g, ' ');
  s = s.replace(/\u20B9/g, 'INR ').replace(/\u20AC/g, 'EUR ').replace(/\u00A3/g, 'GBP ')
    .replace(/(?<!\\)\$/g, '\\$');
  s = s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
  return s;
}

// ─── Main: Type Switch ───
const ctx = $('Detect Revise Type').item.json;
const reviseType = ctx.revise_type;
const revisedJson = $input.first().json.output || {};
const personal = ctx.personal || {};

if (reviseType === 'cover') {
  // ─── Cover Letter LaTeX Builder ───
  const coverSkeleton = ctx.cover_skeleton;

  const contentLines = [];
  contentLines.push('\\begin{lettercontent}');
  contentLines.push('\\begin{center}');
  contentLines.push('{\\large\\textbf{' + escapeLatexText(revisedJson.title || ctx.job_title + ' \\textemdash{} ' + ctx.company) + '}}');
  contentLines.push('\\end{center}');
  contentLines.push('\\vspace{4mm}');
  contentLines.push('');
  contentLines.push(escapeLatexText(revisedJson.salutation || 'Dear Hiring Team,'));
  contentLines.push('');
  contentLines.push(escapeLatexText(revisedJson.hook || ''));
  contentLines.push('');
  contentLines.push('\\begin{itemize}[leftmargin=0.2in]');
  const bullets = revisedJson.bullets || [];
  for (const bullet of bullets) {
    contentLines.push('  \\item \\textbf{' + escapeLatexText(bullet.keyword || '') + ':} ' + escapeLatexText(bullet.text || ''));
  }
  contentLines.push('\\end{itemize}');
  contentLines.push('');
  contentLines.push(escapeLatexText(revisedJson.cta || ''));
  contentLines.push('\\end{lettercontent}');

  const contentLatex = contentLines.join('\n');
  let fullLatex = wrapResumeWithSkeleton({
    skeleton: coverSkeleton,
    headerLatex: '% Header omitted for cover letter',
    contentLatex: contentLatex
  });

  fullLatex = fullLatex
    .replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate'))
    .replace('{{PHONE}}', escapeLatexText(personal.phone || ''))
    .replace('{{EMAIL}}', personal.email || '')
    .replace('{{LINKEDIN}}', personal.linkedin || '');

  const normalized = normalizeLatexForPdflatex(fullLatex);
  return [{ json: { latex: normalized, chat_id: ctx.chat_id, job_title: ctx.job_title, company: ctx.company, revise_type: 'cover', changes_summary: revisedJson.changes_summary || '' } }];

} else {
  // ─── Resume LaTeX Builder ───
  const skeleton = ctx.resume_skeleton;

  const headerTemplate = extractBetweenMarkers(skeleton, '%%% HEADER_START', '%%% HEADER_END') || '';
  const headerLatex = headerTemplate
    .replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate'))
    .replace('{{PHONE}}', escapeLatexText(personal.phone || ''))
    .replace('{{EMAIL}}', personal.email || '')
    .replace('{{LINKEDIN}}', personal.linkedin || '')
    .replace('{{GITHUB}}', personal.github || '')
    .replace('{{LOCATION}}', escapeLatexText(personal.location || ''))
    .replace('{{WORK_AUTH}}', escapeLatexText(personal.work_authorization || ''));

  const sections = revisedJson.sections || [];
  const contentParts = [];

  for (const section of sections) {
    const heading = section.heading || '';
    const items = section.items || [];

    if (heading === 'Skills' || heading === 'Technical Skills') {
      contentParts.push('\\section{Technical Skills}');
      contentParts.push('\\resumeSubHeadingListStart');
      for (const item of items) {
        if (item.type === 'skill_line') {
          contentParts.push('  \\resumeSkillLine{' + escapeLatexText(item.category || '') + '}{' + escapeLatexText(item.skills || '') + '}');
        }
      }
      contentParts.push('\\resumeSubHeadingListEnd');
    } else if (heading === 'Education') {
      contentParts.push('\\section{Education}');
      contentParts.push('\\resumeSubHeadingListStart');
      for (const item of items) {
        if (item.type === 'education') {
          const degree = [item.degree, item.major].filter(Boolean).join(' in ');
          contentParts.push('  \\resumeSubheading{' + escapeLatexText(item.institution || '') + '}{' + escapeLatexText(item.location || '') + '}{' + escapeLatexText(degree) + '}{' + escapeLatexText(item.dates || '') + '}');
          if (item.gpa) contentParts.push('  \\resumeItem{GPA: ' + escapeLatexText(item.gpa) + '}');
          if (item.coursework) contentParts.push('  \\resumeItem{Coursework: ' + escapeLatexText(item.coursework) + '}');
        }
      }
      contentParts.push('\\resumeSubHeadingListEnd');
    } else if (heading === 'Experience') {
      contentParts.push('\\section{Experience}');
      contentParts.push('\\resumeSubHeadingListStart');
      for (const item of items) {
        if (item.type === 'role') {
          contentParts.push('  \\resumeSubheading{' + escapeLatexText(item.role || '') + '}{' + escapeLatexText(item.dates || '') + '}{' + escapeLatexText(item.company || '') + '}{' + escapeLatexText(item.location || '') + '}');
          if (item.bullets && item.bullets.length > 0) {
            contentParts.push('  \\resumeItemListStart');
            for (const bullet of item.bullets) {
              const kw = bullet.keyword ? '\\textbf{' + escapeLatexText(bullet.keyword) + ':} ' : '';
              contentParts.push('    \\resumeItem{' + kw + escapeLatexText(bullet.text || '') + '}');
            }
            contentParts.push('  \\resumeItemListEnd');
          }
        }
      }
      contentParts.push('\\resumeSubHeadingListEnd');
    } else if (heading === 'Projects') {
      contentParts.push('\\section{Projects}');
      contentParts.push('\\resumeSubHeadingListStart');
      for (const item of items) {
        if (item.type === 'project') {
          const techStr = item.tech ? ' $|$ ' + escapeLatexText(item.tech) : '';
          const rightCol = item.url ? escapeLatexText(item.url) : '';
          contentParts.push('  \\resumeProjectHeading{\\textbf{' + escapeLatexText(item.name || '') + '}' + techStr + '}{' + rightCol + '}');
          if (item.bullets && item.bullets.length > 0) {
            contentParts.push('  \\resumeItemListStart');
            for (const bullet of item.bullets) {
              const kw = bullet.keyword ? '\\textbf{' + escapeLatexText(bullet.keyword) + ':} ' : '';
              contentParts.push('    \\resumeItem{' + kw + escapeLatexText(bullet.text || '') + '}');
            }
            contentParts.push('  \\resumeItemListEnd');
          }
        }
      }
      contentParts.push('\\resumeSubHeadingListEnd');
    }
  }

  const contentLatex = contentParts.join('\n');
  const sanitized = sanitizeResumeContentBlock(contentLatex);
  const fullLatex = wrapResumeWithSkeleton({ skeleton, headerLatex, contentLatex: sanitized });
  const normalized = normalizeLatexForPdflatex(fullLatex);

  return [{ json: { latex: normalized, chat_id: ctx.chat_id, job_title: ctx.job_title, company: ctx.company, revise_type: 'resume', changes_summary: revisedJson.changes_summary || '' } }];
}
