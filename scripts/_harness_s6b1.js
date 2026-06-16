// Harness for S6b-1 Assemble Resume LaTeX node. Loads the node source, runs it
// against mocked $input/$ for 4 scenarios, then compiles the valid ones against
// the live latex-service (localhost:5679). Run: node scripts/_harness_s6b1.js
const fs = require('fs');
const path = require('path');
const http = require('http');

const CODE = fs.readFileSync(path.join(__dirname, 'nodes', 'assemble_resume_latex.js'), 'utf8');

function runNode(input, ctx) {
  const $input = { first: () => ({ json: input }) };
  const $ = (name) => ({ first: () => ({ json: name === 'Prepare Apply Context' ? ctx : {} }) });
  const fn = new Function('$input', '$', CODE);
  return fn($input, $);
}

const personal = {
  name: 'Pranav Kowadkar', phone_display: '+1-201-555-0123', email: 'pk.kowadkar@gmail.com',
  linkedin: 'https://linkedin.com/in/pranavkowadkar', github: 'https://github.com/pranav',
  portfolio: '', location: 'Jersey City, NJ', show_location: true,
};
const ctx = { personal, chat_id: 12345, job_title: 'AI Engineer', company: 'Anthropic' };

// 1) experienced: pass2 supplies experience+skills; projects+education fall back
const pass1Exp = {
  tier: 'mid', sectionOrder: ['experience', 'projects', 'skills', 'education'],
  companies: [{ company: 'Dassault Systèmes', positions: [{
    title: 'R&D Software Engineer', startDate: 'Jan 2019', endDate: 'Aug 2022', location: 'Pune, India',
    isSelected: true, keyAchievements: ['Built CATIA PLM module in C++ serving 10k+ users', 'Reduced geometry-kernel latency 30% via caching', 'Led migration to microservices across 50 services'],
  }] }],
  selectedProjects: [{ name: 'CareerForge', techStack: 'n8n, Postgres, LLMs', date: '2025', descriptionPoints: ['Built a multi-agent job pipeline (WF01-WF07)', 'Shipped /100 research-augmented scoring'] }],
  skillsCategories: [{ category: 'Languages', skills: ['Python', 'C++', 'SQL'] }, { category: 'AI', skills: ['LangChain', 'RAG', 'pgvector'] }],
  education: [{ degree: 'M.S.', major: 'Data Science', institution: 'NJIT', graduationDate: 'May 2024', gpa: '' }],
};
const pass2Exp = {
  experience_entries: '\\resumeSubheading{R&D Software Engineer}{Jan 2019 -- Aug 2022}{Dassault Systèmes}{Pune, India}\n\\resumeItemListStart\n  \\resumeItem{\\textbf{Scale:} Built CATIA PLM module in C++ serving 10k+ users}\n  \\resumeItem{\\textbf{Performance:} Reduced geometry-kernel latency 30\\% via caching}\n\\resumeItemListEnd',
  skills_content: '\\textbf{Languages:} Python, C++, SQL \\\\\n\\textbf{AI:} LangChain, RAG, pgvector \\\\',
  resumePlainText: 'R&D Software Engineer at Dassault...',
};

// 2) fresher: pass2 EMPTY -> everything falls back from pass1 verbatim
const pass1Fresh = {
  tier: 'fresher', sectionOrder: ['education', 'skills', 'projects', 'internships', 'achievements'],
  selectedInternships: [{ title: 'ML Intern', company: 'StartupX', startDate: 'Jun 2023', endDate: 'Dec 2023', location: 'Remote', keyAchievements: ['Trained a churn model at 88% AUC', 'Built an ETL pipeline in Python'] }],
  selectedProjects: [{ name: 'Brain fMRI Classifier', techStack: 'PyTorch, stDNN', date: '2024', descriptionPoints: ['Hit 94% accuracy on GM+WM cohorts'] }],
  skillsCategories: [{ category: 'ML', skills: ['PyTorch', 'scikit-learn'] }],
  education: [{ degree: 'M.S.', major: 'Data Science', institution: 'NJIT', graduationDate: 'May 2024', gpa: '3.9' }],
  selectedAchievements: [{ title: '1st place, Pulse NYC Hackathon', description: '1st place, Pulse NYC Hackathon' }],
};
const pass2Fresh = {};

// 3) senior: summary + experience
const pass1Senior = {
  tier: 'senior', sectionOrder: ['summary', 'experience', 'skills', 'education'],
  summary: 'Staff-level AI engineer with 12 years across PLM and multi-agent systems.',
  companies: [{ company: 'BigCo', positions: [{ title: 'Principal Engineer', startDate: 'Jan 2015', endDate: 'Present', location: 'NYC', isSelected: true, keyAchievements: ['Architected platform serving 1M+ users', 'Drove org-wide migration'] }] }],
  skillsCategories: [{ category: 'Leadership', skills: ['Architecture', 'Mentorship'] }],
  education: [{ degree: 'B.E.', major: 'CS', institution: 'Pune University', graduationDate: '2012', gpa: '' }],
};
const pass2Senior = { summary_content: 'Staff-level AI engineer with 12 years across PLM and multi-agent systems.' };

// 4) empty -> must throw
const scenarios = [
  { name: 'experienced (pass2+fallback)', input: { pass1: pass1Exp, pass2: pass2Exp }, expectThrow: false },
  { name: 'fresher (fallback-only)', input: { pass1: pass1Fresh, pass2: pass2Fresh }, expectThrow: false },
  { name: 'senior', input: { pass1: pass1Senior, pass2: pass2Senior }, expectThrow: false },
  { name: 'empty (must throw)', input: { pass1: {}, pass2: {} }, expectThrow: true },
];

function compile(latex) {
  return new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: 5679, path: '/compile', method: 'POST', headers: { 'Content-Type': 'text/plain' }, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, len: Buffer.concat(chunks).length, isPdf: (chunks[0] && Buffer.concat(chunks).slice(0, 5).toString() === '%PDF-') }));
    });
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
    req.write(latex);
    req.end();
  });
}

(async () => {
  const outDir = path.join(__dirname, '_tmp_s6b1');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  for (const s of scenarios) {
    let res, threw = false, err = '';
    try { res = runNode(s.input, ctx); } catch (e) { threw = true; err = e.message; }
    if (s.expectThrow) {
      console.log(`\n[${s.name}] ${threw ? 'THREW (correct): ' + err.slice(0, 70) : 'DID NOT THROW (BUG!)'}`);
      continue;
    }
    if (threw) { console.log(`\n[${s.name}] UNEXPECTED THROW: ${err}`); continue; }
    const latex = res[0].json.latex;
    const checks = {
      hasDoc: latex.includes('\\begin{document}') && latex.includes('\\end{document}'),
      hasName: latex.includes('Pranav Kowadkar'),
      hasEmail: latex.includes('pk.kowadkar@gmail.com') && !latex.includes('{{EMAIL}}'),
      pipeOk: latex.includes('$|$') && !latex.includes('\\$|\\$'),
      noPlaceholders: !latex.includes('{{') && !latex.includes('%%% SLOT') && !latex.includes('%%% CONTENT'),
      plainText: (res[0].json.resumePlainText || '').length > 0,
    };
    fs.writeFileSync(path.join(outDir, s.name.split(' ')[0] + '.tex'), latex);
    const cmp = await compile(latex);
    console.log(`\n[${s.name}] checks=${JSON.stringify(checks)}\n  compile: status=${cmp.status} ${cmp.isPdf ? 'PDF ' + cmp.len + ' bytes' : (cmp.err || 'NON-PDF ' + cmp.len + 'b')}`);
  }
  console.log('\n(.tex written to scripts/_tmp_s6b1/)');
})();
