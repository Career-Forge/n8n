// Ingest Resume JSON v1 — deterministic, no-LLM. Validates a user-provided resume JSON
// (filled from the onboarding template) and assembles the resume_bubbles resume_doc.
// On bad/absent JSON it returns { _needs_template:true } -> Send Resume Template.
const j = $input.first().json || {};
let extractCtx = {};
try { extractCtx = $('Extract Input').first().json || {}; } catch (e) { extractCtx = {}; }
const chatId = j.chat_id || extractCtx.chat_id || null;
const now = new Date().toISOString();

function asStr(v) { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'number' || typeof v === 'boolean') return String(v); return ''; }
function arr(v) { return Array.isArray(v) ? v : []; }
function clean(v) { return asStr(v).replace(/\p{C}/gu, ch => (ch === '\n' || ch === '\t' ? ch : ' ')).trim(); }
function uniq(a) { const s = new Set(), o = []; for (const v of a || []) { const t = clean(v); if (!t) continue; const k = t.toLowerCase(); if (!s.has(k)) { s.add(k); o.push(t); } } return o; }
function slug(s) { return asStr(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 70) || 'item'; }
function needTemplate(reason) { return [{ json: { chat_id: chatId, _error: reason, _needs_template: true } }]; }

// 1) Get raw JSON text (file upload or paste) and parse robustly.
const rawText = asStr(j.upload_text || j.resume_json || j.resume_text || j.message_text || j.text || extractCtx.message_text || '').trim();
const stripped = rawText.replace(/^﻿/, '').replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '').trim();
let data = null;
try { data = JSON.parse(stripped); }
catch (e) { const m = stripped.match(/\{[\s\S]*\}/); if (m) { try { data = JSON.parse(m[0]); } catch (_) {} } }
if (!data || typeof data !== 'object' || Array.isArray(data)) {
  return needTemplate('That was not a valid resume JSON. Send your resume in the JSON template (as a .json file or pasted text).');
}

// 2) Validate required structure.
const personalIn = data.personal || data.profile || {};
const name = clean(personalIn.name);
const expIn = arr(data.experience), projIn = arr(data.projects);
if (!name) return needTemplate('Your resume JSON is missing "personal.name". Fill the template and resend.');
if (!expIn.length && !projIn.length) return needTemplate('Your resume JSON has no experience or projects. Fill the template and resend.');

// 3) Personal.
function normEmails(a) { return arr(a).map((e, i) => { const addr = typeof e === 'string' ? clean(e) : clean(e.address || e.email); return { address: addr, primary: e && e.primary !== undefined ? !!e.primary : i === 0, label: (e && e.label) || (i === 0 ? 'primary' : 'other') }; }).filter(e => e.address); }
function normPhones(a) { return arr(a).map((p, i) => { const num = typeof p === 'string' ? clean(p) : clean(p.number || p.phone); return { number: num, primary: p && p.primary !== undefined ? !!p.primary : i === 0, label: (p && (p.label || p.region)) || (i === 0 ? 'primary' : 'other'), region: clean(p && p.region) }; }).filter(p => p.number); }
const locIn = personalIn.location || {};
const locObj = (locIn && (locIn.city || locIn.region || locIn.country)) ? { city: clean(locIn.city), region: clean(locIn.region), country: clean(locIn.country), primary: true } : null;
const links = {};
for (const [k, v] of Object.entries(personalIn.links || {})) { const u = clean(v); if (u) links[k] = u; }
const profile = {
  name, headline: clean(personalIn.headline),
  emails: normEmails(personalIn.emails), phones: normPhones(personalIn.phones),
  links, locations: locObj ? [locObj] : [],
  work_authorization: clean(personalIn.work_authorization),
  show_location: !!(locIn && locIn.show_on_resume)
};

// 4) Typed bubbles from structured entries.
function tagsFor(text, type) { const l = asStr(text).toLowerCase(); const t = [type]; if (/(machine learning|pytorch|tensorflow|model|llm|rag|nlp|vision|ai)/.test(l)) t.push('ai-ml'); if (/(data|sql|etl|pipeline|spark|airflow|analytics)/.test(l)) t.push('data'); if (/(aws|azure|gcp|docker|kubernetes|cloud|deploy|api)/.test(l)) t.push('cloud-platform'); if (/(research|publication|experiment|study)/.test(l)) t.push('research'); if (/(lead|mentor|manage|stakeholder|cross-functional)/.test(l)) t.push('leadership'); return uniq(t); }
const experienceBubbles = expIn.map((e, i) => {
  const bullets = uniq(arr(e.bullets)).slice(0, 15);
  const raw = [e.title, e.company, e.location, bullets.join('\n')].filter(Boolean).join('\n');
  return { id: `experience_${slug(e.company || e.title)}_${asStr(e.start_date).slice(0, 4) || (i + 1)}`, type: 'experience', title: clean(e.title), organization: clean(e.company || e.organization), company: clean(e.company || e.organization), location: clean(e.location), start_date: clean(e.start_date) || null, end_date: clean(e.end_date) || null, is_current: !!e.is_current, bullets, skills: uniq(arr(e.skills)).slice(0, 30), metrics: uniq(arr(e.metrics)).slice(0, 20), tags: tagsFor(raw, 'experience'), raw_text: raw, confidence: 0.95, order_index: i + 1 };
});
const projectBubbles = projIn.map((p, i) => {
  const bullets = uniq(arr(p.bullets)).slice(0, 15); const tech = uniq(arr(p.tech)).slice(0, 25);
  const raw = [p.name, tech.join(', '), bullets.join('\n')].filter(Boolean).join('\n');
  return { id: `project_${slug(p.name)}_${i + 1}`, type: 'project', title: clean(p.name), name: clean(p.name), organization: '', url: clean(p.url), tech, skills: tech, start_date: clean(p.start_date) || null, end_date: clean(p.end_date) || null, is_current: false, bullets, metrics: uniq(arr(p.metrics)).slice(0, 20), tags: tagsFor(raw, 'project'), raw_text: raw, confidence: 0.95, order_index: i + 1 };
});
const educationBubbles = arr(data.education).map((ed, i) => {
  const raw = [ed.institution, ed.degree, ed.field, ed.gpa ? ('GPA ' + ed.gpa) : '', arr(ed.coursework).join(', ')].filter(Boolean).join(' | ');
  return { id: `education_${slug(ed.institution || ed.degree)}_${i + 1}`, type: 'education', title: clean(ed.degree || ed.institution), institution: clean(ed.institution), organization: clean(ed.institution), degree: clean(ed.degree), field: clean(ed.field), location: clean(ed.location), start_date: clean(ed.start_date) || null, end_date: clean(ed.end_date) || null, is_current: false, gpa: clean(ed.gpa), coursework: uniq(arr(ed.coursework)), bullets: [], skills: [], metrics: ed.gpa ? ['GPA ' + clean(ed.gpa)] : [], tags: ['education'], raw_text: raw, confidence: 0.9, order_index: i + 1 };
});

// 5) Skills (categorized as given, or flat -> other).
const skillsIn = data.skills || {};
const skills = { programming: [], ai_ml: [], data_mlops: [], cloud_devops: [], tools: [], other: [] };
if (Array.isArray(skillsIn)) skills.other = uniq(skillsIn);
else for (const [cat, vals] of Object.entries(skillsIn)) { const key = skills[cat] !== undefined ? cat : 'other'; skills[key].push(...arr(vals)); }
for (const c of Object.keys(skills)) skills[c] = uniq(skills[c]).slice(0, 120);
const summary_bullets = uniq(arr(data.summary_bullets)).slice(0, 12);
const achievements = uniq(arr(data.achievements)).slice(0, 30);

// 6) Assemble resume_doc (same shape as the deterministic bubbles model).
const bubbles = [].concat(experienceBubbles, projectBubbles, educationBubbles).map((b, i) => ({ ...b, order_index: i + 1 }));
const experience = experienceBubbles.map(b => ({ id: b.id, title: b.title, company: b.organization, organization: b.organization, location: b.location, start_date: b.start_date, end_date: b.end_date, is_current: b.is_current, bullets: b.bullets, projects: [], skills: b.skills, metrics: b.metrics, tags: b.tags, raw_text: b.raw_text }));
const projects = projectBubbles.map(b => ({ id: b.id, name: b.name, title: b.title, tech: b.tech, url: b.url, bullets: b.bullets, start_date: b.start_date, end_date: b.end_date, skills: b.skills, metrics: b.metrics, tags: b.tags, raw_text: b.raw_text }));
const education = educationBubbles.map(e => ({ id: e.id, institution: e.institution, degree: e.degree, field: e.field, location: e.location, start_date: e.start_date, end_date: e.end_date, is_current: e.is_current, gpa: e.gpa, coursework: e.coursework, raw_text: e.raw_text }));

const allSkillsFlat = uniq(Object.values(skills).flat());
const skill_index = {};
for (const [cat, vals] of Object.entries(skills)) for (const s of vals) { const key = slug(s); if (!skill_index[key]) skill_index[key] = { name: s, category: cat, evidence_bubble_ids: [] }; for (const b of bubbles) { if (arr(b.skills).some(bs => bs.toLowerCase() === s.toLowerCase()) || asStr(b.raw_text).toLowerCase().includes(s.toLowerCase())) skill_index[key].evidence_bubble_ids.push(b.id); } skill_index[key].evidence_bubble_ids = uniq(skill_index[key].evidence_bubble_ids); }

function bubbleLine(b) { const org = b.organization || b.institution || ''; const date = [b.start_date, b.is_current ? 'current' : b.end_date].filter(Boolean).join(' -> '); const bul = (b.bullets || [])[0] ? ` — ${b.bullets[0]}` : ''; return `${b.type}: ${b.title || b.name || 'Item'}${org ? ' @ ' + org : ''}${date ? ' (' + date + ')' : ''}${bul}`; }
const topSkills = allSkillsFlat.slice(0, 45);
const searchProfile = [profile.name ? `Candidate: ${profile.name}` : '', profile.headline ? `Headline: ${profile.headline}` : '', topSkills.length ? `Core skills: ${topSkills.slice(0, 30).join(', ')}` : '', experienceBubbles.length ? `Experience themes: ${experienceBubbles.slice(0, 4).map(bubbleLine).join(' | ')}` : '', projectBubbles.length ? `Project themes: ${projectBubbles.slice(0, 4).map(bubbleLine).join(' | ')}` : ''].filter(Boolean).join('\n').slice(0, 1800);
const scoringProfile = [searchProfile, summary_bullets.length ? 'Summary:\n' + summary_bullets.map(b => '- ' + b).join('\n') : '', experienceBubbles.slice(0, 6).map(b => `${b.title} @ ${b.organization || ''}\n${b.bullets.slice(0, 4).map(x => '- ' + x).join('\n')}`).join('\n\n'), projectBubbles.slice(0, 5).map(b => `${b.title}\n${b.bullets.slice(0, 3).map(x => '- ' + x).join('\n')}`).join('\n\n')].filter(Boolean).join('\n\n').slice(0, 3500);
const generationBase = [searchProfile, 'Reusable evidence bubbles:', bubbles.slice(0, 16).map(b => `- [${b.id}] ${bubbleLine(b)}${arr(b.skills).length ? ' | skills: ' + b.skills.slice(0, 10).join(', ') : ''}`).join('\n')].filter(Boolean).join('\n').slice(0, 5000);
const rawTextJoined = [profile.name, profile.headline, summary_bullets.join('\n'), bubbles.map(b => b.raw_text).join('\n\n'), achievements.join('\n')].filter(Boolean).join('\n\n');

const warnings = [];
if (!profile.emails.length) warnings.push('No email in personal.emails.');
if (!experience.length) warnings.push('No experience entries.');
if (!education.length) warnings.push('No education entries.');

const resumeDoc = {
  schema_version: '2.0', kind: 'resume_bubbles',
  resume_id: 'resume_' + now.slice(0, 10).replace(/-/g, '_'),
  resume_hash: String(rawTextJoined.length) + '_' + slug(profile.name),
  source: { type: j.upload_text ? 'telegram_json_upload' : 'telegram_json_paste', file_name: extractCtx.document?.file_name || '', uploaded_at: now },
  personal: profile, profile,
  summary_bullets, experience, projects, education, achievements, skills, bubbles, skill_index,
  compact_views: { search_profile: searchProfile, scoring_profile: scoringProfile, generation_base: generationBase },
  raw_text: rawTextJoined,
  section_hints: {},
  derived: { structured_resume: null, structured_resume_model: null, structured_resume_updated_at: null },
  metadata: { created_at: now, updated_at: now, source_model: 'user-json-template-v1', ingestion_version: 3, parse_strategy: 'json_template', parse_confidence: 0.99, parse_warnings: warnings, raw_chars: rawText.length, clean_chars: rawTextJoined.length }
};

return [{ json: { chat_id: chatId, resume_doc: resumeDoc, _meta: { processed_at: now, parse_strategy: 'json_template', parse_confidence: 0.99, warnings } } }];
