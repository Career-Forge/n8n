/**
 * s126_fix_expand_query_country_schema_and_error_handling.js -- root-cause
 * fix for two live Telegram queries ("Find FDE roles in Google worldwide",
 * tried twice) that silently killed the whole search execution with zero
 * response to the user, plus two related hardening fixes in the same area.
 *
 * ROOT CAUSE (verified against real captured execution data, executions
 * 835/836, both "Model output doesn't fit required format"): the raw LLM
 * completion in both cases was 100% valid, complete data -- the visible
 * {"output": {...}} wrapper is n8n's own EXPECTED/INSTRUCTED shape for
 * outputParserStructured at this typeVersion (auto-wraps any authored
 * schema as z.object({output: yourSchema.optional()})), NOT a bug. The
 * actual, sole violation in both payloads: the schema declares
 * "country":{"type":"string"} (non-nullable) while its sibling
 * location_canonical correctly allows ["string","null"] -- for a
 * "worldwide" query the LLM correctly returns country: null (this was
 * always the intended design -- an earlier sprint's own rule: "country:
 * unstated means null, full stop"), but the schema type was never updated
 * to permit it. This also almost certainly explains the OLDER, never-
 * resolved scheduled-tick failures s102/s103 chased (see those scripts'
 * headers) -- Schedule Payload's default query is itself location-
 * unstated and very likely also resolves country: null.
 *
 * Do NOT re-enable Expand Query Output Parser's autoFix or touch the
 * "don't wrap in output" prompt line s102 added -- s103 already tried and
 * explicitly reverted both as an ineffective band-aid.
 *
 * Part 1: schema fix (root cause) -- country becomes nullable.
 * Part 2: onError safety net -- Expand Query gets a dedicated error branch
 *   (matching the JD Paste Extract precedent already live in this
 *   workflow), routing into the EXISTING Send Parse Error node (already
 *   schedule-safe via its isExecuted-guarded chatId expression).
 * Part 3: Parse Expand Query's 3 backstops (target_companies filter,
 *   remote_preference regex, freshness_explicit regex) all reference
 *   $('Prep Expand Input') with no fallback -- confirmed via graph BFS and
 *   a live scheduled execution (844) that Prep Expand Input never runs on
 *   the scheduled path, so these silently no-op there. Fixed with a named
 *   fallback to Schedule Payload (confirmed via ChainLlm.node.js source
 *   that $json.message_text is NOT available as a passthrough field on
 *   either path -- a named reference is required either way).
 *
 * Run: harness (real-payload schema validation + fixture checks) + deploy
 * (master workflow only) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ──────────────────────── Part 1: schema fix ────────────────────────
const SCHEMA_OLD = '"country":{"type":"string"}';
const SCHEMA_NEW = '"country":{"type":["string","null"]}';

// ──────────────────────── Part 2: onError safety net ────────────────────────
const EXPAND_QUERY_FAILED_NODE = {
  parameters: {
    jsCode: "// Expand Query Failed -- dedicated onError branch for Expand Query's\n// chainLlm/output-parser failures (s126). Does NOT inspect the incoming\n// error item's shape -- continueOnFail() on a chainLlm node always\n// produces the same generic { error: \"Model output doesn't fit required\n// format\" } item regardless of what actually broke, and the raw LLM\n// completion text is never recoverable from it (confirmed against the\n// installed n8n-nodes-langchain source). Routes into the EXISTING Send\n// Parse Error node, reusing its already schedule-safe chatId expression\n// ($('Extract Input').isExecuted ? ... : $('Schedule Payload')...) and\n// Telegram-send config -- this node's only job is to supply a friendly\n// error_message.\nreturn [{ json: {\n  error_message: \"⚠️ I had trouble understanding that job search request. Could you try rephrasing it?\\n\\n• \\\"find me AI Engineer jobs in NYC\\\"\\n• \\\"remote ML roles worldwide, $150k+\\\"\"\n} }];",
  },
  id: 'b3f7a5d2-6c19-4e8a-9d34-7f2b1a6e0c58',
  name: 'Expand Query Failed',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [29184, 46300],
};

// ──────────────────────── Part 3: scheduled-path backstop fix ────────────────────────
const ANCHOR0_OLD = `// A STORED pref still applies -- this strips only the ungrounded LLM value.
const REMOTE_LANG_RX = /remote|wfh|work.?from.?home|hybrid|on.?site|in.?office|telecommut/i;`;
const ANCHOR0_NEW = `// A STORED pref still applies -- this strips only the ungrounded LLM value.
// s126: named-reference fallback -- $json.message_text is NOT a passthrough
// field on either trigger path (confirmed against ChainLlm.node.js's
// formatResponse(): the item reaching this node only ever carries
// {output:{...}} or {error:...}), so a real fallback needs a named
// reference to whichever upstream node actually ran.
function resolveRawMessageText() {
  try { if ($('Prep Expand Input').isExecuted) return String($('Prep Expand Input').first().json.message_text || ''); } catch (e) {}
  try { if ($('Schedule Payload').isExecuted) return String($('Schedule Payload').first().json.message_text || ''); } catch (e) {}
  return '';
}
const REMOTE_LANG_RX = /remote|wfh|work.?from.?home|hybrid|on.?site|in.?office|telecommut/i;`;

const SITE1_OLD = `try {
  const rawMsg = String($('Prep Expand Input').first().json.message_text || '');
  if (result.remote_preference !== 'open' && !REMOTE_LANG_RX.test(rawMsg)) {
    result.remote_preference = (userPrefs.remote_preference && REMOTE_LANG_RX.test(String(userPrefs.remote_preference))) ? userPrefs.remote_preference : (userPrefs.remote_preference || 'open');
    if (result.remote_preference !== 'open' && !userPrefs.remote_preference) result.remote_preference = 'open';
  }
} catch (e) { /* Prep Expand Input always runs on this path; fail-open keeps the parsed value */ }`;
const SITE1_NEW = `try {
  const rawMsg = resolveRawMessageText();
  if (result.remote_preference !== 'open' && !REMOTE_LANG_RX.test(rawMsg)) {
    result.remote_preference = (userPrefs.remote_preference && REMOTE_LANG_RX.test(String(userPrefs.remote_preference))) ? userPrefs.remote_preference : (userPrefs.remote_preference || 'open');
    if (result.remote_preference !== 'open' && !userPrefs.remote_preference) result.remote_preference = 'open';
  }
} catch (e) { /* s126: resolveRawMessageText() never throws; kept for defense-in-depth only */ }`;

const SITE2_OLD = `try {
  result.freshness_explicit = FRESH_LANG_RX.test(String($('Prep Expand Input').first().json.message_text || ''));
} catch (e) { result.freshness_explicit = false; }`;
const SITE2_NEW = `try {
  result.freshness_explicit = FRESH_LANG_RX.test(resolveRawMessageText());
} catch (e) { result.freshness_explicit = false; }`;

const SITE3_OLD = `try {
  if (!result.company_cohort && Array.isArray(result.target_companies) && result.target_companies.length) {
    const rawMsgLower = String($('Prep Expand Input').first().json.message_text || '').toLowerCase();
    result.target_companies = result.target_companies.filter((co) => rawMsgLower.includes(String(co || '').toLowerCase()));
  }
} catch (e) { /* fail-open: keep the parsed list rather than block the search */ }`;
const SITE3_NEW = `try {
  if (!result.company_cohort && Array.isArray(result.target_companies) && result.target_companies.length) {
    const rawMsgLower = resolveRawMessageText().toLowerCase();
    result.target_companies = result.target_companies.filter((co) => rawMsgLower.includes(String(co || '').toLowerCase()));
  }
} catch (e) { /* fail-open: keep the parsed list rather than block the search */ }`;

function patch() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const byId = {}; const byName = {};
  wf.nodes.forEach((n) => { byId[n.id] = n; byName[n.name] = n; });

  // ---- Part 1 ----
  const parser = byName['Expand Query Output Parser'];
  if (!parser) { console.error('INTEGRITY FAIL: Expand Query Output Parser missing'); process.exit(1); }
  if (parser.parameters.inputSchema.includes('"country":{"type":["string","null"]}')) {
    console.log('  Part 1: already patched');
  } else {
    replaceOnce(parser.parameters, 'inputSchema', SCHEMA_OLD, SCHEMA_NEW, 'country schema type');
    console.log('  Part 1: OK -- country is now nullable');
  }

  // ---- Part 2 ----
  const expandQuery = byName['Expand Query'];
  if (!expandQuery) { console.error('INTEGRITY FAIL: Expand Query missing'); process.exit(1); }
  if (expandQuery.onError === 'continueErrorOutput') {
    console.log('  Part 2: Expand Query onError already set');
  } else if (expandQuery.onError) {
    console.error(`INTEGRITY FAIL: Expand Query already has an unexpected onError value: ${expandQuery.onError}`);
    process.exit(1);
  } else {
    expandQuery.onError = 'continueErrorOutput';
    console.log('  Part 2: Expand Query onError set');
  }

  if (!byName['Expand Query Failed']) {
    wf.nodes.push(JSON.parse(JSON.stringify(EXPAND_QUERY_FAILED_NODE)));
    console.log('  Part 2: Expand Query Failed node added');
  } else {
    console.log('  Part 2: Expand Query Failed node already present');
  }

  const eqConn = wf.connections['Expand Query'];
  if (!eqConn || !eqConn.main || !eqConn.main[0]) { console.error('INTEGRITY FAIL: Expand Query connections missing/malformed'); process.exit(1); }
  if (eqConn.main[0].length !== 1 || eqConn.main[0][0].node !== 'Parse Expand Query') {
    console.error('INTEGRITY FAIL: Expand Query branch 0 does not match the expected shape -- refusing to patch blind.');
    console.error(JSON.stringify(eqConn));
    process.exit(1);
  }
  if (eqConn.main[1]) {
    console.log('  Part 2: Expand Query branch 1 already present');
  } else {
    eqConn.main.push([{ node: 'Expand Query Failed', type: 'main', index: 0 }]);
    console.log('  Part 2: Expand Query branch 1 (error) added');
  }

  if (!wf.connections['Expand Query Failed']) {
    wf.connections['Expand Query Failed'] = { main: [[{ node: 'Send Parse Error', type: 'main', index: 0 }]] };
    console.log('  Part 2: Expand Query Failed -> Send Parse Error wired');
  } else {
    console.log('  Part 2: Expand Query Failed connections already present');
  }

  // ---- Part 3 ----
  const parseEQ = byName['Parse Expand Query'];
  if (!parseEQ) { console.error('INTEGRITY FAIL: Parse Expand Query missing'); process.exit(1); }
  if (parseEQ.parameters.jsCode.includes('function resolveRawMessageText')) {
    console.log('  Part 3: already patched');
  } else {
    replaceOnce(parseEQ.parameters, 'jsCode', ANCHOR0_OLD, ANCHOR0_NEW, 'insert resolveRawMessageText helper');
    replaceOnce(parseEQ.parameters, 'jsCode', SITE1_OLD, SITE1_NEW, 'remote_preference backstop schedule-safety');
    replaceOnce(parseEQ.parameters, 'jsCode', SITE2_OLD, SITE2_NEW, 'freshness_explicit backstop schedule-safety');
    replaceOnce(parseEQ.parameters, 'jsCode', SITE3_OLD, SITE3_NEW, 'target_companies backstop schedule-safety');
    console.log('  Part 3: OK -- 3 backstops now schedule-safe');
  }

  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log(`OK: s126 patches applied -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // Real captured payloads from the two actual failed executions (835, 836).
  const REAL_PAYLOAD_835 = {"role_families":["Field Sales Engineer","Solutions Engineer","Sales Engineer","Customer Engineer","Forward Deployed Engineer","Forward Deployed Software Engineer"],"excluded_roles":["Technical Support","Customer Success","QA Engineer","Intern","Internship"],"company_cohort":null,"target_companies":["Google"],"firecrawl_queries":["FDE roles Google worldwide","Forward Deployed Engineer Google","Solutions Engineer Google customer-facing technical roles"],"youcom_queries":["site:boards.greenhouse.io \"Forward Deployed Engineer\" Google","site:jobs.lever.co \"Solutions Engineer\" Google","site:myworkdayjobs.com \"Customer Engineer\" Google"],"serper_queries":["(site:boards.greenhouse.io OR site:jobs.lever.co OR site:myworkdayjobs.com) \"Forward Deployed Engineer\" Google after:2026-07-11","(site:boards.greenhouse.io OR site:jobs.lever.co OR site:myworkdayjobs.com) \"Solutions Engineer\" Google after:2026-07-11"],"location_canonical":"worldwide","country":null,"remote_preference":"open","freshness":"qdr:w","sort_by":"relevance","seniority":"any","max_yoe":null,"industry_signals":[],"visa_signals":[],"salary_signals":[],"scoring_priorities":["Google roles","FDE / solutions-engineering role fit","worldwide location coverage"],"verbose":false,"salary_min":null,"equity":false,"sponsorship_required":false,"cross_border_remote_note":"","exclude_recent_layoffs":false,"min_funding_stage":null,"culture_constraints":[]};
  const REAL_PAYLOAD_836 = {"role_families":["Field Solutions Engineer","Forward Deployed Engineer","Solutions Engineer","Implementation Engineer","Sales Engineer"],"excluded_roles":["Technical Support","Customer Success","QA Engineer","Intern","Internship"],"company_cohort":null,"target_companies":["Google"],"firecrawl_queries":["Forward Deployed Engineer Google worldwide","Field Solutions Engineer Google worldwide","Solutions Engineer Google worldwide"],"youcom_queries":["site:boards.greenhouse.io \"Forward Deployed Engineer\" Google worldwide","site:jobs.lever.co \"Field Solutions Engineer\" Google worldwide","site:myworkdayjobs.com \"Solutions Engineer\" Google worldwide"],"serper_queries":["(site:boards.greenhouse.io OR site:jobs.lever.co) \"Forward Deployed Engineer\" Google worldwide after:2026-07-11","site:jobs.myworkday.com \"Field Solutions Engineer\" Google worldwide"],"location_canonical":"worldwide","country":null,"remote_preference":"open","freshness":"qdr:w","sort_by":"relevance","seniority":"any","max_yoe":null,"industry_signals":[],"visa_signals":[],"salary_signals":[],"scoring_priorities":["Google roles","FDE / field solutions style roles","worldwide location fit"],"verbose":false,"salary_min":null,"equity":false,"sponsorship_required":false,"cross_border_remote_note":"","exclude_recent_layoffs":false,"min_funding_stage":null,"culture_constraints":[]};

  function typeOk(val, t) {
    const types = Array.isArray(t) ? t : [t];
    for (const typ of types) {
      if (typ === 'null' && val === null) return true;
      if (typ === 'string' && typeof val === 'string') return true;
      if (typ === 'boolean' && typeof val === 'boolean') return true;
      if (typ === 'integer' && Number.isInteger(val)) return true;
      if (typ === 'number' && typeof val === 'number') return true;
      if (typ === 'array' && Array.isArray(val)) return true;
    }
    return false;
  }
  function countViolations(schema, payload) {
    let violations = 0;
    for (const [k, sub] of Object.entries(schema.properties)) {
      if (!(k in payload)) continue;
      const v = payload[k];
      if (!typeOk(v, sub.type)) violations++;
      if (sub.type === 'array' && sub.minItems && Array.isArray(v) && v.length < sub.minItems) violations++;
    }
    for (const req of schema.required || []) {
      if (!(req in payload)) violations++;
    }
    return violations;
  }
  const BASE_PROPS = {"role_families":{"type":"array","items":{"type":"string"},"minItems":1},"excluded_roles":{"type":"array","items":{"type":"string"}},"company_cohort":{"type":["string","null"]},"target_companies":{"type":"array","items":{"type":"string"}},"firecrawl_queries":{"type":"array","items":{"type":"string"}},"youcom_queries":{"type":"array","items":{"type":"string"}},"serper_queries":{"type":"array","items":{"type":"string"}},"location_canonical":{"type":["string","null"]},"remote_preference":{"type":"string"},"freshness":{"type":"string"},"sort_by":{"type":"string"},"seniority":{"type":"string"},"max_yoe":{"type":["integer","number","null"]},"industry_signals":{"type":"array","items":{"type":"string"}},"visa_signals":{"type":"array","items":{"type":"string"}},"salary_signals":{"type":"array","items":{"type":"string"}},"scoring_priorities":{"type":"array","items":{"type":"string"}},"verbose":{"type":"boolean"},"salary_min":{"type":["number","null"]},"equity":{"type":"boolean"},"sponsorship_required":{"type":"boolean"},"cross_border_remote_note":{"type":"string"},"exclude_recent_layoffs":{"type":"boolean"},"min_funding_stage":{"type":["string","null"]},"culture_constraints":{"type":"array","items":{"type":"string"}}};
  const OLD_SCHEMA = { properties: Object.assign({}, BASE_PROPS, { country: { type: 'string' } }), required: ['role_families'] };
  const NEW_SCHEMA = { properties: Object.assign({}, BASE_PROPS, { country: { type: ['string', 'null'] } }), required: ['role_families'] };

  for (const [label, payload] of [['835', REAL_PAYLOAD_835], ['836', REAL_PAYLOAD_836]]) {
    const oldV = countViolations(OLD_SCHEMA, payload);
    const newV = countViolations(NEW_SCHEMA, payload);
    if (oldV !== 1) { console.error(`HARNESS FAIL: exec ${label} against OLD schema expected exactly 1 violation, got ${oldV}`); process.exit(1); }
    if (newV !== 0) { console.error(`HARNESS FAIL: exec ${label} against NEW schema expected 0 violations, got ${newV}`); process.exit(1); }
  }
  console.log('HARNESS OK: real payloads (execs 835, 836) -- OLD schema fails exactly once (country), NEW schema passes cleanly.');

  // resolveRawMessageText-equivalent fixture check.
  function resolveFixture(prepExecuted, prepText, scheduleExecuted, scheduleText) {
    try { if (prepExecuted) return String(prepText || ''); } catch (e) {}
    try { if (scheduleExecuted) return String(scheduleText || ''); } catch (e) {}
    return '';
  }
  if (resolveFixture(true, 'find AI jobs', false, null) !== 'find AI jobs') { console.error('HARNESS FAIL: Prep Expand Input case'); process.exit(1); }
  if (resolveFixture(false, null, true, 'find me AI Engineer jobs') !== 'find me AI Engineer jobs') { console.error('HARNESS FAIL: Schedule Payload fallback case'); process.exit(1); }
  if (resolveFixture(false, null, false, null) !== '') { console.error('HARNESS FAIL: neither-executed case should return empty string'); process.exit(1); }
  console.log('HARNESS OK: resolveRawMessageText fixture logic verified for all 3 states.');

  // Connections shape sanity (mirrors the JD Paste Extract precedent's real shape).
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const jdConn = wf.connections['JD Paste Extract'];
  if (!jdConn || !jdConn.main || jdConn.main.length !== 2 || jdConn.main[1][0].node !== 'JD Extract Failed') {
    console.error('HARNESS FAIL: JD Paste Extract precedent shape not as expected -- design assumption invalid');
    process.exit(1);
  }
  console.log('HARNESS OK: JD Paste Extract two-branch precedent confirmed live in the file.');

  patch();
  console.log('S126 (Expand Query country schema + onError + scheduled backstop) script complete.');
})();
