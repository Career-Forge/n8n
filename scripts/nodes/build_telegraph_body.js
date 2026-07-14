// Auto-generated from the live workflow node "Build Telegraph Body" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Build Telegraph Body v5 — Phase 4.1 cache-first two-stage scoring: appendix of
// cache/search-ranked (not LLM-scored) candidates beyond the top-30 that actually
// got sent to JobScorer, now that Aggregate Jobs surfaces up to 150 candidates
// instead of 50. Without this, widening the candidate pool would just mean the
// other ~120 are silently discarded -- the whole point of a wider net is moot if
// nothing downstream can see past the scored cutoff.
//
// Also fixes a real badge collision found while touching this: F2's "location
// unverified" marker and this node's own pre-existing tier-3-aggregator glyph both
// used 🌐 for unrelated meanings -- a job could show BOTH in the same digest entry
// (one prefixing the title, one suffixing the location string), meaning two
// different things with the same icon. F2's marker moves to 🔎; tier-3's 🌐 is
// untouched. tierGlyph also now distinguishes cache-sourced tier-1 (🔓, verified as
// of the poller's last check) from freshly-probed ATS-direct tier-1 (✅, verified
// live just now) -- these aren't the same guarantee and shouldn't share a badge.
const sd = $getWorkflowStaticData('global');
const scored = $('Parse Scorer Output').first().json.scored || [];
// S31: read the POST-verification list (Experience Filter = after liveness check
// + S30 location correction + experience filter), not Aggregate Jobs -- reading
// the pre-verification list resurrected every removed job in the appendix.
const aggregateOut = $('Experience Filter').first().json;
const allJobs = aggregateOut.jobs || [];
const intent = sd.last_search_intent || {};

const jobMap = {};
for (const j of allJobs) jobMap[j.job_id] = j;

function salaryStr(job) { const lo = job.salary_min, hi = job.salary_max; if (!lo && !hi) return ''; const sym = {USD:'$',INR:'₹',GBP:'£',EUR:'€',AUD:'A$',CAD:'C$',SGD:'S$',CHF:'CHF ',NZD:'NZ$',ZAR:'R',BRL:'R$',MXN:'MX$',PLN:'zł '}[job.salary_currency] || (job.salary_currency ? job.salary_currency + ' ' : '$'); const lakh = job.salary_currency === 'INR'; const f = lakh ? (n => { const v = n/100000; return (v % 1 ? v.toFixed(1) : v) + 'L'; }) : (n => n >= 1000 ? (Math.round(n/1000) + 'k') : ('' + n)); return sym + ((lo && hi) ? (f(lo) + '–' + f(hi)) : (f(lo || hi) + '+')); }
function scoreEmoji(s) { return s >= 70 ? '🟢' : s >= 55 ? '🟡' : '⚪'; }
function tierGlyph(t, source) { return t === 1 ? (source === 'cache' ? '🔓' : '✅') : t === 1.5 ? '💰' : t === 2 ? '🌿' : t === 2.5 ? '🏢' : t === 3 ? '🌐' : ''; }
function clean(slug) { return (slug || '').replace(/-/g,' ').replace(/\b\w/g, l => l.toUpperCase()); }
function displayLocation(job) {
  const loc = (job.location || '').trim();
  const locOk = loc && !/^(unknown|n\/?a|null|undefined)$/i.test(loc);
  const dl = (job.detected_location || '').trim();
  const dlOk = dl && !/^(unknown|n\/?a|null|undefined)$/i.test(dl);
  let base;
  // s57: an ATS-verified location (Verify Job Links' backfill) beats the
  // LLM's snippet-derived guess -- only fall back to detected_location when
  // this job's location was never deterministically verified.
  if (job.location_verified === true && locOk) base = loc;
  else if (dlOk) base = dl;
  else if (locOk) base = loc;
  else {
    const hay = ((job.title || '') + ' ' + (job.description_snippet || '')).toLowerCase();
    base = (intent.remote_preference === 'remote_only' || hay.includes('remote')) ? 'Remote' : 'Location not specified';
  }
  // F2: location filtering was active for this search but this job's location
  // couldn't be verified (Aggregate Jobs' 'unknown' branch) -- badge it rather
  // than blend it in with confirmed matches. 🔎 (not 🌐 -- see header comment).
  return job.location_verified === null ? base + ' 🔎' : base;
}

const rankedJobs = scored
  .map(s => ({ ...(jobMap[s.job_id] || {}), fit_score: s.fit_score, one_liner: s.one_liner, detected_location: s.detected_location, location_match: s.location_match, score100: s.score100, sub_scores: s.sub_scores, bottleneck: s.bottleneck, bin: s.bin }))
  .filter(j => j && j.url)
  .filter(j => !(j.location_match === 'mismatch' && j.location_verified !== true && intent.location_canonical && intent.remote_preference !== 'remote_only'))
  .sort((a, b) => {
    if (intent.sort_by === 'newest') {
      return (new Date(b.updated_at || 0).getTime() || 0) - (new Date(a.updated_at || 0).getTime() || 0);
    }
    const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);
    if (tierDiff !== 0) return tierDiff;
    const scoreDiff = (b.score100 || 0) - (a.score100 || 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (new Date(b.updated_at || 0).getTime() || 0) - (new Date(a.updated_at || 0).getTime() || 0);
  })
  .slice(0, 40);

// Phase 4.1 (source corrected in S31): everything that survived verification and
// filtering (up to 150) but did NOT make the
// cut into the LLM-scored batch (capped at 30 in Build Scorer Input) -- ranked by
// the cache's own relevance score where available (rrf_score, from bge-m3 cosine +
// tsvector RRF), falling back to tier/recency for jobs with no cache score at all.
const scoredIds = new Set(scored.map((s) => s.job_id));
const appendixJobs = allJobs
  .filter((j) => j && j.url && !scoredIds.has(j.job_id))
  .sort((a, b) => {
    const rrfDiff = (b.rrf_score || 0) - (a.rrf_score || 0);
    if (rrfDiff !== 0) return rrfDiff;
    const tierDiff = (a.source_tier || 99) - (b.source_tier || 99);
    if (tierDiff !== 0) return tierDiff;
    return (new Date(b.updated_at || 0).getTime() || 0) - (new Date(a.updated_at || 0).getTime() || 0);
  })
  .slice(0, 100);

const badges = [];
if (intent.location_canonical) badges.push('📍 ' + String(intent.location_canonical).split(',')[0]);
if (intent.salary_signals?.length) badges.push('💰 ' + intent.salary_signals[0]);
if (intent.visa_signals?.length) badges.push('🛂 ' + intent.visa_signals[0]);
if (intent.industry_signals?.length) badges.push('🏭 ' + intent.industry_signals[0]);
if (intent.seniority && intent.seniority !== 'any') badges.push('📊 ' + intent.seniority);
if (intent.remote_preference === 'remote_only') badges.push('🌍 Remote only');

const searchContext = (intent.role_families?.slice(0,3).join(', ') || 'Jobs')
  + (badges.length ? ' · ' + badges.join(' · ') : '')
  + ' · ' + rankedJobs.length + ' results';

const finalTierCounts = { 1: 0, '1.5': 0, 2: 0, '2.5': 0, 3: 0 };
for (const j of rankedJobs) {
  const t = j.source_tier;
  if (t === 1) finalTierCounts[1]++;
  else if (t === 1.5) finalTierCounts['1.5']++;
  else if (t === 2) finalTierCounts[2]++;
  else if (t === 2.5) finalTierCounts['2.5']++;
  else if (t === 3) finalTierCounts[3]++;
}
const tierBadgeParts = [];
if (finalTierCounts[1])     tierBadgeParts.push('✅ ' + finalTierCounts[1] + ' ATS');
if (finalTierCounts['1.5']) tierBadgeParts.push('💰 ' + finalTierCounts['1.5'] + ' Structured');
if (finalTierCounts[2])     tierBadgeParts.push('🌿 ' + finalTierCounts[2] + ' Curated');
if (finalTierCounts['2.5']) tierBadgeParts.push('🏢 ' + finalTierCounts['2.5'] + ' Career');
if (finalTierCounts[3])     tierBadgeParts.push('🌐 ' + finalTierCounts[3] + ' Aggregator');
const _vjl = (() => { try { return $('Verify Job Links').first().json || {}; } catch (e) { return {}; } })();
if ((_vjl.dead_removed || 0) > 0) tierBadgeParts.push('✂ ' + _vjl.dead_removed + ' expired removed');
const tierBadgeLine = tierBadgeParts.length ? ('Sources: ' + tierBadgeParts.join(' · ')) : '';

const contentNodes = [
  { tag: 'p', children: [{ tag: 'i', children: [searchContext] }] },
];
if (tierBadgeLine) contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: [tierBadgeLine] }] });
contentNodes.push({ tag: 'p', children: ['Reply with a number in Telegram to generate a tailored resume + cover letter.'] });
contentNodes.push({ tag: 'hr' });

const providers = new Set();
for (const j of rankedJobs) if (j.source) providers.add(j.source);
if (providers.size > 0) {
  const labels = { firecrawl: '🔥 Firecrawl', youcom: '🔍 You.com', serper: '⚡ Serper', cache: '🔓 Local cache' };
  contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: ['Powered by: ' + [...providers].map(p => labels[p] || p).join(' · ')] }] });
  contentNodes.push({ tag: 'hr' });
}

for (const [i, job] of rankedJobs.entries()) {
  const score = (job.score100 != null) ? job.score100 : (job.fit_score || 0) * 10;
  const tg = tierGlyph(job.source_tier, job.source);
  const _pd = job.updated_at ? new Date(job.updated_at) : null;
  const posted = (_pd && !isNaN(_pd.getTime())) ? _pd.toLocaleDateString('en-US', {month:'short',day:'numeric'}) : '';
  contentNodes.push({ tag: 'h4', children: [(i + 1) + '. ' + scoreEmoji(score) + (tg ? ' ' + tg : '') + ' ', { tag: 'a', attrs: { href: job.url }, children: [job.title || 'Unknown Role'] }] });
  const metaParts = [clean(job.company) || 'Unknown', displayLocation(job)];
  { const _sal = salaryStr(job); if (_sal) metaParts.push('💰 ' + _sal); }
  metaParts.push(score + '/100');
  if (posted) metaParts.push(posted);
  contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: [metaParts.join(' · ')] }] });
  if (job.one_liner) contentNodes.push({ tag: 'blockquote', children: [job.one_liner] });
  if (job.sub_scores) { const ss = job.sub_scores; contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: ['Skills ' + ss.skills + ' · Exp ' + ss.experience + ' · Visa ' + ss.workauth + ' · Loc ' + ss.location + ' · Comp ' + ss.compensation + (job.bottleneck ? ' — weakest: ' + job.bottleneck : '')] }] }); }
}

if (appendixJobs.length) {
  contentNodes.push({ tag: 'hr' });
  contentNodes.push({ tag: 'p', children: [{ tag: 'b', children: ['📋 ' + appendixJobs.length + ' more matches'] }] });
  contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: ['Ranked by search relevance only — the AI scorer only reviews the top 30 in depth. Treat these as a match ESTIMATE, not a verified fit.'] }] });
  for (const [i, job] of appendixJobs.entries()) {
    const tg = tierGlyph(job.source_tier, job.source);
    contentNodes.push({ tag: 'h4', children: [(rankedJobs.length + i + 1) + '. ' + (tg ? tg + ' ' : ''), { tag: 'a', attrs: { href: job.url }, children: [job.title || 'Unknown Role'] }] });
    const metaParts = [clean(job.company) || 'Unknown', displayLocation(job)];
    { const _sal = salaryStr(job); if (_sal) metaParts.push('💰 ' + _sal); }
    contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: [metaParts.join(' · ')] }] });
  }
}

const top3 = rankedJobs.slice(0, 3);
const _degraded = (($('Parse Scorer Output').first().json || {}).strategy === 'neutral_fallback');
let top3Msg = '🎯 *Found ' + rankedJobs.length + ' roles*' + (appendixJobs.length ? ' _(+' + appendixJobs.length + ' more in the full list)_' : '') + '\n';
if (_degraded) top3Msg += '⚠️ _Scoring degraded — showing by source quality_\n';
if (((intent.ambiguity_flags) || []).indexOf('F1_OPT_REMOTE_LOCATION') !== -1) top3Msg += (intent._f1_note || '🛂 F-1 OPT: remote work must be performed inside the US.') + '\n';
  if (badges.length) top3Msg += badges.join(' · ') + '\n';
if (tierBadgeLine) top3Msg += '_' + tierBadgeLine + '_\n';
top3Msg += '\n';
for (const [i, job] of top3.entries()) {
  const titleClean = (job.title || 'Unknown').replace(/[\[\]]/g, '');
  const tg = tierGlyph(job.source_tier, job.source);
  top3Msg += '*' + (i+1) + '.* ' + (tg ? tg + ' ' : '') + '[' + titleClean + '](' + job.url + ')\n';
  top3Msg += '    🏢 ' + clean(job.company) + ' · 📍 ' + displayLocation(job) + '\n';
  top3Msg += '    📊 ' + ((job.score100 != null) ? job.score100 : (job.fit_score || 0) * 10) + '/100 — ' + (job.one_liner || '') + '\n\n';
}
if (!top3.length) top3Msg += '_No direct job pages survived filtering. Try broadening the query._\n\n';

const _lt = $('Load Telegraph Token').first();
const token = (_lt && _lt.json && _lt.json.value) || sd.telegraph_token || '';
const pageTitle = 'CareerForge — ' + rankedJobs.length + ' Jobs · ' + new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'});

return [{ json: {
  access_token: token,
  title: pageTitle,
  author_name: 'CareerForge',
  content: JSON.stringify(contentNodes),
  return_content: 'false',
  top3_msg: top3Msg,
  total_jobs: rankedJobs.length,
  appendix_count: appendixJobs.length,
  badges,
  rankedJobs,
  has_token: Boolean(token)
} }];
