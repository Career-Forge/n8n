/**
 * s6a_render_fix.js — S6a (part 1): fix the VISIBLE resume/cover header bugs.
 *
 * Both Build Resume LaTeX and Build Cover LaTeX:
 *  (1) `{{EMAIL}}` rendered literally because headerTemplate.replace('{{EMAIL}}',…)
 *      is single-replace, but the template has {{EMAIL}} TWICE (mailto + display).
 *      Fix: replaceAll. (typical emails are LaTeX-safe, so raw value is fine for
 *      both the mailto and the display occurrence.)
 *  (2) `$|$` separators rendered literally because normalizeLatexForPdflatex runs
 *      replace(/(?<!\\)\$/g,'\\$') over the whole doc, escaping the intentional
 *      math-mode `$|$` to `\$|\$`. Fix: restore `\$|\$` -> `$|$` AFTER normalize
 *      (content `$` was already escaped by escapeLatexText, so only the intended
 *      separators are affected). Strings built via JSON.stringify to avoid
 *      backslash/`$`-escaping mistakes; applied with split/join (no $ interp).
 *
 * (Integrity guards — validate-empty + Compile onError — come in s6a2.)
 * Run: node scripts/s6a_render_fix.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const BS = String.fromCharCode(92);          // backslash
const ESC_SEP = BS + '$|' + BS + '$';         // \$|\$  (what normalize over-produces)
const REAL_SEP = '$|$';                        // intended math separator
const RESTORE = 'normalizeLatexForPdflatex(fullLatex).split(' + JSON.stringify(ESC_SEP) + ').join(' + JSON.stringify(REAL_SEP) + ')';

const sj = (s, a, b) => s.split(a).join(b);

function fixNode(node, name, base) {
  let code = node.parameters.jsCode;
  let n = 0;
  if (code.includes(".replace('{{EMAIL}}', personal.email || '')")) {
    code = sj(code, ".replace('{{EMAIL}}', personal.email || '')", ".replaceAll('{{EMAIL}}', personal.email || '')"); n++;
  }
  if (code.includes('normalizeLatexForPdflatex(fullLatex)') && !code.includes(".join('$|$')") && !code.includes('.join("$|$")')) {
    code = sj(code, 'normalizeLatexForPdflatex(fullLatex)', RESTORE); n++;
  }
  node.parameters.jsCode = code;
  // sanity: still parses
  try { new Function(code); } catch (e) { console.error(`PARSE FAIL ${base}/${name}: ${e.message}`); process.exit(1); }
  return n;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((x) => { N[x.name] = x; });
  const base = path.basename(file);
  let total = 0;
  for (const nm of ['Build Resume LaTeX', 'Build Cover LaTeX']) {
    if (N[nm]) total += fixNode(N[nm], nm, base);
    else console.log(`  (no ${nm} in ${base})`);
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S6a render fix (${total} edits)`);
}

TARGETS.forEach(patch);
console.log('S6a (render fix) complete.');
