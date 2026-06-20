/**
 * s13_wire_matcher.js — Sprint 6: wire the matcher into the find pipeline.
 *
 *   IF: Resume Available?[true] -> Build Matcher Request -> Matcher Match (HTTP)
 *       -> Parse Scorer Output (repurposed) -> (Load Telegraph Token + Record Matches)
 *
 *  - ADD Build Matcher Request (Code) + Matcher Match (HTTP to matcher-service:5680).
 *  - REPURPOSE Parse Scorer Output jsCode -> parse matcher output into `scored`
 *    (name kept so Record Matches + Build Telegraph Body refs stay valid).
 *  - REPLACE Build Telegraph Body jsCode -> JobRight display (match% + skills + freshness).
 *  - REMOVE JobScorer (chainLlm) + its OpenRouter model feeder.
 * Writes all 3 masters. Run: node scripts/s13_wire_matcher.js
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

const BMR = fs.readFileSync(path.join(__dirname, 'nodes', 'build_matcher_request.js'), 'utf8');
const PARSE = fs.readFileSync(path.join(__dirname, 'nodes', 'parse_matcher_output.js'), 'utf8');
const TELEGRAPH = fs.readFileSync(path.join(__dirname, 'nodes', 'build_telegraph_body.js'), 'utf8');
for (const [n, c] of [['build_matcher_request', BMR], ['parse_matcher_output', PARSE], ['build_telegraph_body', TELEGRAPH]]) {
  try { new Function('$input', '$', '$getWorkflowStaticData', c); } catch (e) { console.error('PARSE FAIL ' + n + ': ' + e.message); process.exit(1); }
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + file); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);

  if (!N['JobScorer'] && N['Build Matcher Request']) { console.log('  ' + base + ': already wired — skipping'); return; }

  const js = N['JobScorer'];
  const [jx, jy] = (js && js.position) || [0, 0];

  // 1) repurpose Parse Scorer Output + Build Telegraph Body
  if (N['Parse Scorer Output']) N['Parse Scorer Output'].parameters.jsCode = PARSE;
  if (N['Build Telegraph Body']) N['Build Telegraph Body'].parameters.jsCode = TELEGRAPH;

  // 2) new nodes
  if (!N['Build Matcher Request']) {
    wf.nodes.push({ parameters: { jsCode: BMR }, id: crypto.randomUUID(), name: 'Build Matcher Request', type: 'n8n-nodes-base.code', typeVersion: 2, position: [jx, jy] });
  } else { N['Build Matcher Request'].parameters.jsCode = BMR; }
  if (!N['Matcher Match']) {
    wf.nodes.push({
      parameters: { method: 'POST', url: 'http://matcher-service:5680/match', sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}', options: { timeout: 120000 } },
      id: crypto.randomUUID(), name: 'Matcher Match', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [jx + 220, jy], onError: 'continueRegularOutput',
    });
  }

  // 3) rewire: IF: Resume Available?[0] -> Build Matcher Request -> Matcher Match -> Parse Scorer Output
  const ifc = C['IF: Resume Available?'];
  if (ifc && ifc.main) ifc.main[0] = [{ node: 'Build Matcher Request', type: 'main', index: 0 }];
  C['Build Matcher Request'] = { main: [[{ node: 'Matcher Match', type: 'main', index: 0 }]] };
  C['Matcher Match'] = { main: [[{ node: 'Parse Scorer Output', type: 'main', index: 0 }]] };

  // 4) remove JobScorer + every sub-node (model, output parser, memory, ...) that
  // feeds ONLY JobScorer via any ai_* connection type.
  const removeNodeNames = new Set(['JobScorer']);
  for (const [src, obj] of Object.entries(C)) {
    let touched = false;
    for (const [connType, branches] of Object.entries(obj)) {
      if (connType === 'main') continue;
      if ((branches || []).some((br) => (br || []).some((e) => e.node === 'JobScorer'))) {
        touched = true;
        obj[connType] = (branches || []).map((br) => (br || []).filter((e) => e.node !== 'JobScorer'));
      }
    }
    if (touched) {
      const anyLeft = Object.values(obj).some((branches) => (branches || []).some((br) => (br || []).length));
      if (!anyLeft) removeNodeNames.add(src);
    }
  }
  delete C['JobScorer'];
  for (const nm of removeNodeNames) { if (nm !== 'JobScorer') delete C[nm]; }
  wf.nodes = wf.nodes.filter((n) => !removeNodeNames.has(n.name));

  // integrity
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    if (!names.has(src)) { console.error('INTEGRITY FAIL: connection source missing ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => { if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); } }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': matcher wired (' + wf.nodes.length + ' nodes; removed [' + [...removeNodeNames].join(', ') + '])');
}

TARGETS.forEach(patch);
console.log('S13 patch complete.');
