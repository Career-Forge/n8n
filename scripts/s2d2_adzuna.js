/**
 * s2d2_adzuna.js — S2d increment 2: Adzuna structured lane (the India + salary win).
 *
 * Adzuna returns real structured jobs (location + salary) for 19 countries incl.
 * India. Keys (app_id, app_key) are read from Postgres app_settings (rows
 * 'adzuna_app_id' / 'adzuna_app_key') via a shared "Load Structured Config" PG
 * node — so the same node will serve future keyed providers (JSearch/Apify/USAJobs).
 * If the keys are absent/empty the call fails -> onError -> Normalize returns []
 * (graceful, nothing breaks).
 *
 * Adds: Load Structured Config (PG) + Adzuna Fetch (HTTP) + Normalize Adzuna
 *  -> Merge Sources (expanded 4->5). Country from Parse Expand Query.country.
 *
 * Run AFTER s2d_remoteok.js.  node scripts/s2d2_adzuna.js
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
const PG_CRED = { postgres: { id: '5pQq6UUmmGU7e04S', name: 'CareerForge Postgres' } };

// Plain TEXT columns (one row) — avoids any jsonb object/string ambiguity in expressions.
const CONFIG_SQL =
  "SELECT (SELECT value FROM app_settings WHERE key='adzuna_app_id')  AS adzuna_app_id, " +
  "(SELECT value FROM app_settings WHERE key='adzuna_app_key') AS adzuna_app_key, " +
  "(SELECT value FROM app_settings WHERE key='usajobs_key')    AS usajobs_key, " +
  "(SELECT value FROM app_settings WHERE key='jsearch_key')    AS jsearch_key, " +
  "(SELECT value FROM app_settings WHERE key='apify_token')    AS apify_token";

const NORMALIZE_CODE = `// Normalize Adzuna -> canonical jobs (+ real salary in the country's currency).
const intent = $('Parse Expand Query').first().json || {};
const _cc = (intent.country || '').toLowerCase();   // P0.6: unknown/missing country -> null, no silent USD
const ccy = { in:'INR', us:'USD', gb:'GBP', au:'AUD', ca:'CAD', de:'EUR', fr:'EUR', nl:'EUR', sg:'SGD', za:'ZAR', br:'BRL', mx:'MXN', it:'EUR', es:'EUR', pl:'PLN', at:'EUR', ch:'CHF', nz:'NZD', be:'EUR' }[_cc] || null;
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
    description_snippet: String(r.description || '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim().substring(0, 500),
    salary_min: r.salary_min || null,
    salary_max: r.salary_max || null,
    salary_currency: ccy,
    salary_predicted: (r.salary_is_predicted === '1' || r.salary_is_predicted === 1 || r.salary_is_predicted === true),
    updated_at: r.created || '',
    source: 'adzuna',
    source_tier: 1.5,
    tier_label: 'api:adzuna'
  });
}
return [{ json: { jobs, source: 'adzuna', count: jobs.length } }];`;

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  if (!N['Pre-flight: Providers'] || !N['Merge Sources']) { console.log(`SKIP ${base}: prereqs missing`); return; }

  if (!N['Load Structured Config']) {
    wf.nodes.push({
      parameters: { operation: 'executeQuery', query: CONFIG_SQL, options: {} },
      id: crypto.randomUUID(), name: 'Load Structured Config', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
      position: [30240, 48160], credentials: PG_CRED, onError: 'continueRegularOutput', alwaysOutputData: true,
    });
  }
  if (!N['Adzuna Fetch']) {
    wf.nodes.push({
      parameters: {
        url: "=https://api.adzuna.com/v1/api/jobs/{{ String($('Parse Expand Query').first().json.country).toLowerCase() }}/search/1",
        sendQuery: true,
        queryParameters: { parameters: [
          { name: 'app_id', value: "={{ $('Load Structured Config').first().json.adzuna_app_id || '' }}" },
          { name: 'app_key', value: "={{ $('Load Structured Config').first().json.adzuna_app_key || '' }}" },
          { name: 'what', value: "={{ ($('Parse Expand Query').first().json.role_families || ['engineer'])[0] }}" },
          { name: 'where', value: "={{ ($('Parse Expand Query').first().json.location_canonical || '').split(',')[0] }}" },
          { name: 'results_per_page', value: '20' },
          { name: 'content-type', value: 'application/json' },
        ] },
        options: { timeout: 15000 },
      },
      id: crypto.randomUUID(), name: 'Adzuna Fetch', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      position: [30520, 48160], onError: 'continueRegularOutput', alwaysOutputData: true,
    });
  }
  if (!N['Normalize Adzuna']) {
    wf.nodes.push({
      parameters: { jsCode: NORMALIZE_CODE },
      id: crypto.randomUUID(), name: 'Normalize Adzuna', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [30800, 48160], onError: 'continueRegularOutput', alwaysOutputData: true,
    });
  }

  const C = wf.connections;
  if (!C['Pre-flight: Providers'].main[0].some(e => e.node === 'Load Structured Config'))
    C['Pre-flight: Providers'].main[0].push({ node: 'Load Structured Config', type: 'main', index: 0 });
  C['Load Structured Config'] = { main: [[{ node: 'Adzuna Fetch', type: 'main', index: 0 }]] };
  C['Adzuna Fetch'] = { main: [[{ node: 'Normalize Adzuna', type: 'main', index: 0 }]] };
  C['Normalize Adzuna'] = { main: [[{ node: 'Merge Sources', type: 'main', index: 4 }]] };

  if ((N['Merge Sources'].parameters.numberInputs || 2) < 5) N['Merge Sources'].parameters.numberInputs = 5;

  const names = new Set(wf.nodes.map(n => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    (obj.main || []).forEach(a => (a || []).forEach(e => { if (!names.has(e.node)) { console.error(`INTEGRITY FAIL -> ${e.node}`); process.exit(1); } }));
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Adzuna lane added (${wf.nodes.length} nodes, Merge=${N['Merge Sources'].parameters.numberInputs})`);
}

TARGETS.forEach(patch);
console.log('S2d2 (Adzuna) patch prepped. Set adzuna_app_id/adzuna_app_key in app_settings before deploy.');
