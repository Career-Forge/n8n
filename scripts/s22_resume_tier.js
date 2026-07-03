/**
 * s22_resume_tier.js -- F3 (Roadmap v4): resume tier fix + dead skeleton plumbing removal.
 *
 * Design verdict (checked against careerforge-command-center, the original
 * implementation this engine was ported from): the original has NO separate
 * seniority classifier and NO seniority-based LaTeX skeletons -- Pass1
 * self-classifies fresher/junior/mid/senior directly, and the template axis is
 * compact-vs-normal (user-chosen, unrelated to seniority). The n8n port added
 * SeniorityDetector + 3 near-identical skeleton files. S16 already collapsed
 * the 3 skeletons to one shared renderer (correct call -- they were byte-
 * identical except cosmetics). SeniorityDetector is worth KEEPING though: it
 * has title-override logic (Staff/Principal/Director/VP/Head-of/Chief) Pass1's
 * own rules lack, runs on cheap deepseek-v4-flash ahead of the expensive Kimi
 * Pass1 call, and also computes fit_strategy/candidate_yoe/jd_required_min/
 * jd_required_max/jd_seniority -- a completely separate, independently-used
 * mechanism (Detect Revise Type / IF: Mismatch? / ReviseForge / Save Apply
 * Context) that this script does NOT touch.
 *
 * The actual bug: SeniorityDetector outputs a 3-bucket mode (fresher/
 * experienced/senior) that Build Pass1 Context collapses via
 * tierMap={experienced:'mid'} -- unconditionally. Pass1's own prompt defines
 * FOUR tiers (fresher/junior/mid/senior) with different section orders and
 * space allocations, so "junior" is permanently unreachable: every 2-10-year
 * candidate gets the "mid" layout forced on them via an authoritative prompt
 * hint ("Detected tier: mid... use this tier unless the resume clearly
 * contradicts it"), even a candidate with 2 years and one job who Pass1's own
 * rules would call junior (education-first, lighter experience emphasis).
 *
 * Fix, in order:
 * 1. SeniorityDetector -- 4-bucket taxonomy matching Pass1's own thresholds,
 *    plus TA/RA exclusion and a richer title-override list (Manager/Lead-when-
 *    people-managing/Fellow/Distinguished), ported from the prompts/
 *    SeniorityDetector.md reference (confirmed drifted from the live node --
 *    a separate F4 cleanup item, but these two additions are cheap and
 *    directly relevant here so they're folded in now). fit_strategy/
 *    candidate_yoe/jd_required_min/jd_required_max/jd_seniority sections left
 *    byte-for-byte untouched.
 * 2. Seniority Output Parser -- mode enum updated to the 4 values.
 * 3. Build Pass1 Context -- tierMap becomes identity passthrough
 *    ({fresher,junior,mid,senior}), plus experienced->mid for backward compat
 *    with any pre-F3 static data still carrying the old 3-bucket value.
 * 4. Load Skeletons -- strips the SKELETONS map + resumeSkeleton selection +
 *    resume_skeleton output field (confirmed zero consumers: Assemble Resume
 *    LaTeX / Assemble Regen / Build Revised LaTeX all use their own shared
 *    SKELETON constant since S16). Keeps the cover skeleton (Build Cover LaTeX
 *    genuinely reads ctx.cover_skeleton -- there's only ever been one cover
 *    template, this was never part of the seniority-skeleton problem),
 *    seniority_mode, total_years_experience, and the fit_strategy/
 *    candidate_yoe/jd_* passthrough fields, all untouched.
 * 5. Deletes the 3 now-fully-unused resume skeleton .tex files (git preserves
 *    history). cover_skeleton.tex is untouched.
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
const SKELETON_FILES_TO_DELETE = [
  path.join(ROOT, 'templates', 'resume_skeleton_fresher.tex'),
  path.join(ROOT, 'templates', 'resume_skeleton_experienced.tex'),
  path.join(ROOT, 'templates', 'resume_skeleton_senior.tex'),
];

// ═══════════════════════════════════════════════════════════════
// 1. SeniorityDetector -- 4-bucket taxonomy + TA/RA + richer title override
// ═══════════════════════════════════════════════════════════════

const SD_HEADER_OLD = `You are CareerForge's seniority classifier. Read the master resume and classify into one of three modes.

Rules:
- fresher: <2 years professional experience OR current student OR graduated <12 months ago.
- experienced: 2-10 years
- senior: 10+ years OR current title includes Staff, Principal, Director, VP, Head of, Chief

Output:
{ "mode": "fresher | experienced | senior", "total_years_experience": 4, "reasoning": "1 sentence" }`;

const SD_HEADER_NEW = `You are CareerForge's seniority classifier. Read the master resume and classify into one of four modes.

Rules:
- fresher: 0 years professional experience OR current student OR graduated <12 months ago.
- junior: 1-3 years professional experience.
- mid: 4-9 years professional experience.
- senior: 10+ years OR current title includes Staff, Principal, Director, VP, Head of, Chief, Manager, Lead (when it implies people management, not a tech lead), Fellow, Distinguished.
- Teaching Assistant / Research Assistant / Grader roles at a university do NOT count toward professional experience.

Output:
{ "mode": "fresher | junior | mid | senior", "total_years_experience": 4, "reasoning": "1 sentence" }`;

const SD_TRAILER_OLD = `Include all these fields in your JSON output alongside the existing seniority and skeleton fields.`;
const SD_TRAILER_NEW = `Include all these fields in your JSON output alongside the existing seniority fields.`;

// ═══════════════════════════════════════════════════════════════
// 2. Seniority Output Parser -- mode enum
// ═══════════════════════════════════════════════════════════════

const SOP_OLD = `"mode": {"type": "string", "enum": ["fresher", "experienced", "senior"]}`;
const SOP_NEW = `"mode": {"type": "string", "enum": ["fresher", "junior", "mid", "senior"]}`;

// ═══════════════════════════════════════════════════════════════
// 3. Build Pass1 Context -- identity tierMap
// ═══════════════════════════════════════════════════════════════

const BP1_OLD = `const tierMap = { fresher: 'fresher', experienced: 'mid', senior: 'senior' };`;
const BP1_NEW = `// F3: identity passthrough -- SeniorityDetector now outputs the same 4-bucket
// taxonomy Pass1 uses. 'experienced' kept only as a fallback for pre-F3 static
// data; the old map collapsed it into 'mid' unconditionally, making Pass1's
// own 'junior' tier unreachable.
const tierMap = { fresher: 'fresher', junior: 'junior', mid: 'mid', senior: 'senior', experienced: 'mid' };`;

// ═══════════════════════════════════════════════════════════════
// 4. Load Skeletons -- strip dead SKELETONS/resumeSkeleton plumbing
// ═══════════════════════════════════════════════════════════════

const LS_DEFAULT_OLD = `const seniorityOutput = $input.first().json.output || { mode: 'experienced' };
const mode = seniorityOutput.mode || 'experienced';`;
const LS_DEFAULT_NEW = `const seniorityOutput = $input.first().json.output || { mode: 'mid' };
const mode = seniorityOutput.mode || 'mid';`;

// The SKELETONS blob is a JSON.stringify'd object whose VALUES are raw LaTeX
// source -- full of literal { and } from LaTeX braces. A non-greedy regex
// spanning the blob risks stopping at a false "};" match inside the escaped
// text, so this is anchored with plain indexOf against a short, code-only
// suffix ("};\nconst COVER = ") instead of a regex over the blob's contents.
const SKEL_START = 'const SKELETONS = {';
const SKEL_END_ANCHOR = '};\nconst COVER = ';
const RESUME_SKEL_LINE = "const resumeSkeleton = SKELETONS[mode] || SKELETONS.experienced || '';\n";

const LS_RETURN_OLD = `  resume_skeleton: resumeSkeleton,
  cover_skeleton: coverSkeleton,`;
const LS_RETURN_NEW = `  cover_skeleton: coverSkeleton,`;

// Shared by patch() and the harness, so the harness exercises the exact same
// code path that runs against the real deployed node -- not a parallel copy
// that could silently drift out of sync.
function transformLoadSkeletons(codeIn, base) {
  let code = codeIn;
  let edits = 0;

  if (code.indexOf(LS_DEFAULT_NEW) === -1) {
    if (code.indexOf(LS_DEFAULT_OLD) === -1) { console.error(`INTEGRITY FAIL ${base}: Load Skeletons default-mode anchor not found`); process.exit(1); }
    code = code.split(LS_DEFAULT_OLD).join(LS_DEFAULT_NEW);
    edits++;
  }

  const skelStartIdx = code.indexOf(SKEL_START);
  if (skelStartIdx !== -1) {
    const skelEndIdx = code.indexOf(SKEL_END_ANCHOR, skelStartIdx);
    if (skelEndIdx === -1) { console.error(`INTEGRITY FAIL ${base}: Load Skeletons -- found SKELETONS start but not the COVER-adjacent end anchor`); process.exit(1); }
    const removeEnd = skelEndIdx + '};\n'.length; // keep "const COVER = " itself, which starts right after
    code = code.slice(0, skelStartIdx) + code.slice(removeEnd);
    edits++;
  } else if (code.indexOf('SKELETONS') !== -1) {
    console.error(`INTEGRITY FAIL ${base}: Load Skeletons -- SKELETONS referenced but declaration start anchor not found`);
    process.exit(1);
  } // else: already patched, SKELETONS declaration absent -- fine.

  if (code.indexOf(RESUME_SKEL_LINE) !== -1) {
    code = code.split(RESUME_SKEL_LINE).join('');
    edits++;
  } else if (code.indexOf('resumeSkeleton') !== -1) {
    console.error(`INTEGRITY FAIL ${base}: Load Skeletons -- resumeSkeleton referenced but declaration line anchor not found`);
    process.exit(1);
  }

  if (code.indexOf(LS_RETURN_NEW) === -1 || code.indexOf('resume_skeleton: resumeSkeleton') !== -1) {
    if (code.indexOf(LS_RETURN_OLD) === -1) { console.error(`INTEGRITY FAIL ${base}: Load Skeletons return-object anchor not found`); process.exit(1); }
    code = code.split(LS_RETURN_OLD).join(LS_RETURN_NEW);
    edits++;
  }

  return { code, edits };
}

function replaceExact(node, base, label, oldStr, newStr, getField, setField) {
  const cur = getField(node);
  if (typeof cur !== 'string') {
    console.error(`INTEGRITY FAIL ${base}: ${label} (node "${node && node.name}") -- getField() returned ${typeof cur}, expected string.`);
    process.exit(1);
  }
  if (cur === newStr) return false;
  if (cur.indexOf(oldStr) === -1) {
    console.error(`INTEGRITY FAIL ${base}: ${label} (node "${node && node.name}") does not contain expected old value.\nGot (first 300 chars): ${cur.slice(0, 300)}`);
    process.exit(1);
  }
  setField(cur.split(oldStr).join(newStr));
  return true;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of ['SeniorityDetector', 'Seniority Output Parser', 'Build Pass1 Context', 'Load Skeletons']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  // 1. SeniorityDetector
  {
    const n = N['SeniorityDetector'];
    const msgs = n.parameters.messages.messageValues;
    if (!msgs || !msgs[0]) { console.error(`INTEGRITY FAIL ${base}: SeniorityDetector message shape unexpected`); process.exit(1); }
    const get = () => msgs[0].message;
    const set = (v) => { msgs[0].message = v; };
    if (replaceExact(n, base, 'SeniorityDetector header (3-bucket->4-bucket)', SD_HEADER_OLD, SD_HEADER_NEW, get, set)) edits++;
    if (replaceExact(n, base, 'SeniorityDetector trailer', SD_TRAILER_OLD, SD_TRAILER_NEW, get, set)) edits++;
  }

  // 2. Seniority Output Parser
  {
    const n = N['Seniority Output Parser'];
    const get = () => n.parameters.inputSchema;
    const set = (v) => { n.parameters.inputSchema = v; };
    if (replaceExact(n, base, 'Seniority Output Parser mode enum', SOP_OLD, SOP_NEW, get, set)) edits++;
  }

  // 3. Build Pass1 Context
  {
    const n = N['Build Pass1 Context'];
    const get = () => n.parameters.jsCode;
    const set = (v) => { n.parameters.jsCode = v; };
    if (replaceExact(n, base, 'Build Pass1 Context tierMap', BP1_OLD, BP1_NEW, get, set)) edits++;
  }

  // 4. Load Skeletons
  {
    const n = N['Load Skeletons'];
    if (typeof n.parameters.jsCode !== 'string') { console.error(`INTEGRITY FAIL ${base}: Load Skeletons jsCode not a string`); process.exit(1); }
    const { code, edits: lsEdits } = transformLoadSkeletons(n.parameters.jsCode, base);
    n.parameters.jsCode = code;
    edits += lsEdits;
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: resume tier fix applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1/2: 4-bucket enum sanity (string-level -- these are prompt/schema text, not executable logic)
  if (!SD_HEADER_NEW.includes('"mode": "fresher | junior | mid | senior"')) { console.error('HARNESS FAIL: SeniorityDetector new header missing 4-bucket mode line'); process.exit(1); }
  const sopParsed = JSON.parse(SOP_NEW.replace(/^"mode":\s*/, ''));
  if (!Array.isArray(sopParsed.enum) || sopParsed.enum.join(',') !== 'fresher,junior,mid,senior') { console.error('HARNESS FAIL: Seniority Output Parser enum did not parse to the expected 4 values, got', JSON.stringify(sopParsed)); process.exit(1); }

  // 3: tierMap identity + backward-compat, evaluated as real JS
  {
    const src = BP1_NEW + '\nreturn tierMap;';
    const tierMap = new Function(src)();
    const cases = { fresher: 'fresher', junior: 'junior', mid: 'mid', senior: 'senior', experienced: 'mid', garbage: undefined };
    for (const [input, expected] of Object.entries(cases)) {
      const got = tierMap[input] || 'mid'; // mirrors `tierMap[c.seniority_mode] || 'mid'` at the call site
      const wantEffective = expected === undefined ? 'mid' : expected;
      if (got !== wantEffective) { console.error(`HARNESS FAIL: tierMap['${input}'] fallback-resolved to '${got}', expected '${wantEffective}'`); process.exit(1); }
    }
    // the actual regression this fixes: 'junior' must be reachable now (it never was before).
    if (tierMap.junior !== 'junior') { console.error('HARNESS FAIL: junior tier still unreachable'); process.exit(1); }
  }

  // 4: Load Skeletons transformation, run against a synthetic fixture mirroring the real code shape,
  // proving (a) it still parses as valid JS, (b) resume_skeleton is gone, (c) cover_skeleton survives,
  // (d) fit_strategy/candidate_yoe/jd_* survive untouched, (e) mode/seniority_mode/total_years_experience survive.
  {
    const fixtureBefore = [
      "let ctx = { existing_field: 'x' };",
      LS_DEFAULT_OLD,
      'const SKELETONS = {"fresher":"AAA","experienced":"BBB","senior":"CCC"};',
      'const COVER = "COVER_LATEX_HERE";',
      "const resumeSkeleton = SKELETONS[mode] || SKELETONS.experienced || '';",
      "const coverSkeleton = COVER || '';",
      'return [{ json: {',
      '  ...ctx,',
      '  seniority_mode: mode,',
      '  total_years_experience: seniorityOutput.total_years_experience || seniorityOutput.candidate_yoe || 0,',
      LS_RETURN_OLD,
      "  fit_strategy: seniorityOutput.fit_strategy || 'perfect_fit',",
      '  candidate_yoe: seniorityOutput.candidate_yoe || seniorityOutput.total_years_experience || 0,',
      '  jd_required_min: seniorityOutput.jd_required_min ?? null,',
      '  jd_required_max: seniorityOutput.jd_required_max ?? null,',
      "  jd_seniority: seniorityOutput.jd_seniority || 'unknown'",
      '} }];',
    ].join('\n');

    const { code: transformed, edits: fixtureEdits } = transformLoadSkeletons(fixtureBefore, 'harness-fixture.json');
    if (fixtureEdits !== 4) { console.error(`HARNESS FAIL: expected 4 edits on the synthetic fixture (default-mode, SKELETONS removal, resumeSkeleton removal, return-object), got ${fixtureEdits}`); process.exit(1); }

    if (transformed.includes('SKELETONS')) { console.error('HARNESS FAIL: SKELETONS still present after transform'); process.exit(1); }
    if (transformed.includes('resumeSkeleton')) { console.error('HARNESS FAIL: resumeSkeleton still present after transform'); process.exit(1); }
    if (transformed.includes('resume_skeleton:')) { console.error('HARNESS FAIL: resume_skeleton output field still present after transform'); process.exit(1); }
    for (const mustSurvive of ['coverSkeleton', 'cover_skeleton:', 'COVER', 'fit_strategy', 'candidate_yoe', 'jd_required_min', 'jd_required_max', 'jd_seniority', 'seniority_mode', 'total_years_experience', "mode: 'mid'"]) {
      if (!transformed.includes(mustSurvive)) { console.error(`HARNESS FAIL: '${mustSurvive}' was dropped by the transform but should survive`); process.exit(1); }
    }

    // must still be syntactically valid JS (a real, if partial, executability check on generated code).
    // The fixture already carries real seniorityOutput/mode declarations (from LS_DEFAULT_NEW) --
    // just wrap it in a function taking $input, no extra injection needed.
    try { new Function('$input', transformed); } catch (e) { console.error('HARNESS FAIL: transformed Load Skeletons code is not valid JS:', e.message); process.exit(1); }
  }

  console.log('HARNESS OK: 4-bucket taxonomy (prompt text, schema enum, tierMap incl. junior-reachability + backward-compat), and Load Skeletons transform (SKELETONS/resumeSkeleton/resume_skeleton removed, cover + fit_strategy/candidate_yoe/jd_* fields survive, result is valid JS) -- all verified');
})();

TARGETS.forEach(patch);

for (const f of SKELETON_FILES_TO_DELETE) {
  if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`DELETED: ${path.relative(ROOT, f)}`); }
  else console.log(`SKIP (already absent): ${path.relative(ROOT, f)}`);
}

console.log('S22 (resume tier fix) complete.');
