/**
 * s6b3_research_apply.js — S6b-3: research-on-apply dossier branch + mission/vision.
 *
 * Sequential on the resume path (guarantees the dossier is ready before Pass-1,
 * no Merge barrier): gate -> Read Intel Cache (Apply) -> IF: Dossier Fresh?
 *   fresh -> Pass Dossier
 *   cold  -> Prepare Apply Research -> Apply Research Fetch (Serper) ->
 *            Normalize Apply Research -> CompanyIntel Apply (deepseek) ->
 *            Parse Apply Intel -> Save Intel Cache (Apply) -> Pass Dossier
 * Pass Dossier -> Build Pass1 Context (which already reads $('Pass Dossier')).
 *
 * Every step is graceful (onError/neverError) -> a failed cold lookup yields a null
 * dossier and Pass-1 runs JD-only, exactly like before. Warm cache = 1 PG read.
 * Also extends the canonical CompanyIntel prompt + Intel Output Parser with
 * mission_vision (the user explicitly wants vision/mission feeding selection).
 * Run: node scripts/s6b3_research_apply.js
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
const OR_CRED = { openRouterApi: { id: 'xZD1i4ZBmSxVDuIe', name: 'OpenRouter account' } };

const readNode = (f) => fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8');
const CODE_PREP = readNode('prepare_apply_research.js');
const CODE_NORM = readNode('normalize_apply_research.js');
const CODE_PASS = readNode('pass_dossier.js');
const PARSE = readNode('_parseJSON_snippet.js');
const CODE_PARSE_INTEL = PARSE + "\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);return [{json:{dossier:parseJSON(raw)}}];";

const MISSION_VISION_BLOCK =
  "\n\n### 11. Mission & Vision\n" +
  "Also return `mission_vision`: a 1-2 sentence string capturing the company's stated mission and vision " +
  "(what they build and why it matters), drawn from their about/careers/mission pages or reliable sources. " +
  "Use an empty string if unknown. Add this key to your JSON output.";

for (const [nm, code] of Object.entries({ CODE_PREP, CODE_NORM, CODE_PASS, CODE_PARSE_INTEL })) {
  try { new Function('$input', '$', code); } catch (e) { console.error(`PARSE FAIL ${nm}: ${e.message}`); process.exit(1); }
}

const SELECT_SQL = "SELECT (SELECT dossier FROM company_intel WHERE company_key = lower(regexp_replace($1,'[,.].*$','')) AND fetched_at > now() - interval '30 days' LIMIT 1) AS dossier";
const UPSERT_SQL = "INSERT INTO company_intel (company_key, dossier, health_score) VALUES (lower(regexp_replace($1,'[,.].*$','')), $2::jsonb, NULLIF($3,'')::int) ON CONFLICT (company_key) DO UPDATE SET dossier=EXCLUDED.dossier, health_score=EXCLUDED.health_score, fetched_at=now()";

const codeNode = (name, code, pos, onError) => {
  const n = { parameters: { jsCode: code }, id: crypto.randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos };
  if (onError) { n.onError = onError; n.alwaysOutputData = true; }
  return n;
};
const pgNode = (name, query, queryReplacement, pos) => ({
  parameters: { operation: 'executeQuery', query, options: { queryReplacement } },
  id: crypto.randomUUID(), name, type: 'n8n-nodes-base.postgres', typeVersion: 2.6, position: pos,
  credentials: PG_CRED, onError: 'continueRegularOutput', alwaysOutputData: true,
});

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);

  if (!N['Build Pass1 Context']) { console.error(`  ${base}: Build Pass1 Context missing — run s6b2 first`); process.exit(1); }
  if (N['Pass Dossier']) { console.log(`  ${base}: already patched — skipping`); return; }

  // ── S5 touch: mission_vision into canonical CompanyIntel prompt + parser ──
  const ci = N['CompanyIntel'];
  let ciPrompt = ci ? ci.parameters.messages.messageValues[0].message : '';
  const applyPrompt = ciPrompt.includes('mission_vision') ? ciPrompt : (ciPrompt + MISSION_VISION_BLOCK);
  if (ci && !ciPrompt.includes('mission_vision')) ci.parameters.messages.messageValues[0].message = ciPrompt + MISSION_VISION_BLOCK;
  const iop = N['Intel Output Parser'];
  if (iop && !iop.parameters.inputSchema.includes('mission_vision')) {
    iop.parameters.inputSchema = iop.parameters.inputSchema.split('"red_flags"').join('"mission_vision":{"type":"string"},"red_flags"');
  }

  // ── layout anchor: left of Build Pass1 Context ──
  let [bx, by] = N['Build Pass1 Context'].position; bx -= 1500;
  const col = (i, dy) => [bx + i * 230, by + (dy || 0)];

  // ── new nodes ──
  wf.nodes.push(pgNode('Read Intel Cache (Apply)', SELECT_SQL, "={{ [ $('Prepare Job Context').first().json.company || 'unknown' ] }}", col(0)));
  wf.nodes.push({
    parameters: {
      conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: "={{ $json.dossier ? 'yes' : 'no' }}", rightValue: 'yes', operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and' }, options: {},
    }, id: crypto.randomUUID(), name: 'IF: Dossier Fresh?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: col(1),
  });
  wf.nodes.push(codeNode('Prepare Apply Research', CODE_PREP, col(2, 160)));
  wf.nodes.push({
    parameters: {
      method: 'POST', url: 'https://google.serper.dev/search', sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-API-KEY', value: '={{ $env.SERPER_API_KEY || "" }}' }, { name: 'Content-Type', value: 'application/json' }] },
      sendBody: true, specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ q: $('Prepare Apply Research').first().json.research_query, num: 10 }) }}",
      options: { response: { response: { neverError: true } }, timeout: 15000 },
    }, id: crypto.randomUUID(), name: 'Apply Research Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: col(3, 160), onError: 'continueRegularOutput', alwaysOutputData: true,
  });
  wf.nodes.push(codeNode('Normalize Apply Research', CODE_NORM, col(4, 160)));
  wf.nodes.push({
    parameters: { promptType: 'define', text: "={{ JSON.stringify({ company: $json.company, research_text: $json.research_text }) }}", hasOutputParser: false, messages: { messageValues: [{ message: applyPrompt }] } },
    id: crypto.randomUUID(), name: 'CompanyIntel Apply', type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4, position: col(5, 160),
  });
  wf.nodes.push({
    parameters: { model: 'deepseek/deepseek-v4-flash', options: { maxTokens: 4000, timeout: 90000 } },
    id: crypto.randomUUID(), name: 'CompanyIntel Apply Model', type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', typeVersion: 1, position: col(5, 320), credentials: OR_CRED,
  });
  wf.nodes.push(codeNode('Parse Apply Intel', CODE_PARSE_INTEL, col(6, 160)));
  wf.nodes.push(pgNode('Save Intel Cache (Apply)', UPSERT_SQL,
    "={{ [ (($('Parse Apply Intel').first().json.dossier && $('Parse Apply Intel').first().json.dossier.company) || $('Prepare Apply Research').first().json.company || 'unknown'), JSON.stringify($('Parse Apply Intel').first().json.dossier || {}), String((($('Parse Apply Intel').first().json.dossier||{}).health_score) || '') ] }}",
    col(7, 160)));
  wf.nodes.push(codeNode('Pass Dossier', CODE_PASS, col(8)));

  // ── ai_languageModel ──
  C['CompanyIntel Apply Model'] = { ai_languageModel: [[{ node: 'CompanyIntel Apply', type: 'ai_languageModel', index: 0 }]] };

  // ── rewire gate: Build Pass1 Context entry -> Read Intel Cache (Apply) (keep CoverForge) ──
  const retarget = (srcName, branchIdx) => {
    const arr = ((C[srcName] || {}).main || [])[branchIdx] || [];
    arr.forEach((e) => { if (e.node === 'Build Pass1 Context') e.node = 'Read Intel Cache (Apply)'; });
  };
  retarget('IF: Keyword Gaps?', 1);
  retarget('Send Gap Warning', 0);

  // ── dossier branch wiring ──
  C['Read Intel Cache (Apply)'] = { main: [[{ node: 'IF: Dossier Fresh?', type: 'main', index: 0 }]] };
  C['IF: Dossier Fresh?'] = { main: [
    [{ node: 'Pass Dossier', type: 'main', index: 0 }],                  // true: fresh
    [{ node: 'Prepare Apply Research', type: 'main', index: 0 }],        // false: cold
  ] };
  C['Prepare Apply Research'] = { main: [[{ node: 'Apply Research Fetch', type: 'main', index: 0 }]] };
  C['Apply Research Fetch'] = { main: [[{ node: 'Normalize Apply Research', type: 'main', index: 0 }]] };
  C['Normalize Apply Research'] = { main: [[{ node: 'CompanyIntel Apply', type: 'main', index: 0 }]] };
  C['CompanyIntel Apply'] = { main: [[{ node: 'Parse Apply Intel', type: 'main', index: 0 }]] };
  C['Parse Apply Intel'] = { main: [[{ node: 'Save Intel Cache (Apply)', type: 'main', index: 0 }]] };
  C['Save Intel Cache (Apply)'] = { main: [[{ node: 'Pass Dossier', type: 'main', index: 0 }]] };
  C['Pass Dossier'] = { main: [[{ node: 'Build Pass1 Context', type: 'main', index: 0 }]] };

  // ── integrity ──
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S6b-3 research-on-apply wired (${wf.nodes.length} nodes)`);
}

TARGETS.forEach(patch);
console.log('S6b-3 patch complete.');
