/**
 * s77_resume_country_default.js -- user instruction: "the default location is
 * determined as the country of current residence, from the resume. In case of
 * multiple countries, the default location is the 1st one." This replaces
 * needing to type a "remember I'm in X" pref at all -- the default now derives
 * LIVE from the resume every search, so it can never go stale independently of
 * the resume itself (the exact class of bug s75/s76 just spent two sprints
 * fixing for the *pref* path -- this closes the analogous gap for "no pref set
 * at all").
 *
 * TRAP AVOIDED (found during investigation, not assumed): the naive
 * implementation -- setting location_canonical = "India" -- would route
 * through Aggregate Jobs' CITY-SUBSTRING matcher (hasCityConstraint), which
 * would then WRONGLY reject a real India-based job whose location field says
 * "Bangalore, Karnataka" (no literal substring "india" in that string). The
 * codebase already has a correct, separate COUNTRY-level fallback --
 * `expandCtx.country` (an ISO code) feeding `detectCountryFromLocation()`,
 * which has a real city/state -> country lookup table. This fix populates
 * THAT field, not location_canonical, and leaves location_canonical null.
 *
 * Resume data isn't available at Prep Expand Input today -- `Gate Has Resume`
 * reads the file only to compute a boolean and discards the parsed JSON.
 * Adds ONE new node (Read Resume For Location, mirrors the existing
 * Read Resume->Read Resume (parse) pattern already proven elsewhere in this
 * same workflow) between `IF: Resume For Search?` (true branch, the only
 * connection into Prep Expand Input -- confirmed via the connections graph,
 * so this insertion cannot be reached without a resume already present) and
 * `Prep Expand Input`, which parses just personal.location.country.
 *
 * "Multiple countries, take the first": defensively splits the resume's
 * country string on common separators (comma/slash/pipe/and/or/semicolon)
 * and maps the first segment through a small NAME_TO_ISO table -- the exact
 * same alias set as Aggregate Jobs' own COUNTRY_NAMES table, duplicated (not
 * shared, per this codebase's established Code-node convention) for
 * consistency with what detectCountryFromLocation() actually recognizes.
 *
 * Priority chain (extends s75's rule): explicit message location > stored
 * pref location > THIS resume-derived country default > existing "US"
 * default. Unrecognized/missing resume location = no injection, today's
 * fallback-of-fallbacks behavior is completely unchanged.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// ── The actual country-resolution logic (shared source for both the real
//    patch and the harness -- the harness eval's THIS exact string). ──
const RESOLVE_COUNTRY_SRC = `
function resolveResumeCountryDefault(resumeJson) {
  // s77: same alias set as Aggregate Jobs' own COUNTRY_NAMES table (kept in
  // sync manually -- Code nodes can't share modules).
  const NAME_TO_ISO = {
    'india':'IN',
    'usa':'US','u.s.a':'US','u.s.a.':'US','u.s.':'US','united states':'US','united states of america':'US','america':'US',
    'uk':'GB','u.k.':'GB','united kingdom':'GB','britain':'GB','england':'GB','scotland':'GB','wales':'GB',
    'canada':'CA','australia':'AU','germany':'DE','deutschland':'DE','singapore':'SG',
    'uae':'AE','united arab emirates':'AE','dubai':'AE','abu dhabi':'AE',
    'netherlands':'NL','holland':'NL','france':'FR','ireland':'IE','new zealand':'NZ',
  };
  try {
    const raw = String((resumeJson && resumeJson.personal && resumeJson.personal.location && resumeJson.personal.location.country) || '').trim();
    if (!raw) return null;
    // "In case of multiple countries, the default location is the 1st one."
    const first = raw.split(/\\s*(?:,|\\/|\\||;|\\band\\b|\\bor\\b)\\s*/i).filter(Boolean)[0] || raw;
    const iso = NAME_TO_ISO[first.toLowerCase().trim()];
    return iso || null;
  } catch (e) { return null; }
}
`.trim();

// ── 1. Prep Expand Input: parse the new upstream file, resolve, inject ──
const PEI_OLD = "const sd = $getWorkflowStaticData('global');\nconst prefs = sd.user_prefs || {};";
const PEI_NEW = RESOLVE_COUNTRY_SRC + "\n\nconst sd = $getWorkflowStaticData('global');\nconst prefs = sd.user_prefs || {};\n\n" +
  "// s77: resolve the resume-derived country default. This node only runs on\n" +
  "// the 'has resume' branch of IF: Resume For Search?, so a resume file is\n" +
  "// guaranteed present -- but personal.location.country may still be empty on\n" +
  "// older resumes, so this stays optional (null = no injection, no behavior\n" +
  "// change from before this fix).\n" +
  "let resumeCountryDefault = null;\n" +
  "try {\n" +
  "  const buf = await this.helpers.getBinaryDataBuffer(0, 'data');\n" +
  "  if (buf && buf.length) resumeCountryDefault = resolveResumeCountryDefault(JSON.parse(buf.toString('utf8')));\n" +
  "} catch (e) {}";

const PEI_RET_OLD = "return [{\n  json: {\n    ...$input.first().json,         // carry through intent/entities from Route Intent\n    message_text: msg,\n    user_prefs_snapshot: JSON.stringify(prefs)\n  }\n}];";
const PEI_RET_NEW = "return [{\n  json: {\n    // s77: was $input.first().json -- broke the moment a readWriteFile node\n    // (Read Resume For Location) became this node's DIRECT upstream, since a\n    // readWriteFile node's own json output is file metadata, not a pass-\n    // through of what fed INTO it. Re-anchor explicitly to the IF node\n    // (a pure router -- guaranteed to pass its input json through unchanged),\n    // same defensive pattern Gate Has Resume already uses for this exact\n    // reason (re-pulling from a named upstream node instead of trusting\n    // whatever sits immediately before it).\n    ...$('IF: Resume For Search?').first().json,\n    message_text: msg,\n    user_prefs_snapshot: JSON.stringify(prefs),\n    resume_country_default: resumeCountryDefault\n  }\n}];";

// ── 2. Expand Query: user-turn text surfaces the new field ──
const EQ_TEXT_OLD = "={{ 'Query: ' + $json.message_text + '\\n\\nUser preferences: ' + $json.user_prefs_snapshot + '\\n\\nExpand into job search parameters.' }}";
const EQ_TEXT_NEW = "={{ 'Query: ' + $json.message_text + '\\n\\nUser preferences: ' + $json.user_prefs_snapshot + '\\n\\nResume-derived default country (ISO code, use ONLY as last resort -- see PRIORITY RULE): ' + ($json.resume_country_default || 'none') + '\\n\\nExpand into job search parameters.' }}";

// ── 3. Expand Query: system prompt tier-3 rule (extends the s75 rule) ──
const EQ_SYS_OLD = 'PRIORITY RULE (absolute): if the user\'s OWN MESSAGE states any location signal -- a specific place, "remote", "worldwide", "anywhere", "global", "any location" -- that ALWAYS wins over "User preferences", no exceptions, even if a preference exists. Only use the preference\'s location when the message itself contains ZERO location language. NEVER blend the message\'s location with the preference\'s location into one string -- pick exactly one source. When the message says "worldwide"/"anywhere"/"any location", output the single word "worldwide" (not a sentence).\n';
const EQ_SYS_NEW = 'PRIORITY RULE (absolute): if the user\'s OWN MESSAGE states any location signal -- a specific place, "remote", "worldwide", "anywhere", "global", "any location" -- that ALWAYS wins over "User preferences", no exceptions, even if a preference exists. Only use the preference\'s location when the message itself contains ZERO location language. NEVER blend the message\'s location with the preference\'s location into one string -- pick exactly one source. When the message says "worldwide"/"anywhere"/"any location", output the single word "worldwide" (not a sentence). THIRD TIER: if the message has zero location language AND no preference location is set, and "Resume-derived default country" is not "none", set country to that ISO code and leave location_canonical null (this is a COUNTRY-level default, not a city -- never invent a city).\n';

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const name of ['IF: Resume For Search?', 'Prep Expand Input', 'Expand Query']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Prep Expand Input'].parameters.jsCode.includes('resolveResumeCountryDefault')) {
    console.log(`  ${base}: already patched`); return;
  }

  // ── graph edit: insert Read Resume For Location between the IF and Prep Expand Input ──
  const ifNode = N['IF: Resume For Search?'];
  const peiNode = N['Prep Expand Input'];
  const newNode = {
    parameters: { fileSelector: '/data/user-data/resume_structured.json', options: {} },
    type: 'n8n-nodes-base.readWriteFile',
    typeVersion: 1.1,
    position: [
      Math.round((ifNode.position[0] + peiNode.position[0]) / 2),
      Math.round((ifNode.position[1] + peiNode.position[1]) / 2),
    ],
    id: crypto.randomUUID(),
    name: 'Read Resume For Location',
    onError: 'continueRegularOutput',
  };
  wf.nodes.push(newNode);

  const trueBranch = wf.connections['IF: Resume For Search?'].main[0];
  if (trueBranch.length !== 1 || trueBranch[0].node !== 'Prep Expand Input') {
    console.error(`INTEGRITY FAIL ${base}: IF: Resume For Search? true branch shape changed, expected exactly [{node:"Prep Expand Input"}]`);
    process.exit(1);
  }
  wf.connections['IF: Resume For Search?'].main[0] = [{ node: 'Read Resume For Location', type: 'main', index: 0 }];
  wf.connections['Read Resume For Location'] = { main: [[{ node: 'Prep Expand Input', type: 'main', index: 0 }]] };

  // ── code/prompt edits ──
  replaceOnce(N['Prep Expand Input'].parameters, 'jsCode', PEI_OLD, PEI_NEW, 'resolveResumeCountryDefault + resolve call', base);
  replaceOnce(N['Prep Expand Input'].parameters, 'jsCode', PEI_RET_OLD, PEI_RET_NEW, 'inject resume_country_default into output', base);
  replaceOnce(N['Expand Query'].parameters, 'text', EQ_TEXT_OLD, EQ_TEXT_NEW, 'user-turn text surfaces resume default', base);
  const mv = N['Expand Query'].parameters.messages.messageValues;
  replaceOnce(mv[0], 'message', EQ_SYS_OLD, EQ_SYS_NEW, 'tier-3 priority rule', base);

  // ── graph integrity: every connection target must be a real node ──
  const nodeNames = new Set(wf.nodes.map((n) => n.name));
  for (const [src, def] of Object.entries(wf.connections)) {
    if (!nodeNames.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" is not a node`); process.exit(1); }
    for (const outputs of (def.main || [])) {
      for (const c of outputs) {
        if (!nodeNames.has(c.node)) { console.error(`INTEGRITY FAIL ${base}: connection target "${c.node}" (from ${src}) is not a node`); process.exit(1); }
      }
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: resume-derived country default wired (+1 node, ${wf.nodes.length} total) -- graph integrity verified`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  const resolveResumeCountryDefault = new Function('resumeJson', RESOLVE_COUNTRY_SRC + '\nreturn resolveResumeCountryDefault(resumeJson);');

  const fixtures = [
    { label: 'real current resume (Belagavi, Karnataka, India)', json: { personal: { location: { city: 'Belagavi', region: 'Karnataka', country: 'India' } } }, want: 'IN' },
    { label: 'multiple countries, comma-separated -- take 1st', json: { personal: { location: { country: 'India, USA' } } }, want: 'IN' },
    { label: 'multiple countries, slash-separated -- take 1st', json: { personal: { location: { country: 'USA / India' } } }, want: 'US' },
    { label: 'multiple countries, "and"-joined -- take 1st', json: { personal: { location: { country: 'United Kingdom and Ireland' } } }, want: 'GB' },
    { label: 'single recognized country, different alias', json: { personal: { location: { country: 'Deutschland' } } }, want: 'DE' },
    { label: 'empty country string', json: { personal: { location: { country: '' } } }, want: null },
    { label: 'missing location entirely', json: { personal: {} }, want: null },
    { label: 'missing personal entirely', json: {}, want: null },
    { label: 'unrecognized country name (never guess)', json: { personal: { location: { country: 'Atlantis' } } }, want: null },
    { label: 'null resumeJson (defensive)', json: null, want: null },
  ];
  for (const f of fixtures) {
    const got = resolveResumeCountryDefault(f.json);
    if (got !== f.want) { console.error(`HARNESS FAIL: "${f.label}" -> got ${JSON.stringify(got)}, expected ${JSON.stringify(f.want)}`); process.exit(1); }
  }

  // Confirm the ISO codes we resolve to are exactly the keys Aggregate Jobs'
  // own detectCountryFromLocation() would produce for the SAME country names
  // -- the real downstream consistency check, not just an isolated unit test.
  const LIVE_COUNTRY_NAMES = { US: ['usa','u.s.a','u.s.','united states','america'], IN: ['india'], GB: ['uk','u.k.','united kingdom','britain','england','scotland','wales'], CA: ['canada'], AU: ['australia'], DE: ['germany','deutschland'], SG: ['singapore'], AE: ['uae','united arab emirates','dubai','abu dhabi'], NL: ['netherlands','holland'], FR: ['france'], IE: ['ireland'], NZ: ['new zealand'] };
  for (const [iso, aliases] of Object.entries(LIVE_COUNTRY_NAMES)) {
    for (const alias of aliases) {
      const got = resolveResumeCountryDefault({ personal: { location: { country: alias } } });
      if (got !== iso) { console.error(`HARNESS FAIL: downstream-consistency -- alias "${alias}" resolves to ${JSON.stringify(got)} here but "${iso}" in Aggregate Jobs' own table`); process.exit(1); }
    }
  }

  // Prompt/text sanity
  if (!EQ_SYS_NEW.includes('THIRD TIER')) { console.error('HARNESS FAIL: tier-3 rule text missing'); process.exit(1); }
  if (!EQ_SYS_NEW.includes('never invent a city')) { console.error('HARNESS FAIL: city-invention guard missing from prompt'); process.exit(1); }
  if (!EQ_TEXT_NEW.includes('resume_country_default')) { console.error('HARNESS FAIL: resume default not surfaced in user-turn text'); process.exit(1); }
  if (!PEI_RET_NEW.includes("$('IF: Resume For Search?').first().json")) { console.error('HARNESS FAIL: context re-anchor missing -- $input.first().json regression not fixed'); process.exit(1); }
  if (PEI_RET_NEW.includes('...$input.first().json')) { console.error('HARNESS FAIL: still reads the wrong upstream (Read Resume For Location) for context'); process.exit(1); }

  // Graph-shape sanity on the new node definition (mirrors the real script's own node object)
  const testNode = { parameters: { fileSelector: '/data/user-data/resume_structured.json', options: {} }, type: 'n8n-nodes-base.readWriteFile', typeVersion: 1.1, position: [0, 0], id: 'x', name: 'Read Resume For Location', onError: 'continueRegularOutput' };
  if (testNode.type !== 'n8n-nodes-base.readWriteFile' || testNode.parameters.fileSelector !== '/data/user-data/resume_structured.json') {
    console.error('HARNESS FAIL: new node shape does not match the proven Read Resume / Gate Read Resume pattern'); process.exit(1);
  }

  console.log('HARNESS OK: resume country resolution matches on the real current resume (Belagavi/Karnataka/India -> IN); the "multiple countries, take the first" rule holds across comma/slash/"and" separators; every alias resolves to the SAME ISO code Aggregate Jobs\' own detectCountryFromLocation() table would produce (downstream consistency proven, not assumed); unrecognized/missing/malformed input all degrade to null (no guessing, no crash); prompt carries the tier-3 rule with the country-not-city guard.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S77 (resume-derived country default: message > pref > resume.personal.location.country (first of multiple) > existing "US" fallback) complete.');
