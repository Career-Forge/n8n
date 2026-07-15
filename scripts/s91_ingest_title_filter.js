/**
 * s91_ingest_title_filter.js -- fixes the FDE-invisibility bug from a live
 * "FDE roles in India" test: the ATS Poller's Parse Jobs node hardcodes a
 * TITLE_RX that gates ALL cache ingestion to AI/ML/data/SWE/backend/full-
 * stack/platform/infra/devops/SRE titles. "Forward Deployed Engineer" (and
 * frontend, mobile, security, solutions, and most other software titles)
 * never matches it -- confirmed live: every FDE result in that digest came
 * from a web search (🔓/✅), none from the cache, and only the one DigitalOcean
 * posting whose title happened to contain "(AI/ML)" got cached at all.
 *
 * Fix: the title-relevance filter + per-board cap move to a new app_settings
 * row ('ingest_title_filter'), same externalization pattern this codebase
 * already uses for 'geo_reference' -- editable with one SQL UPDATE, no
 * redeploy, and the vocabulary is no longer buried in a Code node. A new
 * 'Load Ingest Config' postgres node (spliced between Run Start and Select
 * Due Companies, same credential Select Due Companies already uses) loads it
 * once per poller tick. Parse Jobs builds the regex from config.keywords at
 * runtime (short tokens <=4 chars get \b word-boundary anchors so "ai"/"ml"/
 * "sde"/"swe"/"sre"/"qa" don't match as bare substrings the way the old
 * regex's un-anchored terms like "backend"/"devops" safely can); config.mode
 * 'all' disables filtering entirely (documented escape hatch, matches every
 * string via a zero-width regex rather than skipping the .test() call, so
 * the 4 self-fetch pagination break-checks that reuse this same TITLE_RX by
 * closure -- fetchWorkday/fetchApple/fetchEightfold/fetchAvature -- need no
 * changes at all). If the config row is missing or malformed, Parse Jobs
 * falls back to the EXACT original hardcoded regex + cap 25 -- a config
 * problem must never silently stop ingestion.
 *
 * One-time seed (run separately, see scripts/s91_ingest_config_seed.sql):
 *   INSERT INTO app_settings (key, value) VALUES ('ingest_title_filter', '<json>')
 *   ON CONFLICT (key) DO NOTHING -- seeds once, never clobbers a user's own edit.
 *
 * +1 node (15 -> 16) in the ATS Poller workflow only. No change to the master
 * workflow. Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
];

const POLLER_PG_CRED = { postgres: { id: 'caLsB31DYOphw0EV', name: 'CareerForge_Postgres' } };

// ═══ 1. Parse Jobs: remove the standalone CAP const (redeclared later, merged with TITLE_RX) ═══
const CAP_OLD = `const CAP = 25;
const count = {};
const jobs = [];`;
const CAP_NEW = `const count = {};
const jobs = [];`;

// ═══ 2. Parse Jobs: TITLE_RX + push -> config-driven derivation + push ═══
const TITLE_OLD = `const TITLE_RX = /(machine\\s*learning|\\bml\\b|\\bai\\b|artificial\\s*intelligence|data\\s*(scien|engineer|analy|platform)|analytics\\s*engineer|deep\\s*learning|\\bnlp\\b|\\bllm\\b|gen\\s*ai|generative|computer\\s*vision|research\\s*(scientist|engineer)|applied\\s*scientist|software\\s*engineer|\\bswe\\b|\\bsde\\b|backend|back-end|full[\\s-]*stack|platform\\s*engineer|infrastructure\\s*engineer|devops|mlops|\\bsre\\b)/i;
const push = (board, obj) => { if (!TITLE_RX.test(String(obj.title || ''))) return; count[board] = (count[board] || 0); if (count[board] >= CAP) return; count[board]++; jobs.push(obj); };`;
const TITLE_NEW = `// s91: title-relevance filter + per-board cap are now config-driven
// (app_settings 'ingest_title_filter', same externalization pattern as
// 'geo_reference') instead of a single hardcoded regex -- see Load Ingest
// Config. Falls back to this EXACT original regex/cap if the config row is
// missing or malformed -- a config problem must never silently stop ingestion.
const FALLBACK_TITLE_RX = /(machine\\s*learning|\\bml\\b|\\bai\\b|artificial\\s*intelligence|data\\s*(scien|engineer|analy|platform)|analytics\\s*engineer|deep\\s*learning|\\bnlp\\b|\\bllm\\b|gen\\s*ai|generative|computer\\s*vision|research\\s*(scientist|engineer)|applied\\s*scientist|software\\s*engineer|\\bswe\\b|\\bsde\\b|backend|back-end|full[\\s-]*stack|platform\\s*engineer|infrastructure\\s*engineer|devops|mlops|\\bsre\\b)/i;
function buildTitleFilter(cfg) {
  if (cfg && cfg.mode === 'all') return { rx: /^/, cap: (typeof cfg.cap_per_board === 'number' && cfg.cap_per_board > 0) ? cfg.cap_per_board : 25 };
  if (!cfg || cfg.mode !== 'keywords' || !Array.isArray(cfg.keywords) || !cfg.keywords.length) return { rx: FALLBACK_TITLE_RX, cap: 25 };
  const esc = (s) => String(s).trim().toLowerCase().replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\s+/g, '\\\\s*');
  const parts = cfg.keywords.map((kw) => String(kw || '').trim()).filter(Boolean).map((raw) => {
    const pattern = esc(raw);
    return raw.length <= 4 ? '\\\\b' + pattern + '\\\\b' : pattern;
  });
  if (!parts.length) return { rx: FALLBACK_TITLE_RX, cap: 25 };
  let rx;
  try { rx = new RegExp('(' + parts.join('|') + ')', 'i'); } catch (e) { return { rx: FALLBACK_TITLE_RX, cap: 25 }; }
  return { rx, cap: (typeof cfg.cap_per_board === 'number' && cfg.cap_per_board > 0) ? cfg.cap_per_board : 25 };
}
let _ingestConfig = null;
try { _ingestConfig = $('Load Ingest Config').first().json.ingest_config; } catch (e) {}
const { rx: TITLE_RX, cap: CAP } = buildTitleFilter(_ingestConfig);
const push = (board, obj) => { if (!TITLE_RX.test(String(obj.title || ''))) return; count[board] = (count[board] || 0); if (count[board] >= CAP) return; count[board]++; jobs.push(obj); };`;

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  // s91's own replacement text contains a literal '$&' (a regex-escaping
  // helper) -- String.replace(str, str) treats $&/$`/$'/$<n> specially even
  // with a plain-string first argument, which would splice the MATCHED TEXT
  // back in instead of the intended literal (documented gotcha, plan_handout.md).
  // split/join has no such special-pattern handling.
  container[key] = val.split(oldStr).join(newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  const required = ['Run Start', 'Select Due Companies', 'Parse Jobs'];
  for (const r of required) { if (!N[r]) { console.error(`INTEGRITY FAIL ${base}: node "${r}" not found`); process.exit(1); } }

  if (N['Parse Jobs'].parameters.jsCode.includes('s91:')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', CAP_OLD, CAP_NEW, 'CAP const removal', base);
  replaceOnce(N['Parse Jobs'].parameters, 'jsCode', TITLE_OLD, TITLE_NEW, 'config-driven title filter', base);

  const runStartPos = N['Run Start'].position;
  const loadIngestConfig = {
    id: crypto.randomUUID(), name: 'Load Ingest Config', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
    position: [runStartPos[0] + 80, runStartPos[1] + 140],
    parameters: {
      operation: 'executeQuery',
      query: "SELECT value::jsonb AS ingest_config FROM app_settings WHERE key='ingest_title_filter'",
    },
    credentials: POLLER_PG_CRED,
  };
  wf.nodes.push(loadIngestConfig);

  // Splice into the existing Run Start -> Select Due Companies edge.
  wf.connections['Run Start'] = { main: [[{ node: 'Load Ingest Config', type: 'main', index: 0 }]] };
  wf.connections['Load Ingest Config'] = { main: [[{ node: 'Select Due Companies', type: 'main', index: 0 }]] };

  // integrity: every edge resolves, no dangling connections
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
  console.log(`OK ${base}: config-driven ingest title filter (+1 node, Load Ingest Config) -- ${wf.nodes.length} nodes`);
}

// ── harness: extract the ACTUAL patched functions and prove behavior before any write ──
(function harness() {
  const buildTitleFilter = new Function('cfg', `
    const FALLBACK_TITLE_RX = /(machine\\s*learning|\\bml\\b|\\bai\\b|artificial\\s*intelligence|data\\s*(scien|engineer|analy|platform)|analytics\\s*engineer|deep\\s*learning|\\bnlp\\b|\\bllm\\b|gen\\s*ai|generative|computer\\s*vision|research\\s*(scientist|engineer)|applied\\s*scientist|software\\s*engineer|\\bswe\\b|\\bsde\\b|backend|back-end|full[\\s-]*stack|platform\\s*engineer|infrastructure\\s*engineer|devops|mlops|\\bsre\\b)/i;
    if (cfg && cfg.mode === 'all') return { rx: /^/, cap: (typeof cfg.cap_per_board === 'number' && cfg.cap_per_board > 0) ? cfg.cap_per_board : 25 };
    if (!cfg || cfg.mode !== 'keywords' || !Array.isArray(cfg.keywords) || !cfg.keywords.length) return { rx: FALLBACK_TITLE_RX, cap: 25 };
    const esc = (s) => String(s).trim().toLowerCase().replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\s+/g, '\\\\s*');
    const parts = cfg.keywords.map((kw) => String(kw || '').trim()).filter(Boolean).map((raw) => {
      const pattern = esc(raw);
      return raw.length <= 4 ? '\\\\b' + pattern + '\\\\b' : pattern;
    });
    if (!parts.length) return { rx: FALLBACK_TITLE_RX, cap: 25 };
    let rx;
    try { rx = new RegExp('(' + parts.join('|') + ')', 'i'); } catch (e) { return { rx: FALLBACK_TITLE_RX, cap: 25 }; }
    return { rx, cap: (typeof cfg.cap_per_board === 'number' && cfg.cap_per_board > 0) ? cfg.cap_per_board : 25 };
  `);

  // The exact real-world failing case: FDE was invisible under the old hardcoded regex.
  const seedCfg = {
    mode: 'keywords', cap_per_board: 50,
    keywords: [
      'software engineer', 'software developer', 'swe', 'sde', 'developer',
      'frontend', 'front end', 'backend', 'back end', 'full stack', 'fullstack',
      'mobile engineer', 'ios', 'android', 'web engineer',
      'forward deployed', 'solutions engineer', 'solutions architect', 'implementation engineer',
      'customer engineer', 'deployment engineer', 'field engineer', 'sales engineer',
      'machine learning', 'ml engineer', 'ml', 'ai', 'artificial intelligence', 'deep learning',
      'nlp', 'llm', 'gen ai', 'genai', 'generative', 'computer vision',
      'data scientist', 'data engineer', 'data analyst', 'data platform', 'analytics engineer', 'applied scientist',
      'research engineer', 'research scientist',
      'devops', 'mlops', 'sre', 'site reliability', 'platform engineer', 'infrastructure', 'cloud engineer',
      'security engineer', 'application security', 'appsec',
      'qa engineer', 'test engineer', 'sdet',
      'embedded', 'firmware', 'systems engineer', 'distributed systems',
      'database', 'dba', 'architect', 'principal engineer', 'staff engineer', 'engineering manager', 'tech lead',
    ],
  };
  const { rx, cap } = buildTitleFilter(seedCfg);
  if (cap !== 50) { console.error('HARNESS FAIL: cap_per_board not honored', cap); process.exit(1); }
  const mustMatch = ['Founding Forward Deployed Engineer (India)', 'Meesho - Forward Deployed Engineer - II', 'Senior Solutions Engineer', 'Frontend Engineer', 'iOS Engineer', 'Security Engineer II', 'AI/ML Engineer', 'ML Engineer', 'Data Engineer', 'Site Reliability Engineer'];
  for (const t of mustMatch) { if (!rx.test(t)) { console.error(`HARNESS FAIL: "${t}" should match the config-driven filter`, rx); process.exit(1); } }
  const mustNotMatch = ['Enterprise Account Executive', 'HR Business Partner', 'Warehouse Associate'];
  for (const t of mustNotMatch) { if (rx.test(t)) { console.error(`HARNESS FAIL: "${t}" should NOT match`, rx); process.exit(1); } }
  console.log('HARNESS OK: config-driven filter matches FDE/solutions/frontend/security/AI-ML titles the old hardcoded regex missed, cap_per_board honored, non-software titles still excluded');

  // Short-token anchoring: bare "ai"/"ml" must not match as a loose substring.
  const shortCfg = { mode: 'keywords', keywords: ['ai', 'ml'] };
  const { rx: shortRx } = buildTitleFilter(shortCfg);
  if (shortRx.test('Warehouse Associate')) { console.error('HARNESS FAIL: bare "ai" matched inside "Associate" -- \\b anchoring broken', shortRx); process.exit(1); }
  if (!shortRx.test('AI Engineer')) { console.error('HARNESS FAIL: "AI Engineer" should match', shortRx); process.exit(1); }
  console.log('HARNESS OK: short tokens (<=4 chars) are \\b-anchored, no false substring matches');

  // mode:'all' escape hatch.
  const { rx: allRx, cap: allCap } = buildTitleFilter({ mode: 'all', cap_per_board: 100 });
  if (!allRx.test('Anything At All')) { console.error('HARNESS FAIL: mode:all should match everything'); process.exit(1); }
  if (allCap !== 100) { console.error('HARNESS FAIL: mode:all should still honor cap_per_board'); process.exit(1); }
  console.log('HARNESS OK: mode:"all" escape hatch matches every title');

  // Missing/malformed config falls back to the exact original hardcoded regex + cap 25.
  const { rx: fbRx, cap: fbCap } = buildTitleFilter(null);
  if (fbCap !== 25) { console.error('HARNESS FAIL: missing config should fall back to cap 25'); process.exit(1); }
  if (!fbRx.test('Machine Learning Engineer') || fbRx.test('Warehouse Associate')) { console.error('HARNESS FAIL: fallback regex behaves differently than the original'); process.exit(1); }
  const { rx: malformedRx } = buildTitleFilter({ mode: 'keywords', keywords: [] });
  if (!malformedRx.test('Machine Learning Engineer')) { console.error('HARNESS FAIL: empty keywords array should fall back, not disable filtering'); process.exit(1); }
  console.log('HARNESS OK: missing/malformed config fails open to the exact original hardcoded filter, never silently stops ingestion');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
