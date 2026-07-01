// Build Scorer Input v6 — resume_bubbles aware, compact by default.
// Phase 3: also emits master_resume_text (full resume for skill extraction) and
// forwards the cache JobRecord fields (jd_text/source_priority/rrf_score/posted_at)
// onto jobBatch so Build Matcher Request can send the full JD + rank cache-first.
const jobs = $('Experience Filter').first().json.jobs || [];
const sd = $getWorkflowStaticData('global');

function parseMaybe(v) {
  if (!v) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch(e) { return v; } }
  return v;
}
function firstPrimary(arr) {
  return Array.isArray(arr) ? (arr.find(x => x && x.primary) || arr[0] || {}) : {};
}
function clean(v) {
  const s = (v === null || v === undefined) ? '' : String(v).trim();
  if (!s || s.toLowerCase() === 'undefined' || s.toLowerCase() === 'null') return '';
  return s;
}
function locToString(loc) {
  if (!loc) return '';
  if (typeof loc === 'string') return clean(loc);
  return [loc.city, loc.region, loc.country].map(clean).filter(Boolean).join(', ');
}
function flatSkills(skills) {
  const out = [];
  if (skills && typeof skills === 'object') {
    for (const vals of Object.values(skills)) if (Array.isArray(vals)) out.push(...vals);
  }
  return [...new Set(out.map(s => String(s).trim()).filter(Boolean))];
}
function summarizeBubbles(r) {
  const parts = [];
  const p = r.personal || r.profile || {};
  const email = firstPrimary(p.emails).address || p.email || '';
  const loc = locToString(firstPrimary(p.locations)) || p.location || '';
  if (p.name) parts.push('CANDIDATE: ' + p.name);
  if (p.headline) parts.push('HEADLINE: ' + p.headline);
  if (email || loc) parts.push('CONTACT CONTEXT: ' + [email, loc].filter(Boolean).join(' | '));
  const wa = p.work_authorization;
  if (wa) parts.push('WORK AUTHORIZATION: ' + (typeof wa === 'object' ? Object.entries(wa).map(([k, v]) => k + ': ' + v).join(' | ') : String(wa)));
  const skillsList = flatSkills(r.skills);
  if (skillsList.length) parts.push('SKILLS: ' + skillsList.slice(0, 55).join(', '));
  const exp = Array.isArray(r.experience) ? r.experience : [];
  if (exp.length) {
    parts.push('EXPERIENCE EVIDENCE:\n' + exp.slice(0, 5).map(e => {
      const title = [e.title, e.company || e.organization].filter(Boolean).join(' @ ');
      const bullets = (e.bullets || []).slice(0, 4).map(b => '- ' + b).join('\n');
      return title + (bullets ? '\n' + bullets : '');
    }).join('\n\n'));
  }
  const projects = Array.isArray(r.projects) ? r.projects : [];
  if (projects.length) {
    parts.push('PROJECT EVIDENCE:\n' + projects.slice(0, 4).map(pj => {
      const title = pj.name || pj.title || 'Project';
      const bullets = (pj.bullets || []).slice(0, 3).map(b => '- ' + b).join('\n');
      return title + (bullets ? '\n' + bullets : '');
    }).join('\n\n'));
  }
  const edu = Array.isArray(r.education) ? r.education : [];
  if (edu.length) parts.push('EDUCATION: ' + edu.map(e => [e.degree, e.field, e.institution].filter(Boolean).join(' ')).join(' | '));
  return parts.join('\n\n').substring(0, 3500);
}
function summarizeStructured(r) {
  if (!r || typeof r !== 'object') return '';
  if (r.kind === 'resume_bubbles') {
    const compact = r.compact_views?.scoring_profile || r.compact_views?.search_profile || '';
    return (compact || summarizeBubbles(r)).substring(0, 3500);
  }
  const parts = [];
  const p = r.personal || {};
  const email = firstPrimary(p.emails).address || p.email || '';
  const loc = locToString(firstPrimary(p.locations)) || p.location || '';
  if (p.name) parts.push('CANDIDATE: ' + p.name);
  if (p.headline) parts.push('HEADLINE: ' + p.headline);
  if (email || loc) parts.push('CONTACT CONTEXT: ' + [email, loc].filter(Boolean).join(' | '));
  if (Array.isArray(r.summary_bullets) && r.summary_bullets.length) {
    parts.push('SUMMARY:\n' + r.summary_bullets.slice(0, 6).map(b => '- ' + b).join('\n'));
  }
  if (Array.isArray(r.experience) && r.experience.length) {
    const expBlocks = r.experience.slice(0, 5).map(e => {
      const dates = (e.start_date || '?') + ' to ' + (e.is_current ? 'current' : (e.end_date || '?'));
      const bullets = [];
      (e.projects || []).slice(0, 3).forEach(pr => {
        if (pr.name) bullets.push('Project: ' + pr.name + (Array.isArray(pr.tech) && pr.tech.length ? ' [' + pr.tech.slice(0, 8).join(', ') + ']' : ''));
        (pr.bullets || []).slice(0, 4).forEach(b => bullets.push(b));
      });
      (e.bullets || []).slice(0, 4).forEach(b => bullets.push(b));
      return (e.title || 'Role') + ' @ ' + (e.company || e.organization || 'Company') + ' (' + dates + ')' + (bullets.length ? '\n  ' + bullets.slice(0, 8).map(b => '- ' + b).join('\n  ') : '');
    });
    parts.push('EXPERIENCE:\n' + expBlocks.join('\n\n'));
  }
  if (Array.isArray(r.projects) && r.projects.length) {
    const projBlocks = r.projects.slice(0, 6).map(pj => {
      const tech = Array.isArray(pj.tech) && pj.tech.length ? ' [' + pj.tech.slice(0, 8).join(', ') + ']' : '';
      const bullets = (pj.bullets || []).slice(0, 3).map(b => '- ' + b).join('\n  ');
      return (pj.name || pj.title || 'Project') + tech + (bullets ? '\n  ' + bullets : '');
    });
    parts.push('PROJECTS:\n' + projBlocks.join('\n'));
  }
  const skillsList = flatSkills(r.skills);
  if (skillsList.length) parts.push('SKILLS: ' + skillsList.slice(0, 60).join(', '));
  if (Array.isArray(r.education) && r.education.length) {
    parts.push('EDUCATION: ' + r.education.map(e => [e.degree, e.field, e.institution].filter(Boolean).join(' ') + (e.gpa ? ' GPA ' + e.gpa : '')).join(' | '));
  }
  return parts.join('\n\n').substring(0, 6000);
}

const rows = $input.all().map(i => i.json || {});
let row = rows.find(r => r && (r.id === 'global:resume_structured' || r.value)) || rows[0] || {};
let resume = parseMaybe(row.value || null);
if (resume && resume.resume_doc) resume = resume.resume_doc;
if ((!resume || typeof resume !== 'object' || !resume.personal) && sd.last_resume_structured) resume = sd.last_resume_structured;
if ((!resume || typeof resume !== 'object') && sd.last_resume_json) resume = sd.last_resume_json;

let resumeSummary = summarizeStructured(resume);
let resumeMissing = !resumeSummary;
if (resumeMissing) resumeSummary = 'No resume found - please run resume setup first';

// Full resume text for the matcher's skill extraction (the cross-encoder truncates
// to ~512 tokens, but full text gives the skill graph the most to work with).
const resumeFull = (resume && typeof resume === 'object'
  && (clean(resume.raw_text) || clean(resume.compact_views?.scoring_profile))) || '';
const resumeText = resumeFull || resumeSummary;

const jobBatch = jobs.map(j => ({
  job_id: j.job_id, title: j.title, company: j.company, location: j.location,
  department: j.department, url: j.url, description_snippet: j.description_snippet,
  jd_text: j.jd_text || j.description_snippet || '',
  source: j.source, source_tier: j.source_tier, source_priority: j.source_priority ?? null,
  source_tier_label: j.source_tier_label || j.tier_label,
  ats_source: j.ats_source || (j.source && j.source !== 'cache' ? j.source : null),  // Tier 2 liveness routing
  board: j.board || null, external_id: j.external_id || null, apply_url: j.apply_url || j.url || '',
  rrf_score: j.rrf_score ?? null, updated_at: j.updated_at || j.posted_at || null,
  required_yoe_min: j.required_yoe_min ?? null, required_yoe_max: j.required_yoe_max ?? null,
  yoe_compat_score: j.yoe_compat_score ?? null,
  salary_min: j.salary_min ?? null, salary_max: j.salary_max ?? null, salary_currency: j.salary_currency || null
}));

let _eq = {}; try { _eq = $('Parse Expand Query').first().json || {}; } catch(_) {}
return [{ json: {
  master_resume_summary: resumeSummary,
  master_resume_text: resumeText,
  resume_missing: resumeMissing,
  resume_kind: resume && typeof resume === 'object' ? (resume.kind || 'structured') : 'none',
  resume_source: resumeMissing ? 'none' : (row.id ? 'supabase' : 'staticData'),
  requested_location: _eq.location_canonical || null,
  requested_remote: _eq.remote_preference || null,
  requested_country: _eq.country || null,
  jobs: jobBatch
} }];
