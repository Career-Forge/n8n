/**
 * s9b_costs.js — S9 (part 2): `costs` command (tool_cost_log spend summary).
 *
 * - Intent Router: add 'costs' to the intent enum + a classification rule.
 * - Route Intent (expression switch): add 'costs' to the index array (-> index 16),
 *   move the unknown fallback from output 16 to 17, bump numberOutputs 17 -> 18.
 * - New handler: Route Intent[16] -> Load Costs (PG) -> Format Costs (Code) -> Send Costs.
 * Run: node scripts/s9b_costs.js
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

const CODE_FORMAT = fs.readFileSync(path.join(__dirname, 'nodes', 'format_costs.js'), 'utf8');
try { new Function('$input', '$', CODE_FORMAT); } catch (e) { console.error('PARSE FAIL format_costs.js: ' + e.message); process.exit(1); }

const COSTS_SQL = "SELECT provider, COALESCE(SUM(units),0) AS units, COALESCE(SUM(est_cost_usd),0) AS cost, COUNT(*) AS calls, "
  + "COALESCE(SUM(est_cost_usd) FILTER (WHERE ts::date = now()::date),0) AS cost_today "
  + "FROM tool_cost_log WHERE ts > now() - interval '30 days' GROUP BY provider ORDER BY cost DESC";
const COSTS_RULE = "\n17. costs — Show how much has been spent on paid API providers (Apollo, etc.). Triggers: \"costs\", \"spend\", \"usage\", \"how much have I spent\", \"my bill\".";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);

  if (N['Load Costs']) { console.log(`  ${base}: already patched — skipping`); return; }

  // 1) Intent Router: enum + rule
  const ir = N['Intent Router'];
  if (ir && ir.parameters.options) {
    let sm = ir.parameters.options.systemMessage || '';
    if (sm.includes('check_resume"') && !sm.includes('| costs')) sm = sm.split('check_resume"').join('check_resume | costs"');
    if (!sm.includes('17. costs')) sm += COSTS_RULE;
    ir.parameters.options.systemMessage = sm;
  }

  // 2) Route Intent: expression + outputs
  const ri = N['Route Intent'];
  if (ri) {
    let expr = ri.parameters.output || '';
    expr = expr.split("'check_resume']").join("'check_resume','costs']");  // add costs to both arrays
    expr = expr.split('=== -1 ? 16 :').join('=== -1 ? 17 :');               // move unknown fallback to 17
    ri.parameters.output = expr;
    ri.parameters.numberOutputs = 18;
  }

  // 3) handler nodes
  const [rx, ry] = (ri && ri.position) || [0, 0];
  wf.nodes.push({
    parameters: { operation: 'executeQuery', query: COSTS_SQL, options: {} },
    id: crypto.randomUUID(), name: 'Load Costs', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
    position: [rx + 260, ry + 700], credentials: PG_CRED, onError: 'continueRegularOutput', alwaysOutputData: true,
  });
  wf.nodes.push({ parameters: { jsCode: CODE_FORMAT }, id: crypto.randomUUID(), name: 'Format Costs', type: 'n8n-nodes-base.code', typeVersion: 2, position: [rx + 480, ry + 700] });
  wf.nodes.push({
    parameters: { chatId: '={{ $json.chat_id }}', text: '={{ $json.message }}', additionalFields: { appendAttribution: false, parse_mode: 'Markdown' } },
    id: crypto.randomUUID(), name: 'Send Costs', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [rx + 700, ry + 700], onError: 'continueRegularOutput',
  });

  // 4) connections: move fallback (16 -> 17), costs handler at 16
  const m = (C['Route Intent'] && C['Route Intent'].main) || [];
  while (m.length < 18) m.push([]);
  m[17] = m[16] || [];                                              // unknown fallback -> output 17
  m[16] = [{ node: 'Load Costs', type: 'main', index: 0 }];         // costs -> output 16
  C['Route Intent'].main = m;
  C['Load Costs'] = { main: [[{ node: 'Format Costs', type: 'main', index: 0 }]] };
  C['Format Costs'] = { main: [[{ node: 'Send Costs', type: 'main', index: 0 }]] };

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
  console.log(`OK ${base}: costs command wired (${wf.nodes.length} nodes, Route Intent outputs=${ri.parameters.numberOutputs})`);
}

TARGETS.forEach(patch);
console.log('S9b patch complete.');
