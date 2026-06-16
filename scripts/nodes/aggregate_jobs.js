// Aggregate Jobs v9 — composite-key dedup (S2d) + tier-aware ordering
// Changes vs v8:
//   - Dedup by canonical apply-URL OR lowercased company+title, so the SAME job
//     surfaced by different sources (RemoteOK url vs Adzuna url vs web) collapses to one.
//   - On a collision, KEEP the lower source_tier (structured/ATS preferred over web),
//     and backfill salary + location onto the kept job from the dropped duplicate.
//   - (v8 carried over) tier-aware sort, Tier 3+ dropped, tier_counts for display.

const sourceCounts = {};
const byKey = new Map(); // dedup key -> kept job (a job may be reachable by several keys)

function dedupKeys(job) {
  const ks = [];
  if (job.url) ks.push('u:' + job.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase());
  const ct = ((job.company || '') + '|' + (job.title || '')).toLowerCase().replace(/\s+/g, ' ').trim();
  if (ct.replace(/\|/g, '').length > 4) ks.push('ct:' + ct);
  return ks;
}

for (const item of $input.all()) {
  const jobs = item.json.jobs || [];
  const source = item.json.source || 'unknown';
  sourceCounts[source] = (sourceCounts[source] || 0) + jobs.length;
  for (const job of jobs) {
    if (!job || !job.url) continue;
    const ks = dedupKeys(job);
    let existing = null;
    for (const k of ks) { if (byKey.has(k)) { existing = byKey.get(k); break; } }
    if (!existing) { for (const k of ks) byKey.set(k, job); continue; }
    // collision: keep lower tier; backfill salary/location from the dropped dup
    const curTier = existing.source_tier || 99;
    const newTier = job.source_tier || 99;
    const keep = newTier < curTier ? job : existing;
    const drop = newTier < curTier ? existing : job;
    if (!keep.salary_min && drop.salary_min) { keep.salary_min = drop.salary_min; keep.salary_max = drop.salary_max; keep.salary_currency = drop.salary_currency; }
    if ((!keep.location || keep.location === 'unknown') && drop.location && drop.location !== 'unknown') keep.location = drop.location;
    for (const k of dedupKeys(existing)) byKey.set(k, keep);
    for (const k of ks) byKey.set(k, keep);
  }
}

const allJobs = Array.from(new Set(byKey.values()));

const expandCtx = $('Parse Expand Query').first().json;
const roleFamilies    = expandCtx.role_families    || [];
const excludedRoles   = expandCtx.excluded_roles   || [];
const locationCanon   = (expandCtx.location_canonical || '').trim().toLowerCase();
const remotePref      = expandCtx.remote_preference  || 'open';
const freshness       = expandCtx.freshness          || 'qdr:w';

const freshnessMs = { 'qdr:h': 3600000, 'qdr:d': 86400000, 'qdr:w': 604800000, 'qdr:m': 2592000000, 'qdr:y': 31536000000 }[freshness] || 604800000;
const cutoff = Date.now() - freshnessMs;

let filtered = allJobs;

// Drop Tier 3 aggregators and Tier 4 unknown pages from the main ranked results.
filtered = filtered.filter(j => (j.source_tier || 4) < 3);

// Role family filter
if (roleFamilies.length > 0) {
  filtered = filtered.filter(j => {
    const haystack = (j.title + ' ' + (j.department || '')).toLowerCase();
    if (excludedRoles.some(excl => {
      const terms = excl.toLowerCase().split(/\s+/);
      return terms.every(t => new RegExp('\\b' + t + '\\b').test(haystack));
    })) return false;
    return roleFamilies.some(variant => {
      const terms = variant.toLowerCase().split(/\s+/).filter(t => t.length > 1);
      return terms.every(term => term.length <= 3
        ? new RegExp('\\b' + term + '\\b').test(haystack)
        : haystack.includes(term));
    });
  });
}

// Location filter (hard, only when set and not remote_only)
if (remotePref !== 'remote_only' && locationCanon && !['any','anywhere','worldwide'].includes(locationCanon)) {
  const locTerms = locationCanon.split(/[\s,]+/).filter(t => t.length > 1);
  filtered = filtered.filter(j => {
    const src = (j.source || '').toLowerCase();
    if (src.includes('firecrawl') || src.includes('serper') || src.includes('youcom')) return true;
    const hay = (j.location || '').toLowerCase();
    if (!hay || hay === 'unknown') return true;
    return locTerms.some(t => hay.includes(t));
  });
}

// Recency filter (soft)
filtered = filtered.filter(j => {
  if (!j.updated_at) return true;
  const t = new Date(j.updated_at).getTime();
  return isNaN(t) || t >= cutoff;
});

// Sort: tier first (Tier 1 ATS at top), then recency within tier
filtered.sort((a, b) => {
  const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);
  if (tierDiff !== 0) return tierDiff;
  const ad = new Date(a.updated_at || 0).getTime() || 0;
  const bd = new Date(b.updated_at || 0).getTime() || 0;
  return bd - ad;
});

// Tier composition for downstream display
const tierCounts = { 1: 0, 2: 0, '2.5': 0, 3: 0 };
for (const j of filtered) {
  const t = j.source_tier;
  if (t === 1) tierCounts[1]++;
  else if (t === 2) tierCounts[2]++;
  else if (t === 2.5) tierCounts['2.5']++;
  else if (t === 3) tierCounts[3]++;
}

const top = filtered.slice(0, 50);
return [{ json: {
  jobs: top, count: top.length, total_raw: allJobs.length,
  sources: sourceCounts, tier_counts: tierCounts,
  filter_applied: { role_families: roleFamilies, location: locationCanon || null, remote_preference: remotePref }
} }];
