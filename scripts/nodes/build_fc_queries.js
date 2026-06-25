// Build FC Queries v3 — deterministic site:ATS coverage (mirrors You.com/Serper).
// Firecrawl was open-web searching (returned Naukri/Indeed aggregators); now we
// bake site:ATS into the query string so it targets real ATS postings, and it
// always fires when a role exists (no longer LLM-query dependent).
// Phase 3: cache-first — skip this PAID lane when the cache already returned enough.
const ctx = $('Parse Expand Query').first().json;
const llmQueries = ctx.firecrawl_queries || [];
const roles = ctx.role_families || [];

if (!roles.length && !llmQueries.length) {
  return [{ json: { _disabled: true, source: 'firecrawl', reason: 'No queries and no role_families' } }];
}

// Cache-first gate: if the cache lane already produced enough, don't pay for web.
// Best-effort cross-branch read; if Cache Prefilter hasn't executed yet we degrade
// to running the lane (safe — never worse than current behavior).
let _cacheCount = 0;
try { _cacheCount = ($('Cache Prefilter').first().json || {}).count || 0; } catch (e) {}
if (_cacheCount >= 25) {
  return [{ json: { _disabled: true, source: 'firecrawl', reason: 'cache_sufficient:' + _cacheCount } }];
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
}));
