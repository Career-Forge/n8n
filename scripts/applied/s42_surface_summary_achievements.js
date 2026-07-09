/**
 * s42_surface_summary_achievements.js -- v7 sprint, part 1: fix two real data
 * bugs in Parse Personal Info found during the tier-plan exploration.
 *
 * The master resume schema has ALWAYS carried `summary_bullets[]` (max 12)
 * and `achievements[]` (max 30, e.g. hackathon wins) -- Ingest Resume JSON
 * ingests and stores both. And the render side has ALWAYS had `summary` and
 * `achievements` section templates in SECTION_LATEX. But the bridge between
 * them -- Parse Personal Info's linesFromBubbles(), the path that always runs
 * since Ingest always sets kind:'resume_bubbles' -- never emits either field
 * into the resume text Pass1 reads. So generated resumes could never have a
 * summary or accomplishments section no matter what the prompts said: the
 * LLM literally never saw the data.
 *
 * Fix: emit `## SUMMARY` and `## ACHIEVEMENTS` blocks (early, so they survive
 * the output cap), and raise that cap 7000 -> 9000 so the new sections can't
 * push `## EDUCATION` off the end. Parity: linesFromStructured already emits
 * summary_bullets but not achievements -- add achievements there too.
 *
 * Downstream visibility is automatic: Build Pass1 Context's masterResume =
 * c.resume_text, which is exactly this function's output.
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const NODE_NAME = 'Parse Personal Info';

// ── 1. linesFromBubbles: insert SUMMARY + ACHIEVEMENTS after the personal block ──
const BUBBLES_ANCHOR_OLD =
  "  out.push('location: ' + loc);\n" +
  "  out.push('');\n" +
  "  const compact = r.compact_views?.generation_base || r.compact_views?.scoring_profile || '';";

const BUBBLES_ANCHOR_NEW =
  "  out.push('location: ' + loc);\n" +
  "  out.push('');\n" +
  "  if (Array.isArray(r.summary_bullets) && r.summary_bullets.length) {\n" +
  "    out.push('## SUMMARY');\n" +
  "    r.summary_bullets.slice(0, 12).forEach(b => out.push('- ' + b));\n" +
  "    out.push('');\n" +
  "  }\n" +
  "  if (Array.isArray(r.achievements) && r.achievements.length) {\n" +
  "    out.push('## ACHIEVEMENTS');\n" +
  "    r.achievements.slice(0, 12).forEach(a => out.push('- ' + a));\n" +
  "    out.push('');\n" +
  "  }\n" +
  "  const compact = r.compact_views?.generation_base || r.compact_views?.scoring_profile || '';";

// ── 2. raise the bubbles-path output cap so EDUCATION survives the new sections ──
const CAP_OLD = "return out.join('\\n').trim().slice(0, 7000);";
const CAP_NEW = "return out.join('\\n').trim().slice(0, 9000);";

// ── 3. linesFromStructured parity: achievements after its existing summary block ──
// (its summary block uses bare forEach -- distinct from the new bubbles-path
// slice(0, 12) insertion, so this anchor stays unique after edit 1)
const STRUCTURED_ANCHOR_OLD =
  "  if (Array.isArray(r.summary_bullets) && r.summary_bullets.length) {\n" +
  "    out.push('## SUMMARY');\n" +
  "    r.summary_bullets.forEach(b => out.push('- ' + b));\n" +
  "    out.push('');\n" +
  "  }\n" +
  "  out.push('## EXPERIENCES');";

const STRUCTURED_ANCHOR_NEW =
  "  if (Array.isArray(r.summary_bullets) && r.summary_bullets.length) {\n" +
  "    out.push('## SUMMARY');\n" +
  "    r.summary_bullets.forEach(b => out.push('- ' + b));\n" +
  "    out.push('');\n" +
  "  }\n" +
  "  if (Array.isArray(r.achievements) && r.achievements.length) {\n" +
  "    out.push('## ACHIEVEMENTS');\n" +
  "    r.achievements.slice(0, 12).forEach(a => out.push('- ' + a));\n" +
  "    out.push('');\n" +
  "  }\n" +
  "  out.push('## EXPERIENCES');";

const EDITS = [
  ['linesFromBubbles summary+achievements', BUBBLES_ANCHOR_OLD, BUBBLES_ANCHOR_NEW],
  ['output cap 7000->9000', CAP_OLD, CAP_NEW],
  ['linesFromStructured achievements parity', STRUCTURED_ANCHOR_OLD, STRUCTURED_ANCHOR_NEW],
];

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const n = wf.nodes.find((x) => x.name === NODE_NAME);
  if (!n) { console.error(`INTEGRITY FAIL ${base}: node "${NODE_NAME}" not found`); process.exit(1); }
  let code = n.parameters.jsCode;

  if (code.includes('## ACHIEVEMENTS')) { console.log(`  ${base}: already patched`); return; }

  for (const [label, oldStr, newStr] of EDITS) {
    const count = code.split(oldStr).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor for "${label}" found ${count} times, expected exactly 1`); process.exit(1); }
    code = code.replace(oldStr, newStr);
  }
  n.parameters.jsCode = code;
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: ${EDITS.length} edits applied to ${NODE_NAME}`);
}

// ── harness ──
(function harness() {
  // Extract the patched linesFromBubbles by applying the edits to a synthetic
  // function assembled from the REAL anchor strings, then behaviorally prove it.
  // Rather than re-type the whole function, run the real one: pull it from the
  // first target file, apply the edits in memory, eval, and test.
  const file = TARGETS.find((f) => fs.existsSync(f));
  if (!file) { console.error('HARNESS FAIL: no target file found to source the real function'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const n = wf.nodes.find((x) => x.name === NODE_NAME);
  let code = n.parameters.jsCode;
  const already = code.includes('## ACHIEVEMENTS');
  if (!already) {
    for (const [label, oldStr, newStr] of EDITS) {
      const count = code.split(oldStr).length - 1;
      if (count !== 1) { console.error(`HARNESS FAIL: anchor for "${label}" found ${count} times in live code, expected 1`); process.exit(1); }
      code = code.replace(oldStr, newStr);
    }
  }

  // isolate linesFromBubbles + its helpers (firstPrimary, locToString, flatSkills)
  function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) throw new Error('fn not found: ' + name);
    let depth = 0, i = src.indexOf('{', start), j = i;
    for (;;) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      if (depth === 0) break;
      j++;
    }
    return src.slice(start, j + 1);
  }
  const fnSrc = ['clean', 'firstPrimary', 'locToString', 'flatSkills', 'linesFromBubbles', 'linesFromStructured']
    .map((f) => extractFn(code, f)).join('\n');
  const { linesFromBubbles, linesFromStructured } = new Function(fnSrc + '\nreturn { linesFromBubbles, linesFromStructured };')();

  // Fixture: summary + achievements + 8 dense experiences to stress the cap.
  const denseFixture = {
    personal: { name: 'Test User', emails: [{ address: 't@x.com', primary: true }], phones: [{ number: '555', primary: true }], locations: [], links: {} },
    summary_bullets: ['AI engineer with production LLM deployments', '4x hackathon winner', 'Public speaker on agentic systems'],
    achievements: ['Winner, Pulse NYC Hackathon (Jan 2026)', 'n8n Sponsor Prize, ElevenLabs Global Hackathon (Nov 2025)'],
    skills: { programming: ['Python'], ai_ml: ['PyTorch'] },
    experience: Array.from({ length: 8 }, (_, i) => ({
      title: 'Role ' + i, company: 'Company ' + i, start_date: 'Jan 202' + (i % 10), end_date: 'Dec 202' + (i % 10),
      bullets: Array.from({ length: 6 }, (_, k) => 'Did a substantial thing number ' + k + ' with measurable impact and a long descriptive sentence to consume characters in the output budget for stress testing purposes'),
    })),
    projects: [{ name: 'Proj', bullets: ['Built a thing'] }],
    education: [{ institution: 'NJIT', degree: 'MS', field: 'Data Science' }],
    compact_views: {},
  };
  const out = linesFromBubbles(denseFixture);
  if (!out.includes('## SUMMARY')) { console.error('HARNESS FAIL: ## SUMMARY missing from bubbles output'); process.exit(1); }
  if (!out.includes('## ACHIEVEMENTS')) { console.error('HARNESS FAIL: ## ACHIEVEMENTS missing from bubbles output'); process.exit(1); }
  if (!out.includes('Winner, Pulse NYC Hackathon')) { console.error('HARNESS FAIL: achievement content missing'); process.exit(1); }
  if (out.indexOf('## SUMMARY') > out.indexOf('## EXPERIENCE BUBBLES')) { console.error('HARNESS FAIL: SUMMARY must precede EXPERIENCE BUBBLES'); process.exit(1); }
  if (out.indexOf('## ACHIEVEMENTS') > out.indexOf('## EXPERIENCE BUBBLES')) { console.error('HARNESS FAIL: ACHIEVEMENTS must precede EXPERIENCE BUBBLES'); process.exit(1); }
  if (!out.includes('## EDUCATION') || !out.includes('NJIT')) { console.error('HARNESS FAIL: EDUCATION section fell off the output cap -- 9000 not enough for dense fixture'); process.exit(1); }
  if (out.length > 9000) { console.error('HARNESS FAIL: output exceeds 9000 cap:', out.length); process.exit(1); }

  // Fixture without the fields: headings absent, personal fields intact.
  const sparseFixture = { ...denseFixture, summary_bullets: [], achievements: undefined };
  const out2 = linesFromBubbles(sparseFixture);
  if (out2.includes('## SUMMARY') || out2.includes('## ACHIEVEMENTS')) { console.error('HARNESS FAIL: headings must be absent when fields are empty'); process.exit(1); }
  if (!out2.includes('name: Test User')) { console.error('HARNESS FAIL: personal fields regressed'); process.exit(1); }

  // linesFromStructured parity: achievements now emitted there too.
  const structuredFixture = {
    personal: { name: 'S User' },
    summary_bullets: ['A summary line'],
    achievements: ['An achievement'],
    experience: [], projects: [], education: [], skills: {},
  };
  const out3 = linesFromStructured(structuredFixture);
  if (!out3.includes('## ACHIEVEMENTS') || !out3.includes('An achievement')) { console.error('HARNESS FAIL: structured-path achievements parity missing'); process.exit(1); }

  console.log('HARNESS OK: patched linesFromBubbles emits ## SUMMARY + ## ACHIEVEMENTS early (before EXPERIENCE BUBBLES), EDUCATION survives the 9000 cap on a dense 8x6-bullet fixture, empty fields emit no headings, personal fields intact, structured-path parity confirmed -- all proven by eval of the ACTUAL patched code');
})();

TARGETS.forEach(patch);
console.log('S42 (surface summary_bullets + achievements to Pass1) complete.');
