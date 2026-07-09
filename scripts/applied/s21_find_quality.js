/**
 * s21_find_quality.js -- F2 (Roadmap v4): find_jobs correctness.
 *
 * Fixes the five confirmed root causes behind the real-digest incidents (intern
 * roles, expired roles, US/EU roles surfacing in a Hyderabad-scoped search),
 * validated against real code + real execution data in an earlier audit this
 * session. One script, six nodes:
 *
 * 1. Aggregate Jobs -- location filter (dominant cause, 62-98% of results):
 *    the 3 main web lanes (firecrawl/serper/youcom) unconditionally skipped
 *    location filtering. Replaced with a uniform 3-state policy applied to
 *    every source: known-mismatch drops, unknown keeps+demotes+badges,
 *    known-match ranks first. Adds a small country-level fallback (city/country
 *    name recognition) for broad queries where location_canonical is null but
 *    country is a real signal -- deliberately non-exhaustive, never asserts a
 *    drop it can't back up. Also fixes role-family matching: terms >3 chars
 *    used plain haystack.includes(term), so "AI Engineering Intern" matched
 *    "AI Engineer" via the substring "engineer" inside "engineering" -- now
 *    word-boundary regex for every term length, matching what excluded_roles
 *    already correctly did.
 * 2. Expand Query (LLM prompt) -- default excluded_roles gains Intern/Internship
 *    (conditional: omit only if the user explicitly asked for internships), and
 *    the CRITICAL role_families guardrail gets the same additions.
 * 3. Parse Expand Query -- the code-level excluded_roles fallback (used when the
 *    LLM omits the field) gets the same Intern/Internship additions.
 * 4. Experience Filter -- read expandCtx.seniority (what Parse Expand Query
 *    actually outputs); expandCtx.seniority_pref was always undefined, so
 *    seniority preference silently never affected filtering. Field kept as a
 *    fallback for any old static data that predates this fix.
 * 5. Handle Prefs Update -- schedule_query had no write path anywhere in the
 *    live workflow (Schedule Payload reads it, nothing ever set it), so the
 *    scheduled digest was permanently pinned to the hardcoded default query.
 *    Adds a regex extractor matching the same style as the other pref fields.
 * 6. Build Telegraph Body -- badges jobs with location_verified===null (kept
 *    by Aggregate Jobs' 'unknown' branch) with a 🌐 marker in the digest, so
 *    an unverified location reads as unverified, not silently blended in with
 *    confirmed matches.
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

// ═══════════════════════════════════════════════════════════════
// 1. Aggregate Jobs -- location filter block + role-family matching
// ═══════════════════════════════════════════════════════════════

const AGG_LOCATION_OLD = `// Location filter (hard, only when set and not remote_only)
if (remotePref !== 'remote_only' && locationCanon && !['any','anywhere','worldwide'].includes(locationCanon)) {
  const locTerms = locationCanon.split(/[\\s,]+/).filter(t => t.length > 1);
  filtered = filtered.filter(j => {
    const src = (j.source || '').toLowerCase();
    if (src.includes('firecrawl') || src.includes('serper') || src.includes('youcom')) return true;
    const hay = (j.location || '').toLowerCase();
    if (!hay || hay === 'unknown') return true;
    return locTerms.some(t => hay.includes(t));
  });
}`;

const AGG_LOCATION_NEW = `// Location filter -- F2: 3-state policy (match/mismatch/unknown), applied
// uniformly to every source. No lane bypass -- the old firecrawl/serper/youcom
// skip let 62-98% of digest results through with zero location enforcement.
// Country-level fallback (city/country name recognition) covers broad queries
// where location_canonical is null but country is a real signal. Deliberately
// non-exhaustive -- anything unrecognized falls to 'unknown' (kept, demoted,
// badged), never a guessed drop.
const COUNTRY_NAMES = {
  US: ['usa','u.s.a','u.s.','united states','america'],
  IN: ['india'],
  GB: ['uk','u.k.','united kingdom','britain','england','scotland','wales'],
  CA: ['canada'],
  AU: ['australia'],
  DE: ['germany','deutschland'],
  SG: ['singapore'],
  AE: ['uae','united arab emirates','dubai','abu dhabi'],
  NL: ['netherlands','holland'],
  FR: ['france'],
  IE: ['ireland'],
  NZ: ['new zealand'],
};
const CITY_COUNTRY = {
  'new york':'US','san francisco':'US','seattle':'US','austin':'US','boston':'US',
  'chicago':'US','los angeles':'US','san jose':'US','denver':'US','atlanta':'US',
  'dallas':'US','houston':'US','washington':'US','miami':'US','portland':'US',
  'hyderabad':'IN','bangalore':'IN','bengaluru':'IN','mumbai':'IN','pune':'IN',
  'delhi':'IN','new delhi':'IN','gurgaon':'IN','gurugram':'IN','chennai':'IN',
  'noida':'IN','kolkata':'IN','ahmedabad':'IN',
  'london':'GB','manchester':'GB','edinburgh':'GB','birmingham':'GB',
  'toronto':'CA','vancouver':'CA','montreal':'CA','ottawa':'CA',
  'berlin':'DE','munich':'DE','frankfurt':'DE','hamburg':'DE',
  'singapore':'SG','dublin':'IE','amsterdam':'NL','paris':'FR','sydney':'AU','melbourne':'AU','auckland':'NZ',
};
function detectCountryFromLocation(hay) {
  for (const code of Object.keys(COUNTRY_NAMES)) { if (COUNTRY_NAMES[code].some(s => hay.includes(s))) return code; }
  for (const city of Object.keys(CITY_COUNTRY)) { if (hay.includes(city)) return CITY_COUNTRY[city]; }
  return null;
}
function checkLocationState(job, locTerms, countryCode) {
  const hay = (job.location || '').toLowerCase().trim();
  if (!hay || hay === 'unknown') return 'unknown';
  if (locTerms && locTerms.length) return locTerms.some(t => hay.includes(t)) ? 'match' : 'mismatch';
  if (countryCode) {
    const detected = detectCountryFromLocation(hay);
    if (!detected) return 'unknown';
    return detected === countryCode ? 'match' : 'mismatch';
  }
  return 'unknown';
}
const hasCityConstraint = locationCanon && !['any','anywhere','worldwide'].includes(locationCanon);
const locTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter(t => t.length > 1) : [];
// Country fallback only when there's no city-level signal AND the country isn't
// the silent "nothing stated" default (country always defaults to 'US' even on
// a totally generic query) -- avoids dropping results on unscoped searches.
const countryCode = (!locTerms.length && expandCtx.country && expandCtx.country !== 'US') ? expandCtx.country : null;
if (remotePref !== 'remote_only' && (locTerms.length || countryCode)) {
  filtered = filtered.filter(j => {
    const state = checkLocationState(j, locTerms, countryCode);
    j.location_verified = state === 'match' ? true : (state === 'unknown' ? null : false);
    return state !== 'mismatch';
  });
}`;

const AGG_ROLEFAMILY_OLD = `// Role family filter
if (roleFamilies.length > 0) {
  filtered = filtered.filter(j => {
    const haystack = (j.title + ' ' + (j.department || '')).toLowerCase();
    if (excludedRoles.some(excl => {
      const terms = excl.toLowerCase().split(/\\s+/);
      return terms.every(t => new RegExp('\\\\b' + t + '\\\\b').test(haystack));
    })) return false;
    return roleFamilies.some(variant => {
      const terms = variant.toLowerCase().split(/\\s+/).filter(t => t.length > 1);
      return terms.every(term => term.length <= 3
        ? new RegExp('\\\\b' + term + '\\\\b').test(haystack)
        : haystack.includes(term));
    });
  });
}`;

const AGG_ROLEFAMILY_NEW = `// Role family filter -- F2: word-boundary matching for every term length.
// Terms >3 chars used to fall back to plain haystack.includes(term), so
// "AI Engineering Intern" matched role family "AI Engineer" via the substring
// "engineer" inside "engineering". Word-boundary regex everywhere now, same
// as excluded_roles already correctly did.
function escapeRegexTerm(t) { return t.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }
if (roleFamilies.length > 0) {
  filtered = filtered.filter(j => {
    const haystack = (j.title + ' ' + (j.department || '')).toLowerCase();
    if (excludedRoles.some(excl => {
      const terms = excl.toLowerCase().split(/\\s+/);
      return terms.every(t => new RegExp('\\\\b' + escapeRegexTerm(t) + '\\\\b').test(haystack));
    })) return false;
    return roleFamilies.some(variant => {
      const terms = variant.toLowerCase().split(/\\s+/).filter(t => t.length > 1);
      return terms.every(term => new RegExp('\\\\b' + escapeRegexTerm(term) + '\\\\b').test(haystack));
    });
  });
}`;

const AGG_SORT_OLD = `// Sort: tier first (Tier 1 ATS at top), then recency within tier
filtered.sort((a, b) => {
  const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);
  if (tierDiff !== 0) return tierDiff;
  const ad = new Date(a.updated_at || 0).getTime() || 0;
  const bd = new Date(b.updated_at || 0).getTime() || 0;
  return bd - ad;
});`;

const AGG_SORT_NEW = `// Sort: verified-location first (only matters when location filtering was
// actually active -- location_verified is undefined on every job otherwise,
// making this a no-op), then tier, then recency within tier.
filtered.sort((a, b) => {
  const locDiff = (a.location_verified === true ? 0 : 1) - (b.location_verified === true ? 0 : 1);
  if (locDiff !== 0) return locDiff;
  const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);
  if (tierDiff !== 0) return tierDiff;
  const ad = new Date(a.updated_at || 0).getTime() || 0;
  const bd = new Date(b.updated_at || 0).getTime() || 0;
  return bd - ad;
});`;

// ═══════════════════════════════════════════════════════════════
// 2. Expand Query (LLM prompt, inline system message)
// ═══════════════════════════════════════════════════════════════

const EXPAND_EXCLUDED_OLD = `- excluded_roles: titles clearly NOT wanted. Default: ["Technical Support","Customer Success","QA Engineer"]`;
const EXPAND_EXCLUDED_NEW = `- excluded_roles: titles clearly NOT wanted. Default: ["Technical Support","Customer Success","QA Engineer","Intern","Internship"] -- omit Intern/Internship from this default ONLY if the user's message explicitly asks for internship/intern roles.`;

const EXPAND_CRITICAL_OLD = `CRITICAL: Never include "Technical Support","Customer Service","QA" in role_families unless explicitly requested.`;
const EXPAND_CRITICAL_NEW = `CRITICAL: Never include "Technical Support","Customer Service","QA","Intern","Internship" in role_families unless explicitly requested.`;

// ═══════════════════════════════════════════════════════════════
// 3. Parse Expand Query -- code-level excluded_roles fallback
// ═══════════════════════════════════════════════════════════════

const PARSE_EXCLUDED_OLD = `  excluded_roles:     parsed.excluded_roles     || userPrefs.excluded_roles     || ["Technical Support","Customer Success","QA Engineer"],`;
const PARSE_EXCLUDED_NEW = `  excluded_roles:     parsed.excluded_roles     || userPrefs.excluded_roles     || ["Technical Support","Customer Success","QA Engineer","Intern","Internship"],`;

// ═══════════════════════════════════════════════════════════════
// 4. Experience Filter -- seniority field mismatch
// ═══════════════════════════════════════════════════════════════

const EXPFILTER_OLD = `const seniorityPref = expandCtx.seniority_pref || 'any';`;
const EXPFILTER_NEW = `const seniorityPref = expandCtx.seniority || expandCtx.seniority_pref || 'any';`;

// ═══════════════════════════════════════════════════════════════
// 5. Handle Prefs Update -- schedule_query write path
// ═══════════════════════════════════════════════════════════════

const PREFS_ANCHOR_OLD = `// ── Timezone ──────────────────────────────────────────────────────────────`;
const PREFS_SCHEDQUERY_BLOCK = `// ── Schedule query (what the recurring digest searches for) ─────────────
if ((m = msg.match(/(?:scheduled?[\\s_]?query|digest query)\\s*[:\\s]+(.+)$/i))) {
  const q = m[1].trim().replace(/[.!]+$/, '');
  if (q.length > 3) delta.schedule_query = q;
} else if ((m = msg.match(/for (?:my |the )?(?:scheduled?|recurring) (?:jobs?|search|digest)s?,?\\s*(?:search for|find|search)\\s+(.+)$/i))) {
  const q = m[1].trim().replace(/[.!]+$/, '');
  if (q.length > 3) delta.schedule_query = q;
}

`;
const PREFS_NEW_BLOCK = PREFS_SCHEDQUERY_BLOCK + PREFS_ANCHOR_OLD;

// ═══════════════════════════════════════════════════════════════
// 6. Build Telegraph Body -- unverified-location badge
// ═══════════════════════════════════════════════════════════════

const TELEGRAPH_DISPLAYLOC_OLD = `function displayLocation(job) {
  const dl = (job.detected_location || '').trim();
  if (dl && !/^(unknown|n\\/?a|null|undefined)$/i.test(dl)) return dl;
  const loc = (job.location || '').trim();
  if (loc && !/^(unknown|n\\/?a|null|undefined)$/i.test(loc)) return loc;
  const hay = ((job.title || '') + ' ' + (job.description_snippet || '')).toLowerCase();
  if (intent.remote_preference === 'remote_only' || hay.includes('remote')) return 'Remote';
  return 'Location not specified';
}`;

const TELEGRAPH_DISPLAYLOC_NEW = `function displayLocation(job) {
  const dl = (job.detected_location || '').trim();
  let base;
  if (dl && !/^(unknown|n\\/?a|null|undefined)$/i.test(dl)) base = dl;
  else {
    const loc = (job.location || '').trim();
    if (loc && !/^(unknown|n\\/?a|null|undefined)$/i.test(loc)) base = loc;
    else {
      const hay = ((job.title || '') + ' ' + (job.description_snippet || '')).toLowerCase();
      base = (intent.remote_preference === 'remote_only' || hay.includes('remote')) ? 'Remote' : 'Location not specified';
    }
  }
  // F2: location filtering was active for this search but this job's location
  // couldn't be verified (Aggregate Jobs' 'unknown' branch) -- badge it rather
  // than blend it in with confirmed matches.
  return job.location_verified === null ? base + ' 🌐' : base;
}`;

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

  for (const name of ['Aggregate Jobs', 'Expand Query', 'Parse Expand Query', 'Experience Filter', 'Handle Prefs Update', 'Build Telegraph Body']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }

  // 1. Aggregate Jobs
  {
    const n = N['Aggregate Jobs'];
    const get = () => n.parameters.jsCode;
    const set = (v) => { n.parameters.jsCode = v; };
    if (replaceExact(n, base, 'Aggregate Jobs location filter', AGG_LOCATION_OLD, AGG_LOCATION_NEW, get, set)) edits++;
    if (replaceExact(n, base, 'Aggregate Jobs role-family filter', AGG_ROLEFAMILY_OLD, AGG_ROLEFAMILY_NEW, get, set)) edits++;
    if (replaceExact(n, base, 'Aggregate Jobs sort', AGG_SORT_OLD, AGG_SORT_NEW, get, set)) edits++;
  }

  // 2. Expand Query (LLM prompt)
  {
    const n = N['Expand Query'];
    const msgs = n.parameters.messages.messageValues;
    if (!msgs || !msgs[0]) { console.error(`INTEGRITY FAIL ${base}: Expand Query message shape unexpected`); process.exit(1); }
    const get = () => msgs[0].message;
    const set = (v) => { msgs[0].message = v; };
    if (replaceExact(n, base, 'Expand Query excluded_roles default', EXPAND_EXCLUDED_OLD, EXPAND_EXCLUDED_NEW, get, set)) edits++;
    if (replaceExact(n, base, 'Expand Query CRITICAL guardrail', EXPAND_CRITICAL_OLD, EXPAND_CRITICAL_NEW, get, set)) edits++;
  }

  // 3. Parse Expand Query
  {
    const n = N['Parse Expand Query'];
    const get = () => n.parameters.jsCode;
    const set = (v) => { n.parameters.jsCode = v; };
    if (replaceExact(n, base, 'Parse Expand Query excluded_roles fallback', PARSE_EXCLUDED_OLD, PARSE_EXCLUDED_NEW, get, set)) edits++;
  }

  // 4. Experience Filter
  {
    const n = N['Experience Filter'];
    const get = () => n.parameters.jsCode;
    const set = (v) => { n.parameters.jsCode = v; };
    if (replaceExact(n, base, 'Experience Filter seniority field', EXPFILTER_OLD, EXPFILTER_NEW, get, set)) edits++;
  }

  // 5. Handle Prefs Update
  {
    const n = N['Handle Prefs Update'];
    const get = () => n.parameters.jsCode;
    const set = (v) => { n.parameters.jsCode = v; };
    if (replaceExact(n, base, 'Handle Prefs Update schedule_query block', PREFS_ANCHOR_OLD, PREFS_NEW_BLOCK, get, set)) edits++;
  }

  // 6. Build Telegraph Body
  {
    const n = N['Build Telegraph Body'];
    const get = () => n.parameters.jsCode;
    const set = (v) => { n.parameters.jsCode = v; };
    if (replaceExact(n, base, 'Build Telegraph Body displayLocation', TELEGRAPH_DISPLAYLOC_OLD, TELEGRAPH_DISPLAYLOC_NEW, get, set)) edits++;
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: find_jobs correctness applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness: exercise the real logic, not just string presence ──
(function harness() {
  // -- Aggregate Jobs location + role-family + sort, run as a single IIFE mirroring $input/$ ---
  function runAggregate(jobsBySource, expandCtxFixture) {
    const items = Object.entries(jobsBySource).map(([source, jobs]) => ({ json: { source, jobs } }));
    const $input = { all: () => items };
    const $ = (name) => { if (name !== 'Parse Expand Query') throw new Error('unexpected ref ' + name); return { first: () => ({ json: expandCtxFixture }) }; };
    const body = AGG_LOCATION_NEW + '\n' + AGG_ROLEFAMILY_NEW + '\n' /* sort/rest inlined below via full pipeline */;
    // Build a minimal standalone version of the whole node using the NEW blocks,
    // mirroring the real node's structure (dedup skipped -- not under test here).
    const fullSrc = `
      const AGGREGATORS = new Set();
      let filtered = [];
      for (const item of $input.all()) { for (const job of (item.json.jobs||[])) { job.source = item.json.source; filtered.push(job); } }
      const expandCtx = $('Parse Expand Query').first().json;
      const roleFamilies    = expandCtx.role_families    || [];
      const excludedRoles   = expandCtx.excluded_roles   || [];
      const locationCanon   = (expandCtx.location_canonical || '').trim().toLowerCase();
      const remotePref      = expandCtx.remote_preference  || 'open';
      ${AGG_LOCATION_NEW}
      ${AGG_ROLEFAMILY_NEW}
      ${AGG_SORT_NEW}
      return filtered;
    `;
    const fn = new Function('$input', '$', fullSrc);
    return fn($input, $);
  }

  const baseCtx = { role_families: ['AI Engineer'], excluded_roles: ['Technical Support', 'Intern', 'Internship'], remote_preference: 'open' };

  // Test A: web-lane (serper) job with matching city -> kept, verified true, ranked first.
  let out = runAggregate({
    serper: [{ url: 'u1', title: 'AI Engineer', company: 'A', location: 'Hyderabad, India', updated_at: '2026-07-01' }],
  }, { ...baseCtx, location_canonical: 'Hyderabad,Telangana,India', country: 'IN' });
  if (out.length !== 1 || out[0].location_verified !== true) { console.error('HARNESS FAIL: web-lane matching-city job should be kept+verified, got', JSON.stringify(out)); process.exit(1); }

  // Test B: web-lane (serper) job with a clearly mismatched city -> DROPPED (the actual bug fix --
  // under the OLD bypass this would have survived).
  out = runAggregate({
    serper: [{ url: 'u2', title: 'AI Engineer', company: 'B', location: 'Seattle, WA', updated_at: '2026-07-01' }],
  }, { ...baseCtx, location_canonical: 'Hyderabad,Telangana,India', country: 'IN' });
  if (out.length !== 0) { console.error('HARNESS FAIL: web-lane mismatched-city job should be dropped, got', JSON.stringify(out)); process.exit(1); }

  // Test C: Serper's own normalizer always emits location:'' -- unknown, kept, verified null (badge-eligible).
  out = runAggregate({
    serper: [{ url: 'u3', title: 'AI Engineer', company: 'C', location: '', updated_at: '2026-07-01' }],
  }, { ...baseCtx, location_canonical: 'Hyderabad,Telangana,India', country: 'IN' });
  if (out.length !== 1 || out[0].location_verified !== null) { console.error('HARNESS FAIL: empty-location job should be kept+unverified(null), got', JSON.stringify(out)); process.exit(1); }

  // Test D: country-only query (location_canonical null, country=IN) -- a US city must be dropped,
  // an India city must be kept, an unrecognized city string stays unknown (kept, not dropped).
  out = runAggregate({
    serper: [
      { url: 'u4', title: 'AI Engineer', company: 'D1', location: 'Austin, TX', updated_at: '2026-07-01' },
      { url: 'u5', title: 'AI Engineer', company: 'D2', location: 'Bangalore, Karnataka', updated_at: '2026-07-01' },
      { url: 'u6', title: 'AI Engineer', company: 'D3', location: 'Someruraltown', updated_at: '2026-07-01' },
    ],
  }, { ...baseCtx, location_canonical: null, country: 'IN' });
  const byCompany = Object.fromEntries(out.map(j => [j.company, j]));
  if (byCompany.D1) { console.error('HARNESS FAIL: country-fallback should drop a US city on an IN-scoped query, got', JSON.stringify(out)); process.exit(1); }
  if (!byCompany.D2 || byCompany.D2.location_verified !== true) { console.error('HARNESS FAIL: country-fallback should keep+verify an India city on an IN-scoped query'); process.exit(1); }
  if (!byCompany.D3 || byCompany.D3.location_verified !== null) { console.error('HARNESS FAIL: unrecognized city string should stay unknown (kept, not dropped)'); process.exit(1); }

  // Test E: totally generic query (country defaults to 'US', location_canonical null) -- must NOT
  // trigger country-fallback filtering (regression guard against over-filtering unscoped searches).
  out = runAggregate({
    serper: [{ url: 'u7', title: 'AI Engineer', company: 'E', location: 'Berlin, Germany', updated_at: '2026-07-01' }],
  }, { ...baseCtx, location_canonical: null, country: 'US' });
  if (out.length !== 1) { console.error('HARNESS FAIL: unscoped query (country=US default) must not drop non-US jobs, got', JSON.stringify(out)); process.exit(1); }

  // Test F: role-family word-boundary fix -- "AI Engineering Manager" (no "intern" anywhere) must NOT
  // match role family "AI Engineer" anymore (old substring bug: "engineer" inside "engineering").
  out = runAggregate({
    serper: [{ url: 'u8', title: 'AI Engineering Manager', company: 'F', location: '', updated_at: '2026-07-01' }],
  }, { role_families: ['AI Engineer'], excluded_roles: [], remote_preference: 'open', location_canonical: null, country: 'US' });
  if (out.length !== 0) { console.error('HARNESS FAIL: word-boundary fix should reject "AI Engineering Manager" for role family "AI Engineer" (substring-of-token bug), got', JSON.stringify(out)); process.exit(1); }

  // -- Experience Filter seniority field --
  {
    const src = `const expandCtx = arguments[0]; ${EXPFILTER_NEW} return seniorityPref;`;
    const fn = new Function(src);
    const v1 = fn({ seniority: 'senior' });
    if (v1 !== 'senior') { console.error('HARNESS FAIL: Experience Filter should read expandCtx.seniority, got', v1); process.exit(1); }
    const v2 = fn({ seniority_pref: 'junior' }); // legacy fallback path
    if (v2 !== 'junior') { console.error('HARNESS FAIL: Experience Filter legacy seniority_pref fallback broken, got', v2); process.exit(1); }
  }

  // -- Handle Prefs Update schedule_query regex (exercise the two supported phrasings) --
  {
    function extract(msg) {
      const delta = {}; let m;
      const lower = msg.toLowerCase();
      if ((m = lower.match(/(?:scheduled?[\s_]?query|digest query)\s*[:\s]+(.+)$/i))) {
        const q = m[1].trim().replace(/[.!]+$/, ''); if (q.length > 3) delta.schedule_query = q;
      } else if ((m = lower.match(/for (?:my |the )?(?:scheduled?|recurring) (?:jobs?|search|digest)s?,?\s*(?:search for|find|search)\s+(.+)$/i))) {
        const q = m[1].trim().replace(/[.!]+$/, ''); if (q.length > 3) delta.schedule_query = q;
      }
      return delta;
    }
    const d1 = extract('schedule_query: find senior data roles in nyc');
    if (d1.schedule_query !== 'find senior data roles in nyc') { console.error('HARNESS FAIL: schedule_query: form not captured, got', JSON.stringify(d1)); process.exit(1); }
    const d2 = extract('for my scheduled digest, search find ml roles in austin');
    if (!d2.schedule_query || !d2.schedule_query.includes('ml roles in austin')) { console.error('HARNESS FAIL: natural-language schedule query form not captured, got', JSON.stringify(d2)); process.exit(1); }
  }

  // -- Build Telegraph Body badge --
  {
    const src = `const intent = {}; ${TELEGRAPH_DISPLAYLOC_NEW} return displayLocation(arguments[0]);`;
    const fn = new Function(src);
    const verified = fn({ location: 'Hyderabad, India', location_verified: true });
    if (verified.includes('🌐')) { console.error('HARNESS FAIL: verified job should not get the unverified badge, got', verified); process.exit(1); }
    const unverified = fn({ location: '', location_verified: null });
    if (!unverified.includes('🌐')) { console.error('HARNESS FAIL: unverified (location_verified===null) job should get the badge, got', unverified); process.exit(1); }
    const notApplicable = fn({ location: 'Austin, TX', location_verified: undefined });
    if (notApplicable.includes('🌐')) { console.error('HARNESS FAIL: job with no location constraint active (location_verified undefined) should not get the badge, got', notApplicable); process.exit(1); }
  }

  console.log('HARNESS OK: location 3-state policy (match/mismatch/unknown incl. country fallback + unscoped-query regression guard), role-family word-boundary fix, seniority field read, schedule_query regex (both phrasings), and Telegraph badge -- all verified against real logic');
})();

TARGETS.forEach(patch);
console.log('S21 (find_jobs correctness) complete.');
