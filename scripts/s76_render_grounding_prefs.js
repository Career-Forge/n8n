/**
 * s76_render_grounding_prefs.js -- four fixes from the 2026-07-14 live Databricks
 * FDE apply test + the MAANG search post-mortem:
 *
 * (1) ACHIEVEMENTS RENDERER (all 3 LaTeX nodes, V2 + V1 builders): was one
 *     \resumeItem per achievement, full github link included -- 2 items ate 2
 *     wide lines. Now compact-grouped like the user's hand-built resume:
 *     one \resumeItem per CATEGORY ("Hackathon Wins: A $|$ B $|$ C",
 *     "Speaking: X $|$ Y"), links stripped, deterministic keyword
 *     categorization, and LINE-BUDGETED -- items are dropped from the tail of
 *     a category until the estimated physical lines fit the tier plan's
 *     achievements budget (rides in as content._budget.achievementsLines).
 *     Same line budget as before, ~2-3x the content.
 *
 * (2) PROJECT HEADER WIDTH CAP (all 3 LaTeX nodes): the tech-stack line had no
 *     width cap -- real output collided with the right-aligned date
 *     ("...Docker2025 --") and truncated mid-word ("Gradio, a"). New
 *     capTechStackV2(): budget = max(30, 92 - name.length) chars, cut at the
 *     last full comma boundary, never mid-token.
 *
 * (3) COVER LETTER BIOGRAPHICAL GROUNDING (Cover Pass1 + Cover Pass2): the
 *     live FDE cover letter asserted "Based in India" with personal.location
 *     EMPTY in stored data -- derived from the JD's "Remote - India" + the
 *     work-authorization string. Both prompts gain a hard rule: zero claims
 *     about residence/citizenship/authorization/relocation unless the exact
 *     fact appears in provided candidate data.
 *
 * (4) PREFS LOCATION CANONICALIZATION (Handle Prefs Update): the regex
 *     captured whole sentences -- "belagavi and targeting roles in bangalore"
 *     was stored verbatim as location_canonical (root cause of the MAANG
 *     2-results incident, filter side fixed in s75). Now the captured text is
 *     truncated at the first connector word and length-capped, so only a
 *     plausible place string is ever stored. The currently-stored garbled
 *     value is deliberately NOT surgically edited (s75's guard already
 *     neutralized it; the user's next location message replaces it cleanly).
 *
 * Twin discipline: V2 renderer edits are byte-identical across all 3 LaTeX
 * nodes; V1 + mergeContent edits byte-identical across the 2 Assemble twins.
 * Run scripts/export_prompts.js after applying (drift checker + mirrors).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ── (1) Achievements: V2 (renderResume) ──
const ACH_V2_OLD = "slots.achievements = (content.achievements || []).map((a) => itemCmd + '{' + escapeLatexTextV2(firstNonEmpty(a.description, a.title)) + '}').join('\\n');";
const ACH_V2_NEW =
  "slots.achievements = (function () {\n" +
  "    // s76: compact grouped achievements -- one \\resumeItem per CATEGORY,\n" +
  "    // pipe-separated, links stripped, line-budgeted against the tier plan.\n" +
  "    const stripLinks = (s) => String(s || '').replace(/\\s*\\|?\\s*(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/\\S*/gi, '').trim().replace(/[|\\s]+$/, '');\n" +
  "    const catOf = (s) => /\\b(?:\\d+(?:st|nd|rd|th)\\s+place|winner|prize|champion)\\b/i.test(s) ? 'Hackathon Wins'\n" +
  "      : /\\b(?:meetup|conference|talk|presentation|speaker|keynote|demo(?:ed)?)\\b/i.test(s) || /llm day/i.test(s) ? 'Speaking'\n" +
  "      : 'Highlights';\n" +
  "    const groups = { 'Hackathon Wins': [], 'Speaking': [], 'Highlights': [] };\n" +
  "    for (const a of (content.achievements || [])) {\n" +
  "      const txt = stripLinks(firstNonEmpty(a.description, a.title));\n" +
  "      if (txt) groups[catOf(txt)].push(txt);\n" +
  "    }\n" +
  "    const lineBudget = ((content._budget || {}).achievementsLines) || 3;\n" +
  "    const CHARS_PER_LINE = 105;\n" +
  "    const est = (cat, items) => Math.ceil((cat.length + 2 + items.join(' | ').length) / CHARS_PER_LINE);\n" +
  "    // Balanced allocation: every non-empty category keeps >=1 line so a big\n" +
  "    // wins list can never evict Speaking entirely; remainder lines go to the\n" +
  "    // earliest category (wins first).\n" +
  "    const order = ['Hackathon Wins', 'Speaking', 'Highlights'].filter((c) => groups[c].length);\n" +
  "    const per = Math.max(1, Math.floor(lineBudget / Math.max(1, order.length)));\n" +
  "    let extra = Math.max(0, lineBudget - per * order.length);\n" +
  "    const rows = [];\n" +
  "    for (const cat of order) {\n" +
  "      let myBudget = per + (extra > 0 ? 1 : 0);\n" +
  "      if (extra > 0) extra--;\n" +
  "      const items = groups[cat].slice();\n" +
  "      while (items.length > 1 && est(cat, items) > myBudget) items.pop();\n" +
  "      rows.push(itemCmd + '{\\\\textbf{' + escapeLatexTextV2(cat) + ':} ' + items.map((t) => escapeLatexTextV2(t)).join(' $|$ ') + '}');\n" +
  "    }\n" +
  "    return rows.join('\\n');\n" +
  "  })();";

// ── (1b) Achievements: V1 (legacy fallback builder, Assemble twins only) ──
const ACH_V1_OLD = "slots.achievements = (pass1.selectedAchievements || []).map((a) => '\\\\resumeItem{' + escapeLatexText(firstNonEmpty(a.description, a.title)) + '}').join('\\n');";
const ACH_V1_NEW =
  "slots.achievements = (function () {\n" +
  "    // s76: grouped fallback -- mirrors the V2 renderer, fixed 3-line budget.\n" +
  "    const stripLinks = (s) => String(s || '').replace(/\\s*\\|?\\s*(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/\\S*/gi, '').trim().replace(/[|\\s]+$/, '');\n" +
  "    const catOf = (s) => /\\b(?:\\d+(?:st|nd|rd|th)\\s+place|winner|prize|champion)\\b/i.test(s) ? 'Hackathon Wins'\n" +
  "      : /\\b(?:meetup|conference|talk|presentation|speaker|keynote|demo(?:ed)?)\\b/i.test(s) || /llm day/i.test(s) ? 'Speaking'\n" +
  "      : 'Highlights';\n" +
  "    const groups = { 'Hackathon Wins': [], 'Speaking': [], 'Highlights': [] };\n" +
  "    for (const a of (pass1.selectedAchievements || [])) {\n" +
  "      const txt = stripLinks(firstNonEmpty(a.description, a.title));\n" +
  "      if (txt) groups[catOf(txt)].push(txt);\n" +
  "    }\n" +
  "    const rows = [];\n" +
  "    for (const cat of ['Hackathon Wins', 'Speaking', 'Highlights']) {\n" +
  "      if (!groups[cat].length) continue;\n" +
  "      rows.push('\\\\resumeItem{\\\\textbf{' + escapeLatexText(cat) + ':} ' + groups[cat].map((t) => escapeLatexText(t)).join(' $|$ ') + '}');\n" +
  "    }\n" +
  "    return rows.slice(0, 3).join('\\n');\n" +
  "  })();";

// ── (2) Project header cap: helper + call site ──
const RR_FN_OLD = "function renderResume(content, personal, isCompact) {";
const RR_FN_NEW =
  "function capTechStackV2(name, stack) {\n" +
  "  // s76: the project header line is name + stack + right-aligned date; an\n" +
  "  // unbounded stack collides with the date and truncates mid-word. Cap at the\n" +
  "  // last full comma boundary within the width budget.\n" +
  "  const budget = Math.max(30, 92 - String(name || '').length);\n" +
  "  let s = String(stack || '');\n" +
  "  if (s.length <= budget) return s;\n" +
  "  let cut = s.lastIndexOf(',', budget);\n" +
  "  if (cut < 15) cut = budget;\n" +
  "  return s.slice(0, cut).replace(/[\\s,]+$/, '');\n" +
  "}\n" +
  "function renderResume(content, personal, isCompact) {";
const PROJ_V2_OLD = "'} $|$ \\\\emph{' + escapeLatexTextV2(p.techStack) + '}}{'";
const PROJ_V2_NEW = "'} $|$ \\\\emph{' + escapeLatexTextV2(capTechStackV2(p.name, p.techStack)) + '}}{'";

// ── (3) mergeContent: pool cap + achievementsLines in _budget (Assemble twins) ──
const MC_ACH_OLD = "achievements: (pass1.selectedAchievements || []).slice(0, ((pass1._contentPlan || {}).achievementsMax) || 3),";
const MC_ACH_NEW = "achievements: (pass1.selectedAchievements || []).slice(0, 8),";
const MC_BUDGET_OLD = "_budget: pass1._contentPlan ? { tier: pass1._contentPlan.tier, maxBulletsPerEntry: pass1._contentPlan.maxBulletsPerEntry, linesPerBullet: pass1._contentPlan.linesPerBullet } : null,";
const MC_BUDGET_NEW = "_budget: pass1._contentPlan ? { tier: pass1._contentPlan.tier, maxBulletsPerEntry: pass1._contentPlan.maxBulletsPerEntry, linesPerBullet: pass1._contentPlan.linesPerBullet, achievementsLines: pass1._contentPlan.achievementsMax || 3 } : null,";

// ── (4) Cover grounding rule (appended to both cover prompts) ──
const COVER_RULE = "\n\nBIOGRAPHICAL GROUNDING (hard rule): NEVER state or imply the candidate's place of residence, citizenship, work authorization, relocation readiness, or time zone unless that exact fact appears in the provided candidate data. If the candidate's location is empty or unknown, make ZERO claims about where they are based or authorized to work -- do not derive residence from the job's location, the phone country code, or any authorization field. A fabricated biographical fact is a disqualifying error.";

// ── (5) Prefs location canonicalization ──
const PREFS_OLD = "  const loc = m[1].trim();\n  if (loc.length > 2) delta.location_canonical = loc;";
const PREFS_NEW =
  "  let loc = m[1].trim();\n" +
  "  // s76: canonicalize -- keep only the place tokens before any connector word,\n" +
  "  // so 'belagavi and targeting roles in bangalore' stores as 'belagavi', never\n" +
  "  // the sentence (which s75's filter guard would treat as no constraint).\n" +
  "  const LOC_STOP = ['and', 'or', 'targeting', 'roles', 'role', 'the', 'for', 'based', 'remember', 'open', 'while', 'looking'];\n" +
  "  const locToks = loc.split(/\\s+/);\n" +
  "  const cutAt = locToks.findIndex((t) => LOC_STOP.includes(t.toLowerCase()));\n" +
  "  if (cutAt === 0) loc = '';\n" +
  "  else if (cutAt > 0) loc = locToks.slice(0, cutAt).join(' ');\n" +
  "  if (loc.length > 2 && loc.split(/\\s+/).length <= 8) delta.location_canonical = loc;";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const name of ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX', 'Cover Pass1', 'Cover Pass2', 'Handle Prefs Update']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Assemble Resume LaTeX'].parameters.jsCode.includes('capTechStackV2')) { console.log(`  ${base}: already patched`); return; }

  // LaTeX nodes: V2 renderer + header cap in all 3
  for (const name of ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX']) {
    replaceOnce(N[name].parameters, 'jsCode', ACH_V2_OLD, ACH_V2_NEW, `ach V2 (${name})`, base);
    replaceOnce(N[name].parameters, 'jsCode', RR_FN_OLD, RR_FN_NEW, `capTechStackV2 helper (${name})`, base);
    replaceOnce(N[name].parameters, 'jsCode', PROJ_V2_OLD, PROJ_V2_NEW, `proj header cap (${name})`, base);
  }
  // V1 fallback + mergeContent: Assemble twins only
  for (const name of ['Assemble Resume LaTeX', 'Assemble Regen']) {
    replaceOnce(N[name].parameters, 'jsCode', ACH_V1_OLD, ACH_V1_NEW, `ach V1 (${name})`, base);
    replaceOnce(N[name].parameters, 'jsCode', MC_ACH_OLD, MC_ACH_NEW, `mergeContent ach pool (${name})`, base);
    replaceOnce(N[name].parameters, 'jsCode', MC_BUDGET_OLD, MC_BUDGET_NEW, `mergeContent achievementsLines (${name})`, base);
  }
  // Cover prompts: append grounding rule (idempotent)
  for (const name of ['Cover Pass1', 'Cover Pass2']) {
    const mv = N[name].parameters.messages.messageValues;
    if (!mv[0].message.includes('BIOGRAPHICAL GROUNDING')) mv[0].message += COVER_RULE;
  }
  // Prefs canonicalization
  replaceOnce(N['Handle Prefs Update'].parameters, 'jsCode', PREFS_OLD, PREFS_NEW, 'prefs location canonicalization', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: achievements grouped+budgeted, project header capped, cover grounding rule, prefs canonicalized -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  const REAL_ACH = [
    { description: '3rd Place, Agentic Engineering Hack -- NYC (Datadog, May 2026) – RegRadar | github.com/p-kowadkar/RegRadar' },
    { description: '1st Place, Build for the Border -- Immigrant Hackathon NYC (May 2026) – HomeCart | github.com/p-kowadkar/HomeCart' },
    { description: '1st Place, Pulse NYC Hackathon (Jan 2026) -- Search Sentinel | github.com/p-kowadkar/search-sentinel' },
    { description: 'n8n Sponsor Prize, ElevenLabs Global Hackathon (Nov 2025) -- EZ OnCall | github.com/p-kowadkar/ez-oncall' },
    { description: 'LLM Day NYC, New York, NY (March 2026) – "Multi-Agent Architectures" | Technical presentation' },
    { description: 'n8n NYC Meetup at Courier Health, New York, NY (April 2026) – live demo' },
  ];
  const stubs = {
    itemCmd: '\\resumeItem',
    esc: (s) => s,
    firstNonEmpty: (a, b) => a || b,
  };

  // Run the ACTUAL patched V2 statement via new Function
  const runV2 = (achievements, achievementsLines) => {
    const body = 'const slots = {}; ' +
      ACH_V2_NEW.replace(/^slots\.achievements/, 'slots.achievements') +
      ' return slots.achievements;';
    return new Function('content', 'itemCmd', 'escapeLatexTextV2', 'firstNonEmpty', body)(
      { achievements, _budget: { achievementsLines } }, stubs.itemCmd, stubs.esc, stubs.firstNonEmpty);
  };

  // Budget 3 (senior default): expect grouped rows, no links, wins first
  let out = runV2(REAL_ACH, 3);
  if (out.includes('github.com')) { console.error('HARNESS FAIL: github link survived stripLinks'); process.exit(1); }
  if (!out.startsWith('\\resumeItem{\\textbf{Hackathon Wins:}')) { console.error('HARNESS FAIL: wins group not first: ' + out.slice(0, 80)); process.exit(1); }
  if (!out.includes(' $|$ ')) { console.error('HARNESS FAIL: pipe separators missing'); process.exit(1); }
  if (!out.includes('\\textbf{Speaking:}')) { console.error('HARNESS FAIL: Speaking group missing at budget 3'); process.exit(1); }
  const winsRow = out.split('\n')[0];
  const winsCount = (winsRow.match(/\$\|\$/g) || []).length + 1;
  if (winsCount < 2) { console.error(`HARNESS FAIL: only ${winsCount} win items at budget 3, expected >=2`); process.exit(1); }

  // Budget 2 (mid tier): must fit budget by estimate, still >=1 row
  out = runV2(REAL_ACH, 2);
  const estLines = out.split('\n').reduce((acc, row) => {
    const inner = row.replace(/^\\resumeItem\{/, '').replace(/\}$/, '');
    return acc + Math.ceil(inner.replace(/\\textbf\{|\}|\$\|\$/g, '').length / 105);
  }, 0);
  if (estLines > 2) { console.error(`HARNESS FAIL: budget 2 produced ~${estLines} estimated lines`); process.exit(1); }
  if (!out.includes('Hackathon Wins:') || !out.includes('Speaking:')) { console.error('HARNESS FAIL: budget 2 must keep both categories (balanced allocation)'); process.exit(1); }

  // Empty/missing budget falls back to 3 and renders
  out = runV2(REAL_ACH.slice(0, 2), undefined);
  if (!out.startsWith('\\resumeItem{\\textbf{')) { console.error('HARNESS FAIL: fallback budget path broken'); process.exit(1); }

  // OLD-code repro: one item per line, link intact (fixture faithfulness)
  const oldOut = new Function('content', 'itemCmd', 'escapeLatexTextV2', 'firstNonEmpty',
    'const slots = {}; ' + ACH_V2_OLD.replace(/\\n/g, '\\n') + ' return slots.achievements;')(
    { achievements: REAL_ACH }, stubs.itemCmd, stubs.esc, stubs.firstNonEmpty);
  if (!oldOut.includes('github.com') || oldOut.split('\n').length !== 6) {
    console.error('HARNESS FAIL: old-code repro mismatch -- fixture not faithful'); process.exit(1);
  }

  // capTechStackV2 against the REAL PrometheusAI overflow case
  const capFn = new Function('name', 'stack', RR_FN_NEW.split('function renderResume')[0].replace('function capTechStackV2(name, stack) {', '') .replace(/\}\s*$/, ''));
  const LONG_STACK = 'Python 3.11, You.com API, multi-agent orchestration, SQLite, Gradio, asyncio, OpenAI-compatible LLMs';
  const LONG_NAME = 'PrometheusAI -- Self-Improving Multi-Agent Research System';
  const capped = capFn(LONG_NAME, LONG_STACK);
  if (capped.length > Math.max(30, 92 - LONG_NAME.length)) { console.error('HARNESS FAIL: cap exceeded budget'); process.exit(1); }
  const lastTok = capped.split(',').pop().trim();
  if (!LONG_STACK.includes(lastTok + ',') && !LONG_STACK.endsWith(lastTok)) { console.error(`HARNESS FAIL: mid-token cut: "${lastTok}"`); process.exit(1); }
  if (capFn('Short', 'Python, FastAPI') !== 'Python, FastAPI') { console.error('HARNESS FAIL: short stack must pass through'); process.exit(1); }

  // Prefs canonicalization against the EXACT production message shape
  const prefsRun = (msg) => {
    const body = "const delta = {}; let m; if ((m = msg.match(/(?:i['\\u2019]?m (?:based |located )?in|location[:\\s]+|moved? to|set location (?:to )?)\\s*([\\w\\s,]+?)(?:\\s*$|[.,!?])/))) {\n" + PREFS_NEW + "\n} return delta.location_canonical;";
    return new Function('msg', body)(msg);
  };
  const got = prefsRun("i'm based in belagavi and targeting roles in bangalore, pune, or remote india");
  if (got !== 'belagavi') { console.error(`HARNESS FAIL: sentence canonicalized to "${got}", expected "belagavi"`); process.exit(1); }
  if (prefsRun('location: bangalore') !== 'bangalore') { console.error('HARNESS FAIL: clean location broken'); process.exit(1); }
  if (prefsRun('moved to new york') !== 'new york') { console.error('HARNESS FAIL: multi-word location broken'); process.exit(1); }

  if (!COVER_RULE.includes('NEVER state or imply')) { console.error('HARNESS FAIL: cover rule text'); process.exit(1); }

  console.log('HARNESS OK: real 6-achievement fixture renders grouped (wins-first, links stripped, $|$ separators), respects line budgets 2 and 3, old code reproduces the verbose format (fixture faithful); PrometheusAI stack caps at a clean comma boundary and short stacks pass through; the exact production prefs sentence canonicalizes to "belagavi" while clean values pass; cover grounding rule verified.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S76 (grouped achievements + project header cap + cover biographical grounding + prefs location canonicalization) complete.');
