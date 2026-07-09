/**
 * s54_data_integrity.js -- 3 data-integrity fixes from the deep audit
 * (staticdata-lifecycle lens, all adversarially verified):
 *
 * 1. Direct-URL applies minted a CONSTANT job_id `direct-<company>-0` -- two
 *    different roles at the same company (two jobs.lever.co/stripe/... URLs)
 *    collided in Track Application's dedup and the second was silently never
 *    tracked (worse: the "Already tracking" reply shows the NEW job's title,
 *    so it reads like a confirmation). Now the id carries a short hash of
 *    the full URL: `direct-<company>-<urlhash>`.
 *
 * 2. ForgeScore scored every apply against visa/salary requirements from
 *    sd.last_search_intent -- ephemeral, TTL-less, and overwritten by EVERY
 *    search including the autonomous scheduled digest's generic default
 *    query. Durable user_prefs.visa_signals/salary_signals (which the user
 *    explicitly sets via prefs) never reached the scorer at all. Both layers
 *    fixed: Parse Expand Query now falls back to userPrefs for those two
 *    fields (exactly like its sibling fields already did), and ForgeScore's
 *    prompt falls back to user_prefs when the search intent has none.
 *
 * 3. The revise-flow staleness cluster: (a) Detect Revise Type read only
 *    sd.last_resume_json, which can point at a PREVIOUS job's resume when
 *    the newer apply's content failed its shape check -- it now prefers
 *    last_apply.resume_json (the current job) when valid-shaped; (b) Build
 *    Revised LaTeX's graceful error item ({chat_id, error}, no latex) flowed
 *    straight into Compile Revised PDF, converting the designed friendly
 *    message into a hard HTTP failure -- a new IF: Revised OK? gate routes
 *    it to the existing "❌ <error>" sender instead; (c) Update Last Apply
 *    branched on last_apply.revise_type, a field no node has ever written
 *    (its own sibling comment admits this) -- dead branch removed, plus a
 *    guard for a legacy/empty last_apply; (d) Send Revised PDF hard-derefed
 *    last_apply.company/.job_title in caption+filename -- now defaulted.
 *
 * +1 node (IF: Revised OK?). 289 -> 290.
 *
 * Run: inside the n8n container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. direct-URL job_id uniqueness ═══
const RJ_URL_OLD = "  return [{ json: { chat_id: chatId, job_number: 0, direct_url: jobUrl, source, company_slug: company, greenhouse_id: null, job: { job_id: `direct-${company}-0`, title: '', company, location: '', url: jobUrl, description_snippet: '' } } }];";
const RJ_URL_NEW =
  "  // s54: hash the full URL into the id -- a constant `direct-<company>-0`\n" +
  "  // collided two different roles at one company in track's dedup.\n" +
  "  let _h = 5381; for (let _i = 0; _i < jobUrl.length; _i++) { _h = ((_h * 33) ^ jobUrl.charCodeAt(_i)) >>> 0; }\n" +
  "  return [{ json: { chat_id: chatId, job_number: 0, direct_url: jobUrl, source, company_slug: company, greenhouse_id: null, job: { job_id: `direct-${company}-${_h.toString(36)}`, title: '', company, location: '', url: jobUrl, description_snippet: '' } } }];";

// ═══ 2. visa/salary durable fallback ═══
const PEQ_OLD =
  "  visa_signals:       parsed.visa_signals         || [],\n" +
  "  salary_signals:     parsed.salary_signals       || [],";
const PEQ_NEW =
  "  visa_signals:       (parsed.visa_signals && parsed.visa_signals.length ? parsed.visa_signals : userPrefs.visa_signals) || [],\n" +
  "  salary_signals:     (parsed.salary_signals && parsed.salary_signals.length ? parsed.salary_signals : userPrefs.salary_signals) || [],";

const FS_OLD =
  "- Visa: {{ JSON.stringify($getWorkflowStaticData('global').last_search_intent?.visa_signals || []) }}\n" +
  "- Salary target: {{ JSON.stringify($getWorkflowStaticData('global').last_search_intent?.salary_signals || []) }}";
const FS_NEW =
  "- Visa: {{ JSON.stringify(($getWorkflowStaticData('global').last_search_intent?.visa_signals?.length ? $getWorkflowStaticData('global').last_search_intent.visa_signals : $getWorkflowStaticData('global').user_prefs?.visa_signals) || []) }}\n" +
  "- Salary target: {{ JSON.stringify(($getWorkflowStaticData('global').last_search_intent?.salary_signals?.length ? $getWorkflowStaticData('global').last_search_intent.salary_signals : $getWorkflowStaticData('global').user_prefs?.salary_signals) || []) }}";

// ═══ 3a. Detect Revise Type: prefer the current job's resume ═══
const DRT_OLD = "const lastResumeJson = sd.last_resume_json || {};";
const DRT_NEW =
  "// s54: prefer the CURRENT apply's resume -- sd.last_resume_json can point at a\n" +
  "// previous job when a newer apply's content failed its shape check.\n" +
  "const _la = sd.last_apply || {};\n" +
  "const lastResumeJson = (_la.resume_json && Array.isArray(_la.resume_json.experience)) ? _la.resume_json\n" +
  "  : ((sd.last_resume_json && Array.isArray(sd.last_resume_json.experience)) ? sd.last_resume_json : {});";

// ═══ 3c. Update Last Apply: dead revise_type branch removal + legacy guard ═══
const ULA_OLD =
  "const staticData = $getWorkflowStaticData('global');\n" +
  "const ctx = $('Load Revise Context').first().json;\n" +
  "const revised = $('ReviseForge').first().json.output || {};\n" +
  "const type = ctx.last_apply.revise_type;\n" +
  "if (type === 'cover') { staticData.last_apply.cover_json = revised; } else { staticData.last_apply.resume_json = revised; staticData.last_resume_json = revised; }\n";
const ULA_NEW =
  "const staticData = $getWorkflowStaticData('global');\n" +
  "const ctx = $('Load Revise Context').first().json;\n" +
  "const revised = $('ReviseForge').first().json.output || {};\n" +
  "// s54: the old revise_type branch was dead -- no node ever wrote that field\n" +
  "// (Build Revised LaTeX's own comment says so). Revise handles resumes only.\n" +
  "staticData.last_apply = staticData.last_apply || {};\n" +
  "staticData.last_apply.resume_json = revised; staticData.last_resume_json = revised;\n";

// ═══ 3d. Send Revised PDF guards ═══
const SRP_CAPTION_OLD = "={{ '\\u270F\\uFE0F Revised ' + $('Build Revised LaTeX').first().json.revise_type + ' \\u2014 ' + $('Load Revise Context').first().json.last_apply.job_title + ' at ' + $('Load Revise Context').first().json.last_apply.company }}";
const SRP_CAPTION_NEW = "={{ '\\u270F\\uFE0F Revised ' + $('Build Revised LaTeX').first().json.revise_type + ' \\u2014 ' + (($('Load Revise Context').first().json.last_apply || {}).job_title || 'resume') + ' at ' + (($('Load Revise Context').first().json.last_apply || {}).company || 'company') }}";
const SRP_FILE_OLD = "={{ $('Load Revise Context').first().json.last_apply.company.replace(/\\s+/g, '_') + '_revised_' + $('Build Revised LaTeX').first().json.revise_type + '_' + $now.format('yyyyMMdd') + '.pdf' }}";
const SRP_FILE_NEW = "={{ (($('Load Revise Context').first().json.last_apply || {}).company || 'resume').replace(/\\s+/g, '_') + '_revised_' + $('Build Revised LaTeX').first().json.revise_type + '_' + $now.format('yyyyMMdd') + '.pdf' }}";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const conns = wf.connections;

  for (const need of ['Retrieve Job', 'Parse Expand Query', 'ForgeScore', 'Detect Revise Type', 'Update Last Apply', 'Send Revised PDF', 'Build Revised LaTeX', 'Compile Revised PDF', 'Send Job Not Found']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['IF: Revised OK?']) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Retrieve Job'].parameters, 'jsCode', RJ_URL_OLD, RJ_URL_NEW, 'direct-URL job_id hash', base);
  replaceOnce(N['Parse Expand Query'].parameters, 'jsCode', PEQ_OLD, PEQ_NEW, 'Parse Expand Query prefs fallback', base);
  replaceOnce(N['ForgeScore'].parameters.messages.messageValues[0], 'message', FS_OLD, FS_NEW, 'ForgeScore prefs fallback', base);
  replaceOnce(N['Detect Revise Type'].parameters, 'jsCode', DRT_OLD, DRT_NEW, 'Detect Revise Type current-job preference', base);
  replaceOnce(N['Update Last Apply'].parameters, 'jsCode', ULA_OLD, ULA_NEW, 'Update Last Apply dead branch', base);
  replaceOnce(N['Send Revised PDF'].parameters.additionalFields, 'caption', SRP_CAPTION_OLD, SRP_CAPTION_NEW, 'Send Revised PDF caption', base);
  replaceOnce(N['Send Revised PDF'].parameters.additionalFields, 'fileName', SRP_FILE_OLD, SRP_FILE_NEW, 'Send Revised PDF fileName', base);

  // 3b. IF: Revised OK? gate between Build Revised LaTeX and Compile Revised PDF
  const brl = conns['Build Revised LaTeX'];
  if (!brl || !brl.main[0].some((e) => e.node === 'Compile Revised PDF')) { console.error(`INTEGRITY FAIL ${base}: Build Revised LaTeX -> Compile Revised PDF edge missing`); process.exit(1); }
  const gate = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: '={{ Boolean($json.latex) }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    id: crypto.randomUUID(),
    name: 'IF: Revised OK?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [N['Build Revised LaTeX'].position[0] + 150, N['Build Revised LaTeX'].position[1] + 200],
  };
  wf.nodes.push(gate);
  conns['Build Revised LaTeX'].main[0] = [{ node: 'IF: Revised OK?', type: 'main', index: 0 }];
  conns['IF: Revised OK?'] = {
    main: [
      [{ node: 'Compile Revised PDF', type: 'main', index: 0 }],
      [{ node: 'Send Job Not Found', type: 'main', index: 0 }],
    ],
  };

  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(conns)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: data-integrity fixes applied -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. URL hash: two different postings at one company -> different ids; same URL -> stable id.
  {
    const body =
      "const jobUrl = url;\n" +
      RJ_URL_NEW.replace('  return [{ json: { chat_id: chatId, job_number: 0, direct_url: jobUrl, source, company_slug: company, greenhouse_id: null, job: ', '  return [{ json: { job: ').replace(", title: '', company, location: '', url: jobUrl, description_snippet: '' } } }];", " } } }];").replace('`direct-${company}-${_h.toString(36)}`', '`direct-${company}-${_h.toString(36)}`');
    const run = (url) => new Function('url', 'company', "const jobUrl = url;\nlet _h = 5381; for (let _i = 0; _i < jobUrl.length; _i++) { _h = ((_h * 33) ^ jobUrl.charCodeAt(_i)) >>> 0; }\nreturn `direct-${company}-${_h.toString(36)}`;")(url, 'stripe');
    const a = run('https://jobs.lever.co/stripe/role-one-1234');
    const b = run('https://jobs.lever.co/stripe/role-two-5678');
    const a2 = run('https://jobs.lever.co/stripe/role-one-1234');
    if (a === b) { console.error('HARNESS FAIL: two different postings must get different ids', a, b); process.exit(1); }
    if (a !== a2) { console.error('HARNESS FAIL: same URL must get a stable id', a, a2); process.exit(1); }
    if (!/^direct-stripe-[a-z0-9]+$/.test(a)) { console.error('HARNESS FAIL: id format unexpected', a); process.exit(1); }
  }
  console.log('HARNESS OK: direct-URL job_id now unique per posting (different Lever roles at one company get different ids), stable for the same URL');

  // 2. Parse Expand Query fallback: search-derived wins, prefs fill the gap, empty stays empty.
  {
    const run = (parsed, userPrefs) => new Function('parsed', 'userPrefs', 'return {' + PEQ_NEW + '};')(parsed, userPrefs);
    const searchWins = run({ visa_signals: ['h1b'], salary_signals: ['$150k'] }, { visa_signals: ['prefs'], salary_signals: ['prefs$'] });
    if (searchWins.visa_signals[0] !== 'h1b' || searchWins.salary_signals[0] !== '$150k') { console.error('HARNESS FAIL: search-derived signals must win', searchWins); process.exit(1); }
    const prefsFill = run({ visa_signals: [], salary_signals: [] }, { visa_signals: ['cap-exempt'], salary_signals: ['$180k'] });
    if (prefsFill.visa_signals[0] !== 'cap-exempt' || prefsFill.salary_signals[0] !== '$180k') { console.error('HARNESS FAIL: prefs must fill empty search signals', prefsFill); process.exit(1); }
    const empty = run({}, {});
    if (empty.visa_signals.length !== 0 || empty.salary_signals.length !== 0) { console.error('HARNESS FAIL: both-empty should stay []', empty); process.exit(1); }
  }
  console.log('HARNESS OK: Parse Expand Query -- search-derived visa/salary win, durable prefs fill the gap (matching its sibling fields), both-empty stays []');

  // 3. Detect Revise Type preference: current job first, fallback second, {} last.
  {
    const run = (sd) => new Function('sd', DRT_NEW + '\nreturn lastResumeJson;')(sd);
    const current = run({ last_apply: { resume_json: { experience: [1], tag: 'B' } }, last_resume_json: { experience: [1], tag: 'A' } });
    if (current.tag !== 'B') { console.error('HARNESS FAIL: must prefer the current apply resume', current); process.exit(1); }
    const fallback = run({ last_apply: { resume_json: null }, last_resume_json: { experience: [1], tag: 'A' } });
    if (fallback.tag !== 'A') { console.error('HARNESS FAIL: fallback to last_resume_json when current is invalid', fallback); process.exit(1); }
    const none = run({});
    if (Object.keys(none).length !== 0) { console.error('HARNESS FAIL: neither valid -> {}', none); process.exit(1); }
  }
  console.log('HARNESS OK: Detect Revise Type prefers the current apply\'s resume, falls back to last_resume_json, never mixes jobs silently');

  // 4. Update Last Apply: revised always lands in both slots, survives an empty last_apply.
  {
    const sd = {}; // legacy: no last_apply at all
    const body = ULA_NEW
      .replace("const ctx = $('Load Revise Context').first().json;\n", '')
      .replace("const revised = $('ReviseForge').first().json.output || {};\n", '')
      .replace("const staticData = $getWorkflowStaticData('global');\n", '');
    new Function('staticData', 'revised', body)(sd, { v: 9 });
    if (!sd.last_apply || sd.last_apply.resume_json.v !== 9 || sd.last_resume_json.v !== 9) { console.error('HARNESS FAIL: ULA rewrite wrong', sd); process.exit(1); }
  }
  console.log('HARNESS OK: Update Last Apply writes both slots and survives a legacy/empty last_apply (was: crash on .revise_type of undefined)');

  // 5. Guarded caption/fileName expressions: paren balance + no unguarded last_apply deref.
  for (const [label, expr] of [['caption', SRP_CAPTION_NEW], ['fileName', SRP_FILE_NEW]]) {
    let depth = 0;
    for (const ch of expr) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) break; }
    if (depth !== 0) { console.error(`HARNESS FAIL: unbalanced parens in ${label}`); process.exit(1); }
    if (/json\.last_apply\.(job_title|company)/.test(expr)) { console.error(`HARNESS FAIL: ${label} still hard-derefs last_apply`); process.exit(1); }
  }
  console.log('HARNESS OK: Send Revised PDF caption/fileName no longer hard-deref last_apply fields');
})();

TARGETS.forEach(patch);
console.log('S54 (data integrity: unique direct-URL job_id, durable visa/salary prefs, revise-flow staleness cluster) complete.');
