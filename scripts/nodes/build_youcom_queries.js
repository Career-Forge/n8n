// Build You.com Queries v2 — LLM creativity + deterministic ATS coverage
// We keep the LLM's queries (good for variants we wouldn't think of) and
// ALWAYS add a fixed set of site-targeted ATS queries built from
// role_families + location, so You.com is never trusted to do domain control
// on its own. Output: deduped list, capped at 6 queries.
// Phase 3: cache-first — skip this PAID lane when the cache already returned enough.

const ctx = $('Parse Expand Query').first().json;
const llmQueries = ctx.youcom_queries || [];
const roles = ctx.role_families || [];

if (!roles.length && !llmQueries.length) {
  return [{ json: { _disabled: true, source: 'youcom', reason: 'No queries and no role_families' } }];
}

let _cacheCount = 0;
try { _cacheCount = ($('Cache Prefilter').first().json || {}).count || 0; } catch (e) {}
if (_cacheCount >= 25) {
  return [{ json: { _disabled: true, source: 'youcom', reason: 'cache_sufficient:' + _cacheCount } }];
}

const top = roles.slice(0, 2);
const loc = (ctx.location_canonical || '').split(',')[0].trim();
const locPart = loc ? ' "' + loc + '"' : '';
const role0 = top[0] || '';
const role1 = top[1] || top[0] || '';

const deterministic = role0 ? [
  'site:boards.greenhouse.io "' + role0 + '"' + locPart,
  'site:jobs.lever.co "' + role0 + '"' + locPart,
  '(site:jobs.ashbyhq.com OR site:apply.workable.com) "' + role0 + '"' + locPart,
  '(site:myworkdayjobs.com OR site:jobs.smartrecruiters.com) "' + role1 + '"' + locPart,
] : [];

const all = [...llmQueries, ...deterministic];
const seen = new Set();
const queries = [];
for (const q of all) {
  if (!q) continue;
  const k = String(q).toLowerCase().trim();
  if (k && !seen.has(k)) { seen.add(k); queries.push(q); }
}

return queries.slice(0, 6).map(q => ({ json: { _disabled: false, query: q } }));
