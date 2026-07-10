/**
 * s59_databricks_apply_fixes.js -- 5 real bugs found from a live Databricks FDE
 * apply (exec id 325), root-caused with real execution data + a 4-agent
 * investigation workflow + direct forensic follow-up. Two other reported
 * symptoms (missing Vaandu context, wrong fMRI accuracy %) turned out to be
 * STALE MASTER DATA, not code bugs -- confirmed by reading the bot's actual
 * stored /data/user-data/resume_structured.json directly, uploaded 2026-07-06,
 * predating the user's current resume edits. No code change fixes those; the
 * user needs to re-upload via /setup.
 *
 * 1. (Root cause of the 2-page overflow + most of the ellipsis truncation.)
 *    s51's adaptive count-table allocator (Parse Pass1's selectAndShape) was
 *    never re-validated against the REAL, pdflatex-calibrated lineBudget
 *    numbers from s43 -- which are still sitting unused in TIER_PLANS.sections
 *    (Build Pass1 Context) the whole time. Confirmed by exact math: mid tier's
 *    4-experience shape [3,3,2,2] + 2-project shape [2,2] = 14 bullets = 28
 *    projected lines, against a calibrated budget of 16 (exp) + 6 (proj) = 22
 *    lines -- a 27% overshoot, more than enough to spill a 2nd page. Parse
 *    Pass1 now trims lowest-priority bullets (protecting mandatory/most-recent
 *    entries down to a floor of 2, everything else down to a floor of 1) until
 *    each pool's projected line count actually fits its calibrated budget.
 *
 * 2. Pass2 was told an "~210 combined character absolute hard ceiling" but
 *    real bullets from this apply landed at 223-225 combined chars -- ~15
 *    over, enough to trigger truncateBullet's last-resort ellipsis on 3 of 14
 *    bullets in one resume (should be rare, not 21%). Tightened the stated
 *    target from 130-165 -> 130-155 chars (more headroom against overshoot)
 *    and reworded the ceiling language to state the actual visible
 *    consequence (mid-sentence "..." cutoff) instead of an abstract number.
 *
 * 3. Build Cover LaTeX's {{LINKEDIN}} substitution never got the normalizeUrl()
 *    treatment s47 added to the resume path -- a bare-domain LinkedIn URL
 *    (no https://) produces a malformed \href target in the cover letter,
 *    non-clickable in most PDF viewers. (The resume header's own LinkedIn/
 *    GitHub/Portfolio links were independently audited and found correctly
 *    wired end-to-end -- confirmed NOT a code bug, likely a PDF-preview
 *    artifact; verify by opening the actual delivered resume PDF in a real
 *    reader, not Telegram's inline thumbnail.)
 *
 * 4. Pass1's LLM invented a graduation date ("2024") that matches neither the
 *    master data's real end_date (2023-12) nor the requested "<MMM YYYY>"
 *    format. resume_structured.education (already threaded into the Assemble
 *    twins since s50's title-integrity work) has the correct raw date the
 *    whole time -- added an analogous backstop that resolves graduationDate
 *    from the master record by institution match, same idiom as
 *    resolveMasterExperienceTitleV2.
 *
 * 5. Two INDEPENDENT LLM generations (original Pass2 and the ATS-retry Pass2
 *    Regen, confirmed genuinely separate calls via different `improvements`
 *    lists) both attributed "LoRA fine-tuning, model quantization (GPTQ/AWQ)"
 *    to the CareerForge project -- but those techniques appear only in the
 *    candidate's cross-cutting SUMMARY material and in a DIFFERENT project
 *    (NJIT's own LoRA fine-tuning bullet), never in CareerForge's own source
 *    excerpts. Added an explicit grounding rule to Pass2 Generate/Regen's
 *    shared system prompt forbidding cross-entry content bleed.
 *
 * No node count change. Run: inside the n8n container with the repo staged
 * under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Parse Pass1: page-fit reconciliation against the real calibrated lineBudget ═══
const PP1_OLD =
  "  let maxB = 1;\n" +
  "  const scan = (tbl) => { if (!tbl) return; for (const k of Object.keys(tbl)) { for (const v of (tbl[k] || [])) { if (v > maxB) maxB = v; } } };";
const PP1_NEW =
  "  // s59: s51's shape tables were never re-validated against the real,\n" +
  "  // pdflatex-calibrated lineBudget numbers that still live unused in\n" +
  "  // _plan.sections (Build Pass1 Context / TIER_PLANS) -- trim lowest-\n" +
  "  // priority bullets first until each pool's projected lines fit its\n" +
  "  // calibrated budget. Mandatory (most-recent/longest-tenure) entries are\n" +
  "  // protected down to a floor of 2 bullets; everything else down to 1.\n" +
  "  const trimToLineBudget = (items, lineBudget) => {\n" +
  "    if (!lineBudget || !items.length) return;\n" +
  "    const live = items.filter((i) => (alloc[i.id] || 0) > 0);\n" +
  "    if (!live.length) return;\n" +
  "    const lowestFirst = rankItems(live).slice().reverse();\n" +
  "    const totalLines = () => live.reduce((sum, i) => sum + (alloc[i.id] || 0) * lpb, 0);\n" +
  "    let guard = 0;\n" +
  "    while (totalLines() > lineBudget && guard < 200) {\n" +
  "      guard++;\n" +
  "      let trimmed = false;\n" +
  "      for (const i of lowestFirst) {\n" +
  "        const floor = i.mandatory ? 2 : 1;\n" +
  "        if ((alloc[i.id] || 0) > floor) { alloc[i.id]--; if (i.ref) i.ref.bulletCount = alloc[i.id]; trimmed = true; break; }\n" +
  "      }\n" +
  "      if (!trimmed) break;\n" +
  "    }\n" +
  "  };\n" +
  "  const _sec = _plan.sections || {};\n" +
  "  if (cp.experience && effectiveOrder.indexOf('experience') !== -1) trimToLineBudget(expItems, _sec.experience && _sec.experience.lineBudget);\n" +
  "  if (cp.internships && effectiveOrder.indexOf('internships') !== -1) trimToLineBudget(internItems, _sec.internships && _sec.internships.lineBudget);\n" +
  "  if (cp.projects && effectiveOrder.indexOf('projects') !== -1) trimToLineBudget(projItems, _sec.projects && _sec.projects.lineBudget);\n" +
  "\n" +
  "  let maxB = 1;\n" +
  "  const scan = (tbl) => { if (!tbl) return; for (const k of Object.keys(tbl)) { for (const v of (tbl[k] || [])) { if (v > maxB) maxB = v; } } };";

// ═══ 2a. Build Pass1 Context: tighten the mid/senior char target for more truncation headroom ═══
const BP1C_OLD =
  "const STYLE_2LINE = {\n" +
  "  linesPerBullet: 2, targetChars: [130, 165],\n" +
  "  directive: 'Impact-and-scope style: each bullet 130-165 characters BEFORE the bold keyword lead-in (~2 printed lines total including the keyword): action verb + system/scope + technology + quantified outcome. Do not write bullets under 110 characters.'\n" +
  "};";
const BP1C_NEW =
  "const STYLE_2LINE = {\n" +
  "  linesPerBullet: 2, targetChars: [130, 155],\n" +
  "  directive: 'Impact-and-scope style: each bullet 130-155 characters BEFORE the bold keyword lead-in (~2 printed lines total including the keyword): action verb + system/scope + technology + quantified outcome. Do not write bullets under 110 characters.'\n" +
  "};";

// ═══ 2b. Pass2 Generate + Pass2 Regen: vivid truncation-consequence framing ═══
const PASS2_TRUNC_OLD = "Absolute hard ceiling ~210 combined characters (keyword + body) — anything longer gets truncated at a word boundary downstream.";
const PASS2_TRUNC_NEW = "HARD ceiling 210 combined characters (keyword + body) — bullets over this get cut off mid-sentence with \"...\" in the delivered PDF, which reads as broken and unprofessional. When in doubt, write SHORTER: a clean 145-character bullet beats a cut-off 200-character one every time.";

// ═══ 5. Pass2 Generate + Pass2 Regen: forbid cross-entry content bleed ═══
const PASS2_GROUND_OLD = "Use the verbatim excerpts as your SOLE source for content — do NOT invent achievements, metrics, or technologies not present in the excerpts.";
const PASS2_GROUND_NEW = "Use the verbatim excerpts as your SOLE source for content — do NOT invent achievements, metrics, or technologies not present in the excerpts. Each bullet must be grounded ONLY in that specific position's or project's OWN excerpts — never pull a tool, technique, or claim from a DIFFERENT position/project's excerpts, or from the candidate's general SUMMARY material, into an entry that didn't actually use it, even if it sounds plausible or the candidate has that skill elsewhere.";

// ═══ 3. Build Cover LaTeX: normalizeUrl the LinkedIn link ═══
const COVER_OLD = "fullLatex = fullLatex.replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate')).replace('{{PHONE}}', escapeLatexText(personal.phone_display || personal.phone_primary || '')).replaceAll('{{EMAIL}}', personal.email || '').replace('{{LINKEDIN}}', personal.linkedin || '');";
const COVER_NEW =
  "function normalizeUrlCoverV2(u) { u = String(u == null ? '' : u).trim(); if (!u) return ''; return /^https?:\\/\\//i.test(u) ? u : 'https://' + u; }\n" +
  "fullLatex = fullLatex.replace('{{NAME}}', escapeLatexText(personal.name || 'Candidate')).replace('{{PHONE}}', escapeLatexText(personal.phone_display || personal.phone_primary || '')).replaceAll('{{EMAIL}}', personal.email || '').replace('{{LINKEDIN}}', normalizeUrlCoverV2(personal.linkedin || ''));";

// ═══ 4. Assemble Resume LaTeX + Assemble Regen: education graduationDate backstop ═══
const MASTERROWS_OLD = "const masterRows = masterExperienceRowsV2();";
const MASTERROWS_NEW =
  "const masterRows = masterExperienceRowsV2();\n" +
  "  // s59: education-date backstop, same idiom as the title-integrity backstop\n" +
  "  // above -- Pass1's LLM invented \"2024\" for a real end_date of 2023-12 on a\n" +
  "  // real live apply. resume_structured.education (threaded in since s50) has\n" +
  "  // the correct raw date; resolve graduationDate from it instead of trusting\n" +
  "  // Pass1's own text output.\n" +
  "  function masterEducationRowsV2() {\n" +
  "    let r = {};\n" +
  "    try { r = ($('Prepare Apply Context').first().json || {}).resume_structured || {}; } catch (e) { r = {}; }\n" +
  "    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];\n" +
  "    const fmt = (e) => {\n" +
  "      const src = e.end_date || e.start_date;\n" +
  "      if (!src) return '';\n" +
  "      const m = String(src).match(/^(\\d{4})-(\\d{2})/);\n" +
  "      if (!m) return String(src);\n" +
  "      const mon = MONTHS[parseInt(m[2], 10) - 1] || '';\n" +
  "      return (mon ? mon + ' ' : '') + m[1] + (e.is_current ? ' (Expected)' : '');\n" +
  "    };\n" +
  "    return (Array.isArray(r.education) ? r.education : []).map((e) => ({ institutionKey: normKeyV2(e.institution || ''), formattedDate: fmt(e) }));\n" +
  "  }\n" +
  "  function resolveMasterGraduationDateV2(edu, rows) {\n" +
  "    const fallback = edu.graduationDate || '';\n" +
  "    if (!rows.length) return fallback;\n" +
  "    const key = normKeyV2(edu.institution || '');\n" +
  "    const match = rows.find((row) => row.institutionKey && key && row.institutionKey === key);\n" +
  "    return (match && match.formattedDate) || fallback;\n" +
  "  }\n" +
  "  const masterEduRows = masterEducationRowsV2();";

const EDU_RETURN_OLD = "education: pass1.education || [],";
const EDU_RETURN_NEW = "education: (pass1.education || []).map((edu) => Object.assign({}, edu, { graduationDate: resolveMasterGraduationDateV2(edu, masterEduRows) })),";

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

  for (const need of ['Parse Pass1', 'Build Pass1 Context', 'Build Cover LaTeX', 'Assemble Resume LaTeX', 'Assemble Regen', 'Pass2 Generate', 'Pass2 Regen']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Parse Pass1'].parameters.jsCode.includes('s59: s51\'s shape tables')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Parse Pass1'].parameters, 'jsCode', PP1_OLD, PP1_NEW, 'page-fit trim', base);
  replaceOnce(N['Build Pass1 Context'].parameters, 'jsCode', BP1C_OLD, BP1C_NEW, 'STYLE_2LINE tighten', base);
  replaceOnce(N['Build Cover LaTeX'].parameters, 'jsCode', COVER_OLD, COVER_NEW, 'cover LinkedIn normalizeUrl', base);
  for (const assembleName of ['Assemble Resume LaTeX', 'Assemble Regen']) {
    replaceOnce(N[assembleName].parameters, 'jsCode', MASTERROWS_OLD, MASTERROWS_NEW, `${assembleName} education backstop fns`, base);
    replaceOnce(N[assembleName].parameters, 'jsCode', EDU_RETURN_OLD, EDU_RETURN_NEW, `${assembleName} education return`, base);
  }
  for (const pass2Name of ['Pass2 Generate', 'Pass2 Regen']) {
    replaceOnce(N[pass2Name].parameters.messages.messageValues[0], 'message', PASS2_GROUND_OLD, PASS2_GROUND_NEW, `${pass2Name} grounding rule`, base);
    replaceOnce(N[pass2Name].parameters.messages.messageValues[0], 'message', PASS2_TRUNC_OLD, PASS2_TRUNC_NEW, `${pass2Name} truncation framing`, base);
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Databricks-apply fixes applied -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. Page-fit trim: reproduces the EXACT real Databricks-apply shape (mid tier,
  // 4 experiences [3,3,2,2]=10 bullets, 2 projects [2,2]=4 bullets) and confirms
  // the trim converges to the real s43-calibrated budget (exp<=16, proj<=6 lines).
  {
    const rankItems = (items) => items.slice().sort((a, b) =>
      (b.mostRecentFlag - a.mostRecentFlag) || (b.relevance - a.relevance) || ((b.endTs == null ? -Infinity : b.endTs) - (a.endTs == null ? -Infinity : a.endTs)) || (b.tenure - a.tenure));
    const lpb = 2;
    const alloc = { njit: 3, bayer: 3, jerseystem: 2, dassault: 2, careerforge: 2, prometheusai: 2 };
    const expItems = [
      { id: 'njit', ref: {}, relevance: 90, endTs: 4, tenure: 12, mostRecentFlag: 1, mandatory: true },
      { id: 'bayer', ref: {}, relevance: 85, endTs: 3, tenure: 3, mostRecentFlag: 0, mandatory: false },
      { id: 'jerseystem', ref: {}, relevance: 60, endTs: 2, tenure: 9, mostRecentFlag: 0, mandatory: false },
      { id: 'dassault', ref: {}, relevance: 55, endTs: 1, tenure: 27, mostRecentFlag: 0, mandatory: false },
    ];
    const projItems = [
      { id: 'careerforge', ref: {}, relevance: 90, endTs: null, tenure: 0, mostRecentFlag: 0, mandatory: false },
      { id: 'prometheusai', ref: {}, relevance: 80, endTs: null, tenure: 0, mostRecentFlag: 0, mandatory: false },
    ];
    const trimToLineBudget = new Function('alloc', 'rankItems', 'lpb', 'items', 'lineBudget',
      PP1_NEW.split('\n').slice(6, 23).join('\n') + '\n  trimToLineBudget(items, lineBudget);'
    );
    trimToLineBudget(alloc, rankItems, lpb, expItems, 16);
    trimToLineBudget(alloc, rankItems, lpb, projItems, 6);
    const expLines = (alloc.njit + alloc.bayer + alloc.jerseystem + alloc.dassault) * lpb;
    const projLines = (alloc.careerforge + alloc.prometheusai) * lpb;
    if (expLines > 16) { console.error('HARNESS FAIL: experience still exceeds the calibrated 16-line budget', expLines, alloc); process.exit(1); }
    if (projLines > 6) { console.error('HARNESS FAIL: projects still exceeds the calibrated 6-line budget', projLines, alloc); process.exit(1); }
    if (alloc.njit < 2) { console.error('HARNESS FAIL: mandatory njit entry trimmed below its protected floor of 2', alloc); process.exit(1); }
    if (expLines + projLines !== 22) { console.error('HARNESS FAIL: expected the trim to converge exactly to the original 22-line s43 total for this shape', expLines + projLines, alloc); process.exit(1); }
  }
  console.log('HARNESS OK: page-fit trim converges the real Databricks-apply shape (10 exp + 4 proj bullets, 28 lines) down to the calibrated 22-line budget (16 exp + 6 proj), mandatory entry protected at floor 2');

  // 2. STYLE_2LINE tightened, truncation framing states the real consequence.
  {
    if (!BP1C_NEW.includes('[130, 155]')) { console.error('HARNESS FAIL: targetChars not tightened'); process.exit(1); }
    if (!PASS2_TRUNC_NEW.includes('cut off mid-sentence')) { console.error('HARNESS FAIL: truncation framing missing the vivid consequence'); process.exit(1); }
  }
  console.log('HARNESS OK: mid/senior char target tightened to 130-155, truncation framing states the real "..." consequence');

  // 3. Cover LinkedIn: normalizeUrlCoverV2 behaves like the resume path's normalizeUrl.
  {
    const fn = new Function(COVER_NEW.split('\n')[0] + '\nreturn normalizeUrlCoverV2;')();
    if (fn('linkedin.com/in/x') !== 'https://linkedin.com/in/x') { console.error('HARNESS FAIL: bare domain not normalized', fn('linkedin.com/in/x')); process.exit(1); }
    if (fn('https://linkedin.com/in/x') !== 'https://linkedin.com/in/x') { console.error('HARNESS FAIL: already-schemed URL was altered', fn('https://linkedin.com/in/x')); process.exit(1); }
    if (fn('') !== '') { console.error('HARNESS FAIL: empty input should stay empty'); process.exit(1); }
  }
  console.log('HARNESS OK: Build Cover LaTeX\'s LinkedIn link now gets the same https:// normalization the resume path already had');

  // 4. Education graduationDate backstop: resolves the real 2023-12 end_date, falls back safely when no match.
  {
    const normKeyV2 = (value) => String(value == null ? '' : value).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    const $ = (name) => ({ first: () => ({ json: { resume_structured: { education: [{ institution: 'New Jersey Institute of Technology', end_date: '2023-12', is_current: false }] } } }) });
    const fnsSrc = MASTERROWS_NEW.split('\n').slice(1).join('\n');
    const build = new Function('$', 'normKeyV2', fnsSrc + '\nreturn { masterEduRows, resolveMasterGraduationDateV2 };')($, normKeyV2);
    const resolved = build.resolveMasterGraduationDateV2({ institution: 'New Jersey Institute of Technology', graduationDate: '2024' }, build.masterEduRows);
    if (resolved !== 'Dec 2023') { console.error('HARNESS FAIL: expected the real Dec 2023 end_date to win over the LLM\'s invented 2024', resolved); process.exit(1); }
    const noMatch = build.resolveMasterGraduationDateV2({ institution: 'Some Other School', graduationDate: 'May 2019' }, build.masterEduRows);
    if (noMatch !== 'May 2019') { console.error('HARNESS FAIL: no-match case should fall back to Pass1\'s own value, not blank it', noMatch); process.exit(1); }
  }
  console.log('HARNESS OK: education graduationDate backstop resolves the real 2023-12 end_date (Dec 2023) over Pass1\'s invented "2024", falls back safely on no institution match');

  // 5. Grounding rule present and specific to cross-entry bleed.
  {
    if (!PASS2_GROUND_NEW.includes('grounded ONLY in that specific position')) { console.error('HARNESS FAIL: grounding rule missing or too generic'); process.exit(1); }
    if (!PASS2_GROUND_NEW.includes('SUMMARY material')) { console.error('HARNESS FAIL: grounding rule does not cover the summary-bleed case actually observed'); process.exit(1); }
  }
  console.log('HARNESS OK: Pass2 Generate/Regen grounding rule explicitly forbids pulling SUMMARY or other-entry content into an unrelated bullet');
})();

TARGETS.forEach(patch);
console.log('S59 (Databricks-apply fixes: page-fit trim, truncation tightening, cover LinkedIn link, education-date backstop, cross-entry grounding rule) complete.');
