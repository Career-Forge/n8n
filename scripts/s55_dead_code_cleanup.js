/**
 * s55_dead_code_cleanup.js -- the evidence-based cleanup batch (v8), every
 * item verified by the duplication/dead-code audits:
 *
 * 1. DELETE `Load Writing Profile` -- confirmed orphan: a Postgres SELECT
 *    with 1 inbound edge, ZERO outbound, ZERO $() references anywhere. The
 *    r8 writing-guidance cache's read side dead-ends; the write side (Build
 *    Writing Guidance -> Save Writing Profile) stays -- harmless
 *    accumulation, and wiring the guidance into Cover Pass1 remains a
 *    documented optional future feature. 290 -> 289 nodes.
 *
 * 2. Strip the dead `queries[]` construction from Prepare Research -- 5-6
 *    search-query strings built on every intel/outreach run and consumed by
 *    NOTHING (confirmed by full param grep; only You.com Research's own
 *    synthesized query is ever sent anywhere).
 *
 * 3. Remove the write-only `sd.last_resume_saved_at` (2 writers, 0 readers).
 *
 * 4. Stale-naming fixes: Parse Personal Info's "Supabase" header + its
 *    resume_source values `supabase_*` -> `local_*` (safe: the only
 *    downstream consumer, Build Scorer Input, OVERWRITES the field -- its
 *    own 'supabase' value also fixed to 'file'); ContactFinder's prompt doc
 *    documenting a `search_results` input field that is actually named
 *    `merged_results` at runtime.
 *
 * 5. Cap sd.tracked_applications at 100 entries (oldest dropped) -- the only
 *    unbounded staticData key left; every sibling got lifecycle handling
 *    (prefs _history capped at 20, _schedule_lastfire pruned at 7d) and
 *    /status joins ALL entries into one Telegram message that hard-fails
 *    past 4096 chars.
 *
 * 6. Normalize the CITY_COUNTRY/COUNTRY_NAMES table formatting in Verify Job
 *    Links to byte-match Aggregate Jobs' copies -- the S30 deliberate
 *    duplication is content-identical but whitespace-drifted, which blocks
 *    adding it to the drift-checker (s56 needs byte equality).
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 2. Prepare Research: queries[] is dead ═══
const PR_Q_OLD_START = "let queries = [];\nif (intent === 'intel') {";
const PR_Q_OLD_END = "return [{ json: { chat_id: chatId, research_type: intent, company, role, location, queries, draft_number: null } }];";
const PR_Q_NEW =
  "// s55: the old queries[] array (5-6 per-run search strings) was dead code --\n" +
  "// nothing anywhere consumed it; only You.com Research's own synthesized query\n" +
  "// is ever sent. Kept as an empty field for output-shape compatibility.\n" +
  "const queries = [];\n" +
  "return [{ json: { chat_id: chatId, research_type: intent, company, role, location, queries, draft_number: null } }];";

// ═══ 3. last_resume_saved_at ═══
const PAB_OLD = "sd.last_resume_structured = resumeDoc;\nsd.last_resume_saved_at = new Date().toISOString();";
const PAB_NEW = "sd.last_resume_structured = resumeDoc;";
const SGW_OLD = "sd.last_resume_structured = v;\nsd.last_resume_saved_at = new Date().toISOString();";
const SGW_NEW = "sd.last_resume_structured = v;";

// ═══ 4. stale naming ═══
const PPI_HDR_OLD = "// Parse Personal Info v5 — Supabase resume_bubbles/structured resume first, legacy file fallback second.";
const PPI_HDR_NEW = "// Parse Personal Info v5 — local resume_structured.json (resume_bubbles/structured) first, legacy file fallback second.";
const PPI_SRC_OLD = "resumeSource = structured.kind === 'resume_bubbles' ? 'supabase_resume_bubbles' : 'supabase_structured';";
const PPI_SRC_NEW = "resumeSource = structured.kind === 'resume_bubbles' ? 'local_resume_bubbles' : 'local_structured';";
const PPI_TXT_OLD = "resumeSource = 'supabase_text';";
const PPI_TXT_NEW = "resumeSource = 'local_text';";
const BSI_OLD = "resume_source: resumeMissing ? 'none' : (row.id ? 'supabase' : 'staticData'),";
const BSI_NEW = "resume_source: resumeMissing ? 'none' : (row.id ? 'file' : 'staticData'),";
const CF_OLD = "- `search_results`: Top 15 deduplicated search results, each with `url`, `title`, `snippet`, and optionally `content`";
const CF_NEW = "- `merged_results`: Top 15 deduplicated search results, each with `url`, `title`, `snippet`, and optionally `content`";

// ═══ 5. tracked_applications cap ═══
const TA_OLD = "staticData.tracked_applications.push(entry);";
const TA_NEW = "staticData.tracked_applications.push(entry);\nif (staticData.tracked_applications.length > 100) staticData.tracked_applications = staticData.tracked_applications.slice(-100);";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function deleteNodeEverywhere(wf, name) {
  const idx = wf.nodes.findIndex((n) => n.name === name);
  if (idx === -1) return false;
  wf.nodes.splice(idx, 1);
  delete wf.connections[name];
  for (const obj of Object.values(wf.connections)) {
    for (const connType of Object.keys(obj)) {
      obj[connType] = obj[connType].map((branch) => (branch || []).filter((e) => e.node !== name));
    }
  }
  return true;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const need of ['Load Writing Profile', 'Prepare Research', 'Prep Apply Body', 'Stage Global Write', 'Parse Personal Info', 'Build Scorer Input', 'ContactFinder', 'Track Application', 'Aggregate Jobs', 'Verify Job Links']) {
    if (!N[need]) {
      if (need === 'Load Writing Profile' && !N[need]) { console.log(`  ${base}: already patched (orphan gone)`); return; }
      console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1);
    }
  }

  // 1. delete the orphan (verify it's still an orphan first)
  const lwpOutgoing = wf.connections['Load Writing Profile'];
  const lwpHasOut = lwpOutgoing && Object.values(lwpOutgoing).some((branches) => (branches || []).some((b) => (b || []).length));
  const lwpReferenced = wf.nodes.some((n) => JSON.stringify(n.parameters || {}).includes("$('Load Writing Profile')"));
  if (lwpHasOut || lwpReferenced) { console.error(`INTEGRITY FAIL ${base}: Load Writing Profile is no longer an orphan -- aborting delete`); process.exit(1); }
  deleteNodeEverywhere(wf, 'Load Writing Profile');

  // 2. queries[]
  {
    const code = N['Prepare Research'].parameters.jsCode;
    const si = code.indexOf(PR_Q_OLD_START);
    const ei = code.indexOf(PR_Q_OLD_END);
    if (si === -1 || ei === -1 || ei < si) { console.error(`INTEGRITY FAIL ${base}: Prepare Research queries anchors not found`); process.exit(1); }
    N['Prepare Research'].parameters.jsCode = code.slice(0, si) + PR_Q_NEW + code.slice(ei + PR_Q_OLD_END.length);
  }

  // 3-5. anchored replaces
  replaceOnce(N['Prep Apply Body'].parameters, 'jsCode', PAB_OLD, PAB_NEW, 'Prep Apply Body saved_at', base);
  replaceOnce(N['Stage Global Write'].parameters, 'jsCode', SGW_OLD, SGW_NEW, 'Stage Global Write saved_at', base);
  replaceOnce(N['Parse Personal Info'].parameters, 'jsCode', PPI_HDR_OLD, PPI_HDR_NEW, 'PPI header', base);
  replaceOnce(N['Parse Personal Info'].parameters, 'jsCode', PPI_SRC_OLD, PPI_SRC_NEW, 'PPI resume_source', base);
  replaceOnce(N['Parse Personal Info'].parameters, 'jsCode', PPI_TXT_OLD, PPI_TXT_NEW, 'PPI text source', base);
  replaceOnce(N['Build Scorer Input'].parameters, 'jsCode', BSI_OLD, BSI_NEW, 'BSI resume_source', base);
  replaceOnce(N['ContactFinder'].parameters.messages.messageValues[0], 'message', CF_OLD, CF_NEW, 'ContactFinder doc', base);
  replaceOnce(N['Track Application'].parameters, 'jsCode', TA_OLD, TA_NEW, 'tracked_applications cap', base);

  // 6. country-table whitespace normalization: copy Aggregate Jobs' exact table
  //    text into Verify Job Links (content already identical, formatting drifted).
  {
    const aj = N['Aggregate Jobs'].parameters.jsCode;
    for (const tbl of ['COUNTRY_NAMES', 'CITY_COUNTRY']) {
      // recompute offsets from the FRESH string each iteration -- the first
      // table's replacement shifts every later offset (stale-index bug caught
      // by the semantic check itself during dry-run)
      const vjFresh = N['Verify Job Links'].parameters.jsCode;
      const ajStart = aj.indexOf(`const ${tbl} = {`);
      const ajEnd = aj.indexOf('};', ajStart) + 2;
      const vjStart = vjFresh.indexOf(`const ${tbl} = {`);
      const vjEnd = vjFresh.indexOf('};', vjStart) + 2;
      if (ajStart === -1 || vjStart === -1) { console.error(`INTEGRITY FAIL ${base}: ${tbl} not found in both nodes`); process.exit(1); }
      const ajBlock = aj.slice(ajStart, ajEnd);
      const vjBlock = vjFresh.slice(vjStart, vjEnd);
      // semantic identity check before overwriting formatting (whitespace and
      // trailing commas before a closing brace/bracket are formatting, not content
      // -- verified by hand: AJ's multiline form ends "...],\n}" vs VJ's "...] }")
      const norm = (s) => s.replace(/\s+/g, '').replace(/,(?=[}\]])/g, '');
      if (norm(ajBlock) !== norm(vjBlock)) { console.error(`INTEGRITY FAIL ${base}: ${tbl} differs SEMANTICALLY between nodes -- not just formatting, aborting`); process.exit(1); }
      N['Verify Job Links'].parameters.jsCode = vjFresh.slice(0, vjStart) + ajBlock + vjFresh.slice(vjEnd);
    }
  }

  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: cleanup applied -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. Prepare Research output shape unchanged (queries still present, empty).
  {
    const body = "const chatId = 1, intent = 'outreach', company = 'X', role = 'Y', location = '';\n" + PR_Q_NEW;
    const out = new Function(body)()[0].json;
    if (!Array.isArray(out.queries) || out.queries.length !== 0 || out.company !== 'X' || out.research_type !== 'outreach') {
      console.error('HARNESS FAIL: Prepare Research output shape changed', out); process.exit(1);
    }
  }
  console.log('HARNESS OK: Prepare Research output shape preserved (queries: [] for compatibility), dead construction gone');

  // 2. tracked_applications cap.
  {
    const staticData = { tracked_applications: Array.from({ length: 100 }, (_, i) => ({ job_id: i })) };
    const entry = { job_id: 'new' };
    new Function('staticData', 'entry', TA_NEW)(staticData, entry);
    if (staticData.tracked_applications.length !== 100) { console.error('HARNESS FAIL: cap should hold at 100, got', staticData.tracked_applications.length); process.exit(1); }
    if (staticData.tracked_applications[99].job_id !== 'new') { console.error('HARNESS FAIL: newest entry must survive the cap'); process.exit(1); }
    if (staticData.tracked_applications[0].job_id !== 1) { console.error('HARNESS FAIL: oldest entry should be dropped'); process.exit(1); }
  }
  console.log('HARNESS OK: tracked_applications capped at 100 (oldest dropped, newest kept)');

  // 3. Naming replacements are pure renames (no behavior implications by construction).
  if (PPI_SRC_NEW.includes('supabase') || BSI_NEW.includes('supabase')) { console.error('HARNESS FAIL: supabase still present in replacements'); process.exit(1); }
  console.log('HARNESS OK: stale supabase naming fully replaced in the new anchors');
})();

TARGETS.forEach(patch);
console.log('S55 (dead-code cleanup: orphan node, dead queries[], dead staticData key, stale naming, tracking cap, table normalization) complete.');
