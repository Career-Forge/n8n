// Pass Dossier — S6b-3. Convergence node for the fresh-cache and cold-research
// branches. Exactly one upstream branch executes per run, so this fires once.
// n8n throws on $('<unrun node>') — caught — so we prefer the research result and
// fall back to the cache result, never cross-run stale data.
let d = null;
try {
  const p = $('Parse Apply Intel').first().json;
  if (p && p.dossier && typeof p.dossier === 'object' && Object.keys(p.dossier).length) d = p.dossier;
} catch (e) {}
if (!d) {
  try {
    const c = $('Read Intel Cache (Apply)').first().json;
    if (c && c.dossier) d = (typeof c.dossier === 'string') ? JSON.parse(c.dossier) : c.dossier;
  } catch (e) {}
}
return [{ json: { dossier: d || null } }];
