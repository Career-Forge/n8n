// Normalize Apply Research — S6b-3. Flatten the Serper response into a compact
// research_text blob for CompanyIntel Apply. Graceful on empty/failed search.
const company = ($('Prepare Apply Research').first().json || {}).company || 'unknown';
let sp = {};
try { sp = $input.first().json || {}; } catch (e) { sp = {}; }
const organic = Array.isArray(sp.organic) ? sp.organic : [];
const kg = sp.knowledgeGraph || {};
const lines = [];
if (kg.title || kg.description) lines.push((kg.title || '') + ': ' + (kg.description || ''));
if (Array.isArray(kg.attributes)) {
  for (const k of Object.keys(kg.attributes || {})) lines.push(k + ': ' + kg.attributes[k]);
}
for (const r of organic.slice(0, 10)) {
  lines.push('- ' + (r.title || '') + ': ' + (r.snippet || ''));
}
const research_text = (lines.join('\n').slice(0, 6000)) || ('No research results found for ' + company + '. Infer conservatively.');
return [{ json: { company, research_text } }];
