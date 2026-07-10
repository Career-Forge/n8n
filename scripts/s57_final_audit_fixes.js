/**
 * s57_final_audit_fixes.js -- the 9 actionable findings from the final 2 audit
 * lenses (field-overwrite, contract-mismatch; run wf_4d778762-f06, 12/12
 * agents, all adversarially verified). A 10th confirmed finding (Pass2 Regen's
 * prompt still carrying the pre-tier-budget contract) was already independently
 * fixed by s56's drift-checker sync -- not touched here.
 *
 * field-overwrite lens (LLM-guessed data silently overriding deterministic data):
 *
 * 1. Prepare Apply Context: `scoreOutput.overall_score || 5.0` converts a
 *    legitimate ForgeScore of exactly 0 (a hard mismatch) into 5.0, which
 *    passes Score Gate and generates a nonsensical tailored resume instead of
 *    triggering Send Skip. `||` -> `??` (nullish coalescing).
 *
 * 2. Build Telegraph Body: the location HARD DROP filter keys only on
 *    JobScorer's LLM-guessed location_match, ignoring Aggregate
 *    Jobs/Verify Job Links' deterministic, ATS-API-verified location_verified
 *    -- a job the pipeline already confirmed via a live ATS call can be
 *    silently dropped from the digest because a 500-char snippet mentions a
 *    different city. Added `&& j.location_verified !== true` to the drop
 *    condition so a verified match survives an LLM misread.
 *
 * 3. Build Telegraph Body: displayLocation() also preferred the LLM's
 *    detected_location over the ATS-verified job.location. Restructured to
 *    prefer job.location whenever location_verified === true, falling back to
 *    the old detected_location-first order for everything else (unverified
 *    jobs still benefit from the LLM's more specific guess).
 *
 * 4. Build Telegraph Body + Assemble Digest: the Telegraph appendix restarts
 *    its own "N." numbering at 1 on the same page as the ranked list, whose
 *    numbers are the ONLY ones sd.last_jobs binds to reply-by-number. A user
 *    replying with an appendix number silently applies to a different job.
 *    Appendix numbering now continues from rankedJobs.length + 1 so the two
 *    sequences never collide.
 *
 * contract-mismatch lens (prompt promises vs parser schema vs downstream reads):
 *
 * 5. Build Revised LaTeX + Update Last Apply: ReviseForge's schema (prompt AND
 *    parser) never carries _budget through, so the tier soft-cap silently
 *    reverts to the old flat 4 on every revise -- concretely dropping the 5th
 *    bullet of an untouched junior-tier entry -- and Update Last Apply then
 *    persists the _budget-less object back into last_apply.resume_json, so the
 *    loss is permanent across all chained revises. Both nodes now backfill
 *    _budget from the prior persisted state (ctx.last_apply.resume_json) when
 *    the model's own output omits it, closing the round-trip for good instead
 *    of just protecting the first revise.
 *
 * 6. Parse Step0: Extract ATS Signals is hard-required (minItems:1) to score
 *    against clusters Step0 legally can return empty (garbled/terse JD) --
 *    Extract ATS Signals is separately told never to invent clusters, so the
 *    contract is unsatisfiable and retryOnFail burns 2 extra paid LLM calls
 *    guaranteed to fail identically before falling through to a rock-bottom
 *    penalty score. Parse Step0 now backfills a single synthetic "General
 *    Requirements" cluster when the model returns none.
 *
 * 7. ContactFinder Output Parser: the prompt promises a top_priority array
 *    (used by Format Contacts for the star/"Top pick" line) but the parser
 *    schema never declares it, so the model's schema-derived format
 *    instructions never mention it -- it's silently dropped. Added to the
 *    schema (optional, not required).
 *
 * 8. Step0 JD Analysis: companyName/roleName are minLength:1 required with no
 *    "if not stated" escape valve, unlike its sibling JD Paste Extract (which
 *    has one) -- a company-less scraped JD forces the model to either
 *    fabricate an identity (which s48's backfill then trusts for the PDF
 *    filename/caption/track record) or fail validation retries. Ported JD
 *    Paste Extract's fallback + anti-invention language.
 *
 * 9. Pass1 Selection: the prompt promises hasProgression/renderAsStacked
 *    ("saves space", renders as one stacked company header) but no downstream
 *    node -- not Parse Pass1, not any of the 3 assemblers -- ever reads
 *    either field; the stacked render mode doesn't exist, so selection is
 *    biased by a false premise. Stripped both schema fields and the false
 *    render claims from the MULTI-ROLE block, keeping the one instruction
 *    that's actually load-bearing (count full company tenure for the
 *    isLongestTenure mandatory-entry rule the allocator uses).
 *
 * No node count change.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Prepare Apply Context: nullish-coalesce the ForgeScore score ═══
const PAC_OLD = "overall_score: scoreOutput.overall_score || 5.0,";
const PAC_NEW = "overall_score: scoreOutput.overall_score ?? 5.0,";

// ═══ 5a. Build Revised LaTeX: backfill _budget from the prior persisted state ═══
const BRL_OLD =
  "const ctx = $('Load Revise Context').first().json || {};\n" +
  "const revised = $input.first().json.output || {};\n" +
  "const personal = (ctx.last_apply && ctx.last_apply.personal) || {};";
const BRL_NEW =
  "const ctx = $('Load Revise Context').first().json || {};\n" +
  "const revised = $input.first().json.output || {};\n" +
  "// s57: ReviseForge's schema doesn't carry _budget through -- backfill it from\n" +
  "// the prior persisted state so the tier soft cap survives revise round-trips.\n" +
  "const _priorBudget = (ctx.last_apply && ctx.last_apply.resume_json && ctx.last_apply.resume_json._budget) || null;\n" +
  "if (_priorBudget && !revised._budget) revised._budget = _priorBudget;\n" +
  "const personal = (ctx.last_apply && ctx.last_apply.personal) || {};";

// ═══ 5b. Update Last Apply: mirror the backfill so it PERSISTS across chained revises ═══
const ULA_OLD =
  "const staticData = $getWorkflowStaticData('global');\n" +
  "const ctx = $('Load Revise Context').first().json;\n" +
  "const revised = $('ReviseForge').first().json.output || {};\n" +
  "// s54: the old revise_type branch was dead -- no node ever wrote that field\n" +
  "// (Build Revised LaTeX's own comment says so). Revise handles resumes only.\n" +
  "staticData.last_apply = staticData.last_apply || {};";
const ULA_NEW =
  "const staticData = $getWorkflowStaticData('global');\n" +
  "const ctx = $('Load Revise Context').first().json;\n" +
  "const revised = $('ReviseForge').first().json.output || {};\n" +
  "// s54: the old revise_type branch was dead -- no node ever wrote that field\n" +
  "// (Build Revised LaTeX's own comment says so). Revise handles resumes only.\n" +
  "// s57: mirror Build Revised LaTeX's _budget backfill so the persisted\n" +
  "// last_apply.resume_json keeps carrying it into the NEXT revise cycle --\n" +
  "// otherwise the round-trip loses it again on every chained revise.\n" +
  "const _priorBudget = (ctx.last_apply && ctx.last_apply.resume_json && ctx.last_apply.resume_json._budget) || null;\n" +
  "if (_priorBudget && !revised._budget) revised._budget = _priorBudget;\n" +
  "staticData.last_apply = staticData.last_apply || {};";

// ═══ 2. Build Telegraph Body: location_verified guard on the hard drop ═══
const BTB_DROP_OLD = ".filter(j => !(j.location_match === 'mismatch' && intent.location_canonical && intent.remote_preference !== 'remote_only'))";
const BTB_DROP_NEW = ".filter(j => !(j.location_match === 'mismatch' && j.location_verified !== true && intent.location_canonical && intent.remote_preference !== 'remote_only'))";

// ═══ 3. Build Telegraph Body: displayLocation prefers ATS-verified location ═══
const BTB_DISPLOC_OLD =
  "function displayLocation(job) {\n" +
  "  const dl = (job.detected_location || '').trim();\n" +
  "  let base;\n" +
  "  if (dl && !/^(unknown|n\\/?a|null|undefined)$/i.test(dl)) base = dl;\n" +
  "  else {\n" +
  "    const loc = (job.location || '').trim();\n" +
  "    if (loc && !/^(unknown|n\\/?a|null|undefined)$/i.test(loc)) base = loc;\n" +
  "    else {\n" +
  "      const hay = ((job.title || '') + ' ' + (job.description_snippet || '')).toLowerCase();\n" +
  "      base = (intent.remote_preference === 'remote_only' || hay.includes('remote')) ? 'Remote' : 'Location not specified';\n" +
  "    }\n" +
  "  }\n" +
  "  // F2: location filtering was active for this search but this job's location\n" +
  "  // couldn't be verified (Aggregate Jobs' 'unknown' branch) -- badge it rather\n" +
  "  // than blend it in with confirmed matches. 🔎 (not 🌐 -- see header comment).\n" +
  "  return job.location_verified === null ? base + ' 🔎' : base;\n" +
  "}";
const BTB_DISPLOC_NEW =
  "function displayLocation(job) {\n" +
  "  const loc = (job.location || '').trim();\n" +
  "  const locOk = loc && !/^(unknown|n\\/?a|null|undefined)$/i.test(loc);\n" +
  "  const dl = (job.detected_location || '').trim();\n" +
  "  const dlOk = dl && !/^(unknown|n\\/?a|null|undefined)$/i.test(dl);\n" +
  "  let base;\n" +
  "  // s57: an ATS-verified location (Verify Job Links' backfill) beats the\n" +
  "  // LLM's snippet-derived guess -- only fall back to detected_location when\n" +
  "  // this job's location was never deterministically verified.\n" +
  "  if (job.location_verified === true && locOk) base = loc;\n" +
  "  else if (dlOk) base = dl;\n" +
  "  else if (locOk) base = loc;\n" +
  "  else {\n" +
  "    const hay = ((job.title || '') + ' ' + (job.description_snippet || '')).toLowerCase();\n" +
  "    base = (intent.remote_preference === 'remote_only' || hay.includes('remote')) ? 'Remote' : 'Location not specified';\n" +
  "  }\n" +
  "  // F2: location filtering was active for this search but this job's location\n" +
  "  // couldn't be verified (Aggregate Jobs' 'unknown' branch) -- badge it rather\n" +
  "  // than blend it in with confirmed matches. 🔎 (not 🌐 -- see header comment).\n" +
  "  return job.location_verified === null ? base + ' 🔎' : base;\n" +
  "}";

// ═══ 4. Build Telegraph Body: appendix numbering continues past the ranked list ═══
const BTB_APPENDIX_OLD = "children: [(i + 1) + '. ' + (tg ? tg + ' ' : '')";
const BTB_APPENDIX_NEW = "children: [(rankedJobs.length + i + 1) + '. ' + (tg ? tg + ' ' : '')";

// ═══ 6. Parse Step0: backfill a synthetic cluster when the model returns none ═══
const PS0_OLD = "return [{json:{step0:parseJSON(raw)}}];";
const PS0_NEW =
  "const step0=parseJSON(raw);\n" +
  "if (!Array.isArray(step0.clusters) || !step0.clusters.length) { step0.clusters = [{ name: 'General Requirements', priority: 'must_have', keywords: [] }]; }\n" +
  "return [{json:{step0}}];";

// ═══ 7. ContactFinder Output Parser: add top_priority to the schema ═══
const CF_SCHEMA_OLD = '{"type":"object","properties":{"contacts":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"role":{"type":"string"},"type":{"type":"string"},"linkedin_url":{},"location":{},"priority":{"type":"string"},"confidence":{"type":"string"},"reason":{"type":"string"},"sources":{"type":"array","items":{"type":"string"}}},"required":["name","role","priority","confidence","reason"]}},"search_tips":{"type":"array","items":{"type":"string"}}},"required":["contacts"]}';
const CF_SCHEMA_NEW = '{"type":"object","properties":{"contacts":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"role":{"type":"string"},"type":{"type":"string"},"linkedin_url":{},"location":{},"priority":{"type":"string"},"confidence":{"type":"string"},"reason":{"type":"string"},"sources":{"type":"array","items":{"type":"string"}}},"required":["name","role","priority","confidence","reason"]}},"top_priority":{"type":"array","items":{"type":"object","properties":{"name":{"type":"string"},"reason":{"type":"string"}}}},"search_tips":{"type":"array","items":{"type":"string"}}},"required":["contacts"]}';

// ═══ 8. Step0 JD Analysis: fallback + anti-invention clauses (matching JD Paste Extract) ═══
const S0_COMPANY_OLD = "\"companyName\": \"<exact company name as written in JD — e.g. 'Microsoft', 'Google', 'Amazon'>\",";
const S0_COMPANY_NEW = "\"companyName\": \"<exact company name as written in JD — e.g. 'Microsoft', 'Google', 'Amazon'; if not stated anywhere, use 'the company'>\",";
const S0_ROLE_OLD = "\"roleName\": \"<exact role/position title from JD>\",";
const S0_ROLE_NEW = "\"roleName\": \"<exact role/position title from JD; if not stated, use 'this role'>\",";
const S0_TAIL_OLD = "Extract 4-6 requirement clusters max. Be concise and factual.";
const S0_TAIL_NEW = "Extract 4-6 requirement clusters max. Be concise and factual. Do not invent a company or role name that is not actually present in the text.";

// ═══ 9. Pass1 Selection: strip the false hasProgression/renderAsStacked promise ═══
const P1_SCHEMA_OLD =
  "],\n" +
  "      \"hasProgression\": <boolean — true if multiple roles show career growth>,\n" +
  "      \"renderAsStacked\": <boolean — true to render as single company header with sub-roles>";
const P1_SCHEMA_NEW = "]";
const P1_MULTIROLE_OLD =
  "If a candidate held MULTIPLE positions at the SAME company:\n" +
  "- Set \"hasProgression\": true and \"renderAsStacked\": true\n" +
  "- This renders as ONE company header with multiple role sub-entries\n" +
  "- Saves space and demonstrates career growth\n" +
  "- Count the entire company tenure for \"longest tenure\" calculation";
const P1_MULTIROLE_NEW =
  "If a candidate held MULTIPLE positions at the SAME company:\n" +
  "- Count the entire company tenure for \"longest tenure\" calculation";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const need of ['Prepare Apply Context', 'Build Revised LaTeX', 'Update Last Apply', 'Build Telegraph Body', 'Parse Step0', 'ContactFinder Output Parser', 'Step0 JD Analysis', 'Pass1 Selection']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Prepare Apply Context'].parameters.jsCode.includes('overall_score: scoreOutput.overall_score ?? 5.0,')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Prepare Apply Context'].parameters, 'jsCode', PAC_OLD, PAC_NEW, 'ForgeScore nullish coalesce', base);
  replaceOnce(N['Build Revised LaTeX'].parameters, 'jsCode', BRL_OLD, BRL_NEW, 'Build Revised LaTeX _budget backfill', base);
  replaceOnce(N['Update Last Apply'].parameters, 'jsCode', ULA_OLD, ULA_NEW, 'Update Last Apply _budget backfill', base);
  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', BTB_DROP_OLD, BTB_DROP_NEW, 'location_verified drop guard', base);
  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', BTB_DISPLOC_OLD, BTB_DISPLOC_NEW, 'displayLocation precedence', base);
  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', BTB_APPENDIX_OLD, BTB_APPENDIX_NEW, 'appendix numbering continuation', base);
  replaceOnce(N['Parse Step0'].parameters, 'jsCode', PS0_OLD, PS0_NEW, 'Parse Step0 clusters backfill', base);
  replaceOnce(N['ContactFinder Output Parser'].parameters, 'inputSchema', CF_SCHEMA_OLD, CF_SCHEMA_NEW, 'ContactFinder top_priority schema', base);
  replaceOnce(N['Step0 JD Analysis'].parameters.messages.messageValues[0], 'message', S0_COMPANY_OLD, S0_COMPANY_NEW, 'Step0 companyName fallback', base);
  replaceOnce(N['Step0 JD Analysis'].parameters.messages.messageValues[0], 'message', S0_ROLE_OLD, S0_ROLE_NEW, 'Step0 roleName fallback', base);
  replaceOnce(N['Step0 JD Analysis'].parameters.messages.messageValues[0], 'message', S0_TAIL_OLD, S0_TAIL_NEW, 'Step0 anti-invention clause', base);
  replaceOnce(N['Pass1 Selection'].parameters.messages.messageValues[0], 'message', P1_SCHEMA_OLD, P1_SCHEMA_NEW, 'Pass1 Selection schema strip', base);
  replaceOnce(N['Pass1 Selection'].parameters.messages.messageValues[0], 'message', P1_MULTIROLE_OLD, P1_MULTIROLE_NEW, 'Pass1 Selection MULTI-ROLE strip', base);

  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: final-audit fixes applied -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. ForgeScore: a legitimate 0 survives; only null/undefined default to 5.0.
  {
    const run = (scoreOutput) => new Function('scoreOutput', 'return {' + PAC_NEW + '};')(scoreOutput);
    const zero = run({ overall_score: 0 });
    if (zero.overall_score !== 0) { console.error('HARNESS FAIL: a real 0 must survive', zero); process.exit(1); }
    const missing = run({});
    if (missing.overall_score !== 5.0) { console.error('HARNESS FAIL: missing score should default to 5.0', missing); process.exit(1); }
  }
  console.log('HARNESS OK: Prepare Apply Context -- overall_score: 0 (hard mismatch) survives, only a truly missing score defaults to 5.0');

  // 5. _budget backfill: prior state fills a model that dropped it; model's own value wins if present; no prior state -> untouched.
  {
    const runBRL = (ctx, revised) => { const fn = new Function('ctx', 'revised', BRL_NEW.split('\n').slice(2).join('\n') + '\nreturn revised;'); return fn(ctx, revised); };
    const ctxWithBudget = { last_apply: { resume_json: { _budget: { tier: 'junior', maxBulletsPerEntry: 5 } } } };
    const backfilled = runBRL(ctxWithBudget, { experience: [] });
    if (!backfilled._budget || backfilled._budget.maxBulletsPerEntry !== 5) { console.error('HARNESS FAIL: _budget should be backfilled from ctx', backfilled); process.exit(1); }
    const modelKept = runBRL(ctxWithBudget, { experience: [], _budget: { tier: 'senior', maxBulletsPerEntry: 4 } });
    if (modelKept._budget.tier !== 'senior') { console.error('HARNESS FAIL: model-provided _budget must win over backfill', modelKept); process.exit(1); }
    const noPrior = runBRL({}, { experience: [] });
    if (noPrior._budget) { console.error('HARNESS FAIL: no prior budget should mean no _budget added', noPrior); process.exit(1); }
    // Chained revise: Update Last Apply's own backfill must ALSO mutate revised in
    // place -- the real node's unchanged tail (staticData.last_apply.resume_json =
    // revised, not part of this anchor) then persists whatever revised carries.
    const runULA = (ctx, revised) => { const fn = new Function('ctx', 'revised', ULA_NEW.split('\n').slice(3, 10).join('\n')); fn(ctx, revised); return revised; };
    const persistedRevised = runULA(ctxWithBudget, { experience: [], changes_summary: 'x' });
    if (!persistedRevised._budget || persistedRevised._budget.maxBulletsPerEntry !== 5) { console.error('HARNESS FAIL: Update Last Apply must backfill _budget onto revised so the unchanged persistence line carries it forward', persistedRevised); process.exit(1); }
  }
  console.log('HARNESS OK: revise _budget round-trip -- prior state backfills a model that drops it, model-provided value still wins, persists into last_apply for chained revises');

  // 2/3. Build Telegraph Body: location_verified guard + displayLocation precedence.
  {
    const runFilter = (jobs, intent) => new Function('scored', 'intent', 'return scored' + BTB_DROP_NEW + ';')(jobs, intent);
    const intent = { location_canonical: 'New York', remote_preference: 'any' };
    const verifiedSurvives = runFilter([{ location_match: 'mismatch', location_verified: true }], intent);
    if (verifiedSurvives.length !== 1) { console.error('HARNESS FAIL: an ATS-verified match must survive an LLM mismatch guess', verifiedSurvives); process.exit(1); }
    const unverifiedDropped = runFilter([{ location_match: 'mismatch', location_verified: null }], intent);
    if (unverifiedDropped.length !== 0) { console.error('HARNESS FAIL: an unverified LLM mismatch should still drop (unchanged behavior)', unverifiedDropped); process.exit(1); }

    const displocFn = new Function('intent', BTB_DISPLOC_NEW + '\nreturn displayLocation;')({ remote_preference: 'any' });
    const verifiedWins = displocFn({ location: 'Bengaluru, India', location_verified: true, detected_location: 'Remote (US)' });
    if (verifiedWins !== 'Bengaluru, India') { console.error('HARNESS FAIL: verified job.location must win over the LLM guess', verifiedWins); process.exit(1); }
    const unverifiedFallsBackToLLM = displocFn({ location: 'HQ address', location_verified: false, detected_location: 'Remote (US)' });
    if (unverifiedFallsBackToLLM !== 'Remote (US)') { console.error('HARNESS FAIL: non-verified jobs should still prefer detected_location (old behavior)', unverifiedFallsBackToLLM); process.exit(1); }
    const unknownBadged = displocFn({ location: 'Somewhere', location_verified: null, detected_location: '' });
    if (unknownBadged !== 'Somewhere 🔎') { console.error('HARNESS FAIL: unknown-verification badge must still apply', unknownBadged); process.exit(1); }
  }
  console.log('HARNESS OK: Build Telegraph Body -- location_verified===true survives the LLM mismatch drop and wins display precedence; unverified jobs keep the old LLM-first display + badge behavior');

  // 4. Appendix numbering continues past the ranked list.
  {
    const rankedJobs = [{}, {}, {}];
    const run = new Function('rankedJobs', 'i', 'tg', 'return ' + BTB_APPENDIX_NEW.replace('children: [', '(').replace(/$/, ')') + ';');
    const first = run(rankedJobs, 0, '');
    if (first !== '4. ') { console.error('HARNESS FAIL: first appendix entry should be numbered 4 (after 3 ranked jobs), got', first); process.exit(1); }
  }
  console.log('HARNESS OK: Telegraph appendix numbering continues from rankedJobs.length + 1, no longer collides with the reply-number keyspace');

  // 6. Parse Step0: empty clusters get a synthetic backfill; non-empty untouched.
  {
    const run = (raw) => new Function('parseJSON', 'raw', PS0_NEW.replace('return [{json:{step0}}];', 'return step0;'))((s) => JSON.parse(s), raw);
    const empty = run(JSON.stringify({ clusters: [], companyName: 'X', roleName: 'Y' }));
    if (!Array.isArray(empty.clusters) || empty.clusters.length !== 1 || empty.clusters[0].name !== 'General Requirements') { console.error('HARNESS FAIL: empty clusters should backfill one synthetic cluster', empty); process.exit(1); }
    const real = run(JSON.stringify({ clusters: [{ name: 'Python' }], companyName: 'X', roleName: 'Y' }));
    if (real.clusters.length !== 1 || real.clusters[0].name !== 'Python') { console.error('HARNESS FAIL: real clusters must be left untouched', real); process.exit(1); }
  }
  console.log('HARNESS OK: Parse Step0 backfills a synthetic cluster only when the model legally returns none, leaving real clusters untouched');

  // 7. ContactFinder schema: valid JSON, top_priority present and optional.
  {
    const schema = JSON.parse(CF_SCHEMA_NEW);
    if (!schema.properties.top_priority) { console.error('HARNESS FAIL: top_priority missing from schema'); process.exit(1); }
    if (schema.required.includes('top_priority')) { console.error('HARNESS FAIL: top_priority must not be required (contacts:[] runs are legal without it)'); process.exit(1); }
    if (!schema.required.includes('contacts')) { console.error('HARNESS FAIL: contacts must remain required'); process.exit(1); }
  }
  console.log('HARNESS OK: ContactFinder Output Parser schema is valid JSON, declares top_priority (optional), keeps contacts required');

  // 9. Pass1 Selection: schema strip leaves valid bracket structure, MULTI-ROLE keeps the tenure instruction.
  {
    if (P1_SCHEMA_NEW.includes('hasProgression') || P1_SCHEMA_NEW.includes('renderAsStacked')) { console.error('HARNESS FAIL: schema strip incomplete'); process.exit(1); }
    if (P1_MULTIROLE_NEW.includes('renderAsStacked') || P1_MULTIROLE_NEW.includes('Saves space')) { console.error('HARNESS FAIL: false render promise still present'); process.exit(1); }
    if (!P1_MULTIROLE_NEW.includes('longest tenure')) { console.error('HARNESS FAIL: real tenure instruction was dropped'); process.exit(1); }
  }
  console.log('HARNESS OK: Pass1 Selection -- hasProgression/renderAsStacked false promise removed, the real longest-tenure instruction kept');
})();

TARGETS.forEach(patch);
console.log('S57 (final audit batch: ForgeScore ??, revise _budget round-trip, location-verified precedence x3, ATS clusters backfill, ContactFinder schema, Step0 fallback, Pass1 false-promise strip) complete.');
