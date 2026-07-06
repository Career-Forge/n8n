/**
 * s41_bullet_render_fix.js -- fixes two long-standing content-quality bugs
 * in the shared LaTeX bullet renderer, found by actually reading a real
 * generated resume PDF (first time this session anyone looked at output
 * content rather than just graph structure). Confirmed via a 4-agent
 * diagnostic workflow + a direct read of the \resumeItem macro definition:
 *
 * 1. Double colon ("Transformer architecture:: Built..."). Pass2 Generate's
 *    prompt schema shows the "keyword" field with no trailing colon in its
 *    example, but doesn't forbid one either -- the LLM frequently writes
 *    natural resume-style labels WITH a trailing colon ("Transformer
 *    architecture:"). Nothing downstream (Parse Pass2, resolveBulletsV2,
 *    mergeContent) strips it -- all pure passthrough. bulletRenderV2 then
 *    unconditionally appends its own ':', producing "::". Fix: strip a
 *    trailing colon/punctuation from keyword defensively at render time --
 *    a code-level backstop, not reliant on LLM compliance (same philosophy
 *    already used elsewhere in this codebase, e.g. Phase 4.2's section-order
 *    backstop).
 *
 * 2. Mid-sentence truncation. truncate110 (introduced in S16, commit
 *    6c62bf1, untouched since) hard-caps every bullet at 110 characters with
 *    no ellipsis ever added -- a cut sentence just silently stops
 *    ("...raising code coverage by", "...for scalable"). Confirmed via the
 *    \resumeItem macro definition (\newcommand{\resumeItem}[1]{\item\small{
 *    {#1}}} -- a plain itemize item, no fixed-width box) that there was
 *    never a structural reason bullets needed to fit one line; they wrap
 *    naturally. The 110-char budget was an unnecessarily tight line-fit
 *    guess that the LLM (despite the prompt's own "MAX 110 characters"
 *    instruction) overshoots almost every time. Fix: raise the ceiling to a
 *    generous sanity cap (240 -- guards against a truly runaway LLM
 *    response, not against normal STAR-bullet length) and add an ellipsis
 *    when the ceiling is actually hit, so the rare truncation reads as
 *    intentional instead of broken.
 *
 * Confirmed byte-identical (and therefore fixed identically here) across
 * all 3 apply-flow LaTeX-rendering nodes: Assemble Resume LaTeX (initial
 * generate), Assemble Regen (ATS retry), Build Revised LaTeX (revise).
 * Build Cover LaTeX is untouched -- confirmed it has no truncate110/
 * bulletRenderV2 reference at all, a fully separate renderer.
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

const NODE_NAMES = ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX'];

const OLD_BLOCK = `function truncate110(t) {
  t = String(t == null ? '' : t).trim();
  if (t.length <= 110) return t;
  const cut = t.slice(0, 110);
  const sp = cut.lastIndexOf(' ');
  return (sp > 80 ? cut.slice(0, sp) : cut).replace(/[,;:.\\s]+$/, '');
}
function bulletRenderV2(bullets, isCompact) {
  const cmd = isCompact ? '\\\\resumeItemCompact' : '\\\\resumeItem';
  return (bullets || []).slice(0, isCompact ? 3 : 4).map((b) => {
    const text = truncate110(b.text);
    const kw = b.keyword ? '\\\\textbf{' + escapeLatexTextV2(b.keyword) + ':} ' : '';
    return '    ' + cmd + '{' + kw + escapeLatexTextV2(text) + '}';
  }).join('\\n');
}`;

const NEW_BLOCK = `function truncateBullet(t) {
  t = String(t == null ? '' : t).trim();
  const MAX = 240;
  if (t.length <= MAX) return t;
  const cut = t.slice(0, MAX);
  const sp = cut.lastIndexOf(' ');
  const base = (sp > MAX - 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\\s]+$/, '');
  return base + '...';
}
function bulletRenderV2(bullets, isCompact) {
  const cmd = isCompact ? '\\\\resumeItemCompact' : '\\\\resumeItem';
  return (bullets || []).slice(0, isCompact ? 3 : 4).map((b) => {
    const text = truncateBullet(b.text);
    const kwText = (b.keyword || '').replace(/[:;,.]+\\s*$/, '');
    const kw = kwText ? '\\\\textbf{' + escapeLatexTextV2(kwText) + ':} ' : '';
    return '    ' + cmd + '{' + kw + escapeLatexTextV2(text) + '}';
  }).join('\\n');
}`;

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  let edits = 0;

  for (const name of NODE_NAMES) {
    const n = wf.nodes.find((x) => x.name === name);
    if (!n) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
    const code = n.parameters.jsCode;
    if (code.includes('function truncateBullet(')) {
      console.log(`  ${base}: "${name}" already patched`);
      continue;
    }
    const count = code.split(OLD_BLOCK).length - 1;
    if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: "${name}" OLD_BLOCK anchor found ${count} times, expected exactly 1`); process.exit(1); }
    n.parameters.jsCode = code.replace(OLD_BLOCK, NEW_BLOCK);
    edits++;
  }

  if (edits === 0) { console.log(`  ${base}: all nodes already patched, nothing to do`); return; }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: bullet renderer fixed in ${edits} node(s)`);
}

// ── harness ──
(function harness() {
  function loadFns(block) {
    return new Function(
      'escapeLatexTextV2',
      `${block}\nreturn { bulletRenderV2, truncateFn: (typeof truncateBullet !== 'undefined' ? truncateBullet : (typeof truncate110 !== 'undefined' ? truncate110 : null)) };`
    )((s) => s); // identity escaper -- isolates render-shape/truncation logic from escaping concerns
  }

  const oldFns = loadFns(OLD_BLOCK);
  const newFns = loadFns(NEW_BLOCK);

  // 1. Short text: unchanged, no ellipsis, in both old and new.
  {
    const short = 'Built a thing that works well.';
    if (oldFns.truncateFn(short) !== short) { console.error('HARNESS FAIL: old truncate mutated short text'); process.exit(1); }
    if (newFns.truncateFn(short) !== short) { console.error('HARNESS FAIL: new truncate mutated short text'); process.exit(1); }
  }

  // 2. Real-shaped long bullet (188 chars, has plenty of word boundaries) --
  //    OLD cuts it (proving the reported bug), NEW returns it whole (proving the fix).
  {
    const realShaped = 'Optimized real-time ETL for point-of-sale data using ADF and Python, lifting campaign performance by 18% and reducing latency for downstream reporting dashboards used by regional sales teams';
    if (realShaped.length <= 110) throw new Error('fixture too short for old-cap test');
    const oldOut = oldFns.truncateFn(realShaped);
    if (oldOut === realShaped) { console.error('HARNESS FAIL: old truncate110 did not truncate a 180+ char bullet -- fixture invalid'); process.exit(1); }
    if (oldOut.length >= realShaped.length) { console.error('HARNESS FAIL: old truncate110 should have shortened the text'); process.exit(1); }
    const newOut = newFns.truncateFn(realShaped);
    if (newOut !== realShaped) { console.error('HARNESS FAIL: new truncateBullet (240 cap) should have returned this 188-char bullet whole, got', newOut); process.exit(1); }
  }

  // 3. Text that genuinely exceeds the new 240 cap: must truncate AND end with an ellipsis
  //    (proving the "silently stops" bug is fixed even when truncation still occurs).
  {
    const veryLong = 'Architected a five-layer multi-agent orchestration platform blending deterministic finite-state machines, classical machine learning classifiers, and large language model reasoning agents across twenty-eight distinct specialized roles spanning ingestion, scoring, generation, and delivery pipelines end to end';
    if (veryLong.length <= 240) throw new Error('fixture too short for new-cap overflow test');
    const out = newFns.truncateFn(veryLong);
    if (out.length >= veryLong.length) { console.error('HARNESS FAIL: new truncateBullet did not shorten a 240+ char bullet'); process.exit(1); }
    if (!out.endsWith('...')) { console.error('HARNESS FAIL: truncated output must end with an ellipsis, got:', JSON.stringify(out.slice(-20))); process.exit(1); }
    if (/[,;:.\s]\.\.\.$/.test(out)) { console.error('HARNESS FAIL: dangling punctuation left right before the ellipsis:', JSON.stringify(out.slice(-25))); process.exit(1); }
  }

  // 4. Word-boundary backoff still works (doesn't regress to a raw hard cut when a
  //    reasonable space exists near the new boundary). Space at index 215 is inside
  //    the backoff window (sp > MAX-30 = 210), so it should back off to right before
  //    the space -- landing entirely before the y-run, not mid-y-run.
  {
    const text = 'x'.repeat(215) + ' ' + 'y'.repeat(60);
    const out = newFns.truncateFn(text);
    if (out !== 'x'.repeat(215) + '...') { console.error('HARNESS FAIL: expected word-boundary backoff to land before the y-run, got', JSON.stringify(out)); process.exit(1); }
  }

  // 5. No word boundary in the backoff window at all -> hard cut at MAX, still gets ellipsis.
  {
    const text = 'z'.repeat(300); // one giant unbroken "word"
    const out = newFns.truncateFn(text);
    if (out !== 'z'.repeat(240) + '...') { console.error('HARNESS FAIL: no-boundary hard-cut case wrong, got length', out.length); process.exit(1); }
  }

  // 6. Keyword colon-strip: the actual reported "::" bug, proven fixed via bulletRenderV2 itself.
  {
    const bulletsWithColon = [{ keyword: 'Transformer architecture:', text: 'Built specialized transformer mapping fMRI signals to brain regions.' }];
    const oldRendered = oldFns.bulletRenderV2(bulletsWithColon, false);
    if (!oldRendered.includes('architecture::')) { console.error('HARNESS FAIL: old bulletRenderV2 should reproduce the "::" bug on this fixture (sanity check on the fixture itself)'); process.exit(1); }
    const newRendered = newFns.bulletRenderV2(bulletsWithColon, false);
    if (newRendered.includes('::')) { console.error('HARNESS FAIL: new bulletRenderV2 still produces "::" for a keyword with a baked-in trailing colon:', newRendered); process.exit(1); }
    if (!newRendered.includes('architecture:} ')) { console.error('HARNESS FAIL: new bulletRenderV2 should render exactly one colon after the keyword, got:', newRendered); process.exit(1); }
  }

  // 7. Keyword WITHOUT a trailing colon still renders exactly one colon (no regression
  //    for the already-correct case), and empty/missing keyword still renders no label at all.
  {
    const bulletsNoColon = [{ keyword: 'Late-fusion model', text: 'Designed stDNN combining fMRI, gray matter, and white matter modalities.' }];
    const rendered = newFns.bulletRenderV2(bulletsNoColon, false);
    if (!rendered.includes('model:} ') || rendered.includes('::')) { console.error('HARNESS FAIL: keyword without trailing colon regressed:', rendered); process.exit(1); }

    const bulletsNoKeyword = [{ keyword: '', text: 'A bullet with no bold lead-in at all.' }];
    const rendered2 = newFns.bulletRenderV2(bulletsNoKeyword, false);
    if (rendered2.includes('\\textbf{')) { console.error('HARNESS FAIL: empty keyword should render no \\textbf{} label at all, got:', rendered2); process.exit(1); }
  }

  // 8. isCompact bullet-count cap (3 vs 4) still works -- confirms this fix didn't
  //    regress the S38 compact-template feature it sits alongside.
  {
    const sixBullets = Array.from({ length: 6 }, (_, i) => ({ keyword: '', text: 'bullet ' + i }));
    const normalOut = newFns.bulletRenderV2(sixBullets, false).split('\n').length;
    const compactOut = newFns.bulletRenderV2(sixBullets, true).split('\n').length;
    if (normalOut !== 4 || compactOut !== 3) { console.error(`HARNESS FAIL: bullet-count cap regressed, normal=${normalOut} (want 4) compact=${compactOut} (want 3)`); process.exit(1); }
    if (!newFns.bulletRenderV2(sixBullets, true).includes('\\resumeItemCompact')) { console.error('HARNESS FAIL: compact macro name regressed'); process.exit(1); }
  }

  console.log('HARNESS OK: truncateBullet (240-char sanity cap, word-boundary backoff, ellipsis on real truncation, hard-cut fallback still ellipsis-terminated) and bulletRenderV2\'s keyword colon-strip (fixes "::", preserves single-colon and no-keyword cases, preserves the S38 compact bullet-count cap) all verified via real JS eval of the actual OLD vs NEW code blocks');
})();

TARGETS.forEach(patch);
console.log('S41 (bullet renderer fix: double-colon + mid-sentence truncation) complete.');
