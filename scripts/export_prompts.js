/**
 * export_prompts.js -- F4 (Roadmap v4): make prompt/script drift structurally
 * impossible to miss.
 *
 * A duplication audit this session found prompts/*.md and scripts/nodes/*.js
 * had drifted from the live workflow -- some severely (IntentRouter.md
 * described 10 intents, live has 17; ForgeScore_v3.md was a near-total
 * rewrite live never backported). The root cause: these files were meant to
 * be hand-kept-in-sync mirrors, and nobody re-synced them across 20+ later
 * sessions.
 *
 * This script flips the direction: it is READ-ONLY against the live workflow
 * and WRITES OUT to prompts/*.md and scripts/nodes/*.js (plus 2 root-level
 * scripts/_build_*.js mirrors). Running it after any prompt/Code-node-touching
 * deploy, then `git diff prompts/ scripts/nodes/ scripts/_build_*.js`, turns
 * drift-checking into a two-command habit instead of a manual audit. Output is
 * purely a function of the live node content -- no timestamps, no
 * incidental noise -- so a clean diff genuinely means "still in sync."
 *
 * Does NOT touch the workflow JSON. Does NOT need the container-staging
 * deploy dance -- this reads a single already-deployed master copy and writes
 * plain files on the host.
 *
 * Run: node scripts/export_prompts.js   (from repo root, host or container --
 * pure Node + fs, no n8n-specific runtime needed)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

// ── extraction helpers ──
function getChainLlmMessage(n) {
  const mv = n.parameters && n.parameters.messages && n.parameters.messages.messageValues;
  if (!Array.isArray(mv) || mv.length !== 1 || typeof mv[0].message !== 'string') return null;
  return mv[0].message;
}
function getAgentSystemMessage(n) {
  const sm = n.parameters && n.parameters.options && n.parameters.options.systemMessage;
  return typeof sm === 'string' ? sm : null;
}
function getJsCode(n) {
  const c = n.parameters && n.parameters.jsCode;
  return typeof c === 'string' ? c : null;
}

// ── prompts/*.md -- node name -> { file, extract } ──
const PROMPT_MAP = {
  'Extract ATS Signals':   { file: 'ATS_Extraction.md',     extract: getChainLlmMessage },
  'ContactFinder':         { file: 'ContactFinder.md',      extract: getChainLlmMessage },
  'Cover Pass1':           { file: 'Cover_Pass1.md',        extract: getChainLlmMessage },
  'Cover Pass2':           { file: 'Cover_Pass2.md',        extract: getChainLlmMessage },
  'OutreachWriter':        { file: 'OutreachWriter.md',     extract: getChainLlmMessage },
  'Step0 JD Analysis':     { file: 'Step0_JD.md',           extract: getChainLlmMessage },
  'CompanyIntel':          { file: 'CompanyIntel.md',       extract: getChainLlmMessage },
  'ForgeScore':            { file: 'ForgeScore_v3.md',      extract: getChainLlmMessage },
  'Intent Router':         { file: 'IntentRouter.md',       extract: getAgentSystemMessage },
  'JobScorer':             { file: 'JobScorer.md',          extract: getChainLlmMessage },
  'SeniorityDetector':     { file: 'SeniorityDetector.md',  extract: getChainLlmMessage },
  'Compute Candidate YOE': { file: 'ComputeCandidateYOE.md', extract: getChainLlmMessage },
  'Pass1 Selection':       { file: 'Pass1_Resume.md',       extract: getChainLlmMessage },
  'Pass2 Generate':        { file: 'Pass2_Resume.md',       extract: getChainLlmMessage },
  // Previously undocumented live nodes -- adding coverage, not just fixing drift.
  // (ScoreOnly was here until R2 dropped the node -- score now formats ForgeScore's
  // already-stored output instead of a second LLM call; see scripts/s32_r2_llm_consolidation.js.)
  'ReviseForge':           { file: 'ReviseForge.md',        extract: getChainLlmMessage },
  'Expand Query':          { file: 'ExpandQuery.md',        extract: getChainLlmMessage },
  'SalarySummarize':       { file: 'SalarySummarize.md',    extract: getChainLlmMessage },
  // Found missing during a doc-staleness audit -- a real chainLlm node (the
  // jd_paste intent's company/role extractor) with no tracked prompt file at
  // all, so drift on it was structurally invisible to this script.
  'JD Paste Extract':      { file: 'JDPasteExtract.md',     extract: getChainLlmMessage },
};

// scripts/nodes/*.js -- node name -> filename (all plain jsCode extraction)
const SCRIPT_NODE_MAP = {
  'Aggregate Jobs':            'aggregate_jobs.js',
  'Assemble Resume LaTeX':     'assemble_resume_latex.js',
  'Build Enriched Contact':    'build_enriched_contact.js',
  'Build Hook Query':          'build_hook_query.js',
  'Build Telegraph Body':      'build_telegraph_body.js',
  'Build Pass1 Context':       'build_pass1_context.js',
  'Build Pass2 Input':         'build_pass2_input.js',
  'Build Pass2 Regen Input':   'build_pass2_regen_input.js',
  'Calculate ATS Score':       'calculate_ats_score.js',
  'Finalize Enriched Contact': 'finalize_enriched_contact.js',
  'Format Costs':              'format_costs.js',
  'Format Intel Report (Cached)': 'format_intel_report_cached.js',
  'Ingest Resume JSON':        'ingest_resume_json.js',
  'Normalize Apply Research':  'normalize_apply_research.js',
  'Normalize Hooks':           'normalize_hooks.js',
  'Pass Dossier':              'pass_dossier.js',
  'Pick Resume LaTeX':         'pick_resume_latex.js',
  'Prepare Apply Research':    'prepare_apply_research.js',
  'Read Uploaded File':        'read_uploaded_file.js',
  'Save Apply Context':        'save_apply_context.js',
  'Validate ATS Signals':      'validate_ats_signals.js',
};

// root-level scripts/_build_*.js mirrors -- node name -> path relative to scripts/
const ROOT_SCRIPT_MAP = {
  'Build Cover LaTeX':   '_build_cover_latex.js',
  'Build Revised LaTeX': '_build_revised_latex.js',
};

// ── R3-4: shared LaTeX render-helper blocks -- Code nodes can't import a shared
// module, so these are hand-copied across the resume-render nodes. They are
// meant to stay byte-identical; drift here means one node got a rendering
// bugfix the other(s) didn't, and it fails silently (a specific user's resume
// or cover letter breaks) until someone traces it by hand -- exactly what
// happened to buildHeaderFromPersonal's escapeLatexText/V2 call (found via
// this same investigation, fixed in scripts/s35_r3_header_escape_fix.js).
// Anchors extract each named block from a node's jsCode via
// indexOf(start)..indexOf(end).
const LATEX_HELPER_NODES = ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX'];
const LATEX_HELPER_BLOCKS = [
  { block: 'SKELETON',                start: 'const SKELETON = String.raw`',                end: '\\end{document}`;' },
  { block: 'SECTION_LATEX',           start: 'const SECTION_LATEX = {',                      end: '\n};' },
  { block: 'SLOT_MARKER',             start: 'const SLOT_MARKER = {',                        end: '\n};' },
  { block: 'firstNonEmpty',           start: 'function firstNonEmpty(...values) {',           end: '\n}' },
  { block: 'normalizeUrl',            start: 'function normalizeUrl(u) {',                    end: '\n}' },
  { block: 'buildHeaderFromPersonal', start: 'function buildHeaderFromPersonal(p) {',         end: '\n}' },
  { block: 'escapeLatexTextV2',       start: 'function escapeLatexTextV2(value) {',           end: '\n  return s;\n}' },
  { block: 'truncateBullet',          start: 'function truncateBullet(t, reserve) {',         end: '\n}' },
  { block: 'truncateSummary',         start: 'function truncateSummary(t) {',                 end: '\n}' },
  { block: 'bulletRenderV2',          start: 'function bulletRenderV2(bullets, isCompact) {',  end: '\n}' },
  { block: 'renderResume',            start: 'function renderResume(content, personal, isCompact) {', end: '\n}\n' },
];

function extractLatexBlock(code, start, end) {
  const si = code.indexOf(start);
  if (si === -1) return null;
  const ei = code.indexOf(end, si + start.length);
  if (ei === -1) return null;
  return code.slice(si, ei + end.length);
}
function shortHash(s) {
  return require('crypto').createHash('sha256').update(s).digest('hex').slice(0, 12);
}

// Confirmed orphaned/dead-architecture files with zero live node to regenerate
// from -- deleted outright (git preserves history). Evidence: duplication
// audit this session, cross-checked by name against the live 275-node graph.
const DEAD_FILES = [
  // orphaned prompts (target node deleted, superseded by the Pass1/Pass2 split)
  'prompts/CoverForge_v3.md',
  'prompts/CoverRefine.md',
  'prompts/ResumeForge_v3.md',
  'prompts/ResumeRefine.md',
  // ScoreOnly node deleted in R2 (score now formats ForgeScore's stored output instead)
  'prompts/ScoreOnly.md',
  // dead-architecture root scripts (never wired into the live graph as designed)
  'scripts/_build_resume_latex.js',
  'scripts/_rrf_merge.js',
  'scripts/_web_search.js',
  // dead-lineage scripts (target workflows/01_careerforge.json, a 111-node
  // fork untouched since commit 6d6d607, zero overlap with the live graph)
  'scripts/fix_prompts_and_models.js',
  'scripts/session5_transform.js',
  'scripts/session6a_transform.js',
  'scripts/session6b_transform.js',
  'scripts/session6c_transform.js',
  // historical, zero references, contradicts the current single-workflow architecture
  'scripts/DEMO_SCRIPT.md',
];

function mdBanner(nodeName) {
  return `> Auto-generated from the live workflow node \`${nodeName}\` via \`scripts/export_prompts.js\`. Edits here don't get read back in -- see [docs/CUSTOMIZE_PROMPTS.md](docs/CUSTOMIZE_PROMPTS.md) for how to make a permanent change.\n\n`;
}
function jsBanner(nodeName) {
  return `// Auto-generated from the live workflow node "${nodeName}" via scripts/export_prompts.js.\n// Edits here don't get read back in -- the live node is the source of truth.\n\n`;
}

function run() {
  if (!fs.existsSync(MASTER)) { console.error(`FAIL: master workflow not found at ${MASTER}`); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  let written = 0, unchanged = 0, deleted = 0;

  for (const [nodeName, { file, extract }] of Object.entries(PROMPT_MAP)) {
    const n = N[nodeName];
    if (!n) { console.error(`FAIL: prompt node "${nodeName}" not found live (mapping stale?)`); process.exit(1); }
    const content = extract(n);
    if (!content || content.length < 20) { console.error(`FAIL: extracted content for "${nodeName}" is empty/too short -- extraction shape probably wrong`); process.exit(1); }
    const outPath = path.join(ROOT, 'prompts', file);
    const out = mdBanner(nodeName) + content.trimEnd() + '\n';
    const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
    if (prev === out) { unchanged++; continue; }
    fs.writeFileSync(outPath, out);
    console.log(`WROTE prompts/${file}  <- ${nodeName}`);
    written++;
  }

  for (const [nodeName, file] of Object.entries(SCRIPT_NODE_MAP)) {
    const n = N[nodeName];
    if (!n) { console.error(`FAIL: script node "${nodeName}" not found live (mapping stale?)`); process.exit(1); }
    const code = getJsCode(n);
    if (!code || code.length < 10) { console.error(`FAIL: extracted jsCode for "${nodeName}" is empty/too short`); process.exit(1); }
    const outPath = path.join(ROOT, 'scripts', 'nodes', file);
    const out = jsBanner(nodeName) + code.trimEnd() + '\n';
    const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
    if (prev === out) { unchanged++; continue; }
    fs.writeFileSync(outPath, out);
    console.log(`WROTE scripts/nodes/${file}  <- ${nodeName}`);
    written++;
  }

  for (const [nodeName, file] of Object.entries(ROOT_SCRIPT_MAP)) {
    const n = N[nodeName];
    if (!n) { console.error(`FAIL: script node "${nodeName}" not found live (mapping stale?)`); process.exit(1); }
    const code = getJsCode(n);
    if (!code || code.length < 10) { console.error(`FAIL: extracted jsCode for "${nodeName}" is empty/too short`); process.exit(1); }
    const outPath = path.join(ROOT, 'scripts', file);
    const out = jsBanner(nodeName) + code.trimEnd() + '\n';
    const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
    if (prev === out) { unchanged++; continue; }
    fs.writeFileSync(outPath, out);
    console.log(`WROTE scripts/${file}  <- ${nodeName}`);
    written++;
  }

  // sanity: CompanyIntel Apply is supposed to be an identical sibling of CompanyIntel.
  const ci = getChainLlmMessage(N['CompanyIntel'] || {});
  const ciApply = getChainLlmMessage(N['CompanyIntel Apply'] || {});
  if (ci && ciApply && ci !== ciApply) {
    console.warn('WARN: "CompanyIntel" and "CompanyIntel Apply" were previously identical siblings and are no longer -- check if this divergence is intentional.');
  }

  // Assemble Regen is supposed to be a byte-identical clone of Assemble Resume
  // LaTeX (see Pick Resume LaTeX's convergence comment) -- check the WHOLE file,
  // not just the shared blocks below, since it also carries Assemble-only logic
  // (mergeContent, buildFallbackSlots, etc.) that isn't in Build Revised LaTeX at all.
  const arWhole = getJsCode(N['Assemble Resume LaTeX'] || {});
  const agWhole = getJsCode(N['Assemble Regen'] || {});
  if (arWhole && agWhole && arWhole !== agWhole) {
    console.warn('WARN: "Assemble Resume LaTeX" and "Assemble Regen" are supposed to be byte-identical clones and have diverged -- diff them directly, not just the shared-block hashes below.');
  }

  // Shared LaTeX-render-helper blocks -- must be byte-identical across the 3 nodes.
  let latexDrift = false;
  for (const { block, start, end } of LATEX_HELPER_BLOCKS) {
    const extracted = {};
    for (const nodeName of LATEX_HELPER_NODES) {
      const n = N[nodeName];
      if (!n) { console.error(`FAIL: LaTeX-helper node "${nodeName}" not found live (mapping stale?)`); process.exit(1); }
      const code = getJsCode(n);
      const b = code && extractLatexBlock(code, start, end);
      if (!b) { console.error(`FAIL: could not locate block "${block}" in "${nodeName}" -- anchor stale or node rewritten. Fix LATEX_HELPER_BLOCKS before trusting any other output.`); process.exit(1); }
      extracted[nodeName] = b;
    }
    const hashes = Object.fromEntries(Object.entries(extracted).map(([k, v]) => [k, shortHash(v)]));
    if (new Set(Object.values(hashes)).size > 1) {
      latexDrift = true;
      console.warn(`\nWARN: LaTeX helper block "${block}" has DRIFTED:`);
      for (const nodeName of LATEX_HELPER_NODES) console.warn(`  ${hashes[nodeName]}  ${nodeName}`);
      const [ref, ...rest] = LATEX_HELPER_NODES;
      for (const nodeName of rest) {
        if (hashes[nodeName] === hashes[ref]) continue;
        const a = extracted[ref].split('\n'), b = extracted[nodeName].split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) console.warn(`    L${i + 1}  ${ref}: ${a[i] ?? '<missing>'}\n    L${i + 1}  ${nodeName}: ${b[i] ?? '<missing>'}`);
        }
      }
    }
  }
  if (latexDrift) {
    console.warn('\n^^ LaTeX render-helper drift detected above -- this is the shared escaping/section logic behind every resume + cover PDF. A mismatch means one node got a rendering fix the other(s) didn\'t. Investigate before the next deploy.');
  }

  // ── s56: additional deliberate-duplication guards (audit-confirmed sets) ──
  // Same warn-not-fail convention as the CompanyIntel sibling check above.

  // Pass2 Regen's chainLlm prompt is a byte-identical sibling of Pass2 Generate
  // (the jsCode user-message builders around them differ BY DESIGN -- regen adds
  // atsGuidance -- but the system prompts must not drift).
  const p2 = getChainLlmMessage(N['Pass2 Generate'] || {});
  const p2r = getChainLlmMessage(N['Pass2 Regen'] || {});
  if (p2 && p2r && p2 !== p2r) {
    console.warn('WARN: "Pass2 Generate" and "Pass2 Regen" system prompts were identical siblings and have drifted -- check if intentional.');
  }

  // buildBudgetBlock is duplicated by design in the two Pass2 input builders
  // (Code nodes can't share modules) -- must stay byte-identical.
  {
    const extractFnBlock = (code, name) => {
      if (!code) return null;
      const start = code.indexOf('function ' + name + '(');
      if (start === -1) return null;
      let depth = 0, i = code.indexOf('{', start), j = i;
      for (;;) { if (code[j] === '{') depth++; else if (code[j] === '}') depth--; if (depth === 0) break; j++; if (j > code.length) return null; }
      return code.slice(start, j + 1);
    };
    const a = extractFnBlock(getJsCode(N['Build Pass2 Input'] || {}), 'buildBudgetBlock');
    const b = extractFnBlock(getJsCode(N['Build Pass2 Regen Input'] || {}), 'buildBudgetBlock');
    if (a && b && a !== b) {
      console.warn('WARN: buildBudgetBlock has drifted between "Build Pass2 Input" and "Build Pass2 Regen Input" -- these are deliberate byte-identical copies.');
    }
  }

  // parseJSON: one canonical body copied into 10 Code nodes (can't share modules).
  {
    const PARSEJSON_NODES = ['Assemble Resume LaTeX', 'Parse Pass1', 'Parse Step0', 'Parse Pass2', 'Parse Apply Intel', 'Validate ATS Signals', 'Parse Pass2 Regen', 'Assemble Regen', 'Parse Cover Pass1', 'Parse Cover Pass2'];
    const bodies = new Map();
    for (const name of PARSEJSON_NODES) {
      const code = getJsCode(N[name] || {});
      if (!code) continue;
      const start = code.indexOf('function parseJSON(');
      if (start === -1) { console.warn(`WARN: parseJSON missing from "${name}" (was one of the 10 known copies).`); continue; }
      let depth = 0, i = code.indexOf('{', start), j = i;
      for (;;) { if (code[j] === '{') depth++; else if (code[j] === '}') depth--; if (depth === 0) break; j++; }
      bodies.set(name, shortHash(code.slice(start, j + 1)));
    }
    if (new Set(bodies.values()).size > 1) {
      console.warn('WARN: the 10-way parseJSON copy set has DRIFTED:');
      for (const [name, h] of bodies) console.warn(`  ${h}  ${name}`);
    }
  }

  // COUNTRY_NAMES / CITY_COUNTRY: S30's deliberate duplication between the two
  // location-checking nodes (formatting normalized in s55 -- byte-comparable now).
  {
    const extractTable = (code, tbl) => {
      if (!code) return null;
      const i = code.indexOf(`const ${tbl} = {`);
      if (i === -1) return null;
      return code.slice(i, code.indexOf('};', i) + 2);
    };
    for (const tbl of ['COUNTRY_NAMES', 'CITY_COUNTRY']) {
      const a = extractTable(getJsCode(N['Aggregate Jobs'] || {}), tbl);
      const b = extractTable(getJsCode(N['Verify Job Links'] || {}), tbl);
      if (a && b && a !== b) {
        console.warn(`WARN: ${tbl} has drifted between "Aggregate Jobs" and "Verify Job Links" -- S30's rule: if either changes, update both.`);
      }
    }
  }

  // Identical utility-helper sets copied across sibling nodes (audit-confirmed
  // byte-identical today; a drift means one sibling got a fix the others didn't).
  {
    const HELPER_SETS = [
      ['locToString', ['Normalize You.com results', 'Normalize Serper results', 'Normalize Firecrawl Results']],
      ['classifyUrlTier', ['Normalize You.com results', 'Normalize Serper results', 'Normalize Firecrawl Results']],
      ['scrub', ['Prep Apply Body', 'Prep Save Pending Body', 'Restore Apply Row For Save']],
      ['cleanString', ['Prep Apply Body', 'Prep Save Pending Body', 'Restore Apply Row For Save']],
      ['normalizePass2', ['Parse Pass2', 'Parse Pass2 Regen']],
    ];
    const extractFnBlock = (code, name) => {
      if (!code) return null;
      const start = code.indexOf('function ' + name + '(');
      if (start === -1) return null;
      let depth = 0, i = code.indexOf('{', start), j = i;
      for (;;) { if (code[j] === '{') depth++; else if (code[j] === '}') depth--; if (depth === 0) break; j++; if (j > code.length) return null; }
      return code.slice(start, j + 1);
    };
    for (const [fn, nodes] of HELPER_SETS) {
      const hashes = new Map();
      for (const name of nodes) {
        const block = extractFnBlock(getJsCode(N[name] || {}), fn);
        if (block) hashes.set(name, shortHash(block));
      }
      if (hashes.size > 1 && new Set(hashes.values()).size > 1) {
        console.warn(`WARN: helper "${fn}" has drifted across its copy set:`);
        for (const [name, h] of hashes) console.warn(`  ${h}  ${name}`);
      }
    }
  }

  for (const rel of DEAD_FILES) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`DELETED ${rel} (orphaned/dead-lineage, no live node)`); deleted++; }
  }

  console.log(`\nDone. ${written} written, ${unchanged} already in sync, ${deleted} dead files removed.`);
  console.log('Run `git diff prompts/ scripts/nodes/ scripts/_build_cover_latex.js scripts/_build_revised_latex.js` to review.');
}

run();
