/**
 * s62_sections_toggle_keyboard.js -- v9 wave Area C: inline-keyboard tap-to-toggle
 * UI for resume section customization, alongside the existing sections:/order:
 * text commands (unchanged, still work exactly as before).
 *
 * Trigger: a bare "sections" or "/sections" message (nothing else in it -- the
 * existing "sections: experience, education" colon form is untouched and takes
 * a completely different code path). Reuses the existing update_prefs intent
 * branch rather than adding a 19th top-level intent (Route Intent's 18-intent
 * enum is saturated) -- Handle Prefs Update gets an early-return special case,
 * gated by a new IF before the existing Send Pref Confirm.
 *
 * Render is a single shared node (Render Sections Keyboard) fed from BOTH the
 * fresh-command path and every toggle-callback re-render, so the checkbox logic
 * can never drift between first render and re-render. Taps edit the SAME message
 * in place via Telegram's editMessageText with a reply_markup payload -- verified
 * against this n8n version's actual Telegram node source (GenericFunctions.js's
 * addReplyMarkup reads the replyMarkup/inlineKeyboard params unconditionally for
 * every operation except sendMediaGroup, regardless of the node UI's displayOptions
 * visibility rules for editMessageText -- displayOptions is a UI-only concept, not
 * enforced at execution time), not guessed.
 *
 * Route Callback Action's hand-rolled Switch (confirmed NOT saturated, unlike
 * Route Intent) grows from 5 to 7 outputs for the sec:toggle:<id> and sec:done
 * callback_data prefixes.
 *
 * Deliberate scope cuts: toggle only, no up/down reordering via buttons (order:
 * stays text-only -- doubling the callback surface isn't worth it against an
 * already-working simple alternative). No double-tap lock (unlike jd_paste's
 * 45-90s LLM pipeline, a toggle is a synchronous idempotent staticData flip --
 * worst case of a double-tap is a harmless flicker, never a duplicate-cost or
 * data-integrity problem). The last enabled section can't be toggled off (a
 * resume needs at least one section).
 *
 * +8 nodes, no LLM parser/schema change (update_prefs intent already exists).
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

const CANONICAL_SECTIONS = ['summary', 'experience', 'internships', 'education', 'projects', 'skills', 'certifications', 'achievements', 'activities'];

// ═══ 1. Handle Prefs Update: early-return special case for bare "sections" ═══
const HPU_OLD = "const msg = ($('Extract Input').first().json.message_text || '').toLowerCase();\nconst sd  = $getWorkflowStaticData('global');";
const HPU_NEW =
  "const msg = ($('Extract Input').first().json.message_text || '').toLowerCase();\n" +
  "// v9 Area C: bare \"sections\"/\"/sections\" (nothing else in the message) opens\n" +
  "// the inline-keyboard toggle UI instead of the normal preference-delta parser\n" +
  "// below -- \"sections: experience, education\" (with a colon) is a totally\n" +
  "// different match further down and is untouched by this check.\n" +
  "if (/^\\/?sections\\s*$/.test(msg.trim())) {\n" +
  "  return [{ json: { _render_sections: true } }];\n" +
  "}\n" +
  "const sd  = $getWorkflowStaticData('global');";

// ═══ 2. Intent Router: add "sections"/"/sections" as an explicit update_prefs trigger ═══
const IR_OLD = '13. update_prefs — User wants to save a preference. Triggers: "remember that", "from now on", "always", "set my location", "I need cap-exempt"';
const IR_NEW = '13. update_prefs — User wants to save a preference, or a bare "sections"/"/sections" message to open the section-toggle menu. Triggers: "remember that", "from now on", "always", "set my location", "I need cap-exempt", "sections", "/sections"';

// ═══ 3. Route Callback Action: 5 -> 7 outputs for sec:toggle:*/sec:done ═══
const RCA_OLD = "={{ ['resume:apply','resume:cancel','resume:redo'].indexOf($('Extract Callback').first().json.callback_data) !== -1 ? ['resume:apply','resume:cancel','resume:redo'].indexOf($('Extract Callback').first().json.callback_data) : ($('Extract Callback').first().json.callback_data.startsWith('jd:generate') ? 3 : ($('Extract Callback').first().json.callback_data.startsWith('jd:contacts') ? 4 : -1)) }}";
const RCA_NEW = "={{ ['resume:apply','resume:cancel','resume:redo'].indexOf($('Extract Callback').first().json.callback_data) !== -1 ? ['resume:apply','resume:cancel','resume:redo'].indexOf($('Extract Callback').first().json.callback_data) : ($('Extract Callback').first().json.callback_data.startsWith('jd:generate') ? 3 : ($('Extract Callback').first().json.callback_data.startsWith('jd:contacts') ? 4 : ($('Extract Callback').first().json.callback_data.startsWith('sec:toggle:') ? 5 : ($('Extract Callback').first().json.callback_data === 'sec:done' ? 6 : -1)))) }}";

// ═══ Render Sections Keyboard (shared code node) ═══
const RENDER_CODE =
  "// v9 Area C: shared render for the sections-toggle inline keyboard -- fed from\n" +
  "// BOTH the initial \"sections\" command (fresh message, message_id null) and\n" +
  "// every toggle-callback re-render (edits the same message), so the checkbox\n" +
  "// logic can never drift between first render and re-render.\n" +
  "const CANONICAL_SECTIONS = ['summary', 'experience', 'internships', 'education', 'projects', 'skills', 'certifications', 'achievements', 'activities'];\n" +
  "const LABELS = { summary: 'Summary', experience: 'Experience', internships: 'Internships', education: 'Education', projects: 'Projects', skills: 'Skills', certifications: 'Certifications', achievements: 'Achievements', activities: 'Activities' };\n" +
  "let chatId, messageId;\n" +
  "try {\n" +
  "  const cb = $('Extract Callback').first().json;\n" +
  "  chatId = cb.chat_id;\n" +
  "  messageId = cb.message_id;\n" +
  "} catch (e) {\n" +
  "  chatId = $('Extract Input').first().json.chat_id;\n" +
  "  messageId = null;\n" +
  "}\n" +
  "const sd = $getWorkflowStaticData('global');\n" +
  "const prefs = sd.user_prefs || {};\n" +
  "const enabled = Array.isArray(prefs.enabled_sections) && prefs.enabled_sections.length ? prefs.enabled_sections : CANONICAL_SECTIONS.slice();\n" +
  "const order = (Array.isArray(prefs.section_order) ? prefs.section_order.filter((s) => CANONICAL_SECTIONS.includes(s)) : []).slice();\n" +
  "for (const s of CANONICAL_SECTIONS) if (!order.includes(s)) order.push(s);\n" +
  "const sections = order.map((id) => ({ id, label: LABELS[id] || id, enabled: enabled.includes(id) }));\n" +
  "return [{ json: { chat_id: chatId, message_id: messageId, sections } }];";

// ═══ Toggle Section (code node) ═══
const TOGGLE_CODE =
  "// v9 Area C: parse the tapped section id from callback_data ('sec:toggle:<id>')\n" +
  "// and flip its enabled_sections membership -- a pure, synchronous, idempotent\n" +
  "// staticData read-modify-write, no lock needed (unlike jd_paste's slow pipeline).\n" +
  "const CANONICAL_SECTIONS = ['summary', 'experience', 'internships', 'education', 'projects', 'skills', 'certifications', 'achievements', 'activities'];\n" +
  "const cb = $('Extract Callback').first().json;\n" +
  "const id = (cb.callback_data || '').split(':')[2];\n" +
  "const sd = $getWorkflowStaticData('global');\n" +
  "if (!sd.user_prefs) sd.user_prefs = { _schema_version: 1, _history: [] };\n" +
  "const prefs = sd.user_prefs;\n" +
  "let enabled = Array.isArray(prefs.enabled_sections) && prefs.enabled_sections.length ? prefs.enabled_sections.slice() : CANONICAL_SECTIONS.slice();\n" +
  "if (CANONICAL_SECTIONS.includes(id)) {\n" +
  "  if (enabled.includes(id)) {\n" +
  "    // guard: never let the last enabled section be toggled off\n" +
  "    if (enabled.length > 1) enabled = enabled.filter((s) => s !== id);\n" +
  "  } else {\n" +
  "    enabled.push(id);\n" +
  "  }\n" +
  "}\n" +
  "prefs.enabled_sections = enabled;\n" +
  "prefs._updated_at = new Date().toISOString();\n" +
  "return [{ json: {} }];";

const SECTIONS_TEXT = '🧩 *Resume sections* — tap to toggle on/off';

function keyboardRows() {
  const rows = CANONICAL_SECTIONS.map((_, i) => ({
    row: {
      buttons: [{
        text: `={{ ($json.sections[${i}].enabled ? '✅ ' : '⬜ ') + $json.sections[${i}].label }}`,
        additionalFields: { callback_data: `={{ 'sec:toggle:' + $json.sections[${i}].id }}` },
      }],
    },
  }));
  rows.push({ row: { buttons: [{ text: '✅ Done', additionalFields: { callback_data: 'sec:done' } }] } });
  return rows;
}

const TELEGRAM_CRED = { telegramApi: { id: 'XayaGFL8EdfqdoR7', name: 'CareerForge_Telegram' } };

function mkNode(overrides) {
  return Object.assign({ id: crypto.randomUUID(), typeVersion: 1.2, credentials: TELEGRAM_CRED }, overrides);
}

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

  for (const need of ['Handle Prefs Update', 'Send Pref Confirm', 'Intent Router', 'Route Callback Action', 'Extract Callback', 'Extract Input']) {
    if (!N[need]) { console.error(`INTEGRITY FAIL ${base}: node "${need}" not found`); process.exit(1); }
  }
  if (N['Handle Prefs Update'].parameters.jsCode.includes('_render_sections')) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Handle Prefs Update'].parameters, 'jsCode', HPU_OLD, HPU_NEW, 'Handle Prefs Update sections early-return', base);
  replaceOnce(N['Intent Router'].parameters.options, 'systemMessage', IR_OLD, IR_NEW, 'Intent Router sections trigger example', base);
  replaceOnce(N['Route Callback Action'].parameters, 'output', RCA_OLD, RCA_NEW, 'Route Callback Action 7-output switch', base);
  N['Route Callback Action'].parameters.numberOutputs = 7;

  const hpuPos = N['Handle Prefs Update'].position || [0, 0];
  const rcaPos = N['Route Callback Action'].position || [0, 0];

  const ifSectionsCommand = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: '={{ $json._render_sections }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    id: crypto.randomUUID(), name: 'IF: Sections Command?', type: 'n8n-nodes-base.if', typeVersion: 2.2,
    position: [hpuPos[0], hpuPos[1] + 180],
  };
  const renderSectionsKeyboard = {
    parameters: { jsCode: RENDER_CODE },
    id: crypto.randomUUID(), name: 'Render Sections Keyboard', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [hpuPos[0] + 240, hpuPos[1] + 180],
  };
  const ifEditingExisting = {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: '={{ Boolean($json.message_id) }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
      options: {},
    },
    id: crypto.randomUUID(), name: 'IF: Editing Existing Message?', type: 'n8n-nodes-base.if', typeVersion: 2.2,
    position: [hpuPos[0] + 480, hpuPos[1] + 180],
  };
  const sendSectionsKeyboard = mkNode({
    parameters: {
      chatId: '={{ $json.chat_id }}', text: SECTIONS_TEXT, replyMarkup: 'inlineKeyboard',
      inlineKeyboard: { rows: keyboardRows() },
      additionalFields: { appendAttribution: false, parse_mode: 'Markdown' },
    },
    name: 'Send Sections Keyboard', type: 'n8n-nodes-base.telegram',
    position: [hpuPos[0] + 720, hpuPos[1] + 80],
  });
  const editSectionsKeyboard = mkNode({
    parameters: {
      resource: 'message', operation: 'editMessageText', messageType: 'message',
      chatId: '={{ $json.chat_id }}', messageId: '={{ $json.message_id }}', text: SECTIONS_TEXT,
      replyMarkup: 'inlineKeyboard', inlineKeyboard: { rows: keyboardRows() },
      additionalFields: { parse_mode: 'Markdown' },
    },
    name: 'Edit Sections Keyboard', type: 'n8n-nodes-base.telegram',
    position: [hpuPos[0] + 720, hpuPos[1] + 280],
  });
  const answerToggleCallback = mkNode({
    parameters: { resource: 'callback', queryId: "={{ $('Extract Callback').first().json.callback_query_id }}", additionalFields: {} },
    name: 'Answer Section Toggle Callback', type: 'n8n-nodes-base.telegram',
    position: [rcaPos[0] + 300, rcaPos[1] + 200],
  });
  const toggleSection = {
    parameters: { jsCode: TOGGLE_CODE },
    id: crypto.randomUUID(), name: 'Toggle Section', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [rcaPos[0] + 540, rcaPos[1] + 200],
  };
  const answerDoneCallback = mkNode({
    parameters: { resource: 'callback', queryId: "={{ $('Extract Callback').first().json.callback_query_id }}", additionalFields: { text: 'Sections saved ✅' } },
    name: 'Answer Section Done Callback', type: 'n8n-nodes-base.telegram',
    position: [rcaPos[0] + 300, rcaPos[1] + 400],
  });

  wf.nodes.push(ifSectionsCommand, renderSectionsKeyboard, ifEditingExisting, sendSectionsKeyboard, editSectionsKeyboard, answerToggleCallback, toggleSection, answerDoneCallback);

  const C = wf.connections;
  // Handle Prefs Update -> IF: Sections Command? (replaces the direct -> Send Pref Confirm edge)
  C['Handle Prefs Update'] = { main: [[{ node: 'IF: Sections Command?', type: 'main', index: 0 }]] };
  C['IF: Sections Command?'] = { main: [
    [{ node: 'Render Sections Keyboard', type: 'main', index: 0 }],
    [{ node: 'Send Pref Confirm', type: 'main', index: 0 }],
  ] };
  C['Render Sections Keyboard'] = { main: [[{ node: 'IF: Editing Existing Message?', type: 'main', index: 0 }]] };
  C['IF: Editing Existing Message?'] = { main: [
    [{ node: 'Edit Sections Keyboard', type: 'main', index: 0 }],
    [{ node: 'Send Sections Keyboard', type: 'main', index: 0 }],
  ] };
  // Route Callback Action outputs 5/6
  C['Route Callback Action'].main[5] = [{ node: 'Answer Section Toggle Callback', type: 'main', index: 0 }];
  C['Route Callback Action'].main[6] = [{ node: 'Answer Section Done Callback', type: 'main', index: 0 }];
  C['Answer Section Toggle Callback'] = { main: [[{ node: 'Toggle Section', type: 'main', index: 0 }]] };
  C['Toggle Section'] = { main: [[{ node: 'Render Sections Keyboard', type: 'main', index: 0 }]] };

  // integrity: every edge resolves, no dangling connections
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: section-toggle keyboard wired -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // 1. Handle Prefs Update: bare "sections"/"/sections" short-circuits; the
  // existing "sections: x, y" colon form is untouched and falls through.
  {
    const run = (msgText) => {
      const $ = (name) => ({ first: () => ({ json: { message_text: msgText } }) });
      const $getWorkflowStaticData = () => ({});
      const body = HPU_NEW + "\nreturn { earlyReturned: false };";
      try {
        return new Function('$', '$getWorkflowStaticData', body)($, $getWorkflowStaticData);
      } catch (e) { throw e; }
    };
    const bare = run('sections');
    if (!Array.isArray(bare) || bare[0].json._render_sections !== true) { console.error('HARNESS FAIL: bare "sections" should early-return _render_sections:true', bare); process.exit(1); }
    const bareSlash = run('/sections');
    if (!Array.isArray(bareSlash) || bareSlash[0].json._render_sections !== true) { console.error('HARNESS FAIL: bare "/sections" should early-return _render_sections:true', bareSlash); process.exit(1); }
    const withColon = run('sections: experience, education');
    if (Array.isArray(withColon)) { console.error('HARNESS FAIL: "sections: x, y" (colon form) must NOT early-return -- it should fall through to the existing parser', withColon); process.exit(1); }
    if (withColon.earlyReturned !== false) { console.error('HARNESS FAIL: colon form should reach the end of the function body', withColon); process.exit(1); }
  }
  console.log('HARNESS OK: Handle Prefs Update -- bare "sections"/"/sections" opens the keyboard, "sections: x, y" (colon form) is untouched and still falls through to the existing parser');

  // 2. Route Callback Action: sec:toggle:* -> 5, sec:done -> 6, existing prefixes unchanged.
  {
    const run = (data) => new Function('$', 'return ' + RCA_NEW.slice(3, -3) + ';')((name) => ({ first: () => ({ json: { callback_data: data } }) }));
    if (run('resume:apply') !== 0) { console.error('HARNESS FAIL: resume:apply should still route to 0'); process.exit(1); }
    if (run('jd:generate:abc') !== 3) { console.error('HARNESS FAIL: jd:generate should still route to 3'); process.exit(1); }
    if (run('jd:contacts:abc') !== 4) { console.error('HARNESS FAIL: jd:contacts should still route to 4'); process.exit(1); }
    if (run('sec:toggle:experience') !== 5) { console.error('HARNESS FAIL: sec:toggle:* should route to 5'); process.exit(1); }
    if (run('sec:done') !== 6) { console.error('HARNESS FAIL: sec:done should route to 6'); process.exit(1); }
    if (run('unknown:x') !== -1) { console.error('HARNESS FAIL: unknown prefix should still route to -1'); process.exit(1); }
  }
  console.log('HARNESS OK: Route Callback Action -- sec:toggle:*/sec:done route to the new outputs 5/6, all 5 existing prefixes unchanged');

  // 3. Render Sections Keyboard: message path (Extract Callback not executed) uses
  // Extract Input + null message_id; callback path uses Extract Callback's chat/message id.
  // Default (no prefs) = all 9 enabled, canonical order.
  {
    function run(mode) {
      const $ = (name) => {
        if (mode === 'callback' && name === 'Extract Callback') return { first: () => ({ json: { chat_id: 111, message_id: 222 } }) };
        if (mode === 'message' && name === 'Extract Callback') throw new Error('no_execution_data');
        if (name === 'Extract Input') return { first: () => ({ json: { chat_id: 999 } }) };
        throw new Error('unexpected node ' + name);
      };
      const $getWorkflowStaticData = () => ({ user_prefs: {} });
      return new Function('$', '$getWorkflowStaticData', RENDER_CODE)($, $getWorkflowStaticData);
    }
    const msgPath = run('message')[0].json;
    if (msgPath.chat_id !== 999 || msgPath.message_id !== null) { console.error('HARNESS FAIL: message path should use Extract Input chat_id + null message_id', msgPath); process.exit(1); }
    const cbPath = run('callback')[0].json;
    if (cbPath.chat_id !== 111 || cbPath.message_id !== 222) { console.error('HARNESS FAIL: callback path should use Extract Callback chat_id/message_id', cbPath); process.exit(1); }
    if (msgPath.sections.length !== 9 || !msgPath.sections.every((s) => s.enabled)) { console.error('HARNESS FAIL: default (no prefs) should be all 9 sections enabled', msgPath.sections); process.exit(1); }
    if (msgPath.sections[0].id !== 'summary' || msgPath.sections[8].id !== 'activities') { console.error('HARNESS FAIL: default order should be canonical order', msgPath.sections.map((s) => s.id)); process.exit(1); }
  }
  console.log('HARNESS OK: Render Sections Keyboard -- correctly branches message-path vs callback-path context, defaults to all 9 sections enabled in canonical order');

  // 4. Render Sections Keyboard: respects enabled_sections + section_order, missing
  // canonical sections still get appended to a custom order.
  {
    function run() {
      const $ = (name) => { if (name === 'Extract Callback') return { first: () => ({ json: { chat_id: 1, message_id: 2 } }) }; throw new Error('x'); };
      const $getWorkflowStaticData = () => ({ user_prefs: { enabled_sections: ['experience', 'skills'], section_order: ['skills', 'experience'] } });
      return new Function('$', '$getWorkflowStaticData', RENDER_CODE)($, $getWorkflowStaticData);
    }
    const out = run()[0].json;
    if (out.sections[0].id !== 'skills' || out.sections[1].id !== 'experience') { console.error('HARNESS FAIL: custom section_order should be honored first', out.sections.map((s) => s.id)); process.exit(1); }
    if (out.sections.length !== 9) { console.error('HARNESS FAIL: sections missing from a custom order must still be appended (all 9 present)', out.sections.map((s) => s.id)); process.exit(1); }
    const enabledIds = out.sections.filter((s) => s.enabled).map((s) => s.id).sort();
    if (JSON.stringify(enabledIds) !== JSON.stringify(['experience', 'skills'])) { console.error('HARNESS FAIL: enabled flags should reflect enabled_sections', enabledIds); process.exit(1); }
  }
  console.log('HARNESS OK: Render Sections Keyboard -- custom section_order honored, sections missing from a partial custom order still appended, enabled flags correct');

  // 5. Toggle Section: toggles membership, guards the last-enabled section, ignores unknown ids.
  {
    function run(callbackData, initialEnabled) {
      const sd = { user_prefs: { enabled_sections: initialEnabled ? initialEnabled.slice() : undefined } };
      const $ = (name) => { if (name === 'Extract Callback') return { first: () => ({ json: { callback_data: callbackData } }) }; throw new Error('x'); };
      const $getWorkflowStaticData = () => sd;
      new Function('$', '$getWorkflowStaticData', TOGGLE_CODE)($, $getWorkflowStaticData);
      return sd.user_prefs.enabled_sections;
    }
    const disabled = run('sec:toggle:skills', ['experience', 'skills', 'education']);
    if (disabled.includes('skills')) { console.error('HARNESS FAIL: skills should have been disabled', disabled); process.exit(1); }
    const enabled = run('sec:toggle:projects', ['experience']);
    if (!enabled.includes('projects')) { console.error('HARNESS FAIL: projects should have been enabled', enabled); process.exit(1); }
    const guarded = run('sec:toggle:experience', ['experience']);
    if (guarded.length !== 1 || !guarded.includes('experience')) { console.error('HARNESS FAIL: the last enabled section must not be toggled off', guarded); process.exit(1); }
    const ignored = run('sec:toggle:not_a_real_section', ['experience']);
    if (JSON.stringify(ignored) !== JSON.stringify(['experience'])) { console.error('HARNESS FAIL: an unknown section id should be a no-op', ignored); process.exit(1); }
  }
  console.log('HARNESS OK: Toggle Section -- toggles membership correctly, guards against disabling the last enabled section, ignores unrecognized ids');

  // 6. Keyboard row structure: exactly 9 toggle rows + 1 done row, valid callback_data shape.
  {
    const rows = keyboardRows();
    if (rows.length !== 10) { console.error('HARNESS FAIL: expected 10 rows (9 sections + done)', rows.length); process.exit(1); }
    for (let i = 0; i < 9; i++) {
      const btn = rows[i].row.buttons[0];
      if (!btn.text.includes(`sections[${i}]`) || !btn.additionalFields.callback_data.includes(`sections[${i}]`)) { console.error(`HARNESS FAIL: row ${i} does not reference sections[${i}]`, btn); process.exit(1); }
    }
    if (rows[9].row.buttons[0].additionalFields.callback_data !== 'sec:done') { console.error('HARNESS FAIL: last row should be the sec:done button', rows[9]); process.exit(1); }
  }
  console.log('HARNESS OK: keyboard row structure -- 9 positional section rows + 1 done row, correct callback_data shape');
})();

TARGETS.forEach(patch);
console.log('S62 (v9 Area C: section-toggle inline keyboard) complete.');
