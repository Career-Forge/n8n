// parsePostedDate — shared across all job-normalize lanes (S12). Normalizes any
// source date field (ISO, epoch sec/ms, or a relative string like "3 days ago",
// "yesterday", "just posted") to an ISO timestamp, or '' if truly unknown. This
// kills the "Invalid Date" display bug and makes recency ranking/filtering real.
// Runs inside n8n Code nodes (new Date() is available at runtime).
function parsePostedDate(raw) {
  if (raw == null) return '';
  if (typeof raw === 'number') { const d = new Date(raw < 1e12 ? raw * 1000 : raw); return isNaN(d) ? '' : d.toISOString(); }
  let s = String(raw).trim();
  if (!s) return '';
  if (/^\d{10}$/.test(s)) { const d = new Date(parseInt(s, 10) * 1000); return isNaN(d) ? '' : d.toISOString(); }
  if (/^\d{13}$/.test(s)) { const d = new Date(parseInt(s, 10)); return isNaN(d) ? '' : d.toISOString(); }
  const low = s.toLowerCase();
  if (/just posted|just now|moments ago|posted today|^today\b|hours? ago|minutes? ago|min ago|seconds? ago/.test(low)) return new Date().toISOString();
  if (/yesterday/.test(low)) { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString(); }
  const m = low.match(/(\d+)\+?\s*(hour|day|week|month|year)s?\s*ago/);
  if (m) {
    const n = parseInt(m[1], 10); const d = new Date(); const u = m[2];
    if (u === 'hour') d.setHours(d.getHours() - n);
    else if (u === 'day') d.setDate(d.getDate() - n);
    else if (u === 'week') d.setDate(d.getDate() - 7 * n);
    else if (u === 'month') d.setMonth(d.getMonth() - n);
    else if (u === 'year') d.setFullYear(d.getFullYear() - n);
    return d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString();
}

// --- URL Tier Classifier ---------------------------------------------------
// Tiers: 1 = direct ATS, 2 = curated boards, 2.5 = unknown career page,
//        3 = general aggregator, 4 = unknown / probably not a job
function classifyUrlTier(url) {
  if (!url) return { tier: 4, label: 'invalid' };
  const u = url.toLowerCase();
  // TIER 1 — Direct ATS platforms
  if (/(?:boards|job-boards)\.greenhouse\.io/.test(u)) return { tier: 1, label: 'ats:greenhouse' };
  if (/jobs\.lever\.co/.test(u)) return { tier: 1, label: 'ats:lever' };
  if (/jobs\.ashbyhq\.com/.test(u)) return { tier: 1, label: 'ats:ashby' };
  if (/[\w-]+\.wd\d+\.myworkdayjobs\.com/.test(u)) return { tier: 1, label: 'ats:workday' };
  if (/apply\.workable\.com/.test(u)) return { tier: 1, label: 'ats:workable' };
  if (/jobs\.smartrecruiters\.com/.test(u)) return { tier: 1, label: 'ats:smartrecruiters' };
  if (/workatastartup\.com\/jobs\//.test(u)) return { tier: 1, label: 'ats:yc' };
  if (/[\w-]+\.recruitee\.com/.test(u)) return { tier: 1, label: 'ats:recruitee' };
  if (/[\w-]+\.personio\.(com|de)/.test(u)) return { tier: 1, label: 'ats:personio' };
  if (/[\w-]+\.bamboohr\.com/.test(u)) return { tier: 1, label: 'ats:bamboohr' };
  if (/[\w-]+\.jobvite\.com/.test(u)) return { tier: 1, label: 'ats:jobvite' };
  if (/careers-[\w-]+\.icims\.com/.test(u)) return { tier: 1, label: 'ats:icims' };
  if (/[\w-]+\.taleo\.net/.test(u)) return { tier: 1, label: 'ats:taleo' };
  if (/successfactors\.(com|eu)/.test(u)) return { tier: 1, label: 'ats:successfactors' };
  if (/[\w-]+\.eightfold\.ai/.test(u)) return { tier: 1, label: 'ats:eightfold' };
  // TIER 2 — Curated remote/aggregator boards
  if (/weworkremotely\.com\/(remote-jobs|listings)\//.test(u)) return { tier: 2, label: 'curated:wwr' };
  if (/remoteok\.(com|io)/.test(u)) return { tier: 2, label: 'curated:remoteok' };
  if (/himalayas\.app\/jobs\//.test(u)) return { tier: 2, label: 'curated:himalayas' };
  if (/remotive\.(com|io)\/(jobs|remote-jobs)\//.test(u)) return { tier: 2, label: 'curated:remotive' };
  if (/jobicy\.com/.test(u)) return { tier: 2, label: 'curated:jobicy' };
  if (/wellfound\.com\/jobs\//.test(u)) return { tier: 2, label: 'curated:wellfound' };
  if (/arbeitnow\.com\/jobs\//.test(u)) return { tier: 2, label: 'curated:arbeitnow' };
  if (/ai-jobs\.net\/job\//.test(u)) return { tier: 2, label: 'curated:aijobs' };
  if (/builtin(nyc|sf|la|chicago|seattle|boston|austin)?\.com\/job\//.test(u)) return { tier: 2, label: 'curated:builtin' };
  // TIER 3 — General web aggregators (often listings pages, low signal)
  if (/linkedin\.com/.test(u)) return { tier: 3, label: 'aggregator:linkedin' };
  if (/indeed\.com/.test(u)) return { tier: 3, label: 'aggregator:indeed' };
  if (/glassdoor\.com/.test(u)) return { tier: 3, label: 'aggregator:glassdoor' };
  if (/ziprecruiter\.com/.test(u)) return { tier: 3, label: 'aggregator:ziprecruiter' };
  if (/dice\.com/.test(u)) return { tier: 3, label: 'aggregator:dice' };
  if (/monster\.com/.test(u)) return { tier: 3, label: 'aggregator:monster' };
  if (/simplyhired\.com/.test(u)) return { tier: 3, label: 'aggregator:simplyhired' };
  if (/careerbuilder\.com/.test(u)) return { tier: 3, label: 'aggregator:careerbuilder' };
  if (/snagajob\.com/.test(u)) return { tier: 3, label: 'aggregator:snagajob' };
  if (/theladders\.com/.test(u)) return { tier: 3, label: 'aggregator:theladders' };
  if (/jora\.com/.test(u)) return { tier: 3, label: 'aggregator:jora' };
  if (/talent\.com/.test(u)) return { tier: 3, label: 'aggregator:talent' };
  if (/jobs2careers\.com/.test(u)) return { tier: 3, label: 'aggregator:jobs2careers' };
  // TIER 2.5 — Plausible career page on unrecognized domain
  if (/^https?:\/\/(careers|jobs|apply|hiring|talent|work|join)\.[\w-]+\.[\w.]+/.test(u)) {
    return { tier: 2.5, label: 'career:subdomain' };
  }
  if (/\/(careers|jobs|join-us|join_us|apply|positions|openings|opportunities|vacancies|hiring|work-with-us)\//.test(u)) {
    return { tier: 2.5, label: 'career:path' };
  }
  // TIER 4 — Anything else
  return { tier: 4, label: 'unknown' };
}

const hits = $input.all();
const allJobs = [];

for (const item of hits) {
  const results = item.json.organic || [];  // Serper-specific
  for (const r of results) {
    const url = r.link || '';              // Serper-specific
    if (!url) continue;
    let company = 'unknown', m;
    if ((m = url.match(/([^.]+)\.wd\d+\.myworkdayjobs\.com/))) company = m[1];
    else if ((m = url.match(/boards\.greenhouse\.io\/([^/?]+)/))) company = m[1];
    else if ((m = url.match(/jobs\.lever\.co\/([^/?]+)/))) company = m[1];
    else if ((m = url.match(/jobs\.ashbyhq\.com\/([^/?]+)/))) company = m[1];
    else if ((m = url.match(/apply\.workable\.com\/([^/?]+)/))) company = m[1];
    else if ((m = url.match(/jobs\.smartrecruiters\.com\/([^/?]+)/))) company = m[1];
    const __tier = classifyUrlTier(url);
    allJobs.push({
      job_id: `serper-${company}-${allJobs.length}`,  // serper prefix
      title: r.title || '',
      company,
      location: '',
      department: '',
      url,
      description_snippet: (r.snippet || '').substring(0, 500),  // Serper-specific
      updated_at: parsePostedDate(r.date || ''),                                    // Serper-specific
      source: 'serper',                                            // serper source
      source_tier: __tier.tier,
      tier_label: __tier.label
    });
  }
}

return [{ json: { jobs: allJobs, source: 'serper', count: allJobs.length } }];