/**
 * s2d_remoteok.js — S2d increment 1: RemoteOK structured lane (keyless, live).
 *
 * RemoteOK (https://remoteok.com/api) is the only no-key structured source
 * (USAJobs turned out to need a key -> gated group with Adzuna/JSearch/Apify).
 * It returns real structured fields (position/company/location/salary/url/date),
 * unfiltered, so the normalizer filters by role client-side.
 *
 * Adds: RemoteOK Fetch (HTTP, graceful) -> Normalize RemoteOK -> Merge Sources
 * (expanded 3->4 inputs); canonical job gains salary_min/max/currency; the digest
 * shows salary; Build Scorer Input carries salary for the future comp sub-score.
 * Every input still fires (alwaysOutputData) so the merge never hangs.
 *
 * Run: node scripts/s2d_remoteok.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const NORMALIZE_CODE = `// Normalize RemoteOK -> canonical job objects (+salary). RemoteOK returns ALL
// recent remote jobs unfiltered, so filter by role_families client-side.
const intent = $('Parse Expand Query').first().json || {};
const roles = (intent.role_families || []).map(r => String(r).toLowerCase());
let raw = $input.all().map(i => i.json);
if (raw.length === 1 && Array.isArray(raw[0])) raw = raw[0];
if (raw.length === 1 && raw[0] && Array.isArray(raw[0].data)) raw = raw[0].data;
const entries = raw.filter(j => j && j.position && (j.id || j.slug));
function relevant(hay) {
  if (!roles.length) return true;
  return roles.some(r => r.split(/\\s+/).filter(w => w.length > 2).every(w => hay.includes(w)));
}
const jobs = [];
for (const j of entries) {
  const title = String(j.position || '');
  const hay = (title + ' ' + (j.tags || []).join(' ') + ' ' + String(j.description || '')).toLowerCase();
  if (!relevant(hay)) continue;
  jobs.push({
    job_id: 'remoteok-' + (j.id || j.slug),
    title,
    company: j.company || '',
    location: (j.location && String(j.location).trim()) ? j.location : 'Remote',
    department: '',
    url: j.url || j.apply_url || '',
    description_snippet: String(j.description || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().substring(0, 500),
    salary_min: j.salary_min || null,
    salary_max: j.salary_max || null,
    salary_currency: 'USD',
    updated_at: j.date || '',
    source: 'remoteok',
    source_tier: 2,
    tier_label: 'curated:remoteok'
  });
}
return [{ json: { jobs, source: 'remoteok', count: jobs.length } }];`;

const SALARY_HELPER =
  "function salaryStr(job) { const lo = job.salary_min, hi = job.salary_max; if (!lo && !hi) return ''; const f = n => n >= 1000 ? ('$' + Math.round(n/1000) + 'k') : ('$' + n); return (lo && hi) ? (f(lo) + '–' + f(hi)) : (f(lo || hi) + '+'); }\n";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  for (const req of ['Pre-flight: Providers', 'Merge Sources', 'Build Telegraph Body', 'Build Scorer Input']) {
    if (!N[req]) { console.log(`SKIP (${base}: no "${req}")`); return; }
  }

  // 1) nodes
  if (!N['RemoteOK Fetch']) {
    wf.nodes.push({
      parameters: {
        url: 'https://remoteok.com/api', sendHeaders: true,
        headerParameters: { parameters: [{ name: 'User-Agent', value: 'CareerForge/1.0 (job search)' }] },
        options: { timeout: 15000 },
      },
      id: crypto.randomUUID(), name: 'RemoteOK Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [30240, 47840], onError: 'continueRegularOutput', alwaysOutputData: true,
    });
  }
  if (!N['Normalize RemoteOK']) {
    wf.nodes.push({
      parameters: { jsCode: NORMALIZE_CODE },
      id: crypto.randomUUID(), name: 'Normalize RemoteOK', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [30520, 47840], onError: 'continueRegularOutput', alwaysOutputData: true,
    });
  }

  // 2) connections
  const C = wf.connections;
  C['Pre-flight: Providers'] = C['Pre-flight: Providers'] || { main: [[]] };
  if (!C['Pre-flight: Providers'].main[0].some(e => e.node === 'RemoteOK Fetch'))
    C['Pre-flight: Providers'].main[0].push({ node: 'RemoteOK Fetch', type: 'main', index: 0 });
  C['RemoteOK Fetch'] = { main: [[{ node: 'Normalize RemoteOK', type: 'main', index: 0 }]] };
  C['Normalize RemoteOK'] = { main: [[{ node: 'Merge Sources', type: 'main', index: 3 }]] };

  // 3) Merge Sources 3 -> 4 inputs
  if ((N['Merge Sources'].parameters.numberInputs || 2) < 4) N['Merge Sources'].parameters.numberInputs = 4;

  // 4) Build Scorer Input — carry salary
  const bsi = N['Build Scorer Input'];
  if (!bsi.parameters.jsCode.includes('salary_min: j.salary_min')) {
    bsi.parameters.jsCode = bsi.parameters.jsCode.replace(
      'yoe_compat_score: j.yoe_compat_score ?? null\n}));',
      'yoe_compat_score: j.yoe_compat_score ?? null,\n  salary_min: j.salary_min ?? null, salary_max: j.salary_max ?? null, salary_currency: j.salary_currency || null\n}));');
  }

  // 5) Build Telegraph Body — show salary in metadata
  // NOTE: use split/join, NOT .replace — the replacement contains "$'" (from '$'+...),
  // which .replace would interpret as the special "substring-after-match" pattern.
  const btb = N['Build Telegraph Body'];
  if (!btb.parameters.jsCode.includes('function salaryStr')) {
    btb.parameters.jsCode = btb.parameters.jsCode
      .split('function scoreEmoji(s) {').join(SALARY_HELPER + 'function scoreEmoji(s) {');
    btb.parameters.jsCode = btb.parameters.jsCode
      .split("const metaParts = [clean(job.company) || 'Unknown', displayLocation(job), score + '/10'];")
      .join("const metaParts = [clean(job.company) || 'Unknown', displayLocation(job)];\n  { const _sal = salaryStr(job); if (_sal) metaParts.push('💰 ' + _sal); }\n  metaParts.push(score + '/10');");
  }

  // integrity
  const names = new Set(wf.nodes.map(n => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL: dangling ${src}`); process.exit(1); }
    (obj.main || []).forEach(a => (a || []).forEach(e => { if (!names.has(e.node)) { console.error(`INTEGRITY FAIL: -> ${e.node}`); process.exit(1); } }));
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: RemoteOK lane added (${wf.nodes.length} nodes, Merge Sources=${N['Merge Sources'].parameters.numberInputs} inputs)`);
}

TARGETS.forEach(patch);
console.log('S2d (RemoteOK) patch complete.');
