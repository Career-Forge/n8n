/**
 * s47_realworld_fixes.js -- 5 real bugs found from the first live apply after
 * v7 deployed (a real Level AI application), each confirmed with hard
 * evidence (real execution data + real pdflatex compiles) before fixing:
 *
 * 1. Header name in \Huge -- oversized relative to the rest of the resume,
 *    wastes vertical space. Reduced to \fontsize{20}{20}.
 *
 * 2. Still 2 pages. Root cause: Parse Pass1's allocator reclaims an empty
 *    achievements section's line budget into the experience pool
 *    (pools[primary] += achMax), but s43's calibration only ever tested the
 *    achievements-PRESENT case -- the reclaimed scenario was never verified
 *    against a real compile and, on this real apply (no achievements
 *    uploaded), pushed experience from the calibrated-safe 16 lines to 18,
 *    landing a 9th bullet that tipped the page over. Fix: stop reclaiming
 *    summary/achievements slack into MORE bullets -- unused space stays
 *    unused space (safe direction) rather than gambling the hard single-page
 *    requirement for a fuller page.
 *
 * 3. Bullets randomly wrapping to a 3rd line with one dangling word. Real
 *    pdflatex probes (not just character-count theory, which already misled
 *    calibration once) show this isn't pure char-count: two 193-213 char
 *    bodies with ~22-char keywords wrapped to 3 lines, while similarly-long
 *    bodies with LONGER keywords (31 chars) stayed at 2 -- it's the
 *    KEYWORD+BODY COMBINED length (~215+) plus unbreakable compound tokens
 *    ("wind-tunnel", "MIL-STD") that tips it over, not body length alone.
 *    Fix: (a) tighten Pass2's mid/senior prompt target 150-200 -> 130-165
 *    chars so fewer bullets approach the danger zone at all; (b) make the
 *    render-time truncateBullet safety net KEYWORD-AWARE (reserves space for
 *    the keyword+colon so the combined total stays under a real, compile-
 *    verified 210-char ceiling) instead of a flat 240 that ignores the
 *    keyword entirely.
 *
 * 4. Summary sometimes 4+ lines despite "2-3 sentences" -- a soft prompt ask
 *    the LLM ignored (481 chars observed live). Fix: hard code-level cap via
 *    a new truncateSummary() (same word-boundary+ellipsis shape as
 *    truncateBullet), MAX=190 -- real pdflatex-verified to hold at exactly 2
 *    lines up to 206 chars pre-ellipsis. Lives in the shared renderResume,
 *    so it protects generate, regen, AND revise uniformly.
 *
 * 5. LinkedIn/GitHub links dead. Real cause: personal data stores bare
 *    domains ("linkedin.com/in/x", no scheme) -- \href{linkedin.com/in/x}{}
 *    is a malformed/relative link to hyperref, not a web URL. Fix: normalize
 *    with a scheme before building \href.
 *
 * Touches: Parse Pass1 (reclaim removal), Build Pass1 Context (tightened
 * STYLE_2LINE target), Pass2 Generate prompt (matching numeric update), and
 * the shared LaTeX helper blocks in all 3 LaTeX nodes (buildHeaderFromPersonal,
 * truncateBullet, bulletRenderV2, renderResume + new truncateSummary).
 * export_prompts.js's truncateBullet anchor needs updating (signature
 * changed, same class of fix as the isCompact-param incident).
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

// ═══ 1. Parse Pass1: remove the summary/achievements-empty reclaim ═══
const RECLAIM_OLD =
  "const pools = {};\n" +
  "  for (const s of POOL_SECTIONS) pools[s] = (_plan.sections[s] && _plan.sections[s].lineBudget) || 0;\n" +
  "  for (const s of POOL_SECTIONS) {\n" +
  "    if (effectiveOrder.indexOf(s) === -1 && pools[s] > 0) { pools[primary] += pools[s]; pools[s] = 0; }\n" +
  "  }\n" +
  "  if (effectiveOrder.indexOf('summary') !== -1 && !(pass1.summary && String(pass1.summary).trim())) pools[primary] += _plan.summaryLines || 0;\n" +
  "  const achMax = (_plan.sections.achievements && _plan.sections.achievements.maxEntries) || 0;\n" +
  "  if (achMax > 0 && !(Array.isArray(pass1.selectedAchievements) && pass1.selectedAchievements.length)) pools[primary] += achMax;\n";

const RECLAIM_NEW =
  "const pools = {};\n" +
  "  for (const s of POOL_SECTIONS) pools[s] = (_plan.sections[s] && _plan.sections[s].lineBudget) || 0;\n" +
  "  for (const s of POOL_SECTIONS) {\n" +
  "    if (effectiveOrder.indexOf(s) === -1 && pools[s] > 0) { pools[primary] += pools[s]; pools[s] = 0; }\n" +
  "  }\n" +
  "  // v7.1 (s47): do NOT reclaim an empty summary/achievements section's slack into\n" +
  "  // MORE bullets -- s43's calibration only verified the achievements/summary-PRESENT\n" +
  "  // case; a real live apply proved the reclaimed case overflows to 2 pages. Unused\n" +
  "  // space stays unused space -- safe direction, never risks the single-page floor.\n" +
  "  const achMax = (_plan.sections.achievements && _plan.sections.achievements.maxEntries) || 0;\n";

// ═══ 2. Build Pass1 Context: tighten the mid/senior bullet target ═══
const STYLE_2LINE_OLD =
  "const STYLE_2LINE = {\n" +
  "  linesPerBullet: 2, targetChars: [150, 200],\n" +
  "  directive: 'Impact-and-scope style: each bullet 150-200 characters (~2 printed lines): action verb + system/scope + technology + quantified outcome. Do not write bullets under 120 characters.'\n" +
  "};";

const STYLE_2LINE_NEW =
  "const STYLE_2LINE = {\n" +
  "  linesPerBullet: 2, targetChars: [130, 165],\n" +
  "  directive: 'Impact-and-scope style: each bullet 130-165 characters BEFORE the bold keyword lead-in (~2 printed lines total including the keyword): action verb + system/scope + technology + quantified outcome. Do not write bullets under 110 characters.'\n" +
  "};";

// ═══ 3. Pass2 Generate prompt: matching numeric update ═══
const P2_LENGTH_OLD = 'Bullet length is TIER-DEPENDENT — follow the == BULLET BUDGET == block in the user message when present: senior/mid bullets are 150-200 characters (impact/scope style, ~2 printed lines); junior/fresher bullets are 70-110 characters (skills-evidence style, ~1 printed line). Absolute hard ceiling 240 characters — anything longer gets truncated at a word boundary downstream.';
const P2_LENGTH_NEW = 'Bullet length is TIER-DEPENDENT — follow the == BULLET BUDGET == block in the user message when present: senior/mid bullets are 130-165 characters BEFORE the keyword lead-in (impact/scope style, ~2 printed lines total); junior/fresher bullets are 70-110 characters (skills-evidence style, ~1 printed line). Longer keywords need shorter bodies to stay on 2 lines. Absolute hard ceiling ~210 combined characters (keyword + body) — anything longer gets truncated at a word boundary downstream.';

// ═══ 4-8. Shared LaTeX helper blocks (all 3 nodes) ═══
const HEADER_OLD =
  "function buildHeaderFromPersonal(p) {\n" +
  "  p = p || {};\n" +
  "  const name = escapeLatexTextV2(firstNonEmpty(p.name, 'Candidate'));\n" +
  "  const parts = [];\n" +
  "  const phone = firstNonEmpty(p.phone_display, p.phone);\n" +
  "  if (phone) parts.push(escapeLatexTextV2(phone));\n" +
  "  if (p.email) parts.push('\\\\href{mailto:' + p.email + '}{\\\\underline{' + p.email + '}}');\n" +
  "  if (p.linkedin) parts.push('\\\\href{' + p.linkedin + '}{\\\\underline{LinkedIn}}');\n" +
  "  if (p.github) parts.push('\\\\href{' + p.github + '}{\\\\underline{GitHub}}');\n" +
  "  if (p.portfolio) parts.push('\\\\href{' + p.portfolio + '}{\\\\underline{Portfolio}}');\n" +
  "  if (p.show_location && p.location) parts.push(escapeLatexTextV2(p.location));\n" +
  "  const contact = parts.length ? '\\\\small ' + parts.join(' $|$ ') : '';\n" +
  "  return '\\\\begin{center}\\n  \\\\textbf{\\\\Huge \\\\scshape ' + name + '} \\\\\\\\ \\\\vspace{4pt}\\n  ' + contact + '\\n\\\\end{center}';\n" +
  "}";

const HEADER_NEW =
  "function normalizeUrl(u) {\n" +
  "  u = String(u == null ? '' : u).trim();\n" +
  "  if (!u) return '';\n" +
  "  return /^https?:\\/\\//i.test(u) ? u : 'https://' + u;\n" +
  "}\n" +
  "function buildHeaderFromPersonal(p) {\n" +
  "  p = p || {};\n" +
  "  const name = escapeLatexTextV2(firstNonEmpty(p.name, 'Candidate'));\n" +
  "  const parts = [];\n" +
  "  const phone = firstNonEmpty(p.phone_display, p.phone);\n" +
  "  if (phone) parts.push(escapeLatexTextV2(phone));\n" +
  "  if (p.email) parts.push('\\\\href{mailto:' + p.email + '}{\\\\underline{' + p.email + '}}');\n" +
  "  if (p.linkedin) parts.push('\\\\href{' + normalizeUrl(p.linkedin) + '}{\\\\underline{LinkedIn}}');\n" +
  "  if (p.github) parts.push('\\\\href{' + normalizeUrl(p.github) + '}{\\\\underline{GitHub}}');\n" +
  "  if (p.portfolio) parts.push('\\\\href{' + normalizeUrl(p.portfolio) + '}{\\\\underline{Portfolio}}');\n" +
  "  if (p.show_location && p.location) parts.push(escapeLatexTextV2(p.location));\n" +
  "  const contact = parts.length ? '\\\\small ' + parts.join(' $|$ ') : '';\n" +
  "  return '\\\\begin{center}\\n  \\\\textbf{\\\\fontsize{20}{20}\\\\selectfont \\\\scshape ' + name + '} \\\\\\\\ \\\\vspace{4pt}\\n  ' + contact + '\\n\\\\end{center}';\n" +
  "}";

const TRUNCATE_OLD =
  "function truncateBullet(t) {\n" +
  "  t = String(t == null ? '' : t).trim();\n" +
  "  const MAX = 240;\n" +
  "  if (t.length <= MAX) return t;\n" +
  "  const cut = t.slice(0, MAX);\n" +
  "  const sp = cut.lastIndexOf(' ');\n" +
  "  const base = (sp > MAX - 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\\s]+$/, '');\n" +
  "  return base + '...';\n" +
  "}";

const TRUNCATE_NEW =
  "function truncateBullet(t, reserve) {\n" +
  "  t = String(t == null ? '' : t).trim();\n" +
  "  const SAFE_TOTAL = 210; // real-pdflatex-verified combined (keyword+body) 2-line ceiling\n" +
  "  const MAX = Math.max(60, SAFE_TOTAL - (reserve || 0));\n" +
  "  if (t.length <= MAX) return t;\n" +
  "  const cut = t.slice(0, MAX);\n" +
  "  const sp = cut.lastIndexOf(' ');\n" +
  "  const base = (sp > MAX - 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\\s]+$/, '');\n" +
  "  return base + '...';\n" +
  "}\n" +
  "function truncateSummary(t) {\n" +
  "  t = String(t == null ? '' : t).trim();\n" +
  "  const MAX = 190; // real-pdflatex-verified: holds at exactly 2 lines up to ~206 chars\n" +
  "  if (t.length <= MAX) return t;\n" +
  "  const cut = t.slice(0, MAX);\n" +
  "  const sp = cut.lastIndexOf(' ');\n" +
  "  const base = (sp > MAX - 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\\s]+$/, '');\n" +
  "  return base + '...';\n" +
  "}";

const BULLETRENDER_OLD =
  "function bulletRenderV2(bullets, isCompact) {\n" +
  "  const cmd = isCompact ? '\\\\resumeItemCompact' : '\\\\resumeItem';\n" +
  "  return (bullets || []).slice(0, isCompact ? 4 : 6).map((b) => {\n" +
  "    const text = truncateBullet(b.text);\n" +
  "    const kwText = (b.keyword || '').replace(/[:;,.]+\\s*$/, '');\n" +
  "    const kw = kwText ? '\\\\textbf{' + escapeLatexTextV2(kwText) + ':} ' : '';\n" +
  "    return '    ' + cmd + '{' + kw + escapeLatexTextV2(text) + '}';\n" +
  "  }).join('\\n');\n" +
  "}";

const BULLETRENDER_NEW =
  "function bulletRenderV2(bullets, isCompact) {\n" +
  "  const cmd = isCompact ? '\\\\resumeItemCompact' : '\\\\resumeItem';\n" +
  "  return (bullets || []).slice(0, isCompact ? 4 : 6).map((b) => {\n" +
  "    const kwText = (b.keyword || '').replace(/[:;,.]+\\s*$/, '');\n" +
  "    const reserve = kwText ? kwText.length + 2 : 0;\n" +
  "    const text = truncateBullet(b.text, reserve);\n" +
  "    const kw = kwText ? '\\\\textbf{' + escapeLatexTextV2(kwText) + ':} ' : '';\n" +
  "    return '    ' + cmd + '{' + kw + escapeLatexTextV2(text) + '}';\n" +
  "  }).join('\\n');\n" +
  "}";

const SUMMARY_SLOT_OLD = "slots.summary = content.summary ? escapeLatexTextV2(content.summary) : '';";
const SUMMARY_SLOT_NEW = "slots.summary = content.summary ? escapeLatexTextV2(truncateSummary(content.summary)) : '';";

const NODE_EDITS = [
  ['buildHeaderFromPersonal (font + URL normalize)', HEADER_OLD, HEADER_NEW],
  ['truncateBullet (keyword-aware) + new truncateSummary', TRUNCATE_OLD, TRUNCATE_NEW],
  ['bulletRenderV2 (pass reserve)', BULLETRENDER_OLD, BULLETRENDER_NEW],
  ['renderResume summary slot (hard cap)', SUMMARY_SLOT_OLD, SUMMARY_SLOT_NEW],
];

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const need of ['Parse Pass1', 'Build Pass1 Context', 'Pass2 Generate', ...LATEX_NODES]) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Assemble Resume LaTeX'].parameters.jsCode.includes('normalizeUrl')) { console.log(`  ${base}: already patched`); return; }

  // 1. Parse Pass1
  {
    const code = N['Parse Pass1'].parameters.jsCode;
    const count = code.split(RECLAIM_OLD).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: Parse Pass1 reclaim anchor found ${count} times`); process.exit(1); }
    N['Parse Pass1'].parameters.jsCode = code.replace(RECLAIM_OLD, RECLAIM_NEW);
  }

  // 2. Build Pass1 Context
  {
    const code = N['Build Pass1 Context'].parameters.jsCode;
    const count = code.split(STYLE_2LINE_OLD).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: Build Pass1 Context STYLE_2LINE anchor found ${count} times`); process.exit(1); }
    N['Build Pass1 Context'].parameters.jsCode = code.replace(STYLE_2LINE_OLD, STYLE_2LINE_NEW);
  }

  // 3. Pass2 Generate prompt
  {
    const msg = N['Pass2 Generate'].parameters.messages.messageValues[0].message;
    const count = msg.split(P2_LENGTH_OLD).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: Pass2 Generate length-policy anchor found ${count} times`); process.exit(1); }
    N['Pass2 Generate'].parameters.messages.messageValues[0].message = msg.replace(P2_LENGTH_OLD, P2_LENGTH_NEW);
  }

  // 4. Shared LaTeX helper blocks, all 3 nodes
  for (const name of LATEX_NODES) {
    let code = N[name].parameters.jsCode;
    for (const [label, oldStr] of NODE_EDITS) {
      const count = code.split(oldStr).length - 1;
      if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: "${name}" anchor "${label}" found ${count} times`); process.exit(1); }
    }
    for (const [, oldStr, newStr] of NODE_EDITS) code = code.replace(oldStr, newStr);
    N[name].parameters.jsCode = code;
  }

  const a = N['Assemble Resume LaTeX'].parameters.jsCode;
  const r = N['Assemble Regen'].parameters.jsCode;
  if (a !== r) { console.error(`INTEGRITY FAIL ${base}: Assemble twins diverged after patch`); process.exit(1); }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: all 5 fixes applied`);
}

// ── harness ──
(function harness() {
  const file = TARGETS.find((f) => fs.existsSync(f));
  if (!file) { console.error('HARNESS FAIL: no target file'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  // 1. Parse Pass1 reclaim removal: eval and confirm no bonus for empty achievements/summary.
  {
    let code = N['Parse Pass1'].parameters.jsCode;
    const already = code.includes('normalizeUrl') || !code.includes(RECLAIM_OLD.split('\n')[0]);
    if (code.split(RECLAIM_OLD).length - 1 === 1) code = code.replace(RECLAIM_OLD, RECLAIM_NEW);
    else if (!code.includes('do NOT reclaim')) { console.error('HARNESS FAIL: Parse Pass1 reclaim anchor not found and not already patched'); process.exit(1); }

    const plan = {
      sectionOrder: ['summary', 'experience', 'skills', 'achievements', 'certifications', 'education'],
      summaryLines: 2, primaryPool: 'experience', bulletStyle: { linesPerBullet: 2 },
      sections: {
        experience: { maxEntries: 4, lineBudget: 16, minBulletsPerEntry: 2, maxBulletsPerEntry: 4, mostRecentMinBullets: 3 },
        projects: { maxEntries: 2, lineBudget: 6, minBulletsPerEntry: 1, maxBulletsPerEntry: 2 },
        internships: { maxEntries: 0, lineBudget: 0 },
        achievements: { maxEntries: 2 }, skills: { maxCategories: 4 }, certifications: { maxEntries: 2 }, education: { maxEntries: 2 },
      },
    };
    function pos(id, opts) { return Object.assign({ id, title: 'T', startDate: '', endDate: 'Dec 2022', tenureMonths: 24, isMostRecent: false, isLongestTenure: false, isSelected: true, relevanceScore: 50, bulletCount: 3, keyAchievements: ['a', 'b', 'c', 'd', 'e', 'f'] }, opts); }
    const fixture = {
      sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: '', // empty -- would have triggered summary reclaim under the old code
      selectedAchievements: [], // empty -- would have triggered achievements reclaim under the old code
      companies: [
        { company: 'A', positions: [pos('p1', { isMostRecent: true, endDate: 'Present', relevanceScore: 90 })] },
        { company: 'B', positions: [pos('p2', { relevanceScore: 70 })] },
        { company: 'C', positions: [pos('p3', { relevanceScore: 60 })] },
        { company: 'D', positions: [pos('p4', { relevanceScore: 50 })] },
      ],
      selectedProjects: [], selectedInternships: [],
    };
    const $mock = (name) => { if (name === 'Build Pass1 Context') return { first: () => ({ json: { plan, tier: 'mid' } }) }; throw new Error('no_execution_data: ' + name); };
    const $input = { first: () => ({ json: { text: JSON.stringify(fixture) } }) };
    const out = new Function('$input', '$', '$getWorkflowStaticData', code)($input, $mock, () => ({ user_prefs: {} }))[0].json.pass1;
    const totalBullets = out.companies.flatMap((c) => c.positions).reduce((a, p) => a + p.bulletCount, 0);
    if (totalBullets !== 8) { console.error('HARNESS FAIL: reclaim removal -- expected exactly 8 bullets (16-line budget, no bonus from empty summary/achievements), got', totalBullets); process.exit(1); }
  }
  console.log('HARNESS OK: Parse Pass1 no longer reclaims empty summary/achievements slack into extra bullets (8 bullets from a 16-line budget, not 9)');

  // 2. Build Pass1 Context: STYLE_2LINE tightened (apply the edit in-memory if not already live).
  {
    let code = N['Build Pass1 Context'].parameters.jsCode;
    if (!code.includes('targetChars: [130, 165]')) {
      const count = code.split(STYLE_2LINE_OLD).length - 1;
      if (count !== 1) { console.error(`HARNESS FAIL: Build Pass1 Context STYLE_2LINE anchor found ${count}x live`); process.exit(1); }
      code = code.replace(STYLE_2LINE_OLD, STYLE_2LINE_NEW);
    }
    if (!code.includes('targetChars: [130, 165]')) { console.error('HARNESS FAIL: Build Pass1 Context STYLE_2LINE not tightened after edit'); process.exit(1); }
  }

  // 3. Pass2 Generate prompt updated (apply the edit in-memory if not already live).
  {
    let msg = N['Pass2 Generate'].parameters.messages.messageValues[0].message;
    if (!msg.includes('130-165 characters')) {
      const count = msg.split(P2_LENGTH_OLD).length - 1;
      if (count !== 1) { console.error(`HARNESS FAIL: Pass2 Generate length-policy anchor found ${count}x live`); process.exit(1); }
      msg = msg.replace(P2_LENGTH_OLD, P2_LENGTH_NEW);
    }
    if (!msg.includes('130-165 characters') || msg.includes('150-200 characters')) { console.error('HARNESS FAIL: Pass2 Generate prompt not updated after edit'); process.exit(1); }
  }

  // 4. Shared LaTeX blocks: eval and behaviorally prove each fix.
  function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('fn not found: ' + name);
    let depth = 0, i = src.indexOf('{', start), j = i;
    for (;;) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; if (depth === 0) break; j++; }
    return src.slice(start, j + 1);
  }
  let latexCode = N['Assemble Resume LaTeX'].parameters.jsCode;
  if (!latexCode.includes('normalizeUrl')) {
    for (const [label, oldStr] of NODE_EDITS) {
      const count = latexCode.split(oldStr).length - 1;
      if (count !== 1) { console.error(`HARNESS FAIL: live anchor "${label}" found ${count}x`); process.exit(1); }
    }
    for (const [, oldStr, newStr] of NODE_EDITS) latexCode = latexCode.replace(oldStr, newStr);
  }

  const fns = new Function(
    [
      extractFn(latexCode, 'firstNonEmpty'),
      extractFn(latexCode, 'escapeLatexTextV2'),
      extractFn(latexCode, 'normalizeUrl'),
      extractFn(latexCode, 'buildHeaderFromPersonal'),
      extractFn(latexCode, 'truncateBullet'),
      extractFn(latexCode, 'bulletRenderV2'),
    ].join('\n') + '\nreturn { buildHeaderFromPersonal, truncateBullet, bulletRenderV2, normalizeUrl };'
  )();

  // 4a. Header: fontsize 20, no \Huge.
  const header = fns.buildHeaderFromPersonal({ name: 'Test User', email: 't@x.com' });
  if (!header.includes('\\fontsize{20}{20}') || header.includes('\\Huge')) { console.error('HARNESS FAIL: header font not fixed:', header); process.exit(1); }

  // 4b. URL normalization: bare domain gets https://, already-schemed URL untouched.
  if (fns.normalizeUrl('linkedin.com/in/x') !== 'https://linkedin.com/in/x') { console.error('HARNESS FAIL: normalizeUrl did not add scheme'); process.exit(1); }
  if (fns.normalizeUrl('https://github.com/x') !== 'https://github.com/x') { console.error('HARNESS FAIL: normalizeUrl mangled an already-schemed URL'); process.exit(1); }
  const headerLinks = fns.buildHeaderFromPersonal({ name: 'T', linkedin: 'linkedin.com/in/pkowadkar', github: 'github.com/p-kowadkar' });
  if (!headerLinks.includes('\\href{https://linkedin.com/in/pkowadkar}') || !headerLinks.includes('\\href{https://github.com/p-kowadkar}')) {
    console.error('HARNESS FAIL: header hrefs not normalized:', headerLinks); process.exit(1);
  }

  // 4c. truncateBullet keyword-aware: same body, long keyword gets a shorter effective cap than short keyword.
  // Filler uses 'Q' (not 'x') -- 'x' collides with the literal x inside \textbf in the surrounding markup,
  // which a naive /x+/ match would find first (a real bug caught while writing this very test).
  const longBody = 'Q'.repeat(230);
  const withShortKw = fns.bulletRenderV2([{ keyword: 'AB', text: longBody }], false);
  const withLongKw = fns.bulletRenderV2([{ keyword: 'A Genuinely Long Keyword Phrase Here', text: longBody }], false);
  const shortLen = withShortKw.match(/Q+/)[0].length;
  const longLen = withLongKw.match(/Q+/)[0].length;
  if (!(longLen < shortLen)) { console.error('HARNESS FAIL: keyword-aware truncation -- longer keyword should yield shorter body, got', longLen, 'vs', shortLen); process.exit(1); }
  if (shortLen + 2 + 2 > 210 + 5) { console.error('HARNESS FAIL: short-keyword combined length exceeds safe ceiling by too much'); process.exit(1); }
  // no keyword: body alone still capped near 210.
  const noKw = fns.bulletRenderV2([{ keyword: '', text: longBody }], false);
  const noKwLen = noKw.match(/Q+/)[0].length;
  if (noKwLen > 210) { console.error('HARNESS FAIL: no-keyword bullet not capped near 210, got', noKwLen); process.exit(1); }
  // short text under the cap is untouched regardless of keyword.
  const untouchedText = 'A short bullet under the cap.';
  const untouched = fns.bulletRenderV2([{ keyword: 'KW', text: untouchedText }], false);
  if (!untouched.includes(untouchedText)) { console.error('HARNESS FAIL: short bullet was altered unnecessarily'); process.exit(1); }

  console.log('HARNESS OK: header font fixed (20pt, no \\Huge), URLs normalized to https:// (schemed URLs left alone), truncateBullet is keyword-aware (longer keyword -> shorter body, combined stays near the 210 ceiling), short bullets untouched');

  // 5. truncateSummary + renderResume slot: eval and confirm hard cap + wiring.
  const rrCode = extractFn(latexCode, 'renderResume');
  if (!rrCode.includes('truncateSummary(content.summary)')) { console.error('HARNESS FAIL: renderResume summary slot not wired to truncateSummary'); process.exit(1); }
  const truncSummaryFn = new Function(extractFn(latexCode, 'truncateSummary') + '\nreturn truncateSummary;')();
  const longSummary = 'A'.repeat(50) + ' ' + 'B'.repeat(50) + ' ' + 'C'.repeat(50) + ' ' + 'D'.repeat(200);
  const trimmed = truncSummaryFn(longSummary);
  if (trimmed.length > 194) { console.error('HARNESS FAIL: truncateSummary did not cap near 190, got length', trimmed.length); process.exit(1); }
  if (!trimmed.endsWith('...')) { console.error('HARNESS FAIL: truncated summary must end with ellipsis'); process.exit(1); }
  const shortSummary = 'A concise two sentence summary that stays well under the cap for this candidate.';
  if (truncSummaryFn(shortSummary) !== shortSummary) { console.error('HARNESS FAIL: short summary must be returned unchanged'); process.exit(1); }

  console.log('HARNESS OK: truncateSummary hard-caps near 190 chars with ellipsis, short summaries pass through unchanged, wired into renderResume\'s summary slot');

  // 6. Twin identity preserved.
  {
    let a2 = N['Assemble Resume LaTeX'].parameters.jsCode;
    let r2 = N['Assemble Regen'].parameters.jsCode;
    if (!a2.includes('normalizeUrl')) { for (const [, o, nw] of NODE_EDITS) { a2 = a2.split(o).join(nw); r2 = r2.split(o).join(nw); } }
    if (a2 !== r2) { console.error('HARNESS FAIL: Assemble twins would diverge after patch'); process.exit(1); }
  }
})();

TARGETS.forEach(patch);
console.log('S47 (real-world live-apply fixes: header size, page overflow, bullet wrap, summary length, dead links) complete.');
