/**
 * s13_fixes.js -- small-fixes batch (exec-29 crash, outreach polish, parser enum).
 *
 * 1) Record Matches: the ONE node on the scheduled-digest path with an unguarded
 *    $('Extract Input') ref (every Send* node got the || Schedule Payload fallback,
 *    this Postgres write was missed) -- crashed execution #29. Mirror Send Digest's
 *    demonstrably-working fallback chain verbatim.
 * 2) Format Contacts: ContactFinder's top_priority array (1-2 recommended contacts
 *    + reason) was emitted by the LLM and read by nothing. Surface it: leading star
 *    on the pick + a "Top pick: <reason>" line.
 * 3) Load Draft Contact: relevant_achievement was a blind resume_text.substring(0,500)
 *    while the OutreachWriter prompt expects "1-2 metric-backed bullets relevant to
 *    the contact". Curated picker: harvest bullets from last_apply.resume_json
 *    (dual-shape: post-s16 content {experience:[{bullets}]} or pass2 {experience_bullets});
 *    keyword-score vs contact role/type/company, +0.5 for metric digits, top-2.
 *    Fragment-shaped/old resume_json has no bullet arrays -> substring fallback.
 * 4) Structured Output Parser (Intent Router): enum stops at check_resume -- the
 *    prompt and Route Intent know 17 intents, the parser 16. Add "costs".
 *
 * Apollo enablement rows (apollo_enabled/apollo_daily_limit/hunter_enabled) are a
 * separate direct-SQL step -- no workflow change needed (Load Enrich Config already
 * COALESCEs missing rows to disabled defaults).
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

// ── 1) Record Matches queryReplacement ──
const RECORD_OLD = "={{ [ $('Extract Input').first().json.chat_id, JSON.stringify($json.scored || []) ] }}";
const RECORD_NEW = "={{ [ $('Extract Input').first().json.chat_id || $('Schedule Payload').first().json.chat_id || $('Telegram Trigger').first().json.message.chat.id, JSON.stringify($json.scored || []) ] }}";

// ── 2) Format Contacts: top_priority star ──
const FC_CONTACTS_OLD = String.raw`const contacts = result.contacts || [];`;
const FC_CONTACTS_NEW = String.raw`const contacts = result.contacts || [];
const topMap = {}; for (const t of (result.top_priority || [])) { const k = String((t && t.name) || t || '').toLowerCase().trim(); if (k) topMap[k] = (t && t.reason) || ''; }`;

const FC_MAP_OLD = String.raw`const lines = contacts.map((c, i) => { const priIcon = c.priority === 'High' ? '\u{1F525}' : c.priority === 'Medium' ? '\u2B50' : '\u{1F4CC}'; const linkedIn = c.linkedin_url ? ' [LinkedIn](' + c.linkedin_url + ')' : ''; return (i + 1) + '. ' + priIcon + ' *' + c.name + '* \u2014 ' + c.role + '\n   ' + c.type + ' | ' + (c.location || '?') + ' | Confidence: ' + c.confidence + linkedIn + '\n   _' + c.reason + '_'; });`;
const FC_MAP_NEW = String.raw`const lines = contacts.map((c, i) => { const priIcon = c.priority === 'High' ? '\u{1F525}' : c.priority === 'Medium' ? '\u2B50' : '\u{1F4CC}'; const linkedIn = c.linkedin_url ? ' [LinkedIn](' + c.linkedin_url + ')' : ''; const topKey = String(c.name || '').toLowerCase().trim(); const isTop = Object.prototype.hasOwnProperty.call(topMap, topKey); return (isTop ? '\u2B50 ' : '') + (i + 1) + '. ' + priIcon + ' *' + c.name + '* \u2014 ' + c.role + '\n   ' + c.type + ' | ' + (c.location || '?') + ' | Confidence: ' + c.confidence + linkedIn + '\n   _' + c.reason + '_' + (isTop && topMap[topKey] ? '\n   \u2B50 _Top pick: ' + topMap[topKey] + '_' : ''); });`;

// ── 3) Load Draft Contact: curated relevant_achievement ──
const PICK_FN = String.raw`function pickAchievements(rj, resumeText, contact, company) {
  const bullets = [];
  const harvest = (arr) => { if (!Array.isArray(arr)) return; for (const e of arr) for (const b of ((e && e.bullets) || [])) if (b && b.text) bullets.push((b.keyword ? b.keyword + ': ' : '') + b.text); };
  if (rj) { harvest(rj.experience_bullets); harvest(rj.project_bullets); harvest(rj.experience); harvest(rj.projects); }
  if (!bullets.length) return resumeText ? resumeText.substring(0, 500) : '';
  const kw = (((contact && contact.role) || '') + ' ' + ((contact && contact.type) || '') + ' ' + (company || '')).toLowerCase().split(/[^a-z0-9+#.]+/).filter(w => w.length > 2);
  const score = (t) => { const lt = t.toLowerCase(); let s = 0; for (const w of kw) if (lt.indexOf(w) !== -1) s += 1; if (/\d/.test(t)) s += 0.5; return s; };
  return bullets.map(t => [score(t), t]).sort((a, b) => b[0] - a[0]).slice(0, 2).map(x => x[1]).join(' \u2022 ');
}`;

const LDC_RESUME_OLD = String.raw`const resumeData = staticData.last_apply || {};`;
const LDC_RESUME_NEW = LDC_RESUME_OLD + '\n' + PICK_FN;
const LDC_ACH_OLD = String.raw`relevant_achievement: resumeData.resume_text ? resumeData.resume_text.substring(0, 500) : ''`;
const LDC_ACH_NEW = String.raw`relevant_achievement: pickAchievements(resumeData.resume_json, resumeData.resume_text, contact, lastContacts.company)`;

// ── harness: exercise every new code path before touching any file ──
(function harness() {
  // Format Contacts -- top pick present (case-mismatched name), absent, and no-top_priority
  const fcBody = (resultFixture) => {
    const pre = 'const result = ' + JSON.stringify(resultFixture) + ';\nconst contacts = result.contacts || [];\n'
      + FC_CONTACTS_NEW.split(FC_CONTACTS_OLD).join('') + '\n';
    return new Function(pre + FC_MAP_NEW + '\nreturn lines;')();
  };
  const withTop = fcBody({
    contacts: [
      { name: 'Jane Doe', role: 'EM', type: 'Hiring Manager', priority: 'High', confidence: 'high', reason: 'runs the team' },
      { name: 'Bob Roe', role: 'Recruiter', type: 'Recruiter', priority: 'Low', confidence: 'medium', reason: 'sources for org' },
    ],
    top_priority: [{ name: 'JANE DOE', reason: 'direct hiring authority' }],
  });
  if (!withTop[0].startsWith('⭐ 1.') || withTop[0].indexOf('Top pick: direct hiring authority') === -1) {
    console.error('HARNESS FAIL: top-pick star/reason missing:\n' + withTop[0]); process.exit(1);
  }
  if (withTop[1].startsWith('\u2B50') || withTop[1].indexOf('Top pick') !== -1) {
    console.error('HARNESS FAIL: non-pick contact got starred'); process.exit(1);
  }
  const noTop = fcBody({ contacts: [{ name: 'X', role: 'r', type: 't', priority: 'High', confidence: 'high', reason: 'z' }] });
  if (noTop[0].startsWith('\u2B50') || noTop[0].indexOf('Top pick') !== -1) {
    console.error('HARNESS FAIL: star leaked with no top_priority'); process.exit(1);
  }

  // pickAchievements -- 4 shapes
  const pick = new Function('rj', 'resumeText', 'contact', 'company',
    PICK_FN + '\nreturn pickAchievements(rj, resumeText, contact, company);');
  const contentShape = { experience: [{ bullets: [
    { keyword: 'RAG', text: 'Improved retrieval accuracy 30% across fintech RAG pipelines' },
    { keyword: '', text: 'Maintained internal tooling' },
    { keyword: 'ML', text: 'Shipped fraud model serving 2M requests daily' },
  ] }] };
  const picked = pick(contentShape, 'fulltext', { role: 'ML Platform Lead', type: 'Hiring Manager' }, 'Acme');
  const parts = picked.split(' • ');
  if (parts.length !== 2 || !/\d/.test(parts[0])) {
    console.error('HARNESS FAIL: content-shape pick wrong: ' + picked); process.exit(1);
  }
  if (picked.indexOf('Maintained internal tooling') !== -1) {
    console.error('HARNESS FAIL: zero-signal bullet outranked metric bullets'); process.exit(1);
  }
  const pass2Shape = { experience_bullets: [{ position_id: 'p1', bullets: [{ keyword: 'K', text: 'Cut latency 40%' }] }] };
  if (pick(pass2Shape, '', {}, '') !== 'K: Cut latency 40%') {
    console.error('HARNESS FAIL: pass2-shape harvest'); process.exit(1);
  }
  const fragmentShape = { header: 'x', experience_entries: '\\resumeItem{legacy latex}' };
  if (pick(fragmentShape, 'RAW RESUME TEXT', {}, '') !== 'RAW RESUME TEXT') {
    console.error('HARNESS FAIL: fragment-shape must fall back to substring'); process.exit(1);
  }
  if (pick(null, null, {}, '') !== '') {
    console.error('HARNESS FAIL: empty inputs must yield empty string'); process.exit(1);
  }
  console.log('HARNESS OK: top-pick star (hit/case/miss/absent) + curated picker (4 shapes) verified');
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

  // 1) Record Matches
  const rm = wf.nodes.find((n) => n.name === 'Record Matches');
  if (!rm) { console.error(`INTEGRITY FAIL ${base}: Record Matches not found`); process.exit(1); }
  if (rm.parameters.options.queryReplacement === RECORD_NEW) {
    console.log(`  ${base}: Record Matches already patched`);
  } else if (rm.parameters.options.queryReplacement !== RECORD_OLD) {
    console.error(`INTEGRITY FAIL ${base}: Record Matches queryReplacement drifted:\n  ${rm.parameters.options.queryReplacement}`);
    process.exit(1);
  } else {
    rm.parameters.options.queryReplacement = RECORD_NEW;
  }

  // 2) Format Contacts
  editCode(wf, base, 'Format Contacts', [[FC_CONTACTS_OLD, FC_CONTACTS_NEW], [FC_MAP_OLD, FC_MAP_NEW]]);

  // 3) Load Draft Contact
  editCode(wf, base, 'Load Draft Contact', [[LDC_RESUME_OLD, LDC_RESUME_NEW], [LDC_ACH_OLD, LDC_ACH_NEW]]);

  // 4) Intent parser enum
  const sops = wf.nodes.filter((n) => n.name === 'Structured Output Parser');
  if (sops.length !== 1) { console.error(`INTEGRITY FAIL ${base}: expected 1 "Structured Output Parser", found ${sops.length}`); process.exit(1); }
  const schema = JSON.parse(sops[0].parameters.inputSchema);
  const en = ((schema.properties || {}).intent || {}).enum;
  if (!Array.isArray(en)) { console.error(`INTEGRITY FAIL ${base}: intent enum missing in parser schema`); process.exit(1); }
  if (en.includes('costs')) {
    console.log(`  ${base}: parser enum already has costs`);
  } else {
    if (en[en.length - 1] !== 'check_resume' || en.length !== 16) {
      console.error(`INTEGRITY FAIL ${base}: parser enum drifted (len ${en.length}, last ${en[en.length - 1]})`);
      process.exit(1);
    }
    en.push('costs');
    sops[0].parameters.inputSchema = JSON.stringify(schema, null, 2);
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Record Matches + Format Contacts + Load Draft Contact + parser enum -- ${wf.nodes.length} nodes`);
}

TARGETS.forEach(patch);
console.log('S13 (fixes batch) complete.');
