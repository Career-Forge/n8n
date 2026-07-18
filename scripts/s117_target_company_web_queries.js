/**
 * s117_target_company_web_queries.js -- makes the 3 web-search lanes
 * (Serper, You.com, Firecrawl) actually company-aware when the user names
 * a specific target company, instead of only ever building role+location
 * `site:knownATS` queries.
 *
 * ROOT CAUSE (found while designing a Meta-specific fix, but this is a
 * GENERAL gap, not Meta-specific -- fixed generically, no hardcoded
 * company name anywhere, matching the whole s86-s89 de-hardcoding pass's
 * own principle): `target_companies` is already populated correctly and
 * conservatively (s84's deterministic backstop requires the name to be a
 * literal substring of the user's own message -- "explicit only" by
 * construction, nothing new needed there). But all 3 query builders
 * (Build Serper Queries, Build You.com Queries, Build FC Queries) only
 * ever emit role+location queries restricted to known ATS site: domains
 * (greenhouse/lever/ashby/workday/workable/smartrecruiters). A company
 * with no adapter and no presence on those platforms -- Meta, Citadel,
 * Renaissance Technologies, Optiver, and others found earlier this
 * session -- can NEVER surface through these lanes no matter how
 * explicitly the user names them. Both Serper's and You.com's own cap
 * logic already bumps to 8 queries when target_companies is set
 * (`(ctx.target_companies||[]).length ? 8 : 4/6`) -- confirming this was
 * anticipated and provisioned for, just never filled in.
 *
 * FIX: each builder now also emits up to 3 company-scoped queries (plain
 * "<role>" "<company>" jobs text, NO site: restriction) whenever
 * target_companies is non-empty, folded into the existing dedup+cap pool
 * (so it never exceeds the already-provisioned 8-query cap).
 *
 * FIRECRAWL-SPECIFIC WRINKLE: its query objects carry an `includeDomains`
 * allowlist (standard ATS + remote aggregators when remote-only) --
 * company-scoped queries need that allowlist OMITTED entirely (open web),
 * or Firecrawl would filter out the exact metacareers.com/similar results
 * this fix exists to surface. Handled by giving company-scoped queries
 * their own bodyObj construction, built and capped separately from the
 * domain-restricted ones, then merged.
 *
 * NOT touched: Aggregate Jobs' downstream cohort/company filter already
 * keys purely on target_companies (confirmed by s80/s84's own prior
 * investigation) -- these new query results flow through the exact same
 * ranking/filtering/badging path as every other web-lane result, no
 * special-casing needed there.
 *
 * Run: harness first (structural + real query-count assertions against
 * fixture contexts), then standard deploy dance (single master file only
 * -- this workflow has no poller-side equivalent).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_TARGETS = [path.join(ROOT, 'workflows', 'CareerForge_Master_local.json')];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ── 1. Build Serper Queries ──
const SERPER_OLD = "const all = [...llmQueries, ...deterministic];\nconst seen = new Set();\nconst queries = [];\nfor (const q of all) {\n  if (!q) continue;\n  const k = String(q).toLowerCase().trim();\n  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }\n}\n\nconst _cap = (ctx.target_companies || []).length ? 8 : 4;\nreturn queries.slice(0, _cap).map(q => ({ json: { _disabled: false, query: q } }));";
const SERPER_NEW = "// s117: company-scoped queries (no site: restriction -- a named company\n// with no ATS-adapter presence, e.g. Meta, can never surface through the\n// site:-restricted deterministic queries above). Only fires when the user\n// explicitly named a company (target_companies is already conservatively\n// gated by s84's literal-substring backstop -- nothing new needed here).\nconst companyQueries = role0 ? (ctx.target_companies || []).slice(0, 3).map((co) => '\"' + role0 + '\" \"' + co + '\" jobs' + locPart) : [];\n\nconst all = [...llmQueries, ...deterministic, ...companyQueries];\nconst seen = new Set();\nconst queries = [];\nfor (const q of all) {\n  if (!q) continue;\n  const k = String(q).toLowerCase().trim();\n  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }\n}\n\nconst _cap = (ctx.target_companies || []).length ? 8 : 4;\nreturn queries.slice(0, _cap).map(q => ({ json: { _disabled: false, query: q } }));";

// ── 2. Build You.com Queries ──
const YOUCOM_OLD = "const all = [...llmQueries, ...deterministic];\nconst seen = new Set();\nconst queries = [];\nfor (const q of all) {\n  if (!q) continue;\n  const k = String(q).toLowerCase().trim();\n  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }\n}\n\nconst _cap = (ctx.target_companies || []).length ? 8 : 6;\nreturn queries.slice(0, _cap).map(q => ({ json: { _disabled: false, query: q } }));";
const YOUCOM_NEW = "// s117: same company-scoped-query fix as Build Serper Queries (see that\n// node's comment for the full rationale) -- open-web queries, no site:\n// restriction, only when the user explicitly named a company.\nconst companyQueries = role0 ? (ctx.target_companies || []).slice(0, 3).map((co) => '\"' + role0 + '\" \"' + co + '\" jobs' + locPart) : [];\n\nconst all = [...llmQueries, ...deterministic, ...companyQueries];\nconst seen = new Set();\nconst queries = [];\nfor (const q of all) {\n  if (!q) continue;\n  const k = String(q).toLowerCase().trim();\n  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }\n}\n\nconst _cap = (ctx.target_companies || []).length ? 8 : 6;\nreturn queries.slice(0, _cap).map(q => ({ json: { _disabled: false, query: q } }));";

// ── 3. Build FC Queries (Firecrawl) -- needs its own open-web bodyObj, no includeDomains ──
const FC_OLD = "const all = [...llmQueries, ...deterministic, ...remoteExtra];\nconst seen = new Set();\nconst queries = [];\nfor (const q of all) {\n  if (!q) continue;\n  const k = String(q).toLowerCase().trim();\n  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }\n}\n\nreturn queries.slice(0, 4).map(query => ({\n  json: {\n    _disabled: false,\n    query,\n    bodyObj: { query, limit, includeDomains, tbs: freshness, ignoreInvalidURLs: true, ...(country ? { country } : {}), ...(location ? { location } : {}) }\n  }\n}));";
const FC_NEW = "// s117: company-scoped queries need includeDomains OMITTED entirely (open\n// web) -- the standard-ATS/remote-aggregator allowlist above would filter\n// out the exact non-ATS company pages (e.g. metacareers.com) this exists to\n// surface. Built and capped separately from the domain-restricted queries,\n// then merged -- only fires when the user explicitly named a company.\nconst companyQueryTexts = role0 ? (ctx.target_companies || []).slice(0, 3).map((co) => '\"' + role0 + '\" \"' + co + '\" jobs' + locPart) : [];\nconst companyItems = companyQueryTexts.map((query) => ({\n  json: {\n    _disabled: false,\n    query,\n    bodyObj: { query, limit, tbs: freshness, ignoreInvalidURLs: true, ...(country ? { country } : {}), ...(location ? { location } : {}) }\n  }\n}));\n\nconst all = [...llmQueries, ...deterministic, ...remoteExtra];\nconst seen = new Set();\nconst queries = [];\nfor (const q of all) {\n  if (!q) continue;\n  const k = String(q).toLowerCase().trim();\n  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }\n}\n\nconst atsItems = queries.slice(0, 4).map(query => ({\n  json: {\n    _disabled: false,\n    query,\n    bodyObj: { query, limit, includeDomains, tbs: freshness, ignoreInvalidURLs: true, ...(country ? { country } : {}), ...(location ? { location } : {}) }\n  }\n}));\nreturn [...atsItems, ...companyItems].slice(0, 6);";

function patchMaster(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Build Serper Queries', 'Build You.com Queries', 'Build FC Queries']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Build Serper Queries'].parameters.jsCode.includes('companyQueries')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Serper Queries'].parameters, 'jsCode', SERPER_OLD, SERPER_NEW, 'company-scoped queries (serper)', base);
  replaceOnce(N['Build You.com Queries'].parameters, 'jsCode', YOUCOM_OLD, YOUCOM_NEW, 'company-scoped queries (youcom)', base);
  replaceOnce(N['Build FC Queries'].parameters, 'jsCode', FC_OLD, FC_NEW, 'company-scoped queries (firecrawl)', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: 3 web-lane query builders gained company-scoped, open-web queries -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // Real fixture context, matching what Parse Expand Query actually outputs.
  const CTX_WITH_TARGET = {
    role_families: ['Machine Learning Engineer', 'ML Engineer'],
    location_canonical: null, country_name: null, country: null, location: null,
    target_companies: ['Meta'], remote_preference: 'open', freshness: 'qdr:w',
    serper_queries: [], youcom_queries: [], firecrawl_queries: [],
  };
  const CTX_NO_TARGET = Object.assign({}, CTX_WITH_TARGET, { target_companies: [] });

  // The patched snippets reference outer-scope vars (ctx, role0, locPart,
  // llmQueries, deterministic) defined earlier in the real node -- build a
  // full standalone harness body per node, ending in the real patched text.
  function fullSerperBody() {
    return `
const ctx = $('Parse Expand Query').first().json;
const llmQueries = ctx.serper_queries || [];
const roles = ctx.role_families || [];
const top = roles.slice(0, 2);
const loc = (ctx.location_canonical || '').split(',')[0].trim();
const locPart = loc ? ' "' + loc + '"' : (ctx.country_name ? ' "' + ctx.country_name + '"' : '');
const role0 = top[0] || '';
const role1 = top[1] || top[0] || '';
const freshness = ctx.freshness || 'qdr:w';
const daysBack = { 'qdr:h': 1, 'qdr:d': 1, 'qdr:w': 7, 'qdr:m': 30, 'qdr:y': 365 }[freshness] || 7;
const sinceDate = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
const deterministic = role0 ? [
  '(site:boards.greenhouse.io OR site:jobs.lever.co) "' + role0 + '"' + locPart + ' after:' + sinceDate,
  '(site:jobs.ashbyhq.com OR site:myworkdayjobs.com) "' + role0 + '"' + locPart + ' after:' + sinceDate,
  '(site:apply.workable.com OR site:jobs.smartrecruiters.com) "' + role1 + '"' + locPart + ' after:' + sinceDate,
] : [];
${SERPER_NEW}
`;
  }
  function run(bodySrc, ctx) {
    const $ = () => ({ first: () => ({ json: ctx }) });
    const factory = new Function('$', bodySrc);
    return factory($);
  }

  const withTarget = run(fullSerperBody(), CTX_WITH_TARGET);
  const noTarget = run(fullSerperBody(), CTX_NO_TARGET);
  const withCompanyQ = withTarget.filter((r) => r.json.query.includes('"Meta"'));
  const noCompanyQ = noTarget.filter((r) => r.json.query.includes('"Meta"'));
  if (withCompanyQ.length < 1) { console.error('HARNESS FAIL (serper): expected a Meta-scoped query when target_companies is set, got none. Full output:', JSON.stringify(withTarget)); process.exit(1); }
  if (noCompanyQ.length !== 0) { console.error('HARNESS FAIL (serper): unexpected company query with no target_companies'); process.exit(1); }
  if (withTarget.length > 8) { console.error(`HARNESS FAIL (serper): exceeded the 8-query cap, got ${withTarget.length}`); process.exit(1); }

  console.log(`HARNESS OK: Serper builder emits a Meta-scoped open-web query when target_companies=['Meta'] (${withCompanyQ.length} found), zero such queries when target_companies is empty, total capped at ${withTarget.length}/8.`);

  // 2. Firecrawl: company items must have NO includeDomains key.
  function fullFCBody() {
    return `
const ctx = $('Parse Expand Query').first().json;
const llmQueries = ctx.firecrawl_queries || [];
const roles = ctx.role_families || [];
const top = roles.slice(0, 2);
const loc = (ctx.location_canonical || '').split(',')[0].trim();
const locPart = loc ? ' "' + loc + '"' : (ctx.country_name ? ' "' + ctx.country_name + '"' : '');
const role0 = top[0] || '';
const role1 = top[1] || top[0] || '';
const remoteOnly = ctx.remote_preference === 'remote_only';
const deterministic = role0 ? [
  'site:boards.greenhouse.io "' + role0 + '"' + locPart,
  'site:jobs.lever.co "' + role0 + '"' + locPart,
] : [];
const remoteExtra = [];
const standardATS = ['boards.greenhouse.io'];
const remoteAggregators = [];
const includeDomains = remoteOnly ? [...standardATS, ...remoteAggregators] : standardATS;
const country = ctx.country || null;
const location = ctx.location_canonical || null;
const freshness = ctx.freshness || 'qdr:w';
const limit = remoteOnly ? 25 : 10;
${FC_NEW}
`;
  }
  const fcWithTarget = run(fullFCBody(), CTX_WITH_TARGET);
  const fcCompanyItems = fcWithTarget.filter((r) => r.json.query.includes('"Meta"'));
  if (fcCompanyItems.length < 1) { console.error('HARNESS FAIL (firecrawl): expected a Meta-scoped item'); process.exit(1); }
  for (const item of fcCompanyItems) {
    if ('includeDomains' in item.json.bodyObj) { console.error('HARNESS FAIL (firecrawl): company-scoped item should NOT have includeDomains, got', JSON.stringify(item.json.bodyObj)); process.exit(1); }
  }
  const fcAtsItems = fcWithTarget.filter((r) => !r.json.query.includes('"Meta"'));
  for (const item of fcAtsItems) {
    if (!('includeDomains' in item.json.bodyObj)) { console.error('HARNESS FAIL (firecrawl): ATS-scoped item should still have includeDomains'); process.exit(1); }
  }

  console.log(`HARNESS OK: Firecrawl builder's company-scoped items (${fcCompanyItems.length}) correctly omit includeDomains (open web), ATS-scoped items (${fcAtsItems.length}) keep it.`);

  MASTER_TARGETS.forEach(patchMaster);
  console.log('S117 (target-company web queries) script complete.');
})();
