/**
 * r1_scorer_sync.js — R1: sync JobScorer to the full prompts/JobScorer.md source
 * and add work_authorization to Build Scorer Input's resume summary (P1-#9).
 *
 * Patches BOTH workflows/CareerForge_Master_local.json and
 * docker/workflows/CareerForge_Master_local.json in place (localize_v63 pattern).
 *
 * Run:  node scripts/r1_scorer_sync.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
];

// ── Build the new JobScorer message ────────────────────────────────────────
const mdRaw = fs.readFileSync(path.join(ROOT, 'prompts', 'JobScorer.md'), 'utf8');
// Strip the "# JobScorer" doc title; keep everything else verbatim.
const mdBody = mdRaw.replace(/^# JobScorer\s*\n/, '').trim();

const PREAMBLE =
  'CRITICAL: Respond with raw JSON only. Start your response with { — no preamble, no markdown fences, no commentary.\n\n';

// Workflow-contract block preserved verbatim from the current stub (scoring
// priorities interpolation evaluated by n8n at runtime).
const PRIORITIES_BLOCK =
  "\n\nUser's scoring priorities for this search (weight these highly):\n" +
  "{{ $('Parse Expand Query').first().json.scoring_priorities?.length > 0 ? $('Parse Expand Query').first().json.scoring_priorities.join(', ') : 'General fit' }}";

const NEW_MESSAGE = PREAMBLE + mdBody + PRIORITIES_BLOCK;

// ── Build Scorer Input insertion ───────────────────────────────────────────
const ANCHOR =
  "if (email || loc) parts.push('CONTACT CONTEXT: ' + [email, loc].filter(Boolean).join(' | '));";
const WA_LINES =
  ANCHOR +
  "\n  const wa = p.work_authorization;\n" +
  "  if (wa) parts.push('WORK AUTHORIZATION: ' + (typeof wa === 'object' ? Object.entries(wa).map(([k, v]) => k + ': ' + v).join(' | ') : String(wa)));";

for (const file of TARGETS) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  // 1) JobScorer prompt
  const js = N['JobScorer'];
  if (!js) throw new Error(`JobScorer node missing in ${file}`);
  const mv = js.parameters.messages.messageValues;
  if (!mv || mv.length !== 1) throw new Error(`Unexpected messageValues shape in ${file}`);
  const before = mv[0].message.length;
  mv[0].message = NEW_MESSAGE;

  // 2) Build Scorer Input work_authorization
  const bsi = N['Build Scorer Input'];
  if (!bsi) throw new Error(`Build Scorer Input node missing in ${file}`);
  const code = bsi.parameters.jsCode;
  if (code.includes('WORK AUTHORIZATION')) {
    console.log(`${path.basename(path.dirname(file))}/${path.basename(file)}: work_authorization already present, skipping insert`);
  } else {
    if (!code.includes(ANCHOR)) throw new Error(`Anchor line not found in Build Scorer Input (${file})`);
    bsi.parameters.jsCode = code.replace(ANCHOR, WA_LINES);
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`${file}: JobScorer message ${before} -> ${mv[0].message.length} chars; work_authorization wired.`);
}
console.log('R1 patch complete.');
