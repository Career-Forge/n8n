/**
 * sN1_intern_intent.js — S1: intent-driven intern/seniority.
 *
 * Two patch kinds in one script (serialized over the shared nodes, per plan):
 *  A) string-splice (s4-style) the inline nodes that have no canonical file:
 *       - Expand Query prompt:   extract include_interns + level_intent
 *       - Parse Expand Query:    set result.include_interns/level_intent + a
 *         non-blocking INTERN_CLARIFY flag (mirrors the F-1 OPT pattern)
 *  B) MAP-replace (s14-style) the canonical node bodies that now gate the intern
 *     drop on include_interns (intern roles flip in/out purely by query intent):
 *       - Cache Prefilter, Aggregate Jobs  (gate the unconditional intern drop)
 *       - Build Telegraph Body             (render the INTERN_CLARIFY line)
 *
 * Idempotent (guards on already-applied markers). Backups + integrity check.
 * Run: node scripts/sN1_intern_intent.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODES = path.join(__dirname, 'nodes');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// (B) canonical node bodies to replace wholesale: node name -> [file, field]
const MAP = {
  'Cache Prefilter': ['cache_prefilter.js', 'jsCode'],
  'Aggregate Jobs': ['aggregate_jobs.js', 'jsCode'],
  'Build Telegraph Body': ['build_telegraph_body.js', 'jsCode'],
};
const BODIES = {};
for (const [name, [file, field]] of Object.entries(MAP)) {
  const body = fs.readFileSync(path.join(NODES, file), 'utf8');
  try { new Function('$input', '$', '$json', '$getWorkflowStaticData', body); }
  catch (e) { console.error('PARSE FAIL ' + file + ': ' + e.message); process.exit(1); }
  BODIES[name] = { body, field };
}

// (A) Expand Query prompt addition
const PROMPT_BLOCK =
  "\n\n## Internship / level intent (extract; default to NOT interns unless asked)\n" +
  "- include_interns: true ONLY if the user explicitly wants internship/trainee/co-op roles " +
  "(\"intern\", \"internship\", \"summer intern\", \"trainee\"), else false.\n" +
  "- level_intent: \"internship\" | \"entry\" | \"mid\" | \"senior\" | \"any\" (default \"any\" if no level is stated).";

// (A) Parse Expand Query block, spliced before the staticData save anchor
const FILTER_BLOCK =
  "// S1: intern/level intent + non-blocking intern clarifier\n" +
  "result.level_intent = parsed.level_intent || 'any';\n" +
  "result.include_interns = !!(parsed.include_interns || parsed.level_intent === 'internship' || userPrefs.include_interns);\n" +
  "result.ambiguity_flags = result.ambiguity_flags || [];\n" +
  "if (!result.include_interns && result.level_intent === 'any') {\n" +
  "  result.ambiguity_flags.push('INTERN_CLARIFY');\n" +
  "  result._intern_note = \"\\uD83C\\uDF93 _Hiding intern/trainee roles -- add 'intern' to your search to include them._\";\n" +
  "}\n";
const ANCHOR = 'sd.last_search_intent = result;';

function sj(s, a, b) { return s.split(a).join(b); }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + file); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  let edits = 0;

  // (A1) Expand Query prompt
  const eq = N['Expand Query'];
  if (eq) {
    const mv = eq.parameters.messages.messageValues[0];
    if (!mv.message.includes('include_interns')) { mv.message += PROMPT_BLOCK; edits++; }
  } else console.log('  WARN ' + base + ': Expand Query missing');

  // (A2) Parse Expand Query
  const peq = N['Parse Expand Query'];
  if (peq && !peq.parameters.jsCode.includes('include_interns')) {
    const before = peq.parameters.jsCode;
    if (!before.includes(ANCHOR)) console.log('  WARN ' + base + ': PEQ anchor missing');
    peq.parameters.jsCode = sj(before, ANCHOR, FILTER_BLOCK + ANCHOR);
    if (peq.parameters.jsCode !== before) edits++;
  } else if (!peq) console.log('  WARN ' + base + ': Parse Expand Query missing');

  // (B) canonical node bodies
  const patched = [], missing = [];
  for (const [name, { body, field }] of Object.entries(BODIES)) {
    if (!N[name]) { missing.push(name); continue; }
    N[name].parameters = N[name].parameters || {};
    N[name].parameters[field] = body;
    patched.push(name); edits++;
  }

  // integrity: every connection target still exists
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections || {})) {
    if (!names.has(src)) { console.error('INTEGRITY FAIL: source missing ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((br) => (br || []).forEach((e) => {
        if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file + '.s1bak-' + stamp(), fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': ' + edits + ' edits, nodes [' + patched.join(', ') + ']' + (missing.length ? ' MISSING: ' + missing.join(', ') : ''));
}

TARGETS.forEach(patch);
console.log('S1 patch complete.');
