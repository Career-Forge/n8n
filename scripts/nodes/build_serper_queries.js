// Build Serper Queries v2 — LLM creativity + deterministic ATS coverage
// Same idea as Build You.com Queries, with after:YYYY-MM-DD baked in for
// every deterministic query so freshness is guaranteed regardless of what
// the LLM produced. Capped at 4 to respect the Serper free tier.
// Phase 3: cache-first — skip this PAID lane when the cache already returned enough.

const ctx = $('Parse Expand Query').first().json;
const llmQueries = ctx.serper_queries || [];
const roles = ctx.role_families || [];

if (!roles.length && !llmQueries.length) {
  return [{ json: { _disabled: true, source: 'serper', reason: 'No queries and no role_families' } }];
}

let _cacheCount = 0;
try { _cacheCount = ($('Cache Prefilter').first().json || {}).count || 0; } catch (e) {}
if (_cacheCount >= 25) {
  return [{ json: { _disabled: true, source: 'serper', reason: 'cache_sufficient:' + _cacheCount } }];
}

const top = roles.slice(0, 2);
const loc = (ctx.location_canonical || '').split(',')[0].trim();
const locPart = loc ? ' "' + loc + '"' : '';
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

const all = [...llmQueries, ...deterministic];
const seen = new Set();
const queries = [];
for (const q of all) {
  if (!q) continue;
  const k = String(q).toLowerCase().trim();
  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }
}

return queries.slice(0, 4).map(q => ({ json: { _disabled: false, query: q } }));
