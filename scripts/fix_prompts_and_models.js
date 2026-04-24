// ═══════════════════════════════════════════════════════════════
// Fix: Embed full prompts from .md files + correct model slugs
// Run: node scripts/fix_prompts_and_models.js
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const wfPath = path.join(__dirname, '..', 'workflows', '01_careerforge.json');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf-8'));

function readPrompt(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'prompts', name), 'utf-8').trim();
}

function findNode(id) {
  const node = wf.nodes.find(n => n.id === id);
  if (!node) throw new Error('Node ' + id + ' not found');
  return node;
}

// ─── Read all prompt files ───
const P = {
  seniority:     readPrompt('SeniorityDetector.md'),
  forgeScore:    readPrompt('ForgeScore_v3.md'),
  resumeForge:   readPrompt('ResumeForge_v3.md'),
  coverForge:    readPrompt('CoverForge_v3.md'),
  resumeRefine:  readPrompt('ResumeRefine.md'),
  coverRefine:   readPrompt('CoverRefine.md'),
  contactFinder: readPrompt('ContactFinder.md'),
  outreachWriter:readPrompt('OutreachWriter.md'),
  companyIntel:  readPrompt('CompanyIntel.md'),
};

// ─── Reusable expression: render merged search results ───
const searchResultsExpr =
  '{{ $json.merged_results.map(r => \'## \' + r.title + \'\\nURL: \' + r.url + \'\\n\' + r.snippet + (r.content ? \'\\n\' + r.content.substring(0, 500) : \'\')).join(\'\\n\\n---\\n\\n\') }}';

// ═══════════════════════════════════════════════════════════════
// Fix 1: Embed full verbatim prompts
// ═══════════════════════════════════════════════════════════════

// cf-058: SeniorityDetector
findNode('cf-058').parameters.prompt =
  '=' + P.seniority +
  '\n\n---\n\nMaster Resume:\n{{ $json.resume_text }}';

// cf-062: ForgeScore
findNode('cf-062').parameters.prompt =
  '=' + P.forgeScore +
  '\n\n---\n\nMaster Resume:\n{{ $json.resume_text }}' +
  '\n\nJob Description:\n{{ $json.job_description }}' +
  '\n\nJob Title: {{ $json.job_title }}\nCompany: {{ $json.company }}';

// cf-070: ResumeForge
findNode('cf-070').parameters.prompt =
  '=' + P.resumeForge +
  '\n\n---\n\nMaster Resume:\n{{ $json.resume_text }}' +
  '\n\nJob Description:\n{{ $json.job_description }}' +
  '\n\nSeniority Mode: {{ $json.seniority_mode }}' +
  '\n\nJob Title: {{ $json.job_title }}\nCompany: {{ $json.company }}';

// cf-076: CoverForge
findNode('cf-076').parameters.prompt =
  '=' + P.coverForge +
  '\n\n---\n\nMaster Resume:\n{{ $json.resume_text }}' +
  '\n\nJob Description:\n{{ $json.job_description }}' +
  '\n\nCompany: {{ $json.company }}\nJob Title: {{ $json.job_title }}' +
  '\n\nCandidate Location: {{ $json.personal.location || \'Unknown\' }}' +
  '\nCompany Location: {{ $json.location || \'Unknown\' }}';

// cf-107: ScoreOnly (same ForgeScore prompt, same vars)
findNode('cf-107').parameters.prompt =
  '=' + P.forgeScore +
  '\n\n---\n\nMaster Resume:\n{{ $json.resume_text }}' +
  '\n\nJob Description:\n{{ $json.job_description }}' +
  '\n\nJob Title: {{ $json.job_title }}\nCompany: {{ $json.company }}';

// cf-124: ReviseForge — includes BOTH ResumeRefine + CoverRefine
// with conditional instruction telling the model which to follow
findNode('cf-124').parameters.prompt =
  '=You are a {{ $json.revise_type === \'cover\' ? \'cover letter\' : \'resume\' }} refinement agent. Follow ONLY the applicable rules section below.\n\n' +
  '=== RESUME REFINEMENT RULES (apply ONLY when revise_type = "resume") ===\n\n' +
  P.resumeRefine + '\n\n' +
  '=== COVER LETTER REFINEMENT RULES (apply ONLY when revise_type = "cover") ===\n\n' +
  P.coverRefine + '\n\n' +
  '=== END OF RULES ===\n\n' +
  'IMPORTANT: Apply ONLY the {{ $json.revise_type === \'cover\' ? \'COVER LETTER REFINEMENT\' : \'RESUME REFINEMENT\' }} rules above. Ignore the other section entirely.\n\n' +
  '---\n\n' +
  'Previous {{ $json.revise_type === \'cover\' ? \'cover letter\' : \'resume\' }} JSON:\n{{ JSON.stringify($json.previous_json) }}\n\n' +
  'User\'s change request: {{ $json.change_request }}\n\n' +
  'Master Resume:\n{{ $json.resume_text }}\n\n' +
  'Job Description:\n{{ $json.job_description }}\n\n' +
  'Job Title: {{ $json.job_title }}\nCompany: {{ $json.company }}';

// cf-145: CompanyIntel
findNode('cf-145').parameters.prompt =
  '=' + P.companyIntel +
  '\n\n---\n\nCompany: {{ $json.company }}' +
  '\n\nSearch Results:\n' + searchResultsExpr;

// cf-150: ContactFinder
findNode('cf-150').parameters.prompt =
  '=' + P.contactFinder +
  '\n\n---\n\nCompany: {{ $json.company }}' +
  '\nTarget Role: {{ $json.role }}' +
  '\n\nSearch Results:\n' + searchResultsExpr;

// cf-158: OutreachWriter
findNode('cf-158').parameters.prompt =
  '=' + P.outreachWriter +
  '\n\n---\n\n' +
  'Contact: {{ $json.contact.name }} \u2014 {{ $json.contact.role }} at {{ $json.company }}\n' +
  'Contact Location: {{ $json.contact.location || \'Unknown\' }}\n' +
  'Contact Type: {{ $json.contact.type }}\n\n' +
  'Candidate: {{ $json.candidate_name }}\n' +
  'Candidate Location: {{ $json.candidate_location || \'Unknown\' }}\n' +
  'Target Role: {{ $json.role }}\n\n' +
  'Relevant Background:\n{{ $json.relevant_achievement }}';

// ═══════════════════════════════════════════════════════════════
// Fix 2: Correct model slugs
// ═══════════════════════════════════════════════════════════════

// anthropic/claude-sonnet-4-6 → anthropic/claude-sonnet-4.6
['cf-071', 'cf-077', 'cf-125', 'cf-159'].forEach(id => {
  findNode(id).parameters.model = 'anthropic/claude-sonnet-4.6';
});

// deepseek → deepseek/deepseek-chat-v3.1:free
['cf-059', 'cf-063', 'cf-108', 'cf-115', 'cf-146', 'cf-151'].forEach(id => {
  findNode(id).parameters.model = 'deepseek/deepseek-chat-v3.1:free';
});

// ═══════════════════════════════════════════════════════════════
// Write and report
// ═══════════════════════════════════════════════════════════════

fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2));

console.log('\n=== Prompt Lengths (9 nodes) ===');
[
  ['cf-058', 'SeniorityDetector'],
  ['cf-062', 'ForgeScore'],
  ['cf-070', 'ResumeForge'],
  ['cf-076', 'CoverForge'],
  ['cf-107', 'ScoreOnly'],
  ['cf-124', 'ReviseForge'],
  ['cf-145', 'CompanyIntel'],
  ['cf-150', 'ContactFinder'],
  ['cf-158', 'OutreachWriter'],
].forEach(([id, name]) => {
  const len = findNode(id).parameters.prompt.length;
  const ok = len > 3000 ? 'OK' : 'SHORT!';
  console.log('  ' + id + ' (' + name + '): ' + len + ' chars  ' + ok);
});

console.log('\n=== Model Slugs (10 nodes) ===');
['cf-059', 'cf-063', 'cf-071', 'cf-077', 'cf-108', 'cf-115', 'cf-125', 'cf-146', 'cf-151', 'cf-159'].forEach(id => {
  const node = findNode(id);
  console.log('  ' + id + ' (' + node.name + '): ' + node.parameters.model);
});

console.log('\nDone: workflow saved with full prompts and corrected model slugs.');
