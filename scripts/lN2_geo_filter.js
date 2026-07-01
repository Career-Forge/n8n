/**
 * lN2_geo_filter.js — L2 (demand side): geo-aware cache search + resolved-location filter.
 *
 * MAP-replaces (s14-style) the canonical node bodies that now carry the L2 (and S1)
 * changes, and patches the Hybrid Cache Search node's queryReplacement to pass the
 * three new params the SQL expects ($3 location_canonical, $4 country, $5 remote_pref):
 *   - Hybrid Cache Search (SQL): cf_resolve_location CTE, country/mode gate in the
 *     kNN + keyword lanes, soft proximity folded into rrf_score, geo cols selected.
 *   - Cache Prefilter: carry country_iso/workplace_type/allowed_countries/lat/lng.
 *   - Aggregate Jobs: LOC_SYN/LOC_COUNTRY deleted -> cache jobs trust the SQL gate,
 *     web-lane jobs string-match the requested place.
 *
 * Idempotent. Backups + integrity check. Run: node scripts/lN2_geo_filter.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODES = path.join(__dirname, 'nodes');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const MAP = {
  'Hybrid Cache Search': ['hybrid_cache_search.sql', 'query'],
  'Cache Prefilter': ['cache_prefilter.js', 'jsCode'],
  'Aggregate Jobs': ['aggregate_jobs.js', 'jsCode'],
};
const BODIES = {};
for (const [name, [file, field]] of Object.entries(MAP)) {
  const body = fs.readFileSync(path.join(NODES, file), 'utf8');
  if (field === 'jsCode') {
    try { new Function('$input', '$', '$json', '$getWorkflowStaticData', body); }
    catch (e) { console.error('PARSE FAIL ' + file + ': ' + e.message); process.exit(1); }
  }
  BODIES[name] = { body, field };
}

// New queryReplacement: append $3 location_canonical, $4 country, $5 remote_preference.
const QREPL =
  "={{ [ ($json.embeddings && $json.embeddings[0] && $json.embeddings[0].length===1024) ? ('[' + $json.embeddings[0].join(',') + ']') : null, " +
  "(($('Pre-flight: Providers').first().json.role_families)||[]).join(' '), " +
  "($('Parse Expand Query').first().json.location_canonical || null), " +
  "($('Parse Expand Query').first().json.country || null), " +
  "($('Parse Expand Query').first().json.remote_preference || 'open') ] }}";

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log('SKIP (missing): ' + file); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);

  const patched = [], missing = [];
  for (const [name, { body, field }] of Object.entries(BODIES)) {
    if (!N[name]) { missing.push(name); continue; }
    N[name].parameters = N[name].parameters || {};
    N[name].parameters[field] = body;
    patched.push(name);
  }

  // queryReplacement params for Hybrid Cache Search
  let qr = 'n/a';
  const hcs = N['Hybrid Cache Search'];
  if (hcs) {
    hcs.parameters.options = hcs.parameters.options || {};
    hcs.parameters.options.queryReplacement = QREPL;
    qr = 'set ($3/$4/$5)';
  }

  // integrity: every connection target still exists
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections || {})) {
    if (!names.has(src)) { console.error('INTEGRITY FAIL: source missing ' + src); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((br) => (br || []).forEach((e) => {
        if (!names.has(e.node)) { console.error('INTEGRITY FAIL ' + src + ' -> ' + e.node); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file + '.s1bak-' + stamp(), fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log('OK ' + base + ': nodes [' + patched.join(', ') + '] queryReplacement ' + qr + (missing.length ? ' MISSING: ' + missing.join(', ') : ''));
}

TARGETS.forEach(patch);
console.log('L2 patch complete.');
