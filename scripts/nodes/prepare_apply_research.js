// Auto-generated from the live workflow node "Prepare Apply Research" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Prepare Apply Research — S6b-3. Compact apply-time company research query,
// focused on what resume tailoring needs (values / mission / culture). Company
// comes from Prepare Job Context. Only runs on a cold cache (IF: Dossier Fresh? = no).
const company = ($('Prepare Job Context').first().json || {}).company || 'unknown';
const research_query = '"' + company + '" company mission vision core values culture; '
  + 'what ' + company + ' values in engineers; leadership principles; employee reviews; what it is like to work there';
return [{ json: { company, research_query } }];
