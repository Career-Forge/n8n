/**
 * p0_ambiguity_note.js -- P0(D): minimal non-blocking note for ambiguous bare
 * 2-letter location tokens (country vs US state). NO clarify-and-wait flow.
 *
 *   - Expand Query (prompt)      : instruct the LLM to prefer the ISO-COUNTRY reading
 *                                  of a bare 2-letter token unless there's US context,
 *                                  and emit location_ambiguous / location_note.
 *   - Parse Expand Query (jsCode): parse those + push a non-blocking LOCATION_CLARIFY
 *                                  flag/note (mirrors the INTERN_CLARIFY pattern).
 *   - Build Telegraph Body (jsCode): render the note (canonical body, already edited).
 *
 * Idempotent. Backups + integrity check. Run: node scripts/p0_ambiguity_note.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODES = path.join(__dirname, 'nodes');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
];
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const PROMPT_ANCHOR = 'set country AND location_canonical to that country name.';
const PROMPT_INSERT = '\n- location_ambiguous / location_note: a BARE 2-letter location token ("IN","DE","CA","TN") is ambiguous -- ' +
  'it can be an ISO country OR a US state. Prefer the ISO-COUNTRY reading (IN->India, DE->Germany, CA->Canada) UNLESS the ' +
  'message gives clear US context (a US city, "USA"/"US", another US state, or "remote US"). When you resolve such a bare ' +
  'token, set location_ambiguous=true and location_note to a short non-blocking note (e.g. "Interpreted IN as India; say ' +
  'Indiana, US if you meant the state."). Otherwise location_ambiguous=false and location_note="". NEVER silently treat a ' +
  'bare 2-letter token as a US state.';

const PARSE_ANCHOR = 'sd.last_search_intent = result;';
const PARSE_INSERT =
  "// P0(D): non-blocking ambiguous-location note (bare 2-letter token country-vs-US-state).\n" +
  "result.location_ambiguous = !!parsed.location_ambiguous;\n" +
  "result.location_note = (typeof parsed.location_note === 'string') ? parsed.location_note : '';\n" +
  "result.ambiguity_flags = result.ambiguity_flags || [];\n" +
  "if (result.location_ambiguous && result.location_note) {\n" +
  "  result.ambiguity_flags.push('LOCATION_CLARIFY');\n" +
  "  result._location_note = '\\uD83D\\uDCCD ' + result.location_note;\n" +
  "}\n";

const TELEGRAPH_BODY = fs.readFileSync(path.join(NODES, 'build_telegraph_body.js'), 'utf8');
try { new Function('$input', '$', '$json', '$getWorkflowStaticData', '$env', TELEGRAPH_BODY); }
catch (e) { console.error('PARSE FAIL build_telegraph_body.js: ' + e.message); process.exit(1); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + path.relative(ROOT, file)); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.relative(ROOT, file);
  const log = [];

  // 1) Expand Query prompt
  const eq = N['Expand Query'];
  if (eq) {
    const mv = eq.parameters.messages.messageValues[0];
    if (mv.message.includes('location_ambiguous')) log.push('prompt(skip)');
    else if (mv.message.includes(PROMPT_ANCHOR)) {
      mv.message = mv.message.split(PROMPT_ANCHOR).join(PROMPT_ANCHOR + PROMPT_INSERT);
      log.push('prompt');
    } else log.push('prompt(ANCHOR MISSING)');
  } else log.push('Expand Query MISSING');

  // 2) Parse Expand Query
  const peq = N['Parse Expand Query'];
  if (peq) {
    let code = peq.parameters.jsCode;
    if (code.includes('LOCATION_CLARIFY')) log.push('parse(skip)');
    else if (code.includes(PARSE_ANCHOR)) {
      code = code.replace(PARSE_ANCHOR, PARSE_INSERT + PARSE_ANCHOR);
      try { new Function('$input', '$', '$json', '$getWorkflowStaticData', '$env', code); }
      catch (e) { console.error('PARSE FAIL Parse Expand Query (' + base + '): ' + e.message); process.exit(1); }
      peq.parameters.jsCode = code;
      log.push('parse');
    } else log.push('parse(ANCHOR MISSING)');
  } else log.push('Parse Expand Query MISSING');

  // 3) Build Telegraph Body (canonical splice)
  const btb = N['Build Telegraph Body'];
  if (btb) { btb.parameters.jsCode = TELEGRAPH_BODY; log.push('telegraph'); }
  else log.push('Build Telegraph Body MISSING');

  // integrity
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections || {})) {
    if (!names.has(src)) { console.error('INTEGRITY FAIL: source ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) (branches || []).forEach((br) => (br || []).forEach((e) => {
      if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
    }));
  }

  fs.writeFileSync(file + '.p0bak-' + stamp(), fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': [' + log.join(', ') + ']');
}

TARGETS.forEach(patch);
console.log('p0_ambiguity_note complete.');
