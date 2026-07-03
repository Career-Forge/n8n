// Auto-generated from the live workflow node "Build Hook Query" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Build Hook Query — S7 (S8: reads the enriched contact when present). Compact,
// ToS-safe outreach-hook search query for the selected contact. PUBLIC sources only
// — GitHub, conference talks, engineering blogs, papers, podcasts. NO LinkedIn
// login-scraping, no bulk social targeting.
function draftCtx() {
  try { const f = $('Finalize Enriched Contact').first().json; if (f && f.contact) return f; } catch (e) {}
  return $('Load Draft Contact').first().json || {};
}
const ctx = draftCtx();
const c = ctx.contact || {};
const name = (c.name || '').trim();
const company = ctx.company || '';
const hook_query = name
  ? '"' + name + '" ' + company + ' (site:github.com OR "conference talk" OR "engineering blog" OR site:arxiv.org OR podcast OR keynote)'
  : company + ' engineering blog OR github OR conference talk';
return [{ json: Object.assign({}, ctx, { hook_query }) }];
