// Harness for S6b-2: simulates the full resume chain with pinned LLM outputs.
// Build Pass1 Context -> [Pass1 LLM] -> Parse Pass1 -> [Step0 LLM] -> Parse Step0
//   -> Build Pass2 Input -> [Pass2 LLM] -> Parse Pass2 -> Assemble Resume LaTeX -> compile.
// The Pass2 raw deliberately has UNESCAPED real newlines inside JSON strings (the
// classic LLM mistake) to prove parseJSON repairs it. Run: node scripts/_harness_s6b2.js
const fs = require('fs');
const path = require('path');
const http = require('http');

const ND = path.join(__dirname, 'nodes');
const read = (f) => fs.readFileSync(path.join(ND, f), 'utf8');
const PARSE = read('_parseJSON_snippet.js');
const BUILD_P1 = read('build_pass1_context.js');
const BUILD_P2 = read('build_pass2_input.js');
const ASSEMBLE = read('assemble_resume_latex.js');

const parsePass1 = PARSE + '\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);return [{json:{pass1:parseJSON(raw)}}];';
const parseStep0 = PARSE + '\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);return [{json:{step0:parseJSON(raw)}}];';
const parsePass2 = PARSE + "\nconst t=$input.first().json||{};const raw=(t.text!=null)?t.text:((t.output!=null)?t.output:t);const pass1=($('Build Pass2 Input').first().json||{}).pass1||{};return [{json:{pass1:pass1,pass2:parseJSON(raw)}}];";

// node registry so $('Name') resolves to prior outputs
const reg = {};
function run(code, inputJson) {
  const $input = { first: () => ({ json: inputJson }) };
  const $ = (name) => ({ first: () => ({ json: reg[name] || {} }) });
  const out = new Function('$input', '$', code)($input, $);
  return out[0].json;
}

const personal = { name: 'Pranav Kowadkar', phone_display: '+1-201-555-0123', email: 'pk.kowadkar@gmail.com', linkedin: 'https://linkedin.com/in/pranav', github: 'https://github.com/pranav', portfolio: '', location: 'Jersey City, NJ', show_location: true };
reg['Prepare Apply Context'] = {
  personal, chat_id: 42, job_title: 'AI Engineer', company: 'Anthropic',
  seniority_mode: 'experienced', candidate_yoe: 5,
  resume_text: 'Pranav Kowadkar\nR&D Software Engineer at Dassault Systemes (Jan 2019 - Aug 2022): Built CATIA PLM module in C++ serving 10k+ users; reduced kernel latency 30%.\nM.S. Data Science, NJIT, 2024.\nSkills: Python, C++, SQL, LangChain.',
  job_description: 'We seek an AI Engineer with strong Python, LLM orchestration, and production ML experience. Bonus: C++, RAG.',
  keyword_gaps: ['LLM orchestration', 'RAG'], gaps: ['No explicit production ML deployment'],
};

// 1) Build Pass1 Context
reg['Build Pass1 Context'] = run(BUILD_P1, {});
console.log('[Build Pass1 Context] pass1_user has resume+jd+tier:',
  reg['Build Pass1 Context'].pass1_user.includes('Master Resume') &&
  reg['Build Pass1 Context'].pass1_user.includes('Detected tier: mid') &&
  reg['Build Pass1 Context'].pass1_user.includes('LLM orchestration'),
  '| step0_user:', reg['Build Pass1 Context'].step0_user.startsWith('Job Description:'));

// 2) Pass1 LLM (pinned) -> Parse Pass1
const pass1Obj = {
  tier: 'mid', sectionOrder: ['experience', 'skills', 'education'],
  companies: [{ company: 'Dassault Systemes', positions: [{ title: 'R&D Software Engineer', startDate: 'Jan 2019', endDate: 'Aug 2022', location: 'Pune, India', isSelected: true, keyAchievements: ['Built CATIA PLM module in C++ serving 10k+ users', 'Reduced kernel latency 30% via caching'] }] }],
  skillsCategories: [{ category: 'Languages', skills: ['Python', 'C++', 'SQL'] }, { category: 'AI', skills: ['LangChain', 'RAG'] }],
  education: [{ degree: 'M.S.', major: 'Data Science', institution: 'NJIT', graduationDate: 'May 2024', gpa: '' }],
  atsKeywords: { matched: ['Python', 'C++'], missing: ['RAG'] },
};
reg['Parse Pass1'] = run(parsePass1, { text: '```json\n' + JSON.stringify(pass1Obj) + '\n```' });
console.log('[Parse Pass1] tier:', reg['Parse Pass1'].pass1.tier, '| sections:', (reg['Parse Pass1'].pass1.sectionOrder || []).join(','));

// 3) Step0 LLM (pinned) -> Parse Step0
const step0Obj = { clusters: [{ name: 'Python', priority: 'must_have', keywords: ['python'] }, { name: 'LLM orchestration', priority: 'must_have', keywords: ['llm', 'rag'] }], dealbreakers: [], targetTier: 'mid', keyTerms: ['Python', 'LLM', 'RAG'] };
reg['Parse Step0'] = run(parseStep0, { text: JSON.stringify(step0Obj) });
console.log('[Parse Step0] clusters:', (reg['Parse Step0'].step0.clusters || []).length);

// 4) Build Pass2 Input
reg['Build Pass2 Input'] = run(BUILD_P2, {});
console.log('[Build Pass2 Input] has decisions+jdRequirements:',
  reg['Build Pass2 Input'].pass2_user.includes('"decisions"') && reg['Build Pass2 Input'].pass2_user.includes('"jdRequirements"'),
  '| carries pass1:', !!reg['Build Pass2 Input'].pass1.tier);

// 5) Pass2 LLM (pinned) -> TORTURE: real unescaped newlines inside JSON string values
const pass2Obj = {
  experience_entries: '\\resumeSubheading{R\\&D Software Engineer}{Jan 2019 -- Aug 2022}{Dassault Systemes}{Pune, India}\n\\resumeItemListStart\n  \\resumeItem{\\textbf{Scale:} Built CATIA PLM module in C++ serving 10k+ users}\n  \\resumeItem{\\textbf{Performance:} Reduced kernel latency 30\\% via caching}\n\\resumeItemListEnd',
  skills_content: '\\textbf{Languages:} Python, C++, SQL \\\\\n\\textbf{AI:} LangChain, RAG \\\\',
  education_entries: '\\resumeSubheading{M.S. -- Data Science}{May 2024}{NJIT}{}',
  resumePlainText: 'R&D Software Engineer at Dassault. Built CATIA module. M.S. NJIT.',
};
// simulate the LLM emitting literal newlines (breaks strict JSON.parse):
const pass2Raw = JSON.stringify(pass2Obj).split('\\n').join('\n');
console.log('[Pass2 raw] strict JSON.parse fails as expected:', (() => { try { JSON.parse(pass2Raw); return false; } catch (e) { return true; } })());
reg['Parse Pass2'] = run(parsePass2, { text: pass2Raw });
console.log('[Parse Pass2] recovered pass2 keys:', Object.keys(reg['Parse Pass2'].pass2).join(','), '| carries pass1:', !!reg['Parse Pass2'].pass1.tier);

// 6) Assemble
const asm = run(ASSEMBLE, { pass1: reg['Parse Pass2'].pass1, pass2: reg['Parse Pass2'].pass2 });
const latex = asm.latex;
console.log('[Assemble] checks:', JSON.stringify({
  hasDoc: latex.includes('\\begin{document}') && latex.includes('\\end{document}'),
  hasName: latex.includes('Pranav Kowadkar'),
  hasExp: latex.includes('CATIA PLM module'),
  pipeOk: latex.includes('$|$') && !latex.includes('\\$|\\$'),
  noPlaceholders: !latex.includes('%%% SLOT') && !latex.includes('%%% CONTENT'),
}));

// 7) compile
function compile(tex) {
  return new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: 5679, path: '/compile', method: 'POST', headers: { 'Content-Type': 'text/plain' }, timeout: 60000 }, (res) => {
      const ch = []; res.on('data', (c) => ch.push(c)); res.on('end', () => { const b = Buffer.concat(ch); resolve({ status: res.statusCode, len: b.length, isPdf: b.slice(0, 5).toString() === '%PDF-' }); });
    });
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
    req.write(tex); req.end();
  });
}
compile(latex).then((r) => console.log('[compile]', r.isPdf ? 'PDF ' + r.len + ' bytes (status ' + r.status + ')' : 'FAIL status=' + r.status + ' ' + (r.err || '')));
