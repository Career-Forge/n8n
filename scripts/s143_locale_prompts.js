/**
 * s143_locale_prompts.js -- locale-aware resume/cover, step 4 of 5
 * (s140-s144). Prompt localization -- can run any time after s140 (only
 * needs ctx.locale_profile, already threaded).
 *
 * Resume side:
 *  - Pass2 Generate + Pass2 Regen (byte-identical chainLlm system prompts,
 *    confirmed this session): ONE generic new paragraph telling the model to
 *    follow an "== LOCALE STYLE ==" block when the user message contains
 *    one -- no locale-specific logic in the prompt itself, that lives in
 *    the data (locale_profiles.json) and the new buildLocaleBlock() below.
 *  - Build Pass2 Input + Build Pass2 Regen Input (byte-identical
 *    buildBudgetBlock siblings, confirmed this session): new shared
 *    buildLocaleBlock(profile) emits the == LOCALE STYLE == block from
 *    ctx.locale_profile.spelling/style_hints -- '' (no-op) for DEFAULT/no
 *    profile, so pass2_user is unchanged for the common case.
 *
 * Cover side (n8n expression nodes, not Code nodes):
 *  - Cover Pass1's `text` expression gains locale_structure_hint (from
 *    ctx.locale_profile.cover.structure_hint); its prompt gets one line
 *    telling it to factor that into toneNotes/openingHook guidance.
 *  - Cover Pass2's `text` expression gains locale_salutation_hint +
 *    locale_structure_hint; its prompt's salutation schema line and RULES
 *    section reference them. The closing line stays untouched here --
 *    already deterministic/skeleton-side via s141's {{CLOSING}} token, never
 *    the LLM's job.
 *
 * Re-run export_prompts.js after (Pass2 Generate/Regen sibling-identity
 * check + Build Pass2 Input/Regen Input's buildBudgetBlock check already
 * exist as drift guards -- this script keeps both pairs byte-identical).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}

// ════════════════════ Part 1: Pass2 Generate / Pass2 Regen ════════════════════
const P2_OLD = 'When in doubt, write SHORTER: a clean 145-character bullet beats a cut-off 200-character one every time.';
const P2_NEW = P2_OLD + '\n\nLOCALE: if the user message contains a == LOCALE STYLE == block, follow its spelling convention (American vs British English) and any style hints given there. If no such block is present, write in standard American English.';

function patchPass2Node(nodeName, wf) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) { console.error(`INTEGRITY FAIL: ${nodeName} missing`); process.exit(1); }
  const msg = n.parameters.messages.messageValues[0].message;
  if (msg.includes('== LOCALE STYLE ==')) { console.log(`  ${nodeName}: already patched`); return; }
  const count = msg.split(P2_OLD).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: ${nodeName} P2_OLD anchor found ${count} times, expected 1`); process.exit(1); }
  n.parameters.messages.messageValues[0].message = msg.replace(P2_OLD, () => P2_NEW);
  console.log(`  ${nodeName}: patched`);
}

// ════════════════════ Part 2: Build Pass2 Input / Build Pass2 Regen Input ════════════════════
// Byte-identical buildLocaleBlock() added to both, right before the
// existing buildBudgetBlock() -- same shared-siblings convention.
const BUDGET_FN_ANCHOR = 'function buildBudgetBlock(p1) {';
const LOCALE_BLOCK_FN = `function buildLocaleBlock(profile) {
  if (!profile) return '';
  const hints = Array.isArray(profile.style_hints) ? profile.style_hints.filter(Boolean) : [];
  if (profile.spelling !== 'en-GB' && !hints.length) return '';
  const spelling = profile.spelling === 'en-GB' ? 'British English spelling (e.g. "optimised", "colour", "organisation")' : 'American English spelling';
  let block = '\\n\\n== LOCALE STYLE ==\\nWrite in ' + spelling + '.';
  if (hints.length) block += ' ' + hints.join(' ');
  return block;
}
` + BUDGET_FN_ANCHOR;

const BPI_PASS2USER_OLD = "  + antiHalluc + buildBudgetBlock(pass1) + '\\n\\n' + pass2Input;";
const BPI_PASS2USER_NEW = "  + antiHalluc + buildLocaleBlock((($('Prepare Apply Context').first().json || {}).locale_profile) || null) + buildBudgetBlock(pass1) + '\\n\\n' + pass2Input;";

const BPRI_PASS2USER_OLD = "  + antiHalluc + atsGuidance + buildBudgetBlock(pass1) + '\\n\\n' + pass2Input;";
const BPRI_PASS2USER_NEW = "  + antiHalluc + atsGuidance + buildLocaleBlock((($('Prepare Apply Context').first().json || {}).locale_profile) || null) + buildBudgetBlock(pass1) + '\\n\\n' + pass2Input;";

function patchBuildPass2Input(wf) {
  const n = wf.nodes.find((x) => x.name === 'Build Pass2 Input');
  if (!n) { console.error('INTEGRITY FAIL: Build Pass2 Input missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('function buildLocaleBlock(')) { console.log('  Build Pass2 Input: already patched'); return; }
  replaceOnce(n.parameters, 'jsCode', BUDGET_FN_ANCHOR, LOCALE_BLOCK_FN, 'Build Pass2 Input buildBudgetBlock insertion point');
  replaceOnce(n.parameters, 'jsCode', BPI_PASS2USER_OLD, BPI_PASS2USER_NEW, 'Build Pass2 Input pass2_user construction');
  console.log('  Build Pass2 Input: patched');
}
function patchBuildPass2RegenInput(wf) {
  const n = wf.nodes.find((x) => x.name === 'Build Pass2 Regen Input');
  if (!n) { console.error('INTEGRITY FAIL: Build Pass2 Regen Input missing'); process.exit(1); }
  if (n.parameters.jsCode.includes('function buildLocaleBlock(')) { console.log('  Build Pass2 Regen Input: already patched'); return; }
  replaceOnce(n.parameters, 'jsCode', BUDGET_FN_ANCHOR, LOCALE_BLOCK_FN, 'Build Pass2 Regen Input buildBudgetBlock insertion point');
  replaceOnce(n.parameters, 'jsCode', BPRI_PASS2USER_OLD, BPRI_PASS2USER_NEW, 'Build Pass2 Regen Input pass2_user construction');
  console.log('  Build Pass2 Regen Input: patched');
}

// ════════════════════ Part 3: Cover Pass1 ════════════════════
const CP1_TEXT_OLD = "={{ JSON.stringify({ resume: $('Prepare Apply Context').first().json.resume_text, jd: $('Prepare Apply Context').first().json.job_description, company: $('Prepare Apply Context').first().json.company, role: $('Prepare Apply Context').first().json.job_title, dossier: ($('Pass Dossier').first().json||{}).dossier, tier: $('Prepare Apply Context').first().json.seniority_mode }) }}";
const CP1_TEXT_NEW = "={{ JSON.stringify({ resume: $('Prepare Apply Context').first().json.resume_text, jd: $('Prepare Apply Context').first().json.job_description, company: $('Prepare Apply Context').first().json.company, role: $('Prepare Apply Context').first().json.job_title, dossier: ($('Pass Dossier').first().json||{}).dossier, tier: $('Prepare Apply Context').first().json.seniority_mode, locale_structure_hint: ((($('Prepare Apply Context').first().json.locale_profile)||{}).cover||{}).structure_hint || '' }) }}";

const CP1_PROMPT_OLD = "IMPORTANT: company, role, and tier are provided directly in the input JSON (already computed upstream by earlier nodes in this same run) -- use them VERBATIM for extractedCompany/extractedRole/tier in your output. Do NOT re-derive them from the JD text, and do NOT second-guess the provided tier. ONE exception: if the provided company is 'unknown' or empty, extract the real company name from the JD text for extractedCompany (and likewise derive extractedRole if the provided role is empty or reads like a page title rather than a job title).";
const CP1_PROMPT_NEW = CP1_PROMPT_OLD + "\n\nLOCALE: if the input's locale_structure_hint is non-empty, factor it into toneNotes and openingHook guidance (e.g. a hint like \"more formal, fact-dense tone; avoid overly promotional language\" should measurably shift word choice away from typical enthusiastic American framing). If empty, use your normal judgment.";

function patchCoverPass1(wf) {
  const n = wf.nodes.find((x) => x.name === 'Cover Pass1');
  if (!n) { console.error('INTEGRITY FAIL: Cover Pass1 missing'); process.exit(1); }
  if (n.parameters.text.includes('locale_structure_hint')) { console.log('  Cover Pass1: already patched'); return; }
  replaceOnce(n.parameters, 'text', CP1_TEXT_OLD, CP1_TEXT_NEW, 'Cover Pass1 text expression');
  const msg = n.parameters.messages.messageValues[0].message;
  const count = msg.split(CP1_PROMPT_OLD).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: Cover Pass1 prompt anchor found ${count} times, expected 1`); process.exit(1); }
  n.parameters.messages.messageValues[0].message = msg.replace(CP1_PROMPT_OLD, () => CP1_PROMPT_NEW);
  console.log('  Cover Pass1: patched');
}

// ════════════════════ Part 4: Cover Pass2 ════════════════════
const CP2_TEXT_OLD = "={{ JSON.stringify({ selection: $('Parse Cover Pass1').first().json.cover1, jd: $('Prepare Apply Context').first().json.job_description, company: $('Prepare Apply Context').first().json.company, candidate_location: (($('Prepare Apply Context').first().json.personal)||{}).location || '', job_location: $('Prepare Apply Context').first().json.location || '' }) }}";
const CP2_TEXT_NEW = "={{ JSON.stringify({ selection: $('Parse Cover Pass1').first().json.cover1, jd: $('Prepare Apply Context').first().json.job_description, company: $('Prepare Apply Context').first().json.company, candidate_location: (($('Prepare Apply Context').first().json.personal)||{}).location || '', job_location: $('Prepare Apply Context').first().json.location || '', locale_salutation_hint: ((($('Prepare Apply Context').first().json.locale_profile)||{}).cover||{}).salutation_hint || '', locale_structure_hint: ((($('Prepare Apply Context').first().json.locale_profile)||{}).cover||{}).structure_hint || '' }) }}";

const CP2_SALUTATION_OLD = '  "salutation": "Dear <Company> Hiring Team,",';
const CP2_SALUTATION_NEW = '  "salutation": "<a greeting matching the input\'s locale_salutation_hint if non-empty (e.g. \'Dear Hiring Manager,\'), otherwise \'Dear <Company> Hiring Team,\'>",';

const CP2_RULES_OLD = '- Plain professional prose inside field values. No LaTeX, no markdown.';
const CP2_RULES_NEW = CP2_RULES_OLD + '\n- If locale_structure_hint is non-empty, follow its guidance for overall tone (e.g. more formal and fact-dense, less promotional language) without changing the bullet-count/word-count/STAR rules above.';

function patchCoverPass2(wf) {
  const n = wf.nodes.find((x) => x.name === 'Cover Pass2');
  if (!n) { console.error('INTEGRITY FAIL: Cover Pass2 missing'); process.exit(1); }
  if (n.parameters.text.includes('locale_salutation_hint')) { console.log('  Cover Pass2: already patched'); return; }
  replaceOnce(n.parameters, 'text', CP2_TEXT_OLD, CP2_TEXT_NEW, 'Cover Pass2 text expression');
  const msg0 = n.parameters.messages.messageValues[0].message;
  const c1 = msg0.split(CP2_SALUTATION_OLD).length - 1;
  if (c1 !== 1) { console.error(`INTEGRITY FAIL: Cover Pass2 salutation anchor found ${c1} times, expected 1`); process.exit(1); }
  let msg = msg0.replace(CP2_SALUTATION_OLD, () => CP2_SALUTATION_NEW);
  const c2 = msg.split(CP2_RULES_OLD).length - 1;
  if (c2 !== 1) { console.error(`INTEGRITY FAIL: Cover Pass2 rules anchor found ${c2} times, expected 1`); process.exit(1); }
  msg = msg.replace(CP2_RULES_OLD, () => CP2_RULES_NEW);
  n.parameters.messages.messageValues[0].message = msg;
  console.log('  Cover Pass2: patched');
}

// ════════════════════════════════ HARNESS ════════════════════════════════
(function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const N = {};
  for (const n of wf.nodes) N[n.name] = n;

  // ---- Pre-patch anchor integrity ----
  for (const name of ['Pass2 Generate', 'Pass2 Regen']) {
    const msg = N[name].parameters.messages.messageValues[0].message;
    if (!msg.includes('== LOCALE STYLE ==')) {
      check(`${name}: P2_OLD anchor unique`, msg.split(P2_OLD).length - 1 === 1);
    }
  }
  check('Pass2 Generate === Pass2 Regen BEFORE patch (byte-identical sibling contract)', N['Pass2 Generate'].parameters.messages.messageValues[0].message === N['Pass2 Regen'].parameters.messages.messageValues[0].message);

  for (const name of ['Build Pass2 Input', 'Build Pass2 Regen Input']) {
    const code = N[name].parameters.jsCode;
    if (!code.includes('function buildLocaleBlock(')) {
      check(`${name}: buildBudgetBlock anchor unique`, code.split(BUDGET_FN_ANCHOR).length - 1 === 1);
    }
  }
  if (!N['Build Pass2 Input'].parameters.jsCode.includes('function buildLocaleBlock(')) {
    check('Build Pass2 Input: pass2_user anchor unique', N['Build Pass2 Input'].parameters.jsCode.split(BPI_PASS2USER_OLD).length - 1 === 1);
  }
  if (!N['Build Pass2 Regen Input'].parameters.jsCode.includes('function buildLocaleBlock(')) {
    check('Build Pass2 Regen Input: pass2_user anchor unique', N['Build Pass2 Regen Input'].parameters.jsCode.split(BPRI_PASS2USER_OLD).length - 1 === 1);
  }

  if (!N['Cover Pass1'].parameters.text.includes('locale_structure_hint')) {
    check('Cover Pass1: text expression anchor unique', N['Cover Pass1'].parameters.text.split(CP1_TEXT_OLD).length - 1 === 1);
    check('Cover Pass1: prompt anchor unique', N['Cover Pass1'].parameters.messages.messageValues[0].message.split(CP1_PROMPT_OLD).length - 1 === 1);
  }
  if (!N['Cover Pass2'].parameters.text.includes('locale_salutation_hint')) {
    check('Cover Pass2: text expression anchor unique', N['Cover Pass2'].parameters.text.split(CP2_TEXT_OLD).length - 1 === 1);
    check('Cover Pass2: salutation anchor unique', N['Cover Pass2'].parameters.messages.messageValues[0].message.split(CP2_SALUTATION_OLD).length - 1 === 1);
    check('Cover Pass2: rules anchor unique', N['Cover Pass2'].parameters.messages.messageValues[0].message.split(CP2_RULES_OLD).length - 1 === 1);
  }

  if (failures > 0) { console.error(`\n${failures} PRE-PATCH ANCHOR FAILURE(S)`); process.exit(1); }

  // ---- Behavioral tests on the REAL new functions/logic ----
  function runBuildLocaleBlock(profile) {
    const fn = new Function('profile', LOCALE_BLOCK_FN.slice(0, LOCALE_BLOCK_FN.length - BUDGET_FN_ANCHOR.length) + '\nreturn buildLocaleBlock(profile);');
    return fn(profile);
  }
  check('buildLocaleBlock: null profile -> no-op empty string', runBuildLocaleBlock(null) === '');
  check('buildLocaleBlock: DEFAULT-shaped profile (en-US, no hints) -> no-op empty string', runBuildLocaleBlock({ spelling: 'en-US', style_hints: [] }) === '');
  const ukBlock = runBuildLocaleBlock({ spelling: 'en-GB', style_hints: ['understated tone over promotional language'] });
  check('buildLocaleBlock: en-GB profile mentions British spelling', ukBlock.includes('British English spelling'));
  check('buildLocaleBlock: style hint included verbatim', ukBlock.includes('understated tone over promotional language'));
  const usHintsOnlyBlock = runBuildLocaleBlock({ spelling: 'en-US', style_hints: ['precise, factual tone over promotional language'] });
  check('buildLocaleBlock: en-US WITH hints still emits a block (hints matter even without spelling change)', usHintsOnlyBlock.includes('American English spelling') && usHintsOnlyBlock.includes('precise, factual tone'));

  // pass2_user construction ordering -- locale block must sit between
  // antiHalluc and buildBudgetBlock (both existing, verified unchanged).
  function simulatePass2UserOrder(hasAtsGuidance) {
    const antiHalluc = '<ANTIHALLUC>';
    const atsGuidance = hasAtsGuidance ? '<ATSGUIDANCE>' : '';
    const localeBlock = '<LOCALEBLOCK>';
    const budgetBlock = '<BUDGETBLOCK>';
    const pass2Input = '<PASS2INPUT>';
    return hasAtsGuidance
      ? ('BASE' + antiHalluc + atsGuidance + localeBlock + budgetBlock + '\n\n' + pass2Input)
      : ('BASE' + antiHalluc + localeBlock + budgetBlock + '\n\n' + pass2Input);
  }
  check('pass2_user ordering (Build Pass2 Input): antiHalluc -> locale -> budget -> input', simulatePass2UserOrder(false) === 'BASE<ANTIHALLUC><LOCALEBLOCK><BUDGETBLOCK>\n\n<PASS2INPUT>');
  check('pass2_user ordering (Build Pass2 Regen Input): antiHalluc -> atsGuidance -> locale -> budget -> input', simulatePass2UserOrder(true) === 'BASE<ANTIHALLUC><ATSGUIDANCE><LOCALEBLOCK><BUDGETBLOCK>\n\n<PASS2INPUT>');

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: Pass2 Generate/Regen prompts confirmed byte-identical before patch; buildLocaleBlock no-ops for null/DEFAULT-shaped profiles, emits a block for en-GB and for en-US-with-hints, includes style hints verbatim; pass2_user field ordering correct for both the plain and ATS-retry builders; all anchors unique pre-write.');

  // ── Writes ──
  patchPass2Node('Pass2 Generate', wf);
  patchPass2Node('Pass2 Regen', wf);
  patchBuildPass2Input(wf);
  patchBuildPass2RegenInput(wf);
  patchCoverPass1(wf);
  patchCoverPass2(wf);
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));

  // Post-write sibling-identity re-check.
  const wf2 = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const p2g = wf2.nodes.find((n) => n.name === 'Pass2 Generate').parameters.messages.messageValues[0].message;
  const p2r = wf2.nodes.find((n) => n.name === 'Pass2 Regen').parameters.messages.messageValues[0].message;
  if (p2g !== p2r) { console.error('INTEGRITY FAIL: Pass2 Generate and Pass2 Regen diverged post-patch!'); process.exit(1); }
  console.log('  post-write check: Pass2 Generate === Pass2 Regen (still byte-identical siblings)');

  console.log('S143 (prompt localization) script complete.');
})();
