// Cache Prefilter — Phase 3 (cache-first). Carries the full JobRecord forward
// (trust, skills, salary, full jd_text, posted_at) instead of flattening to a
// snippet, tags source_priority:0 so the cache outranks web at equal tier, and
// runs the NEG-regex over the FULL JD. Emits one {jobs, source:'cache', count}
// envelope (count is the cache-shortfall signal the web lanes gate on).
const rows = $input.all().map(i => i.json).filter(r => r && r.job_id);
const NEG = /(u\.?s\.?\s*citizen(ship)?\s*(required|only)|must\s*be\s*a\s*(u\.?s\.?\s*)?citizen|security\s*clearance|active\s*clearance|ts\/sci|secret\s*clearance|no\s*sponsorship|not?\s*(able|willing)\s*to\s*sponsor|unable\s*to\s*sponsor)/i;
const NEG_TITLE = /\b(intern(ship)?|internship|trainee|apprentice|hackathon\s*intern|co-?op)\b/i;
const seen = new Set();
const jobs = [];
for (const r of rows) {
  const jd = String(r.jd_text || '');
  if (NEG.test(jd)) continue;
  if (NEG_TITLE.test(r.title || '')) continue;
  const url = r.apply_url || r.url || '';
  if (!url) continue;
  const key = url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  jobs.push({
    job_id: 'cache_' + r.job_id,
    cache_job_id: r.job_id,
    title: r.title || '',
    company: r.company || '',
    company_domain: r.company_domain || null,
    location: r.location || '',
    remote: !!r.remote,
    url: url,
    updated_at: r.posted_at || null,
    posted_at: r.posted_at || null,
    status: r.status || 'active',
    source: 'cache',
    source_tier: 1,
    source_priority: 0,
    trust: r.trust || 0,
    tier: r.tier || null,            // desirability tier (S/A/B/C/D) from company_tiers

    seniority: r.seniority || null,
    employment_type: r.employment_type || null,
    skills: Array.isArray(r.skills) ? r.skills : [],
    salary_min: r.salary_min ?? null,
    salary_max: r.salary_max ?? null,
    salary_currency: r.salary_currency || null,
    description_snippet: jd.slice(0, 600),
    jd_text: jd,
    rrf_score: r.rrf_score || 0,
  });
}
return [{ json: { jobs: jobs, source: 'cache', count: jobs.length } }];
