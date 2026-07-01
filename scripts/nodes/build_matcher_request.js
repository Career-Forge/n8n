// Build Matcher Request — S13 + Phase 3. POST body for the matcher service:
// the full resume + the top-25 candidates (cache-first: source_priority -> rrf
// relevance -> tier -> recency) with FULL JD text, enrich=true. The matcher now
// reranks all 25, then validates the post-rerank top_n (true 2-pass), so input
// order only decides which 25 are sent, not what gets validated.
// Out: { resume_text, jobs, enrich, top_n }.
const bsi = $('Build Scorer Input').first().json || {};
const jobs = bsi.jobs || [];
const resume = bsi.master_resume_text || bsi.master_resume_summary || '';

// metadata for ordering/recency lives on the Aggregate Jobs records too
let metaById = {};
try {
  const agg = ($('Aggregate Jobs').first().json || {}).jobs || [];
  agg.forEach((j) => { if (j && j.job_id) metaById[j.job_id] = j; });
} catch (e) {}

const meta = (j) => metaById[j.job_id] || j;
const dateOf = (j) => { const m = meta(j); return new Date(m.posted_at || m.updated_at || j.updated_at || 0).getTime() || 0; };

const sorted = jobs.slice().sort((a, b) => {
  const ma = meta(a), mb = meta(b);
  const pa = ma.source_priority ?? a.source_priority ?? 1;
  const pb = mb.source_priority ?? b.source_priority ?? 1;
  if (pa !== pb) return pa - pb;                       // cache (0) before web (1)
  if (pa === 0) {
    const ra = ma.rrf_score || a.rrf_score || 0;
    const rb = mb.rrf_score || b.rrf_score || 0;
    if (rb !== ra) return rb - ra;                     // cache hybrid relevance
  }
  const t = (a.source_tier || 99) - (b.source_tier || 99);
  if (t !== 0) return t;
  return dateOf(b) - dateOf(a);
});

const top = sorted.slice(0, 25);
const payloadJobs = top.map((j) => ({
  id: j.job_id,
  title: [j.title, j.company].filter(Boolean).join(' at '),
  jd_text: j.jd_text || j.description_snippet || '',   // full cache JD when available
  url: j.url || '',
  source: j.ats_source || null,                        // Tier 2: real ATS provider for find-time liveness
  board: j.board || null,
  external_id: j.external_id || null,
  apply_url: j.apply_url || j.url || '',
}));

return [{ json: { resume_text: resume, jobs: payloadJobs, enrich: true, top_n: 15 } }];
