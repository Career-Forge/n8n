/* Harness for the S10 deterministic assembler. Runs assemble_resume_latex.js
 * against fixtures, asserts the bug classes are gone, and writes .tex files for
 * compile-testing against the latex service. Run: node scripts/_harness_s10.js */
const fs = require('fs');
const path = require('path');

const CODE = fs.readFileSync(path.join(__dirname, 'nodes', 'assemble_resume_latex.js'), 'utf8');
const fn = new Function('$input', '$', CODE);

const PERSONAL = {
  name: 'Pranav Shridhar Kowadkar', phone_display: '+1 973-704-7623',
  email: 'pk.kowadkar@gmail.com', linkedin: 'https://linkedin.com/in/pranav',
  github: 'https://github.com/pranav', portfolio: 'https://pranav.dev', show_location: false,
};
const mk$ = () => (name) => {
  if (name === 'Prepare Apply Context') return { first: () => ({ json: { personal: PERSONAL, chat_id: 1, job_title: 'AI Engineer', company: 'Sarvam' } }) };
  throw new Error('Unexpected $("' + name + '")');
};
const run = (pass1, pass2) => fn({ first: () => ({ json: { pass1, pass2 } }) }, mk$())[0].json;

const results = {};
let failures = 0;
function check(label, cond, extra) { if (!cond) { failures++; console.log('  FAIL: ' + label + (extra ? ' :: ' + extra : '')); } else { console.log('  ok:   ' + label); } }

// ── Fixture 1: MID (Pranav-like) with refined Pass-2 bullets keyed by id, **bold, torture chars ──
const p1_mid = {
  tier: 'mid', sectionOrder: ['experience', 'projects', 'skills', 'education'],
  summary: '',
  companies: [
    { company: 'New Jersey Institute of Technology', renderAsStacked: false, positions: [
      { id: 'e1', title: 'AI Engineer', startDate: 'Mar 2025', endDate: 'Present', location: 'Newark, NJ', isSelected: true,
        keyAchievements: ['Built fMRI transformer achieving 94% accuracy', 'Applied transfer learning reducing training time by ~40% compared to scratch'] } ] },
    { company: 'Dassault Systemes', renderAsStacked: false, positions: [
      { id: 'e2', title: 'R&D Software Engineer', startDate: 'Apr 2020', endDate: 'Jul 2022', location: 'Remote', isSelected: true,
        keyAchievements: ['Fixed 10+ memory bugs in C/C++ cutting crash rates by 20%'] } ] },
  ],
  selectedProjects: [
    { id: 'p1', name: 'CareerForge', techStack: 'TypeScript, tRPC, XState, Node.js, Python, FastAPI, spaCy, scikit-learn, React, pgvector, PostgreSQL, MongoDB, Redis', date: '2025',
      descriptionPoints: ['Architected a 5-layer, 28-agent platform', 'Built a two-pass ResumeForge engine'] },
  ],
  skillsCategories: [{ category: 'AI/ML & LLM', skills: ['LLM Integration', 'RAG', 'C++', 'C#'] }],
  education: [{ degree: 'Master of Science', major: 'Data Science', institution: 'NJIT', graduationDate: 'May 2024', gpa: '' }],
};
const p2_mid = {
  bullets: {
    e1: ['Developed a multi-modal transformer mapping fMRI signals to brain regions, achieving **94% accuracy** across 4 cohorts (HCP, Dallas, OASIS, PreventAD)',
         'Applied transfer learning from Vision Transformers to cut model training time by ~40% versus training from scratch'],
    e2: ['Diagnosed and fixed 10+ critical memory bugs in C/C++ (CATIA), cutting crash rates by 20% and improving enterprise stability'],
    p1: ['Architected a 5-layer, 28-agent platform blending deterministic, GenAI, and hybrid agents: an intent router, an XState FSM conductor, and a validation judge (regex -> pgvector RAG -> LLM -> RLV Rlog)',
         'Implemented a two-pass ResumeForge engine: Pass 1 selects by tier; Pass 2 writes STAR bullets and compiles to PDF via LaTeX'],
  },
  achievements: {}, improvements: [], resumePlainText: 'Pranav ... plain text resume',
};
results.mid = run(p1_mid, p2_mid).latex;

// ── Fixture 2: SENIOR with summary + a STACKED company (2 roles) ──
const p1_senior = {
  tier: 'senior', sectionOrder: ['summary', 'experience', 'skills', 'education'],
  summary: 'Senior AI engineer with 12 years building production ML systems at scale.',
  companies: [
    { company: 'Google', renderAsStacked: true, positions: [
      { id: 's1', title: 'Staff Engineer', startDate: 'Jan 2023', endDate: 'Present', location: 'Mountain View, CA', isSelected: true,
        keyAchievements: ['Led platform migration across 30 services'] },
      { id: 's2', title: 'Senior Engineer', startDate: 'Jan 2020', endDate: 'Jan 2023', location: 'Mountain View, CA', isSelected: true,
        keyAchievements: ['Built microservices handling 1M+ QPS'] } ] },
  ],
  skillsCategories: [{ category: 'Languages', skills: ['Go', 'Python'] }],
  education: [{ degree: 'BS', major: 'CS', institution: 'MIT', graduationDate: '2012', gpa: '' }],
};
const p2_senior = {
  summary: 'Senior AI engineer with 12 years driving production ML at scale, from research to reliable systems.',
  bullets: { s1: ['Drove a platform migration across 30 services with zero downtime'], s2: ['Architected microservices sustaining **1M+ QPS** at p99 < 50ms'] },
};
results.senior = run(p1_senior, p2_senior).latex;

// ── Fixture 3: FRESHER (internships + projects + activities), NO experience ──
const p1_fresh = {
  tier: 'fresher', sectionOrder: ['education', 'projects', 'internships', 'skills', 'activities'],
  companies: [],
  selectedInternships: [{ id: 'in1', title: 'ML Intern', company: 'Acme', startDate: 'Jun 2023', endDate: 'Aug 2023', location: 'NYC',
    keyAchievements: ['Built a churn model with 0.85 AUC'] }],
  selectedProjects: [{ id: 'pp1', name: 'Recsys', techStack: 'PyTorch', date: '2023', descriptionPoints: ['Built a two-tower recommender'] }],
  skillsCategories: [{ category: 'ML', skills: ['PyTorch'] }],
  education: [{ degree: 'BS', major: 'CS', institution: 'Rutgers', graduationDate: '2024', gpa: '3.8' }],
  activities: [{ name: 'AI Club', organization: 'Rutgers', date: '2022-2024', description: 'Led 20+ workshops on deep learning' }],
};
results.fresher = run(p1_fresh, { bullets: {}, achievements: {} }).latex;

// ── Fixture 4: FALLBACK — empty pass2 must render from verbatim ──
results.fallback = run(p1_mid, {}).latex;

// ── Fixture 5: TORTURE — a Pass-2 bullet packed with LaTeX-breaking chars ──
const p1_tort = {
  tier: 'mid', sectionOrder: ['experience'],
  companies: [{ company: 'X & Y_Co', renderAsStacked: false, positions: [
    { id: 't1', title: 'Engineer', startDate: '2021', endDate: '2024', location: 'NYC', isSelected: true, keyAchievements: ['placeholder'] }] }],
};
const p2_tort = { bullets: { t1: ['Cut $100k budget by ~40% & boosted C++17 R&D throughput 50% via a_b pipeline; wrote \\LaTeX docs, regex a->b, #1 ranked, **94% win**'] } };
results.torture = run(p1_tort, p2_tort).latex;

// ─────────── Assertions ───────────
console.log('\n[Assertions]');
for (const [name, tex] of Object.entries(results)) {
  console.log('Fixture: ' + name);
  check(name + ': non-empty latex', tex && tex.length > 200);
  check(name + ': has \\begin{document}', tex.includes('\\begin{document}'));
  check(name + ': NO $$ display-math (broken-bullet class)', !tex.includes('$$'));
  check(name + ': NO \\labelitemii math bullet', !tex.includes('$\\bullet$') && !tex.includes('\\vcenter'));
  check(name + ': header keeps $|$ separators', tex.includes(' $|$ '));
  check(name + ': project heading uses tabularx (wrap)', !tex.includes('Projects') || tex.includes('\\begin{tabularx}') || !tex.includes('\\resumeProjectHeading'));
}
// torture-specific: every dangerous char must be escaped, none raw
const t = results.torture;
check('torture: $ escaped (no UNescaped $100k)', t.includes('\\$100k') && !/(^|[^\\])\$100k/.test(t));
check('torture: % escaped', !/[^\\]%/.test(t.replace(/%%% .*/g, '')) , 'raw % found');
check('torture: & escaped', t.includes('X \\& Y') || t.includes('\\&'));
check('torture: _ escaped', t.includes('a\\_b') && t.includes('Y\\_Co'));
check('torture: backslash neutralized (no raw \\LaTeX)', !t.includes('\\LaTeX'));
check('torture: # escaped', t.includes('\\#1'));
check('torture: ~ neutralized', t.includes('\\textasciitilde{}'));
check('torture: **bold** -> \\textbf', t.includes('\\textbf{94\\% win}'));
check('torture: NO leftover ** markers', !t.includes('**'));
// stacked-specific
check('senior: stacked uses \\resumeSubSubheading', results.senior.includes('\\resumeSubSubheading'));
check('mid: refined bullet present (94% accuracy)', results.mid.includes('\\textbf{94\\% accuracy}'));
check('fallback: verbatim bullet present', results.fallback.includes('Built fMRI transformer'));

// write .tex for compile test
const outDir = path.join(__dirname, '_s10_out');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, tex] of Object.entries(results)) fs.writeFileSync(path.join(outDir, name + '.tex'), tex);
console.log('\nWrote .tex files to scripts/_s10_out/');
console.log(failures ? ('\n*** ' + failures + ' ASSERTION FAILURES ***') : '\nALL ASSERTIONS PASSED');
process.exit(failures ? 1 : 0);
