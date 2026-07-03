// Auto-generated from the live workflow node "Build Enriched Contact" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Build Enriched Contact — S8. Converge after the Apollo gate. Merges the Apollo
// match (work email + title) into the contact when Apollo ran; otherwise passes the
// free contact through unchanged. Carries hunter_enabled + has_email forward so the
// Hunter gate can decide cheaply. n8n throws on $('<unrun node>') — caught.
const ctx = $('Load Draft Contact').first().json || {};
const base = ctx.contact || {};

let cfg = {};
try { cfg = $('Load Enrich Config').first().json || {}; } catch (e) { cfg = {}; }

let person = null;
try {
  const a = $('Apollo Match').first().json || {};
  person = a.person || (Array.isArray(a.matches) && a.matches[0]) || (Array.isArray(a.people) && a.people[0]) || null;
} catch (e) { person = null; }

const email = (person && (person.email || person.work_email)) || base.email || null;
const title = (person && (person.title || person.headline)) || base.role || base.title || '';
const contact = Object.assign({}, base, {
  email: email || null,
  title: title,
  apollo_enriched: !!person,
});

return [{ json: Object.assign({}, ctx, {
  contact,
  has_email: !!email,
  hunter_enabled: cfg.hunter_enabled || 'false',
}) }];
