/**
 * s84_bare_company_list_targeting.js -- "find jobs at Google, Microsoft, Amazon
 * in India" produced 98 results, only 1 actually from those companies. Naming
 * companies directly (no cohort keyword like "MAANG") never populated
 * target_companies -- so s80's cache targeting, Aggregate Jobs' cohort filter,
 * and the pre-existing COHORT_TARGETS site-query table (all keyed purely on
 * target_companies, confirmed via read-only investigation, not assumed) never
 * engaged. Getting target_companies populated for a bare list is the entire
 * fix -- every downstream consumer already "just works" once it's non-empty.
 *
 * Two layers (s75/s79/s82/s83 pattern):
 * (1) Expand Query prompt: broaden target_companies population to also fire
 *     on a bare list of specific companies (company_cohort stays null -- it's
 *     not a named group). Explicit target-vs-context examples, since "I used
 *     to work at Stripe, find AI jobs" must NOT populate target_companies.
 * (2) Parse Expand Query deterministic backstop (same node/access pattern as
 *     s82/s83): an LLM array wired to a hard filter can hallucinate, same
 *     risk class as remote_preference/freshness_explicit. Gated ONLY on the
 *     ad-hoc path (company_cohort === null) -- the cohort-keyword path is a
 *     trusted exact lookup (s81) whose names legitimately don't appear as
 *     message substrings ("MAANG" doesn't contain "Meta"). Drop any ad-hoc
 *     target company not literally present in the raw message.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ── (1) Expand Query prompt: broaden target_companies population ──
const EQ_OLD = '- target_companies: if company_cohort is set, list the actual company names you know belong to it (e.g. FAANG -> ["Meta","Amazon","Apple","Netflix","Google"]); else [].';
const EQ_NEW = '- target_companies: if company_cohort is set, list the actual company names you know belong to it (e.g. FAANG -> ["Meta","Amazon","Apple","Netflix","Google"]). ALSO populate target_companies (leaving company_cohort null) when the message names one or more SPECIFIC companies directly as the target of the search, even with no cohort keyword -- e.g. "find jobs at Google, Microsoft, Amazon" -> target_companies=["Google","Microsoft","Amazon"], company_cohort=null; "jobs at Nvidia" -> target_companies=["Nvidia"]. Do NOT populate when a company is mentioned as background/context/comparison, not as a search target -- e.g. "I used to work at Stripe, find me AI jobs" or "companies like Stripe" -> target_companies=[]. Else [].';

// ── (2) Parse Expand Query: deterministic backstop, same node as s82/s83 ──
const PEQ_ANCHOR = "result.freshness_explicit = FRESH_LANG_RX.test(String($('Prep Expand Input').first().json.message_text || ''));\n} catch (e) { result.freshness_explicit = false; }";
const TARGET_BACKSTOP =
  "\n\n// s84: target_companies is a HARD filter downstream (Aggregate Jobs' cohort\n" +
  "// filter, s80's cache SQL) -- same risk class as remote_preference/\n" +
  "// freshness_explicit above. Only the AD-HOC path (company_cohort null) needs\n" +
  "// this: the cohort-KEYWORD path (s81) is a trusted exact lookup whose names\n" +
  "// legitimately never appear in the message ('MAANG' doesn't contain 'Meta').\n" +
  "try {\n" +
  "  if (!result.company_cohort && Array.isArray(result.target_companies) && result.target_companies.length) {\n" +
  "    const rawMsgLower = String($('Prep Expand Input').first().json.message_text || '').toLowerCase();\n" +
  "    result.target_companies = result.target_companies.filter((co) => rawMsgLower.includes(String(co || '').toLowerCase()));\n" +
  "  }\n" +
  "} catch (e) { /* fail-open: keep the parsed list rather than block the search */ }";
const PEQ_NEW = PEQ_ANCHOR + TARGET_BACKSTOP;

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Expand Query', 'Parse Expand Query']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Expand Query'].parameters.jsCode.includes('s84:')) { console.log(`  ${base}: already patched`); return; }

  const mv = N['Expand Query'].parameters.messages.messageValues;
  replaceOnce(mv[0], 'message', EQ_OLD, EQ_NEW, 'bare company-list prompt rule', base);
  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', PEQ_ANCHOR, PEQ_NEW, 'target_companies backstop', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: bare company-list targeting + backstop -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  function runBackstop(companyCohort, targetCompanies, rawMsg) {
    const result = { company_cohort: companyCohort, target_companies: targetCompanies };
    const $ = () => ({ first: () => ({ json: { message_text: rawMsg } }) });
    const body = TARGET_BACKSTOP + '\nreturn result.target_companies;';
    return new Function('result', '$', body)(result, $);
  }

  const cases = [
    [null, ['Google', 'Microsoft', 'Amazon'], 'find jobs at Google, Microsoft, Amazon in India', ['Google', 'Microsoft', 'Amazon'], 'exec-594 repro: all real, all kept'],
    [null, ['Nvidia'], 'jobs at Nvidia', ['Nvidia'], 'single ad-hoc company kept'],
    [null, ['Google', 'Meta'], 'find jobs at Google, Microsoft, Amazon in India', ['Google'], 'hallucinated addition (Meta never mentioned) dropped, real ones survive'],
    ['maango', ['Meta', 'Anthropic', 'Amazon', 'Nvidia', 'Google', 'OpenAI'], 'Find me AI jobs in MAANGO companies worldwide', ['Meta', 'Anthropic', 'Amazon', 'Nvidia', 'Google', 'OpenAI'], 'cohort-keyword path untouched -- s81 regression guard'],
    [null, [], 'find AI jobs', [], 'empty stays empty'],
  ];
  for (const [cohort, targets, msg, want, label] of cases) {
    const got = runBackstop(cohort, targets, msg);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`HARNESS FAIL: "${label}" -> ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
      process.exit(1);
    }
  }
  if (!EQ_NEW.includes('I used to work at Stripe')) { console.error('HARNESS FAIL: context-vs-target example missing from prompt'); process.exit(1); }
  console.log('HARNESS OK: exec-594 case fully kept, single ad-hoc company kept, a hallucinated addition dropped while real mentions survive, MAANGO cohort-keyword path completely unaffected (s81 regression guard passes), empty stays empty.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S84 (bare company-list targeting) complete.');
