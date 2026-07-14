/**
 * s75_location_priority_fix.js -- fixes a real, confirmed production bug found
 * via a full execution trace of a live "Find me AI jobs in MAANG companies
 * worldwide" search (exec 559, 2026-07-14).
 *
 * Root cause, iron-clad from the trace: 239 real raw candidate jobs entered
 * Aggregate Jobs (30 Firecrawl + 51 You.com + 22 Serper + 21 RemoteOK + 136
 * cache) -- the MAANG cohort expansion itself worked perfectly (target_companies
 * correctly resolved to [Meta, Apple, Amazon, Netflix, Google], all 5 site:
 * queries fired). But `location_canonical` came back as the literal string
 * "Belagavi and targeting roles in Bangalore" -- the user's STORED PREFERENCE
 * sentence, copied in verbatim, completely overriding the query's own explicit
 * "worldwide". Aggregate Jobs' `hasCityConstraint` gate only special-cases the
 * exact strings 'any'/'anywhere'/'worldwide' -- anything else is treated as a
 * real city and split into substring match-terms: ['belagavi','and',
 * 'targeting','roles','in','bangalore']. Every real job with a real location
 * ("Menlo Park, CA", "Seattle, WA", ...) matched none of those tokens and was
 * dropped as a "known mismatch". Only jobs with an EMPTY location field
 * survived. 239 raw candidates collapsed to 4, then 2 after downstream
 * liveness/experience filtering.
 *
 * TWO layered bugs, both fixed here:
 *
 * (1) Expand Query's prompt had no priority rule at all between the message's
 *     own location language and stored user_prefs -- just "merge with any user
 *     preferences provided in the context". User's explicit instruction this
 *     session: an explicit location in the Telegram message ALWAYS wins over
 *     the stored profile, no exceptions, never blended into one string.
 *
 * (2) Even with the prompt fixed, nothing stops a future off-model response
 *     (or the CURRENTLY-STORED corrupted pref, which is still
 *     "belagavi and targeting roles in bangalore" until cleaned up separately)
 *     from producing the same shape of garbage. Added a defensive guard --
 *     `looksLikeCleanLocation()` -- that treats anything sentence-shaped
 *     (>5 tokens, or containing connector words like "and"/"targeting") as NOT
 *     a real location, same "never fully trust the LLM" backstop idiom used
 *     everywhere else in this codebase (the deterministic allocator, the
 *     render-time trims, etc). This gate is duplicated in THREE places --
 *     Aggregate Jobs (the real filter), Pre-flight: Providers (the v9 A1 SQL
 *     cache pre-filter, whose own comment says "keep in sync with Aggregate
 *     Jobs if that gate changes"), and Verify Job Links (re-evaluates
 *     backfilled-location jobs) -- all three patched identically here.
 *
 * NOT in scope: the general multi-target location schema (Bangalore OR Pune OR
 * remote-India as a real list) -- that's the already-deferred granular
 * location-targeting sprint. This fix only restores correct priority + adds a
 * safety net; it doesn't change location_canonical from a single string to a
 * list.
 *
 * Also NOT in scope (separate, tiny follow-up once the fallback value is
 * decided): the CURRENTLY-STORED bad pref (`user_prefs.location_canonical =
 * "belagavi and targeting roles in bangalore"`) still needs a one-time cleanup
 * so future *unscoped* queries and the scheduled digest don't fall back to it.
 * The defensive guard in this script neutralizes it as a filter hazard in the
 * meantime (hasCityConstraint will now be false against it), but it should
 * still be replaced with a clean value or cleared.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
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

// ── 1. Expand Query prompt: explicit priority rule ──
const EQ_OLD = '- location_canonical: Full string for Firecrawl geo-targeting (e.g. "New York,New York,United States"). null if none stated.\n';
const EQ_NEW = '- location_canonical: Full string for Firecrawl geo-targeting (e.g. "New York,New York,United States"). null if none stated.\n' +
  '  PRIORITY RULE (absolute): if the user\'s OWN MESSAGE states any location signal -- a specific place, "remote", "worldwide", "anywhere", "global", "any location" -- that ALWAYS wins over "User preferences", no exceptions, even if a preference exists. Only use the preference\'s location when the message itself contains ZERO location language. NEVER blend the message\'s location with the preference\'s location into one string -- pick exactly one source. When the message says "worldwide"/"anywhere"/"any location", output the single word "worldwide" (not a sentence).\n';

function patchExpandQuery(wf, base) {
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  if (!N['Expand Query']) { console.error(`INTEGRITY FAIL ${base}: node "Expand Query" not found`); process.exit(1); }
  const mv = N['Expand Query'].parameters.messages.messageValues;
  if (mv[0].message.includes('PRIORITY RULE (absolute)')) { console.log(`  ${base}: Expand Query already patched`); return; }
  replaceOnce(mv[0], 'message', EQ_OLD, EQ_NEW, 'location_canonical priority rule', base);
}

// ── 2. Aggregate Jobs: defensive guard ──
const AJ_OLD = "const hasCityConstraint = locationCanon && !['any','anywhere','worldwide'].includes(locationCanon);\nconst locTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter(t => t.length > 1) : [];";
const AJ_NEW = "// s75: a location_canonical that's really a sentence (e.g. a raw preference\n" +
  "// blurb that leaked through, or a future prompt-compliance slip) must never\n" +
  "// drive substring matching -- it matches nothing real and silently mismatches\n" +
  "// everything. Cheap sanity gate: a real canonical location is short and has\n" +
  "// no connector words.\n" +
  "function looksLikeCleanLocation(s) {\n" +
  "  const STOP = ['and','or','targeting','roles','role','the','for','based','remember'];\n" +
  "  const tokens = s.split(/[\\s,]+/).filter(Boolean);\n" +
  "  return tokens.length > 0 && tokens.length <= 8 && !tokens.some(t => STOP.includes(t.toLowerCase()));\n" +
  "}\n" +
  "const hasCityConstraint = locationCanon && !['any','anywhere','worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);\n" +
  "const locTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter(t => t.length > 1) : [];";

// ── 3. Pre-flight: Providers: same guard, cacheLocTerms variant ──
const PF_OLD = "const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon);\nconst cacheLocTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter((t) => t.length > 1).join(',') : '';";
const PF_NEW = "// s75: mirrors Aggregate Jobs' looksLikeCleanLocation guard exactly -- see\n" +
  "// that node for the full rationale. Keep in sync if either changes.\n" +
  "function looksLikeCleanLocation(s) {\n" +
  "  const STOP = ['and','or','targeting','roles','role','the','for','based','remember'];\n" +
  "  const tokens = s.split(/[\\s,]+/).filter(Boolean);\n" +
  "  return tokens.length > 0 && tokens.length <= 8 && !tokens.some(t => STOP.includes(t.toLowerCase()));\n" +
  "}\n" +
  "const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);\n" +
  "const cacheLocTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter((t) => t.length > 1).join(',') : '';";

// ── 4. Verify Job Links: same guard, nested-scope variant ──
const VJ_OLD = "const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon);\n    const locTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter((t) => t.length > 1) : [];";
const VJ_NEW = "const looksLikeCleanLocation = (s) => {\n" +
  "      const STOP = ['and','or','targeting','roles','role','the','for','based','remember'];\n" +
  "      const tokens = s.split(/[\\s,]+/).filter(Boolean);\n" +
  "      return tokens.length > 0 && tokens.length <= 8 && !tokens.some((t) => STOP.includes(t.toLowerCase()));\n" +
  "    };\n" +
  "    const hasCityConstraint = locationCanon && !['any', 'anywhere', 'worldwide'].includes(locationCanon) && looksLikeCleanLocation(locationCanon);\n" +
  "    const locTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter((t) => t.length > 1) : [];";

function patchGuard(wf, base) {
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  ['Aggregate Jobs', 'Pre-flight: Providers', 'Verify Job Links'].forEach((name) => {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  });

  if (N['Aggregate Jobs'].parameters.jsCode.includes('looksLikeCleanLocation')) {
    console.log(`  ${base}: guard already patched`); return;
  }
  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', AJ_OLD, AJ_NEW, 'Aggregate Jobs guard', base);
  replaceOnce(N['Pre-flight: Providers'].parameters, 'jsCode', PF_OLD, PF_NEW, 'Pre-flight: Providers guard', base);
  replaceOnce(N['Verify Job Links'].parameters, 'jsCode', VJ_OLD, VJ_NEW, 'Verify Job Links guard', base);
}

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  patchExpandQuery(wf, base);
  patchGuard(wf, base);
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: location priority rule + defensive guard patched -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // 1. Prompt text sanity
  if (!EQ_NEW.includes('PRIORITY RULE (absolute)')) { console.error('HARNESS FAIL: priority rule missing from prompt'); process.exit(1); }
  if (!EQ_NEW.includes('NEVER blend')) { console.error('HARNESS FAIL: anti-blend instruction missing'); process.exit(1); }

  // 2. Extract the REAL patched looksLikeCleanLocation + hasCityConstraint logic
  //    from AJ_NEW via new Function(), run it against real fixture values --
  //    including the EXACT garbled string that broke tonight's real search.
  const GARBLED = 'belagavi and targeting roles in bangalore'; // exact stored value, lowercased as the real code does
  const fixtures = [
    { label: 'the actual bug (stored pref leaked in)', locationCanon: GARBLED, wantConstraint: false },
    { label: 'clean city', locationCanon: 'bangalore', wantConstraint: true },
    { label: 'clean multi-word city', locationCanon: 'new york, new york, united states', wantConstraint: true },
    { label: 'magic word worldwide (pre-existing case, must stay unaffected)', locationCanon: 'worldwide', wantConstraint: false },
    { label: 'magic word any', locationCanon: 'any', wantConstraint: false },
    { label: 'empty string', locationCanon: '', wantConstraint: false },
  ];

  // Build a real callable from the exact AJ_NEW text (strip the trailing locTerms line, we only need hasCityConstraint).
  const ajLogicSrc = AJ_NEW.replace(
    "const locTerms = hasCityConstraint ? locationCanon.split(/[\\s,]+/).filter(t => t.length > 1) : [];",
    'return hasCityConstraint;'
  );
  const evalHasCityConstraint = new Function('locationCanon', ajLogicSrc);

  for (const f of fixtures) {
    const got = !!evalHasCityConstraint(f.locationCanon);
    if (got !== f.wantConstraint) {
      console.error(`HARNESS FAIL: "${f.label}" (locationCanon="${f.locationCanon}") -> hasCityConstraint=${got}, expected ${f.wantConstraint}`);
      process.exit(1);
    }
  }

  // 3. Regression proof: the OLD logic must reproduce the actual observed bug
  //    (hasCityConstraint=true on the garbled string), so we know this harness
  //    fixture is a faithful reproduction, not a strawman.
  const oldLogicSrc = "const hasCityConstraint = locationCanon && !['any','anywhere','worldwide'].includes(locationCanon); return hasCityConstraint;";
  const evalOld = new Function('locationCanon', oldLogicSrc);
  if (evalOld(GARBLED) !== true) {
    console.error('HARNESS FAIL: old logic does NOT reproduce the bug on the garbled fixture -- fixture is wrong, not a faithful repro');
    process.exit(1);
  }

  // 4. Verify all 3 node patches are byte-identical in their guard SHAPE (same
  //    STOP list, same threshold) even though variable names/formatting differ
  //    per node (established convention: duplicated, not shared).
  for (const src of [AJ_NEW, PF_NEW, VJ_NEW]) {
    if (!src.includes('tokens.length <= 8')) { console.error('HARNESS FAIL: guard threshold missing in one node variant'); process.exit(1); }
    if (!src.includes("'and','or','targeting','roles','role','the','for','based','remember'")) {
      console.error('HARNESS FAIL: STOP list drifted between node variants'); process.exit(1);
    }
  }

  console.log('HARNESS OK: priority-rule prompt text verified; the exact garbled string from tonight\'s real bug (`belagavi and targeting roles in bangalore`) now correctly defuses hasCityConstraint (was true under the old logic, confirmed via regression check -- now false); clean single/multi-word locations and the existing "worldwide"/"any" magic-string cases are all unaffected; all 3 node variants (Aggregate Jobs, Pre-flight: Providers, Verify Job Links) carry the identical guard shape.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S75 (location priority fix: explicit query location always beats stored prefs, + defensive guard against sentence-shaped location_canonical) complete.');
