/**
 * s8_contacts.js — S8: optional BYOK contact enrichment (Apollo + Hunter), gated,
 * cost-logged, daily-budget-capped, graceful. Inserted on the draft path between
 * IF: Contact Found? and the hook lane:
 *
 *   IF: Contact Found?(true) -> Load Enrich Config -> IF: Apollo Enabled?
 *      true  -> Apollo Match (HTTP, X-Api-Key header cred) -> Log Apollo Cost -> Build Enriched Contact
 *      false -> Build Enriched Contact
 *   Build Enriched Contact -> IF: Hunter Enabled?
 *      true  -> Hunter Verify (native node) -> Finalize Enriched Contact
 *      false -> Finalize Enriched Contact
 *   Finalize Enriched Contact -> Build Hook Query (now reads the enriched contact)
 *
 * OFF BY DEFAULT: app_settings flags apollo_enabled / hunter_enabled default 'false'
 * (-> free contact path, labeled unverified). Apollo costs exactly 1 credit/match;
 * the budget guard caps daily spend via SUM(units) in tool_cost_log vs apollo_daily_limit.
 * Both provider nodes ship credential-UNBOUND (no cred exists for a fresh clone) and
 * gated off, so they never run until the user binds the cred + flips the flag.
 * Run: node scripts/s8_contacts.js
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

const readNode = (f) => fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8');
const CODE_BUILD_ENR = readNode('build_enriched_contact.js');
const CODE_FINALIZE = readNode('finalize_enriched_contact.js');
const CODE_HOOKQ = readNode('build_hook_query.js');     // updated to read Finalize Enriched Contact
const CODE_NORMHOOKS = readNode('normalize_hooks.js');  // updated to read Finalize Enriched Contact

for (const [nm, code] of Object.entries({ CODE_BUILD_ENR, CODE_FINALIZE, CODE_HOOKQ, CODE_NORMHOOKS })) {
  try { new Function('$input', '$', code); } catch (e) { console.error(`PARSE FAIL ${nm}: ${e.message}`); process.exit(1); }
}

const CONFIG_SQL = "SELECT COALESCE((SELECT value FROM app_settings WHERE key='apollo_enabled'),'false') AS apollo_enabled, "
  + "COALESCE((SELECT value FROM app_settings WHERE key='hunter_enabled'),'false') AS hunter_enabled, "
  + "COALESCE((SELECT value::int FROM app_settings WHERE key='apollo_daily_limit'),25) AS apollo_daily_limit, "
  + "COALESCE((SELECT SUM(units) FROM tool_cost_log WHERE provider='apollo' AND ts::date = now()::date),0) AS apollo_today";
const LOG_SQL = "INSERT INTO tool_cost_log (provider, action, units, est_cost_usd, meta) VALUES ('apollo','people_match', $1::numeric, $1::numeric * 0.02, $2::jsonb)";

const codeNode = (name, code, pos, onError) => {
  const n = { parameters: { jsCode: code }, id: crypto.randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos };
  if (onError) { n.onError = onError; n.alwaysOutputData = true; }
  return n;
};
const pgNode = (name, query, queryReplacement, pos) => {
  const params = { operation: 'executeQuery', query, options: queryReplacement ? { queryReplacement } : {} };
  return { parameters: params, id: crypto.randomUUID(), name, type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: pos, credentials: PG_CRED, onError: 'continueRegularOutput', alwaysOutputData: true };
};
const ifNode = (name, conditions, pos) => ({
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions, combinator: 'and' }, options: {} },
  id: crypto.randomUUID(), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
});

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);

  if (!N['Build Hook Query'] || !N['Load Draft Contact']) { console.error(`  ${base}: prerequisites missing (run s7 first)`); process.exit(1); }

  // keep hook nodes in sync (now read the enriched contact, fallback to Load Draft Contact)
  N['Build Hook Query'].parameters.jsCode = CODE_HOOKQ;
  if (N['Normalize Hooks']) N['Normalize Hooks'].parameters.jsCode = CODE_NORMHOOKS;

  if (N['Load Enrich Config']) { fs.writeFileSync(file, JSON.stringify(wf, null, 2)); console.log(`  ${base}: hook nodes synced; enrich lane already present`); return; }

  let [bx, by] = N['Build Hook Query'].position; bx -= 1150; by -= 180;
  const col = (i, dy) => [bx + i * 220, by + (dy || 0)];

  wf.nodes.push(pgNode('Load Enrich Config', CONFIG_SQL, undefined, col(0)));
  wf.nodes.push(ifNode('IF: Apollo Enabled?', [
    { leftValue: '={{ $json.apollo_enabled }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } },
    { leftValue: '={{ Number($json.apollo_today) }}', rightValue: '={{ Number($json.apollo_daily_limit) }}', operator: { type: 'number', operation: 'lt' } },
  ], col(1)));
  wf.nodes.push({
    parameters: {
      method: 'POST', url: 'https://api.apollo.io/api/v1/people/match',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendQuery: true, queryParameters: { parameters: [
        { name: 'name', value: "={{ (($('Load Draft Contact').first().json||{}).contact||{}).name || '' }}" },
        { name: 'organization_name', value: "={{ ($('Load Draft Contact').first().json||{}).company || '' }}" },
        { name: 'reveal_personal_emails', value: 'false' },
      ] },
      options: { response: { response: { neverError: true } }, timeout: 20000 },
    }, id: crypto.randomUUID(), name: 'Apollo Match', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: col(2, -160), onError: 'continueRegularOutput', alwaysOutputData: true,
  });
  wf.nodes.push(pgNode('Log Apollo Cost', LOG_SQL,
    "={{ [ ((($('Apollo Match').first().json||{}).person) ? 1 : 0), JSON.stringify({ contact: ((($('Load Draft Contact').first().json||{}).contact)||{}).name || '', company: ($('Load Draft Contact').first().json||{}).company || '' }) ] }}",
    col(3, -160)));
  wf.nodes.push(codeNode('Build Enriched Contact', CODE_BUILD_ENR, col(4)));
  wf.nodes.push(ifNode('IF: Hunter Enabled?', [
    { leftValue: '={{ $json.hunter_enabled }}', rightValue: 'true', operator: { type: 'string', operation: 'equals' } },
    { leftValue: "={{ $json.has_email ? 'yes' : 'no' }}", rightValue: 'yes', operator: { type: 'string', operation: 'equals' } },
  ], col(5)));
  wf.nodes.push({
    parameters: { operation: 'emailVerifier', email: "={{ ($('Build Enriched Contact').first().json.contact||{}).email || '' }}" },
    id: crypto.randomUUID(), name: 'Hunter Verify', type: 'n8n-nodes-base.hunter', typeVersion: 1,
    position: col(6, -160), onError: 'continueRegularOutput', alwaysOutputData: true,
  });
  wf.nodes.push(codeNode('Finalize Enriched Contact', CODE_FINALIZE, col(7)));

  // retarget the edge into Build Hook Query -> Load Enrich Config
  let rewired = 0;
  for (const obj of Object.values(C)) {
    (obj.main || []).forEach((branch) => (branch || []).forEach((e) => { if (e.node === 'Build Hook Query') { e.node = 'Load Enrich Config'; rewired++; } }));
  }
  if (!rewired) console.log(`  WARN ${base}: no edge into Build Hook Query to rewire`);

  C['Load Enrich Config'] = { main: [[{ node: 'IF: Apollo Enabled?', type: 'main', index: 0 }]] };
  C['IF: Apollo Enabled?'] = { main: [
    [{ node: 'Apollo Match', type: 'main', index: 0 }],          // true
    [{ node: 'Build Enriched Contact', type: 'main', index: 0 }], // false
  ] };
  C['Apollo Match'] = { main: [[{ node: 'Log Apollo Cost', type: 'main', index: 0 }]] };
  C['Log Apollo Cost'] = { main: [[{ node: 'Build Enriched Contact', type: 'main', index: 0 }]] };
  C['Build Enriched Contact'] = { main: [[{ node: 'IF: Hunter Enabled?', type: 'main', index: 0 }]] };
  C['IF: Hunter Enabled?'] = { main: [
    [{ node: 'Hunter Verify', type: 'main', index: 0 }],              // true
    [{ node: 'Finalize Enriched Contact', type: 'main', index: 0 }], // false
  ] };
  C['Hunter Verify'] = { main: [[{ node: 'Finalize Enriched Contact', type: 'main', index: 0 }]] };
  C['Finalize Enriched Contact'] = { main: [[{ node: 'Build Hook Query', type: 'main', index: 0 }]] };

  // integrity
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S8 contact enrichment wired (${wf.nodes.length} nodes)`);
}

TARGETS.forEach(patch);
console.log('S8 patch complete.');
