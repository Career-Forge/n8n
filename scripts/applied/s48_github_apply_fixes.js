/**
 * s48_github_apply_fixes.js -- 4 fixes from the second live apply (a real
 * GitHub/jibeapply application), each root-caused against the actual
 * execution data (exec 251) before writing this:
 *
 * 1. "at unknown" captions + junky job_title. jibeapply.com isn't in
 *    Retrieve Job's URL-slug map and the page metadata gave "Machine
 *    Learning Engineer in Ontario, Canada" -- while Parse Step0 correctly
 *    extracted companyName "GitHub" / roleName "Machine Learning Engineer"
 *    and NOTHING consumed it. Fix: backfill display fields from Step0
 *    wherever it has already executed (Send Resume PDF caption/filename,
 *    Store Apply Context for track/status/revise), using the F1-era
 *    isExecuted-ternary pattern in expressions and try/catch in Code nodes.
 *    The cover branch completes BEFORE Step0 runs (verified in execution
 *    order), so Send Cover PDF instead backfills from its own branch's
 *    Parse Cover Pass1 output (extractedCompany/extractedRole) -- enabled by
 *    fix 2.
 *
 * 2. Cover Pass1's R2-era "echo company VERBATIM" rule faithfully echoed
 *    'unknown' into extractedCompany. The letter only said "GitHub" because
 *    the LLM disobeyed the rule -- lucky, not designed. Fix: one explicit
 *    exception -- when the provided company is 'unknown'/empty, derive it
 *    from the JD text.
 *
 * 3. s42 regression: Parse Personal Info's ## SUMMARY / ## ACHIEVEMENTS
 *    sections never reach Pass1 because Select Relevant Resume Bubbles
 *    OVERWRITES resume_text with its own bubble-compact evidence text
 *    downstream (verified: exec 251's pass1_user contains neither heading,
 *    despite the master resume holding 9 summary bullets + 6 achievements).
 *    The generated summaries were being invented from the JD instead of
 *    sourced, and the achievements section structurally could not render.
 *    Fix: surface both sections in the evidence text this node builds
 *    (conditionally -- Pass1's plan rules key off the headings existing),
 *    early in the document so the 6500-char cap can't cut them (cap also
 *    raised to 8000).
 *
 * 4. Visible truncation artifacts: ~half the rendered bullets ended in
 *    "..." ("using PyTorch and...") because the LLM chronically overshoots
 *    its char target and the s47 safety net always ellipsizes. Fix: cut at
 *    the last CLAUSE boundary (comma/semicolon past 55% of budget) with no
 *    ellipsis -- reads as a complete thought -- falling back to the old
 *    word-boundary+ellipsis only when no clause boundary exists; both paths
 *    now also drop a dangling connector word ("and", "with", "by"...).
 *    truncateSummary prefers a full SENTENCE boundary ('. ') first. Plus:
 *    both escapers (escapeLatexTextV2 in the 3 resume LaTeX nodes AND Build
 *    Cover LaTeX's own escapeLatexText) now transliterate accents via NFKD
 *    (Systèmes -> Systemes) instead of deleting the character (-> Systmes)
 *    or passing raw UTF-8 to pdflatex.
 *
 * export_prompts.js anchors: escapeLatexTextV2 / truncateBullet /
 * truncateSummary keep their start+end anchors -- no checker change needed.
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

// ═══ 1a. Select Relevant Resume Bubbles: surface summary/achievements in evidenceText ═══
const SRRB_OLD =
  "const evidenceText = [\n" +
  "  '## Candidate profile',\n" +
  "  Object.entries(profile).filter(([_, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\\n'),\n" +
  "  '',\n";
const SRRB_NEW =
  "const evidenceText = [\n" +
  "  '## Candidate profile',\n" +
  "  Object.entries(profile).filter(([_, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\\n'),\n" +
  "  '',\n" +
  "  // s48: surface master summary_bullets/achievements here -- Parse Personal Info's\n" +
  "  // s42 fix was invisible to Pass1 because THIS node overwrites resume_text.\n" +
  "  // Conditional: Pass1's plan rules key off these exact headings existing.\n" +
  "  ...(arr(r.summary_bullets).length ? ['## SUMMARY (master summary bullets -- sole source material for the professional summary)', arr(r.summary_bullets).slice(0, 9).map(b => '- ' + b).join('\\n'), ''] : []),\n" +
  "  ...(arr(r.achievements).length ? ['## ACHIEVEMENTS (verbatim -- the achievements section may ONLY use entries from this list)', arr(r.achievements).slice(0, 8).map(a => '- ' + a).join('\\n'), ''] : []),\n";

const SRRB_CAP_OLD = "].join('\\n').slice(0, 6500);";
const SRRB_CAP_NEW = "].join('\\n').slice(0, 8000);";

// ═══ 1b. Send Resume PDF: backfill from Step0 (runs after Step0 in the resume branch) ═══
const R_TITLE = "(($('Prepare Apply Context').first().json.job_number === 0 && $('Parse Step0').isExecuted && (($('Parse Step0').first().json.step0 || {}).roleName || '')) ? $('Parse Step0').first().json.step0.roleName : $('Prepare Apply Context').first().json.job_title)";
const R_COMPANY = "(($('Prepare Apply Context').first().json.company === 'unknown' && $('Parse Step0').isExecuted && (($('Parse Step0').first().json.step0 || {}).companyName || '')) ? $('Parse Step0').first().json.step0.companyName : $('Prepare Apply Context').first().json.company)";

const RESUME_CAPTION_OLD = "={{ '\\u2705 Resume \\u2014 ' + $('Prepare Apply Context').first().json.job_title + ' at ' + $('Prepare Apply Context').first().json.company + ' (ForgeScore: ' + $('Prepare Apply Context').first().json.overall_score + '/10)' }}";
const RESUME_CAPTION_NEW = "={{ '\\u2705 Resume \\u2014 ' + " + R_TITLE + " + ' at ' + " + R_COMPANY + " + ' (ForgeScore: ' + $('Prepare Apply Context').first().json.overall_score + '/10)' }}";
const RESUME_FILENAME_OLD = "={{ $('Prepare Apply Context').first().json.company.replace(/\\s+/g, '_') + '_' + $('Prepare Apply Context').first().json.job_title.replace(/\\s+/g, '_') + '_resume_' + $now.format('yyyyMMdd') + '.pdf' }}";
const RESUME_FILENAME_NEW = "={{ " + R_COMPANY + ".replace(/\\s+/g, '_') + '_' + " + R_TITLE + ".replace(/\\s+/g, '_') + '_resume_' + $now.format('yyyyMMdd') + '.pdf' }}";

// ═══ 1c. Send Cover PDF: backfill from Parse Cover Pass1 (same branch, already executed) ═══
const C_TITLE = "(($('Prepare Apply Context').first().json.job_number === 0 && $('Parse Cover Pass1').isExecuted && (($('Parse Cover Pass1').first().json.cover1 || {}).extractedRole || '')) ? $('Parse Cover Pass1').first().json.cover1.extractedRole : $('Prepare Apply Context').first().json.job_title)";
const C_COMPANY = "(($('Prepare Apply Context').first().json.company === 'unknown' && $('Parse Cover Pass1').isExecuted && ((($('Parse Cover Pass1').first().json.cover1 || {}).extractedCompany || '') !== 'unknown') && (($('Parse Cover Pass1').first().json.cover1 || {}).extractedCompany || '')) ? $('Parse Cover Pass1').first().json.cover1.extractedCompany : $('Prepare Apply Context').first().json.company)";

const COVER_CAPTION_OLD = "={{ '\\u2705 Cover Letter \\u2014 ' + $('Prepare Apply Context').first().json.job_title + ' at ' + $('Prepare Apply Context').first().json.company }}";
const COVER_CAPTION_NEW = "={{ '\\u2705 Cover Letter \\u2014 ' + " + C_TITLE + " + ' at ' + " + C_COMPANY + " }}";
const COVER_FILENAME_OLD = "={{ $('Prepare Apply Context').first().json.company.replace(/\\s+/g, '_') + '_' + $('Prepare Apply Context').first().json.job_title.replace(/\\s+/g, '_') + '_cover_' + $now.format('yyyyMMdd') + '.pdf' }}";
const COVER_FILENAME_NEW = "={{ " + C_COMPANY + ".replace(/\\s+/g, '_') + '_' + " + C_TITLE + ".replace(/\\s+/g, '_') + '_cover_' + $now.format('yyyyMMdd') + '.pdf' }}";

// ═══ 1d. Store Apply Context: backfill the stored context (track/status/score/revise) ═══
const SAC_OLD = "const ctx = $('Prepare Apply Context').first().json;\n";
const SAC_NEW =
  "const ctx = $('Prepare Apply Context').first().json;\n" +
  "// s48: backfill display identity from Step0's JD extraction when the URL-paste\n" +
  "// path produced 'unknown'/scrape-junk (Step0 always runs before this node).\n" +
  "try {\n" +
  "  const s0 = ($('Parse Step0').first().json || {}).step0 || {};\n" +
  "  if ((!ctx.company || ctx.company === 'unknown') && s0.companyName) ctx.company = s0.companyName;\n" +
  "  if (ctx.job_number === 0 && s0.roleName) ctx.job_title = s0.roleName;\n" +
  "} catch (e) {}\n";

// ═══ 2. Cover Pass1 prompt: unknown-company exception ═══
const COVER_PROMPT_OLD = "use them VERBATIM for extractedCompany/extractedRole/tier in your output. Do NOT re-derive them from the JD text, and do NOT second-guess the provided tier.";
const COVER_PROMPT_NEW = "use them VERBATIM for extractedCompany/extractedRole/tier in your output. Do NOT re-derive them from the JD text, and do NOT second-guess the provided tier. ONE exception: if the provided company is 'unknown' or empty, extract the real company name from the JD text for extractedCompany (and likewise derive extractedRole if the provided role is empty or reads like a page title rather than a job title).";

// ═══ 3. Escapers: NFKD transliteration instead of deletion ═══
const ESC_V2_OLD =
  "function escapeLatexTextV2(value) {\n" +
  "  let s = String(value == null ? '' : value);\n";
const ESC_V2_NEW =
  "function escapeLatexTextV2(value) {\n" +
  "  let s = String(value == null ? '' : value);\n" +
  "  s = s.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '');\n";

const ESC_COVER_OLD =
  "function escapeLatexText(input) {\n" +
  "  if (typeof input !== 'string') return '';\n" +
  "  return input.replace(";
const ESC_COVER_NEW =
  "function escapeLatexText(input) {\n" +
  "  if (typeof input !== 'string') return '';\n" +
  "  input = input.normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '');\n" +
  "  return input.replace(";

// ═══ 4. Clause-boundary truncation ═══
const TRUNC_BULLET_OLD =
  "function truncateBullet(t, reserve) {\n" +
  "  t = String(t == null ? '' : t).trim();\n" +
  "  const SAFE_TOTAL = 210; // real-pdflatex-verified combined (keyword+body) 2-line ceiling\n" +
  "  const MAX = Math.max(60, SAFE_TOTAL - (reserve || 0));\n" +
  "  if (t.length <= MAX) return t;\n" +
  "  const cut = t.slice(0, MAX);\n" +
  "  const sp = cut.lastIndexOf(' ');\n" +
  "  const base = (sp > MAX - 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\\s]+$/, '');\n" +
  "  return base + '...';\n" +
  "}";
const TRUNC_BULLET_NEW =
  "function truncateBullet(t, reserve) {\n" +
  "  t = String(t == null ? '' : t).trim();\n" +
  "  const SAFE_TOTAL = 210; // real-pdflatex-verified combined (keyword+body) 2-line ceiling\n" +
  "  const MAX = Math.max(60, SAFE_TOTAL - (reserve || 0));\n" +
  "  if (t.length <= MAX) return t;\n" +
  "  const cut = t.slice(0, MAX);\n" +
  "  const bal = (s) => { let d = 0; for (let k = 0; k < s.length; k++) { if (s[k] === '(') d++; else if (s[k] === ')') d--; } return d === 0; };\n" +
  "  const floor = Math.floor(MAX * 0.55);\n" +
  "  // Prefer a clean clause end (a balanced ')' or a comma/semicolon OUTSIDE any\n" +
  "  // parenthetical) -- reads as a complete thought, no ellipsis needed.\n" +
  "  for (let i = cut.length - 1; i > floor; i--) {\n" +
  "    const ch = cut[i];\n" +
  "    if (ch === ')' && bal(cut.slice(0, i + 1))) return cut.slice(0, i + 1);\n" +
  "    if ((ch === ',' || ch === ';') && bal(cut.slice(0, i))) {\n" +
  "      return cut.slice(0, i).replace(/\\s+(and|or|with|for|to|of|by|in|on|at|via|across|the|a|an|using)$/i, '').replace(/[,;:.\\s]+$/, '');\n" +
  "    }\n" +
  "  }\n" +
  "  const sp = cut.lastIndexOf(' ');\n" +
  "  let base = cut.slice(0, sp > MAX - 30 ? sp : MAX);\n" +
  "  if (!bal(base) && base.lastIndexOf('(') > 0) base = base.slice(0, base.lastIndexOf('('));\n" +
  "  base = base.replace(/\\s+(and|or|with|for|to|of|by|in|on|at|via|across|the|a|an|using)$/i, '').replace(/[,;:.\\s]+$/, '');\n" +
  "  return base + '...';\n" +
  "}";

const TRUNC_SUMMARY_OLD =
  "function truncateSummary(t) {\n" +
  "  t = String(t == null ? '' : t).trim();\n" +
  "  const MAX = 190; // real-pdflatex-verified: holds at exactly 2 lines up to ~206 chars\n" +
  "  if (t.length <= MAX) return t;\n" +
  "  const cut = t.slice(0, MAX);\n" +
  "  const sp = cut.lastIndexOf(' ');\n" +
  "  const base = (sp > MAX - 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\\s]+$/, '');\n" +
  "  return base + '...';\n" +
  "}";
const TRUNC_SUMMARY_NEW =
  "function truncateSummary(t) {\n" +
  "  t = String(t == null ? '' : t).trim();\n" +
  "  const MAX = 190; // real-pdflatex-verified: holds at exactly 2 lines up to ~206 chars\n" +
  "  if (t.length <= MAX) return t;\n" +
  "  const cut = t.slice(0, MAX);\n" +
  "  const period = cut.lastIndexOf('. ');\n" +
  "  if (period > MAX * 0.5) return cut.slice(0, period + 1);\n" +
  "  const bal = (s) => { let d = 0; for (let k = 0; k < s.length; k++) { if (s[k] === '(') d++; else if (s[k] === ')') d--; } return d === 0; };\n" +
  "  const floor = Math.floor(MAX * 0.55);\n" +
  "  for (let i = cut.length - 1; i > floor; i--) {\n" +
  "    const ch = cut[i];\n" +
  "    if ((ch === ',' || ch === ';') && bal(cut.slice(0, i))) return cut.slice(0, i).replace(/[,;:.\\s]+$/, '') + '.';\n" +
  "  }\n" +
  "  const sp = cut.lastIndexOf(' ');\n" +
  "  const base = (sp > MAX - 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\\s]+$/, '');\n" +
  "  return base + '...';\n" +
  "}";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const need of ['Select Relevant Resume Bubbles', 'Send Resume PDF', 'Send Cover PDF', 'Store Apply Context', 'Cover Pass1', 'Build Cover LaTeX', ...LATEX_NODES]) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Select Relevant Resume Bubbles'].parameters.jsCode.includes('## ACHIEVEMENTS (verbatim')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Select Relevant Resume Bubbles'].parameters, 'jsCode', SRRB_OLD, SRRB_NEW, 'SRRB evidenceText', base);
  replaceOnce(N['Select Relevant Resume Bubbles'].parameters, 'jsCode', SRRB_CAP_OLD, SRRB_CAP_NEW, 'SRRB cap', base);

  replaceOnce(N['Send Resume PDF'].parameters.additionalFields, 'caption', RESUME_CAPTION_OLD, RESUME_CAPTION_NEW, 'resume caption', base);
  replaceOnce(N['Send Resume PDF'].parameters.additionalFields, 'fileName', RESUME_FILENAME_OLD, RESUME_FILENAME_NEW, 'resume fileName', base);
  replaceOnce(N['Send Cover PDF'].parameters.additionalFields, 'caption', COVER_CAPTION_OLD, COVER_CAPTION_NEW, 'cover caption', base);
  replaceOnce(N['Send Cover PDF'].parameters.additionalFields, 'fileName', COVER_FILENAME_OLD, COVER_FILENAME_NEW, 'cover fileName', base);

  replaceOnce(N['Store Apply Context'].parameters, 'jsCode', SAC_OLD, SAC_NEW, 'Store Apply Context backfill', base);
  replaceOnce(N['Cover Pass1'].parameters.messages.messageValues[0], 'message', COVER_PROMPT_OLD, COVER_PROMPT_NEW, 'Cover Pass1 verbatim exception', base);
  replaceOnce(N['Build Cover LaTeX'].parameters, 'jsCode', ESC_COVER_OLD, ESC_COVER_NEW, 'cover escaper NFKD', base);

  for (const name of LATEX_NODES) {
    replaceOnce(N[name].parameters, 'jsCode', ESC_V2_OLD, ESC_V2_NEW, `${name} escaper NFKD`, base);
    replaceOnce(N[name].parameters, 'jsCode', TRUNC_BULLET_OLD, TRUNC_BULLET_NEW, `${name} truncateBullet`, base);
    replaceOnce(N[name].parameters, 'jsCode', TRUNC_SUMMARY_OLD, TRUNC_SUMMARY_NEW, `${name} truncateSummary`, base);
  }

  if (N['Assemble Resume LaTeX'].parameters.jsCode !== N['Assemble Regen'].parameters.jsCode) {
    console.error(`INTEGRITY FAIL ${base}: Assemble twins diverged after patch`); process.exit(1);
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: all s48 fixes applied`);
}

// ── harness ──
(function harness() {
  // 1. New truncateBullet: real failing bullets from exec 251 -- clause cut, no ellipsis.
  const truncateBullet = new Function('return ' + TRUNC_BULLET_NEW)();
  {
    // Real bullet that rendered "...using PyTorch and..." live (keyword 'Transformer architecture' = 24+2 reserve)
    const real = 'developed specialized fMRI-to-brain-region mapping model achieving 89% sex classification accuracy validated across 4 cohorts (HCP, Dallas, OASIS, PreventAD) using PyTorch and spatiotemporal deep neural networks';
    const out = truncateBullet(real, 26);
    if (out.endsWith('...')) { console.error('HARNESS FAIL: clause boundary exists but output still ellipsized:', JSON.stringify(out.slice(-60))); process.exit(1); }
    if (!out.endsWith('(HCP, Dallas, OASIS, PreventAD)')) { console.error('HARNESS FAIL: expected cut at the last clause boundary, got:', JSON.stringify(out.slice(-60))); process.exit(1); }
    // No clause boundary at all -> word-boundary + ellipsis, dangling connector dropped
    const noClause = 'A'.repeat(100) + ' works with tools and systems built for very large scale processing on modern hardware every day always'.repeat(3);
    const out2 = truncateBullet(noClause, 0);
    if (!out2.endsWith('...')) { console.error('HARNESS FAIL: no-clause case must keep the ellipsis'); process.exit(1); }
    if (/\s(and|with|by|for|to|of)\.\.\.$/i.test(out2)) { console.error('HARNESS FAIL: dangling connector before ellipsis:', JSON.stringify(out2.slice(-25))); process.exit(1); }
    // Short text untouched
    if (truncateBullet('Short and sweet.', 10) !== 'Short and sweet.') { console.error('HARNESS FAIL: short bullet altered'); process.exit(1); }
  }
  console.log('HARNESS OK: truncateBullet cuts at clause boundary without ellipsis (real exec-251 bullet ends at "(HCP, Dallas, OASIS, PreventAD)"), keeps ellipsis when no clause exists, drops dangling connectors');

  // 2. New truncateSummary: sentence boundary preferred, decimals not mistaken for sentence ends.
  const truncateSummary = new Function('return ' + TRUNC_SUMMARY_NEW)();
  {
    const real = 'Machine Learning Engineer with 6+ years of experience building and deploying agentic AI systems, LLM-powered pipelines, and scalable data solutions across research and industry settings. Proven expertise designing multi-provider orchestration layers and production reliability engineering for enterprise platforms.';
    const out = truncateSummary(real);
    if (out.endsWith('...')) { console.error('HARNESS FAIL: summary with a sentence boundary should not ellipsize:', JSON.stringify(out.slice(-50))); process.exit(1); }
    if (!out.endsWith('settings.')) { console.error('HARNESS FAIL: expected sentence-boundary cut at "settings.", got:', JSON.stringify(out.slice(-40))); process.exit(1); }
    const decimals = ('Improved accuracy by 99.8% across systems handling 1.5M records daily for teams, ' .repeat(4)).slice(0, 250);
    const out2 = truncateSummary(decimals);
    if (/\d\.$/.test(out2.replace(/\.\.\.$/, ''))) { console.error('HARNESS FAIL: cut mid-decimal:', JSON.stringify(out2.slice(-20))); process.exit(1); }
  }
  console.log('HARNESS OK: truncateSummary prefers full-sentence cut (no ellipsis), never cuts at a decimal point');

  // 3. Escapers: accents transliterated, not deleted.
  {
    // Build the full patched V2 escaper from a representative body
    const fullV2 =
      ESC_V2_NEW +
      "  s = s.replace(/[“”]/g, '\"').replace(/[‘’]/g, \"'\");\n" +
      "  s = s.replace(/[^\\x09\\x0A\\x0D\\x20-\\x7E]/g, '');\n" +
      "  return s;\n}";
    const escV2 = new Function(fullV2 + '\nreturn escapeLatexTextV2;')();
    if (escV2('Dassault Systèmes') !== 'Dassault Systemes') { console.error('HARNESS FAIL: V2 escaper should transliterate è->e, got:', JSON.stringify(escV2('Dassault Systèmes'))); process.exit(1); }
    if (escV2('Renée') !== 'Renee') { console.error('HARNESS FAIL: V2 escaper accent transliteration wrong'); process.exit(1); }
  }
  {
    const fullCover = ESC_COVER_NEW + "/\\\\/g, '\\\\textbackslash{}');\n}";
    const escCover = new Function(fullCover + '\nreturn escapeLatexText;')();
    if (escCover('Systèmes') !== 'Systemes') { console.error('HARNESS FAIL: cover escaper should transliterate, got:', JSON.stringify(escCover('Systèmes'))); process.exit(1); }
  }
  console.log('HARNESS OK: both escapers transliterate accents via NFKD (Systèmes -> Systemes, Renée -> Renee) instead of deleting the character');

  // 4. SRRB conditional sections: same spread logic against with/without fixtures.
  {
    const arr = (x) => (Array.isArray(x) ? x : []);
    const build = (r) => [
      '## Candidate profile', 'name: T', '',
      ...(arr(r.summary_bullets).length ? ['## SUMMARY (master summary bullets -- sole source material for the professional summary)', arr(r.summary_bullets).slice(0, 9).map((b) => '- ' + b).join('\n'), ''] : []),
      ...(arr(r.achievements).length ? ['## ACHIEVEMENTS (verbatim -- the achievements section may ONLY use entries from this list)', arr(r.achievements).slice(0, 8).map((a) => '- ' + a).join('\n'), ''] : []),
      '## Matched skills',
    ].join('\n');
    const withBoth = build({ summary_bullets: ['sb1', 'sb2'], achievements: ['won X', 'won Y'] });
    if (!withBoth.includes('## SUMMARY') || !withBoth.includes('## ACHIEVEMENTS') || !withBoth.includes('- won X')) { console.error('HARNESS FAIL: SRRB sections missing when data present'); process.exit(1); }
    const without = build({});
    if (without.includes('## SUMMARY') || without.includes('## ACHIEVEMENTS')) { console.error('HARNESS FAIL: SRRB sections must be absent when master data empty (Pass1 rules key off the headings)'); process.exit(1); }
  }
  console.log('HARNESS OK: SRRB surfaces ## SUMMARY/## ACHIEVEMENTS only when the master data actually has them');

  // 5. Store Apply Context backfill: eval the inserted block with mocked $.
  {
    const block = SAC_NEW.replace("const ctx = $('Prepare Apply Context').first().json;\n", '') + '\nreturn ctx;';
    const run = (ctx, s0available, s0) => new Function('ctx', '$', block)(ctx, (name) => {
      if (name === 'Parse Step0' && s0available) return { first: () => ({ json: { step0: s0 } }) };
      throw new Error('no_execution_data');
    });
    const r1 = run({ company: 'unknown', job_title: 'ML Engineer in Ontario, Canada', job_number: 0 }, true, { companyName: 'GitHub', roleName: 'Machine Learning Engineer' });
    if (r1.company !== 'GitHub' || r1.job_title !== 'Machine Learning Engineer') { console.error('HARNESS FAIL: SAC backfill did not apply:', r1); process.exit(1); }
    const r2 = run({ company: 'Stripe', job_title: 'SWE', job_number: 3 }, true, { companyName: 'WrongCo', roleName: 'WrongRole' });
    if (r2.company !== 'Stripe' || r2.job_title !== 'SWE') { console.error('HARNESS FAIL: SAC backfill must not touch registry jobs:', r2); process.exit(1); }
    const r3 = run({ company: 'unknown', job_title: 'X', job_number: 0 }, false, null);
    if (r3.company !== 'unknown') { console.error('HARNESS FAIL: SAC backfill must degrade gracefully when Step0 missing'); process.exit(1); }
  }
  console.log('HARNESS OK: Store Apply Context backfills GitHub/Machine Learning Engineer from Step0, never touches registry jobs, degrades gracefully without Step0');

  // 6. Expression sanity: new expressions are balanced and guarded.
  for (const [label, expr] of [['resume caption', RESUME_CAPTION_NEW], ['resume fileName', RESUME_FILENAME_NEW], ['cover caption', COVER_CAPTION_NEW], ['cover fileName', COVER_FILENAME_NEW]]) {
    let depth = 0;
    for (const ch of expr) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) break; }
    if (depth !== 0) { console.error(`HARNESS FAIL: unbalanced parens in ${label}`); process.exit(1); }
    if (!expr.includes('.isExecuted')) { console.error(`HARNESS FAIL: ${label} missing isExecuted guard`); process.exit(1); }
  }
  console.log('HARNESS OK: all 4 send-node expressions are paren-balanced and isExecuted-guarded (F1 pattern)');
})();

TARGETS.forEach(patch);
console.log('S48 (GitHub-apply fixes: Step0/Cover backfill, summary+achievements surfacing, clause-boundary truncation, accent transliteration) complete.');
