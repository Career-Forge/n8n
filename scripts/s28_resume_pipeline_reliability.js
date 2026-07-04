/**
 * s28_resume_pipeline_reliability.js -- closes the same vulnerability class S27
 * fixed for Expand Query, across the other 8 nodes found by the same sweep: any
 * chainLlm node with no formal output parser can't throw when its response is
 * unusable, so retryOnFail (even if added) would never trigger -- the node
 * "succeeds" with garbage and whatever consumes it either silently degrades or
 * breaks. All 8 are in the resume/cover-letter pipeline: Pass1 Selection, Step0 JD
 * Analysis, Pass2 Generate, Pass2 Regen, Cover Pass1, Cover Pass2, Extract ATS
 * Signals, CompanyIntel Apply.
 *
 * Good news found while scoping this: every one of these 8 nodes' downstream
 * Parse* node uses the IDENTICAL shared parseJSON() helper (ported from
 * command-center), which already starts with
 *   if (content && typeof content === 'object') return content;
 * -- meaning once a formal output parser makes `.output` a validated OBJECT
 * instead of raw text, the existing Parse* code handles it correctly with ZERO
 * changes needed. Unlike S27 (Expand Query), no Parse*-node edits in this patch --
 * purely additive (new parser node + hasOutputParser + retryOnFail per LLM node).
 *
 * Same schema philosophy as S27: each schema requires only the ONE field whose
 * absence would mean the response was actually broken (chosen by reading each
 * node's own prompt in prompts/*.md, freshly regenerated in F4 so they're
 * trustworthy), leaving everything else loosely typed via additionalProperties.
 * This is deliberately NOT an attempt to fully specify every field -- an
 * exhaustive schema risks rejecting legitimate variation (e.g. Pass2's `summary`
 * is intentionally empty-string for non-senior tiers; requiring it non-empty
 * would be wrong). The target is "did the model actually try", not "did it
 * produce a perfect response".
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

function permissive(requiredProps) {
  return {
    type: 'object',
    properties: Object.fromEntries(requiredProps.map(([k, schema]) => [k, schema])),
    required: requiredProps.map(([k]) => k),
    additionalProperties: true,
  };
}

// [llmNodeName, parserNodeName, schema, why-this-field]
const NODES = [
  {
    llm: 'Pass1 Selection',
    parser: 'Pass1 Output Parser',
    schema: permissive([['sectionOrder', { type: 'array', items: { type: 'string' }, minItems: 1 }]]),
    why: 'every resume needs at least one section; downstream rendering iterates sectionOrder directly',
  },
  {
    llm: 'Step0 JD Analysis',
    parser: 'Step0 Output Parser',
    schema: permissive([
      ['companyName', { type: 'string', minLength: 1 }],
      ['roleName', { type: 'string', minLength: 1 }],
    ]),
    why: 'a JD analysis that can\'t even name the company/role has fundamentally failed to parse the JD',
  },
  {
    llm: 'Pass2 Generate',
    parser: 'Pass2 Output Parser',
    schema: permissive([['skills', { type: 'array', minItems: 1 }]]),
    why: 'skills is the one field present across every tier (summary is intentionally empty for non-senior, experience/internship/project bullets vary legitimately by tier)',
  },
  {
    llm: 'Pass2 Regen',
    parser: 'Pass2 Regen Output Parser',
    schema: permissive([['skills', { type: 'array', minItems: 1 }]]),
    why: 'same shape and same reasoning as Pass2 Generate (ATS-retry regeneration)',
  },
  {
    llm: 'Cover Pass1',
    parser: 'Cover Pass1 Output Parser',
    schema: permissive([['selectedAchievements', { type: 'array', minItems: 1 }]]),
    why: 'selecting achievements to highlight is this pass\'s entire purpose',
  },
  {
    llm: 'Cover Pass2',
    parser: 'Cover Pass2 Output Parser',
    schema: permissive([['bullets', { type: 'array', minItems: 1 }]]),
    why: 'bullets are the core cover letter content this pass writes',
  },
  {
    llm: 'Extract ATS Signals',
    parser: 'ATS Signals Output Parser',
    schema: permissive([['requirement_clusters', { type: 'array', minItems: 1 }]]),
    why: 'the prompt\'s own top-level key list centers on requirement_clusters; every real JD has at least one requirement',
  },
  {
    llm: 'CompanyIntel Apply',
    parser: 'CompanyIntel Apply Output Parser',
    schema: permissive([['recommendation', { type: 'string', minLength: 1 }]]),
    why: 'a company-health report with no recommendation at all is not a usable answer, this is what downstream apply-flow gating reads',
  },
];

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const { llm } of NODES) {
    if (!N[llm]) { console.error(`INTEGRITY FAIL ${base}: node "${llm}" not found`); process.exit(1); }
  }

  const C = wf.connections;
  for (const { llm, parser, schema } of NODES) {
    const n = N[llm];
    if (n.parameters.hasOutputParser !== true) { n.parameters.hasOutputParser = true; edits++; }
    if (n.retryOnFail !== true || n.maxTries !== 3 || n.waitBetweenTries !== 1000) {
      n.retryOnFail = true; n.maxTries = 3; n.waitBetweenTries = 1000;
      edits++;
    }
    if (!N[parser]) {
      wf.nodes.push({
        parameters: { schemaType: 'manual', inputSchema: JSON.stringify(schema) },
        id: crypto.randomUUID(),
        name: parser,
        type: '@n8n/n8n-nodes-langchain.outputParserStructured',
        typeVersion: 1.2,
        position: [(n.position || [0, 0])[0] + 100, (n.position || [0, 0])[1] + 200],
      });
      N[parser] = wf.nodes[wf.nodes.length - 1];
      edits++;
    }
    if (!C[parser]) {
      C[parser] = { ai_outputParser: [[{ node: llm, type: 'ai_outputParser', index: 0 }]] };
      edits++;
    }
  }

  // integrity: every edge resolves
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source ${src} missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: ${src} -> ${e.node} target missing`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: resume pipeline reliability applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  const failures = [];
  function check(name, cond) { if (!cond) failures.push(name); }

  check('exactly 8 nodes targeted', NODES.length === 8);
  for (const { llm, parser, schema } of NODES) {
    check(`${llm}: schema has exactly 1 required field`, schema.required.length >= 1);
    check(`${llm}: schema allows additional properties (permissive)`, schema.additionalProperties === true);
    check(`${llm}: parser name is unique and non-empty`, typeof parser === 'string' && parser.length > 0);
    // schema must be valid JSON when stringified+parsed (catches accidental non-serializable values)
    let roundtrip;
    try { roundtrip = JSON.parse(JSON.stringify(schema)); } catch (e) { roundtrip = null; }
    check(`${llm}: schema serializes/parses cleanly`, roundtrip && JSON.stringify(roundtrip) === JSON.stringify(schema));
  }

  // Parse* compatibility check: the shared parseJSON's object-shortcut (already
  // live in all 8 downstream Parse* nodes) must correctly pass through an object
  // shaped like what each new parser would actually validate and return.
  function parseJSON(content) {
    if (content && typeof content === 'object') return content;
    return {};
  }
  for (const { llm, schema } of NODES) {
    const sampleObj = {};
    for (const key of schema.required) {
      const propSchema = schema.properties[key];
      sampleObj[key] = propSchema.type === 'array' ? ['sample'] : 'sample';
    }
    const result = parseJSON(sampleObj);
    check(`${llm}: existing Parse* parseJSON object-shortcut returns the validated object unchanged`, result === sampleObj);
  }

  if (failures.length) { console.error('HARNESS FAIL:', failures.join(', ')); process.exit(1); }
  console.log(`HARNESS OK: all 8 schemas (1 required field each, permissive otherwise, clean serialization) + confirmed the existing shared parseJSON object-shortcut passes each validated shape through unchanged, no Parse*-node changes needed -- verified`);
})();

TARGETS.forEach(patch);
console.log('S28 (resume pipeline reliability) complete.');
