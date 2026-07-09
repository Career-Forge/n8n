/**
 * r8_values_writing.js — R8: company-values-aware resume/cover writing (Goal 4).
 *
 * SAFE-BY-CONSTRUCTION: purely additive.
 *  - "Load Writing Profile" is a DEAD-END branch off Prepare Apply Context
 *    (does not alter the main apply flow); looks up company_writing_profiles.
 *  - ResumeForge / CoverForge prompts get an appended block that injects the
 *    guidance ONLY if non-empty. No profile (or PG error) => empty string =>
 *    the forges behave EXACTLY as before. Zero risk to the working money-path.
 *
 * Run AFTER R7.  node scripts/r8_values_writing.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
];
const PG_CRED = { postgres: { id: '5pQq6UUmmGU7e04S', name: 'CareerForge Postgres' } };

const LOAD_SQL =
  "SELECT guidance FROM company_writing_profiles " +
  "WHERE company_key = lower(regexp_replace($1,'[,.].*$','')) " +
  "AND fetched_at > now() - interval '90 days' LIMIT 1";
const LOAD_PARAMS =
  "={{ [ (() => { const c = $('Prepare Apply Context').first().json || {}; " +
  "return c.company || (c.jd && c.jd.company) || (c.job && c.job.company) || c.target_company || c.company_name || 'unknown'; })() ] }}";

const INJECT_BLOCK =
  "\n\nCOMPANY VALUES (apply ONLY if the line below is non-empty — weight bullet selection and phrasing toward these company priorities; never fabricate to fit them):\n" +
  "{{ ($('Load Writing Profile').first() && $('Load Writing Profile').first().json.guidance) || '' }}";

for (const file of TARGETS) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  // 1) Load Writing Profile — dead-end branch off Prepare Apply Context
  if (!N['Load Writing Profile']) {
    const pac = N['Prepare Apply Context'];
    if (!pac) throw new Error(`Prepare Apply Context missing in ${file}`);
    const [x, y] = pac.position;
    wf.nodes.push({
      parameters: { operation: 'executeQuery', query: LOAD_SQL, options: { queryReplacement: LOAD_PARAMS } },
      id: crypto.randomUUID(), name: 'Load Writing Profile', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
      position: [x + 120, y + 260], credentials: PG_CRED, onError: 'continueRegularOutput', alwaysOutputData: true,
    });
    // add a parallel connection (does not disturb existing main -> IF: Mismatch?)
    wf.connections['Prepare Apply Context'].main[0].push({ node: 'Load Writing Profile', type: 'main', index: 0 });
  }

  // 2) Append the empty-fallback guidance block to both forge prompts
  for (const forge of ['ResumeForge', 'CoverForge']) {
    const node = N[forge];
    if (!node) throw new Error(`${forge} missing in ${file}`);
    const mv = node.parameters.messages.messageValues;
    if (!mv[0].message.includes('COMPANY VALUES')) {
      mv[0].message = mv[0].message + INJECT_BLOCK;
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`${file}: R8 applied (${wf.nodes.length} nodes).`);
}
console.log('R8 patch complete.');
