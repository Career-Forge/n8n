/**
 * s100_h1b_workauth_scoring.js -- Phase C of the semi-RAG reference-data
 * wave. Wires data/reference/h1b_sponsors.json (84,925 employers, USCIS
 * FY2021-2023, public domain) into workauth scoring, gated tightly: ONLY
 * when the user explicitly signaled a sponsorship need (visa_signals
 * mentions h1b/sponsor, or sponsorship_required is set) AND the search is
 * US-scoped. Zero behavior change for every other search.
 *
 * Build Scorer Input: attaches a per-job `h1b: {name, appr, fy} | null`
 * field via the same normalized-name lookup build_reference_data.js/
 * seed_company_tier_weights.js already use, only computed when the gate
 * above is true (file isn't even read otherwise).
 *
 * JobScorer prompt: gains a rule telling it to use the h1b field as the
 * PRIMARY workauth signal when present, instead of the generic large-
 * company heuristic.
 *
 * Parse Scorer Output: a CODE-LEVEL floor on workauth_score when h1b data
 * is present -- same s82 precedent this codebase already established
 * ("LLM booleans/scores wired to hard filters wobble across backends;
 * never trust the LLM alone on a numeric floor"). appr >= 50 -> floor 85;
 * 1-49 -> floor 65; explicit need stated + no H1B record found at all ->
 * cap 40 (a real signal this employer has never sponsored, not neutral).
 *
 * No node count change (3 existing nodes). Run: inside the n8n container
 * with the repo staged under /tmp. Re-export prompts/JobScorer.md via
 * scripts/export_prompts.js after this deploys.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Build Scorer Input: per-job h1b field, tightly gated ═══
const JOBBATCH_OLD = `const jobBatch = jobs.slice(0, 30).map(j => ({
  job_id: j.job_id, title: j.title, company: j.company, location: j.location,
  department: j.department, url: j.url, description_snippet: j.description_snippet,
  source: j.source, source_tier: j.source_tier, source_tier_label: j.source_tier_label || j.tier_label,
  required_yoe_min: j.required_yoe_min ?? null, required_yoe_max: j.required_yoe_max ?? null,
  yoe_compat_score: j.yoe_compat_score ?? null,
  salary_min: j.salary_min ?? null, salary_max: j.salary_max ?? null, salary_currency: j.salary_currency || null,
  // s98: without this, Parse Scorer Output's jobById never sees Aggregate
  // Jobs' gazetteer-grounded location_verified (s96) -- it was silently
  // dropped by this whitelist mapping, which would have made the score100
  // location-dim fix downstream a complete no-op.
  location_verified: j.location_verified ?? null
}));`;
const JOBBATCH_NEW = `// s100: H1B lookup, gated tightly -- ONLY when the candidate explicitly
// stated a sponsorship need AND the search is US-scoped. The file isn't
// even read otherwise, so this is a true zero-cost no-op for every other
// search. Mirrors build_reference_data.js/seed_company_tier_weights.js's
// normalizer -- keep in sync if any of those change.
// NOTE: the shared '_eq' variable this node also uses is declared further
// DOWN in this file (after jobBatch, for requested_location/etc.) -- a
// temporal-dead-zone bug caught by testing before this shipped. This block
// does its own independent lookup rather than depending on that later
// declaration.
let _eqForH1b = {}; try { _eqForH1b = $('Parse Expand Query').first().json || {}; } catch (e) {}
const _needsSponsorship = !!_eqForH1b.sponsorship_required || (_eqForH1b.visa_signals || []).some((v) => /h1b|h-1b|sponsor/i.test(String(v)));
const _isUsScoped = _eqForH1b.country === 'US';
let H1B_DATA = null;
if (_needsSponsorship && _isUsScoped) {
  try { H1B_DATA = JSON.parse(require('fs').readFileSync('/home/node/.n8n-files/companies/reference/h1b_sponsors.json', 'utf8')).sponsors || {}; } catch (e) { H1B_DATA = null; }
}
const H1B_NAME_SUFFIX_RX = /\\b(incorporated|corporation|company|limited|holdings?|group|llc|inc|corp|co|ltd|llp|plc|gmbh|ag|sa|nv|bv)\\b\\.?/g;
function normalizeH1bCompanyName(raw) { return String(raw || '').toLowerCase().replace(/&/g, 'and').replace(/[.,'"()]/g, '').replace(H1B_NAME_SUFFIX_RX, '').replace(/\\s+/g, ' ').trim(); }
function h1bLookup(companyName) { if (!H1B_DATA) return null; return H1B_DATA[normalizeH1bCompanyName(companyName)] || null; }
const jobBatch = jobs.slice(0, 30).map(j => ({
  job_id: j.job_id, title: j.title, company: j.company, location: j.location,
  department: j.department, url: j.url, description_snippet: j.description_snippet,
  source: j.source, source_tier: j.source_tier, source_tier_label: j.source_tier_label || j.tier_label,
  required_yoe_min: j.required_yoe_min ?? null, required_yoe_max: j.required_yoe_max ?? null,
  yoe_compat_score: j.yoe_compat_score ?? null,
  salary_min: j.salary_min ?? null, salary_max: j.salary_max ?? null, salary_currency: j.salary_currency || null,
  // s98: without this, Parse Scorer Output's jobById never sees Aggregate
  // Jobs' gazetteer-grounded location_verified (s96) -- it was silently
  // dropped by this whitelist mapping, which would have made the score100
  // location-dim fix downstream a complete no-op.
  location_verified: j.location_verified ?? null,
  // s100: null unless the sponsorship-need + US-scoped gate above is true.
  h1b: h1bLookup(j.company)
}));`;

// ═══ 2. JobScorer prompt: use h1b as the primary signal when present ═══
const PROMPT_OLD = 'workauth_score: work-authorization fit — if `requested_visa_signals` is non-empty, score against that STATED need explicitly; if empty, fall back to the generic large/established-firm-higher heuristic (unknown → 60). Never invent a sponsorship need the candidate didn\'t state.';
const PROMPT_NEW = 'workauth_score: work-authorization fit — if a job\'s `h1b` field is present (real USCIS H-1B approval data for this employer, only ever populated when the candidate explicitly stated a sponsorship need on a US-scoped search), use its `appr` (approval count) as the PRIMARY signal: higher appr -> higher confidence this employer sponsors. If `h1b` is absent but `requested_visa_signals` is non-empty, score against that STATED need explicitly using your own knowledge. If neither is present, fall back to the generic large/established-firm-higher heuristic (unknown → 60). Never invent a sponsorship need the candidate didn\'t state.';

// ═══ 3. Parse Scorer Output: code-level floor/cap on workauth_score when h1b data is present ═══
const WORKAUTH_OLD = `    workauth: _clamp(s.workauth_score != null ? s.workauth_score : base),`;
const WORKAUTH_NEW = `    // s100: code-level floor/cap when real H1B data is available for this
    // job's company -- same s82 precedent this codebase already established
    // (never trust the LLM alone on a numeric floor once a hard signal
    // exists; a retry can land on a different backend with different
    // compliance). appr >= 50 -> floor 85 (clearly sponsors at scale);
    // 1-49 -> floor 65 (some real history); explicit need stated + no H1B
    // record found at all -> cap 40 (a real signal, not neutral).
    workauth: (() => {
      const llmScore = _clamp(s.workauth_score != null ? s.workauth_score : base);
      if (job.h1b === null && (_eq.sponsorship_required || (_eq.visa_signals || []).some((v) => /h1b|h-1b|sponsor/i.test(String(v)))) && _eq.country === 'US') return Math.min(llmScore, 40);
      if (job.h1b && job.h1b.appr >= 50) return Math.max(llmScore, 85);
      if (job.h1b && job.h1b.appr >= 1) return Math.max(llmScore, 65);
      return llmScore;
    })(),`;

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.split(oldStr).join(newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  const required = ['Build Scorer Input', 'JobScorer', 'Parse Scorer Output'];
  for (const r of required) { if (!N[r]) { console.error(`INTEGRITY FAIL ${base}: node "${r}" not found`); process.exit(1); } }
  if (N['Build Scorer Input'].parameters.jsCode.includes('s100:')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Scorer Input'].parameters, 'jsCode', JOBBATCH_OLD, JOBBATCH_NEW, 'h1b lookup + jobBatch field', base);
  replaceOnce(N['JobScorer'].parameters.messages.messageValues[0], 'message', PROMPT_OLD, PROMPT_NEW, 'workauth_score h1b prompt rule', base);
  replaceOnce(N['Parse Scorer Output'].parameters, 'jsCode', WORKAUTH_OLD, WORKAUTH_NEW, 'workauth code-level floor/cap', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: H1B sponsor data wired into workauth scoring, gated on explicit US+sponsorship signals -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  const H1B = JSON.parse(fs.readFileSync('/Users/pkowadkar/Projects/n8n/data/reference/h1b_sponsors.json', 'utf8')).sponsors;
  const NAME_SUFFIX_RX = /\b(incorporated|corporation|company|limited|holdings?|group|llc|inc|corp|co|ltd|llp|plc|gmbh|ag|sa|nv|bv)\b\.?/g;
  function normalize(raw) { return String(raw || '').toLowerCase().replace(/&/g, 'and').replace(/[.,'"()]/g, '').replace(NAME_SUFFIX_RX, '').replace(/\s+/g, ' ').trim(); }
  function h1bLookup(name) { return H1B[normalize(name)] || null; }

  // Gate correctness.
  function needsSponsorship(eq) { return !!eq.sponsorship_required || (eq.visa_signals || []).some((v) => /h1b|h-1b|sponsor/i.test(String(v))); }
  if (!needsSponsorship({ visa_signals: ['h1b'] })) { console.error('HARNESS FAIL: h1b visa_signal should trigger the gate'); process.exit(1); }
  if (needsSponsorship({ visa_signals: [] })) { console.error('HARNESS FAIL: no visa signals should not trigger the gate'); process.exit(1); }
  console.log('HARNESS OK: sponsorship-need gate correctly keyed on visa_signals/sponsorship_required');

  // Real lookups.
  const google = h1bLookup('Google');
  if (!google || google.appr < 1000) { console.error('HARNESS FAIL: Google should have a large real H1B approval count', google); process.exit(1); }
  console.log('HARNESS OK: Google resolves to a real large H1B approval count:', google.appr);

  // Workauth floor/cap logic (extracted, same as the patch).
  function workauthFloor(llmScore, h1b, eq) {
    if (h1b === null && needsSponsorship(eq) && eq.country === 'US') return Math.min(llmScore, 40);
    if (h1b && h1b.appr >= 50) return Math.max(llmScore, 85);
    if (h1b && h1b.appr >= 1) return Math.max(llmScore, 65);
    return llmScore;
  }
  const eqUsSponsor = { sponsorship_required: true, country: 'US' };
  if (workauthFloor(20, { appr: 17362, fy: 2023 }, eqUsSponsor) !== 85) { console.error('HARNESS FAIL: high appr should floor to 85 even if LLM said low'); process.exit(1); }
  if (workauthFloor(95, { appr: 17362, fy: 2023 }, eqUsSponsor) !== 95) { console.error('HARNESS FAIL: floor should not pull DOWN a correctly-high LLM score'); process.exit(1); }
  if (workauthFloor(90, null, eqUsSponsor) !== 40) { console.error('HARNESS FAIL: explicit need + no H1B record at all should cap at 40'); process.exit(1); }
  if (workauthFloor(90, null, { sponsorship_required: false, country: 'US' }) !== 90) { console.error('HARNESS FAIL: no explicit need stated should NOT cap -- gate is off, pass through unchanged'); process.exit(1); }
  console.log('HARNESS OK: workauth floor/cap logic -- high appr floors to 85 without lowering a correct high score, explicit need + no record caps at 40, gate-off passes through unchanged');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
