/* Harness for S11: cleanCompany (kill Https://Visa) + cover dash spacing.
 * Slices the relevant helpers out of the node files and tests them. */
const fs = require('fs');
const path = require('path');

// ── extract cleanCompany helper block from build_telegraph_body.js ──
const tb = fs.readFileSync(path.join(__dirname, 'nodes', 'build_telegraph_body.js'), 'utf8');
const ccBlock = tb.slice(tb.indexOf('const _BRAND'), tb.indexOf('function displayLocation'));
// ── extract normalizeLatexForPdflatex from build_cover_latex.js ──
const cl = fs.readFileSync(path.join(__dirname, 'nodes', 'build_cover_latex.js'), 'utf8');
const normBlock = cl.slice(cl.indexOf('function normalizeLatexForPdflatex'), cl.indexOf('const coverJson'));

const ctx = {};
eval(ccBlock + '\nctx.cleanCompany = cleanCompany;');
eval(normBlock + '\nctx.norm = normalizeLatexForPdflatex;');

let fails = 0;
function eq(label, got, want) { const ok = got === want; if (!ok) fails++; console.log((ok ? '  ok:   ' : '  FAIL: ') + label + '  => "' + got + '"' + (ok ? '' : '  (want "' + want + '")')); }
function has(label, got, sub, want) { const ok = got.includes(sub) === want; if (!ok) fails++; console.log((ok ? '  ok:   ' : '  FAIL: ') + label + (ok ? '' : '  => "' + got + '"')); }

console.log('[cleanCompany]');
eq('leaked scheme: https://visa', ctx.cleanCompany({ company: 'https://visa', url: 'https://visa.com/careers/1' }), 'Visa');
eq('leaked scheme cap: Https://Crowdstrike', ctx.cleanCompany({ company: 'Https://Crowdstrike' }), 'CrowdStrike');
eq('bare domain: crowdstrike.com', ctx.cleanCompany({ company: 'crowdstrike.com' }), 'CrowdStrike');
eq('clean brand passthrough: Visa', ctx.cleanCompany({ company: 'Visa' }), 'Visa');
eq('plain name: Justworks', ctx.cleanCompany({ company: 'Justworks' }), 'Justworks');
eq('slug name: confido-labs', ctx.cleanCompany({ company: 'confido-labs' }), 'Confido Labs');
eq('empty + greenhouse url', ctx.cleanCompany({ company: '', url: 'https://boards.greenhouse.io/justworks/jobs/7996868' }), 'Justworks');
eq('empty + workday url', ctx.cleanCompany({ company: '', url: 'https://capitalone.wd12.myworkdayjobs.com/en-US/x' }), 'Capitalone');
eq('unknown -> url fallback', ctx.cleanCompany({ company: 'unknown', url: 'https://jobs.lever.co/palantir/abc' }), 'Palantir');
eq('smartrecruiters camel slug', ctx.cleanCompany({ company: '', url: 'https://jobs.smartrecruiters.com/CityOfNewYork/123-ml' }), 'CityOfNewYork');
eq('multiword with period kept', ctx.cleanCompany({ company: 'St. Jude Research' }), 'St. Jude Research');
eq('nothing at all', ctx.cleanCompany({ company: '', url: '' }), 'Unknown');
// never returns a scheme
const probe = ctx.cleanCompany({ company: 'https://visa' });
has('no :// in output', probe, '://', false);

console.log('\n[cover dash spacing]');
eq('cramped en-dash title', ctx.norm('Production Scale–Applied AI'), 'Production Scale -- Applied AI');
eq('cramped em-dash clause', ctx.norm("opposites—they're prerequisites"), "opposites -- they're prerequisites");
eq('already-spaced range untouched', ctx.norm('Mar 2025 -- Present'), 'Mar 2025 -- Present');
has('hyphenated compound preserved', ctx.norm('production-grade systems'), 'production-grade', true);

console.log(fails ? ('\n*** ' + fails + ' FAILURES ***') : '\nALL PASSED');
process.exit(fails ? 1 : 0);
