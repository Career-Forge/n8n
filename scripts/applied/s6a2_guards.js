/**
 * s6a2_guards.js — S6a (part 2): integrity guards so a blank/broken PDF never ships.
 *
 * Two failure modes the render fix (s6a) did NOT cover:
 *  A) ResumeForge returns valid JSON but empty/near-empty sections -> Build Resume
 *     LaTeX makes a near-blank-but-valid doc -> compiles 200 -> user gets a blank
 *     resume. Caught by a new "Validate Resume Sections" code node BEFORE build.
 *  B) LaTeX has a syntax error -> latex-service returns 400/500/504. Today both
 *     Compile nodes are onError=continueRegularOutput, which swallows the HTTP
 *     error and ships whatever's there. Flip them to continueErrorOutput and route
 *     the error branch to a user-facing message.
 *
 * Both compile error branches + the validate error branch fan into one new
 * "Send Apply Build Error" Telegram node (chatId from Prepare Apply Context,
 * matching the success senders).
 *
 * NOT doing the planned "require type on items" parser-schema tightening: the
 * runtime guard is strictly more robust, and over-constraining the structured
 * output schema is what reintroduced the S2b parse failure. Skipped on purpose.
 *
 * Run: node scripts/s6a2_guards.js
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

const VALIDATE_CODE =
`// S6a-2: content guard — never build/ship a blank resume.
const rj = ($input.first().json && $input.first().json.output) || $input.first().json || {};
const sections = Array.isArray(rj.sections) ? rj.sections : [];
function itemCount(s) {
  const it = (s && Array.isArray(s.items)) ? s.items : [];
  return it.filter(x => x && (typeof x !== 'string' || x.trim().length > 0)).length;
}
const total = sections.reduce((n, s) => n + itemCount(s), 0);
const named = sections.filter(s => s && typeof s.heading === 'string' && s.heading.trim().length > 0).length;
if (sections.length === 0 || total < 2 || named === 0) {
  throw new Error('Resume generation produced empty/incomplete sections (sections=' + sections.length + ', items=' + total + '). Refusing to compile a blank resume.');
}
return $input.all();`;

const ERROR_TEXT =
  '❌ Could not build your application this time — the resume or cover came back empty or failed to compile. ' +
  'Run the apply again; if it keeps failing, re-upload your resume so I have clean source data to work from.';

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const C = wf.connections;
  const base = path.basename(file);
  let edits = 0;

  const RF = N['ResumeForge'], BRL = N['Build Resume LaTeX'];
  const CR = N['Compile Resume PDF'], CC = N['Compile Cover PDF'];
  if (!RF || !BRL || !CR || !CC) { console.log(`  (missing core nodes in ${base}) — skipping`); return; }

  // 0) shared error sender
  if (!N['Send Apply Build Error']) {
    const [cx, cy] = CR.position;
    wf.nodes.push({
      parameters: {
        chatId: "={{ $('Prepare Apply Context').first().json.chat_id }}",
        text: ERROR_TEXT,
        additionalFields: { appendAttribution: false, parse_mode: 'Markdown' },
      },
      id: crypto.randomUUID(), name: 'Send Apply Build Error',
      type: 'n8n-nodes-base.telegram', typeVersion: 1.2,
      position: [cx + 220, cy + 260],
    });
    edits++;
  }

  // 1) Validate Resume Sections node, spliced ResumeForge -> [Validate] -> Build Resume LaTeX
  if (!N['Validate Resume Sections']) {
    const [rx, ry] = RF.position, [bx, by] = BRL.position;
    wf.nodes.push({
      parameters: { jsCode: VALIDATE_CODE },
      id: crypto.randomUUID(), name: 'Validate Resume Sections',
      type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [Math.round((rx + bx) / 2), Math.round((ry + by) / 2)],
      onError: 'continueErrorOutput',
    });
    // rewire: any ResumeForge main[0] edge to Build Resume LaTeX -> Validate
    const rfMain = (C['ResumeForge'] && C['ResumeForge'].main) || [];
    let rewired = false;
    (rfMain[0] || []).forEach((e) => { if (e.node === 'Build Resume LaTeX') { e.node = 'Validate Resume Sections'; rewired = true; } });
    if (!rewired) console.log(`  WARN ${base}: ResumeForge->Build Resume LaTeX edge not found`);
    C['Validate Resume Sections'] = { main: [
      [{ node: 'Build Resume LaTeX', type: 'main', index: 0 }],
      [{ node: 'Send Apply Build Error', type: 'main', index: 0 }],
    ] };
    edits++;
  }

  // 2) flip Compile Resume PDF -> continueErrorOutput + error branch
  if (CR.onError !== 'continueErrorOutput') {
    CR.onError = 'continueErrorOutput';
    const m = (C['Compile Resume PDF'] && C['Compile Resume PDF'].main) || [[]];
    C['Compile Resume PDF'] = { main: [ m[0] || [], [{ node: 'Send Apply Build Error', type: 'main', index: 0 }] ] };
    edits++;
  }

  // 3) flip Compile Cover PDF -> continueErrorOutput + error branch
  if (CC.onError !== 'continueErrorOutput') {
    CC.onError = 'continueErrorOutput';
    const m = (C['Compile Cover PDF'] && C['Compile Cover PDF'].main) || [[]];
    C['Compile Cover PDF'] = { main: [ m[0] || [], [{ node: 'Send Apply Build Error', type: 'main', index: 0 }] ] };
    edits++;
  }

  // sanity: validate code parses + connection integrity
  try { new Function(VALIDATE_CODE); } catch (e) { console.error(`PARSE FAIL ${base}: ${e.message}`); process.exit(1); }
  const names = new Set(wf.nodes.map(n => n.name));
  for (const [src, obj] of Object.entries(C)) {
    (obj.main || []).forEach(a => (a || []).forEach(e => { if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${src} -> ${e.node}`); process.exit(1); } }));
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S6a-2 guards applied (${edits} edits, ${wf.nodes.length} nodes)`);
}

TARGETS.forEach(patch);
console.log('S6a-2 patch complete.');
