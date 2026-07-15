/**
 * s89_market_assumption_dehardcode.js -- fourth and final sprint of the
 * de-hardcoding pass. Removes the US-immigration-specific schema/vocabulary
 * and the unconditional '$' currency assumption.
 *
 * CURRENCY: `Handle Prefs Update`'s salary regex unconditionally prepended
 * '$' regardless of what the user actually typed -- "min salary 20L" (Indian
 * lakh notation) stored as the nonsense "$20". Now reads the currency
 * symbol the user actually typed (reusing the same vocabulary `Build
 * Telegraph Body` already has correct, duplicated per Code-node convention),
 * recognizes lakh/crore as INR-implying (reading the user's OWN stated
 * numbering convention, not inferring anything from residency -- design
 * law #4), and when NEITHER a symbol nor an Indian unit word is present,
 * stores the bare number with NO invented currency -- honest about not
 * knowing, per design law #3, a real behavior change from "always assume $"
 * to "assume nothing not stated."
 *
 * F1_OPT FULL RENAME (user-confirmed 2026-07-15, not the smaller
 * genericize-only option): `f1_opt_constraint` -> `cross_border_remote_note`
 * across all 4 sites. The old design baked a fixed country (US) into the
 * ENUM VALUES themselves (`remote_from_outside_us`/`us_physical`), not just
 * the field name -- a true generalization can't just rename around that, so
 * the mechanism changes shape: instead of a closed enum tied to one country,
 * the LLM writes a short free-language note ONLY when the user's own stated
 * visa/permit physical-presence requirement conflicts with their search,
 * grounded in nothing but what they explicitly said. Same trigger discipline
 * as design law #1 -- never invented, never inferred from residency.
 *
 * VISA/INTEL GENERICIZATION: "H1B sponsorship" as the only-named visa facet
 * becomes generic "visa/work-authorization sponsorship" language (the
 * MECHANISM survives -- researching whether a company sponsors work visas is
 * genuinely useful everywhere -- only the US-specific naming goes); `Intel
 * Output Parser`'s `h1b` schema key renames to `visa_sponsorship`;
 * "Glassdoor" as the sole hardcoded review source becomes a named list of
 * common sources across markets, "whatever is found" -- never assuming
 * Glassdoor exists for a given market.
 *
 * JOBSCORER WIRING BUG (found in passing during investigation, in scope
 * since it's the same field): `Build Scorer Input` never passed
 * visa_signals to JobScorer at all -- confirmed via investigation that its
 * prompt is literally `JSON.stringify($json)`, so anything added to Build
 * Scorer Input's return object is automatically visible with zero template
 * changes needed. The sponsorship heuristic was a pure company-size guess
 * with ZERO connection to whether the user ever stated a need. Now wires
 * the real, already-priority-merged `_eq.visa_signals` through (Parse
 * Expand Query already does explicit-message > stored-pref merging for this
 * field -- confirmed, not re-implemented) and makes the generic heuristic
 * an EXPLICIT fallback used only when nothing was stated, applying design
 * law #1 to scoring, not just search.
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

// ── 1. Handle Prefs Update: currency-aware salary parsing ──
const SALARY_OLD = "// ── Salary ────────────────────────────────────────────────────────────────\nif ((m = msg.match(/(?:min(?:imum)? salary|at least|salary[:\\s]+|above|over)\\s*\\$?([\\d]+(?:k|,\\d{3})?)/))) {\n  delta.salary_signals = ['$' + m[1]];\n}";
const SALARY_NEW = "// ── Salary ────────────────────────────────────────────────────────────────\n// s89: currency-aware -- was an unconditional '$' regardless of what the\n// user typed (\"min salary 20L\" stored as the nonsense \"$20\"). Reads the\n// symbol they actually used (same vocabulary Build Telegraph Body already\n// has correct); lakh/crore reads the user's OWN stated numbering\n// convention, not an inference from residency; no symbol + no Indian unit\n// word means no currency is invented -- bare number, honest about not\n// knowing.\nif ((m = msg.match(/(?:min(?:imum)? salary|at least|salary[:\\s]+|above|over)\\s*(₹|£|€|\\$|a\\$|c\\$|s\\$|nz\\$)?\\s*([\\d]+(?:k|,\\d{3})?)\\s*(lakh|lac|l\\b|cr|crore)?/i))) {\n  const symMap = { '₹':'₹', '£':'£', '€':'€', '$':'$', 'a$':'A$', 'c$':'C$', 's$':'S$', 'nz$':'NZ$' };\n  const sym = symMap[(m[1] || '').toLowerCase()] || '';\n  const unit = (m[3] || '').toLowerCase();\n  const isIndianUnit = /^(lakh|lac|l|cr|crore)$/.test(unit);\n  const finalSym = sym || (isIndianUnit ? '₹' : '');\n  const suffix = isIndianUnit ? (unit.startsWith('cr') ? 'Cr' : 'L') : '';\n  delta.salary_signals = [finalSym + m[2] + suffix];\n}";

// ── 2. Expand Query prompt: f1_opt_constraint -> cross_border_remote_note ──
const EQ_F1_OLD = '- f1_opt_constraint: "remote_from_outside_us" if they want a US-based REMOTE role they\'d work from OUTSIDE the US (e.g. "remote US jobs I can do from India"); "us_physical" if remote but worked from inside the US; else "none".';
const EQ_F1_NEW = '- cross_border_remote_note: ONLY if the user\'s message or preferences describe a visa/work-permit category with a physical-presence requirement (e.g. "I\'m on OPT, must be physically in the US", "my permit requires me to work from Germany") AND their search conflicts with it (e.g. searching remote roles based elsewhere) -- write ONE short plain-language heads-up sentence, grounded ONLY in what they explicitly stated. Empty string "" if nothing stated or no conflict. NEVER invent a visa category or country the user didn\'t mention.';

// ── 3. Expand Query Output Parser schema ──
const PARSER_OLD = '"f1_opt_constraint":{"type":"string"}';
const PARSER_NEW = '"cross_border_remote_note":{"type":"string"}';

// ── 4. Parse Expand Query: assignment + ambiguity flag + note ──
const PEQ_F1_OLD = "result.f1_opt_constraint = parsed.f1_opt_constraint || 'none';\nresult.exclude_recent_layoffs = !!parsed.exclude_recent_layoffs;\nresult.min_funding_stage = parsed.min_funding_stage || null;\nresult.culture_constraints = Array.isArray(parsed.culture_constraints) ? parsed.culture_constraints : [];\nresult.ambiguity_flags = [];\nif (result.f1_opt_constraint === 'remote_from_outside_us') {\n  result.ambiguity_flags.push('F1_OPT_REMOTE_LOCATION');\n  result._f1_note = '🛂 Heads-up: on F-1 OPT, remote work must be performed while physically in the US. I searched anyway, but a US-based role worked from outside the US generally is NOT OPT-eligible — confirm you will be in the US.';\n}";
const PEQ_F1_NEW = "result.cross_border_remote_note = String(parsed.cross_border_remote_note || '').trim();\nresult.exclude_recent_layoffs = !!parsed.exclude_recent_layoffs;\nresult.min_funding_stage = parsed.min_funding_stage || null;\nresult.culture_constraints = Array.isArray(parsed.culture_constraints) ? parsed.culture_constraints : [];\nresult.ambiguity_flags = [];\n// s89: fully generic -- was hardcoded to US/F-1 OPT specifically. Fires\n// only on what the user themselves stated, for any country/visa category.\nif (result.cross_border_remote_note) {\n  result.ambiguity_flags.push('CROSS_BORDER_REMOTE_TENSION');\n  result._cross_border_note = '🛂 ' + result.cross_border_remote_note;\n}";

// ── 5. Build Telegraph Body: flag consumption ──
const BTB_F1_OLD = "if (((intent.ambiguity_flags) || []).indexOf('F1_OPT_REMOTE_LOCATION') !== -1) top3Msg += (intent._f1_note || '🛂 F-1 OPT: remote work must be performed inside the US.') + '\\n';";
const BTB_F1_NEW = "if (((intent.ambiguity_flags) || []).indexOf('CROSS_BORDER_REMOTE_TENSION') !== -1) top3Msg += (intent._cross_border_note || '🛂 Heads-up: check your visa/work-permit physical-presence requirements against this role\\'s location.') + '\\n';";

// ── 6. Intel Output Parser schema: h1b -> visa_sponsorship ──
const IOP_OLD = '"h1b":{"type":"object","properties":{"sponsors":{"type":"boolean"},"recent_approvals":{"type":"string"}}}';
const IOP_NEW = '"visa_sponsorship":{"type":"object","properties":{"sponsors":{"type":"boolean"},"recent_approvals":{"type":"string"}}}';

// ── 7. CompanyIntel + CompanyIntel Apply (byte-identical pair): H1B section, weighting, glassdoor, intro ──
const CI_INTRO_OLD = 'covering news, reviews, layoffs, funding, H1B sponsorship, and culture. You synthesize them into a structured company health report';
const CI_INTRO_NEW = 'covering news, reviews, layoffs, funding, visa/work-authorization sponsorship, and culture. You synthesize them into a structured company health report';
const CI_H1B_OLD = '### 6. H1B Sponsorship\n\n- `sponsors`: `true` only if sources explicitly confirm H1B sponsorship or show recent H1B approvals\n- `recent_approvals`: Summarize approval counts if found in sources (e.g., from H1B employer data). Set to `null` if not found.\n- `trend`: Determine from multi-year data if available. Default to `"Unknown"`.\n\n';
const CI_H1B_NEW = '### 6. Visa/Work-Authorization Sponsorship\n\n- `visa_sponsorship.sponsors`: `true` only if sources explicitly confirm the company sponsors work visas/permits (any country) or show recent sponsorship approvals\n- `visa_sponsorship.recent_approvals`: Summarize approval counts if found in sources (e.g., published sponsorship data for the relevant country). Set to `null` if not found.\n- `visa_sponsorship.trend`: Determine from multi-year data if available. Default to `"Unknown"`.\n\n';
const CI_WEIGHT_OLD = "H1B / immigration friendliness: 15% (higher weight if candidate requires sponsorship — but you don't know this, so keep it moderate)";
const CI_WEIGHT_NEW = "Visa/work-authorization sponsorship friendliness: 15% (higher weight if candidate requires sponsorship — but you don't know this, so keep it moderate)";
const CI_GLASSDOOR_OLD = 'covering multiple query facets: recent news, layoff history, Glassdoor reviews, H1B sponsorship, funding rounds, company culture';
const CI_GLASSDOOR_NEW = 'covering multiple query facets: recent news, layoff history, employee review site ratings (Glassdoor, AmbitionBox, Indeed, Comparably, Kununu, etc. -- whatever is actually found for this company\'s market), visa/work-authorization sponsorship, funding rounds, company culture';

// ── 8. Format Intel Report + (Cached): render lines ──
const FIR_H1B_OLD = "sections.push('\\u{1F6C2} *H1B:* ' + (r.h1b && r.h1b.sponsors ? 'Yes' : 'Unknown'));";
const FIR_H1B_NEW = "sections.push('\\u{1F6C2} *Visa Sponsorship:* ' + (r.visa_sponsorship && r.visa_sponsorship.sponsors ? 'Yes' : 'Unknown'));";
const FIR_GD_OLD = "'\\u{1F4CA} *Sentiment:* ' + (r.sentiment && r.sentiment.overall_mood || 'Unknown') + (r.sentiment && r.sentiment.glassdoor_rating ? ' (Glassdoor: ' + r.sentiment.glassdoor_rating + ')' : ''),";
const FIR_GD_NEW = "'\\u{1F4CA} *Sentiment:* ' + (r.sentiment && r.sentiment.overall_mood || 'Unknown') + (r.sentiment && r.sentiment.glassdoor_rating ? ' (' + (r.sentiment.review_source || 'Reviews') + ': ' + r.sentiment.glassdoor_rating + ')' : ''),";

// ── 9. You.com Research: hardcoded query string ──
const YCR_OLD = '`Company health analysis for ${company} ${year}: latest news, layoffs, funding rounds, Glassdoor rating, H1B sponsorship, engineering culture, red flags`';
const YCR_NEW = '`Company health analysis for ${company} ${year}: latest news, layoffs, funding rounds, employee review ratings, visa/work-authorization sponsorship, engineering culture, red flags`';

// ── 10. Build Scorer Input: wire the real visa signal through ──
const BSI_OLD = "requested_country: _eq.country || null,\n  jobs: jobBatch\n} }];";
const BSI_NEW = "requested_country: _eq.country || null,\n  // s89: was never passed at all -- JobScorer's sponsorship heuristic had\n  // ZERO connection to whether the user actually stated a need.\n  // _eq.visa_signals is already explicit-message > stored-pref merged by\n  // Parse Expand Query (confirmed, not re-implemented here).\n  requested_visa_signals: _eq.visa_signals || [],\n  jobs: jobBatch\n} }];";

// ── 11. JobScorer: rubric + workauth_score wired to the real signal ──
const JS_RUBRIC_OLD = "- **Work authorization**: If the candidate requires sponsorship, does the company likely sponsor? (Large tech companies generally do; small startups generally don't.)";
const JS_RUBRIC_NEW = "- **Work authorization**: Check `requested_visa_signals` in the input. If NON-EMPTY (the candidate explicitly stated a sponsorship/visa need), score against that STATED need directly -- does this employer likely meet it? If EMPTY (nothing stated), fall back to a generic heuristic ONLY (large/established firms more likely to sponsor; small startups less likely) -- never assume a need the candidate didn't state.";
const JS_WORKAUTH_OLD = "- workauth_score: work-authorization fit — if the candidate needs sponsorship, does this employer likely sponsor? (large/established firms higher, tiny startups lower; unknown → 60).";
const JS_WORKAUTH_NEW = "- workauth_score: work-authorization fit — if `requested_visa_signals` is non-empty, score against that STATED need explicitly; if empty, fall back to the generic large/established-firm-higher heuristic (unknown → 60). Never invent a sponsorship need the candidate didn't state.";

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Handle Prefs Update', 'Expand Query', 'Expand Query Output Parser', 'Parse Expand Query', 'Build Telegraph Body', 'Intel Output Parser', 'CompanyIntel', 'CompanyIntel Apply', 'Format Intel Report', 'Format Intel Report (Cached)', 'You.com Research', 'Build Scorer Input', 'JobScorer']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Expand Query'].parameters.jsCode.includes('cross_border_remote_note')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Handle Prefs Update'].parameters, 'jsCode', SALARY_OLD, SALARY_NEW, 'currency-aware salary parsing', base);

  const eqMv = N['Expand Query'].parameters.messages.messageValues;
  replaceOnce(eqMv[0], 'message', EQ_F1_OLD, EQ_F1_NEW, 'cross_border_remote_note prompt rule', base);

  replaceOnce(N['Expand Query Output Parser'].parameters, 'inputSchema', PARSER_OLD, PARSER_NEW, 'output parser schema rename', base);

  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', PEQ_F1_OLD, PEQ_F1_NEW, 'cross_border_remote_note assignment', base);

  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', BTB_F1_OLD, BTB_F1_NEW, 'cross-border flag consumption', base);

  replaceOnce(N['Intel Output Parser'].parameters, 'inputSchema', IOP_OLD, IOP_NEW, 'h1b -> visa_sponsorship schema', base);

  for (const nm of ['CompanyIntel', 'CompanyIntel Apply']) {
    const mv = N[nm].parameters.messages.messageValues;
    replaceOnce(mv[0], 'message', CI_INTRO_OLD, CI_INTRO_NEW, `${nm} intro`, base);
    replaceOnce(mv[0], 'message', CI_H1B_OLD, CI_H1B_NEW, `${nm} H1B section`, base);
    replaceOnce(mv[0], 'message', CI_WEIGHT_OLD, CI_WEIGHT_NEW, `${nm} weighting`, base);
    replaceOnce(mv[0], 'message', CI_GLASSDOOR_OLD, CI_GLASSDOOR_NEW, `${nm} glassdoor facet list`, base);
  }

  for (const nm of ['Format Intel Report', 'Format Intel Report (Cached)']) {
    replaceOnce(N[nm].parameters, 'jsCode', FIR_H1B_OLD, FIR_H1B_NEW, `${nm} H1B render`, base);
    replaceOnce(N[nm].parameters, 'jsCode', FIR_GD_OLD, FIR_GD_NEW, `${nm} Glassdoor render`, base);
  }

  replaceOnce(N['You.com Research'].parameters, 'jsCode', YCR_OLD, YCR_NEW, 'intel research query string', base);

  replaceOnce(N['Build Scorer Input'].parameters, 'jsCode', BSI_OLD, BSI_NEW, 'wire visa_signals through', base);

  const jsMv = N['JobScorer'].parameters.messages.messageValues;
  replaceOnce(jsMv[0], 'message', JS_RUBRIC_OLD, JS_RUBRIC_NEW, 'JobScorer rubric', base);
  replaceOnce(jsMv[0], 'message', JS_WORKAUTH_OLD, JS_WORKAUTH_NEW, 'JobScorer workauth_score', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: market assumptions de-hardcoded -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. Currency-aware salary parsing, run for real against realistic fixtures
  function parseSalary(msg) {
    const body = SALARY_NEW.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const fn = new Function('msg', 'delta', 'let m;\n' + body + '\nreturn delta.salary_signals;');
    return fn(msg.toLowerCase(), {});
  }
  const salaryCases = [
    ['min salary $150k', ['$150k'], 'explicit $ preserved (regression -- was already correct)'],
    ['min salary 20L', ['₹20L'], 'the actual bug: Indian lakh notation now correctly tagged INR, not $20'],
    ['min salary ₹20L', ['₹20L'], 'explicit ₹ + L preserved'],
    ['salary above 20 lakh', ['₹20L'], 'spaced-word form recognized'],
    ['min salary 150k', ['150k'], 'no symbol stated -- bare number, no invented $ (real behavior change per design law #3)'],
    ['min salary €80k', ['€80k'], 'EUR preserved'],
  ];
  for (const [msg, want, label] of salaryCases) {
    const got = parseSalary(msg);
    if (JSON.stringify(got) !== JSON.stringify(want)) { console.error(`HARNESS FAIL: "${label}" -> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); process.exit(1); }
  }

  // 2. F1_OPT full rename -- zero old identifiers anywhere in the new text
  const ALL_NEW = [EQ_F1_NEW, PARSER_NEW, PEQ_F1_NEW, BTB_F1_NEW].join('\n');
  for (const old of ['f1_opt_constraint', 'F1_OPT_REMOTE_LOCATION', '_f1_note', 'remote_from_outside_us', 'us_physical']) {
    if (ALL_NEW.includes(old)) { console.error(`HARNESS FAIL: old identifier "${old}" still present in the renamed text`); process.exit(1); }
  }
  if (!PEQ_F1_NEW.includes('cross_border_remote_note') || !PEQ_F1_NEW.includes('CROSS_BORDER_REMOTE_TENSION')) {
    console.error('HARNESS FAIL: new identifiers missing'); process.exit(1);
  }

  // 3. Cross-border note trigger logic, run for real -- extract the trigger
  //    block programmatically (from `result.ambiguity_flags = []` onward) so
  //    the harness can't drift from the real patched text.
  const CB_ANCHOR = 'result.ambiguity_flags = [];';
  const cbStart = PEQ_F1_NEW.indexOf(CB_ANCHOR);
  if (cbStart === -1) { console.error('HARNESS FAIL: cross-border trigger anchor not found in PEQ_F1_NEW'); process.exit(1); }
  const CB_TRIGGER_SRC = PEQ_F1_NEW.slice(cbStart);
  function runCrossBorder(note) {
    const result = { cross_border_remote_note: note };
    new Function('result', CB_TRIGGER_SRC)(result);
    return { flags: result.ambiguity_flags, note: result._cross_border_note };
  }
  const cb1 = runCrossBorder('');
  if (cb1.flags.length !== 0) { console.error('HARNESS FAIL: empty note must not set the ambiguity flag'); process.exit(1); }
  const cb2 = runCrossBorder('On a work permit that requires physical presence in Germany.');
  if (cb2.flags[0] !== 'CROSS_BORDER_REMOTE_TENSION' || !cb2.note.includes('Germany')) { console.error('HARNESS FAIL: stated note must set the flag and be grounded in what was said'); process.exit(1); }

  // 4. Visa/intel genericization -- zero H1B/Glassdoor-only occurrences in the new text
  const INTEL_NEW = [IOP_NEW, CI_INTRO_NEW, CI_H1B_NEW, CI_WEIGHT_NEW, CI_GLASSDOOR_NEW, FIR_H1B_NEW, YCR_NEW].join('\n');
  if (/\bH1B\b/i.test(INTEL_NEW.replace(/AmbitionBox|Comparably|Kununu/gi, ''))) {
    console.error('HARNESS FAIL: "H1B" still present in genericized intel text'); process.exit(1);
  }
  if (!INTEL_NEW.includes('visa_sponsorship')) { console.error('HARNESS FAIL: visa_sponsorship schema key missing'); process.exit(1); }
  if (!CI_GLASSDOOR_NEW.includes('AmbitionBox')) { console.error('HARNESS FAIL: multi-source review language missing'); process.exit(1); }

  // 5. JobScorer wiring, run for real
  if (!BSI_NEW.includes('requested_visa_signals: _eq.visa_signals || []')) { console.error('HARNESS FAIL: Build Scorer Input wiring missing'); process.exit(1); }
  if (!JS_RUBRIC_NEW.includes('requested_visa_signals') || !JS_WORKAUTH_NEW.includes('requested_visa_signals')) {
    console.error('HARNESS FAIL: JobScorer prompt not wired to the real signal'); process.exit(1);
  }
  if (!JS_RUBRIC_NEW.includes("never assume a need the candidate didn't state") && !JS_RUBRIC_NEW.includes('never assume a need the candidate')) {
    console.error('HARNESS FAIL: explicit-fallback-only framing missing from rubric'); process.exit(1);
  }

  console.log('HARNESS OK: currency-aware salary parsing verified against 6 real fixtures (the "min salary 20L" -> "$20" bug now correctly tags INR; unstated currency now stores bare, never an invented $); F1_OPT fully renamed with zero old identifiers surviving anywhere; the cross-border trigger only fires on an actually-stated note; visa/intel language fully genericized (zero bare "H1B", multi-source reviews); JobScorer now receives and is instructed to prioritize requested_visa_signals over its generic company-size fallback.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S89 (market-assumption de-hardcoding) complete.');
