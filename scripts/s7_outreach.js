/**
 * s7_outreach.js — S7: sync full outreach prompts + ToS-safe hook lane.
 *
 * 1) Replace the truncated in-node ContactFinder (520 chars) and OutreachWriter
 *    (373 chars) prompts with the full prompts/ContactFinder.md (9 rules) +
 *    prompts/OutreachWriter.md (8 rules incl. location-aware CTAs + hook_sources).
 *    The output parsers + Format nodes already match the full output shapes.
 * 2) Insert a hook-search lane on the draft path so OutreachWriter can cite a REAL
 *    public hook (GitHub / talks / eng blogs / papers — NO LinkedIn login-scrape,
 *    no bulk social targeting):
 *      IF: Contact Found?(true) -> Build Hook Query -> Hook Search Fetch (Serper)
 *        -> Normalize Hooks -> OutreachWriter
 *    Normalize Hooks merges the draft context + hook_sources, so OutreachWriter's
 *    JSON input gains hook_sources (+ candidate_role, contact_location). Graceful:
 *    a failed search yields hook_sources: [] and the prompt falls back to a JD fact.
 * Run: node scripts/s7_outreach.js
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

const readNode = (f) => fs.readFileSync(path.join(__dirname, 'nodes', f), 'utf8');
const readPrompt = (f) => fs.readFileSync(path.join(ROOT, 'prompts', f), 'utf8').replace(/\r\n/g, '\n');
const PROMPT_CONTACT = readPrompt('ContactFinder.md');
const PROMPT_OUTREACH = readPrompt('OutreachWriter.md');
const CODE_HOOKQ = readNode('build_hook_query.js');
const CODE_NORMHOOKS = readNode('normalize_hooks.js');

for (const [nm, code] of Object.entries({ CODE_HOOKQ, CODE_NORMHOOKS })) {
  try { new Function('$input', '$', code); } catch (e) { console.error(`PARSE FAIL ${nm}: ${e.message}`); process.exit(1); }
}

const codeNode = (name, code, pos) => ({ parameters: { jsCode: code }, id: crypto.randomUUID(), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos });

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);
  let edits = 0;

  // 1) sync prompts
  if (N['ContactFinder']) { const mv = N['ContactFinder'].parameters.messages.messageValues[0]; if (mv.message !== PROMPT_CONTACT) { mv.message = PROMPT_CONTACT; edits++; } }
  if (N['OutreachWriter']) { const mv = N['OutreachWriter'].parameters.messages.messageValues[0]; if (mv.message !== PROMPT_OUTREACH) { mv.message = PROMPT_OUTREACH; edits++; } }

  // 2) hook lane
  if (!N['Build Hook Query']) {
    const ow = N['OutreachWriter'];
    let [ox, oy] = (ow && ow.position) || [0, 0]; ox -= 720;
    wf.nodes.push(codeNode('Build Hook Query', CODE_HOOKQ, [ox, oy]));
    wf.nodes.push({
      parameters: {
        method: 'POST', url: 'https://google.serper.dev/search', sendHeaders: true,
        headerParameters: { parameters: [{ name: 'X-API-KEY', value: '={{ $env.SERPER_API_KEY || "" }}' }, { name: 'Content-Type', value: 'application/json' }] },
        sendBody: true, specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ q: $('Build Hook Query').first().json.hook_query, num: 8 }) }}",
        options: { response: { response: { neverError: true } }, timeout: 15000 },
      }, id: crypto.randomUUID(), name: 'Hook Search Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [ox + 230, oy], onError: 'continueRegularOutput', alwaysOutputData: true,
    });
    wf.nodes.push(codeNode('Normalize Hooks', CODE_NORMHOOKS, [ox + 460, oy]));

    // retarget the edge(s) that currently point to OutreachWriter -> Build Hook Query
    let rewired = 0;
    for (const obj of Object.values(C)) {
      (obj.main || []).forEach((branch) => (branch || []).forEach((e) => { if (e.node === 'OutreachWriter') { e.node = 'Build Hook Query'; rewired++; } }));
    }
    if (!rewired) console.log(`  WARN ${base}: no edge into OutreachWriter found to rewire`);
    C['Build Hook Query'] = { main: [[{ node: 'Hook Search Fetch', type: 'main', index: 0 }]] };
    C['Hook Search Fetch'] = { main: [[{ node: 'Normalize Hooks', type: 'main', index: 0 }]] };
    C['Normalize Hooks'] = { main: [[{ node: 'OutreachWriter', type: 'main', index: 0 }]] };
    edits++;
  }

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
  console.log(`OK ${base}: S7 applied (${edits} edits, ${wf.nodes.length} nodes)`);
}

TARGETS.forEach(patch);
console.log('S7 patch complete.');
