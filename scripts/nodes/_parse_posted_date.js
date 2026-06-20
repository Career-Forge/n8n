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
