// Build Telegraph Body v4 — tier-aware ordering, token gate, location fallback.
const sd = $getWorkflowStaticData('global');
const scored = $('Parse Scorer Output').first().json.scored || [];
const aggregateOut = $('Aggregate Jobs').first().json;
const allJobs = aggregateOut.jobs || [];
const intent = sd.last_search_intent || {};

const jobMap = {};
for (const j of allJobs) jobMap[j.job_id] = j;

function salaryStr(job) { const lo = job.salary_min, hi = job.salary_max; if (!lo && !hi) return ''; const sym = {USD:'$',INR:'₹',GBP:'£',EUR:'€',AUD:'A$',CAD:'C$',SGD:'S$',CHF:'CHF ',NZD:'NZ$',ZAR:'R',BRL:'R$',MXN:'MX$',PLN:'zł '}[job.salary_currency] || (job.salary_currency ? job.salary_currency + ' ' : '$'); const lakh = job.salary_currency === 'INR'; const f = lakh ? (n => { const v = n/100000; return (v % 1 ? v.toFixed(1) : v) + 'L'; }) : (n => n >= 1000 ? (Math.round(n/1000) + 'k') : ('' + n)); return sym + ((lo && hi) ? (f(lo) + '–' + f(hi)) : (f(lo || hi) + '+')); }
function scoreEmoji(s) { return s >= 70 ? '🟢' : s >= 55 ? '🟡' : '⚪'; }
function tierGlyph(t)  { return t === 1 ? '✅' : t === 2 ? '🌿' : t === 2.5 ? '🏢' : t === 3 ? '🌐' : ''; }
function clean(slug) { return (slug || '').replace(/-/g,' ').replace(/\b\w/g, l => l.toUpperCase()); }
// Company-name hardening: kill "Https://Visa" — strip any leaked scheme/URL,
// derive a clean brand from the apply URL when the company field is junk, and
// brand-case known names. Never returns a string containing "://".
const _BRAND = { crowdstrike:'CrowdStrike', github:'GitHub', gitlab:'GitLab', openai:'OpenAI', paypal:'PayPal', youtube:'YouTube', tiktok:'TikTok', visa:'Visa', ibm:'IBM', sap:'SAP', nvidia:'NVIDIA', amd:'AMD', aws:'AWS', hsbc:'HSBC', jpmorgan:'JPMorgan', linkedin:'LinkedIn', deepmind:'DeepMind', servicenow:'ServiceNow', mongodb:'MongoDB', databricks:'Databricks' };
const _NOISE = new Set(['www','jobs','job','boards','board','careers','career','apply','talent','work','workday','hire','hiring','recruiting','greenhouse','lever','ashbyhq','ashby','myworkdayjobs','workable','smartrecruiters','icims','taleo','bamboohr','jobvite','eightfold','us','en']);
const _TLD = new Set(['com','io','ai','co','org','net','gov','edu','us','uk','ca','in','de','fr','jp','au','sg','eu','app','dev','xyz','tech']);
function _titleCase(s){ return String(s||'').replace(/[-_]+/g,' ').replace(/\s+/g,' ').trim().replace(/\b\w/g, l => l.toUpperCase()); }
function _brandLabel(x){ return x ? (_BRAND[String(x).toLowerCase()] || _titleCase(x)) : ''; }
function _brandFromUrl(raw){
  const u = String(raw || '').trim(); let m;
  // ATS hosts carry the company in the PATH, not the host
  if ((m = u.match(/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([^\/?&#]+)/i))) return _brandLabel(m[1]);
  if ((m = u.match(/jobs\.lever\.co\/([^\/?#]+)/i))) return _brandLabel(m[1]);
  if ((m = u.match(/jobs\.ashbyhq\.com\/([^\/?#]+)/i))) return _brandLabel(m[1]);
  if ((m = u.match(/([^.\/]+)\.wd\d+\.myworkdayjobs\.com/i))) return _brandLabel(m[1]);
  if ((m = u.match(/apply\.workable\.com\/([^\/?#]+)/i))) return _brandLabel(m[1]);
  if ((m = u.match(/jobs\.smartrecruiters\.com\/([^\/?#]+)/i))) return _brandLabel(m[1]);
  // else derive a brand label from the host
  let s = u.toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'');
  const host = s.split(/[\/?#]/)[0];
  if (!host) return '';
  const labels = host.split('.').filter(l => l && !_TLD.has(l) && !/^wd\d+$/.test(l));
  const pick = labels.find(l => !_NOISE.has(l)) || labels[0] || '';
  return _brandLabel(pick);
}
function cleanCompany(job){
  let c = ((job && job.company) || '').trim();
  const looksUrl = /:\/\//.test(c) || /^www\./i.test(c) || (/\.[a-z]{2,}(\/|$)/i.test(c) && !/\s/.test(c));
  if (!c || /^(unknown|n\/?a|null|undefined)$/i.test(c) || looksUrl) {
    return _brandFromUrl(looksUrl ? c : ((job && job.url) || '')) || (looksUrl ? '' : _titleCase(c)) || 'Unknown';
  }
  return _BRAND[c.toLowerCase()] || _titleCase(c);
}
function displayLocation(job) {
  const dl = (job.detected_location || '').trim();
  if (dl && !/^(unknown|n\/?a|null|undefined)$/i.test(dl)) return dl;
  const loc = (job.location || '').trim();
  if (loc && !/^(unknown|n\/?a|null|undefined)$/i.test(loc)) return loc;
  const hay = ((job.title || '') + ' ' + (job.description_snippet || '')).toLowerCase();
  if (intent.remote_preference === 'remote_only' || hay.includes('remote')) return 'Remote';
  return 'Location not specified';
}

// "Latest + relevant on top": rank by match% + a small freshness boost, but keep
// VALIDATED (live/unverified) jobs above not_checked ones so freshness can't lift
// a possibly-dead job over a verified one (belt-and-suspenders to the matcher's
// 2-pass, which already validates the post-rerank top-N). Freshness from posted_at.
function freshBoost(d) { const t = new Date(d || 0).getTime() || 0; if (!t) return 0; const days = (Date.now() - t) / 86400000; if (days < 2) return 6; if (days < 7) return 3; if (days < 30) return 1; return 0; }
function vrank(v) { return v === 'live' ? 0 : v === 'unverified' ? 1 : 2; }
// desirability tier (S/A/B/C/D) — strong sort booster, not a hard sort: a great
// match at an A-tier still beats a weak match at an S-tier; body-shops (D) sink.
function desirGlyph(t){ return t === 'S' ? '🏆' : t === 'A' ? '⭐' : t === 'D' ? '⚠️' : ''; }
function desirBonus(t){ return t === 'S' ? 12 : t === 'A' ? 6 : t === 'B' ? 2 : t === 'D' ? -40 : 0; }
function desirLabel(t){ return t === 'S' ? '🏆 S-tier' : t === 'A' ? '⭐ A-tier' : ''; }
let rankedJobs = scored
  .map(s => ({ ...(jobMap[s.job_id] || {}), match_pct: s.match_pct, score100: s.score100, fit_score: s.fit_score, one_liner: s.one_liner, matched_skills: s.matched_skills || [], missing_skills: s.missing_skills || [], adjacent_skills: s.adjacent_skills || [], validated: s.validated, bin: s.bin }))
  .filter(j => j && j.url)
  .sort((a, b) => {
    const va = vrank(a.validated), vb = vrank(b.validated);
    if (va !== vb) return va - vb;
    const fa = a.posted_at || a.updated_at, fb = b.posted_at || b.updated_at;
    const ka = (a.match_pct || 0) + freshBoost(fa) + desirBonus(a.tier);
    const kb = (b.match_pct || 0) + freshBoost(fb) + desirBonus(b.tier);
    if (kb !== ka) return kb - ka;
    return (new Date(fb || 0).getTime() || 0) - (new Date(fa || 0).getTime() || 0);
  })
  .slice(0, 40);

// Only surface jobs we actually liveness-checked: 'live' / 'unverified' (Firecrawl)
// or trusted real-time ATS (matcher marks those 'live'). Drop the unvalidated
// 'not_checked' tail so stale listings (esp. Workday) don't reach the user.
// Fallback: if validation thinned it below 6, keep the full list rather than
// show an almost-empty page.
const _validated = rankedJobs.filter(j => j.validated === 'live' || j.validated === 'unverified');
if (_validated.length >= 6) rankedJobs = _validated;

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

const finalTierCounts = { 1: 0, 2: 0, '2.5': 0, 3: 0 };
for (const j of rankedJobs) {
  const t = j.source_tier;
  if (t === 1) finalTierCounts[1]++;
  else if (t === 2) finalTierCounts[2]++;
  else if (t === 2.5) finalTierCounts['2.5']++;
  else if (t === 3) finalTierCounts[3]++;
}
const tierBadgeParts = [];
if (finalTierCounts[1])     tierBadgeParts.push('✅ ' + finalTierCounts[1] + ' ATS');
if (finalTierCounts[2])     tierBadgeParts.push('🌿 ' + finalTierCounts[2] + ' Curated');
if (finalTierCounts['2.5']) tierBadgeParts.push('🏢 ' + finalTierCounts['2.5'] + ' Career');
if (finalTierCounts[3])     tierBadgeParts.push('🌐 ' + finalTierCounts[3] + ' Aggregator');
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
  const labels = { firecrawl: '🔥 Firecrawl', youcom: '🔍 You.com', serper: '⚡ Serper' };
  contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: ['Powered by: ' + [...providers].map(p => labels[p] || p).join(' · ')] }] });
  contentNodes.push({ tag: 'hr' });
}

function matchEmoji(p) { return p >= 70 ? '🟢' : p >= 55 ? '🟡' : '⚪'; }
function vBadge(v) { return v === 'live' ? '✓ verified' : (v === 'unverified' ? '~ unverified' : ''); }
function skillLine(job) {
  const bits = [];
  if ((job.matched_skills || []).length) bits.push('✅ ' + job.matched_skills.slice(0, 6).join(', '));
  if ((job.adjacent_skills || []).length) bits.push('➕ ' + job.adjacent_skills.slice(0, 3).join(', '));
  if ((job.missing_skills || []).length) bits.push('❌ ' + job.missing_skills.slice(0, 4).join(', '));
  return bits.join('  ·  ');
}
for (const [i, job] of rankedJobs.entries()) {
  const mp = job.match_pct != null ? job.match_pct : (job.score100 || 0);
  const dtg = desirGlyph(job.tier);
  const _pd = job.updated_at ? new Date(job.updated_at) : null;
  const posted = (_pd && !isNaN(_pd)) ? _pd.toLocaleDateString('en-US', {month:'short',day:'numeric'}) : '';
  contentNodes.push({ tag: 'h4', children: [(i + 1) + '. ' + matchEmoji(mp) + ' ' + mp + '% ' + (dtg ? dtg + ' ' : '') + '— ', { tag: 'a', attrs: { href: job.url }, children: [job.title || 'Unknown Role'] }] });
  const metaParts = [cleanCompany(job)];
  { const _dl = desirLabel(job.tier); if (_dl) metaParts.push(_dl); }
  metaParts.push(displayLocation(job));
  { const _sal = salaryStr(job); if (_sal) metaParts.push('💰 ' + _sal); }
  if (posted) metaParts.push('🗓 ' + posted);
  { const vb = vBadge(job.validated); if (vb) metaParts.push(vb); }
  contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: [metaParts.join(' · ')] }] });
  const sl = skillLine(job);
  if (sl) contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: [sl] }] });
}

const top3 = rankedJobs.slice(0, 3);
const _pso = $('Parse Scorer Output').first().json || {};
const _degraded = (_pso.strategy !== 'matcher') || (_pso.total === 0 && rankedJobs.length === 0);
const _dropN = (_pso.dropped || []).length;
let top3Msg = '🎯 *Found ' + rankedJobs.length + ' roles*\n';
if (_degraded) top3Msg += '⚠️ _Matcher unavailable — showing by source quality_\n';
if (_dropN) top3Msg += '🗑 _Dropped ' + _dropN + ' dead/closed listing' + (_dropN > 1 ? 's' : '') + '_\n';
if (((intent.ambiguity_flags) || []).indexOf('F1_OPT_REMOTE_LOCATION') !== -1) top3Msg += (intent._f1_note || '🛂 F-1 OPT: remote work must be performed inside the US.') + '\n';
if (((intent.ambiguity_flags) || []).indexOf('INTERN_CLARIFY') !== -1) top3Msg += (intent._intern_note || "🎓 _Hiding intern/trainee roles -- add 'intern' to your search to include them._") + '\n';
if (((intent.ambiguity_flags) || []).indexOf('LOCATION_CLARIFY') !== -1) top3Msg += (intent._location_note || '📍 _Interpreted an ambiguous location code -- reply with the full place name if needed._') + '\n';
  if (badges.length) top3Msg += badges.join(' · ') + '\n';
if (tierBadgeLine) top3Msg += '_' + tierBadgeLine + '_\n';
top3Msg += '\n';
for (const [i, job] of top3.entries()) {
  const titleClean = (job.title || 'Unknown').replace(/[\[\]]/g, '');
  const mp = job.match_pct != null ? job.match_pct : (job.score100 || 0);
  const vb = vBadge(job.validated);
  const _dl = desirLabel(job.tier);
  top3Msg += '*' + (i+1) + '.* ' + matchEmoji(mp) + ' *' + mp + '% match* — [' + titleClean + '](' + job.url + ')\n';
  top3Msg += '    🏢 ' + cleanCompany(job) + (_dl ? ' · ' + _dl : '') + ' · 📍 ' + displayLocation(job) + (vb ? ' · ' + vb : '') + '\n';
  const sk = [];
  if ((job.matched_skills || []).length) sk.push('✅ ' + job.matched_skills.slice(0, 4).join(', '));
  if ((job.missing_skills || []).length) sk.push('❌ ' + job.missing_skills.slice(0, 2).join(', '));
  if (sk.length) top3Msg += '    ' + sk.join('  ·  ') + '\n';
  top3Msg += '\n';
}
if (!top3.length) top3Msg += '_No live job pages survived matching. Try broadening the query._\n\n';

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
  badges,
  rankedJobs,
  has_token: Boolean(token)
} }];
