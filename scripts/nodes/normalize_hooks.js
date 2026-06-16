// Normalize Hooks — S7. Flatten the Serper hook search into hook_sources and merge
// with the draft context so OutreachWriter gets {contact, candidate_*, company,
// relevant_achievement, candidate_role, contact_location, hook_sources}. Graceful
// on empty/failed search (hook_sources: []).
const ctx = $('Load Draft Contact').first().json || {};
let sp = {};
try { sp = $input.first().json || {}; } catch (e) { sp = {}; }
const organic = Array.isArray(sp.organic) ? sp.organic : [];
const hook_sources = organic.slice(0, 6).map((r) => ({
  title: r.title || '', url: r.link || '', snippet: r.snippet || '',
})).filter((h) => h.title || h.snippet);

return [{ json: Object.assign({}, ctx, {
  candidate_role: ctx.role || ctx.candidate_role || '',
  contact_location: (ctx.contact || {}).location || null,
  hook_sources,
}) }];
