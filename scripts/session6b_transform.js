// Session 6b transform: Revise branch with PDF regeneration
// Run: node scripts/session6b_transform.js

const fs = require('fs');
const path = require('path');

const wfPath = path.join(__dirname, '..', 'workflows', '01_careerforge.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));

// Read big Code node script
const buildRevisedCode = fs.readFileSync(path.join(__dirname, '_build_revised_latex.js'), 'utf-8');

// ─── 1. Remove cf-041 "Stub: Revise" ───
wf.nodes = wf.nodes.filter(n => n.id !== 'cf-041');
delete wf.connections['Stub: Revise'];

// ─── 2. Rewire Route Intent output 3 ───
wf.connections['Route Intent'].main[3] = [
  { node: 'Load Revise Context', type: 'main', index: 0 }
];

// ─── 3. Helper factories ───
function tgNode(id, name, pos, chatIdExpr, text, parseMode, extra) {
  const params = {
    chatId: chatIdExpr,
    text: text,
    additionalFields: parseMode ? { parse_mode: parseMode } : {}
  };
  if (extra) Object.assign(params, extra);
  return {
    parameters: params, id, name,
    type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: pos,
    credentials: { telegramApi: { id: 'TELEGRAM_CREDENTIAL_ID', name: 'CareerForge Bot' } }
  };
}

function tgDocNode(id, name, pos, chatIdExpr, captionExpr, fileNameExpr) {
  return {
    parameters: {
      operation: 'sendDocument',
      chatId: chatIdExpr,
      binaryData: true,
      binaryPropertyName: 'data',
      additionalFields: {
        caption: captionExpr,
        fileName: fileNameExpr,
        parse_mode: 'HTML'
      }
    },
    id, name,
    type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: pos,
    credentials: { telegramApi: { id: 'TELEGRAM_CREDENTIAL_ID', name: 'CareerForge Bot' } }
  };
}

function llmNode(id, name, pos, model, temp, maxTokens) {
  const opts = { baseURL: 'https://openrouter.ai/api/v1', temperature: temp || 0 };
  if (maxTokens) opts.maxTokens = maxTokens;
  return {
    parameters: { model, options: opts }, id, name,
    type: '@n8n/n8n-nodes-langchain.lmChatOpenAi', typeVersion: 1.2, position: pos,
    credentials: { openAiApi: { id: 'OPENROUTER_CREDENTIAL_ID', name: 'OpenRouter API' } }
  };
}

function parserNode(id, name, pos, schema) {
  return {
    parameters: { schemaType: 'manual', inputSchema: JSON.stringify(schema) },
    id, name,
    type: '@n8n/n8n-nodes-langchain.outputParserStructured', typeVersion: 1.2, position: pos
  };
}

function codeNode(id, name, pos, jsCode) {
  return {
    parameters: { jsCode }, id, name,
    type: 'n8n-nodes-base.code', typeVersion: 2, position: pos
  };
}

function ifNode(id, name, pos, conditions) {
  return {
    parameters: { conditions }, id, name,
    type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos
  };
}

// ─── 4. Build all new nodes ───
const newNodes = [

  // cf-120: Load Revise Context
  codeNode('cf-120', 'Load Revise Context', [1320, 2140],
`const staticData = $getWorkflowStaticData('global');
const chatId = $('Extract Input').item.json.chat_id;
const lastApply = staticData.last_apply;
if (!lastApply || (!lastApply.resume_json && !lastApply.cover_json)) {
  return [{ json: { chat_id: chatId, error: 'Nothing to revise. Apply to a job first (reply with a job number after a search).' } }];
}
return [{ json: {
  chat_id: chatId,
  change_request: $('Extract Input').item.json.message_text || '',
  last_apply: lastApply,
  error: ''
}}];`
  ),

  // cf-121: IF: Has Last Apply?
  ifNode('cf-121', 'IF: Has Last Apply?', [1540, 2140], {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: 'revise-check',
        leftValue: '={{ $json.error }}',
        rightValue: '',
        operator: { type: 'string', operation: 'empty' }
      }
    ],
    combinator: 'and'
  }),

  // cf-122: Send No Revise Context
  tgNode('cf-122', 'Send No Revise Context', [1540, 2340],
    '={{ $json.chat_id }}', '={{ "\\u274C " + $json.error }}', 'Markdown'),

  // cf-123: Detect Revise Type
  codeNode('cf-123', 'Detect Revise Type', [1760, 2140],
`const ctx = $input.first().json;
const msg = ctx.change_request.toLowerCase();
const isCover = /cover\\s*letter|\\bcover\\b|\\bcl\\b/.test(msg);
const type = isCover ? 'cover' : 'resume';
const previousJson = type === 'cover' ? ctx.last_apply.cover_json : ctx.last_apply.resume_json;
return [{ json: {
  chat_id: ctx.chat_id,
  change_request: ctx.change_request,
  revise_type: type,
  previous_json: previousJson || {},
  resume_text: ctx.last_apply.resume_text || '',
  job_description: ctx.last_apply.job_description || '',
  job_title: ctx.last_apply.job_title || '',
  company: ctx.last_apply.company || '',
  personal: ctx.last_apply.personal || {},
  resume_skeleton: ctx.last_apply.resume_skeleton || '',
  cover_skeleton: ctx.last_apply.cover_skeleton || '',
  seniority_mode: ctx.last_apply.seniority_mode || 'experienced',
  location: ctx.last_apply.location || ''
}}];`
  ),

  // cf-124: ReviseForge (chainLlm)
  {
    parameters: {
      prompt: `=You are a {{ $json.revise_type === 'cover' ? 'cover letter' : 'resume' }} refinement agent. Return strict JSON only — no markdown fencing, no commentary.

Previous {{ $json.revise_type === 'cover' ? 'cover letter' : 'resume' }} JSON:
{{ JSON.stringify($json.previous_json) }}

User's change request: {{ $json.change_request }}

Master Resume:
{{ $json.resume_text }}

Job Description:
{{ $json.job_description }}

Job Title: {{ $json.job_title }}
Company: {{ $json.company }}

{{ $json.revise_type === 'cover' ? 'Return updated cover letter JSON with fields: title, salutation, hook, bullets (array of {keyword, text}), cta, word_count, changes_summary. Always exactly 3 bullets. Word count 350-450.' : 'Return updated resume JSON with fields: sections (array of {heading, items} matching ResumeForge schema), changes_summary. Max 6 entries (roles + projects). Bullet text max 110 chars.' }}

The changes_summary field must be a concise 1-3 sentence description of what changed.`
    },
    id: 'cf-124', name: 'ReviseForge',
    type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
    position: [1980, 2140]
  },

  // cf-125: OpenRouter LLM (Revise) — Sonnet for writing quality
  llmNode('cf-125', 'OpenRouter LLM (Revise)', [1920, 2340],
    'anthropic/claude-sonnet-4-6', 0.3, 4096),

  // cf-126: Revise Output Parser — permissive schema for both types
  parserNode('cf-126', 'Revise Output Parser', [2060, 2340], {
    type: 'object',
    properties: {
      sections: { type: 'array' },
      title: { type: 'string' },
      salutation: { type: 'string' },
      hook: { type: 'string' },
      bullets: { type: 'array' },
      cta: { type: 'string' },
      word_count: { type: 'integer' },
      changes_summary: { type: 'string' }
    },
    required: ['changes_summary']
  }),

  // cf-127: Build Revised LaTeX — BIG CODE NODE from external file
  codeNode('cf-127', 'Build Revised LaTeX', [2200, 2140], buildRevisedCode),

  // cf-128: Compile Revised PDF
  {
    parameters: {
      method: 'POST',
      url: 'http://latex-service:5679/compile',
      sendBody: true,
      contentType: 'raw',
      rawContentType: 'text/plain',
      body: '={{ $json.latex }}',
      options: {
        timeout: 300000,
        response: { response: { responseFormat: 'file' } }
      }
    },
    id: 'cf-128', name: 'Compile Revised PDF',
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [2420, 2140],
    retryOnFail: true, maxTries: 3, waitBetweenTries: 5000
  },

  // cf-129: Send Revised PDF
  tgDocNode('cf-129', 'Send Revised PDF', [2640, 2140],
    "={{ $('Detect Revise Type').item.json.chat_id }}",
    "={{ '\\u270F\\uFE0F Revised ' + $('Build Revised LaTeX').item.json.revise_type + ' \\u2014 ' + $('Detect Revise Type').item.json.job_title + ' at ' + $('Detect Revise Type').item.json.company }}",
    "={{ $('Detect Revise Type').item.json.company.replace(/\\s+/g, '_') + '_' + $('Detect Revise Type').item.json.job_title.replace(/\\s+/g, '_') + '_revised_' + $('Build Revised LaTeX').item.json.revise_type + '_' + $now.format('yyyyMMdd') + '.pdf' }}"
  ),

  // cf-130: Update Last Apply
  codeNode('cf-130', 'Update Last Apply', [2860, 2140],
`const staticData = $getWorkflowStaticData('global');
const ctx = $('Detect Revise Type').item.json;
const revised = $('ReviseForge').item.json.output || {};
const type = ctx.revise_type;
if (type === 'cover') {
  staticData.last_apply.cover_json = revised;
} else {
  staticData.last_apply.resume_json = revised;
}
staticData.last_apply.timestamp = new Date().toISOString();
const summary = revised.changes_summary || 'Updated.';
return [{ json: {
  chat_id: ctx.chat_id,
  message: "\\u270F\\uFE0F *Updated!* " + summary + "\\n\\nMore tweaks? Just describe what you want changed."
}}];`
  ),

  // cf-131: Send Revise Done
  tgNode('cf-131', 'Send Revise Done', [3080, 2140],
    '={{ $json.chat_id }}', '={{ $json.message }}', 'Markdown'),
];

wf.nodes.push(...newNodes);

// ─── 5. Add connections ───
Object.assign(wf.connections, {
  'Load Revise Context': { main: [[{ node: 'IF: Has Last Apply?', type: 'main', index: 0 }]] },
  'IF: Has Last Apply?': { main: [
    [{ node: 'Detect Revise Type', type: 'main', index: 0 }],           // TRUE (error empty)
    [{ node: 'Send No Revise Context', type: 'main', index: 0 }]        // FALSE
  ]},
  'Detect Revise Type': { main: [[{ node: 'ReviseForge', type: 'main', index: 0 }]] },
  'OpenRouter LLM (Revise)': { ai_languageModel: [[{ node: 'ReviseForge', type: 'ai_languageModel', index: 0 }]] },
  'Revise Output Parser': { ai_outputParser: [[{ node: 'ReviseForge', type: 'ai_outputParser', index: 0 }]] },
  'ReviseForge': { main: [[{ node: 'Build Revised LaTeX', type: 'main', index: 0 }]] },
  'Build Revised LaTeX': { main: [[{ node: 'Compile Revised PDF', type: 'main', index: 0 }]] },
  'Compile Revised PDF': { main: [[{ node: 'Send Revised PDF', type: 'main', index: 0 }]] },
  'Send Revised PDF': { main: [[{ node: 'Update Last Apply', type: 'main', index: 0 }]] },
  'Update Last Apply': { main: [[{ node: 'Send Revise Done', type: 'main', index: 0 }]] },
});

// ─── 6. Write and report ───
fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2));

console.log('Done:');
console.log('  Removed cf-041 (Stub: Revise)');
console.log('  Rewired Route Intent output 3 -> Load Revise Context');
console.log('  Added', newNodes.length, 'new nodes');
console.log('  Total nodes:', wf.nodes.length);
console.log('  Total connections:', Object.keys(wf.connections).length);
