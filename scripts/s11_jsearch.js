/**
 * s11_jsearch.js -- WS1: JSearch structured lane (Google-for-Jobs coverage).
 *
 * JSearch rides Google's job index (schema.org JobPosting markup), which is how
 * custom career sites (Microsoft/Meta/Netflix/...) become reachable without
 * per-company scrapers. Key read from app_settings ('jsearch_key') via the
 * existing "Load Structured Config" PG node (column already SELECTed since S2d).
 * Missing key -> 401/403 -> onError continueRegularOutput -> Normalize emits []
 * (same graceful pattern as the Adzuna lane).
 *
 * NOTE: endpoint is /search-v2 (the /search path from the original S2d plan was
 * retired by the provider); response nests under data.jobs[]. Verified live.
 *
 * Adds: JSearch Fetch (HTTP) + Normalize JSearch -> Merge Sources (5 -> 6 inputs).
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
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

const NORMALIZE_CODE = `// Normalize JSearch (/search-v2) -> canonical jobs. Prefers direct employer apply links.
let raw = $input.all().map(i => i.json);
let results = [];
for (const r of raw) {
  if (!r) continue;
  if (r.data && Array.isArray(r.data.jobs)) results = results.concat(r.data.jobs);
  else if (Array.isArray(r.data)) results = results.concat(r.data);
  else if (r.job_id && r.job_title) results.push(r);
}
const jobs = [];
for (const r of results) {
  if (!r || !r.job_title) continue;
  let url = r.job_apply_link || '';
  if (Array.isArray(r.apply_options)) {
    const direct = r.apply_options.find(o => o && o.is_direct && o.apply_link);
    if (direct) url = direct.apply_link;
  }
  if (!url) continue;
  jobs.push({
    job_id: 'jsearch-' + (r.job_id || jobs.length),
    title: r.job_title || '',
    company: r.employer_name || '',
    location: [r.job_city, r.job_state, r.job_country].filter(Boolean).join(', '),
    department: '',
    url,
    description_snippet: String(r.job_description || '').replace(/\\s+/g, ' ').trim().substring(0, 500),
    salary_min: r.job_min_salary || null,
    salary_max: r.job_max_salary || null,
    salary_currency: r.job_salary_currency || null,
    updated_at: r.job_posted_at_datetime_utc || '',
    source: 'jsearch',
    source_tier: 2,
    tier_label: 'api:jsearch'
  });
}
return [{ json: { jobs, source: 'jsearch', count: jobs.length } }];`;

// ── harness: run the normalizer against a real /search-v2 response shape ──
(function harness() {
  const sample = {
    status: 'OK',
    data: { jobs: [
      { job_id: 'abc==', job_title: 'ML Engineer', employer_name: 'Eaton', job_publisher: 'LinkedIn',
        job_apply_link: 'https://in.linkedin.com/jobs/view/1', job_apply_is_direct: false,
        apply_options: [
          { apply_link: 'https://in.linkedin.com/jobs/view/1', is_direct: false, publisher: 'LinkedIn' },
          { apply_link: 'https://careers.eaton.com/job/1', is_direct: true, publisher: 'Eaton' },
        ],
        job_description: 'Build   ML\npipelines at scale.', job_city: 'Pune', job_state: 'MH', job_country: 'IN',
        job_posted_at_datetime_utc: '2026-06-30T00:00:00Z', job_min_salary: null, job_max_salary: null },
      { job_id: 'nourl', job_title: 'Ghost Role', employer_name: 'X' },
    ] },
  };
  const mock$input = { all: () => [{ json: sample }] };
  const out = new Function('$input', '$', NORMALIZE_CODE)(mock$input, () => { throw new Error('unused'); });
  const j = out[0].json;
  if (j.count !== 1 || j.jobs[0].url !== 'https://careers.eaton.com/job/1' || j.jobs[0].company !== 'Eaton'
      || j.jobs[0].location !== 'Pune, MH, IN' || j.jobs[0].tier_label !== 'api:jsearch'
      || j.jobs[0].description_snippet !== 'Build ML pipelines at scale.') {
    console.error('HARNESS FAIL:', JSON.stringify(j, null, 1)); process.exit(1);
  }
  console.log('HARNESS OK: Normalize JSearch verified (direct-link preference, url-less drop, whitespace)');
})();

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  if (!N['Load Structured Config'] || !N['Merge Sources']) { console.error(`INTEGRITY FAIL ${base}: prereqs missing`); process.exit(1); }

  if (!N['JSearch Fetch']) {
    wf.nodes.push({
      parameters: {
        url: 'https://jsearch.p.rapidapi.com/search-v2',
        sendQuery: true,
        queryParameters: { parameters: [
          { name: 'query', value: "={{ (($('Parse Expand Query').first().json.role_families || ['engineer'])[0]) + ' in ' + (($('Parse Expand Query').first().json.location_canonical || '').split(',')[0] || $('Parse Expand Query').first().json.country || 'US') }}" },
          { name: 'num_pages', value: '1' },
          { name: 'country', value: "={{ ($('Parse Expand Query').first().json.country || 'us').toLowerCase() }}" },
          { name: 'date_posted', value: 'week' },
        ] },
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'X-RapidAPI-Key', value: "={{ $('Load Structured Config').first().json.jsearch_key || '' }}" },
          { name: 'X-RapidAPI-Host', value: 'jsearch.p.rapidapi.com' },
        ] },
        options: { timeout: 15000 },
      },
      id: crypto.randomUUID(), name: 'JSearch Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [30520, 48360], onError: 'continueRegularOutput', alwaysOutputData: true,
    });
  }
  if (!N['Normalize JSearch']) {
    wf.nodes.push({
      parameters: { jsCode: NORMALIZE_CODE },
      id: crypto.randomUUID(), name: 'Normalize JSearch', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [30800, 48360], onError: 'continueRegularOutput', alwaysOutputData: true,
    });
  }

  const C = wf.connections;
  // Load Structured Config currently feeds only Adzuna Fetch -- add JSearch Fetch in parallel.
  if (!C['Load Structured Config'].main[0].some((e) => e.node === 'JSearch Fetch'))
    C['Load Structured Config'].main[0].push({ node: 'JSearch Fetch', type: 'main', index: 0 });
  C['JSearch Fetch'] = { main: [[{ node: 'Normalize JSearch', type: 'main', index: 0 }]] };
  C['Normalize JSearch'] = { main: [[{ node: 'Merge Sources', type: 'main', index: 5 }]] };

  if ((N['Merge Sources'].parameters.numberInputs || 2) < 6) N['Merge Sources'].parameters.numberInputs = 6;

  // integrity: every edge resolves
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source ${src} missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: JSearch lane added -- ${wf.nodes.length} nodes, Merge inputs ${N['Merge Sources'].parameters.numberInputs}`);
}

TARGETS.forEach(patch);
console.log('S11 (JSearch) complete.');
