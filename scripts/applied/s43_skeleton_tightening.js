/**
 * s43_skeleton_tightening.js -- v7 sprint, part 2: port the vertical-density
 * discipline from the user's hand-built reference template into the shared
 * SKELETON. Their manual resume fits MORE content (5 jobs + summary +
 * accomplishments) on one page than the pipeline's 4-job output because it
 * squeezes: tighter margins, -12pt before every section, -2pt inside every
 * bullet, bold section titles. This is pure typography -- zero content or
 * personalization risk, applies identically to any candidate.
 *
 * Four anchored edits inside the SKELETON block, applied identically to all
 * 3 LaTeX nodes (Assemble Resume LaTeX, Assemble Regen, Build Revised LaTeX)
 * so the drift-checker's twin-identity and shared-block checks stay green:
 *   1. geometry: top/bottom 0.45in -> 0.3in, left/right 0.55in -> 0.4in
 *   2. section titleformat: \vspace{-5pt} -> -12pt, add \bfseries,
 *      closer \vspace{-4pt} -> -5pt
 *   3. \resumeItem: content gains a trailing \vspace{-2pt}
 *   4. \resumeItemListEnd: -4pt -> -5pt
 * Compact macros untouched (already denser; compact is an explicit opt-in).
 *
 * export_prompts.js's SKELETON anchors (start 'const SKELETON = String.raw`',
 * end '\end{document}`;') are unaffected -- only interior lines change.
 *
 * Verification beyond the harness (per the standing LaTeX rule): real
 * pdflatex compiles of dense/sparse/overflow-probe fixtures against the
 * latex-service container, asserting page counts -- the probe reading
 * calibrates s44's lineBudget numbers. That step runs after the dry-run.
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

const EDITS = [
  [
    'geometry margins',
    '\\usepackage[top=0.45in, bottom=0.45in, left=0.55in, right=0.55in]{geometry}',
    '\\usepackage[top=0.3in, bottom=0.3in, left=0.4in, right=0.4in]{geometry}',
  ],
  [
    'section titleformat',
    '\\titleformat{\\section}{\n  \\vspace{-5pt}\\scshape\\raggedright\\large\n}{}{0em}{}[\\color{black}\\titlerule \\vspace{-4pt}]',
    '\\titleformat{\\section}{\n  \\vspace{-12pt}\\scshape\\raggedright\\large\\bfseries\n}{}{0em}{}[\\color{black}\\titlerule \\vspace{-5pt}]',
  ],
  [
    'resumeItem per-bullet squeeze',
    '\\newcommand{\\resumeItem}[1]{\n  \\item\\small{\n    {#1}\n  }\n}',
    '\\newcommand{\\resumeItem}[1]{\n  \\item\\small{\n    {#1 \\vspace{-2pt}}\n  }\n}',
  ],
  [
    'resumeItemListEnd',
    '\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-4pt}}',
    '\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-5pt}}',
  ],
];

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  let touched = 0;

  for (const name of NODE_NAMES) {
    const n = wf.nodes.find((x) => x.name === name);
    if (!n) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
    let code = n.parameters.jsCode;
    if (code.includes('top=0.3in')) { console.log(`  ${base}: "${name}" already patched`); continue; }
    for (const [label, oldStr, newStr] of EDITS) {
      const count = code.split(oldStr).length - 1;
      if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: "${name}" anchor for "${label}" found ${count} times, expected exactly 1`); process.exit(1); }
      code = code.replace(oldStr, newStr);
    }
    n.parameters.jsCode = code;
    touched++;
  }

  if (touched === 0) { console.log(`  ${base}: all nodes already patched`); return; }

  // twin-identity invariant: the two Assemble nodes must remain byte-identical
  const a = wf.nodes.find((x) => x.name === 'Assemble Resume LaTeX').parameters.jsCode;
  const r = wf.nodes.find((x) => x.name === 'Assemble Regen').parameters.jsCode;
  if (a !== r) { console.error(`INTEGRITY FAIL ${base}: Assemble twins diverged after patch`); process.exit(1); }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: SKELETON tightened in ${touched} node(s)`);
}

// ── harness ──
(function harness() {
  const file = TARGETS.find((f) => fs.existsSync(f));
  if (!file) { console.error('HARNESS FAIL: no target file found'); process.exit(1); }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));

  for (const name of NODE_NAMES) {
    const n = wf.nodes.find((x) => x.name === name);
    let code = n.parameters.jsCode;
    const already = code.includes('top=0.3in');
    if (!already) {
      for (const [label, oldStr] of EDITS) {
        const count = code.split(oldStr).length - 1;
        if (count !== 1) { console.error(`HARNESS FAIL: "${name}" anchor "${label}" found ${count}x in live code, expected 1`); process.exit(1); }
      }
      for (const [, oldStr, newStr] of EDITS) code = code.replace(oldStr, newStr);
    }

    // post-patch invariants on the patched (or already-patched) code
    if (!code.includes('top=0.3in, bottom=0.3in, left=0.4in, right=0.4in')) { console.error(`HARNESS FAIL: "${name}" new geometry missing`); process.exit(1); }
    if (code.includes('top=0.45in')) { console.error(`HARNESS FAIL: "${name}" old geometry still present`); process.exit(1); }
    if (!code.includes('\\vspace{-12pt}\\scshape\\raggedright\\large\\bfseries')) { console.error(`HARNESS FAIL: "${name}" new section format missing`); process.exit(1); }
    if (!code.includes('{#1 \\vspace{-2pt}}')) { console.error(`HARNESS FAIL: "${name}" per-bullet squeeze missing`); process.exit(1); }
    if (!code.includes('\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-5pt}}')) { console.error(`HARNESS FAIL: "${name}" listEnd -5pt missing`); process.exit(1); }
    // compact macros untouched
    if (!code.includes('\\newcommand{\\resumeItemListEndCompact}{\\end{itemize}\\vspace{-6pt}}')) { console.error(`HARNESS FAIL: "${name}" compact listEnd was disturbed`); process.exit(1); }
    if (!code.includes('\\item\\footnotesize{\n    {#1}\n  }')) { console.error(`HARNESS FAIL: "${name}" resumeItemCompact was disturbed`); process.exit(1); }

    // SKELETON extraction still works with the drift-checker's anchors
    const skStart = code.indexOf('const SKELETON = String.raw`');
    const skEnd = code.indexOf('\\end{document}`;', skStart);
    if (skStart === -1 || skEnd === -1) { console.error(`HARNESS FAIL: "${name}" drift-checker SKELETON anchors broken`); process.exit(1); }
    const skeleton = code.slice(skStart, skEnd);
    // brace balance on the skeleton body (String.raw content between backticks)
    const body = skeleton.slice(skeleton.indexOf('`') + 1);
    let depth = 0;
    for (const ch of body) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    // \end{document} + backtick-semicolon were cut off by the end anchor; account for the dangling '\end{document' not present here
    if (depth !== 0) { console.error(`HARNESS FAIL: "${name}" SKELETON brace imbalance after patch: ${depth}`); process.exit(1); }
  }

  console.log('HARNESS OK: all 4 anchors unique in all 3 nodes, patched SKELETON has new geometry/-12pt bold sections/-2pt bullets/-5pt listEnd, compact macros untouched, drift-checker anchors intact, braces balanced');
})();

TARGETS.forEach(patch);
console.log('S43 (SKELETON spacing tightening) complete.');
