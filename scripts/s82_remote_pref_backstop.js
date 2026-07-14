/**
 * s82_remote_pref_backstop.js -- deterministic gate on remote_preference.
 * Evidence (exec 584, 2026-07-14): "Find me AI jobs in MAANG worldwide" --
 * zero remote language -- came back remote_preference:'remote_only' while
 * execs 578/582 got 'open' on near-identical queries. Pure model wobble wired
 * to a HARD filter: the cache lane's $4 clause dropped 18 of 19 targeted rows
 * and JobScorer told the user "candidate wants remote only." Same disease as
 * the s75 location bug: derived signal treated as explicit command.
 *
 * Two layers (s75/s79 pattern):
 * (1) Parse Expand Query (3 master mirrors): after the result object is
 *     built, force remote_preference back to the USER-PREF-or-'open' baseline
 *     unless the raw message contains remote/hybrid/onsite language. Message
 *     text via $('Prep Expand Input').first().json.message_text -- straight-
 *     chain upstream (Prep Expand Input -> Expand Query -> Parse Expand
 *     Query), wrapped in try/catch per the F1 isExecuted discipline. A STORED
 *     user pref (userPrefs.remote_preference) still applies -- the gate only
 *     strips the LLM's ungrounded contribution, exactly mirroring the
 *     established priority: explicit message > stored pref > default.
 * (2) Expand Query prompt: harden the remote_preference rule -- only from
 *     explicit message language; "worldwide" is NOT remote.
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

// ── (1) Parse Expand Query: the gate, inserted right after the result object ──
const PEQ_ANCHOR = "  _schema_version:    2,\n  _parsed_at:         new Date().toISOString()\n};";
const REMOTE_GATE =
  "\n\n// s82: remote_preference is a HARD filter downstream -- the LLM may only\n" +
  "// set it away from 'open' when the user's own message contains remote/\n" +
  "// hybrid/onsite language (exec 584 hallucinated remote_only from a query\n" +
  "// that never mentioned remote, silently dropping 18 of 19 cache rows).\n" +
  "// A STORED pref still applies -- this strips only the ungrounded LLM value.\n" +
  "const REMOTE_LANG_RX = /remote|wfh|work.?from.?home|hybrid|on.?site|in.?office|telecommut/i;\n" +
  "try {\n" +
  "  const rawMsg = String($('Prep Expand Input').first().json.message_text || '');\n" +
  "  if (result.remote_preference !== 'open' && !REMOTE_LANG_RX.test(rawMsg)) {\n" +
  "    result.remote_preference = (userPrefs.remote_preference && REMOTE_LANG_RX.test(String(userPrefs.remote_preference))) ? userPrefs.remote_preference : (userPrefs.remote_preference || 'open');\n" +
  "    if (result.remote_preference !== 'open' && !userPrefs.remote_preference) result.remote_preference = 'open';\n" +
  "  }\n" +
  "} catch (e) { /* Prep Expand Input always runs on this path; fail-open keeps the parsed value */ }";
const PEQ_NEW = PEQ_ANCHOR + REMOTE_GATE;

// ── (2) Expand Query prompt hardening ──
const EQ_OLD = '- remote_preference: "remote_only" | "hybrid_ok" | "in_office_only" | "open" (default if unstated: "open")';
const EQ_NEW = '- remote_preference: "remote_only" | "hybrid_ok" | "in_office_only" | "open" (default if unstated: "open"). Set a non-"open" value ONLY when the message itself contains remote/hybrid/onsite/WFH language. "worldwide"/"anywhere"/"global" are LOCATION words, NOT remote signals -- they alone never justify "remote_only".';

function patchFile(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['Parse Expand Query', 'Expand Query']) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
  }
  if (N['Parse Expand Query'].parameters.jsCode.includes('REMOTE_LANG_RX')) { console.log(`  ${base}: already patched`); return; }
  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', PEQ_ANCHOR, PEQ_NEW, 'remote gate after result object', base);
  const mv = N['Expand Query'].parameters.messages.messageValues;
  replaceOnce(mv[0], 'message', EQ_OLD, EQ_NEW, 'remote_preference prompt hardening', base);
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: remote_preference gate + prompt hardening -- ${wf.nodes.length} nodes`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  // Run the ACTUAL gate code (REMOTE_GATE) against fixtures. Mock $() to feed rawMsg.
  function runGate(parsedRemote, rawMsg, userPrefRemote) {
    const result = { remote_preference: parsedRemote };
    const userPrefs = userPrefRemote === undefined ? {} : { remote_preference: userPrefRemote };
    const $ = (name) => ({ first: () => ({ json: { message_text: rawMsg } }) });
    const body = REMOTE_GATE + '\nreturn result.remote_preference;';
    return new Function('result', 'userPrefs', '$', body)(result, userPrefs, $);
  }
  const cases = [
    ['remote_only', 'Find me AI jobs in MAANG worldwide', undefined, 'open', 'exec 584 exact repro: hallucinated remote_only stripped'],
    ['remote_only', 'find remote AI jobs in India', undefined, 'remote_only', 'explicit remote kept'],
    ['hybrid_ok', 'hybrid roles in NYC', undefined, 'hybrid_ok', 'explicit hybrid kept'],
    ['in_office_only', 'onsite jobs in Pune', undefined, 'in_office_only', 'explicit onsite kept'],
    ['open', 'find AI jobs', undefined, 'open', 'open passes untouched'],
    ['remote_only', 'find AI jobs', 'remote_only', 'remote_only', 'stored user pref survives the gate'],
    ['remote_only', 'work from home data roles', undefined, 'remote_only', 'wfh phrasing recognized'],
  ];
  for (const [parsed, msg, pref, want, label] of cases) {
    const got = runGate(parsed, msg, pref);
    if (got !== want) { console.error(`HARNESS FAIL: "${label}" -> ${got}, wanted ${want}`); process.exit(1); }
  }
  if (!EQ_NEW.includes('NOT remote signals')) { console.error('HARNESS FAIL: prompt hardening text missing'); process.exit(1); }
  console.log('HARNESS OK: exec-584 hallucination repro stripped to open; explicit remote/hybrid/onsite/wfh all kept; stored pref survives; open untouched.');
})();

MASTER_TARGETS.forEach(patchFile);
console.log('S82 (remote_preference deterministic backstop) complete.');
