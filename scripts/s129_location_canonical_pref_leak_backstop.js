/**
 * s129_location_canonical_pref_leak_backstop.js -- s128 fixed the FALLBACK
 * path (what happens when the LLM outputs no location) but never guarded
 * against the LLM ignoring its own prompt instruction and outputting the
 * stored preference verbatim anyway. Confirmed live, immediately after
 * s128 deployed: "AI jobs in Dassault Systems" (zero location language)
 * still returned `location_canonical: "belagavi"` straight from the raw
 * model completion -- an EXACT, character-for-character match of
 * sd.user_prefs.location_canonical, despite s128's prompt rewrite
 * explicitly saying "NEVER use 'User preferences' location for this
 * field." The model sees the stored value verbatim in the injected
 * "User preferences: {...}" JSON blob and is copying it, not deriving it.
 *
 * This is the exact same risk class every OTHER LLM-field-wired-to-a-
 * hard-filter already has a deterministic backstop for in this same node
 * (remote_preference/s82, freshness_explicit/s83, target_companies/s84) --
 * a prompt instruction alone was never going to be sufficient, same as
 * those three. Add the missing backstop: if the LLM's location_canonical
 * output is an exact match (case-insensitive) of the stored preference,
 * AND the raw message never actually said that place, reject it -- it
 * didn't come from the user. Deliberately an EXACT match (not a fuzzy/
 * substring check against the whole message) to avoid false-rejecting a
 * legitimately-expanded location (e.g. user says "NYC", LLM correctly
 * expands to "New York,New York,United States" per its own prompt
 * instruction -- that wouldn't match the stored pref string at all, so
 * this backstop never touches it).
 *
 * Run: harness (real fixture matching the exact observed leak) + deploy
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

const ANCHOR_OLD = `} catch (e) { /* fail-open: keep the parsed list rather than block the search */ }

// s87: priority is a UNIT, not per-field`;
const ANCHOR_NEW = `} catch (e) { /* fail-open: keep the parsed list rather than block the search */ }

// s129: location_canonical is a HARD filter downstream (Aggregate Jobs'
// location match) -- same risk class as remote_preference/target_companies
// above. s128's prompt instruction alone wasn't enough: confirmed live the
// model still copies the stored preference's location verbatim from the
// injected "User preferences" JSON blob despite being told not to.
// Deliberately an EXACT match against the stored pref (not a broad
// substring-of-message check) so a legitimately-expanded location (user
// says "NYC", LLM correctly expands per its own instructions) never gets
// false-rejected just because the expansion doesn't share literal text
// with what the user typed.
try {
  if (result.location_canonical && cleanPrefLoc) {
    const llmLocNorm = String(result.location_canonical).trim().toLowerCase();
    const prefLocNorm = String(cleanPrefLoc).trim().toLowerCase();
    const rawMsgLower = resolveRawMessageText().toLowerCase();
    if (llmLocNorm === prefLocNorm && !rawMsgLower.includes(prefLocNorm)) {
      result.location_canonical = null;
      if (!result.country) result.country = resumeCountryDefault;
    }
  }
} catch (e) { /* fail-open: keep the parsed value rather than block the search */ }

// s87: priority is a UNIT, not per-field`;

function patch() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const parseEQ = wf.nodes.find((n) => n.name === 'Parse Expand Query');
  if (!parseEQ) { console.error('INTEGRITY FAIL: Parse Expand Query missing'); process.exit(1); }
  if (parseEQ.parameters.jsCode.includes('s129: location_canonical is a HARD filter downstream')) {
    console.log('  master: already patched');
    return;
  }
  replaceOnce(parseEQ.parameters, 'jsCode', ANCHOR_OLD, ANCHOR_NEW, 'location_canonical pref-leak backstop');
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log('  master: Parse Expand Query patched');
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  function applyBackstop(resultLocationCanonical, resultCountry, cleanPrefLoc, rawMsg, resumeCountryDefault) {
    const result = { location_canonical: resultLocationCanonical, country: resultCountry };
    if (result.location_canonical && cleanPrefLoc) {
      const llmLocNorm = String(result.location_canonical).trim().toLowerCase();
      const prefLocNorm = String(cleanPrefLoc).trim().toLowerCase();
      const rawMsgLower = rawMsg.toLowerCase();
      if (llmLocNorm === prefLocNorm && !rawMsgLower.includes(prefLocNorm)) {
        result.location_canonical = null;
        if (!result.country) result.country = resumeCountryDefault;
      }
    }
    return result;
  }
  // 1. The exact observed bug: LLM copies stored pref verbatim, message never said it -> reject, backfill resume country.
  let r = applyBackstop('belagavi', null, 'belagavi', 'AI jobs in Dassault Systems', 'IN');
  if (r.location_canonical !== null || r.country !== 'IN') { console.error('HARNESS FAIL: exact pref-leak case', r); process.exit(1); }
  // 2. User genuinely typed the pref city -> must NOT reject (it's a legitimate message-derived match).
  r = applyBackstop('belagavi', null, 'belagavi', 'find jobs in belagavi', 'IN');
  if (r.location_canonical !== 'belagavi') { console.error('HARNESS FAIL: genuine same-city message case', r); process.exit(1); }
  // 3. Legitimately-expanded location (NYC -> full string) must NOT be false-rejected just for not matching the pref textually.
  r = applyBackstop('New York,New York,United States', null, 'belagavi', 'jobs in NYC', 'IN');
  if (r.location_canonical !== 'New York,New York,United States') { console.error('HARNESS FAIL: legitimate expansion case', r); process.exit(1); }
  // 4. No stored pref at all -> backstop never engages.
  r = applyBackstop('Some City,State,Country', null, '', 'find jobs in Some City', 'IN');
  if (r.location_canonical !== 'Some City,State,Country') { console.error('HARNESS FAIL: no-stored-pref case', r); process.exit(1); }
  console.log('HARNESS OK: pref-leak backstop verified for leak/genuine-match/legitimate-expansion/no-pref cases.');

  patch();
  console.log('S129 (location_canonical pref-leak backstop) script complete.');
})();
