// Build Hook Query — S7. Compact, ToS-safe outreach-hook search query for the
// selected contact. PUBLIC sources only — GitHub, conference talks, engineering
// blogs, papers, podcasts. NO LinkedIn login-scraping, no bulk social targeting.
const ctx = $('Load Draft Contact').first().json || {};
const c = ctx.contact || {};
const name = (c.name || '').trim();
const company = ctx.company || '';
const hook_query = name
  ? '"' + name + '" ' + company + ' (site:github.com OR "conference talk" OR "engineering blog" OR site:arxiv.org OR podcast OR keynote)'
  : company + ' engineering blog OR github OR conference talk';
return [{ json: Object.assign({}, ctx, { hook_query }) }];
