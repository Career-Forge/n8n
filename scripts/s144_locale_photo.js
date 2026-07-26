/**
 * s144_locale_photo.js -- locale-aware resume/cover, step 5 of 5 (s140-s144).
 * Photo subsystem: a Telegram photo upload (with an explicit "photo" caption
 * keyword, a deliberate safety gate against treating an arbitrary shared
 * image as a profile photo) gets saved to disk and referenced from
 * resume_structured.json; the render side embeds it only when the resolved
 * locale profile's disclosure gate allows it AND the candidate has one on
 * file.
 *
 * New workflow nodes (graph edit -- extra care on connection integrity,
 * per this project's own established precedent for this class of change):
 *   Extract Input (MODIFY) --photo_file_id (last/largest of message.photo)
 *   IF: Has Photo? --new-- (photo_file_id present AND caption/text matches /\bphoto\b/i)
 *     -> Download Photo File --new-- (Telegram resource:file, mirrors the
 *        existing "Download Resume File" node exactly)
 *     -> Save Profile Photo --new-- (readWriteFile write,
 *        /data/user-data/profile_photo.jpg -- the SAME n8n-native binary
 *        write mechanism "Save Global File" already uses, not code-node fs)
 *     -> Read Resume For Photo --new-- (readWriteFile read, same file
 *        resume_structured.json every other resume reader uses)
 *     -> Parse And Patch Resume Photo --new-- (Code: parse the binary same
 *        way "Read Master Resume (Apply) (parse)" already does, then set
 *        personal.photo -- profile.photo is the SAME object reference per
 *        Ingest Resume JSON's own convention, so one assignment covers both)
 *     -> IF: Resume Parsed OK For Photo? --new-- (guards against writing a
 *        {_error:...} sentinel over a real/nonexistent resume_structured.json)
 *        true  -> Convert Patched Resume To File --new-- (convertToFile,
 *                 mirrors "Global To File" exactly)
 *              -> Save Patched Resume File --new-- (readWriteFile write,
 *                 same file, mirrors "Save Global File" exactly)
 *              -> Send Photo Saved Ack --new-- (full success message)
 *        false -> Send Photo Saved Ack (same node, different text branch --
 *                 a photo sent before /setup is saved on disk but has
 *                 nothing to attach to yet; told to the user, not silently
 *                 dropped)
 *   This whole branch is a SECOND, independent outgoing edge off Extract
 *   Input (parallel to the existing "IF: Has Document?" edge) -- zero
 *   changes to any existing node or edge, matching this session's own
 *   "purely additive" precedent (e.g. s139's Compute Candidate YOE).
 *
 * Render side (3 LaTeX nodes, all already-tracked blocks -- SKELETON gains
 * one unconditional \usepackage{graphicx} line; buildHeaderFromPersonal's
 * existing return expression is captured into a base variable and
 * conditionally wrapped in a two-column minipage pair with the photo when
 * the gate allows it -- fs.existsSync belt-and-suspenders so a stale
 * personal.photo value with no actual file on disk degrades to the
 * unmodified header instead of failing pdflatex on a missing image).
 *
 * Budget: Build Pass1 Context's s141 header-line compensation gains the
 * missing 'photo' check (header_line_costs.photo already existed in
 * locale_profiles.json since s140 -- nothing read it until now).
 *
 * Compose: the latex service gets a new read-only user-data mount so
 * pdflatex can actually see the photo file at compile time (deploy note:
 * this needs `docker compose up -d latex` -- a container recreate, not the
 * usual workflow-only cp/import/restart dance).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const MASTER_FILE = path.join(ROOT, 'workflows', 'CareerForge_Master_local.json');
const COMPOSE_FILE = path.join(ROOT, 'docker', 'docker-compose.yml');

function replaceOnce(container, key, oldStr, newStr, label) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, () => newStr);
}
function replaceOnceStr(str, oldStr, newStr, label) {
  const count = str.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  return str.replace(oldStr, () => newStr);
}

// ════════════════════ Part 1: docker-compose.yml -- latex service mount ════════════════════
const COMPOSE_OLD = `    container_name: careerforge_latex
    hostname: latex-service
    restart: unless-stopped`;
const COMPOSE_NEW = `    container_name: careerforge_latex
    hostname: latex-service
    restart: unless-stopped
    volumes:
      - ../user-data:/data/user-data:ro`;

function patchCompose() {
  let yml = fs.readFileSync(COMPOSE_FILE, 'utf8');
  if (yml.includes(COMPOSE_NEW)) { console.log('  docker-compose.yml: already patched'); return; }
  yml = replaceOnceStr(yml, COMPOSE_OLD, COMPOSE_NEW, 'docker-compose.yml latex service block');
  fs.writeFileSync(COMPOSE_FILE, yml);
  console.log('  docker-compose.yml: patched (latex service gains a :ro user-data mount -- needs `docker compose up -d latex` to take effect)');
}

// ════════════════════ Part 2: Extract Input -- photo_file_id ════════════════════
const EI_ANCHOR_OLD = `      {
        "id": "83d5db8f-ffcc-41ef-a398-bf775787c16c",
        "name": "document_mime_type",
        "value": "={{ $json.message?.document?.mime_type || null }}",
        "type": "string"
      }
    ]
  },
  "options": {}
}`;

function patchExtractInput(wf) {
  const n = wf.nodes.find((x) => x.name === 'Extract Input');
  if (!n) { console.error('INTEGRITY FAIL: Extract Input missing'); process.exit(1); }
  const list = n.parameters.assignments.assignments;
  if (list.some((a) => a.name === 'photo_file_id')) { console.log('  Extract Input: already patched'); return; }
  if (list.some((a) => a.name === 'document_mime_type') !== true) { console.error('INTEGRITY FAIL: Extract Input missing document_mime_type assignment'); process.exit(1); }
  list.push({
    id: crypto.randomUUID(),
    name: 'photo_file_id',
    value: "={{ ($json.message?.photo && $json.message.photo.length) ? $json.message.photo[$json.message.photo.length - 1].file_id : null }}",
    type: 'string',
  });
  console.log('  Extract Input: patched (photo_file_id added)');
}

// ════════════════════ Part 3: new nodes + connections ════════════════════
function mkNode(name, type, typeVersion, parameters, extra) {
  return Object.assign({
    id: crypto.randomUUID(),
    name,
    type,
    typeVersion,
    position: [24368, 51200],
    parameters,
  }, extra || {});
}

function buildNewNodes(telegramCredential) {
  const ifHasPhoto = mkNode('IF: Has Photo?', 'n8n-nodes-base.if', 2.2, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        leftValue: "={{ Boolean($json.photo_file_id) && /\\bphoto\\b/i.test($json.message_text || '') }}",
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  });

  const downloadPhotoFile = mkNode('Download Photo File', 'n8n-nodes-base.telegram', 1.2, {
    resource: 'file',
    fileId: '={{ $json.photo_file_id }}',
    additionalFields: {},
  }, { credentials: telegramCredential });

  const saveProfilePhoto = mkNode('Save Profile Photo', 'n8n-nodes-base.readWriteFile', 1.1, {
    operation: 'write',
    fileName: '/data/user-data/profile_photo.jpg',
    options: {},
  });

  const readResumeForPhoto = mkNode('Read Resume For Photo', 'n8n-nodes-base.readWriteFile', 1.1, {
    fileSelector: '/data/user-data/resume_structured.json',
    options: {},
  }, { onError: 'continueRegularOutput', alwaysOutputData: true });

  const parseAndPatch = mkNode('Parse And Patch Resume Photo', 'n8n-nodes-base.code', 2, {
    jsCode: `// Parse the JSON file read by the preceding Read/Write Files node (no fs,
// no extractFromFile -- same pattern as Read Master Resume (Apply) (parse)),
// then patch personal.photo (== profile.photo, same object reference, per
// Ingest Resume JSON's own convention) with the filename Save Profile Photo
// just wrote. Gracefully flags (never throws) if no resume_structured.json
// exists yet -- a photo sent before /setup has nothing to attach to.
let value = null;
try { const buf = await this.helpers.getBinaryDataBuffer(0, 'data'); if (buf && buf.length) value = JSON.parse(buf.toString('utf8')); } catch (e) {}
if (!value || typeof value !== 'object') {
  return [{ json: { _error: 'no_resume_yet' } }];
}
const p = value.personal || value.profile || {};
p.photo = 'profile_photo.jpg';
value.personal = p;
value.profile = p;
return [{ json: value }];`,
  });

  const ifParsedOk = mkNode('IF: Resume Parsed OK For Photo?', 'n8n-nodes-base.if', 2.2, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        leftValue: '={{ !$json._error }}',
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      }],
      combinator: 'and',
    },
    options: {},
  });

  const convertPatched = mkNode('Convert Patched Resume To File', 'n8n-nodes-base.convertToFile', 1.1, {
    operation: 'toJson',
    mode: 'each',
    options: { format: true },
  });

  const savePatched = mkNode('Save Patched Resume File', 'n8n-nodes-base.readWriteFile', 1.1, {
    operation: 'write',
    fileName: '/data/user-data/resume_structured.json',
    options: {},
  });

  const sendAck = mkNode('Send Photo Saved Ack', 'n8n-nodes-base.telegram', 1.2, {
    chatId: "={{ $('Extract Input').first().json.chat_id }}",
    text: "={{ $json._error === 'no_resume_yet' ? '\ud83d\udcf8 Got your photo -- saved. You have not set up your resume yet, though, so there is nothing to attach it to. Run /setup, then resend the photo (with \"photo\" in the caption) to attach it.' : '\ud83d\udcf8 Got it -- your photo is saved and will be added to your resume for locales that expect one.' }}",
    additionalFields: { parse_mode: 'Markdown' },
  }, { credentials: telegramCredential });

  return { ifHasPhoto, downloadPhotoFile, saveProfilePhoto, readResumeForPhoto, parseAndPatch, ifParsedOk, convertPatched, savePatched, sendAck };
}

function addConnection(wf, from, to, fromOutputIndex) {
  wf.connections[from] = wf.connections[from] || { main: [] };
  const idx = fromOutputIndex || 0;
  while (wf.connections[from].main.length <= idx) wf.connections[from].main.push([]);
  wf.connections[from].main[idx].push({ node: to, type: 'main', index: 0 });
}

function patchGraph(wf) {
  if (wf.nodes.some((n) => n.name === 'IF: Has Photo?')) { console.log('  graph: already patched (IF: Has Photo? exists)'); return; }
  const downloadResumeFile = wf.nodes.find((n) => n.name === 'Download Resume File');
  if (!downloadResumeFile) { console.error('INTEGRITY FAIL: Download Resume File missing (needed to clone Telegram credential)'); process.exit(1); }
  const telegramCredential = JSON.parse(JSON.stringify(downloadResumeFile.credentials));

  const nodes = buildNewNodes(telegramCredential);
  for (const n of Object.values(nodes)) wf.nodes.push(n);

  addConnection(wf, 'Extract Input', 'IF: Has Photo?');
  addConnection(wf, 'IF: Has Photo?', 'Download Photo File', 0);
  addConnection(wf, 'Download Photo File', 'Save Profile Photo', 0);
  addConnection(wf, 'Save Profile Photo', 'Read Resume For Photo', 0);
  addConnection(wf, 'Read Resume For Photo', 'Parse And Patch Resume Photo', 0);
  addConnection(wf, 'Parse And Patch Resume Photo', 'IF: Resume Parsed OK For Photo?', 0);
  addConnection(wf, 'IF: Resume Parsed OK For Photo?', 'Convert Patched Resume To File', 0);
  addConnection(wf, 'IF: Resume Parsed OK For Photo?', 'Send Photo Saved Ack', 1);
  addConnection(wf, 'Convert Patched Resume To File', 'Save Patched Resume File', 0);
  addConnection(wf, 'Save Patched Resume File', 'Send Photo Saved Ack', 0);

  console.log('  graph: patched (9 new nodes + 10 new edges, purely additive off Extract Input)');
}

// ════════════════════ Part 4: SKELETON -- unconditional graphicx ════════════════════
const SKELETON_OLD = '\\usepackage{tabularx}';
const SKELETON_NEW = '\\usepackage{tabularx}\n\\usepackage{graphicx}';

// ════════════════════ Part 5: buildHeaderFromPersonal -- photo wrap ════════════════════
// Real VALUES (1 real backslash per LaTeX command, normal single-level JS
// escaping -- exactly like every other string literal in this codebase).
// JSON.stringify() below embeds each safely as correctly-escaped generated
// source code -- no manual double-escaping (the exact lesson from s141's
// first, wrong, hand-typed attempt at this same function).
const PHOTO_WRAP_PREFIX = '\\noindent\\begin{minipage}[c]{0.78\\textwidth}\n';
const PHOTO_WRAP_MIDDLE = '\n\\end{minipage}\\hfill\\begin{minipage}[c]{0.18\\textwidth}\\includegraphics[height=2.5cm]{';
const PHOTO_WRAP_SUFFIX = '}\\end{minipage}';

function transformBuildHeaderFromPersonalPhoto(block) {
  const RETURN_ANCHOR = '  return ';
  const idx = block.lastIndexOf(RETURN_ANCHOR);
  if (idx === -1) { console.error('INTEGRITY FAIL: buildHeaderFromPersonal return anchor not found (photo wrap)'); process.exit(1); }
  const head = block.slice(0, idx);
  const tail = block.slice(idx + RETURN_ANCHOR.length); // "EXPR;\n}"
  const lastSemi = tail.lastIndexOf(';');
  if (lastSemi === -1) { console.error('INTEGRITY FAIL: buildHeaderFromPersonal return statement has no terminating ";" (photo wrap)'); process.exit(1); }
  const expr = tail.slice(0, lastSemi);
  const afterSemi = tail.slice(lastSemi); // ";\n}"

  const photoLogic = [
    'const __headerLatexBase = ' + expr + ';',
    "  const __photoPath = '/data/user-data/profile_photo.jpg';",
    '  let __headerLatex = __headerLatexBase;',
    "  if (localeGateAllows(__locFields, 'photo') && p.photo && require('fs').existsSync(__photoPath)) {",
    '    __headerLatex = ' + JSON.stringify(PHOTO_WRAP_PREFIX) + ' + __headerLatexBase + ' + JSON.stringify(PHOTO_WRAP_MIDDLE) + ' + __photoPath + ' + JSON.stringify(PHOTO_WRAP_SUFFIX) + ';',
    '  }',
    '  return __headerLatex',
  ].join('\n  ');

  return head + '  ' + photoLogic + afterSemi;
}

function patchLatexNode(nodeName, wf) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) { console.error(`INTEGRITY FAIL: ${nodeName} missing`); process.exit(1); }
  if (n.parameters.jsCode.includes('__photoPath')) { console.log(`  ${nodeName}: already patched`); return; }
  let code = n.parameters.jsCode;
  code = replaceOnceStr(code, SKELETON_OLD, SKELETON_NEW, `${nodeName} SKELETON graphicx`);
  const start = code.indexOf('function buildHeaderFromPersonal(p) {');
  const end = code.indexOf('\n}', start) + 2;
  if (start === -1 || end === 1) { console.error(`INTEGRITY FAIL: ${nodeName} buildHeaderFromPersonal block not found`); process.exit(1); }
  const block = code.slice(start, end);
  const newBlock = transformBuildHeaderFromPersonalPhoto(block);
  code = code.slice(0, start) + newBlock + code.slice(end);
  n.parameters.jsCode = code;
  console.log(`  ${nodeName}: patched (graphicx + photo wrap)`);
}

// ════════════════════ Part 6: Build Pass1 Context -- photo compensation ════════════════════
const BP1C_PHOTO_OLD = "if (localeGateAllows(_locProfile.fields, 'signature_line') && _personal.signature === true) _extraHeaderLines += _costs.signature_block || 3;";
const BP1C_PHOTO_NEW = BP1C_PHOTO_OLD + "\n  if (localeGateAllows(_locProfile.fields, 'photo') && _personal.photo) _extraHeaderLines += _costs.photo || 5;";

function patchBuildPass1ContextPhoto(wf) {
  const n = wf.nodes.find((x) => x.name === 'Build Pass1 Context');
  if (!n) { console.error('INTEGRITY FAIL: Build Pass1 Context missing'); process.exit(1); }
  if (n.parameters.jsCode.includes("_costs.photo")) { console.log('  Build Pass1 Context: already patched (photo compensation)'); return; }
  replaceOnce(n.parameters, 'jsCode', BP1C_PHOTO_OLD, BP1C_PHOTO_NEW, 'Build Pass1 Context signature_block compensation (insertion point)');
  console.log('  Build Pass1 Context: patched (photo compensation added)');
}

// ════════════════════════════════ HARNESS ════════════════════════════════
(function harness() {
  let failures = 0;
  function check(label, cond) { if (!cond) { console.error('HARNESS FAIL:', label); failures++; } }

  // ---- docker-compose.yml ----
  const yml = fs.readFileSync(COMPOSE_FILE, 'utf8');
  if (!yml.includes(COMPOSE_NEW)) {
    check('docker-compose.yml: latex service anchor unique', yml.split(COMPOSE_OLD).length - 1 === 1);
  }

  const wf = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const N = {};
  for (const n of wf.nodes) N[n.name] = n;

  // ---- Extract Input ----
  if (!N['Extract Input'].parameters.assignments.assignments.some((a) => a.name === 'photo_file_id')) {
    check('Extract Input: document_mime_type assignment present (anchor for photo_file_id append)', N['Extract Input'].parameters.assignments.assignments.some((a) => a.name === 'document_mime_type'));
  }
  check('Download Resume File exists (credential-clone source)', !!N['Download Resume File']);

  // ---- LaTeX nodes: pre-patch anchors ----
  for (const nodeName of ['Assemble Resume LaTeX', 'Assemble Regen', 'Build Revised LaTeX']) {
    const code = N[nodeName].parameters.jsCode;
    if (!code.includes('__photoPath')) {
      check(`${nodeName}: SKELETON tabularx anchor unique`, code.split(SKELETON_OLD).length - 1 === 1);
      check(`${nodeName}: buildHeaderFromPersonal present`, code.indexOf('function buildHeaderFromPersonal(p) {') !== -1);
    }
  }
  if (!N['Build Pass1 Context'].parameters.jsCode.includes('_costs.photo')) {
    check('Build Pass1 Context: signature_block compensation anchor unique', N['Build Pass1 Context'].parameters.jsCode.split(BP1C_PHOTO_OLD).length - 1 === 1);
  }

  if (failures > 0) { console.error(`\n${failures} PRE-PATCH ANCHOR FAILURE(S)`); process.exit(1); }

  // ---- Behavioral test: IF: Has Photo? condition logic (real expression, standalone) ----
  function testHasPhotoExpr(photoFileId, messageText) {
    return Boolean(photoFileId) && /\bphoto\b/i.test(messageText || '');
  }
  check('IF: Has Photo? -- photo + "photo" caption -> true', testHasPhotoExpr('abc123', 'here is my photo') === true);
  check('IF: Has Photo? -- photo, no "photo" word in caption -> false (deliberate safety gate)', testHasPhotoExpr('abc123', 'check this out') === false);
  check('IF: Has Photo? -- no photo at all -> false', testHasPhotoExpr(null, 'my photo') === false);
  check('IF: Has Photo? -- case-insensitive match', testHasPhotoExpr('abc123', 'PHOTO attached') === true);

  // ---- Behavioral test: photo_file_id extraction (last/largest of message.photo) ----
  function extractPhotoFileId(message) {
    return (message?.photo && message.photo.length) ? message.photo[message.photo.length - 1].file_id : null;
  }
  check('photo_file_id: picks the LAST (largest) size variant', extractPhotoFileId({ photo: [{ file_id: 'small' }, { file_id: 'medium' }, { file_id: 'large' }] }) === 'large');
  check('photo_file_id: no photo array -> null', extractPhotoFileId({}) === null);
  check('photo_file_id: empty photo array -> null', extractPhotoFileId({ photo: [] }) === null);

  // ---- Behavioral test: buildHeaderFromPersonal photo wrap, real literal source ----
  {
    const rawCode = N['Assemble Resume LaTeX'].parameters.jsCode;
    function extract(code, start, end) { const si = code.indexOf(start); const ei = code.indexOf(end, si + start.length); return code.slice(si, ei + end.length); }
    const oldBuildHeader = extract(rawCode, 'function buildHeaderFromPersonal(p) {', '\n}');
    const newBuildHeader = rawCode.includes('__photoPath')
      ? oldBuildHeader
      : transformBuildHeaderFromPersonalPhoto(oldBuildHeader);
    const escapeLatexTextV2Src = extract(rawCode, 'function escapeLatexTextV2(value) {', '\n  return s;\n}');
    const firstNonEmptySrc = extract(rawCode, 'function firstNonEmpty(...values) {', '\n}');
    const normalizeUrlSrc = extract(rawCode, 'function normalizeUrl(u) {', '\n}');
    const visibleUrlSrc = extract(rawCode, 'function visibleUrlTextV2(u) {', '\n}');
    const localeGateAllowsSrc = 'function localeGateAllows(fields, key) { return !!fields && (fields[key] === \'optional\' || fields[key] === \'expected\'); }';

    function runHeader(personal, localeProfile, jobCountryCode, photoExists) {
      const fsMock = { existsSync: (p) => (p === '/data/user-data/profile_photo.jpg' ? !!photoExists : false) };
      const unitSrc = [firstNonEmptySrc, normalizeUrlSrc, visibleUrlSrc, escapeLatexTextV2Src, localeGateAllowsSrc, newBuildHeader].join('\n');
      const fn = new Function('p', '__localeProfile', '__jobCountryCode', 'require', unitSrc + '\nreturn buildHeaderFromPersonal(p);');
      return fn(personal, localeProfile, jobCountryCode, (mod) => { if (mod === 'fs') return fsMock; throw new Error('unexpected require: ' + mod); });
    }

    const PERSONAL_NO_PHOTO = { name: 'Alex Candidate', email: 'a@example.com' };
    const DACH_NO_PHOTO_FIELD = { fields: { photo: 'forbidden' } };
    const DACH_PHOTO_FIELD = { fields: { photo: 'expected' } };

    check('photo wrap: DEFAULT (field forbidden) -> no minipage wrap even if p.photo is set + file exists', !runHeader({ ...PERSONAL_NO_PHOTO, photo: 'profile_photo.jpg' }, DACH_NO_PHOTO_FIELD, null, true).includes('includegraphics'));
    check('photo wrap: gate allows + p.photo set + file EXISTS -> wraps with includegraphics', runHeader({ ...PERSONAL_NO_PHOTO, photo: 'profile_photo.jpg' }, DACH_PHOTO_FIELD, null, true).includes('\\includegraphics[height=2.5cm]{/data/user-data/profile_photo.jpg}'));
    check('photo wrap: gate allows + p.photo set but file does NOT exist -> graceful no-wrap (belt-and-suspenders)', !runHeader({ ...PERSONAL_NO_PHOTO, photo: 'profile_photo.jpg' }, DACH_PHOTO_FIELD, null, false).includes('includegraphics'));
    check('photo wrap: gate allows but p.photo is empty (no opt-in value) -> no wrap (AND-gate)', !runHeader(PERSONAL_NO_PHOTO, DACH_PHOTO_FIELD, null, true).includes('includegraphics'));
    const wrapped = runHeader({ ...PERSONAL_NO_PHOTO, photo: 'profile_photo.jpg' }, DACH_PHOTO_FIELD, null, true);
    check('photo wrap: still contains the original header content (name) inside the minipage', wrapped.includes('Alex Candidate'));
    check('photo wrap: uses a real pdflatex-valid two-minipage structure', wrapped.includes('\\begin{minipage}[c]{0.78\\textwidth}') && wrapped.includes('\\begin{minipage}[c]{0.18\\textwidth}') && (wrapped.match(/\\end\{minipage\}/g) || []).length === 2);
  }

  // ---- Behavioral test: Build Pass1 Context photo compensation ----
  {
    function localeGateAllows(fields, key) { return !!fields && (fields[key] === 'optional' || fields[key] === 'expected'); }
    function computeExtra(profile, personal) {
      const _locProfile = profile; const _personal = personal;
      let _extraHeaderLines = 0;
      if (_locProfile && _locProfile.fields) {
        const _costs = _locProfile.header_line_costs || { photo: 5 };
        if (localeGateAllows(_locProfile.fields, 'photo') && _personal.photo) _extraHeaderLines += _costs.photo || 5;
      }
      return _extraHeaderLines;
    }
    check('BP1C photo compensation: gate allows + real photo -> +5 lines (default cost)', computeExtra({ fields: { photo: 'expected' }, header_line_costs: {} }, { photo: 'profile_photo.jpg' }) === 5);
    check('BP1C photo compensation: gate forbids -> 0', computeExtra({ fields: { photo: 'forbidden' }, header_line_costs: { photo: 5 } }, { photo: 'profile_photo.jpg' }) === 0);
    check('BP1C photo compensation: gate allows but no photo value -> 0', computeExtra({ fields: { photo: 'expected' }, header_line_costs: { photo: 5 } }, {}) === 0);
  }

  if (failures > 0) { console.error(`\n${failures} HARNESS FAILURE(S)`); process.exit(1); }
  console.log('HARNESS OK: IF: Has Photo? condition logic correct (incl. the deliberate caption-keyword safety gate); photo_file_id picks the largest size variant; buildHeaderFromPersonal photo wrap correctly gated (locale-forbidden, AND-gate on missing value, and the fs.existsSync belt-and-suspenders all verified via real literal source text execution); Build Pass1 Context photo compensation math correct.');

  // ── Writes ──
  patchCompose();
  patchExtractInput(wf);
  patchGraph(wf);
  patchLatexNode('Assemble Resume LaTeX', wf);
  patchLatexNode('Assemble Regen', wf);
  patchLatexNode('Build Revised LaTeX', wf);
  patchBuildPass1ContextPhoto(wf);
  fs.writeFileSync(MASTER_FILE, JSON.stringify(wf, null, 2));

  // Post-write sibling check.
  const wf2 = JSON.parse(fs.readFileSync(MASTER_FILE, 'utf8'));
  const arCode = wf2.nodes.find((n) => n.name === 'Assemble Resume LaTeX').parameters.jsCode;
  const agCode = wf2.nodes.find((n) => n.name === 'Assemble Regen').parameters.jsCode;
  if (arCode !== agCode) { console.error('INTEGRITY FAIL: Assemble Resume LaTeX and Assemble Regen diverged post-patch!'); process.exit(1); }
  console.log('  post-write check: Assemble Resume LaTeX === Assemble Regen (still byte-identical twins)');

  console.log('S144 (photo subsystem) script complete. REMINDER: run `docker compose up -d latex` (container recreate, not just workflow import) for the new mount to take effect.');
})();
