/**
 * s4_nl_filters.js — S4: natural-language -> structured filters + F-1 OPT flag.
 *
 * Folded into Expand Query (prompt) + Parse Expand Query (output) — no parallel
 * node, since everything downstream already reads Parse Expand Query.
 *
 * Adds to the parsed intent: salary_min, equity, sponsorship_required,
 * f1_opt_constraint, exclude_recent_layoffs, min_funding_stage, culture_constraints,
 * ambiguity_flags. These flow to: S3 compensation sub-score (composite reads
 * salary_min), the visa sub-score, and future structured-API salary params.
 *
 * F-1 rule: if the user wants a US-based remote role worked from OUTSIDE the US
 * (f1_opt_constraint='remote_from_outside_us'), push ambiguity_flags + a
 * non-blocking clarification shown in the digest (search still runs).
 *
 * split/join only (avoids the $-in-replace footgun). Run: node scripts/s4_nl_filters.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const PROMPT_BLOCK =
  "\n\n## Additional structured filters (extract from the message; sensible defaults if unstated; include ALL keys)\n" +
  "- salary_min: integer annual floor in the query's currency if stated (\"180k\"->180000, \"$150k+\"->150000, \"20L+\"/\"₹20L\"->2000000), else null.\n" +
  "- equity: true if equity / stock / RSUs mentioned, else false.\n" +
  "- sponsorship_required: true if the user needs visa sponsorship (\"visa sponsorship\", \"sponsors H1B\", \"needs sponsorship\"), else false.\n" +
  "- f1_opt_constraint: \"remote_from_outside_us\" if they want a US-based REMOTE role they'd work from OUTSIDE the US (e.g. \"remote US jobs I can do from India\"); \"us_physical\" if remote but worked from inside the US; else \"none\".\n" +
  "- exclude_recent_layoffs: true if they want stable companies / no recent layoffs, else false.\n" +
  "- min_funding_stage: \"seed\" | \"series_a\" | \"series_b\" | \"series_c\" | \"public\" | null.\n" +
  "- culture_constraints: array of short phrases (e.g. [\"no crunch\",\"growth-focused\"]) or [].";

const FILTER_BLOCK =
  "// S4: rich structured filters + F-1 OPT ambiguity flag\n" +
  "result.salary_min = (typeof parsed.salary_min === 'number' ? parsed.salary_min : (userPrefs.salary_min || null));\n" +
  "result.equity = !!parsed.equity;\n" +
  "result.sponsorship_required = !!(parsed.sponsorship_required || userPrefs.sponsorship_required);\n" +
  "result.f1_opt_constraint = parsed.f1_opt_constraint || 'none';\n" +
  "result.exclude_recent_layoffs = !!parsed.exclude_recent_layoffs;\n" +
  "result.min_funding_stage = parsed.min_funding_stage || null;\n" +
  "result.culture_constraints = Array.isArray(parsed.culture_constraints) ? parsed.culture_constraints : [];\n" +
  "result.ambiguity_flags = [];\n" +
  "if (result.f1_opt_constraint === 'remote_from_outside_us') {\n" +
  "  result.ambiguity_flags.push('F1_OPT_REMOTE_LOCATION');\n" +
  "  result._f1_note = '🛂 Heads-up: on F-1 OPT, remote work must be performed while physically in the US. I searched anyway, but a US-based role worked from outside the US generally is NOT OPT-eligible — confirm you will be in the US.';\n" +
  "}\n";

const F1_DIGEST_LINE =
  "if (((intent.ambiguity_flags) || []).indexOf('F1_OPT_REMOTE_LOCATION') !== -1) top3Msg += (intent._f1_note || '🛂 F-1 OPT: remote work must be performed inside the US.') + '\\n';\n  ";

function sj(s, a, b) { return s.split(a).join(b); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  let edits = 0;

  // 1) Expand Query prompt — request the new fields
  const eq = N['Expand Query'];
  if (eq) {
    const mv = eq.parameters.messages.messageValues[0];
    if (!mv.message.includes('f1_opt_constraint')) { mv.message += PROMPT_BLOCK; edits++; }
  }

  // 2) Parse Expand Query — add fields to result + F-1 flag (Object-assign style, before save)
  const peq = N['Parse Expand Query'];
  if (peq && !peq.parameters.jsCode.includes('ambiguity_flags')) {
    const before = peq.parameters.jsCode;
    peq.parameters.jsCode = sj(before, 'sd.last_search_intent = result;', FILTER_BLOCK + 'sd.last_search_intent = result;');
    if (peq.parameters.jsCode !== before) edits++; else console.log(`  WARN ${base}: PEQ anchor missing`);
  }

  // 3) Build Telegraph Body — non-blocking F-1 clarification line in top3Msg
  const btb = N['Build Telegraph Body'];
  if (btb && !btb.parameters.jsCode.includes('F1_OPT_REMOTE_LOCATION')) {
    const before = btb.parameters.jsCode;
    btb.parameters.jsCode = sj(before,
      "if (badges.length) top3Msg += badges.join(' · ')",
      F1_DIGEST_LINE + "if (badges.length) top3Msg += badges.join(' · ')");
    if (btb.parameters.jsCode !== before) edits++; else console.log(`  WARN ${base}: BTB anchor missing`);
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S4 applied (${edits} edits)`);
}

TARGETS.forEach(patch);
console.log('S4 patch complete.');
