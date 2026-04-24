// Session 6c transform: Outreach + Intel + Draft (shared research infrastructure)
// Run: node scripts/session6c_transform.js

const fs = require('fs');
const path = require('path');

const wfPath = path.join(__dirname, '..', 'workflows', '01_careerforge.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));

// Read big Code node scripts
const webSearchCode = fs.readFileSync(path.join(__dirname, '_web_search.js'), 'utf-8');
const rrfMergeCode = fs.readFileSync(path.join(__dirname, '_rrf_merge.js'), 'utf-8');

// ─── 1. Remove stubs ───
const removeIds = ['cf-043', 'cf-044'];
wf.nodes = wf.nodes.filter(n => !removeIds.includes(n.id));
delete wf.connections['Stub: Intel'];
delete wf.connections['Stub: Outreach'];

// ─── 2. Rewire Route Intent outputs 5 and 6 to shared entry ───
wf.connections['Route Intent'].main[5] = [
  { node: 'Prepare Research', type: 'main', index: 0 }
];
wf.connections['Route Intent'].main[6] = [
  { node: 'Prepare Research', type: 'main', index: 0 }
];

// ─── 3. Helper factories ───
function tgNode(id, name, pos, chatIdExpr, text, parseMode) {
  return {
    parameters: {
      chatId: chatIdExpr, text: text,
      additionalFields: parseMode ? { parse_mode: parseMode } : {}
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

const FREE_MODEL = 'deepseek/deepseek-chat-v3-0324:free';

// ─── 4. Build all new nodes ───
const newNodes = [

  // ═══════════════════════════════════════════
  // Shared Research Infrastructure (5 nodes)
  // ═══════════════════════════════════════════

  // cf-140: Prepare Research
  codeNode('cf-140', 'Prepare Research', [1320, 2500],
`const chatId = $('Extract Input').item.json.chat_id;
const routerOutput = $('Route Intent').item.json.output || {};
const entities = routerOutput.entities || {};
const intent = routerOutput.intent || 'outreach';
const msgText = $('Extract Input').item.json.message_text || '';

// Check for "draft N" sub-intent
const draftMatch = msgText.match(/draft\\s*(\\d+)/i);
if (draftMatch && intent === 'outreach') {
  return [{ json: {
    chat_id: chatId,
    research_type: 'draft',
    draft_number: parseInt(draftMatch[1]),
    company: entities.company || null,
    role: entities.role || null,
    queries: []
  }}];
}

const company = entities.company || 'Unknown';
const role = entities.role || 'Software Engineer';
const location = entities.location || '';
const year = new Date().getFullYear();

let queries = [];
if (intent === 'intel') {
  queries = [
    company + ' latest news ' + year,
    company + ' layoffs ' + (year - 1) + ' ' + year,
    company + ' glassdoor reviews',
    company + ' H1B sponsorship visa',
    company + ' funding round valuation',
    company + ' company culture engineering'
  ];
} else {
  queries = [
    company + ' ' + role + ' recruiter hiring manager LinkedIn',
    company + ' ' + role + ' engineer team lead site:linkedin.com/in',
    company + ' ' + role + (location ? ' ' + location : '') + ' hiring team'
  ];
}

return [{ json: {
  chat_id: chatId,
  research_type: intent,
  company, role, location, queries,
  draft_number: null
}}];`
  ),

  // cf-141: IF: Draft Request?
  ifNode('cf-141', 'IF: Draft Request?', [1540, 2500], {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: 'draft-check',
        leftValue: '={{ $json.research_type }}',
        rightValue: 'draft',
        operator: { type: 'string', operation: 'equals' }
      }
    ],
    combinator: 'and'
  }),

  // cf-142: Web Search — BIG CODE NODE
  codeNode('cf-142', 'Web Search', [1760, 2500], webSearchCode),

  // cf-143: RRF Merge — BIG CODE NODE
  codeNode('cf-143', 'RRF Merge', [1980, 2500], rrfMergeCode),

  // cf-144: IF: Intel or Outreach?
  ifNode('cf-144', 'IF: Intel or Outreach?', [2200, 2500], {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: 'intel-check',
        leftValue: '={{ $json.research_type }}',
        rightValue: 'intel',
        operator: { type: 'string', operation: 'equals' }
      }
    ],
    combinator: 'and'
  }),

  // ═══════════════════════════════════════════
  // Intel Path (5 nodes)
  // ═══════════════════════════════════════════

  // cf-145: CompanyIntel (chainLlm)
  {
    parameters: {
      prompt: `=You are a company health analysis engine. Analyze the search results about {{ $json.company }} and produce a structured health report for a job seeker.

Search Results:
{{ $json.merged_results.map(r => '## ' + r.title + '\\nURL: ' + r.url + '\\n' + r.snippet + (r.content ? '\\n' + r.content.substring(0, 500) : '')).join('\\n\\n---\\n\\n') }}

Use ONLY the information in the search results above. Do not supplement with prior knowledge. If a data point is not found, mark it as unknown or null.

Return strict JSON only — no markdown fencing, no commentary.`
    },
    id: 'cf-145', name: 'CompanyIntel',
    type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
    position: [2420, 2500]
  },

  llmNode('cf-146', 'OpenRouter LLM (Intel)', [2360, 2300], FREE_MODEL, 0),

  parserNode('cf-147', 'Intel Output Parser', [2500, 2300], {
    type: 'object',
    properties: {
      company: { type: 'string' },
      health_score: { type: 'integer' },
      recommendation: { type: 'string', enum: ['Apply', 'Caution', 'Avoid'] },
      summary: { type: 'string' },
      layoffs: { type: 'object', properties: {
        has_recent_layoffs: { type: 'boolean' },
        details: { type: 'string' }
      }},
      sentiment: { type: 'object', properties: {
        glassdoor_rating: {},
        overall_mood: { type: 'string' },
        positives: { type: 'array', items: { type: 'string' } },
        negatives: { type: 'array', items: { type: 'string' } }
      }},
      h1b: { type: 'object', properties: {
        sponsors: { type: 'boolean' },
        recent_approvals: { type: 'string' }
      }},
      funding: { type: 'object', properties: {
        stage: { type: 'string' },
        last_round: { type: 'string' }
      }},
      red_flags: { type: 'array', items: { type: 'string' } },
      green_flags: { type: 'array', items: { type: 'string' } }
    },
    required: ['company', 'health_score', 'recommendation', 'summary', 'red_flags', 'green_flags']
  }),

  // cf-148: Format Intel Report
  codeNode('cf-148', 'Format Intel Report', [2640, 2500],
`const r = $input.first().json.output || {};
const ctx = $('RRF Merge').item.json;
const recIcon = r.recommendation === 'Apply' ? '\\u2705' : r.recommendation === 'Caution' ? '\\u26A0\\uFE0F' : '\\u{1F6D1}';
const sections = [
  recIcon + ' *' + (r.company || ctx.company) + ' \\u2014 Health Score: ' + (r.health_score || '?') + '/100*',
  '_' + (r.summary || 'No summary available.') + '_',
  '',
  '\\u{1F4CA} *Sentiment:* ' + (r.sentiment && r.sentiment.overall_mood || 'Unknown') +
    (r.sentiment && r.sentiment.glassdoor_rating ? ' (Glassdoor: ' + r.sentiment.glassdoor_rating + ')' : ''),
];
if (r.sentiment && r.sentiment.positives && r.sentiment.positives.length) {
  sections.push(r.sentiment.positives.map(p => '  \\u2705 ' + p).join('\\n'));
}
if (r.sentiment && r.sentiment.negatives && r.sentiment.negatives.length) {
  sections.push(r.sentiment.negatives.map(p => '  \\u274C ' + p).join('\\n'));
}
sections.push('');
sections.push('\\u{1F534} *Layoffs:* ' + (r.layoffs && r.layoffs.has_recent_layoffs ? 'Yes \\u2014 ' + r.layoffs.details : 'None recent'));
sections.push('\\u{1F4B0} *Funding:* ' + (r.funding && r.funding.stage || 'Unknown') + (r.funding && r.funding.last_round ? ' (' + r.funding.last_round + ')' : ''));
sections.push('\\u{1F6C2} *H1B:* ' + (r.h1b && r.h1b.sponsors ? 'Yes' + (r.h1b.recent_approvals ? ' (' + r.h1b.recent_approvals + ')' : '') : 'Unknown'));
sections.push('');
if (r.green_flags && r.green_flags.length) {
  sections.push('\\u{1F7E2} *Green Flags:*\\n' + r.green_flags.map(f => '\\u2022 ' + f).join('\\n'));
}
if (r.red_flags && r.red_flags.length) {
  sections.push('\\u{1F534} *Red Flags:*\\n' + r.red_flags.map(f => '\\u2022 ' + f).join('\\n'));
}
return [{ json: { chat_id: ctx.chat_id, message: sections.filter(Boolean).join('\\n') } }];`
  ),

  tgNode('cf-149', 'Send Intel', [2860, 2500],
    '={{ $json.chat_id }}', '={{ $json.message }}', 'Markdown'),

  // ═══════════════════════════════════════════
  // Outreach Path (5 nodes)
  // ═══════════════════════════════════════════

  // cf-150: ContactFinder (chainLlm)
  {
    parameters: {
      prompt: `=You are a contact extraction engine. Extract named contacts from search results for cold outreach to {{ $json.company }}.

Target role: {{ $json.role }}

Search Results:
{{ $json.merged_results.map(r => '## ' + r.title + '\\nURL: ' + r.url + '\\n' + r.snippet + (r.content ? '\\n' + r.content.substring(0, 500) : '')).join('\\n\\n---\\n\\n') }}

Rules:
- Only include contacts whose full names appear in the search results
- Never fabricate or construct LinkedIn URLs
- Max 5 contacts
- Priority: Recruiters/Hiring Managers = High, IC engineers = Medium, Directors/VPs = Low

Return strict JSON only — no markdown fencing, no commentary.`
    },
    id: 'cf-150', name: 'ContactFinder',
    type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
    position: [2420, 2740]
  },

  llmNode('cf-151', 'OpenRouter LLM (ContactFinder)', [2360, 2940], FREE_MODEL, 0),

  parserNode('cf-152', 'ContactFinder Output Parser', [2500, 2940], {
    type: 'object',
    properties: {
      contacts: { type: 'array', items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          type: { type: 'string' },
          linkedin_url: {},
          location: {},
          priority: { type: 'string' },
          confidence: { type: 'string' },
          reason: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } }
        },
        required: ['name', 'role', 'priority', 'confidence', 'reason']
      }},
      search_tips: { type: 'array', items: { type: 'string' } }
    },
    required: ['contacts']
  }),

  // cf-153: Format Contacts (also stores to staticData)
  codeNode('cf-153', 'Format Contacts', [2640, 2740],
`const result = $input.first().json.output || {};
const ctx = $('RRF Merge').item.json;
const staticData = $getWorkflowStaticData('global');
const contacts = result.contacts || [];

// Store contacts for later "draft N" retrieval
staticData.last_contacts = {
  contacts: contacts,
  company: ctx.company,
  role: ctx.role,
  timestamp: new Date().toISOString()
};

if (contacts.length === 0) {
  const tips = (result.search_tips || []).map(t => '\\u2022 ' + t).join('\\n');
  return [{ json: { chat_id: ctx.chat_id, message: '\\u{1F4E7} *No contacts found for ' + ctx.company + '.*\\n\\n' + (tips ? '*Search Tips:*\\n' + tips : 'Try a more specific role or check the company name.') } }];
}

const lines = contacts.map((c, i) => {
  const priIcon = c.priority === 'High' ? '\\u{1F525}' : c.priority === 'Medium' ? '\\u2B50' : '\\u{1F4CC}';
  const linkedIn = c.linkedin_url ? ' [LinkedIn](' + c.linkedin_url + ')' : '';
  return (i + 1) + '. ' + priIcon + ' *' + c.name + '* \\u2014 ' + c.role +
    '\\n   ' + c.type + ' | ' + (c.location || '?') + ' | Confidence: ' + c.confidence +
    linkedIn +
    '\\n   _' + c.reason + '_';
});

const msg = '\\u{1F4E7} *Contacts at ' + ctx.company + ':*\\n\\n' + lines.join('\\n\\n') +
  '\\n\\n\\u{1F4A1} Reply "draft 1" to generate outreach templates for contact #1.';
return [{ json: { chat_id: ctx.chat_id, message: msg } }];`
  ),

  tgNode('cf-154', 'Send Contacts', [2860, 2740],
    '={{ $json.chat_id }}', '={{ $json.message }}', 'Markdown'),

  // ═══════════════════════════════════════════
  // Draft Path (8 nodes)
  // ═══════════════════════════════════════════

  // cf-155: Load Draft Contact
  codeNode('cf-155', 'Load Draft Contact', [1760, 2980],
`const staticData = $getWorkflowStaticData('global');
const chatId = $('Extract Input').item.json.chat_id;
const ctx = $('Prepare Research').item.json;
const draftNum = ctx.draft_number;
const lastContacts = staticData.last_contacts;

if (!lastContacts || !lastContacts.contacts || lastContacts.contacts.length === 0) {
  return [{ json: { chat_id: chatId, error: 'No contacts to draft for. Run /outreach first to find contacts.' } }];
}

const idx = draftNum - 1;
if (idx < 0 || idx >= lastContacts.contacts.length) {
  return [{ json: { chat_id: chatId, error: 'Contact #' + draftNum + ' not found. You have ' + lastContacts.contacts.length + ' contacts. Try "draft 1" through "draft ' + lastContacts.contacts.length + '".' } }];
}

const contact = lastContacts.contacts[idx];
const resumeData = staticData.last_apply || {};
return [{ json: {
  chat_id: chatId,
  contact: contact,
  company: lastContacts.company,
  role: lastContacts.role,
  candidate_name: (resumeData.personal && resumeData.personal.name) || 'Candidate',
  candidate_location: (resumeData.personal && resumeData.personal.location) || '',
  relevant_achievement: resumeData.resume_text ? resumeData.resume_text.substring(0, 500) : '',
  error: ''
}}];`
  ),

  // cf-156: IF: Contact Found?
  ifNode('cf-156', 'IF: Contact Found?', [1980, 2980], {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: 'contact-check',
        leftValue: '={{ $json.error }}',
        rightValue: '',
        operator: { type: 'string', operation: 'empty' }
      }
    ],
    combinator: 'and'
  }),

  // cf-157: Send No Contact
  tgNode('cf-157', 'Send No Contact', [1980, 3180],
    '={{ $json.chat_id }}', '={{ "\\u274C " + $json.error }}', 'Markdown'),

  // cf-158: OutreachWriter (chainLlm) — Sonnet for writing quality
  {
    parameters: {
      prompt: `=You are a cold outreach drafting engine. Generate 4 outreach variants for this contact. Return strict JSON only — no markdown fencing.

Contact: {{ $json.contact.name }} — {{ $json.contact.role }} at {{ $json.company }}
Contact Location: {{ $json.contact.location || 'Unknown' }}
Contact Type: {{ $json.contact.type }}

Candidate: {{ $json.candidate_name }}
Candidate Location: {{ $json.candidate_location || 'Unknown' }}
Target Role: {{ $json.role }}

Relevant Background:
{{ $json.relevant_achievement }}

Rules:
- LinkedIn message: max 300 characters. Personal hook + value prop + soft ask.
- Email: 100-150 words. Hook + fit + 1 metric bullet + CTA + sign-off.
- Same city → "grab coffee"; different city same country → "30-min video call"; different country → "video call, flexible on time zones".
- Subject line: direct, specific, under 60 chars.
- Follow-up: reference original, offer graceful exit, 2-3 sentences.
- No flattery. Lead with specific reference, not compliments.
- Engineer-to-engineer tone. Direct. No corporate-speak.`
    },
    id: 'cf-158', name: 'OutreachWriter',
    type: '@n8n/n8n-nodes-langchain.chainLlm', typeVersion: 1.4,
    position: [2200, 2980]
  },

  llmNode('cf-159', 'OpenRouter LLM (Writer)', [2140, 3180],
    'anthropic/claude-sonnet-4-6', 0.3, 2048),

  parserNode('cf-160', 'Outreach Output Parser', [2280, 3180], {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      linkedin_message: { type: 'string' },
      email_body: { type: 'string' },
      followup_message: { type: 'string' }
    },
    required: ['subject', 'linkedin_message', 'email_body', 'followup_message']
  }),

  // cf-161: Format Outreach
  codeNode('cf-161', 'Format Outreach', [2420, 2980],
`const o = $input.first().json.output || {};
const ctx = $('Load Draft Contact').item.json;
const contact = ctx.contact || {};
const msg = '\\u{1F4E7} *Outreach for ' + contact.name + ' (' + contact.role + '):*\\n\\n' +
  '\\u{1F4CC} *Subject:* ' + (o.subject || '') + '\\n\\n' +
  '\\u{1F517} *LinkedIn Message* (< 300 chars):\\n\`\`\`\\n' + (o.linkedin_message || '') + '\\n\`\`\`\\n\\n' +
  '\\u{1F4E9} *Email:*\\n\`\`\`\\n' + (o.email_body || '') + '\\n\`\`\`\\n\\n' +
  '\\u{1F504} *Follow-up (5-7 days later):*\\n\`\`\`\\n' + (o.followup_message || '') + '\\n\`\`\`\\n\\n' +
  '_Copy any section above and personalize before sending._';
return [{ json: { chat_id: ctx.chat_id, message: msg } }];`
  ),

  tgNode('cf-162', 'Send Outreach', [2640, 2980],
    '={{ $json.chat_id }}', '={{ $json.message }}', 'Markdown'),
];

wf.nodes.push(...newNodes);

// ─── 5. Add all connections ───
Object.assign(wf.connections, {
  // Shared Research
  'Prepare Research': { main: [[{ node: 'IF: Draft Request?', type: 'main', index: 0 }]] },
  'IF: Draft Request?': { main: [
    [{ node: 'Load Draft Contact', type: 'main', index: 0 }],  // TRUE (is draft)
    [{ node: 'Web Search', type: 'main', index: 0 }]           // FALSE (normal search)
  ]},
  'Web Search': { main: [[{ node: 'RRF Merge', type: 'main', index: 0 }]] },
  'RRF Merge': { main: [[{ node: 'IF: Intel or Outreach?', type: 'main', index: 0 }]] },
  'IF: Intel or Outreach?': { main: [
    [{ node: 'CompanyIntel', type: 'main', index: 0 }],    // TRUE (intel)
    [{ node: 'ContactFinder', type: 'main', index: 0 }]    // FALSE (outreach)
  ]},

  // Intel path
  'OpenRouter LLM (Intel)': { ai_languageModel: [[{ node: 'CompanyIntel', type: 'ai_languageModel', index: 0 }]] },
  'Intel Output Parser': { ai_outputParser: [[{ node: 'CompanyIntel', type: 'ai_outputParser', index: 0 }]] },
  'CompanyIntel': { main: [[{ node: 'Format Intel Report', type: 'main', index: 0 }]] },
  'Format Intel Report': { main: [[{ node: 'Send Intel', type: 'main', index: 0 }]] },

  // Outreach path
  'OpenRouter LLM (ContactFinder)': { ai_languageModel: [[{ node: 'ContactFinder', type: 'ai_languageModel', index: 0 }]] },
  'ContactFinder Output Parser': { ai_outputParser: [[{ node: 'ContactFinder', type: 'ai_outputParser', index: 0 }]] },
  'ContactFinder': { main: [[{ node: 'Format Contacts', type: 'main', index: 0 }]] },
  'Format Contacts': { main: [[{ node: 'Send Contacts', type: 'main', index: 0 }]] },

  // Draft path
  'Load Draft Contact': { main: [[{ node: 'IF: Contact Found?', type: 'main', index: 0 }]] },
  'IF: Contact Found?': { main: [
    [{ node: 'OutreachWriter', type: 'main', index: 0 }],      // TRUE (contact found)
    [{ node: 'Send No Contact', type: 'main', index: 0 }]       // FALSE
  ]},
  'OpenRouter LLM (Writer)': { ai_languageModel: [[{ node: 'OutreachWriter', type: 'ai_languageModel', index: 0 }]] },
  'Outreach Output Parser': { ai_outputParser: [[{ node: 'OutreachWriter', type: 'ai_outputParser', index: 0 }]] },
  'OutreachWriter': { main: [[{ node: 'Format Outreach', type: 'main', index: 0 }]] },
  'Format Outreach': { main: [[{ node: 'Send Outreach', type: 'main', index: 0 }]] },
});

// ─── 6. Write and report ───
fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2));

console.log('Done:');
console.log('  Removed stubs:', removeIds.join(', '));
console.log('  Rewired Route Intent outputs 5, 6 -> Prepare Research');
console.log('  Added', newNodes.length, 'new nodes');
console.log('  Total nodes:', wf.nodes.length);
console.log('  Total connections:', Object.keys(wf.connections).length);
