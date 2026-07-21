/**
 * _s135_calibrate.js -- real pdflatex calibration probes for s135's render
 * redesign. Runs the ACTUAL patched "Assemble Resume LaTeX" node (via its
 * export_prompts.js mirror, scripts/nodes/assemble_resume_latex.js -- kept in
 * sync, 0-drift confirmed) against realistic pass1/pass2 fixtures for all 11
 * matrix entries from the approved plan, compiles each via the live
 * latex-service container (localhost:5679/compile, same call shape as
 * scripts/applied/_harness_s6b1.js), counts real PDF pages.
 *
 * STATUS: EXECUTED 2026-07-21. 11/11 fixtures pass at s135's current values
 * (the 1-page targets all hit exactly 1; the deliberately over-stuffed
 * overflow-probe correctly hits 2, proving the budget is genuinely binding).
 * This confirmed the two values s135 had marked PLACEHOLDER (the \vspace
 * between name/contact, the 3 compact -7pt values) -- both now say
 * "probe-confirmed" in s135's own comments, not placeholder.
 *
 * Real-PDF page counting note (non-obvious, cost real debugging time): this
 * container's pdflatex (pdfTeX 3.141592653-2.6-1.40.22) writes compressed
 * object streams (/ObjStm) -- /Type /Pages is NOT visible as plain text in
 * the raw PDF bytes. countPages() below decompresses every FlateDecode
 * stream in the file and searches the concatenated plaintext; a naive
 * plain-text regex silently returns 0 pages for every fixture.
 *
 * NOT covered by this pass (honest limitation, no rasterizer available in
 * either this environment or the latex-service container -- no gs/convert/
 * pdftoppm/pdfinfo/qpdf found): "1 page" is confirmed exactly, but visual
 * fill quality (not laughably sparse, no ugly clipping) was not eyeballed.
 * The realistic bullet counts/lengths used here (matching this session's own
 * real generated-resume review) and the overflow-probe's correct 2-page
 * split are the best available proxy for that without a rasterizer.
 *
 * Re-run: node scripts/_s135_calibrate.js --live
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');

const CODE = fs.readFileSync(path.join(__dirname, 'nodes', 'assemble_resume_latex.js'), 'utf8');

function runNode(pass1, pass2, ctx) {
  const $input = { first: () => ({ json: { pass1, pass2 } }) };
  const $ = (name) => ({ first: () => ({ json: name === 'Prepare Apply Context' ? ctx : {} }) });
  const $getWorkflowStaticData = () => ({ user_prefs: ctx._prefs || {} });
  const fn = new Function('$input', '$', '$getWorkflowStaticData', CODE);
  return fn($input, $, $getWorkflowStaticData);
}

function compile(latex) {
  return new Promise((resolve) => {
    const req = http.request({ host: 'localhost', port: 5679, path: '/compile', method: 'POST', headers: { 'Content-Type': 'text/plain' }, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const isPdf = buf.slice(0, 5).toString() === '%PDF-';
        resolve({ status: res.statusCode, len: buf.length, isPdf, buf, body: isPdf ? null : buf.toString('utf8').slice(0, 2000) });
      });
    });
    req.on('error', (e) => resolve({ status: 0, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, err: 'timeout' }); });
    req.write(latex);
    req.end();
  });
}

function countPages(buf) {
  // This container's pdflatex (pdfTeX 3.141592653-2.6-1.40.22) writes compressed
  // object streams (/ObjStm) -- the /Type /Pages dict is NOT visible as plain
  // text in the raw PDF bytes (confirmed by direct inspection). Decompress every
  // FlateDecode stream in the file and search the concatenated plaintext.
  const text = buf.toString('latin1');
  const re = /stream\r?\n/g;
  const decoded = [];
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end === -1) continue;
    const raw = buf.slice(start, end);
    try { decoded.push(zlib.inflateSync(raw).toString('latin1')); } catch (e) { /* not flate, or not a real stream -- skip */ }
  }
  const all = text + '\n' + decoded.join('\n');
  const m2 = all.match(/\/Type\s*\/Pages[\s\S]{0,300}?\/Count\s+(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  const matches = all.match(/\/Type\s*\/Page(?!s)\b/g) || [];
  return matches.length;
}

// ── Realistic bullet-text generators, tuned to STYLE_2LINE (130-155 char body,
// short bold keyword lead-in) and STYLE_1LINE (70-110 char, 1-line) targets ──
function kw2(keyword, text) { return { keyword, text }; }

const MID_SENIOR_BULLETS = [
  kw2('Pipeline Architecture', 'Designed and shipped a multi-agent LLM orchestration pipeline handling 40K+ monthly job-matching requests across seven providers'),
  kw2('Retrieval Quality', 'Built a hybrid pgvector + tsvector RRF ranking system that lifted cache-hit relevance from 61% to 89% against real user queries'),
  kw2('Scoring Infrastructure', 'Implemented a deterministic ATS-signal extractor and single-retry regeneration loop, cutting resume overflow incidents by 94%'),
  kw2('Cost Optimization', 'Cut per-application LLM spend 55% by consolidating eight redundant model calls into three parallelized passes with shared context'),
  kw2('Data Pipeline', 'Owned a nightly ETL job normalizing 15K+ postings across nine ATS platforms into a unified Postgres schema with zero downtime'),
  kw2('Reliability', 'Diagnosed and fixed a silent structured-output parser failure that had been dropping 30% of scheduled digests undetected for weeks'),
  kw2('Team Leadership', 'Led a three-engineer team through a full poller-scheduling rewrite, quadrupling registry coverage from 2K to 15K+ companies'),
  kw2('Platform Migration', 'Migrated a legacy Supabase resume store to a local-first Postgres architecture, eliminating a recurring 200ms write-latency spike'),
];

const JUNIOR_FRESHER_BULLETS = [
  kw2('React', 'Built a responsive dashboard in React and TypeScript used by 500+ weekly active users'),
  kw2('Python', 'Automated a data-cleaning pipeline in Python, cutting manual QA time by 6 hours weekly'),
  kw2('SQL', 'Wrote optimized SQL queries reducing report generation time from 4 minutes to 12 seconds'),
  kw2('Testing', 'Achieved 92% test coverage on a Django backend using pytest and CI integration'),
  kw2('ML', 'Trained a classification model reaching 94% accuracy on a 10K-row labeled dataset'),
  kw2('APIs', 'Designed a REST API serving 3 internal tools, documented with OpenAPI specs'),
];

function bulletsFor(n, senior) {
  const pool = senior ? MID_SENIOR_BULLETS : JUNIOR_FRESHER_BULLETS;
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[i % pool.length]);
  return out;
}

function pass2From(positions) {
  // positions: [{id, n, senior}] -> pass2.experience_bullets shape
  return positions.map((p) => ({ position_id: p.id, bullets: bulletsFor(p.n, p.senior) }));
}

const PERSONAL_FULL = {
  name: 'Pranav Shridhar Kowadkar', phone_display: '+91 88614 32607', email: 'pk.kowadkar@gmail.com',
  linkedin: 'https://linkedin.com/in/pkowadkar', github: 'https://github.com/p-kowadkar',
  portfolio: 'https://pkowadkar.com', location: 'Belagavi, Karnataka, India', show_location: true,
};
const PERSONAL_MIN = {
  name: 'Pranav Shridhar Kowadkar', phone_display: '+91 88614 32607', email: 'pk.kowadkar@gmail.com',
  linkedin: 'https://linkedin.com/in/pkowadkar', github: '', portfolio: '', location: '', show_location: false,
};

const proj = (name, tech, n) => ({ name, techStack: tech, date: '2026', descriptionPoints: bulletsFor(n, true).map((b) => b.text) });
const edu = (deg, inst) => ({ degree: deg, major: 'Data Science', institution: inst, graduationDate: 'Dec 2023', gpa: '' });
const skills = () => [
  { category: 'Languages', skills: ['Python', 'TypeScript', 'SQL', 'C++'] },
  { category: 'AI/ML', skills: ['LangChain', 'RAG', 'pgvector', 'PyTorch'] },
  { category: 'Infra', skills: ['n8n', 'Postgres', 'Docker', 'AWS'] },
];
const achv = (n) => Array.from({ length: n }, (_, i) => ({ title: `Winner, Sample Hackathon ${i + 1}` }));

function pos(id, title, company, start, end, n) {
  return { id, title, startDate: start, endDate: end, location: 'Remote', isSelected: true, tenureMonths: 18, relevanceScore: 80, keyAchievements: bulletsFor(n, true).map((b) => b.text) };
}

const FIXTURES = [
  {
    name: 'mid-4+2-flat',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'mid', sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'AI Engineer specializing in multi-agent LLM orchestration, RAG pipelines, and production-grade automation systems.',
      companies: [
        { company: 'Wisdom AI', positions: [pos('p1', 'AI Engineer', 'Wisdom AI', 'Jan 2025', 'Present', 3)] },
        { company: 'Vaandu Technologies', positions: [pos('p2', 'Data Engineer', 'Vaandu Technologies', 'Nov 2023', 'Dec 2024', 3)] },
        { company: 'Bayer', positions: [pos('p3', 'Data Analyst', 'Bayer', 'Jun 2022', 'Oct 2023', 2)] },
        { company: 'Dassault Systemes', positions: [pos('p4', 'R&D Software Engineer', 'Dassault Systemes', 'Jul 2020', 'May 2022', 2)] },
      ],
      selectedProjects: [proj('CareerForge', 'n8n, Postgres, LLMs', 3), proj('RegRadar', 'LangGraph, FastAPI', 2)],
      skillsCategories: skills(), selectedAchievements: achv(2),
      certifications: [{ name: 'AWS Certified', issuer: 'Amazon', date: '2025', qualityTier: 'exam' }],
      education: [edu('M.S.', 'NJIT'), edu('B.E.', 'VTU')],
    }),
    pass2: (p1) => ({ experience_bullets: pass2From([{ id: 'p1', n: 3, senior: true }, { id: 'p2', n: 3, senior: true }, { id: 'p3', n: 2, senior: true }, { id: 'p4', n: 2, senior: true }]) }),
    target: 1,
  },
  {
    name: 'mid-3+3',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'mid', sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'AI Engineer with production experience across multi-agent systems and applied ML.',
      companies: [
        { company: 'Wisdom AI', positions: [pos('p1', 'AI Engineer', 'Wisdom AI', 'Jan 2025', 'Present', 4)] },
        { company: 'Vaandu Technologies', positions: [pos('p2', 'Data Engineer', 'Vaandu Technologies', 'Nov 2023', 'Dec 2024', 3)] },
        { company: 'Bayer', positions: [pos('p3', 'Data Analyst', 'Bayer', 'Jun 2022', 'Oct 2023', 3)] },
      ],
      selectedProjects: [proj('CareerForge', 'n8n, Postgres, LLMs', 2), proj('RegRadar', 'LangGraph, FastAPI', 2), proj('Quorum', 'ElevenLabs, Telegram', 2)],
      skillsCategories: skills(), selectedAchievements: achv(2),
      certifications: [], education: [edu('M.S.', 'NJIT')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 'p1', n: 4, senior: true }, { id: 'p2', n: 3, senior: true }, { id: 'p3', n: 3, senior: true }]) }),
    target: 1,
  },
  {
    name: 'senior-4+2',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'senior', sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'Staff AI Engineer with 10+ years across ML infrastructure and multi-agent orchestration at scale.',
      companies: [
        { company: 'BigCo A', positions: [pos('p1', 'Staff AI Engineer', 'BigCo A', 'Jan 2023', 'Present', 4)] },
        { company: 'BigCo B', positions: [pos('p2', 'Senior ML Engineer', 'BigCo B', 'Jun 2020', 'Dec 2022', 3)] },
        { company: 'BigCo C', positions: [pos('p3', 'ML Engineer', 'BigCo C', 'Jan 2018', 'May 2020', 3)] },
        { company: 'BigCo D', positions: [pos('p4', 'Software Engineer', 'BigCo D', 'Jul 2015', 'Dec 2017', 2)] },
      ],
      selectedProjects: [proj('OSS Contribution A', 'Rust, Tokio', 2), proj('OSS Contribution B', 'Python, gRPC', 2)],
      skillsCategories: skills(), selectedAchievements: achv(3),
      certifications: [{ name: 'AWS Solutions Architect', issuer: 'Amazon', date: '2022', qualityTier: 'exam' }],
      education: [edu('M.S.', 'Stanford')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 'p1', n: 4, senior: true }, { id: 'p2', n: 3, senior: true }, { id: 'p3', n: 3, senior: true }, { id: 'p4', n: 2, senior: true }]) }),
    target: 1,
  },
  {
    name: 'senior-3+3',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'senior', sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'Principal Engineer with deep expertise in distributed systems and applied AI.',
      companies: [
        { company: 'BigCo A', positions: [pos('p1', 'Principal Engineer', 'BigCo A', 'Jan 2022', 'Present', 4)] },
        { company: 'BigCo B', positions: [pos('p2', 'Staff Engineer', 'BigCo B', 'Jun 2018', 'Dec 2021', 3)] },
        { company: 'BigCo C', positions: [pos('p3', 'Senior Engineer', 'BigCo C', 'Jan 2015', 'May 2018', 3)] },
      ],
      selectedProjects: [proj('OSS A', 'Rust', 2), proj('OSS B', 'Go', 2), proj('OSS C', 'Python', 2)],
      skillsCategories: skills(), selectedAchievements: achv(3),
      certifications: [], education: [edu('Ph.D.', 'CMU')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 'p1', n: 4, senior: true }, { id: 'p2', n: 3, senior: true }, { id: 'p3', n: 3, senior: true }]) }),
    target: 1,
  },
  {
    name: 'senior-stacked-run',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'senior', sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'Engineering leader who grew from IC to Principal across six years at one company, plus prior scale-up experience.',
      companies: [
        {
          company: 'LongTenure Corp', positions: [
            pos('s1', 'Principal Engineer', 'LongTenure Corp', 'Jan 2023', 'Present', 3),
            pos('s2', 'Senior Engineer', 'LongTenure Corp', 'Jan 2021', 'Dec 2022', 2),
            pos('s3', 'Software Engineer', 'LongTenure Corp', 'Jan 2019', 'Dec 2020', 2),
          ],
        },
        { company: 'ScaleUp Inc', positions: [pos('p4', 'Software Engineer', 'ScaleUp Inc', 'Jun 2016', 'Dec 2018', 2)] },
        { company: 'StartupX', positions: [pos('p5', 'Junior Engineer', 'StartupX', 'Jan 2015', 'May 2016', 2)] },
      ],
      selectedProjects: [proj('OSS A', 'Rust', 2), proj('OSS B', 'Go', 2)],
      skillsCategories: skills(), selectedAchievements: achv(3),
      certifications: [], education: [edu('M.S.', 'MIT')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 's1', n: 3, senior: true }, { id: 's2', n: 2, senior: true }, { id: 's3', n: 2, senior: true }, { id: 'p4', n: 2, senior: true }, { id: 'p5', n: 2, senior: true }]) }),
    target: 1,
  },
  {
    name: 'mid-stacked-run',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'mid', sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'AI Engineer who transitioned from Data Engineer to AI Engineer within the same organization.',
      companies: [
        {
          company: 'Wisdom AI', positions: [
            pos('s1', 'AI Engineer', 'Wisdom AI', 'Jun 2025', 'Present', 3),
            pos('s2', 'Data Engineer', 'Wisdom AI', 'Jan 2025', 'May 2025', 2),
          ],
        },
        { company: 'Vaandu Technologies', positions: [pos('p3', 'Data Engineer', 'Vaandu Technologies', 'Nov 2023', 'Dec 2024', 3)] },
        { company: 'Bayer', positions: [pos('p4', 'Data Analyst', 'Bayer', 'Jun 2022', 'Oct 2023', 2)] },
      ],
      selectedProjects: [proj('CareerForge', 'n8n, Postgres, LLMs', 2), proj('RegRadar', 'LangGraph, FastAPI', 2)],
      skillsCategories: skills(), selectedAchievements: achv(2),
      certifications: [], education: [edu('M.S.', 'NJIT')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 's1', n: 3, senior: true }, { id: 's2', n: 2, senior: true }, { id: 'p3', n: 3, senior: true }, { id: 'p4', n: 2, senior: true }]) }),
    target: 1,
  },
  {
    name: 'junior-reranged',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'junior', sectionOrder: ['education', 'experience', 'projects', 'skills', 'certifications'],
      companies: [
        { company: 'Company A', positions: [pos('p1', 'Software Engineer', 'Company A', 'Jan 2025', 'Present', 4)] },
        { company: 'Company B', positions: [pos('p2', 'Junior Engineer', 'Company B', 'Jun 2024', 'Dec 2024', 4)] },
        // boomerang: Company A appears again, non-adjacent -- must NOT merge with p1
        { company: 'Company A', positions: [pos('p3', 'Intern', 'Company A', 'Jan 2023', 'May 2024', 3)] },
      ],
      selectedProjects: [proj('Side Project A', 'React, Node', 3), proj('Side Project B', 'Python, Flask', 3)],
      skillsCategories: skills(),
      certifications: [{ name: 'Meta Front-End Cert', issuer: 'Meta', date: '2024', qualityTier: 'exam' }],
      education: [edu('B.Tech', 'VTU')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 'p1', n: 4, senior: false }, { id: 'p2', n: 4, senior: false }, { id: 'p3', n: 3, senior: false }]) }),
    target: 1,
  },
  {
    name: 'fresher',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'fresher', sectionOrder: ['education', 'projects', 'internships', 'skills', 'activities'],
      selectedInternships: [
        { id: 'i1', title: 'ML Intern', company: 'StartupX', startDate: 'Jun 2025', endDate: 'Dec 2025', location: 'Remote', keyAchievements: bulletsFor(3, false).map((b) => b.text) },
        { id: 'i2', title: 'SWE Intern', company: 'StartupY', startDate: 'Jan 2025', endDate: 'May 2025', location: 'Remote', keyAchievements: bulletsFor(3, false).map((b) => b.text) },
      ],
      selectedProjects: [proj('fMRI Classifier', 'PyTorch, stDNN', 3), proj('Amma Assistant', 'Python, RAG', 3), proj('Search Sentinel', 'Node, Elasticsearch', 3), proj('Smriti', 'Rust', 2)],
      skillsCategories: skills(),
      certifications: [{ name: 'Cert A', issuer: 'Issuer A', date: '2024', qualityTier: 'exam' }, { name: 'Cert B', issuer: 'Issuer B', date: '2024', qualityTier: 'exam' }],
      education: [edu('M.S.', 'NJIT')], activities: [{ name: 'Hackathon Club', role: 'Member' }],
    }),
    pass2: () => ({
      internship_bullets: [{ position_id: 'i1', bullets: bulletsFor(3, false) }, { position_id: 'i2', bullets: bulletsFor(3, false) }],
    }),
    target: 1,
  },
  {
    name: 'compact-mid',
    ctx: () => ({ personal: PERSONAL_MIN, _prefs: { template: 'compact' } }),
    pass1: () => ({
      tier: 'mid', sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'AI Engineer specializing in multi-agent LLM orchestration and production automation.',
      companies: [
        {
          company: 'Wisdom AI', positions: [
            pos('s1', 'AI Engineer', 'Wisdom AI', 'Jun 2025', 'Present', 3),
            pos('s2', 'Data Engineer', 'Wisdom AI', 'Jan 2025', 'May 2025', 2),
          ],
        },
        { company: 'Vaandu Technologies', positions: [pos('p3', 'Data Engineer', 'Vaandu Technologies', 'Nov 2023', 'Dec 2024', 2)] },
        { company: 'Bayer', positions: [pos('p4', 'Data Analyst', 'Bayer', 'Jun 2022', 'Oct 2023', 2)] },
      ],
      selectedProjects: [proj('CareerForge', 'n8n, Postgres, LLMs', 2), proj('RegRadar', 'LangGraph, FastAPI', 2)],
      skillsCategories: skills(), selectedAchievements: achv(2),
      certifications: [], education: [edu('M.S.', 'NJIT')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 's1', n: 3, senior: true }, { id: 's2', n: 2, senior: true }, { id: 'p3', n: 2, senior: true }, { id: 'p4', n: 2, senior: true }]) }),
    target: 1,
  },
  {
    name: 'contact-line-6-fields',
    ctx: () => ({ personal: PERSONAL_FULL }),
    pass1: () => ({
      tier: 'mid', sectionOrder: ['summary', 'experience', 'skills', 'education'],
      summary: 'AI Engineer.',
      companies: [{ company: 'Wisdom AI', positions: [pos('p1', 'AI Engineer', 'Wisdom AI', 'Jan 2025', 'Present', 2)] }],
      skillsCategories: skills(), education: [edu('M.S.', 'NJIT')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 'p1', n: 2, senior: true }]) }),
    target: 1,
    headerOnly: true,
  },
  {
    name: 'overflow-probe',
    ctx: () => ({ personal: PERSONAL_MIN }),
    pass1: () => ({
      tier: 'senior', sectionOrder: ['summary', 'experience', 'projects', 'skills', 'achievements', 'certifications', 'education'],
      summary: 'Deliberately over-stuffed fixture to confirm the redesign still has a real, binding upper bound.',
      companies: [
        {
          company: 'LongTenure Corp', positions: [
            pos('s1', 'Principal Engineer', 'LongTenure Corp', 'Jan 2023', 'Present', 4),
            pos('s2', 'Senior Engineer', 'LongTenure Corp', 'Jan 2021', 'Dec 2022', 4),
            pos('s3', 'Software Engineer', 'LongTenure Corp', 'Jan 2019', 'Dec 2020', 4),
          ],
        },
        { company: 'BigCo B', positions: [pos('p4', 'Staff Engineer', 'BigCo B', 'Jun 2016', 'Dec 2018', 4)] },
        // boomerang back to LongTenure Corp -- must NOT merge with the s1-s3 run above
        { company: 'LongTenure Corp', positions: [pos('p5', 'Intern', 'LongTenure Corp', 'Jan 2015', 'May 2016', 4)] },
      ],
      selectedProjects: [proj('OSS A', 'Rust', 3), proj('OSS B', 'Go', 3), proj('OSS C', 'Python', 3)],
      skillsCategories: skills(), selectedAchievements: achv(3),
      certifications: [{ name: 'Cert A', issuer: 'Issuer', date: '2024', qualityTier: 'exam' }],
      education: [edu('Ph.D.', 'MIT'), edu('M.S.', 'Stanford')],
    }),
    pass2: () => ({ experience_bullets: pass2From([{ id: 's1', n: 4, senior: true }, { id: 's2', n: 4, senior: true }, { id: 's3', n: 4, senior: true }, { id: 'p4', n: 4, senior: true }, { id: 'p5', n: 4, senior: true }]) }),
    target: 2, // deliberately over budget -- must NOT be forced to 1 page
  },
];

(async () => {
  const outDir = path.join(__dirname, '_tmp_s135_calibrate');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
  const results = [];
  for (const f of FIXTURES) {
    const pass1 = f.pass1();
    const pass2 = f.pass2(pass1);
    const ctx = f.ctx();
    let res, threw = false, err = '';
    try { res = runNode(pass1, pass2, ctx); } catch (e) { threw = true; err = e.stack || e.message; }
    if (threw) { console.log(`\n[${f.name}] NODE THREW: ${err}`); results.push({ name: f.name, ok: false, reason: 'threw' }); continue; }
    const latex = res[0].json.latex;
    fs.writeFileSync(path.join(outDir, f.name + '.tex'), latex);
    const cmp = await compile(latex);
    if (!cmp.isPdf) {
      console.log(`\n[${f.name}] COMPILE FAILED: status=${cmp.status} err=${cmp.err || ''}\n${(cmp.body || '').slice(0, 500)}`);
      results.push({ name: f.name, ok: false, reason: 'compile-fail' });
      continue;
    }
    const pages = countPages(cmp.buf);
    const ok = pages === f.target;
    console.log(`[${f.name}] pages=${pages} target=${f.target} ${ok ? 'PASS' : 'FAIL'}  (${cmp.len} bytes)`);
    results.push({ name: f.name, ok, pages, target: f.target });
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  pages=${r.pages ?? '?'} target=${r.target ?? '?'} ${r.reason || ''}`));
  console.log(failed.length ? `\n${failed.length} FIXTURE(S) FAILED -- .tex sources in ${outDir}/ for inspection` : '\nALL FIXTURES PASSED at s135\'s probe-confirmed values.');
})();
