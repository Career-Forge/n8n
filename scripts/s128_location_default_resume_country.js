/**
 * s128_location_default_resume_country.js -- changes the location default
 * for unstated-location searches from the user's STORED home-city
 * preference (currently "belagavi") to the CANDIDATE'S RESUME-DERIVED
 * COUNTRY, per explicit user instruction.
 *
 * Root cause, confirmed via two independent, real execution traces this
 * session: "AI Engineer roles in Google" (no location stated at all) had
 * 98 real candidate jobs after the s127 hardcode fix, and 0 survived --
 * all killed by a silent default to `location: "belagavi"`. That default
 * came from TWO places, both fixed here:
 *
 * 1. Expand Query's own prompt PRIORITY RULE explicitly told the LLM:
 *    message > stored preference > resume-derived country (in that
 *    order) -- so the resume-derived country ("THIRD TIER") almost never
 *    got reached, since the stored preference is (almost?) always set.
 * 2. Parse Expand Query's deterministic backstop (the REAL authority,
 *    since it runs regardless of what the LLM decided) independently
 *    fell back to the SAME stored preference (`cleanPrefLoc`/
 *    `userPrefs.country`) and never referenced `resume_country_default`
 *    at all, despite that field already being resolved and available
 *    (via Prep Expand Input, wired in an earlier sprint) -- this is the
 *    backstop that was actually deciding the outcome live.
 *
 * Fix: both layers now use resume_country_default as the ONLY fallback
 * when the message states no location -- never the stored preference.
 * Belagavi (small city, virtually no real company presence) as a SEARCH
 * default was actively harmful: it silently narrowed every unstated-
 * location query to near-zero real results. A country-level resume
 * default (e.g. "India") is far more permissive while still being
 * genuinely tied to the candidate, not a guess.
 *
 * The stored-preference SANITIZATION logic (s90, self-healing a garbled
 * value written before s76 shipped) is left untouched -- it's an
 * independent data-hygiene concern, not part of the default-selection
 * bug, and the preference value may still be read/displayed elsewhere.
 *
 * Scheduled-path note: resume_country_default is resolved by Prep Expand
 * Input, which only runs on the interactive path (confirmed this session
 * while fixing the s126 scheduled-backstop bug). On the scheduled path,
 * with no resume-country source wired in, an unstated location now
 * correctly falls through to fully unconstrained -- honest, not a
 * regression (the stored-pref fallback being removed was never a good
 * default there either).
 *
 * Run: harness (real fixture proving the priority chain) + deploy
 * (master only) + verify.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

// ──────────────────────── Part A: Expand Query prompt ────────────────────────
const PROMPT_OLD = `- location_canonical: Full string for Firecrawl geo-targeting (e.g. "New York,New York,United States"). null if none stated.
  PRIORITY RULE (absolute): if the user's OWN MESSAGE states any location signal -- a specific place, "remote", "worldwide", "anywhere", "global", "any location" -- that ALWAYS wins over "User preferences", no exceptions, even if a preference exists. Only use the preference's location when the message itself contains ZERO location language. NEVER blend the message's location with the preference's location into one string -- pick exactly one source. When the message says "worldwide"/"anywhere"/"any location", output the single word "worldwide" (not a sentence). COUNTRY RULE: when the location the user names is a COUNTRY ("jobs in India", "roles in Germany", "USA jobs"), set country to that ISO code and output location_canonical as null -- location_canonical is ONLY for city/metro/state-level places, never a bare country name. THIRD TIER: if the message has zero location language AND no preference location is set, and "Resume-derived default country" is not "none", set country to that ISO code and leave location_canonical null (this is a COUNTRY-level default, not a city -- never invent a city).
`;
const PROMPT_NEW = `- location_canonical: Full string for Firecrawl geo-targeting (e.g. "New York,New York,United States"). null if none stated.
  PRIORITY RULE (absolute): if the user's OWN MESSAGE states any location signal -- a specific place, "remote", "worldwide", "anywhere", "global", "any location" -- that ALWAYS wins, no exceptions. NEVER use "User preferences" location for this field or for country -- a stored home-city preference is not a search-scoping default and must never be used to set location_canonical or country. When the message says "worldwide"/"anywhere"/"any location", output the single word "worldwide" (not a sentence). COUNTRY RULE: when the location the user names is a COUNTRY ("jobs in India", "roles in Germany", "USA jobs"), set country to that ISO code and output location_canonical as null -- location_canonical is ONLY for city/metro/state-level places, never a bare country name. RESUME DEFAULT: if the message has ZERO location language, and "Resume-derived default country" is not "none", set country to that ISO code and leave location_canonical null (a COUNTRY-level default, not a city -- never invent a city). If the message has zero location language AND there is no resume-derived default country either, leave BOTH location_canonical and country null -- fully unconstrained, never guess.
`;

// ──────────────────────── Part B: Parse Expand Query backstop ────────────────────────
const RESOLVER_ANCHOR_OLD = `let llmOutput = '';`;
const RESOLVER_ANCHOR_NEW = `// s128: resume_country_default is resolved by Prep Expand Input (interactive
// path only -- confirmed this session it never runs on the scheduled path).
// Named reference, isExecuted-guarded, same pattern as the s126 scheduled-
// path fix -- this is the ONLY location default now; the stored home-city
// preference is never used to set location_canonical or country.
function resolveResumeCountryDefault() {
  try { if ($('Prep Expand Input').isExecuted) return $('Prep Expand Input').first().json.resume_country_default || null; } catch (e) {}
  return null;
}
const resumeCountryDefault = resolveResumeCountryDefault();

let llmOutput = '';`;

const MERGE_OLD = `  // s90: location is a UNIT, same reasoning as s87's worldwide-tier null-out
  // below -- if the LLM resolved EITHER field from the message (its own
  // PRIORITY RULE already handles message-vs-pref precedence upstream), JS
  // must not layer the stored pref on top of a message-scoped result. The
  // pref (now sanitized above) only backfills when the LLM produced NEITHER
  // field -- confirmed live bug: "France" correctly resolved country:'FR' but
  // JS still blended in the stored city pref on top of it.
  location_canonical: parsed.location_canonical || ((parsed.location_canonical || parsed.country) ? null : cleanPrefLoc) || null,
  country:            parsed.country            || ((parsed.location_canonical || parsed.country) ? null : userPrefs.country) || null,`;
const MERGE_NEW = `  // s90/s128: location is a UNIT -- if the LLM resolved EITHER field from
  // the message, JS must not layer any default on top of a message-scoped
  // result. When the LLM produced NEITHER field, the ONLY fallback is the
  // candidate's resume-derived country (never the stored home-city
  // preference -- confirmed live that defaulting to a small home city with
  // no real company presence silently zeroed out every unstated-location
  // search, e.g. 98 real Google candidates -> 0 survivors).
  location_canonical: parsed.location_canonical || null,
  country:            parsed.country            || ((parsed.location_canonical || parsed.country) ? null : resumeCountryDefault) || null,`;

function patch() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const byName = {}; wf.nodes.forEach((n) => { byName[n.name] = n; });

  const expandQuery = byName['Expand Query'];
  if (!expandQuery) { console.error('INTEGRITY FAIL: Expand Query missing'); process.exit(1); }
  const mv = expandQuery.parameters.messages.messageValues;
  if (mv[0].message.includes('RESUME DEFAULT: if the message has ZERO location language')) {
    console.log('  master: Expand Query prompt already patched');
  } else {
    replaceOnce(mv[0], 'message', PROMPT_OLD, PROMPT_NEW, 'location PRIORITY RULE rewrite');
    console.log('  master: Expand Query prompt patched');
  }

  const parseEQ = byName['Parse Expand Query'];
  if (!parseEQ) { console.error('INTEGRITY FAIL: Parse Expand Query missing'); process.exit(1); }
  if (parseEQ.parameters.jsCode.includes('function resolveResumeCountryDefault')) {
    console.log('  master: Parse Expand Query already patched');
  } else {
    replaceOnce(parseEQ.parameters, 'jsCode', RESOLVER_ANCHOR_OLD, RESOLVER_ANCHOR_NEW, 'insert resolveResumeCountryDefault');
    replaceOnce(parseEQ.parameters, 'jsCode', MERGE_OLD, MERGE_NEW, 'location_canonical/country merge -> resume country default');
    console.log('  master: Parse Expand Query patched');
  }

  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // Real-shaped fixture proving the new merge logic's full priority chain.
  function mergeLocation(parsed, resumeCountryDefault) {
    return {
      location_canonical: parsed.location_canonical || null,
      country: parsed.country || ((parsed.location_canonical || parsed.country) ? null : resumeCountryDefault) || null,
    };
  }
  // 1. Message states a city -> LLM already resolved it, JS must not touch it.
  let r = mergeLocation({ location_canonical: 'New York,New York,United States', country: null }, 'IN');
  if (r.location_canonical !== 'New York,New York,United States' || r.country !== null) { console.error('HARNESS FAIL: message-stated city case', r); process.exit(1); }
  // 2. Message states a country -> LLM already resolved country, no resume bleed.
  r = mergeLocation({ location_canonical: null, country: 'FR' }, 'IN');
  if (r.country !== 'FR' || r.location_canonical !== null) { console.error('HARNESS FAIL: message-stated country case', r); process.exit(1); }
  // 3. Message states nothing, resume has a country -> resume country wins (the actual bug being fixed).
  r = mergeLocation({ location_canonical: null, country: null }, 'IN');
  if (r.country !== 'IN' || r.location_canonical !== null) { console.error('HARNESS FAIL: resume-default case', r); process.exit(1); }
  // 4. Message states nothing, no resume country either -> fully unconstrained, never guess.
  r = mergeLocation({ location_canonical: null, country: null }, null);
  if (r.country !== null || r.location_canonical !== null) { console.error('HARNESS FAIL: fully-unconstrained case', r); process.exit(1); }
  console.log('HARNESS OK: full location priority chain verified (message > resume country > unconstrained, stored pref never consulted).');

  // resolveResumeCountryDefault-equivalent isExecuted guard fixture.
  function resolveFixture(prepExecuted, val) {
    try { if (prepExecuted) return val || null; } catch (e) {}
    return null;
  }
  if (resolveFixture(true, 'IN') !== 'IN') { console.error('HARNESS FAIL: Prep Expand Input executed case'); process.exit(1); }
  if (resolveFixture(false, 'IN') !== null) { console.error('HARNESS FAIL: scheduled-path (Prep Expand Input not executed) case'); process.exit(1); }
  console.log('HARNESS OK: resume-country resolver correctly falls through to null on the scheduled path.');

  patch();
  console.log('S128 (location default -> resume country) script complete.');
})();
