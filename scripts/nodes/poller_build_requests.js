// Build Requests -- v2, Phase 2.3 adapter expansion.
// Adds 3 GET-fetchable-via-Fetch-ATS adapters (smartrecruiters, amazon, oracle) and
// 3 self-fetching adapters (workday, apple, eightfold) that ignore Fetch ATS's
// response entirely and make their own require('https') calls in Parse Jobs (POST
// bodies, small per-page caps, or a dual-endpoint-tier fallback that a single GET
// can't express). Still emit a best-effort URL for those three so Fetch ATS has
// something harmless to GET -- it will typically fail (400/403/405), which is fine,
// Parse Jobs never reads that response for these types.
const items = $input.all();
// NOTE: n8n JS task runner sandboxes out process.env; per-ATS toggles would need a settings table.
const IMPLEMENTED = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'smartrecruiters', 'amazon', 'oracle', 'workday', 'apple', 'eightfold', 'avature', 'google', 'deshaw', 'microsoft'];
const mkUrl = (t, slug, apiBase) => ({
  greenhouse: 'https://boards-api.greenhouse.io/v1/boards/' + slug + '/jobs?content=true',
  lever:      'https://api.lever.co/v0/postings/' + slug + '?mode=json',
  ashby:      'https://api.ashbyhq.com/posting-api/job-board/' + slug + '?includeCompensation=true',
  workable:   'https://apply.workable.com/api/v1/widget/accounts/' + slug + '?details=true',
  recruitee:  'https://' + slug + '.recruitee.com/api/offers',
  smartrecruiters: 'https://api.smartrecruiters.com/v1/companies/' + encodeURIComponent(slug) + '/postings?limit=100&offset=0',
  amazon:     'https://www.amazon.jobs/en/search.json?offset=0&result_limit=100',
  oracle:     'https://' + apiBase + '/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=' + encodeURIComponent(slug) + ',limit=20,offset=0,sortBy=POSTING_DATES_DESC',
  // self-fetching adapters (Parse Jobs discards this response and calls require('https') itself) --
  // still a real, harmless-if-it-fails URL so Fetch ATS's behavior stays predictable.
  workday:    'https://' + apiBase + '.myworkdayjobs.com/wday/cxs/' + apiBase.split('.')[0] + '/' + slug + '/jobs',
  apple:      'https://jobs.apple.com/api/v1/search',
  eightfold:  'https://' + apiBase + '/api/apply/v2/jobs?domain=' + encodeURIComponent(slug) + '&start=0&num=10',
  avature:    'https://' + slug + '.avature.net/' + (apiBase || 'careers') + '/SearchJobs?jobRecordsPerPage=1&jobOffset=0',
  google:     'https://www.google.com/about/careers/applications/jobs/results',
  deshaw:     'https://www.deshaw.com/careers',
  microsoft:  'https://jobs.careers.microsoft.com/global/en/search',
}[t]);
const out = [];
for (const it of items) {
  const c = it.json;
  if (IMPLEMENTED.indexOf(c.ats_type) === -1) continue;
  const u = mkUrl(c.ats_type, c.slug, c.api_base || '');
  if (!u) continue;
  out.push({ json: { company_id: c.company_id, board: c.board, ats_type: c.ats_type, slug: c.slug, api_base: c.api_base || '', url: u, etag: c.etag || '' } });
}
return out;
