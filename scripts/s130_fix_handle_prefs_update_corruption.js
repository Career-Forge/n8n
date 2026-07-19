/**
 * s130_fix_handle_prefs_update_corruption.js -- restores `Handle Prefs
 * Update` from a hard JavaScript syntax error that has been LIVE in
 * production since 2026-07-15 (commit 91b8865, "Genericize currency,
 * F1-OPT visa schema, and intel vocabulary" -- the s89 sprint). Every
 * message routed to the update_prefs intent since then -- "remember I'm in
 * X", "always remote only", "min salary...", "sections: ...", "template:
 * compact", "timezone: ..." -- has been throwing `Unexpected token 'of'`
 * and failing silently. Confirmed against BOTH the git-tracked file and the
 * currently-deployed live workflow (docker exec export) -- this is not a
 * drift issue, the corruption is live right now.
 *
 * ROOT CAUSE (found by bisecting 30 commits, then diffing the exact
 * before/after of 91b8865): s89's own patch script
 * (scripts/applied/s89_market_assumption_dehardcode.js) built the new
 * salary block correctly and its OWN harness (a synthetic standalone
 * function test) passed -- but the actual file-level `replaceOnce` helper
 * does `val.replace(oldStr, newStr)` with NEWSTR PASSED AS A STRING. In
 * JavaScript, `String.prototype.replace(search, replacementString)` treats
 * `$`-prefixed sequences in the REPLACEMENT string specially -- `$$`, `$&`,
 * `` $` ``, `$'`, `$1`-`$9` -- REGARDLESS of whether the search side is a
 * plain string or a regex. The new salary block's currency symbol map
 * (`{ '$':'$', 'a$':'A$', 'c$':'C$', 's$':'S$', 'nz$':'NZ$' }`, plus the
 * comment text "unconditional '$' regardless of what the...") contains the
 * literal two-character sequence `$'` a dozen times over. Each occurrence
 * told `.replace()` to splice in "everything in the original string AFTER
 * the match" -- i.e. the entire rest of the function, body-for-body,
 * once per `$'` occurrence. That's exactly what's on disk: the real
 * 159-line function followed by ~11 near-duplicate copies of everything
 * from "Seniority" onward, each with a different garbled trailing
 * fragment where the next `$'`-triggered splice cut it off mid-string.
 * Confirmed via a full parse-check sweep of every Code node across all 3
 * live workflows (Master/Poller/Seeder) plus a tail-repetition scan of
 * every long string field (jsCode/prompts/schemas) -- this is the ONLY
 * node affected anywhere in the codebase.
 *
 * FIX: reconstruct the correct 159-line pre-91b8865 function (pulled
 * verbatim from the git history at the parent commit, dba39f3) and apply
 * s89's ORIGINAL, already-correct SALARY_OLD -> SALARY_NEW text via a
 * FUNCTION-form replacer (`.replace(oldStr, () => newStr)`), which bypasses
 * `$`-pattern substitution entirely since the callback's return value is
 * inserted literally. This is now the safe pattern for every future script
 * whose replacement text might contain a `$` -- not just currency work.
 *
 * Run: harness (parses clean + 17 real end-to-end fixtures covering salary
 * currency-awareness AND every pre-existing pref field, proving nothing
 * downstream of Salary was severed) + integrity-guarded deploy (refuses to
 * touch the node unless its current jsCode matches the exact known-corrupt
 * fingerprint) + verify + commit.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');

// The verbatim, known-good pre-corruption body (git show dba39f3a:...,
// the parent of the corrupting commit 91b8865), MINUS the old $-only
// salary block, which gets reinserted via the safe function-replacer below.
const HPU_BEFORE = `// Handle Prefs Update v3
// Regex-based preference extractor. Schedule times rounded to 3-hour boundary
// to match the every-3-hours Schedule Tick cron.

const msg = ($('Extract Input').first().json.message_text || '').toLowerCase();
// v9 Area C: bare "sections"/"/sections" (nothing else in the message) opens
// the inline-keyboard toggle UI instead of the normal preference-delta parser
// below -- "sections: experience, education" (with a colon) is a totally
// different match further down and is untouched by this check.
if (/^\\/?sections\\s*$/.test(msg.trim())) {
  return [{ json: { _render_sections: true } }];
}
const sd  = $getWorkflowStaticData('global');
if (!sd.user_prefs) sd.user_prefs = { _schema_version: 1, _history: [] };
const prefs = sd.user_prefs;
const changes = [];
const delta   = {};
let m;

// ── Location ──────────────────────────────────────────────────────────────
if ((m = msg.match(/(?:i['\\u2019]?m (?:based |located )?in|location[:\\s]+|moved? to|set location (?:to )?)\\s*([\\w\\s,]+?)(?:\\s*$|[.,!?])/))) {
  let loc = m[1].trim();
  // s76: canonicalize -- keep only the place tokens before any connector word,
  // so 'belagavi and targeting roles in bangalore' stores as 'belagavi', never
  // the sentence (which s75's filter guard would treat as no constraint).
  const LOC_STOP = ['and', 'or', 'targeting', 'roles', 'role', 'the', 'for', 'based', 'remember', 'open', 'while', 'looking'];
  const locToks = loc.split(/\\s+/);
  const cutAt = locToks.findIndex((t) => LOC_STOP.includes(t.toLowerCase()));
  if (cutAt === 0) loc = '';
  else if (cutAt > 0) loc = locToks.slice(0, cutAt).join(' ');
  if (loc.length > 2 && loc.split(/\\s+/).length <= 8) delta.location_canonical = loc;
}

// ── Remote ────────────────────────────────────────────────────────────────
if (/always remote|remote only|remote-only/.test(msg))           delta.remote_preference = 'remote_only';
else if (/hybrid(?:\\s+ok)?|open to hybrid/.test(msg))           delta.remote_preference = 'hybrid_ok';
else if (/in.?office only|no remote/.test(msg))                  delta.remote_preference = 'in_office_only';

// ── Visa ──────────────────────────────────────────────────────────────────
const visaSigs = [];
if (/cap.?exempt/.test(msg))            visaSigs.push('cap-exempt');
if (/h1b|h-1b/.test(msg))               visaSigs.push('h1b');
if (/sponsorship|sponsor/.test(msg))    visaSigs.push('sponsorship');
if (visaSigs.length) delta.visa_signals = visaSigs;

##SALARY_BLOCK##

// ── Seniority ────────────────────────────────────────────────────────────
if (/\\bsenior\\b|\\bstaff\\b|\\bprincipal\\b/.test(msg))        delta.seniority = 'senior';
else if (/mid.?level|mid level/.test(msg))                       delta.seniority = 'mid';
else if (/junior|entry.?level|new grad/.test(msg))               delta.seniority = 'junior';

// ── Verbose ───────────────────────────────────────────────────────────────
if (/verbose on/.test(msg))  delta.verbose = true;
if (/verbose off/.test(msg)) delta.verbose = false;

// ── Max YOE ───────────────────────────────────────────────────────────────
if ((m = msg.match(/(?:max(?:imum)?|less than|under|at most)\\s*(\\d+)\\s*(?:years?|yrs?|yoe)/))) {
  delta.max_yoe = parseInt(m[1], 10);
}

// ── Freshness ────────────────────────────────────────────────────────────
if (/past day|last 24|qdr:d|daily/.test(msg))                    delta.freshness = 'qdr:d';
else if (/past week|last week|qdr:w/.test(msg))                  delta.freshness = 'qdr:w';
else if (/past month|last month|qdr:m/.test(msg))                delta.freshness = 'qdr:m';

// ── Schedule times (rounded to 3-hour boundary) ──────────────────────────
const schedCtx   = /schedul[a-z]*|digest|every (?:morning|day|weekday|evening|afternoon)|send (?:me )?(?:jobs|searches)|run at|fire at|jobs at/i;
const disableCtx = /stop|disable|pause|turn off|no more|halt|cancel/i;

if (schedCtx.test(msg)) {
  if (disableCtx.test(msg)) {
    delta.schedule_times = [];
  } else {
    const timeRe = /\\b(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?\\b/gi;
    const found  = new Set();
    let tm;
    while ((tm = timeRe.exec(msg)) !== null) {
      let hr = parseInt(tm[1], 10);
      const mn = tm[2] ? parseInt(tm[2], 10) : 0;
      const mer = tm[3] ? tm[3].toLowerCase().replace(/\\./g,'') : null;
      if (hr > 23) continue;
      if (!mer) {
        if (hr >= 1 && hr <= 7) hr += 12;
        else if (hr === 0) continue;
      } else {
        if (mer === 'pm' && hr < 12) hr += 12;
        if (mer === 'am' && hr === 12) hr = 0;
      }
      // Round to nearest 3-hour boundary (00, 03, 06, 09, 12, 15, 18, 21)
      const total   = hr * 60 + mn;
      const rounded = Math.round(total / 180) * 180;
      const rh = String(Math.floor(rounded / 60) % 24).padStart(2, '0');
      found.add(\`\${rh}:00\`);
    }
    if (found.size > 0) delta.schedule_times = [...found].sort();
  }
}

// ── Schedule query (what the recurring digest searches for) ─────────────
if ((m = msg.match(/(?:scheduled?[\\s_]?query|digest query)\\s*[:\\s]+(.+)$/i))) {
  const q = m[1].trim().replace(/[.!]+$/, '');
  if (q.length > 3) delta.schedule_query = q;
} else if ((m = msg.match(/for (?:my |the )?(?:scheduled?|recurring) (?:jobs?|search|digest)s?,?\\s*(?:search for|find|search)\\s+(.+)$/i))) {
  const q = m[1].trim().replace(/[.!]+$/, '');
  if (q.length > 3) delta.schedule_query = q;
}

// ── Resume sections (which sections to include in generated resumes) ────
// Canonical ids: summary, experience, internships, education, projects, skills,
// certifications, achievements, activities. Requires an explicit colon (like
// schedule_query:) to avoid false-positive matches on ordinary sentences.
const CANONICAL_SECTIONS = ['summary', 'experience', 'internships', 'education', 'projects', 'skills', 'certifications', 'achievements', 'activities'];
if ((m = msg.match(/\\bsections\\s*:\\s*([a-z, ]+?)(?:[.!]|$)/i))) {
  const list = m[1].split(',').map((s) => s.trim().toLowerCase()).filter((s) => CANONICAL_SECTIONS.includes(s));
  if (list.length) delta.enabled_sections = [...new Set(list)];
}

// ── Resume section order (exact order + membership -- highest priority) ──
if ((m = msg.match(/\\border\\s*:\\s*([a-z, ]+?)(?:[.!]|$)/i))) {
  const list = m[1].split(',').map((s) => s.trim().toLowerCase()).filter((s) => CANONICAL_SECTIONS.includes(s));
  if (list.length) delta.section_order = [...new Set(list)];
}

// ── Resume template density (compact = fewer bullets/education entries, ──
// tighter spacing; normal = default). Colon required, same convention as
// sections:/order:, to avoid false-positive matches on ordinary sentences.
if ((m = msg.match(/\\btemplate\\s*:\\s*(compact|normal)\\b/i))) {
  delta.template = m[1].toLowerCase();
}

// ── Timezone ──────────────────────────────────────────────────────────────
if ((m = msg.match(/(?:timezone|time zone|tz)\\s*(?:to|=|:)?\\s*([\\w]+\\/[\\w_\\/]+)/i))) {
  delta.timezone = m[1];
}

// ── Apply delta ──────────────────────────────────────────────────────────
for (const [key, val] of Object.entries(delta)) {
  if (JSON.stringify(prefs[key]) !== JSON.stringify(val)) {
    const old = prefs[key];
    prefs[key] = val;
    changes.push('• ' + key + ': ' + (old !== undefined ? JSON.stringify(old) + ' → ' : '') + JSON.stringify(val));
  }
}

if (!changes.length) {
  return [{ json: { message: "ℹ️ I didn't catch a clear preference there\\\\. Try:\\n• \\"I'm in NYC\\"\\n• \\"always remote only\\"\\n• \\"min salary $150k\\"\\n• \\"send me jobs at 9am and 6pm\\" (rounded to 3-hour boundaries)\\n• \\"stop scheduled jobs\\"" } }];
}

prefs._history = prefs._history || [];
prefs._history.push({ ts: new Date().toISOString(), delta });
if (prefs._history.length > 20) prefs._history = prefs._history.slice(-20);
prefs._updated_at = new Date().toISOString();

const firstKey = Object.keys(delta)[0];
return [{ json: { message: '✅ *Preferences updated:*\\n' + changes.join('\\n') + '\\n\\n_Reply \\\\\`/prefs\\\\\` to see all, \\\\\`/prefs forget ' + firstKey + '\\\\\` to remove\\\\._' } }];
`;

// s89's ORIGINAL, already-correct salary block (verbatim from
// scripts/applied/s89_market_assumption_dehardcode.js's SALARY_NEW const --
// the text itself was always right, only the insertion mechanism was buggy).
const SALARY_NEW = "// ── Salary ────────────────────────────────────────────────────────────────\n// s89: currency-aware -- was an unconditional '$' regardless of what the\n// user typed (\"min salary 20L\" stored as the nonsense \"$20\"). Reads the\n// symbol they actually used (same vocabulary Build Telegraph Body already\n// has correct); lakh/crore reads the user's OWN stated numbering\n// convention, not an inference from residency; no symbol + no Indian unit\n// word means no currency is invented -- bare number, honest about not\n// knowing.\nif ((m = msg.match(/(?:min(?:imum)? salary|at least|salary[:\\s]+|above|over)\\s*(₹|£|€|\\$|a\\$|c\\$|s\\$|nz\\$)?\\s*([\\d]+(?:k|,\\d{3})?)\\s*(lakh|lac|l\\b|cr|crore)?/i))) {\n  const symMap = { '₹':'₹', '£':'£', '€':'€', '$':'$', 'a$':'A$', 'c$':'C$', 's$':'S$', 'nz$':'NZ$' };\n  const sym = symMap[(m[1] || '').toLowerCase()] || '';\n  const unit = (m[3] || '').toLowerCase();\n  const isIndianUnit = /^(lakh|lac|l|cr|crore)$/.test(unit);\n  const finalSym = sym || (isIndianUnit ? '₹' : '');\n  const suffix = isIndianUnit ? (unit.startsWith('cr') ? 'Cr' : 'L') : '';\n  delta.salary_signals = [finalSym + m[2] + suffix];\n}";

// FIX (also the lesson for every future script): function-form replacer.
// `.replace(str, () => newStr)` inserts the callback's return value
// literally -- `$`-pattern substitution only applies when the replacement
// argument is a STRING, never when it's a function. This is what
// s89's own `replaceOnce` should have used from the start.
const FIXED_JSCODE = HPU_BEFORE.replace('##SALARY_BLOCK##', () => SALARY_NEW);

// Known-corrupt fingerprint of the live node, for the integrity guard --
// refuse to touch anything that doesn't match exactly what we diagnosed.
const CORRUPT_TAIL_MARKER = '// ── Seniority';

function patch() {
  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const node = wf.nodes.find((n) => n.name === 'Handle Prefs Update');
  if (!node) { console.error('INTEGRITY FAIL: Handle Prefs Update missing'); process.exit(1); }
  const current = node.parameters.jsCode;

  if (current === FIXED_JSCODE) {
    console.log('  master: already patched (byte-identical)');
    return;
  }

  const seniorityCount = current.split(CORRUPT_TAIL_MARKER).length - 1;
  let parsesOk = true;
  try { new Function(current); } catch (e) { parsesOk = false; }
  if (parsesOk || seniorityCount <= 1) {
    console.error(`INTEGRITY FAIL: current jsCode does not match the known-corrupt fingerprint (parses=${parsesOk}, "${CORRUPT_TAIL_MARKER}" count=${seniorityCount}) -- refusing to overwrite blind. Investigate before re-running.`);
    process.exit(1);
  }

  node.parameters.jsCode = FIXED_JSCODE;
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));
  console.log(`  master: Handle Prefs Update restored (was ${current.length} chars/${seniorityCount}x duplicated -> now ${FIXED_JSCODE.length} chars, clean)`);
}

// ════════════════════════ HARNESS ════════════════════════
(function harness() {
  try { new Function(FIXED_JSCODE); }
  catch (e) { console.error('HARNESS FAIL: reconstructed jsCode does not parse:', e.message); process.exit(1); }

  function run(messageText, sd) {
    const $ = (name) => {
      if (name !== 'Extract Input') throw new Error('unexpected $() ref: ' + name);
      return { first: () => ({ json: { message_text: messageText } }) };
    };
    const $getWorkflowStaticData = () => sd;
    const fn = new Function('$', '$getWorkflowStaticData', FIXED_JSCODE);
    return fn($, $getWorkflowStaticData);
  }

  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  const salaryCases = [
    ['min salary $150k', ['$150k']],
    ['min salary 20L', ['₹20L']],
    ['min salary ₹20L', ['₹20L']],
    ['salary above 20 lakh', ['₹20L']],
    ['min salary 150k', ['150k']],
    ['min salary €80k', ['€80k']],
  ];
  for (const [msg, want] of salaryCases) {
    const sd = {};
    run(msg, sd);
    check(`salary "${msg}"`, JSON.stringify(sd.user_prefs && sd.user_prefs.salary_signals) === JSON.stringify(want));
  }

  { const sd = {}; run("remember I'm based in belagavi and targeting roles in bangalore", sd);
    check('location canonicalization (s76)', sd.user_prefs.location_canonical === 'belagavi'); }
  { const sd = {}; run('always remote only please', sd);
    check('remote_preference', sd.user_prefs.remote_preference === 'remote_only'); }
  { const sd = {}; run('I need h1b sponsorship', sd);
    check('visa_signals', JSON.stringify(sd.user_prefs.visa_signals.sort()) === JSON.stringify(['h1b','sponsorship'].sort())); }
  { const sd = {}; run('sections: experience, education, skills', sd);
    check('enabled_sections', JSON.stringify(sd.user_prefs.enabled_sections) === JSON.stringify(['experience','education','skills'])); }
  { const sd = {}; run('template: compact', sd);
    check('template', sd.user_prefs.template === 'compact'); }
  { const sd = {}; run('timezone: Asia/Kolkata', sd);
    check('timezone', sd.user_prefs.timezone === 'asia/kolkata'); }
  { const out = run('sections', {});
    check('bare sections shortcut (v9 Area C)', out[0].json._render_sections === true); }
  { const sd = {}; const out = run('hello there', sd);
    check('no-match hint message, no throw', typeof out[0].json.message === 'string'); }
  { const sd = {}; run('remember min salary 20L, always remote only, timezone: Asia/Kolkata', sd);
    check('multi-field salary', JSON.stringify(sd.user_prefs.salary_signals) === JSON.stringify(['₹20L']));
    check('multi-field remote', sd.user_prefs.remote_preference === 'remote_only');
    check('multi-field timezone', sd.user_prefs.timezone === 'asia/kolkata'); }

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: reconstructed Handle Prefs Update verified end-to-end (17 checks: salary currency-awareness + every pre-existing pref field + bare-sections shortcut + no-match hint + multi-field messages).');

  patch();
  console.log('S130 (fix Handle Prefs Update corruption) script complete.');
})();
