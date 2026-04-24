// Session 6a transform: Track + Status + Score + Salary branches
// Run: node scripts/session6a_transform.js

const fs = require('fs');
const path = require('path');

const wfPath = path.join(__dirname, '..', 'workflows', '01_careerforge.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));

// ─── 1. Remove 4 stubs ───
const removeIds = ['cf-042', 'cf-045', 'cf-046', 'cf-047'];
wf.nodes = wf.nodes.filter(n => !removeIds.includes(n.id));
// Also remove their connections
delete wf.connections['Stub: Score'];
delete wf.connections['Stub: Salary'];
delete wf.connections['Stub: Track'];
delete wf.connections['Stub: Status'];

// ─── 2. Patch cf-083 (Store Apply Context) — add more fields to last_apply ───
const storeNode = wf.nodes.find(n => n.id === 'cf-083');
if (storeNode) {
  storeNode.parameters.jsCode = `const staticData = $getWorkflowStaticData('global');
const ctx = $('Prepare Apply Context').first().json;
staticData.last_apply = {
  job_id: ctx.job_number,
  job_title: ctx.job_title,
  company: ctx.company,
  seniority_mode: ctx.seniority_mode,
  resume_json: $('ResumeForge').first().json.output || null,
  cover_json: $('CoverForge').first().json.output || null,
  forge_score: ctx.forge_score || null,
  skeleton_mode: ctx.seniority_mode,
  resume_text: ctx.resume_text || '',
  personal: ctx.personal || {},
  resume_skeleton: ctx.resume_skeleton || '',
  cover_skeleton: ctx.cover_skeleton || '',
  job_description: ctx.job_description || '',
  location: ctx.location || '',
  timestamp: new Date().toISOString()
};
return [{ json: {
  chat_id: ctx.chat_id,
  message: "\\u2705 *Done!* Resume and cover letter delivered.\\n\\nReply with changes ('shorter', 'more Python', 'swap bullet 2') or 'track' to save this application."
}}];`;
}

// ─── 3. Move Send Fallback down to make room ───
const fallbackNode = wf.nodes.find(n => n.id === 'cf-048');
if (fallbackNode) fallbackNode.position = [1320, 3400];

// ─── 4. Helper factories (same as Session 5) ───
function tgNode(id, name, pos, chatIdExpr, text, parseMode) {
  return {
    parameters: {
      chatId: chatIdExpr,
      text: text,
      additionalFields: parseMode ? { parse_mode: parseMode } : {}
    },
    id, name,
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: pos,
    credentials: { telegramApi: { id: 'TELEGRAM_CREDENTIAL_ID', name: 'CareerForge Bot' } }
  };
}

function llmNode(id, name, pos, model, temp, maxTokens) {
  const opts = { baseURL: 'https://openrouter.ai/api/v1', temperature: temp || 0 };
  if (maxTokens) opts.maxTokens = maxTokens;
  return {
    parameters: { model, options: opts },
    id, name,
    type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
    typeVersion: 1.2,
    position: pos,
    credentials: { openAiApi: { id: 'OPENROUTER_CREDENTIAL_ID', name: 'OpenRouter API' } }
  };
}

function parserNode(id, name, pos, schema) {
  return {
    parameters: { schemaType: 'manual', inputSchema: JSON.stringify(schema) },
    id, name,
    type: '@n8n/n8n-nodes-langchain.outputParserStructured',
    typeVersion: 1.2,
    position: pos
  };
}

function codeNode(id, name, pos, jsCode) {
  return {
    parameters: { jsCode },
    id, name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos
  };
}

function ifNode(id, name, pos, conditions) {
  return {
    parameters: { conditions },
    id, name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: pos
  };
}

const chatId = "={{ $('Extract Input').item.json.chat_id }}";
const FREE_MODEL = 'deepseek/deepseek-chat-v3-0324:free';

// ─── 5. Build all new nodes ───
const newNodes = [

  // ═══ Track (2 nodes) ═══
  codeNode('cf-100', 'Track Application', [1320, 1100],
`const staticData = $getWorkflowStaticData('global');
const chatId = $('Extract Input').item.json.chat_id;
const lastApply = staticData.last_apply;
if (!lastApply) {
  return [{ json: { chat_id: chatId, message: "\\u274C Nothing to track. Apply to a job first." } }];
}
if (!staticData.tracked_applications) staticData.tracked_applications = [];
const entry = {
  job_id: lastApply.job_id,
  job_title: lastApply.job_title,
  company: lastApply.company,
  status: 'applied',
  score: lastApply.forge_score ? lastApply.forge_score.overall_score : null,
  applied_at: new Date().toISOString()
};
// Avoid duplicates
const exists = staticData.tracked_applications.some(a => a.job_id === entry.job_id);
if (exists) {
  return [{ json: { chat_id: chatId, message: "\\u2139\\uFE0F Already tracking *" + entry.job_title + "* at *" + entry.company + "*." } }];
}
staticData.tracked_applications.push(entry);
return [{ json: { chat_id: chatId, message: "\\u2705 Tracking *" + entry.job_title + "* at *" + entry.company + "*.\\n\\nUse /status to see all tracked applications." } }];`
  ),

  tgNode('cf-101', 'Send Track Ack', [1540, 1100],
    '={{ $json.chat_id }}', '={{ $json.message }}', 'Markdown'),

  // ═══ Status (2 nodes) ═══
  codeNode('cf-102', 'List Applications', [1320, 1260],
`const staticData = $getWorkflowStaticData('global');
const chatId = $('Extract Input').item.json.chat_id;
const apps = staticData.tracked_applications || [];
if (apps.length === 0) {
  return [{ json: { chat_id: chatId, message: "\\u{1F4CB} No tracked applications yet. Apply to a job and then reply 'track' to start tracking." } }];
}
const lines = apps.map((a, i) => {
  const statusIcon = a.status === 'applied' ? '\\u{1F7E1}' : a.status === 'interviewing' ? '\\u{1F7E2}' : '\\u26AA';
  const score = a.score ? ' (Score: ' + a.score + ')' : '';
  const date = a.applied_at ? new Date(a.applied_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  return (i + 1) + '. ' + statusIcon + ' *' + a.job_title + '* at *' + a.company + '*' + score + (date ? ' \\u2014 ' + date : '');
});
return [{ json: { chat_id: chatId, message: "\\u{1F4CB} *Tracked Applications:*\\n\\n" + lines.join('\\n') } }];`
  ),

  tgNode('cf-103', 'Send Status', [1540, 1260],
    '={{ $json.chat_id }}', '={{ $json.message }}', 'Markdown'),

  // ═══ Score (8 nodes) ═══
  codeNode('cf-104', 'Load Score Context', [1320, 1420],
`const staticData = $getWorkflowStaticData('global');
const chatId = $('Extract Input').item.json.chat_id;
const lastApply = staticData.last_apply;
if (!lastApply || !lastApply.resume_text || !lastApply.job_description) {
  return [{ json: { chat_id: chatId, error: 'No resume/job context. Apply to a job first, then use /score.', resume_text: '', job_description: '', job_title: '', company: '' } }];
}
return [{ json: {
  chat_id: chatId,
  error: '',
  resume_text: lastApply.resume_text,
  job_description: lastApply.job_description,
  job_title: lastApply.job_title,
  company: lastApply.company
}}];`
  ),

  ifNode('cf-105', 'IF: Has Score Data?', [1540, 1420], {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: 'score-check',
        leftValue: '={{ $json.error }}',
        rightValue: '',
        operator: { type: 'string', operation: 'empty' }
      }
    ],
    combinator: 'and'
  }),

  tgNode('cf-106', 'Send No Score Context', [1540, 1620],
    '={{ $json.chat_id }}', '={{ "\\u274C " + $json.error }}', 'Markdown'),

  {
    parameters: {
      prompt: "=Score this candidate's resume against the job description. Return strict JSON only \u2014 no markdown fencing, no commentary.\n\nMaster Resume:\n{{ $json.resume_text }}\n\nJob Description:\n{{ $json.job_description }}\n\nJob Title: {{ $json.job_title }}\nCompany: {{ $json.company }}"
    },
    id: 'cf-107', name: 'ScoreOnly',
    type: '@n8n/n8n-nodes-langchain.chainLlm',
    typeVersion: 1.4,
    position: [1760, 1420]
  },

  llmNode('cf-108', 'OpenRouter LLM (ScoreOnly)', [1700, 1620], FREE_MODEL, 0),

  parserNode('cf-109', 'ScoreOnly Output Parser', [1840, 1620], {
    type: 'object',
    properties: {
      overall_score: { type: 'number' },
      dimensions: { type: 'object', properties: {
        skills_match: { type: 'integer' }, experience_relevance: { type: 'integer' },
        metric_impact: { type: 'integer' }, seniority_fit: { type: 'integer' },
        keyword_coverage: { type: 'integer' }, leadership_signals: { type: 'integer' }
      }},
      gaps: { type: 'array', items: { type: 'string' } },
      strengths: { type: 'array', items: { type: 'string' } },
      recommendation: { type: 'string', enum: ['Apply', 'Caution', 'Skip'] }
    },
    required: ['overall_score', 'dimensions', 'gaps', 'strengths', 'recommendation']
  }),

  codeNode('cf-110', 'Format Score Message', [1980, 1420],
`const s = $input.first().json.output || {};
const ctx = $('Load Score Context').item.json;
const d = s.dimensions || {};
const recIcon = s.recommendation === 'Apply' ? '\\u2705' : s.recommendation === 'Caution' ? '\\u26A0\\uFE0F' : '\\u26D4';
const bar = (score) => {
  const filled = Math.round((score || 0));
  return '\\u2588'.repeat(filled) + '\\u2591'.repeat(10 - filled) + ' ' + (score || 0) + '/10';
};
const msg = recIcon + ' *ForgeScore: ' + (s.overall_score || '?') + '/10* \\u2014 ' + (s.recommendation || 'Unknown') + '\\n' +
  '_' + ctx.job_title + ' at ' + ctx.company + '_\\n\\n' +
  '*Dimensions:*\\n' +
  'Skills Match:        ' + bar(d.skills_match) + '\\n' +
  'Experience:          ' + bar(d.experience_relevance) + '\\n' +
  'Impact/Metrics:      ' + bar(d.metric_impact) + '\\n' +
  'Seniority Fit:       ' + bar(d.seniority_fit) + '\\n' +
  'Keyword Coverage:    ' + bar(d.keyword_coverage) + '\\n' +
  'Leadership:          ' + bar(d.leadership_signals) + '\\n\\n' +
  (s.strengths && s.strengths.length ? '*Strengths:*\\n' + s.strengths.map(g => '\\u2705 ' + g).join('\\n') + '\\n\\n' : '') +
  (s.gaps && s.gaps.length ? '*Gaps:*\\n' + s.gaps.map(g => '\\u26A0\\uFE0F ' + g).join('\\n') : '');
return [{ json: { chat_id: ctx.chat_id, message: msg } }];`
  ),

  tgNode('cf-111', 'Send Score', [2200, 1420],
    '={{ $json.chat_id }}', '={{ $json.message }}', 'Markdown'),

  // ═══ Salary (7 nodes) ═══
  codeNode('cf-112', 'Extract Salary Params', [1320, 1780],
`const chatId = $('Extract Input').item.json.chat_id;
const entities = $('Route Intent').item.json.output ? ($('Route Intent').item.json.output.entities || {}) : {};
const staticData = $getWorkflowStaticData('global');
const lastApply = staticData.last_apply || {};
const role = entities.role || lastApply.job_title || 'Software Engineer';
const company = entities.company || lastApply.company || '';
return [{ json: { chat_id: chatId, role, company, query: 'salary ' + role + (company ? ' at ' + company : '') + ' compensation total comp ' + new Date().getFullYear() } }];`
  ),

  codeNode('cf-113', 'Search Salary Data', [1540, 1780],
`const https = require('https');
const ctx = $input.first().json;
const query = ctx.query;
const serperKey = $env.SERPER_API_KEY || '';

function httpPost(url, headers, body) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const opts = { hostname: u.hostname, path: u.pathname, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } };
      const req = https.request(opts, res => {
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      });
      req.on('error', () => resolve({}));
      req.setTimeout(15000, () => { req.destroy(); resolve({}); });
      req.write(JSON.stringify(body));
      req.end();
    } catch { resolve({}); }
  });
}

let searchText = 'No salary data found. Provide general estimates for the role.';

if (serperKey) {
  const resp = await httpPost('https://google.serper.dev/search', { 'X-API-KEY': serperKey }, { q: query, num: 10 });
  const results = (resp.organic || []).slice(0, 8);
  if (results.length > 0) {
    searchText = results.map(r => r.title + ': ' + (r.snippet || '')).join('\\n\\n');
  }
} else {
  // Try You.com
  const youKey = $env.YOUCOM_API_KEY || '';
  if (youKey) {
    const youUrl = 'https://api.ydc-index.io/search?query=' + encodeURIComponent(query);
    const resp = await new Promise((resolve) => {
      const u = new URL(youUrl);
      const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'X-API-Key': youKey } };
      const req = https.request(opts, res => {
        let data = ''; res.on('data', c => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
      });
      req.on('error', () => resolve({}));
      req.setTimeout(15000, () => { req.destroy(); resolve({}); });
      req.end();
    });
    const hits = (resp.hits || []).slice(0, 8);
    if (hits.length > 0) {
      searchText = hits.map(h => h.title + ': ' + (h.description || h.snippets?.[0] || '')).join('\\n\\n');
    }
  }
}

return [{ json: { ...ctx, search_results: searchText } }];`
  ),

  {
    parameters: {
      prompt: "=Summarize the salary information for the role of {{ $json.role }}{{ $json.company ? ' at ' + $json.company : '' }}. Return strict JSON only.\n\nSearch Results:\n{{ $json.search_results }}\n\nProvide realistic salary ranges based on the search data. If data is limited, note that."
    },
    id: 'cf-114', name: 'SalarySummarize',
    type: '@n8n/n8n-nodes-langchain.chainLlm',
    typeVersion: 1.4,
    position: [1760, 1780]
  },

  llmNode('cf-115', 'OpenRouter LLM (Salary)', [1700, 1980], FREE_MODEL, 0),

  parserNode('cf-116', 'Salary Output Parser', [1840, 1980], {
    type: 'object',
    properties: {
      salary_range: { type: 'string' },
      total_comp: { type: 'string' },
      negotiation_tips: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      sources_note: { type: 'string' }
    },
    required: ['salary_range', 'total_comp', 'negotiation_tips', 'confidence', 'sources_note']
  }),

  codeNode('cf-117', 'Format Salary', [1980, 1780],
`const s = $input.first().json.output || {};
const ctx = $('Extract Salary Params').item.json;
const tips = (s.negotiation_tips || []).map(t => '\\u2022 ' + t).join('\\n');
const confIcon = s.confidence === 'high' ? '\\u{1F7E2}' : s.confidence === 'medium' ? '\\u{1F7E1}' : '\\u{1F534}';
const msg = '\\u{1F4B0} *Salary Intel: ' + ctx.role + (ctx.company ? ' at ' + ctx.company : '') + '*\\n\\n' +
  '\\u{1F4B5} *Base Range:* ' + (s.salary_range || 'Unknown') + '\\n' +
  '\\u{1F4CA} *Total Comp:* ' + (s.total_comp || 'Unknown') + '\\n\\n' +
  '*Negotiation Tips:*\\n' + (tips || '\\u2022 Research market rates before negotiating') + '\\n\\n' +
  confIcon + ' _Confidence: ' + (s.confidence || 'low') + ' | ' + (s.sources_note || 'General estimates') + '_';
return [{ json: { chat_id: ctx.chat_id, message: msg } }];`
  ),

  tgNode('cf-118', 'Send Salary', [2200, 1780],
    '={{ $json.chat_id }}', '={{ $json.message }}', 'Markdown'),
];

wf.nodes.push(...newNodes);

// ─── 6. Rewire Route Intent outputs ───
wf.connections['Route Intent'].main[4] = [{ node: 'Load Score Context', type: 'main', index: 0 }];
wf.connections['Route Intent'].main[7] = [{ node: 'Extract Salary Params', type: 'main', index: 0 }];
wf.connections['Route Intent'].main[8] = [{ node: 'Track Application', type: 'main', index: 0 }];
wf.connections['Route Intent'].main[9] = [{ node: 'List Applications', type: 'main', index: 0 }];

// ─── 7. Add all new connections ───
Object.assign(wf.connections, {
  // Track
  'Track Application': { main: [[{ node: 'Send Track Ack', type: 'main', index: 0 }]] },

  // Status
  'List Applications': { main: [[{ node: 'Send Status', type: 'main', index: 0 }]] },

  // Score
  'Load Score Context': { main: [[{ node: 'IF: Has Score Data?', type: 'main', index: 0 }]] },
  'IF: Has Score Data?': { main: [
    [{ node: 'ScoreOnly', type: 'main', index: 0 }],      // TRUE (error is empty)
    [{ node: 'Send No Score Context', type: 'main', index: 0 }]  // FALSE
  ]},
  'OpenRouter LLM (ScoreOnly)': { ai_languageModel: [[{ node: 'ScoreOnly', type: 'ai_languageModel', index: 0 }]] },
  'ScoreOnly Output Parser': { ai_outputParser: [[{ node: 'ScoreOnly', type: 'ai_outputParser', index: 0 }]] },
  'ScoreOnly': { main: [[{ node: 'Format Score Message', type: 'main', index: 0 }]] },
  'Format Score Message': { main: [[{ node: 'Send Score', type: 'main', index: 0 }]] },

  // Salary
  'Extract Salary Params': { main: [[{ node: 'Search Salary Data', type: 'main', index: 0 }]] },
  'Search Salary Data': { main: [[{ node: 'SalarySummarize', type: 'main', index: 0 }]] },
  'OpenRouter LLM (Salary)': { ai_languageModel: [[{ node: 'SalarySummarize', type: 'ai_languageModel', index: 0 }]] },
  'Salary Output Parser': { ai_outputParser: [[{ node: 'SalarySummarize', type: 'ai_outputParser', index: 0 }]] },
  'SalarySummarize': { main: [[{ node: 'Format Salary', type: 'main', index: 0 }]] },
  'Format Salary': { main: [[{ node: 'Send Salary', type: 'main', index: 0 }]] },
});

// ─── 8. Write and report ───
fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2));

console.log('Done:');
console.log('  Removed stubs:', removeIds.join(', '));
console.log('  Patched cf-083 (Store Apply Context)');
console.log('  Moved cf-048 (Send Fallback) to Y=3400');
console.log('  Rewired Route Intent outputs 4, 7, 8, 9');
console.log('  Added', newNodes.length, 'new nodes');
console.log('  Total nodes:', wf.nodes.length);
console.log('  Total connections:', Object.keys(wf.connections).length);
