// Session 5 transform: Add apply pipeline to workflow
// Run: node scripts/session5_transform.js

const fs = require('fs');
const path = require('path');

const wfPath = path.join(__dirname, '..', 'workflows', '01_careerforge.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));

// Read big Code node scripts (these will be JSON-stringified into jsCode fields)
const buildResumeCode = fs.readFileSync(path.join(__dirname, '_build_resume_latex.js'), 'utf-8');
const buildCoverCode = fs.readFileSync(path.join(__dirname, '_build_cover_latex.js'), 'utf-8');

// ─── 1. Remove cf-040 "Stub: Apply" ───
wf.nodes = wf.nodes.filter(n => n.id !== 'cf-040');

// ─── 2. Rewire Route Intent output 2 ───
wf.connections['Route Intent'].main[2] = [
  { node: 'Send Apply Ack', type: 'main', index: 0 }
];

// ─── 3. Helper factories ───
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

const chatId = "={{ $('Extract Input').item.json.chat_id }}";

// ─── 4. Build all new nodes ───
const newNodes = [
  // Phase 1: Ack + Job Retrieval
  tgNode('cf-050', 'Send Apply Ack', [1320, 580], chatId,
    '\u2699\uFE0F *Generating your tailored resume + cover letter...* (~45 sec)', 'Markdown'),

  codeNode('cf-051', 'Retrieve Job', [1540, 580],
`const staticData = $getWorkflowStaticData('global');
const chatId = $('Extract Input').item.json.chat_id;
const entities = $('Route Intent').item.json.output?.entities || $('Route Intent').item.json.output || {};
const jobNumber = entities.job_number;
if (!jobNumber) {
  return [{ json: { chat_id: chatId, error: 'No job number provided. Reply with a number (1-5) after a job search.' } }];
}
const lastJobs = staticData.last_jobs || {};
const job = lastJobs[jobNumber];
if (!job) {
  return [{ json: { chat_id: chatId, error: 'Job #' + jobNumber + ' not found. Run a job search first (/find jobs).' } }];
}
const parts = job.job_id.split('-');
const greenhouseId = parts.pop();
const companySlug = parts.join('-');
return [{ json: { chat_id: chatId, job_number: jobNumber, job, company_slug: companySlug, greenhouse_id: greenhouseId, error: null } }];`),

  {
    parameters: {
      conditions: {
        options: { version: 2 },
        conditions: [{
          leftValue: '={{ $json.error }}',
          rightValue: '',
          operator: { type: 'string', operation: 'empty' }
        }]
      }
    },
    id: 'cf-052', name: 'IF: Job Found?',
    type: 'n8n-nodes-base.if', typeVersion: 2.2,
    position: [1760, 580]
  },

  tgNode('cf-053', 'Send Job Not Found', [1760, 780], '={{ $json.chat_id }}',
    '={{ "\u274C " + $json.error }}', null),

  {
    parameters: {
      url: '=https://boards-api.greenhouse.io/v1/boards/{{ $json.company_slug }}/jobs/{{ $json.greenhouse_id }}',
      options: { timeout: 15000 },
      sendQuery: true,
      queryParameters: { parameters: [{ name: 'content', value: 'true' }] },
      retry: { maxRetries: 3, retryInterval: 5000 }
    },
    id: 'cf-054', name: 'Fetch Full JD',
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [1980, 580],
    onError: 'continueRegularOutput'
  },

  codeNode('cf-055', 'Prepare Job Context', [2200, 580],
`const retrieveData = $('Retrieve Job').item.json;
const ghResponse = $input.first().json;
let jobDescription = retrieveData.job.description_snippet || '';
if (ghResponse && ghResponse.content) {
  jobDescription = ghResponse.content
    .replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\\s+/g, ' ').trim().substring(0, 8000);
}
const job = retrieveData.job;
return [{ json: {
  chat_id: retrieveData.chat_id, job_number: retrieveData.job_number,
  job_title: job.title || 'Unknown Role', company: job.company || 'unknown',
  company_slug: retrieveData.company_slug, location: job.location || 'Unknown',
  job_url: job.url || '', job_description: jobDescription,
  fit_score_from_digest: job.fit_score || null
}}];`),

  // Phase 2: Resume + Seniority + Skeletons
  {
    parameters: { filePath: '/data/user-data/master_resume.txt' },
    id: 'cf-056', name: 'Read Master Resume (Apply)',
    type: 'n8n-nodes-base.readWriteFile', typeVersion: 1,
    position: [2420, 580]
  },

  codeNode('cf-057', 'Parse Personal Info', [2640, 580],
`const jobCtx = $('Prepare Job Context').item.json;
const binaryData = $input.first().binary;
let resumeText = '';
if (binaryData && binaryData.data) {
  resumeText = Buffer.from(binaryData.data.data, 'base64').toString('utf-8');
} else if ($input.first().json.data) {
  resumeText = $input.first().json.data;
} else {
  return [{ json: { ...jobCtx, resume_text: '', personal: {}, error: 'Master resume not found. Place master_resume.txt in /data/user-data/ first.' }}];
}
const personal = {};
const fieldPattern = /^(name|email|phone|linkedin|github|portfolio|location|work_authorization):\\s*(.+)/gim;
let match;
while ((match = fieldPattern.exec(resumeText)) !== null) {
  personal[match[1].toLowerCase()] = match[2].trim();
}
return [{ json: { ...jobCtx, resume_text: resumeText, personal } }];`),

  // SeniorityDetector chain
  {
    parameters: {
      prompt: "=Classify this candidate's seniority level based on their master resume. Return strict JSON only — no markdown fencing, no commentary.\n\nMaster Resume:\n{{ $json.resume_text }}"
    },
    id: 'cf-058', name: 'SeniorityDetector',
    type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
    position: [2860, 580]
  },

  llmNode('cf-059', 'OpenRouter LLM (Seniority)', [2800, 800], 'deepseek/deepseek-chat-v3-0324:free', 0),

  parserNode('cf-060', 'Seniority Output Parser', [2940, 800], {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['fresher', 'experienced', 'senior'] },
      total_years_experience: { type: 'integer' },
      reasoning: { type: 'string' }
    },
    required: ['mode', 'total_years_experience', 'reasoning']
  }),

  codeNode('cf-061', 'Load Skeletons', [3080, 580],
`const fs = require('fs');
const ctx = $('Parse Personal Info').item.json;
const seniorityOutput = $input.first().json.output || { mode: 'experienced' };
const mode = seniorityOutput.mode || 'experienced';
const skeletonMap = {
  fresher: '/data/templates/resume_skeleton_fresher.tex',
  experienced: '/data/templates/resume_skeleton_experienced.tex',
  senior: '/data/templates/resume_skeleton_senior.tex'
};
let resumeSkeleton = '', coverSkeleton = '';
try { resumeSkeleton = fs.readFileSync(skeletonMap[mode] || skeletonMap.experienced, 'utf-8'); }
catch (e) { try { resumeSkeleton = fs.readFileSync(skeletonMap.experienced, 'utf-8'); } catch (e2) {} }
try { coverSkeleton = fs.readFileSync('/data/templates/cover_skeleton.tex', 'utf-8'); } catch (e) {}
return [{ json: { ...ctx, seniority_mode: mode, total_years_experience: seniorityOutput.total_years_experience || 0, resume_skeleton: resumeSkeleton, cover_skeleton: coverSkeleton }}];`),

  // ForgeScore chain
  {
    parameters: {
      prompt: "=Score this candidate's resume against the job description. Return strict JSON only — no markdown fencing, no commentary.\n\nMaster Resume:\n{{ $json.resume_text }}\n\nJob Description:\n{{ $json.job_description }}\n\nJob Title: {{ $json.job_title }}\nCompany: {{ $json.company }}"
    },
    id: 'cf-062', name: 'ForgeScore',
    type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
    position: [3300, 580]
  },

  llmNode('cf-063', 'OpenRouter LLM (ForgeScore)', [3240, 800], 'deepseek/deepseek-chat-v3-0324:free', 0),

  parserNode('cf-064', 'ForgeScore Output Parser', [3380, 800], {
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

  codeNode('cf-065', 'Prepare Apply Context', [3520, 580],
`const ctx = $('Load Skeletons').item.json;
const scoreOutput = $input.first().json.output || { overall_score: 5.0, recommendation: 'Caution', gaps: ['Unable to score'], strengths: [] };
return [{ json: {
  ...ctx,
  forge_score: scoreOutput,
  overall_score: scoreOutput.overall_score || 5.0,
  recommendation: scoreOutput.recommendation || 'Caution',
  gaps: scoreOutput.gaps || [],
  strengths: scoreOutput.strengths || []
}}];`),

  // Score Gate
  {
    parameters: {
      conditions: {
        options: { version: 2 },
        conditions: [{
          leftValue: '={{ $json.overall_score }}',
          rightValue: '4',
          operator: { type: 'number', operation: 'gte' }
        }]
      }
    },
    id: 'cf-066', name: 'Score Gate',
    type: 'n8n-nodes-base.if', typeVersion: 2.2,
    position: [3740, 580]
  },

  tgNode('cf-067', 'Send Skip', [3740, 800], '={{ $json.chat_id }}',
    '={{ "\u26D4 *Low fit score: " + $json.overall_score + "/10* \\u2014 Skipping generation.\\n\\n*Gaps:*\\n" + $json.gaps.map(function(g) { return "\\u2022 " + g; }).join("\\n") + "\\n\\n_Try a different job that matches your background better._" }}',
    'Markdown'),

  // Caution check
  {
    parameters: {
      conditions: {
        options: { version: 2 },
        conditions: [{
          leftValue: '={{ $json.overall_score }}',
          rightValue: '6',
          operator: { type: 'number', operation: 'lt' }
        }]
      }
    },
    id: 'cf-068', name: 'Caution Check',
    type: 'n8n-nodes-base.if', typeVersion: 2.2,
    position: [3960, 580]
  },

  tgNode('cf-069', 'Send Caution', [3960, 380], '={{ $json.chat_id }}',
    '={{ "\\u26A0\\uFE0F *Moderate fit: " + $json.overall_score + "/10*\\n\\n*Gaps:*\\n" + $json.gaps.map(function(g) { return "\\u2022 " + g; }).join("\\n") + "\\n\\nGenerating anyway \\u2014 review carefully before sending." }}',
    'Markdown'),

  // ──── Resume Branch ────
  {
    parameters: {
      prompt: "=Generate a tailored resume as structured JSON for this job. Return strict JSON only — no markdown fencing.\n\nMaster Resume:\n{{ $json.resume_text }}\n\nJob Description:\n{{ $json.job_description }}\n\nJob Title: {{ $json.job_title }}\nCompany: {{ $json.company }}\nSeniority Mode: {{ $json.seniority_mode }}"
    },
    id: 'cf-070', name: 'ResumeForge',
    type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
    position: [4300, 380]
  },

  llmNode('cf-071', 'OpenRouter LLM (Resume)', [4240, 160], 'anthropic/claude-sonnet-4-6', 0.3, 4096),

  parserNode('cf-072', 'Resume Output Parser', [4380, 160], {
    type: 'object',
    properties: {
      sections: { type: 'array', items: {
        type: 'object',
        properties: { heading: { type: 'string' }, items: { type: 'array' } },
        required: ['heading', 'items']
      }}
    },
    required: ['sections']
  }),

  // cf-073: Build Resume LaTeX (loaded from file)
  codeNode('cf-073', 'Build Resume LaTeX', [4520, 380], buildResumeCode),

  // Compile + Send Resume
  {
    parameters: {
      method: 'POST',
      url: 'http://latex-service:5679/compile',
      sendBody: true, contentType: 'raw', rawContentType: 'text/plain',
      body: '={{ $json.latex }}',
      options: { timeout: 300000, response: { response: { responseFormat: 'file' } } },
      retry: { maxRetries: 3, retryInterval: 5000 }
    },
    id: 'cf-074', name: 'Compile Resume PDF',
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [4740, 380],
    onError: 'continueRegularOutput'
  },

  {
    parameters: {
      operation: 'sendDocument',
      chatId: "={{ $('Prepare Apply Context').item.json.chat_id }}",
      binaryData: true, binaryPropertyName: 'data',
      additionalFields: {
        caption: "={{ '\\u2705 Resume \\u2014 ' + $('Prepare Apply Context').item.json.job_title + ' at ' + $('Prepare Apply Context').item.json.company + ' (ForgeScore: ' + $('Prepare Apply Context').item.json.overall_score + '/10)' }}",
        fileName: "={{ $('Prepare Apply Context').item.json.company.replace(/\\s+/g, '_') + '_' + $('Prepare Apply Context').item.json.job_title.replace(/\\s+/g, '_') + '_resume_' + $now.format('yyyyMMdd') + '.pdf' }}",
        parse_mode: 'HTML'
      }
    },
    id: 'cf-075', name: 'Send Resume PDF',
    type: 'n8n-nodes-base.telegram', typeVersion: 1.2,
    position: [4960, 380],
    credentials: { telegramApi: { id: 'TELEGRAM_CREDENTIAL_ID', name: 'CareerForge Bot' } }
  },

  // ──── Cover Branch ────
  {
    parameters: {
      prompt: "=Generate a tailored cover letter as structured JSON. Return strict JSON only — no markdown fencing.\n\nMaster Resume:\n{{ $json.resume_text }}\n\nJob Description:\n{{ $json.job_description }}\n\nJob Title: {{ $json.job_title }}\nCompany: {{ $json.company }}\nCandidate Location: {{ $json.personal.location || 'Unknown' }}\nCompany Location: {{ $json.location || 'Unknown' }}"
    },
    id: 'cf-076', name: 'CoverForge',
    type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
    position: [4300, 780]
  },

  llmNode('cf-077', 'OpenRouter LLM (Cover)', [4240, 1000], 'anthropic/claude-sonnet-4-6', 0.3, 2048),

  parserNode('cf-078', 'Cover Output Parser', [4380, 1000], {
    type: 'object',
    properties: {
      title: { type: 'string' }, salutation: { type: 'string' }, hook: { type: 'string' },
      bullets: { type: 'array', items: { type: 'object', properties: {
        keyword: { type: 'string' }, text: { type: 'string' }
      }, required: ['keyword', 'text'] }},
      cta: { type: 'string' }, word_count: { type: 'integer' }
    },
    required: ['title', 'salutation', 'hook', 'bullets', 'cta']
  }),

  // cf-079: Build Cover LaTeX (loaded from file)
  codeNode('cf-079', 'Build Cover LaTeX', [4520, 780], buildCoverCode),

  // Compile + Send Cover
  {
    parameters: {
      method: 'POST',
      url: 'http://latex-service:5679/compile',
      sendBody: true, contentType: 'raw', rawContentType: 'text/plain',
      body: '={{ $json.latex }}',
      options: { timeout: 300000, response: { response: { responseFormat: 'file' } } },
      retry: { maxRetries: 3, retryInterval: 5000 }
    },
    id: 'cf-080', name: 'Compile Cover PDF',
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
    position: [4740, 780],
    onError: 'continueRegularOutput'
  },

  {
    parameters: {
      operation: 'sendDocument',
      chatId: "={{ $('Prepare Apply Context').item.json.chat_id }}",
      binaryData: true, binaryPropertyName: 'data',
      additionalFields: {
        caption: "={{ '\\u2705 Cover Letter \\u2014 ' + $('Prepare Apply Context').item.json.job_title + ' at ' + $('Prepare Apply Context').item.json.company }}",
        fileName: "={{ $('Prepare Apply Context').item.json.company.replace(/\\s+/g, '_') + '_' + $('Prepare Apply Context').item.json.job_title.replace(/\\s+/g, '_') + '_cover_' + $now.format('yyyyMMdd') + '.pdf' }}",
        parse_mode: 'HTML'
      }
    },
    id: 'cf-081', name: 'Send Cover PDF',
    type: 'n8n-nodes-base.telegram', typeVersion: 1.2,
    position: [4960, 780],
    credentials: { telegramApi: { id: 'TELEGRAM_CREDENTIAL_ID', name: 'CareerForge Bot' } }
  },

  // ──── Phase 5: Merge + Finalize ────
  {
    parameters: { mode: 'append' },
    id: 'cf-082', name: 'Merge PDFs',
    type: 'n8n-nodes-base.merge', typeVersion: 3,
    position: [5180, 580]
  },

  codeNode('cf-083', 'Store Apply Context', [5400, 580],
`const staticData = $getWorkflowStaticData('global');
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
  timestamp: new Date().toISOString()
};
return [{ json: {
  chat_id: ctx.chat_id,
  message: "\\u2705 *Done!* Resume and cover letter delivered.\\n\\nReply with changes ('shorter', 'more Python', 'swap bullet 2') or 'track' to save this application."
}}];`),

  tgNode('cf-084', 'Send Done', [5620, 580], '={{ $json.chat_id }}',
    '={{ $json.message }}', 'Markdown')
];

// ─── 5. Add all new nodes ───
wf.nodes.push(...newNodes);

// ─── 6. Add all new connections ───
Object.assign(wf.connections, {
  'Send Apply Ack': { main: [[{ node: 'Retrieve Job', type: 'main', index: 0 }]] },
  'Retrieve Job': { main: [[{ node: 'IF: Job Found?', type: 'main', index: 0 }]] },
  'IF: Job Found?': { main: [
    [{ node: 'Fetch Full JD', type: 'main', index: 0 }],
    [{ node: 'Send Job Not Found', type: 'main', index: 0 }]
  ]},
  'Fetch Full JD': { main: [[{ node: 'Prepare Job Context', type: 'main', index: 0 }]] },
  'Prepare Job Context': { main: [[{ node: 'Read Master Resume (Apply)', type: 'main', index: 0 }]] },
  'Read Master Resume (Apply)': { main: [[{ node: 'Parse Personal Info', type: 'main', index: 0 }]] },
  'Parse Personal Info': { main: [[{ node: 'SeniorityDetector', type: 'main', index: 0 }]] },
  'OpenRouter LLM (Seniority)': { ai_languageModel: [[{ node: 'SeniorityDetector', type: 'ai_languageModel', index: 0 }]] },
  'Seniority Output Parser': { ai_outputParser: [[{ node: 'SeniorityDetector', type: 'ai_outputParser', index: 0 }]] },
  'SeniorityDetector': { main: [[{ node: 'Load Skeletons', type: 'main', index: 0 }]] },
  'Load Skeletons': { main: [[{ node: 'ForgeScore', type: 'main', index: 0 }]] },
  'OpenRouter LLM (ForgeScore)': { ai_languageModel: [[{ node: 'ForgeScore', type: 'ai_languageModel', index: 0 }]] },
  'ForgeScore Output Parser': { ai_outputParser: [[{ node: 'ForgeScore', type: 'ai_outputParser', index: 0 }]] },
  'ForgeScore': { main: [[{ node: 'Prepare Apply Context', type: 'main', index: 0 }]] },
  'Prepare Apply Context': { main: [[{ node: 'Score Gate', type: 'main', index: 0 }]] },
  'Score Gate': { main: [
    [{ node: 'Caution Check', type: 'main', index: 0 }],
    [{ node: 'Send Skip', type: 'main', index: 0 }]
  ]},
  'Caution Check': { main: [
    [{ node: 'Send Caution', type: 'main', index: 0 }],
    [
      { node: 'ResumeForge', type: 'main', index: 0 },
      { node: 'CoverForge', type: 'main', index: 0 }
    ]
  ]},
  'Send Caution': { main: [[
    { node: 'ResumeForge', type: 'main', index: 0 },
    { node: 'CoverForge', type: 'main', index: 0 }
  ]]},
  'OpenRouter LLM (Resume)': { ai_languageModel: [[{ node: 'ResumeForge', type: 'ai_languageModel', index: 0 }]] },
  'Resume Output Parser': { ai_outputParser: [[{ node: 'ResumeForge', type: 'ai_outputParser', index: 0 }]] },
  'ResumeForge': { main: [[{ node: 'Build Resume LaTeX', type: 'main', index: 0 }]] },
  'Build Resume LaTeX': { main: [[{ node: 'Compile Resume PDF', type: 'main', index: 0 }]] },
  'Compile Resume PDF': { main: [[{ node: 'Send Resume PDF', type: 'main', index: 0 }]] },
  'Send Resume PDF': { main: [[{ node: 'Merge PDFs', type: 'main', index: 0 }]] },
  'OpenRouter LLM (Cover)': { ai_languageModel: [[{ node: 'CoverForge', type: 'ai_languageModel', index: 0 }]] },
  'Cover Output Parser': { ai_outputParser: [[{ node: 'CoverForge', type: 'ai_outputParser', index: 0 }]] },
  'CoverForge': { main: [[{ node: 'Build Cover LaTeX', type: 'main', index: 0 }]] },
  'Build Cover LaTeX': { main: [[{ node: 'Compile Cover PDF', type: 'main', index: 0 }]] },
  'Compile Cover PDF': { main: [[{ node: 'Send Cover PDF', type: 'main', index: 0 }]] },
  'Send Cover PDF': { main: [[{ node: 'Merge PDFs', type: 'main', index: 1 }]] },
  'Merge PDFs': { main: [[{ node: 'Store Apply Context', type: 'main', index: 0 }]] },
  'Store Apply Context': { main: [[{ node: 'Send Done', type: 'main', index: 0 }]] }
});

// ─── 7. Write ───
fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2), 'utf-8');

console.log('Done:');
console.log('  Removed cf-040 (Stub: Apply)');
console.log('  Rewired Route Intent output 2 -> Send Apply Ack');
console.log('  Added', newNodes.length, 'new nodes');
console.log('  Total nodes:', wf.nodes.length);
console.log('  Total connections:', Object.keys(wf.connections).length);
