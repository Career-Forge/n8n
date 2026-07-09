/**
 * s2c2_location_truth.js — make location honest + requested-location-aware.
 *
 * Problems:
 *  - Scorer judged "location match" against the candidate's PROFILE (NJ/NYC), not
 *    the REQUESTED search location, so India-ranking was incidental.
 *  - Web-search jobs have empty location; the digest fell back to stamping the
 *    SEARCH location ("India") on them -> US jobs mislabeled India.
 *
 * Fix (additive):
 *  1) Build Scorer Input: pass requested_location/remote/country to the scorer.
 *  2) JobScorer prompt: judge location vs requested_location; return
 *     detected_location + location_match (match|mismatch|unknown); cap mismatches.
 *  3) Scorer Output Parser schema + Parse Scorer Output validate(): carry the
 *     two new fields through.
 *  4) Build Telegraph Body: displayLocation shows detected_location -> real
 *     location -> "Location not specified" (NEVER the search location); drop
 *     confident mismatches for location-specific non-remote queries; warn on
 *     degraded scoring.
 *
 * (Model swap gpt-5.4-mini -> deepseek-v4-flash deferred to S9 model config.)
 * Run: node scripts/s2c2_location_truth.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const LOCATION_BLOCK =
  "\n\n## Location Matching (IMPORTANT)\n" +
  "You are also given the user's REQUESTED search location in `requested_location` (plus `requested_remote`, `requested_country`). For EACH job ALSO return:\n" +
  "- `detected_location`: the job's actual location inferred from its title/location/description_snippet (e.g. \"Bengaluru, India\", \"Remote (US)\"), or null if genuinely not stated.\n" +
  "- `location_match`: \"match\" if the job is in / serves requested_location (or requested_remote is remote and the job is remote); \"mismatch\" if it clearly is NOT (e.g. requested India but the job is US-only on-site); \"unknown\" if you cannot tell.\n" +
  "Judge location against requested_location, NOT the candidate's home location. When location_match is \"mismatch\" for a location-specific, non-remote request, cap fit_score at 3.\n" +
  "Output item shape: { \"job_id\": \"...\", \"fit_score\": N, \"one_liner\": \"...\", \"detected_location\": \"...\"|null, \"location_match\": \"match|mismatch|unknown\" }";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);
  let edits = 0, warns = 0;
  const rep = (obj, key, find, replacement, label) => {
    if (obj[key].includes(replacement.slice(0, 40)) && !obj[key].includes(find)) { return; } // already applied
    if (!obj[key].includes(find)) { console.log(`  WARN ${base}: anchor not found for ${label}`); warns++; return; }
    obj[key] = obj[key].replace(find, replacement); edits++;
  };

  // 1) Build Scorer Input — pass requested location
  const bsi = N['Build Scorer Input'];
  if (bsi && !bsi.parameters.jsCode.includes('requested_location')) {
    rep(bsi.parameters, 'jsCode',
      'return [{ json: {\n  master_resume_summary: resumeSummary,',
      "let _eq = {}; try { _eq = $('Parse Expand Query').first().json || {}; } catch(_) {}\nreturn [{ json: {\n  master_resume_summary: resumeSummary,",
      'BSI _eq');
    rep(bsi.parameters, 'jsCode',
      '  jobs: jobBatch\n} }];',
      "  requested_location: _eq.location_canonical || null,\n  requested_remote: _eq.remote_preference || null,\n  requested_country: _eq.country || null,\n  jobs: jobBatch\n} }];",
      'BSI fields');
  }

  // 2) JobScorer prompt — append location block
  const js = N['JobScorer'];
  if (js) {
    const mv = js.parameters.messages.messageValues[0];
    if (!mv.message.includes('location_match')) { mv.message = mv.message + LOCATION_BLOCK; edits++; }
  }

  // 3) Scorer Output Parser schema — add fields
  const sop = N['Scorer Output Parser'];
  if (sop && !sop.parameters.inputSchema.includes('location_match')) {
    rep(sop.parameters, 'inputSchema',
      '"yoe_compatibility": {"type": ["integer", "number", "null"]}}',
      '"yoe_compatibility": {"type": ["integer", "number", "null"]}, "detected_location": {"type": ["string", "null"]}, "location_match": {"type": "string"}}',
      'parser schema');
  }

  // 4) Parse Scorer Output validate() — carry fields
  const pso = N['Parse Scorer Output'];
  if (pso && !pso.parameters.jsCode.includes('location_match')) {
    rep(pso.parameters, 'jsCode',
      'yoe_compatibility: s.yoe_compatibility ?? null\n  }));',
      "yoe_compatibility: s.yoe_compatibility ?? null,\n    detected_location: (s.detected_location != null ? String(s.detected_location).substring(0, 80) : null),\n    location_match: (['match','mismatch','unknown'].indexOf(s.location_match) !== -1 ? s.location_match : 'unknown')\n  }));",
      'PSO validate');
  }

  // 5) Build Telegraph Body — honest location + drop mismatches + degraded banner
  const btb = N['Build Telegraph Body'];
  if (btb && !btb.parameters.jsCode.includes('detected_location')) {
    const c = 'jsCode';
    rep(btb.parameters, c,
      '.map(s => ({ ...(jobMap[s.job_id] || {}), fit_score: s.fit_score, one_liner: s.one_liner }))',
      '.map(s => ({ ...(jobMap[s.job_id] || {}), fit_score: s.fit_score, one_liner: s.one_liner, detected_location: s.detected_location, location_match: s.location_match }))',
      'BTB map');
    rep(btb.parameters, c,
      '  .filter(j => j && j.url)\n',
      "  .filter(j => j && j.url)\n  .filter(j => !(j.location_match === 'mismatch' && intent.location_canonical && intent.remote_preference !== 'remote_only'))\n",
      'BTB mismatch filter');
    rep(btb.parameters, c,
      "function displayLocation(job) {\n  const loc = (job.location || '').trim();\n  if (loc && !/^(unknown|n\\/?a|null|undefined)$/i.test(loc)) return loc;\n  const hay = ((job.title || '') + ' ' + (job.description_snippet || '')).toLowerCase();\n  if (intent.remote_preference === 'remote_only' || hay.includes('remote')) return 'Remote';\n  if (intent.location_canonical) return String(intent.location_canonical).split(',').slice(0, 2).join(', ');\n  return 'N/A';\n}",
      "function displayLocation(job) {\n  const dl = (job.detected_location || '').trim();\n  if (dl && !/^(unknown|n\\/?a|null|undefined)$/i.test(dl)) return dl;\n  const loc = (job.location || '').trim();\n  if (loc && !/^(unknown|n\\/?a|null|undefined)$/i.test(loc)) return loc;\n  const hay = ((job.title || '') + ' ' + (job.description_snippet || '')).toLowerCase();\n  if (intent.remote_preference === 'remote_only' || hay.includes('remote')) return 'Remote';\n  return 'Location not specified';\n}",
      'BTB displayLocation');
    rep(btb.parameters, c,
      "let top3Msg = '🎯 *Found ' + rankedJobs.length + ' roles*\\n';",
      "const _degraded = (($('Parse Scorer Output').first().json || {}).strategy === 'neutral_fallback');\nlet top3Msg = '🎯 *Found ' + rankedJobs.length + ' roles*\\n';\nif (_degraded) top3Msg += '⚠️ _Scoring degraded — showing by source quality_\\n';",
      'BTB degraded banner');
  }

  // integrity: connections still resolve
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL: dangling ${src} in ${file}`); process.exit(1); }
  }
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S2c2 applied (${edits} edits, ${warns} warns)`);
}

TARGETS.forEach(patch);
console.log('S2c2 patch complete.');
