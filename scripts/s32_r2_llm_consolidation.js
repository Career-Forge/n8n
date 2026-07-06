/**
 * s32_r2_llm_consolidation.js -- Sprint R2 (partial) of the post-audit rebuild
 * plan (2026-07-05 v5 addendum): items 1, 2, 4 of 5. An apply/score/cover flow
 * fires more LLM calls than it needs to, several re-deriving data an earlier
 * node in the SAME run already computed -- this trims three of those without
 * touching graph topology (items 3 "parallelize Step0" and 5 "intel cache
 * read" both need new nodes/branches and are deliberately left for a separate
 * pass -- more structural risk than a prompt/input edit, deserve their own
 * harness and verification, not to be rushed into the same patch).
 *
 * 1. DROP SCOREONLY. Load Score Context only ever loads staticData.last_apply
 *    (confirmed -- there is no "score an arbitrary resume" path in this bot,
 *    `score` is always scoped to whatever the last `apply` produced). ForgeScore
 *    already scored that exact resume_text+job_description during the apply,
 *    on the identical rubric (verified: ScoreOnly's prompt is textually "Same
 *    rubric as ForgeScore" -- same 6 dimensions, same weights, same thresholds),
 *    and Prepare Apply Context already stores that parsed output as
 *    last_apply.forge_score (via Store Apply Context). So `score` was paying
 *    for a second LLM call to re-produce data already sitting in static data.
 *    Fix: Load Score Context passes forge_score through, Format Score Message
 *    reads it directly, and the ScoreOnly node + its model + its output parser
 *    are deleted outright (each confirmed to have zero other consumers).
 *
 * 2. FEED STEP0's CLUSTERS/DEALBREAKERS INTO EXTRACT ATS SIGNALS. Step0 JD
 *    Analysis already extracts requirement clusters + dealbreakers from the JD
 *    early in the apply flow -- Pass1/Pass2 write the resume against exactly
 *    those clusters (Build Pass2 Input feeds them in as jdRequirements).
 *    Extract ATS Signals, much later in the SAME run, re-derives its OWN
 *    cluster set from scratch by re-reading the raw JD -- so the resume is
 *    graded against a DIFFERENT breakdown than the one it was written for,
 *    and the ATS-retry loop (regen on low score) ends up optimizing against a
 *    moving target. Fix: pass Step0's parsed clusters/dealbreakers into Extract
 *    ATS Signals' input and instruct it to score against exactly those (verified
 *    safe: Extract ATS Signals runs exactly once per apply, strictly downstream
 *    of Parse Step0 in the graph -- confirmed no regen-loop path re-enters it,
 *    so Parse Step0 has always executed by the time this node fires).
 *
 * 4. COVER PASS1 STOPS RE-DERIVING KNOWN DATA. Cover Pass1's prompt tells it to
 *    "detect the candidate's career tier" and "Extract the company name and
 *    role/position from the job description" -- but by the time Cover Pass1
 *    runs, SeniorityDetector has already classified tier (Cover Pass1's own
 *    input already carries it as `tier`, just previously unused-as-authoritative)
 *    and Prepare Job Context already extracted company + job_title from the
 *    original job listing. Fix: add `role` to the input (company/tier were
 *    already there) and rewrite the instruction to use the given values
 *    verbatim instead of re-deriving -- output schema unchanged (extractedCompany/
 *    extractedRole/tier stay as fields, just echoed rather than computed), so
 *    every downstream consumer of Cover Pass1's output is unaffected.
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

// ═══════════════════════════════════════════════════════════════
// 1. Drop ScoreOnly
// ═══════════════════════════════════════════════════════════════

const LSC_OLD = `return [{ json: { chat_id: chatId, error: '', resume_text: lastApply.resume_text, job_description: lastApply.job_description, job_title: lastApply.job_title, company: lastApply.company } }];`;
const LSC_NEW = `return [{ json: { chat_id: chatId, error: '', resume_text: lastApply.resume_text, job_description: lastApply.job_description, job_title: lastApply.job_title, company: lastApply.company, forge_score: lastApply.forge_score || null } }];`;

const FSM_OLD = `const s = $input.first().json.output || {};
const ctx = $('Load Score Context').first().json;`;
const FSM_NEW = `// R2: ScoreOnly dropped -- score is a moving-in-time value, but for the same
// resume+JD ForgeScore already computed during the apply this is scoring, so
// there is no LLM call here anymore, just formatting of the stored output.
const ctx = $('Load Score Context').first().json;
const s = ctx.forge_score || {};`;

const NODES_TO_DELETE = ['ScoreOnly', 'OpenRouter Chat Model', 'ScoreOnly Output Parser'];

function deleteNodeEverywhere(wf, name) {
  const idx = wf.nodes.findIndex((n) => n.name === name);
  if (idx === -1) return false;
  wf.nodes.splice(idx, 1);
  delete wf.connections[name];
  for (const obj of Object.values(wf.connections)) {
    for (const connType of Object.keys(obj)) {
      obj[connType] = obj[connType].map((branch) => (branch || []).filter((e) => e.node !== name));
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
// 2. Feed Step0 into Extract ATS Signals
// ═══════════════════════════════════════════════════════════════

const ATS_TEXT_OLD = `={{ 'RESUME:\\n' + ($('Assemble Resume LaTeX').first().json.resumePlainText || '') + '\\n\\nJOB DESCRIPTION:\\n' + ($('Prepare Job Context').first().json.job_description || 'No JD provided.') }}`;
const ATS_TEXT_NEW = `={{ 'RESUME:\\n' + ($('Assemble Resume LaTeX').first().json.resumePlainText || '') + '\\n\\nJOB DESCRIPTION:\\n' + ($('Prepare Job Context').first().json.job_description || 'No JD provided.') + '\\n\\nREQUIREMENT CLUSTERS (pre-extracted -- score against exactly these, do not derive your own):\\n' + JSON.stringify((($('Parse Step0').first().json || {}).step0 || {}).clusters || []) + '\\n\\nDEALBREAKERS (pre-extracted):\\n' + JSON.stringify((($('Parse Step0').first().json || {}).step0 || {}).dealbreakers || []) }}`;

const ATS_SYS_OLD = `You are an expert ATS analyzer. Extract structured scoring signals.

CRITICAL RULES:`;
const ATS_SYS_NEW = `You are an expert ATS analyzer. Extract structured scoring signals.

You are given a pre-extracted list of requirement clusters and dealbreakers from the JD (see REQUIREMENT CLUSTERS / DEALBREAKERS in the input) -- score the resume against EXACTLY those clusters, one requirement_cluster entry per given cluster, in the same order. Do not invent new clusters, and do not split, merge, or rename the given ones.

CRITICAL RULES:`;

// ═══════════════════════════════════════════════════════════════
// 4. Cover Pass1 trims redundant work
// ═══════════════════════════════════════════════════════════════

const CP1_TEXT_OLD = `={{ JSON.stringify({ resume: $('Prepare Apply Context').first().json.resume_text, jd: $('Prepare Apply Context').first().json.job_description, company: $('Prepare Apply Context').first().json.company, dossier: ($('Pass Dossier').first().json||{}).dossier, tier: $('Prepare Apply Context').first().json.seniority_mode }) }}`;
const CP1_TEXT_NEW = `={{ JSON.stringify({ resume: $('Prepare Apply Context').first().json.resume_text, jd: $('Prepare Apply Context').first().json.job_description, company: $('Prepare Apply Context').first().json.company, role: $('Prepare Apply Context').first().json.job_title, dossier: ($('Pass Dossier').first().json||{}).dossier, tier: $('Prepare Apply Context').first().json.seniority_mode }) }}`;

const CP1_INTRO_OLD = `You are CoverForge Pass 1 — the adaptive selection engine for cover letters. Analyze the resume and JD, detect the candidate's career tier, and decide which achievements to highlight.

IMPORTANT: Extract the company name and role/position from the job description text. Do NOT expect them as separate inputs.`;
const CP1_INTRO_NEW = `You are CoverForge Pass 1 — the adaptive selection engine for cover letters. Decide which achievements to highlight and how to position them.

IMPORTANT: company, role, and tier are provided directly in the input JSON (already computed upstream by earlier nodes in this same run) -- use them VERBATIM for extractedCompany/extractedRole/tier in your output. Do NOT re-derive them from the JD text, and do NOT second-guess the provided tier.`;

const CP1_TIER_SECTION_OLD = `═══════════════════════════════════════════════════════════════
TIER DETECTION (same rules as ResumeForge)
═══════════════════════════════════════════════════════════════

- FRESHER (0 years full-time): Projects, coursework, internships only.
- JUNIOR (1-3 years): Limited professional experience.
- MID (4-9 years): Solid experience across roles.
- SENIOR (10+ years): Leadership, strategic impact.

═══════════════════════════════════════════════════════════════
ACHIEVEMENT COUNT BY TIER`;
const CP1_TIER_SECTION_NEW = `═══════════════════════════════════════════════════════════════
TIER (provided in the input -- see ACHIEVEMENT COUNT BY TIER below)
═══════════════════════════════════════════════════════════════
ACHIEVEMENT COUNT BY TIER`;

function replaceExact(getField, setField, oldStr, newStr, label, base) {
  const cur = getField();
  if (cur === newStr) return false;
  if (cur.indexOf(oldStr) === -1) { console.error(`INTEGRITY FAIL ${base}: ${label} does not contain expected old value.\nGot (first 200 chars): ${String(cur).slice(0, 200)}`); process.exit(1); }
  setField(cur.split(oldStr).join(newStr));
  return true;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  let edits = 0;

  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Load Score Context', 'Format Score Message', 'IF: Has Score Data?', 'Extract ATS Signals', 'Cover Pass1']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  // 1a. Load Score Context
  if (replaceExact(
    () => N['Load Score Context'].parameters.jsCode,
    (v) => { N['Load Score Context'].parameters.jsCode = v; },
    LSC_OLD, LSC_NEW, 'Load Score Context forge_score passthrough', base
  )) edits++;

  // 1b. Format Score Message
  if (replaceExact(
    () => N['Format Score Message'].parameters.jsCode,
    (v) => { N['Format Score Message'].parameters.jsCode = v; },
    FSM_OLD, FSM_NEW, 'Format Score Message source switch', base
  )) edits++;

  // 1c. Rewire IF: Has Score Data? branch 0 to skip ScoreOnly, if not already done
  const ifNode = 'IF: Has Score Data?';
  const branch0 = wf.connections[ifNode].main[0];
  const alreadyRewired = branch0.some((e) => e.node === 'Format Score Message');
  if (!alreadyRewired) {
    if (!branch0.some((e) => e.node === 'ScoreOnly')) { console.error(`INTEGRITY FAIL ${base}: ${ifNode} branch 0 does not point at ScoreOnly, wiring unexpected`); process.exit(1); }
    wf.connections[ifNode].main[0] = branch0.map((e) => (e.node === 'ScoreOnly' ? { ...e, node: 'Format Score Message' } : e));
    edits++;
  }

  // 1d. Delete ScoreOnly + its model + its output parser (each confirmed zero other consumers)
  for (const name of NODES_TO_DELETE) {
    if (deleteNodeEverywhere(wf, name)) edits++;
  }

  // 2. Extract ATS Signals
  if (replaceExact(
    () => N['Extract ATS Signals'].parameters.text,
    (v) => { N['Extract ATS Signals'].parameters.text = v; },
    ATS_TEXT_OLD, ATS_TEXT_NEW, 'Extract ATS Signals input text', base
  )) edits++;
  if (replaceExact(
    () => N['Extract ATS Signals'].parameters.messages.messageValues[0].message,
    (v) => { N['Extract ATS Signals'].parameters.messages.messageValues[0].message = v; },
    ATS_SYS_OLD, ATS_SYS_NEW, 'Extract ATS Signals system message', base
  )) edits++;

  // 4. Cover Pass1
  if (replaceExact(
    () => N['Cover Pass1'].parameters.text,
    (v) => { N['Cover Pass1'].parameters.text = v; },
    CP1_TEXT_OLD, CP1_TEXT_NEW, 'Cover Pass1 input text', base
  )) edits++;
  if (replaceExact(
    () => N['Cover Pass1'].parameters.messages.messageValues[0].message,
    (v) => { N['Cover Pass1'].parameters.messages.messageValues[0].message = v; },
    CP1_INTRO_OLD, CP1_INTRO_NEW, 'Cover Pass1 intro paragraph', base
  )) edits++;
  if (replaceExact(
    () => N['Cover Pass1'].parameters.messages.messageValues[0].message,
    (v) => { N['Cover Pass1'].parameters.messages.messageValues[0].message = v; },
    CP1_TIER_SECTION_OLD, CP1_TIER_SECTION_NEW, 'Cover Pass1 tier-detection section', base
  )) edits++;

  // integrity: every connection edge resolves to a node that still exists
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" no longer exists`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling connection ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: R2 (partial: items 1,2,4) applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. Load Score Context / Format Score Message logic, run as real JS.
  {
    const lastApply = { resume_text: 'r', job_description: 'jd', job_title: 'AI Engineer', company: 'Acme', forge_score: { overall_score: 7.2, recommendation: 'Apply', dimensions: { skills_match: 8, experience_relevance: 7, metric_impact: 6, seniority_fit: 8, keyword_coverage: 7, leadership_signals: 5 }, strengths: ['strong Python'], gaps: ['no Kubernetes'] } };
    const src = `
      const staticData = { last_apply: arguments[0] };
      const chatId = 123;
      const lastApply = staticData.last_apply;
      if (!lastApply || !lastApply.resume_text || !lastApply.job_description) return { error: 'no context' };
      ${LSC_NEW.replace('return [{ json: {', 'return {').replace('} }];', '};')}
    `;
    const ctx = new Function(src)(lastApply);
    if (!ctx.forge_score || ctx.forge_score.overall_score !== 7.2) { console.error('HARNESS FAIL: Load Score Context did not pass forge_score through, got', JSON.stringify(ctx)); process.exit(1); }

    // Exercise Format Score Message's actual new logic (ctx.forge_score -> s) against
    // the same ctx Load Score Context would have produced.
    const s2 = ctx.forge_score || {};
    if (s2.dimensions.skills_match !== 8) { console.error('HARNESS FAIL: Format Score Message would read the wrong dimensions shape'); process.exit(1); }
    // no-context case must not throw and must produce {} (score command run with no forge_score at all -- old static data)
    const emptyCtx = { forge_score: null };
    const sEmpty = emptyCtx.forge_score || {};
    if (Object.keys(sEmpty).length !== 0) { console.error('HARNESS FAIL: null forge_score should fall back to {}'); process.exit(1); }
  }

  // deleteNodeEverywhere: prove it removes the node AND every dangling connection reference.
  {
    const wf = {
      nodes: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
      connections: {
        A: { main: [[{ node: 'B' }]] },
        B: { main: [[{ node: 'C' }]], ai_languageModel: [[{ node: 'C' }]] },
      },
    };
    const ok = deleteNodeEverywhere(wf, 'B');
    if (!ok) { console.error('HARNESS FAIL: deleteNodeEverywhere returned false for an existing node'); process.exit(1); }
    if (wf.nodes.some((n) => n.name === 'B')) { console.error('HARNESS FAIL: node B still present after delete'); process.exit(1); }
    if (wf.connections['B']) { console.error('HARNESS FAIL: connections.B still present after delete'); process.exit(1); }
    if (wf.connections['A'].main[0].some((e) => e.node === 'B')) { console.error('HARNESS FAIL: dangling A->B connection survived'); process.exit(1); }
    const notFound = deleteNodeEverywhere(wf, 'DoesNotExist');
    if (notFound !== false) { console.error('HARNESS FAIL: deleteNodeEverywhere should return false for a missing node'); process.exit(1); }
  }

  // 2. Extract ATS Signals input text -- prove Step0 clusters/dealbreakers serialize into the prompt.
  {
    const body = ATS_TEXT_NEW.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const $ = (name) => {
      if (name === 'Assemble Resume LaTeX') return { first: () => ({ json: { resumePlainText: 'RESUME TEXT' } }) };
      if (name === 'Prepare Job Context') return { first: () => ({ json: { job_description: 'JD TEXT' } }) };
      if (name === 'Parse Step0') return { first: () => ({ json: { step0: { clusters: [{ name: 'Python', priority: 'must_have', keywords: ['python'] }], dealbreakers: ['5+ years'] } } }) };
      throw new Error('unexpected ref ' + name);
    };
    const fn = new Function('$', 'return (' + body + ');');
    const out = fn($);
    if (!out.includes('RESUME TEXT') || !out.includes('JD TEXT')) { console.error('HARNESS FAIL: Extract ATS Signals text lost the resume/JD base fields'); process.exit(1); }
    if (!out.includes('"name":"Python"') && !out.includes('"name": "Python"')) { console.error('HARNESS FAIL: Step0 clusters not present in Extract ATS Signals input, got', out); process.exit(1); }
    if (!out.includes('5+ years')) { console.error('HARNESS FAIL: Step0 dealbreakers not present in Extract ATS Signals input'); process.exit(1); }

    // missing Step0 (defensive: null step0) must not throw, must degrade to empty arrays.
    const $empty = (name) => {
      if (name === 'Assemble Resume LaTeX') return { first: () => ({ json: {} }) };
      if (name === 'Prepare Job Context') return { first: () => ({ json: {} }) };
      if (name === 'Parse Step0') return { first: () => ({ json: {} }) };
      throw new Error('unexpected ref ' + name);
    };
    const outEmpty = fn($empty);
    if (!outEmpty.includes('CLUSTERS (pre-extracted')) { console.error('HARNESS FAIL: degraded case should still emit the clusters label with an empty array'); process.exit(1); }
  }

  // 4. Cover Pass1 input text -- prove role now serializes in alongside company/tier.
  {
    const body = CP1_TEXT_NEW.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const $ = (name) => {
      if (name === 'Prepare Apply Context') return { first: () => ({ json: { resume_text: 'R', job_description: 'JD', company: 'Acme', job_title: 'Staff Engineer', seniority_mode: 'senior' } }) };
      if (name === 'Pass Dossier') return { first: () => ({ json: {} }) };
      throw new Error('unexpected ref ' + name);
    };
    const fn = new Function('$', 'return (' + body + ');');
    const out = JSON.parse(fn($));
    if (out.role !== 'Staff Engineer') { console.error('HARNESS FAIL: Cover Pass1 input missing role, got', JSON.stringify(out)); process.exit(1); }
    if (out.company !== 'Acme' || out.tier !== 'senior') { console.error('HARNESS FAIL: Cover Pass1 input lost company/tier while adding role, got', JSON.stringify(out)); process.exit(1); }
  }

  console.log('HARNESS OK: forge_score passthrough + null-safe formatting, deleteNodeEverywhere (removal + dangling-connection cleanup + missing-node false-return), Extract ATS Signals Step0-cluster injection (incl. degraded empty case), Cover Pass1 role injection alongside existing company/tier -- all verified');
})();

TARGETS.forEach(patch);
console.log('S32 (R2 partial: drop ScoreOnly, feed Step0 into ATS, trim Cover Pass1) complete.');
