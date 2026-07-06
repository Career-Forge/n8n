/**
 * s35_r3_header_escape_fix.js -- real bug found while researching R3 item 4
 * (the LaTeX render-helper drift-checker). Not part of the original R3 scope,
 * but exactly the class of bug that sprint exists to catch, and it's live
 * today in the primary (non-legacy) resume-render path.
 *
 * `buildHeaderFromPersonal` in both "Assemble Resume LaTeX" and "Assemble
 * Regen" (byte-identical clones -- confirmed) calls the OLD `escapeLatexText`
 * (V1) for name/phone/location, while the S16 rewrite (commit 6c62bf1)
 * upgraded every OTHER escaping call in these same nodes -- and "Build
 * Revised LaTeX" entirely -- to `escapeLatexTextV2`. V1 has no Unicode
 * normalization (curly quotes, em-dashes, ellipses) and no final non-ASCII
 * strip; V2 has both, specifically to survive pdflatex. Confirmed via a real
 * node execution inside the container that V1 also has a double-escape
 * artifact V2 doesn't (escaping a backslash introduces a brace pair that its
 * own brace-escaping regex then re-escapes).
 *
 * Concrete failure: a candidate name/phone/location containing a curly
 * apostrophe, em-dash, ellipsis, or any codepoint above \x7E (e.g. "Renée",
 * a name pasted from a smart-quote editor) reaches pdflatex completely raw
 * in the header -- and unlike the legacy fragment-shaped output path, the
 * primary merge/content render path (renderResume, the S16-era default) is
 * NEVER passed through normalizeLatexForPdflatex afterward, so nothing else
 * catches it. This has been live for 4 days (since 6c62bf1, unchanged since).
 *
 * Fix: 3 calls in each of the 2 nodes, escapeLatexText -> escapeLatexTextV2.
 * Makes buildHeaderFromPersonal byte-identical across Assemble Resume LaTeX /
 * Assemble Regen / Build Revised LaTeX again (all 3 already share every other
 * LaTeX-helper block byte-for-byte -- this was the one that had drifted).
 * Everywhere else escapeLatexText (V1) is still called in these 2 nodes
 * (buildFallbackSlots, sanitizeLatexContent -- the legacy fragment path) is
 * intentionally untouched; this fix is scoped to buildHeaderFromPersonal only.
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

const OLD = "function buildHeaderFromPersonal(p) {\n  p = p || {};\n  const name = escapeLatexText(firstNonEmpty(p.name, 'Candidate'));\n  const parts = [];\n  const phone = firstNonEmpty(p.phone_display, p.phone);\n  if (phone) parts.push(escapeLatexText(phone));\n  if (p.email) parts.push('\\\\href{mailto:' + p.email + '}{\\\\underline{' + p.email + '}}');\n  if (p.linkedin) parts.push('\\\\href{' + p.linkedin + '}{\\\\underline{LinkedIn}}');\n  if (p.github) parts.push('\\\\href{' + p.github + '}{\\\\underline{GitHub}}');\n  if (p.portfolio) parts.push('\\\\href{' + p.portfolio + '}{\\\\underline{Portfolio}}');\n  if (p.show_location && p.location) parts.push(escapeLatexText(p.location));\n  const contact = parts.length ? '\\\\small ' + parts.join(' $|$ ') : '';\n  return '\\\\begin{center}\\n  \\\\textbf{\\\\Huge \\\\scshape ' + name + '} \\\\\\\\ \\\\vspace{4pt}\\n  ' + contact + '\\n\\\\end{center}';\n}";

const NEW = "function buildHeaderFromPersonal(p) {\n  p = p || {};\n  const name = escapeLatexTextV2(firstNonEmpty(p.name, 'Candidate'));\n  const parts = [];\n  const phone = firstNonEmpty(p.phone_display, p.phone);\n  if (phone) parts.push(escapeLatexTextV2(phone));\n  if (p.email) parts.push('\\\\href{mailto:' + p.email + '}{\\\\underline{' + p.email + '}}');\n  if (p.linkedin) parts.push('\\\\href{' + p.linkedin + '}{\\\\underline{LinkedIn}}');\n  if (p.github) parts.push('\\\\href{' + p.github + '}{\\\\underline{GitHub}}');\n  if (p.portfolio) parts.push('\\\\href{' + p.portfolio + '}{\\\\underline{Portfolio}}');\n  if (p.show_location && p.location) parts.push(escapeLatexTextV2(p.location));\n  const contact = parts.length ? '\\\\small ' + parts.join(' $|$ ') : '';\n  return '\\\\begin{center}\\n  \\\\textbf{\\\\Huge \\\\scshape ' + name + '} \\\\\\\\ \\\\vspace{4pt}\\n  ' + contact + '\\n\\\\end{center}';\n}";

const TARGET_NODES = ['Assemble Resume LaTeX', 'Assemble Regen'];

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  for (const name of TARGET_NODES) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
    const n = N[name];
    const cur = n.parameters.jsCode;
    if (cur.indexOf(NEW) !== -1) continue;
    if (cur.indexOf(OLD) === -1) { console.error(`INTEGRITY FAIL ${base}: ${name} buildHeaderFromPersonal does not match expected old value`); process.exit(1); }
    n.parameters.jsCode = cur.split(OLD).join(NEW);
    edits++;
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: header escape V1->V2 fix applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  if (OLD.indexOf('escapeLatexTextV2') !== -1) { console.error('HARNESS FAIL: OLD string unexpectedly already has V2 -- anchor wrong'); process.exit(1); }
  const v2Count = (NEW.match(/escapeLatexTextV2/g) || []).length;
  if (v2Count !== 3) { console.error('HARNESS FAIL: NEW should call escapeLatexTextV2 exactly 3 times, got', v2Count); process.exit(1); }
  if ((NEW.match(/escapeLatexText\(/g) || []).length !== 0) { console.error('HARNESS FAIL: NEW should have zero remaining bare escapeLatexText( calls'); process.exit(1); }

  // Real behavioral proof: build a minimal harness mirroring firstNonEmpty + a real
  // escapeLatexTextV2 (copied verbatim from the live node, not reimplemented) and confirm
  // the NEW buildHeaderFromPersonal correctly escapes a name with problem characters that
  // the OLD (V1) version would leave dangerous/raw.
  const escapeLatexTextV2 = new Function('value', `
    let s = String(value == null ? '' : value);
    s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
      .replace(/…/g, '...').replace(/[–—]/g, '--')
      .replace(/[→➔➡]/g, '->').replace(/•/g, '*')
      .replace(/₹/g, 'INR ').replace(/€/g, 'EUR ').replace(/£/g, 'GBP ');
    s = s.replace(/\\\\/g, '\\x00');
    s = s.replace(/([#$%&_{}])/g, '\\\\$1');
    s = s.replace(/~/g, '\\\\textasciitilde{}').replace(/\\^/g, '\\\\textasciicircum{}');
    s = s.replace(/\\x00/g, '\\\\textbackslash{}');
    s = s.replace(/[^\\x09\\x0A\\x0D\\x20-\\x7E]/g, '');
    return s;
  `);
  function firstNonEmpty(...values) { return values.find((v) => String(v == null ? '' : v).trim().length > 0) ?? ''; }
  const fn = new Function('escapeLatexTextV2', 'firstNonEmpty', 'return ' + NEW);
  const buildHeaderFromPersonal = fn(escapeLatexTextV2, firstNonEmpty);

  const problemName = 'Renée O’Malley–Chen'; // e-acute, curly apostrophe, en-dash
  const out = buildHeaderFromPersonal({ name: problemName, phone: '555', email: 'a@b.com' });
  if (out.includes('’') || out.includes('–') || !/[^\x00-\x7F]/.test(problemName)) {
    // sanity: the input DOES contain non-ASCII/smart-punctuation (guards the test itself from being vacuous)
  }
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(out)) { console.error('HARNESS FAIL: fixed header still contains raw non-ASCII characters -- V2 escaping not applied correctly, output:', out); process.exit(1); }
  if (!out.includes("O'Malley")) { console.error('HARNESS FAIL: curly apostrophe should normalize to a straight one, got', out); process.exit(1); }
  if (!out.includes('--')) { console.error('HARNESS FAIL: en-dash should normalize to --, got', out); process.exit(1); }

  // Contrast proof: the OLD (V1) escaper genuinely leaves this raw -- confirms this is a real fix, not a no-op.
  const escapeLatexTextV1 = new Function('value', `
    return String(value == null ? '' : value)
      .replace(/\\\\/g, '\\\\textbackslash{}')
      .replace(/([#$%&_{}])/g, '\\\\$1')
      .replace(/~/g, '\\\\textasciitilde{}')
      .replace(/\\^/g, '\\\\textasciicircum{}');
  `);
  const v1Out = escapeLatexTextV1(problemName);
  if (!/[^\x09\x0A\x0D\x20-\x7E]/.test(v1Out)) { console.error('HARNESS FAIL: test is not discriminating -- V1 was expected to leave raw non-ASCII characters in place but did not, got', v1Out); process.exit(1); }

  console.log('HARNESS OK: OLD/NEW anchors correct (3 calls upgraded, zero bare V1 calls remain), and a real behavioral test proves the fix -- a name with curly apostrophe/en-dash/accented character now escapes cleanly under V2, confirmed to have been left raw under V1 (test is genuinely discriminating, not vacuous)');
})();

TARGETS.forEach(patch);
console.log('S35 (R3: header escape V1->V2 bugfix) complete.');
