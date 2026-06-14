/**
 * s2c_firecrawl_fix.js — make Firecrawl pull its weight in find-jobs.
 *
 * Bug: Build FC Queries fed the @mendable Firecrawl node generic LLM queries
 * ("AI engineer India") and relied on an `includeDomains` body that the node
 * never actually sends (useCustomBody has no body wired). So Firecrawl did an
 * open-web search -> returned Naukri/Indeed/Wellfound aggregator landing pages
 * (tier 3/4) -> all dropped by the URL classifier -> Firecrawl contributed zero.
 * It also only ran when the LLM happened to emit firecrawl_queries (no
 * deterministic fallback like You.com/Serper have).
 *
 * Fix: rewrite Build FC Queries to mirror Build You.com Queries — bake
 * deterministic `site:ATS "role" "location"` queries into the query STRING
 * (domain restriction that doesn't depend on includeDomains), always fire when
 * a role exists, keep bodyObj for any node version that does honor it.
 *
 * Run: node scripts/s2c_firecrawl_fix.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const NEW_CODE = `// Build FC Queries v3 — deterministic site:ATS coverage (mirrors You.com/Serper).
// Firecrawl was open-web searching (returned Naukri/Indeed aggregators); now we
// bake site:ATS into the query string so it targets real ATS postings, and it
// always fires when a role exists (no longer LLM-query dependent).
const ctx = $('Parse Expand Query').first().json;
const llmQueries = ctx.firecrawl_queries || [];
const roles = ctx.role_families || [];

if (!roles.length && !llmQueries.length) {
  return [{ json: { _disabled: true, source: 'firecrawl', reason: 'No queries and no role_families' } }];
}

const top = roles.slice(0, 2);
const loc = (ctx.location_canonical || '').split(',')[0].trim();
const locPart = loc ? ' "' + loc + '"' : '';
const role0 = top[0] || '';
const role1 = top[1] || top[0] || '';
const remoteOnly = ctx.remote_preference === 'remote_only';

const deterministic = role0 ? [
  'site:boards.greenhouse.io "' + role0 + '"' + locPart,
  'site:jobs.lever.co "' + role0 + '"' + locPart,
  '(site:jobs.ashbyhq.com OR site:apply.workable.com) "' + role0 + '"' + locPart,
  '(site:myworkdayjobs.com OR site:jobs.smartrecruiters.com) "' + role1 + '"' + locPart,
] : [];
const remoteExtra = (remoteOnly && role0) ? [
  '(site:weworkremotely.com OR site:remoteok.com OR site:wellfound.com) "' + role0 + '"',
] : [];

const standardATS = [
  'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co',
  'jobs.ashbyhq.com', 'apply.workable.com', 'myworkdayjobs.com',
  'jobs.smartrecruiters.com', 'workatastartup.com'
];
const remoteAggregators = [
  'weworkremotely.com', 'remoteok.com', 'himalayas.app',
  'remotive.com', 'jobicy.com', 'wellfound.com', 'arbeitnow.com'
];
const includeDomains = remoteOnly ? [...standardATS, ...remoteAggregators] : standardATS;
const country = ctx.country || 'US';
const location = ctx.location_canonical || null;
const freshness = ctx.freshness || 'qdr:w';
const limit = remoteOnly ? 25 : 10;

const all = [...llmQueries, ...deterministic, ...remoteExtra];
const seen = new Set();
const queries = [];
for (const q of all) {
  if (!q) continue;
  const k = String(q).toLowerCase().trim();
  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }
}

return queries.slice(0, 4).map(query => ({
  json: {
    _disabled: false,
    query,
    bodyObj: { query, limit, includeDomains, tbs: freshness, ignoreInvalidURLs: true, country, ...(location ? { location } : {}) }
  }
}));`;

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Build FC Queries');
  if (!node) { console.log(`SKIP (${path.basename(file)}: no "Build FC Queries")`); return; }
  node.parameters.jsCode = NEW_CODE;
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${path.basename(file)}: Build FC Queries -> deterministic site:ATS queries`);
}

TARGETS.forEach(patch);
console.log('S2c Firecrawl patch complete.');
