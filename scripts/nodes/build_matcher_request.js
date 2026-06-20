// Build Matcher Request — S13 (Sprint 6). Assembles the POST body for the matcher
// service: resume_text + the top-25 jobs (by tier then recency) to rerank, with
// enrich=true so the matcher Firecrawl-validates + JD-enriches the top 12.
// Replaces the LLM JobScorer's input. Out: { resume_text, jobs, enrich, top_n }.
const bsi = $('Build Scorer Input').first().json || {};
const jobs = bsi.jobs || [];
const resume = bsi.master_resume_summary || '';

// recency lives on the Aggregate Jobs records (jobBatch dropped updated_at)
let dateById = {};
try {
  const agg = ($('Aggregate Jobs').first().json || {}).jobs || [];
  agg.forEach((j) => { if (j && j.job_id) dateById[j.job_id] = j.updated_at; });
} catch (e) {}

const sorted = jobs.slice().sort((a, b) => {
  const t = (a.source_tier || 99) - (b.source_tier || 99);
  if (t !== 0) return t;
  const ad = new Date(dateById[a.job_id] || 0).getTime() || 0;
  const bd = new Date(dateById[b.job_id] || 0).getTime() || 0;
  return bd - ad;
});

const top = sorted.slice(0, 25);
const payloadJobs = top.map((j) => ({
  id: j.job_id,
  title: [j.title, j.company].filter(Boolean).join(' at '),
  jd_text: j.description_snippet || '',
  url: j.url || '',
}));

return [{ json: { resume_text: resume, jobs: payloadJobs, enrich: true, top_n: 12 } }];
