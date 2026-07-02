/**
 * s15_cohort.js -- WS3: cohort expansion ("Fortune 50", "FAANG", ...).
 *
 * Today "find AI jobs at Fortune 50 companies" fails silently: Expand Query has
 * no concept of a named cohort, so the literal words "Fortune 50" get baked into
 * site: queries that never match anything (Amazon/Meta/Google don't run on
 * greenhouse/lever). Fix: teach Expand Query to recognize cohorts and name
 * members; expand known members via a static table into per-company site:
 * queries; post-filter Aggregate Jobs to the named companies so generic web
 * noise can't dilute a cohort-scoped search.
 *
 * No new node -- Build Serper/You.com Queries and Aggregate Jobs already read
 * $('Parse Expand Query') by name, so the expansion lives in that node's tail.
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

// ── 1) Expand Query system prompt: teach cohort recognition ──
const PROMPT_OLD = String.raw`- excluded_roles: titles clearly NOT wanted. Default: ["Technical Support","Customer Success","QA Engineer"]`;
const PROMPT_NEW = String.raw`- excluded_roles: titles clearly NOT wanted. Default: ["Technical Support","Customer Success","QA Engineer"]
- company_cohort: if the message names a well-known company GROUP (e.g. "Fortune 50", "FAANG", "MAANG", "big tech"), a short slug string identifying it (e.g. "fortune50-tech","faang","big-tech-india"); else null.
- target_companies: if company_cohort is set, list the actual company names you know belong to it (e.g. FAANG -> ["Meta","Amazon","Apple","Netflix","Google"]); else [].`;

// ── 2) Parse Expand Query tail: pass fields through + expand via static table ──
const COHORT_TABLE = String.raw`// WS3: static cohort -> known ATS/careers targets, merged over the LLM's
// target_companies (LLM supplies membership, this table supplies HOW to search).
const COHORT_TARGETS = {
  'meta': { careers_domain: 'metacareers.com' }, 'facebook': { careers_domain: 'metacareers.com' },
  'amazon': { careers_domain: 'amazon.jobs' }, 'apple': { careers_domain: 'jobs.apple.com' },
  'netflix': { careers_domain: 'explore.jobs.netflix.net' }, 'google': { careers_domain: 'careers.google.com' },
  'microsoft': { careers_domain: 'careers.microsoft.com' }, 'nvidia': { workday_tenant: 'nvidia.wd5', workday_site: 'NVIDIAExternalCareerSite' },
  'salesforce': { careers_domain: 'careers.salesforce.com' }, 'oracle': { workday_tenant: 'oracle.wd3', workday_site: 'Oracle' },
  'ibm': { careers_domain: 'careers.ibm.com' }, 'visa': { workday_tenant: 'visa.wd1', workday_site: 'Visa' },
  'mastercard': { workday_tenant: 'mastercard.wd1', workday_site: 'mastercard_careers' },
  'jpmorgan': { careers_domain: 'careers.jpmorgan.com' }, 'jpmorgan chase': { careers_domain: 'careers.jpmorgan.com' },
  'walmart': { workday_tenant: 'walmart.wd5', workday_site: 'WalmartExternal' },
  'target': { workday_tenant: 'target.wd5', workday_site: 'targetcareers' },
  'uber': { careers_domain: 'uber.com/careers' }, 'adobe': { workday_tenant: 'adobe.wd5', workday_site: 'external_experienced' },
  'sap': { careers_domain: 'jobs.sap.com' }, 'intel': { workday_tenant: 'intel.wd1', workday_site: 'external' },
  'flipkart': { careers_domain: 'flipkartcareers.com' }, 'infosys': { careers_domain: 'infosys.com/careers' },
  'tcs': { careers_domain: 'tcs.com/careers' }, 'wipro': { careers_domain: 'careers.wipro.com' },
};
function cohortSiteQuery(company) {
  const k = String(company || '').toLowerCase().trim();
  const t = COHORT_TARGETS[k];
  if (!t) return null;
  if (t.careers_domain) return 'site:' + t.careers_domain;
  if (t.workday_tenant) return 'site:' + t.workday_tenant + '.myworkdayjobs.com';
  return null;
}
result.company_cohort = parsed.company_cohort || null;
result.target_companies = Array.isArray(parsed.target_companies) ? parsed.target_companies.slice(0, 12) : [];
if (result.target_companies.length) {
  const role0 = (result.role_families || [])[0] || '';
  const perCompany = [];
  for (const co of result.target_companies) {
    const site = cohortSiteQuery(co);
    perCompany.push(site ? (site + ' "' + role0 + '"') : ('"' + co + '" "' + role0 + '"'));
  }
  result.serper_queries = perCompany.slice(0, 8);
  result.youcom_queries = perCompany.slice(0, 8);
}`;

const PARSE_ANCHOR_OLD = String.raw`sd.last_search_intent = result;`;
const PARSE_ANCHOR_NEW = COHORT_TABLE + '\nsd.last_search_intent = result;';

// ── 3) Build Serper/You.com Queries: raise caps + prefer cohort queries ──
const SERPER_CAP_OLD = 'return queries.slice(0, 4).map(q => ({ json: { _disabled: false, query: q } }));';
const SERPER_CAP_NEW = String.raw`const _cap = (ctx.target_companies || []).length ? 8 : 4;
return queries.slice(0, _cap).map(q => ({ json: { _disabled: false, query: q } }));`;

const YOUCOM_CAP_OLD = 'return queries.slice(0, 6).map(q => ({ json: { _disabled: false, query: q } }));';
const YOUCOM_CAP_NEW = String.raw`const _cap = (ctx.target_companies || []).length ? 8 : 6;
return queries.slice(0, _cap).map(q => ({ json: { _disabled: false, query: q } }));`;

// ── 4) Aggregate Jobs: post-filter to the named cohort ──
const AGG_ANCHOR_OLD = String.raw`let filtered = allJobs;`;
const AGG_ANCHOR_NEW = String.raw`let filtered = allJobs;

// WS3: cohort-scoped search -- keep only jobs whose company fuzzy-matches the
// LLM-named target list (normalize case/punct; substring match both ways so
// "JPMorgan Chase & Co." matches target "JPMorgan").
const targetCompanies = expandCtx.target_companies || [];
if (targetCompanies.length) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const targets = targetCompanies.map(norm).filter(Boolean);
  filtered = filtered.filter((j) => {
    const c = norm(j.company);
    if (!c) return false;
    return targets.some((t) => c.includes(t) || t.includes(c));
  });
}`;

// ── harness: prove the cohort table, query rewrite, and Aggregate filter work ──
(function harness() {
  const parseFn = new Function('parsed', 'sd', 'result',
    COHORT_TABLE + '\nreturn result;');
  const result = { role_families: ['ML Engineer', 'AI Engineer'], serper_queries: ['old q1'], youcom_queries: ['old q2'] };
  const out = parseFn({ company_cohort: 'faang', target_companies: ['Meta', 'Amazon', 'Netflix', 'Unknown Startup Co'] }, {}, result);
  if (out.company_cohort !== 'faang' || out.target_companies.length !== 4) { console.error('HARNESS FAIL: cohort fields not passed through'); process.exit(1); }
  if (!out.serper_queries.some((q) => q.includes('site:metacareers.com'))) { console.error('HARNESS FAIL: Meta site query missing:', out.serper_queries); process.exit(1); }
  if (!out.serper_queries.some((q) => q.includes('site:amazon.jobs'))) { console.error('HARNESS FAIL: Amazon site query missing'); process.exit(1); }
  if (!out.serper_queries.some((q) => q.includes('"Unknown Startup Co"'))) { console.error('HARNESS FAIL: unknown company should fall back to quoted-name query'); process.exit(1); }
  if (out.serper_queries.length > 8 || out.youcom_queries.length > 8) { console.error('HARNESS FAIL: cap exceeded'); process.exit(1); }

  // no cohort -> passthrough, old queries untouched
  const noCohort = parseFn({ company_cohort: null, target_companies: [] }, {}, { role_families: [], serper_queries: ['keep me'], youcom_queries: ['keep me too'] });
  if (noCohort.serper_queries[0] !== 'keep me' || noCohort.target_companies.length !== 0) { console.error('HARNESS FAIL: no-cohort path mutated queries'); process.exit(1); }

  // cap logic
  const capped = new Function('queries', 'ctx', SERPER_CAP_NEW)(['a','b','c','d','e','f','g','h','i','j'], { target_companies: ['x'] });
  if (capped.length !== 8) { console.error('HARNESS FAIL: serper cohort cap should be 8, got', capped.length); process.exit(1); }
  const uncapped = new Function('queries', 'ctx', SERPER_CAP_NEW)(['a','b','c','d','e','f','g','h','i','j'], { target_companies: [] });
  if (uncapped.length !== 4) { console.error('HARNESS FAIL: serper default cap should be 4, got', uncapped.length); process.exit(1); }

  // Aggregate post-filter
  const aggFn = new Function('allJobs', 'expandCtx',
    'let filtered = allJobs;\n' + AGG_ANCHOR_NEW.split(AGG_ANCHOR_OLD).join('') + '\nreturn filtered;');
  const jobs = [
    { company: 'Meta Platforms Inc.', title: 'ML Engineer' },
    { company: 'JPMorgan Chase & Co.', title: 'Data Scientist' },
    { company: 'RandomStartup', title: 'ML Engineer' },
  ];
  const filteredJpmc = aggFn(jobs, { target_companies: ['JPMorgan', 'Meta'] });
  if (filteredJpmc.length !== 2 || filteredJpmc.some((j) => j.company === 'RandomStartup')) {
    console.error('HARNESS FAIL: cohort post-filter wrong:', JSON.stringify(filteredJpmc)); process.exit(1);
  }
  const filteredNone = aggFn(jobs, { target_companies: [] });
  if (filteredNone.length !== 3) { console.error('HARNESS FAIL: empty target_companies must not filter'); process.exit(1); }

  console.log('HARNESS OK: cohort prompt fields, per-company query rewrite, cap logic, Aggregate post-filter verified');
})();

function editCode(wf, base, nodeName, pairs) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) { console.error(`INTEGRITY FAIL ${base}: node "${nodeName}" not found`); process.exit(1); }
  for (const [oldS, newS] of pairs) {
    const parts = node.parameters.jsCode.split(oldS);
    if (parts.length !== 2) {
      if (node.parameters.jsCode.includes(newS)) { console.log(`  ${base}: ${nodeName} already patched`); continue; }
      console.error(`INTEGRITY FAIL ${base}: "${nodeName}" target found ${parts.length - 1}x (want 1): ${oldS.slice(0, 80)}`);
      process.exit(1);
    }
    node.parameters.jsCode = parts.join(newS);
  }
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);

  // Expand Query system prompt (chainLlm messages array)
  const eq = wf.nodes.find((n) => n.name === 'Expand Query');
  if (!eq) { console.error(`INTEGRITY FAIL ${base}: Expand Query not found`); process.exit(1); }
  const msg = eq.parameters.messages.messageValues[0];
  if (msg.message.includes('company_cohort')) {
    console.log(`  ${base}: Expand Query already patched`);
  } else {
    const parts = msg.message.split(PROMPT_OLD);
    if (parts.length !== 2) { console.error(`INTEGRITY FAIL ${base}: Expand Query prompt anchor not found`); process.exit(1); }
    msg.message = parts.join(PROMPT_NEW);
  }

  editCode(wf, base, 'Parse Expand Query', [[PARSE_ANCHOR_OLD, PARSE_ANCHOR_NEW]]);
  editCode(wf, base, 'Build Serper Queries', [[SERPER_CAP_OLD, SERPER_CAP_NEW]]);
  editCode(wf, base, 'Build You.com Queries', [[YOUCOM_CAP_OLD, YOUCOM_CAP_NEW]]);
  editCode(wf, base, 'Aggregate Jobs', [[AGG_ANCHOR_OLD, AGG_ANCHOR_NEW]]);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: cohort expansion (prompt + Parse Expand Query + query caps + Aggregate filter) -- ${wf.nodes.length} nodes`);
}

TARGETS.forEach(patch);
console.log('S15 (cohort expansion) complete.');
