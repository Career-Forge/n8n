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

// Normalize Adzuna -> canonical jobs (+ real salary in the country's currency).
const intent = $('Parse Expand Query').first().json || {};
const ccy = { in:'INR', us:'USD', gb:'GBP', au:'AUD', ca:'CAD', de:'EUR', fr:'EUR', nl:'EUR', sg:'SGD', za:'ZAR', br:'BRL', mx:'MXN', it:'EUR', es:'EUR', pl:'PLN', at:'EUR', ch:'CHF', nz:'NZD', be:'EUR' }[(intent.country||'us').toLowerCase()] || 'USD';
let raw = $input.all().map(i => i.json);
let results = [];
for (const r of raw) {
  if (r && Array.isArray(r.results)) results = results.concat(r.results);
  else if (r && r.id && r.title) results.push(r);
}
const jobs = [];
for (const r of results) {
  if (!r) continue;
  const loc = (r.location && (r.location.display_name || (Array.isArray(r.location.area) ? r.location.area.join(', ') : ''))) || '';
  jobs.push({
    job_id: 'adzuna-' + (r.id || jobs.length),
    title: r.title || '',
    company: (r.company && r.company.display_name) || '',
    location: loc,
    department: (r.category && r.category.label) || '',
    url: r.redirect_url || '',
    description_snippet: String(r.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500),
    salary_min: r.salary_min || null,
    salary_max: r.salary_max || null,
    salary_currency: ccy,
    salary_predicted: (r.salary_is_predicted === '1' || r.salary_is_predicted === 1 || r.salary_is_predicted === true),
    updated_at: parsePostedDate(r.created || ''),
    source: 'adzuna',
    source_tier: 1.5,
    tier_label: 'api:adzuna'
  });
}
return [{ json: { jobs, source: 'adzuna', count: jobs.length } }];