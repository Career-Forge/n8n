/**
 * s139_search_stage_seniority.js -- closes the search-stage seniority gap found
 * this session: a real live apply (Point72, "Machine Learning Engineer, GenAI
 * Technology", cache_9376) showed score100=85 ("Good fit") in the digest, but
 * at apply time SeniorityDetector+ForgeScore correctly caught a real,
 * disqualifying gap ("candidate has 4 years, JD requires 10+") and skipped it.
 *
 * Two independent, compounding gaps, both confirmed against live code and real
 * execution data this session (not guessed):
 *
 * 1. score100's `experience` sub-score (Parse Scorer Output, weight 0.20) is
 *    100% LLM judgment with zero code-level backstop -- unlike `workauth`
 *    (s100) and `location` (s98) in that SAME node, which already have a
 *    deterministic floor/cap over the LLM's guess. JobScorer's own input
 *    never includes a numeric "candidate has N years total" field at all.
 *    Meanwhile Experience Filter (upstream) already regex-extracts a JD's
 *    stated years-required (required_yoe_min/max) for every job and this
 *    already flows unchanged into JobScorer's batch (Build Scorer Input) --
 *    confirmed via direct code read -- but Parse Scorer Output's composite
 *    math never reads it. The wiring exists; nothing consumes it.
 *
 * 2. JD-side: job.description_snippet -- the only text Experience Filter's
 *    regex ever sees -- is truncated to 500-600 chars per source lane, well
 *    before most JDs' requirements section. For Point72 specifically,
 *    Postgres's jobs.jd_text column already holds the FULL, untruncated JD
 *    (Upsert Jobs/Parse Jobs in the poller never truncate on write), but
 *    Hybrid Cache Search's SQL caps at left(jd_text,1200) and Cache
 *    Prefilter's JS then cuts that down again to .slice(0,600) -- discarding
 *    text already fetched, for free, before the "10+ years" clause is ever
 *    reached. Same class of self-imposed (not API-imposed) truncation on the
 *    RemoteOK and JSearch web lanes (both genuinely return fuller
 *    descriptions, both artificially capped at 500). Serper/You.com/
 *    Firecrawl-search are genuine short snippet APIs -- left alone, nothing
 *    to gain. Fixing #1 alone would NOT have caught the Point72 case --
 *    required_yoe_min would still resolve null for it today. Both fixes
 *    ship together.
 *
 * Design (5 new nodes, mirroring this codebase's own chainLlm+Model+
 * OutputParser+Parse-code convention -- see SeniorityDetector's own quartet):
 *   Read Resume (parse) --[2nd edge, additive]--> Prep Candidate YOE Input
 *     (Code, mirrors Build Scorer Input's own resume-fallback chain)
 *     --> Compute Candidate YOE (chainLlm, deepseek-v4-flash -- same cheap
 *         tier SeniorityDetector already uses for this exact class of
 *         judgment, run ONCE per search, not once per job)
 *     --> Parse Candidate YOE (Code, unwraps the chainLlm output)
 * Parse Scorer Output (modified) reads $('Parse Candidate YOE')'s output the
 * same way it already reads $('Build Scorer Input') -- a pure cross-reference,
 * no new connection edge needed for that node.
 *
 * Explicitly NOT touched: JobScorer's own prompt (doesn't need to change --
 * the new signal comes from the new node + existing regex extraction, not
 * from JobScorer itself); apply-time SeniorityDetector/ForgeScore/IF:
 * Mismatch? (this pass only affects search-stage score100); no hard exclusion
 * of mismatched jobs from the digest (demotion only, per this codebase's own
 * "unknown/imperfect signal -> demote+badge, never silently hide" law);
 * overqualification (candidate has MORE years than required) gets no penalty.
 *
 * Run: harness (real Point72 numbers: reqMin=10, candidate_yoe=4 -> capped;
 * a met/exceeded case -> unchanged; no-reqMin case -> unchanged; missing
 * candidate_yoe -> no-op) + deploy (master workflow) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const EXPORT_PROMPTS_FILE = path.join(ROOT, 'scripts', 'export_prompts.js');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}

// ──────────────────────── New node definitions ────────────────────────
const PREP_CODE = `function parseMaybe(v) {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch(e) { return v; } }
  return v;
}
const sd = $getWorkflowStaticData('global');
const rows = $input.all().map(i => i.json || {});
let row = rows.find(r => r && (r.id === 'global:resume_structured' || r.value)) || rows[0] || {};
let resume = parseMaybe(row.value || null);
if (resume && resume.resume_doc) resume = resume.resume_doc;
if ((!resume || typeof resume !== 'object' || !resume.personal) && sd.last_resume_structured) resume = sd.last_resume_structured;
if ((!resume || typeof resume !== 'object') && sd.last_resume_json) resume = sd.last_resume_json;
const experience = (resume && Array.isArray(resume.experience)) ? resume.experience.slice(0, 12).map((e) => ({
  title: e.title || '', company: e.company || e.organization || '',
  start_date: e.start_date || null, end_date: e.end_date || null, is_current: !!e.is_current
})) : [];
return [{ json: { experience, valid: experience.length > 0 } }];`;

const CANDIDATE_YOE_PROMPT = `You are computing a candidate's total years of professional experience for job-search scoring purposes -- NOT for resume writing, just a single number used once per search.

You will receive: { "experience": [ {title, company, start_date, end_date, is_current}, ... ], "valid": true|false }

If "valid" is false or "experience" is empty, return candidate_yoe: null.

Otherwise:
- Sum all professional role durations (start_date to end_date, or to today if is_current).
- Count internships (title/company language indicating an internship) at 0.5x weight.
- Teaching Assistant / Research Assistant / Grader roles at a university do NOT count toward professional experience -- exclude them entirely.
- If two roles overlap in time, count the overlapping period only once (do not double-count).
- Round to the nearest integer.

Output ONLY:
{ "candidate_yoe": <integer or null>, "reasoning": "<1 sentence>" }`;

const CANDIDATE_YOE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    candidate_yoe: { type: ['integer', 'number', 'null'] },
    reasoning: { type: 'string' },
  },
  required: ['reasoning'],
});

const PARSE_CANDIDATE_YOE_CODE = `const rawInput = $input.first().json;
let candidateYoe = null;
try {
  const o = (rawInput && rawInput.output) ? rawInput.output : rawInput;
  if (o && typeof o.candidate_yoe === 'number' && isFinite(o.candidate_yoe)) candidateYoe = Math.round(o.candidate_yoe);
} catch (e) {}
return [{ json: { candidate_yoe: candidateYoe } }];`;

function makeNodes() {
  const prepId = 'a1e9f3d0-c139-4a1e-9c1e-139000000001';
  const modelId = 'a1e9f3d0-c139-4a1e-9c1e-139000000002';
  const parserId = 'a1e9f3d0-c139-4a1e-9c1e-139000000003';
  const chainId = 'a1e9f3d0-c139-4a1e-9c1e-139000000004';
  const parseId = 'a1e9f3d0-c139-4a1e-9c1e-139000000005';

  return [
    {
      id: prepId, name: 'Prep Candidate YOE Input', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [33632, 46400],
      parameters: { jsCode: PREP_CODE },
    },
    {
      id: modelId, name: 'Compute Candidate YOE Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1,
      position: [33700, 46600],
      parameters: { model: 'deepseek/deepseek-v4-flash', options: {} },
    },
    {
      id: parserId, name: 'Candidate YOE Output Parser', type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1.2,
      position: [33850, 46600],
      parameters: { schemaType: 'manual', inputSchema: CANDIDATE_YOE_SCHEMA },
    },
    {
      id: chainId, name: 'Compute Candidate YOE', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
      position: [33840, 46400], retryOnFail: true, maxTries: 3, waitBetweenTries: 1000,
      parameters: {
        promptType: 'define',
        text: '={{ JSON.stringify($json) }}',
        hasOutputParser: true,
        messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: CANDIDATE_YOE_PROMPT }] },
      },
    },
    {
      id: parseId, name: 'Parse Candidate YOE', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [34050, 46400],
      parameters: { jsCode: PARSE_CANDIDATE_YOE_CODE },
    },
  ];
}

// ──────────────────────── Part 1: new nodes + connections ────────────────────────
function patchGraph(wf) {
  if (wf.nodes.find((n) => n.name === 'Compute Candidate YOE')) { console.log('  master: new nodes already present'); return false; }

  const newNodes = makeNodes();
  wf.nodes.push(...newNodes);

  const readResumeConns = wf.connections['Read Resume (parse)'];
  if (!readResumeConns || !readResumeConns.main || !readResumeConns.main[0]) {
    console.error('INTEGRITY FAIL: "Read Resume (parse)" main[0] connection array missing'); process.exit(1);
  }
  const alreadyWired = readResumeConns.main[0].some((c) => c.node === 'Prep Candidate YOE Input');
  if (!alreadyWired) readResumeConns.main[0].push({ node: 'Prep Candidate YOE Input', type: 'main', index: 0 });

  wf.connections['Prep Candidate YOE Input'] = { main: [[{ node: 'Compute Candidate YOE', type: 'main', index: 0 }]] };
  wf.connections['Compute Candidate YOE Model'] = { ai_languageModel: [[{ node: 'Compute Candidate YOE', type: 'ai_languageModel', index: 0 }]] };
  wf.connections['Candidate YOE Output Parser'] = { ai_outputParser: [[{ node: 'Compute Candidate YOE', type: 'ai_outputParser', index: 0 }]] };
  wf.connections['Compute Candidate YOE'] = { main: [[{ node: 'Parse Candidate YOE', type: 'main', index: 0 }]] };

  console.log('  master: 5 new nodes + connections added');
  return true;
}

// ──────────────────────── Part 2: truncation fixes ────────────────────────
const HCS_OLD = 'left(j.jd_text,1200) AS jd_text';
const HCS_NEW = 'left(j.jd_text,3000) AS jd_text';

const CP_OLD = 'description_snippet: jd.slice(0,600), rrf_score: r.rrf_score || 0 });';
const CP_NEW = 'description_snippet: jd.slice(0,2500), rrf_score: r.rrf_score || 0 });';

const ROK_OLD = "description_snippet: String(j.description || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().substring(0, 500),";
const ROK_NEW = "description_snippet: String(j.description || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().substring(0, 2000),";

const JS_OLD = "description_snippet: String(r.job_description || '').replace(/\\s+/g, ' ').trim().substring(0, 500),";
const JS_NEW = "description_snippet: String(r.job_description || '').replace(/\\s+/g, ' ').trim().substring(0, 2000),";

function patchTruncation(wf) {
  const hcs = wf.nodes.find((n) => n.name === 'Hybrid Cache Search');
  if (!hcs) { console.error('INTEGRITY FAIL: Hybrid Cache Search missing'); process.exit(1); }
  const cp = wf.nodes.find((n) => n.name === 'Cache Prefilter');
  if (!cp) { console.error('INTEGRITY FAIL: Cache Prefilter missing'); process.exit(1); }
  const rok = wf.nodes.find((n) => n.name === 'Normalize RemoteOK');
  if (!rok) { console.error('INTEGRITY FAIL: Normalize RemoteOK missing'); process.exit(1); }
  const js = wf.nodes.find((n) => n.name === 'Normalize JSearch');
  if (!js) { console.error('INTEGRITY FAIL: Normalize JSearch missing'); process.exit(1); }

  if (hcs.parameters.query.includes('left(j.jd_text,3000)')) { console.log('  master: truncation already patched'); return; }

  replaceOnce(hcs.parameters, 'query', HCS_OLD, HCS_NEW, 'Hybrid Cache Search jd_text cap');
  replaceOnce(cp.parameters, 'jsCode', CP_OLD, CP_NEW, 'Cache Prefilter description_snippet cap');
  replaceOnce(rok.parameters, 'jsCode', ROK_OLD, ROK_NEW, 'Normalize RemoteOK description_snippet cap');
  replaceOnce(js.parameters, 'jsCode', JS_OLD, JS_NEW, 'Normalize JSearch description_snippet cap');
  console.log('  master: truncation caps raised (Hybrid Cache Search + Cache Prefilter + RemoteOK + JSearch)');
}

// ──────────────────────── Part 3: Parse Scorer Output floor/cap ────────────────────────
const PSO_EQ_OLD = `const _eq = (() => { try { return $('Parse Expand Query').first().json || {}; } catch(_) { return {}; } })();`;
const PSO_EQ_NEW = `const _eq = (() => { try { return $('Parse Expand Query').first().json || {}; } catch(_) { return {}; } })();
// s139: candidate's real total years of experience, computed once per search
// (job-independent) by the new "Compute Candidate YOE" node -- see that
// node's own header comment for why it runs once, not once per job.
const _candidateYoe = (() => { try { const v = $('Parse Candidate YOE').first().json.candidate_yoe; return (typeof v === 'number') ? v : null; } catch (_) { return null; } })();`;

const PSO_EXP_OLD = `    experience: _clamp(s.experience_score != null ? s.experience_score : base),`;
const PSO_EXP_NEW = `    // s139: deterministic floor/cap on top of the LLM's own experience_score,
    // same precedent as workauth (s100) and location (s98) just below --
    // never trust the LLM alone on a numeric floor once a hard signal
    // exists. required_yoe_min (Experience Filter's regex extraction) and
    // _candidateYoe (the new per-search node) are both real, already-
    // computed signals; only engage when BOTH are present. Overqualification
    // (gap <= 0) gets no penalty -- this pass only addresses the reported
    // underqualification problem. Thresholds loosely mirror
    // SeniorityDetector's own slightly_under (1-2)/mismatch (>3) bands for
    // conceptual consistency across the two scoring stages, without being
    // bound to reuse the exact same numbers (0-100 score caps vs 0-10
    // qualitative labels are a different unit) -- tune if these don't feel
    // right in practice.
    experience: (() => {
      const llmScore = _clamp(s.experience_score != null ? s.experience_score : base);
      const reqMin = job.required_yoe_min;
      if (reqMin != null && _candidateYoe != null) {
        const gap = reqMin - _candidateYoe;
        if (gap >= 6) return Math.min(llmScore, 25);
        if (gap >= 3) return Math.min(llmScore, 45);
        if (gap >= 1) return Math.min(llmScore, 65);
      }
      return llmScore;
    })(),`;

function patchParseScorerOutput(wf) {
  const pso = wf.nodes.find((n) => n.name === 'Parse Scorer Output');
  if (!pso) { console.error('INTEGRITY FAIL: Parse Scorer Output missing'); process.exit(1); }
  if (pso.parameters.jsCode.includes('_candidateYoe')) { console.log('  master: Parse Scorer Output already patched'); return; }

  replaceOnce(pso.parameters, 'jsCode', PSO_EQ_OLD, PSO_EQ_NEW, 'Parse Scorer Output _eq declaration (insert _candidateYoe after)');
  replaceOnce(pso.parameters, 'jsCode', PSO_EXP_OLD, PSO_EXP_NEW, 'Parse Scorer Output experience sub-score');
  console.log('  master: Parse Scorer Output patched (candidate YOE floor/cap wired in)');
}

// ──────────────────────── Part 4: export_prompts.js registration ────────────────────────
const EP_OLD = `  'SeniorityDetector':     { file: 'SeniorityDetector.md',  extract: getChainLlmMessage },`;
const EP_NEW = `  'SeniorityDetector':     { file: 'SeniorityDetector.md',  extract: getChainLlmMessage },
  'Compute Candidate YOE': { file: 'ComputeCandidateYOE.md', extract: getChainLlmMessage },`;

function patchExportPrompts() {
  let src = fs.readFileSync(EXPORT_PROMPTS_FILE, 'utf8');
  if (src.includes("'Compute Candidate YOE'")) { console.log('  export_prompts.js: already patched'); return; }
  const c = src.split(EP_OLD).length - 1;
  if (c !== 1) { console.error(`INTEGRITY FAIL: anchor "PROMPT_MAP SeniorityDetector line" found ${c} times, expected 1`); process.exit(1); }
  src = src.replace(EP_OLD, () => EP_NEW);
  fs.writeFileSync(EXPORT_PROMPTS_FILE, src);
  console.log('  export_prompts.js: registered Compute Candidate YOE in PROMPT_MAP');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  // 1. The exact floor/cap logic, run for real against realistic fixtures.
  function _clamp(n) { return Math.max(0, Math.min(100, Math.round(Number(n) || 0))); }
  function computeExperienceSub(s, job, candidateYoe, base) {
    const llmScore = _clamp(s.experience_score != null ? s.experience_score : base);
    const reqMin = job.required_yoe_min;
    if (reqMin != null && candidateYoe != null) {
      const gap = reqMin - candidateYoe;
      if (gap >= 6) return Math.min(llmScore, 25);
      if (gap >= 3) return Math.min(llmScore, 45);
      if (gap >= 1) return Math.min(llmScore, 65);
    }
    return llmScore;
  }

  // Real Point72 numbers: reqMin=10 (once the JD-truncation fix lets the
  // regex actually see it), candidate_yoe=4 (real SeniorityDetector output
  // for this exact candidate, captured this session), reconstructed
  // experience_score=75 (illustrative -- the actual raw LLM sub-score for
  // this execution wasn't recoverable, but a mediocre-not-catastrophic
  // number is what the earlier investigation showed plausibly produces an
  // ~81/100 composite).
  check('Point72 case (gap=6, severe) caps hard at 25', computeExperienceSub({ experience_score: 75 }, { required_yoe_min: 10 }, 4, 750) === 25);
  check('gap=3 (moderate) caps at 45', computeExperienceSub({ experience_score: 90 }, { required_yoe_min: 8 }, 5, 900) === 45);
  check('gap=1 (mild) caps at 65', computeExperienceSub({ experience_score: 90 }, { required_yoe_min: 5 }, 4, 900) === 65);
  check('gap=0 (meets exactly) -- no penalty, trusts LLM as-is', computeExperienceSub({ experience_score: 82 }, { required_yoe_min: 5 }, 5, 820) === 82);
  check('candidate EXCEEDS requirement (negative gap) -- no penalty', computeExperienceSub({ experience_score: 88 }, { required_yoe_min: 3 }, 10, 880) === 88);
  check('no required_yoe_min extracted (null) -- unchanged, no fabricated penalty', computeExperienceSub({ experience_score: 75 }, { required_yoe_min: null }, 4, 750) === 75);
  check('no candidate_yoe (LLM/resume failure) -- unchanged, no fabricated penalty', computeExperienceSub({ experience_score: 75 }, { required_yoe_min: 10 }, null, 750) === 75);
  check('missing experience_score falls back to fit_score*10 base, THEN gets floored same as before', computeExperienceSub({}, { required_yoe_min: 10 }, 4, 750) === 25);

  // 2. Parse Candidate YOE's unwrap logic, both raw shapes chainLlm can produce.
  function parseCandidateYoe(rawInput) {
    let candidateYoe = null;
    try {
      const o = (rawInput && rawInput.output) ? rawInput.output : rawInput;
      if (o && typeof o.candidate_yoe === 'number' && isFinite(o.candidate_yoe)) candidateYoe = Math.round(o.candidate_yoe);
    } catch (e) {}
    return candidateYoe;
  }
  check('unwraps the .output-wrapped shape', parseCandidateYoe({ output: { candidate_yoe: 4.0, reasoning: 'x' } }) === 4);
  check('unwraps the bare shape (no .output wrapper)', parseCandidateYoe({ candidate_yoe: 7, reasoning: 'x' }) === 7);
  check('a real null candidate_yoe (invalid resume) stays null, not 0', parseCandidateYoe({ output: { candidate_yoe: null, reasoning: 'no resume' } }) === null);
  check('malformed input never throws, resolves null', parseCandidateYoe({}) === null);

  // 3. Prep Candidate YOE Input's fallback chain -- fixture the resume-missing case.
  function prepValid(resumeVal) { return !!(resumeVal && Array.isArray(resumeVal.experience) && resumeVal.experience.length > 0); }
  check('valid resume -> valid=true', prepValid({ experience: [{ title: 'x' }] }) === true);
  check('missing resume -> valid=false', prepValid(null) === false);
  check('resume with empty experience -> valid=false', prepValid({ experience: [] }) === false);

  // 4. Anchor integrity, checked for real before any write.
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const hcs = wf.nodes.find((n) => n.name === 'Hybrid Cache Search');
  check('Hybrid Cache Search anchor present exactly once', hcs.parameters.query.split(HCS_OLD).length - 1 === 1);
  const cp = wf.nodes.find((n) => n.name === 'Cache Prefilter');
  check('Cache Prefilter anchor present exactly once', cp.parameters.jsCode.split(CP_OLD).length - 1 === 1);
  const rok = wf.nodes.find((n) => n.name === 'Normalize RemoteOK');
  check('Normalize RemoteOK anchor present exactly once', rok.parameters.jsCode.split(ROK_OLD).length - 1 === 1);
  const jsn = wf.nodes.find((n) => n.name === 'Normalize JSearch');
  check('Normalize JSearch anchor present exactly once', jsn.parameters.jsCode.split(JS_OLD).length - 1 === 1);
  const pso = wf.nodes.find((n) => n.name === 'Parse Scorer Output');
  check('Parse Scorer Output _eq anchor present exactly once', pso.parameters.jsCode.split(PSO_EQ_OLD).length - 1 === 1);
  check('Parse Scorer Output experience anchor present exactly once', pso.parameters.jsCode.split(PSO_EXP_OLD).length - 1 === 1);
  check('Read Resume (parse) connection array present', !!(wf.connections['Read Resume (parse)'] && wf.connections['Read Resume (parse)'].main));
  check('new node name not already taken', !wf.nodes.find((n) => n.name === 'Compute Candidate YOE'));

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: floor/cap logic reproduces the real Point72 gap (severe cap 25) and all edge cases (met/exceeded/missing-signal -> unchanged); Parse Candidate YOE unwrap handles both chainLlm output shapes; all anchors verified unique before write.');

  const wf2 = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const graphChanged = patchGraph(wf2);
  patchTruncation(wf2);
  patchParseScorerOutput(wf2);
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf2, null, 2));
  patchExportPrompts();
  console.log('S139 (search-stage seniority scoring) complete.' + (graphChanged ? '' : ' (graph was already present)'));
})();
