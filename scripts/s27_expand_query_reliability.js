/**
 * s27_expand_query_reliability.js -- fixes a live find_jobs failure: "AI jobs in
 * India" (and presumably other otherwise-clear queries) occasionally return
 * "Couldn't figure out what role you're looking for" even though Expand Query's own
 * system prompt gives "AI jobs" -> ["AI Engineer","ML Engineer",...] as a WORKED
 * EXAMPLE -- this isn't a prompt/schema mismatch, it's a node that can silently
 * "succeed" with unusable output.
 *
 * Root cause, confirmed against real execution data (exec 154, 2026-07-04 22:05
 * UTC): Expand Query has NO formal LangChain output parser attached at all
 * (hasOutputParser unset, no ai_outputParser connection) -- it's pure prompt-
 * instructed JSON with defensive best-effort parsing in Parse Expand Query's code
 * (JSON.parse, then markdown-fence strip, then regex-extract). Because there's no
 * formal parser, the chainLlm node itself never THROWS when the model's response
 * doesn't contain valid role_families -- it "succeeds" with whatever text it got,
 * and Parse Expand Query's fallback strategies all come up empty. This is why S19's
 * retryOnFail sweep (scoped to "nodes with an attached ai_outputParser connection")
 * never caught this node: retryOnFail only retries a THROWN error, and this node
 * was architecturally incapable of throwing one, no matter how bad the model's
 * response was.
 *
 * Fix: add a real (but narrowly-scoped) Structured Output Parser -- only
 * role_families is strictly required (non-empty string array), matching the exact
 * failure symptom; every other field stays loosely typed / optional, matching what
 * Parse Expand Query already tolerates via its own `|| default` fallbacks, so this
 * doesn't create new rejection surface area for fields that were always meant to be
 * flexible. Now that a bad response actually throws, retryOnFail (3 tries, same
 * pattern as every other OpenRouter-routed node in this codebase) gives it a real
 * chance to retry -- a retry is a new request that likely lands on a different
 * OpenRouter backend, per this project's established multi-provider-variance
 * finding. Parse Expand Query is updated to read the now-object-shaped `.output`
 * directly (matching the "Strategy 0" pattern Parse Scorer Output already uses for
 * exactly this transition), falling back to its existing string-parsing strategies
 * for any raw text that slips through unparsed.
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

const SCHEMA = {
  type: 'object',
  properties: {
    role_families: { type: 'array', items: { type: 'string' }, minItems: 1 },
    excluded_roles: { type: 'array', items: { type: 'string' } },
    company_cohort: { type: ['string', 'null'] },
    target_companies: { type: 'array', items: { type: 'string' } },
    firecrawl_queries: { type: 'array', items: { type: 'string' } },
    youcom_queries: { type: 'array', items: { type: 'string' } },
    serper_queries: { type: 'array', items: { type: 'string' } },
    location_canonical: { type: ['string', 'null'] },
    country: { type: 'string' },
    remote_preference: { type: 'string' },
    freshness: { type: 'string' },
    seniority: { type: 'string' },
    max_yoe: { type: ['integer', 'number', 'null'] },
    industry_signals: { type: 'array', items: { type: 'string' } },
    visa_signals: { type: 'array', items: { type: 'string' } },
    salary_signals: { type: 'array', items: { type: 'string' } },
    scoring_priorities: { type: 'array', items: { type: 'string' } },
    verbose: { type: 'boolean' },
    salary_min: { type: ['number', 'null'] },
    equity: { type: 'boolean' },
    sponsorship_required: { type: 'boolean' },
    f1_opt_constraint: { type: 'string' },
    exclude_recent_layoffs: { type: 'boolean' },
    min_funding_stage: { type: ['string', 'null'] },
    culture_constraints: { type: 'array', items: { type: 'string' } },
  },
  required: ['role_families'],
  additionalProperties: true,
};

const PEQ_OLD = `let llmOutput = '';
try {
  const raw = $input.first().json;
  llmOutput = raw.text || raw.output || raw.response || raw.content || JSON.stringify(raw);
} catch(e) { llmOutput = ''; }`;

const PEQ_NEW = `let llmOutput = '';
try {
  const raw = $input.first().json;
  // S27: with a formal output parser now attached, raw.output is already a
  // validated OBJECT (not a string) -- handle that directly, matching the
  // pattern Parse Scorer Output already uses for exactly this case ("Strategy
  // 0"). Falls back to the pre-existing string-based parsing for any raw text
  // that slips through unparsed (e.g. if the parser is ever detached again).
  if (raw.output && typeof raw.output === 'object') {
    llmOutput = JSON.stringify(raw.output);
  } else {
    llmOutput = raw.text || raw.output || raw.response || raw.content || JSON.stringify(raw);
  }
} catch(e) { llmOutput = ''; }`;

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of ['Expand Query', 'Parse Expand Query']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  const eq = N['Expand Query'];
  if (eq.parameters.hasOutputParser !== true) { eq.parameters.hasOutputParser = true; edits++; }
  if (eq.retryOnFail !== true || eq.maxTries !== 3 || eq.waitBetweenTries !== 1000) {
    eq.retryOnFail = true; eq.maxTries = 3; eq.waitBetweenTries = 1000;
    edits++;
  }

  if (!N['Expand Query Output Parser']) {
    wf.nodes.push({
      parameters: { schemaType: 'manual', inputSchema: JSON.stringify(SCHEMA) },
      id: crypto.randomUUID(),
      name: 'Expand Query Output Parser',
      type: '@n8n/n8n-nodes-langchain.outputParserStructured',
      typeVersion: 1.2,
      position: [(eq.position || [0, 0])[0] + 100, (eq.position || [0, 0])[1] + 200],
    });
    edits++;
  }

  const C = wf.connections;
  if (!C['Expand Query Output Parser']) {
    C['Expand Query Output Parser'] = { ai_outputParser: [[{ node: 'Expand Query', type: 'ai_outputParser', index: 0 }]] };
    edits++;
  }

  {
    const n = N['Parse Expand Query'];
    const cur = n.parameters.jsCode;
    if (cur.indexOf(PEQ_NEW) === -1) {
      if (cur.indexOf(PEQ_OLD) === -1) { console.error(`INTEGRITY FAIL ${base}: Parse Expand Query does not contain expected old value`); process.exit(1); }
      n.parameters.jsCode = cur.split(PEQ_OLD).join(PEQ_NEW);
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
  console.log(`OK ${base}: Expand Query reliability fix applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  const failures = [];
  function check(name, cond) { if (!cond) failures.push(name); }

  // 1. Schema itself: role_families required+non-empty, everything else permissive.
  check('schema requires role_families', JSON.stringify(SCHEMA.required) === JSON.stringify(['role_families']));
  check('schema allows additional properties', SCHEMA.additionalProperties === true);
  check('schema role_families has minItems 1 (rejects empty array, the actual failure symptom)', SCHEMA.properties.role_families.minItems === 1);

  // 2. Parse Expand Query: object-shaped .output handled directly; string-shaped
  // (legacy / no-parser) input still works via the fallback path.
  function runParse(rawJson) {
    const $input = { first: () => ({ json: rawJson }) };
    const src = PEQ_NEW + `
      llmOutput = llmOutput.replace(/^\`\`\`json\\s*/i,'').replace(/^\`\`\`\\s*/i,'').replace(/\`\`\`\\s*$/i,'').trim();
      let parsed = null;
      try { parsed = JSON.parse(llmOutput); } catch(e) {}
      return parsed;
    `;
    return new Function('$input', src)($input);
  }
  const objCase = runParse({ output: { role_families: ['AI Engineer', 'ML Engineer'] } });
  check('object-shaped .output (formal parser attached) parses directly', objCase && JSON.stringify(objCase.role_families) === JSON.stringify(['AI Engineer', 'ML Engineer']));
  const stringCase = runParse({ text: '```json\n{"role_families": ["Data Scientist"]}\n```' });
  check('legacy string-shaped .text still parses via existing fallback path', stringCase && JSON.stringify(stringCase.role_families) === JSON.stringify(['Data Scientist']));

  if (failures.length) { console.error('HARNESS FAIL:', failures.join(', ')); process.exit(1); }
  console.log('HARNESS OK: schema (role_families required+non-empty, everything else permissive), Parse Expand Query object-shape handling (both new formal-parser object case and legacy string case) -- all verified');
})();

TARGETS.forEach(patch);
console.log('S27 (Expand Query reliability) complete.');
