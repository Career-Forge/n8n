/**
 * s5_intel.js — S5: richer company intel + writing-bias feed.
 *
 * 1) Sync the FULL prompts/CompanyIntel.md (9 rules + dossier schema incl.
 *    culture.values) into the CompanyIntel node (was a 4-line stub) + append a
 *    bullet_selection_biases instruction (command-center contract).
 * 2) Expand Intel Output Parser schema to ALLOW culture + bullet_selection_biases
 *    (the stub schema lacked culture, so it was being stripped).
 * 3) Target FREE sources in the intel research queries (layoffs.fyi, levels.fyi,
 *    teamblind, h1b, techcrunch, values/careers pages).
 * 4) New Build Writing Guidance (code) + Save Writing Profile (PG): derive a
 *    company_writing_profiles.guidance row from the dossier so the apply path's
 *    Load Writing Profile (R8) biases resume/cover toward what the company values.
 *
 * Find-jobs company_health sub-score lookup deferred (R7 SQL penalty already
 * downranks low-health cached companies; composite stays neutral 60).
 * Run: node scripts/s5_intel.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];
const PG_CRED = { postgres: { id: '5pQq6UUmmGU7e04S', name: 'CareerForge Postgres' } };

const MD = fs.readFileSync(path.join(ROOT, 'prompts', 'CompanyIntel.md'), 'utf8');
const BIASES_BLOCK =
  "\n\n### 10. Bullet-Selection Biases (for resume tailoring)\n" +
  "Also return `bullet_selection_biases`: an object of booleans inferred from the company's stated values/culture, indicating which resume-bullet qualities to emphasize when tailoring a resume for THIS company:\n" +
  "{ \"prioritize_metrics\": bool, \"prioritize_ownership\": bool, \"prioritize_scale\": bool, \"prioritize_customer_impact\": bool, \"prioritize_research_rigor\": bool, \"prioritize_speed\": bool }\n" +
  "Infer from values/culture (e.g. Amazon → ownership + customer_impact; Google → metrics + scale; a research lab → research_rigor). Add this key to your JSON output.";
const COMPANYINTEL_PROMPT = MD + BIASES_BLOCK;

const OLD_INTEL_QUERIES =
  "queries = [company + ' latest news ' + year, company + ' layoffs ' + (year - 1) + ' ' + year, company + ' glassdoor reviews', company + ' H1B sponsorship visa', company + ' funding round valuation', company + ' company culture engineering'];";
const NEW_INTEL_QUERIES =
  "queries = [" +
  "'site:layoffs.fyi ' + company + ' OR ' + company + ' layoffs ' + (year - 1) + ' ' + year, " +
  "company + ' employee reviews glassdoor OR site:teamblind.com ' + company + ' culture', " +
  "'site:levels.fyi ' + company + ' salary compensation', " +
  "company + ' H1B sponsorship visa ' + (year - 1) + ' OR site:h1bdata.info ' + company, " +
  "company + ' funding round valuation ' + year + ' techcrunch', " +
  "company + ' leadership principles core values careers'" +
  "];";

const GUIDANCE_CODE =
`// S5: derive resume-writing guidance from the CompanyIntel dossier
const d = ((($('CompanyIntel').first() || {}).json || {}).output) || {};
let company = d.company;
try { company = company || ((($('Normalize Research Results').first() || {}).json || {}).company); } catch(_) {}
company = company || 'unknown';
const vals = (d.culture && Array.isArray(d.culture.values)) ? d.culture.values : [];
const biases = d.bullet_selection_biases || {};
const activeBias = Object.keys(biases).filter(k => biases[k]).map(k => String(k).replace(/^prioritize_/, '').replace(/_/g, ' '));
const parts = [];
if (vals.length) parts.push('This company values: ' + vals.join(', ') + '.');
if (d.culture && d.culture.type) parts.push('Culture: ' + d.culture.type + '.');
if (activeBias.length) parts.push('Weight resume/cover bullets toward: ' + activeBias.join(', ') + '.');
const guidance = parts.join(' ').substring(0, 800);
const company_key = String(company).toLowerCase().replace(/[,.].*$/, '').trim();
return [{ json: { company_key, guidance, _has_guidance: guidance.length > 0 } }];`;

const SAVE_PROFILE_SQL =
  "INSERT INTO company_writing_profiles (company_key, guidance, source) " +
  "SELECT $1, $2, 'intel' WHERE length($2) > 0 " +
  "ON CONFLICT (company_key) DO UPDATE SET guidance = EXCLUDED.guidance, source = 'intel', fetched_at = now()";

function sj(s, a, b) { return s.split(a).join(b); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const baseN = path.basename(file);
  let edits = 0;

  // 1) sync full CompanyIntel prompt
  const ci = N['CompanyIntel'];
  if (ci) { const mv = ci.parameters.messages.messageValues[0]; if (mv.message !== COMPANYINTEL_PROMPT) { mv.message = COMPANYINTEL_PROMPT; edits++; } }

  // 2) Intel Output Parser schema — allow culture + biases
  const iop = N['Intel Output Parser'];
  if (iop && !iop.parameters.inputSchema.includes('bullet_selection_biases')) {
    iop.parameters.inputSchema = sj(iop.parameters.inputSchema, '"red_flags":{"type":"array"',
      '"culture":{"type":"object","properties":{"type":{"type":"string"},"values":{"type":"array","items":{"type":"string"}}}},"bullet_selection_biases":{"type":"object"},"red_flags":{"type":"array"');
    edits++;
  }

  // 3) free-source intel queries
  const pr = N['Prepare Research'];
  if (pr && pr.parameters.jsCode.includes(OLD_INTEL_QUERIES)) { pr.parameters.jsCode = sj(pr.parameters.jsCode, OLD_INTEL_QUERIES, NEW_INTEL_QUERIES); edits++; }

  // 4) Build Writing Guidance + Save Writing Profile, spliced Save Intel Cache -> ... -> Format Intel Report
  if (N['Save Intel Cache'] && N['Format Intel Report'] && !N['Save Writing Profile']) {
    const [sx, sy] = N['Save Intel Cache'].position;
    wf.nodes.push({
      parameters: { jsCode: GUIDANCE_CODE }, id: crypto.randomUUID(), name: 'Build Writing Guidance',
      type: 'n8n-nodes-base.code', typeVersion: 2, position: [sx + 180, sy + 200], onError: 'continueRegularOutput', alwaysOutputData: true,
    });
    wf.nodes.push({
      parameters: { operation: 'executeQuery', query: SAVE_PROFILE_SQL, options: { queryReplacement: "={{ [$json.company_key, $json.guidance] }}" } },
      id: crypto.randomUUID(), name: 'Save Writing Profile', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
      position: [sx + 360, sy + 200], credentials: PG_CRED, onError: 'continueRegularOutput', alwaysOutputData: true,
    });
    // rewire: Save Intel Cache -> Build Writing Guidance -> Save Writing Profile -> Format Intel Report
    C['Save Intel Cache'] = { main: [[{ node: 'Build Writing Guidance', type: 'main', index: 0 }]] };
    C['Build Writing Guidance'] = { main: [[{ node: 'Save Writing Profile', type: 'main', index: 0 }]] };
    C['Save Writing Profile'] = { main: [[{ node: 'Format Intel Report', type: 'main', index: 0 }]] };
    edits++;
  }

  // integrity
  const names = new Set(wf.nodes.map(n => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    (obj.main || []).forEach(a => (a || []).forEach(e => { if (!names.has(e.node)) { console.error(`INTEGRITY FAIL -> ${e.node}`); process.exit(1); } }));
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${baseN}: S5 applied (${edits} edits, ${wf.nodes.length} nodes)`);
}

TARGETS.forEach(patch);
console.log('S5 patch complete.');
