/**
 * local_render_rank_fixes.js — the "A + imposters" batch (diagnosed from execution
 * #19/#20 data on 2026-07-01):
 *
 * 1) Assemble Resume LaTeX + Assemble Regen: the escaper mangles the skeleton's
 *    math-mode sub-bullet marker \labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}
 *    (renders literal $$•$$ on every bullet) — restore it after normalize, same
 *    pattern as the existing s6a $|$ restore. Also sanitize LLM-emitted math arrows
 *    ($\rightarrow$ / bare \rightarrow / unicode →) to '->' — post-escape they leave
 *    a bare \rightarrow that forces TeX into math mode and eats all spaces.
 * 2) Normalize Serper results + Retrieve Job: workday company capture [^.]+ matches
 *    protocol ("https://visa") — align with the fixed [^.\/]+ the You.com/Firecrawl
 *    normalizers already use.
 * 3) Build Telegraph Body: unparseable posted-dates rendered the literal string
 *    "Invalid Date" — guard with isNaN and omit instead.
 * 4) Aggregate Jobs: known recruiting-aggregator slugs (jobgether, weekday, ...) host
 *    on real ATSes so they classify Tier 1 and outrank actual employers — demote to
 *    Tier 3 so the existing `< 3` tier filter drops them.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const ASSEMBLE_OLD = String.raw`const normalized = normalizeLatexForPdflatex(finalLatex).split('\\$|\\$').join('$|$');`;
const ASSEMBLE_NEW = String.raw`let normalized = normalizeLatexForPdflatex(finalLatex).split('\\$|\\$').join('$|$');
// restore the skeleton's math-mode sub-bullet marker the escaper mangles (renders literal $$•$$ otherwise)
normalized = normalized.split('\\$\\vcenter{\\hbox{\\tiny\\$\\bullet\\$}}\\$').join('$\\vcenter{\\hbox{\\tiny$\\bullet$}}$');
// LLM-emitted math arrows: post-escape they leave a bare \rightarrow that forces TeX into math mode (eats spaces)
normalized = normalized.split('\\$\\rightarrow\\$').join('->').split('\\rightarrow').join('->').split('→').join('->');`;

const WD_OLD_SERPER = String.raw`url.match(/([^.]+)\.wd\d+\.myworkdayjobs\.com/)`;
const WD_NEW_SERPER = String.raw`url.match(/([^.\/]+)\.wd\d+\.myworkdayjobs\.com/)`;
const WD_OLD_RETRIEVE = String.raw`jobUrl.match(/([^.]+)\.wd\d+\.myworkdayjobs\.com\//)`;
const WD_NEW_RETRIEVE = String.raw`jobUrl.match(/([^.\/]+)\.wd\d+\.myworkdayjobs\.com\//)`;

const DATE_OLD = String.raw`  const posted = job.updated_at ? new Date(job.updated_at).toLocaleDateString('en-US', {month:'short',day:'numeric'}) : '';`;
const DATE_NEW = String.raw`  const _pd = job.updated_at ? new Date(job.updated_at) : null;
  const posted = (_pd && !isNaN(_pd.getTime())) ? _pd.toLocaleDateString('en-US', {month:'short',day:'numeric'}) : '';`;

const AGG_ANCHOR_OLD = String.raw`const sourceCounts = {};`;
const AGG_ANCHOR_NEW = String.raw`// Recruiting aggregators that post on real ATSes (so they classify Tier 1) but are
// not the employer — demote to Tier 3 so the existing tier filter drops them.
const AGGREGATORS = new Set(['jobgether','weekdayworks','weekday','cutshort','instahyre','crossover','turing','braintrust','toptal','uplers','remotebase','hirist','talentprise']);
const sourceCounts = {};`;
const AGG_DEMOTE_OLD = String.raw`    if (!job || !job.url) continue;`;
const AGG_DEMOTE_NEW = String.raw`    if (!job || !job.url) continue;
    if (AGGREGATORS.has((job.company || '').toLowerCase())) { job.source_tier = 3; job.tier_label = 'aggregator'; }`;

// ── mini-harness: prove the new assembler block does what we claim ──
(function harness() {
  const stubNormalize = (s) => s.split('$').join('\\$'); // what the real escaper does to $
  const input = 'Name $|$ Phone\n\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}\nregex $\\rightarrow$ RAG → LLM';
  const fn = new Function('normalizeLatexForPdflatex', 'finalLatex', ASSEMBLE_NEW + '\nreturn normalized;');
  const out = fn(stubNormalize, input);
  const want = 'Name $|$ Phone\n\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}\nregex -> RAG -> LLM';
  if (out !== want) { console.error('HARNESS FAIL assembler block:\n got: ' + JSON.stringify(out) + '\nwant: ' + JSON.stringify(want)); process.exit(1); }
  const fn2 = new Function('job', DATE_NEW + '\nreturn posted;');
  if (fn2({ updated_at: '2 days ago' }) !== '' || fn2({}) !== '' || !/[A-Z][a-z]{2} \d/.test(fn2({ updated_at: '2026-06-28' }))) {
    console.error('HARNESS FAIL date guard'); process.exit(1);
  }
  console.log('HARNESS OK: assembler restore/sanitize + date guard verified');
})();

function edit(wf, base, nodeName, pairs) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) { console.error(`INTEGRITY FAIL ${base}: node "${nodeName}" not found`); process.exit(1); }
  for (const [oldS, newS] of pairs) {
    const parts = node.parameters.jsCode.split(oldS);
    if (parts.length !== 2) {
      if (node.parameters.jsCode.includes(newS)) { console.log(`  ${base}: ${nodeName} already patched`); continue; }
      console.error(`INTEGRITY FAIL ${base}: "${nodeName}" target found ${parts.length - 1}x (want 1)\n  target: ${oldS.slice(0, 90)}`);
      process.exit(1);
    }
    node.parameters.jsCode = parts.join(newS);
  }
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  edit(wf, base, 'Assemble Resume LaTeX', [[ASSEMBLE_OLD, ASSEMBLE_NEW]]);
  edit(wf, base, 'Assemble Regen', [[ASSEMBLE_OLD, ASSEMBLE_NEW]]);
  edit(wf, base, 'Normalize Serper results', [[WD_OLD_SERPER, WD_NEW_SERPER]]);
  edit(wf, base, 'Retrieve Job', [[WD_OLD_RETRIEVE, WD_NEW_RETRIEVE]]);
  edit(wf, base, 'Build Telegraph Body', [[DATE_OLD, DATE_NEW]]);
  edit(wf, base, 'Aggregate Jobs', [[AGG_ANCHOR_OLD, AGG_ANCHOR_NEW], [AGG_DEMOTE_OLD, AGG_DEMOTE_NEW]]);
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: 6 nodes patched — ${wf.nodes.length} nodes`);
}

TARGETS.forEach(patch);
console.log('Render + ranking fixes complete.');
