/**
 * s18_registry_growth.js -- registry self-growth: every search permanently widens the
 * crawler's coverage. Splices a side-branch off Aggregate Jobs (parallel to Verify Job
 * Links, doesn't touch the main find flow) that extracts company/slug from any Tier-1
 * ATS job the web lanes surfaced, and upserts it into the poller's `companies` table.
 *
 * Conservative by design: ON CONFLICT DO NOTHING (never reactivates a company the user
 * deliberately turned off, unlike the Registry Seeder's DO UPDATE ... is_active=TRUE),
 * onError continueRegularOutput + alwaysOutputData (a DB hiccup here must never affect
 * the find/digest flow -- this branch's output is consumed by nothing else).
 *
 * Extraction mirrors the ATS patterns already classified upstream by classifyUrlTier
 * (Normalize Serper/You.com/Firecrawl results) via each job's tier_label.
 *
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

const EXTRACT_CODE = String.raw`// Extract Registry Candidates -- scans this find's Tier-1 ATS jobs and emits one
// item per unique (ats_type, slug) so Upsert Discovered Companies can grow the
// poller's registry. Never blocks the main flow (side branch off Aggregate Jobs).
function extractCandidate(job) {
  const url = job.url || '';
  const label = job.tier_label || '';
  const name = String(job.company || '').trim();
  if (!name) return null;
  let m;
  if (label === 'ats:greenhouse' && (m = url.match(/(?:boards|job-boards)\.greenhouse\.io\/([^\/?#]+)/i))) {
    return { name, ats_type: 'greenhouse', slug: m[1], api_base: '' };
  }
  if (label === 'ats:lever' && (m = url.match(/jobs\.lever\.co\/([^\/?#]+)/i))) {
    return { name, ats_type: 'lever', slug: m[1], api_base: '' };
  }
  if (label === 'ats:ashby' && (m = url.match(/jobs\.ashbyhq\.com\/([^\/?#]+)/i))) {
    let slug; try { slug = decodeURIComponent(m[1]); } catch (e) { slug = m[1]; }
    return { name, ats_type: 'ashby', slug, api_base: '' };
  }
  if (label === 'ats:workday' && (m = url.match(/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^\/?#]+)/i))) {
    return { name, ats_type: 'workday', slug: m[3], api_base: m[1] + '.' + m[2] };
  }
  if (label === 'ats:smartrecruiters' && (m = url.match(/jobs\.smartrecruiters\.com\/([^\/?#]+)/i))) {
    return { name, ats_type: 'smartrecruiters', slug: m[1], api_base: '' };
  }
  if (label === 'ats:workable' && (m = url.match(/apply\.workable\.com\/([^\/?#]+)/i))) {
    return { name, ats_type: 'workable', slug: m[1], api_base: '' };
  }
  return null;
}

const agg = $input.first().json || {};
const jobs = Array.isArray(agg.jobs) ? agg.jobs : [];
const seen = new Set();
const out = [];
for (const job of jobs) {
  if (job.source_tier !== 1) continue;
  const c = extractCandidate(job);
  if (!c) continue;
  const key = c.ats_type + '|' + c.slug.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({ json: c });
}
return out;`;

// ── harness: prove per-type extraction, dedup, tier filter, ashby url-decode, workday parse ──
(function harness() {
  const run = (jobs) => new Function('$input', EXTRACT_CODE)({ first: () => ({ json: { jobs } }) });
  const out = run([
    { source_tier: 1, tier_label: 'ats:greenhouse', company: 'GitLab', url: 'https://job-boards.greenhouse.io/gitlab/jobs/123' },
    { source_tier: 1, tier_label: 'ats:lever', company: 'Spotify', url: 'https://jobs.lever.co/spotify/abc-def' },
    { source_tier: 1, tier_label: 'ats:ashby', company: 'Wisdom AI', url: 'https://jobs.ashbyhq.com/Wisdom%20AI/33333333-3333-3333-3333-333333333333' },
    { source_tier: 1, tier_label: 'ats:workday', company: 'Fractal', url: 'https://fractal.wd1.myworkdayjobs.com/en-US/Careers/job/Bengaluru/Slug_SR-1' },
    { source_tier: 1, tier_label: 'ats:workday', company: 'Fractal', url: 'https://fractal.wd1.myworkdayjobs.com/en-US/Careers/job/Other-City/Slug2_SR-2' }, // dup company/site -> collapses
    { source_tier: 3, tier_label: 'aggregator:linkedin', company: 'SomeCo', url: 'https://linkedin.com/jobs/view/999' }, // not tier 1 -> skipped
    { source_tier: 1, tier_label: 'ats:greenhouse', company: '', url: 'https://job-boards.greenhouse.io/noname/jobs/1' }, // no company name -> skipped
  ]);
  const byType = {}; out.forEach((o) => { byType[o.json.ats_type] = byType[o.json.ats_type] || []; byType[o.json.ats_type].push(o.json); });
  if (out.length !== 4) { console.error('HARNESS FAIL: expected 4 candidates (dedup + filters), got', out.length, JSON.stringify(out)); process.exit(1); }
  if (!byType.greenhouse || byType.greenhouse[0].slug !== 'gitlab') { console.error('HARNESS FAIL: greenhouse extraction wrong'); process.exit(1); }
  if (!byType.lever || byType.lever[0].slug !== 'spotify') { console.error('HARNESS FAIL: lever extraction wrong'); process.exit(1); }
  if (!byType.ashby || byType.ashby[0].slug !== 'Wisdom AI') { console.error('HARNESS FAIL: ashby URL-decode wrong:', JSON.stringify(byType.ashby)); process.exit(1); }
  if (!byType.workday || byType.workday.length !== 1 || byType.workday[0].slug !== 'Careers' || byType.workday[0].api_base !== 'fractal.wd1') {
    console.error('HARNESS FAIL: workday extraction/dedup wrong:', JSON.stringify(byType.workday)); process.exit(1);
  }
  console.log('HARNESS OK: per-ATS extraction (greenhouse/lever/ashby/workday), ashby URL-decode, workday tenant.wdN parsing, tier-1 filter, empty-name filter, in-batch dedup -- all verified');
})();

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Aggregate Jobs']) { console.error(`INTEGRITY FAIL ${base}: Aggregate Jobs not found`); process.exit(1); }
  const pgCredNode = N['Load Telegraph Token'];
  if (!pgCredNode) { console.error(`INTEGRITY FAIL ${base}: Load Telegraph Token (credential source) not found`); process.exit(1); }
  const pgCred = pgCredNode.credentials.postgres;

  if (N['Extract Registry Candidates']) { console.log(`  ${base}: already patched`); return; }

  wf.nodes.push({
    parameters: { jsCode: EXTRACT_CODE },
    id: crypto.randomUUID(), name: 'Extract Registry Candidates', type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [(N['Aggregate Jobs'].position || [0, 0])[0] + 200, (N['Aggregate Jobs'].position || [0, 0])[1] + 300],
    onError: 'continueRegularOutput', alwaysOutputData: true,
  });
  wf.nodes.push({
    parameters: {
      operation: 'executeQuery',
      query: "INSERT INTO companies (name, ats_type, slug, api_base, next_poll_at)\nVALUES ($1, $2, $3, NULLIF($4, '')::text, now())\nON CONFLICT (ats_type, slug) DO NOTHING",
      options: { queryReplacement: '={{ [$json.name, $json.ats_type, $json.slug, $json.api_base || \'\'] }}' },
    },
    id: crypto.randomUUID(), name: 'Upsert Discovered Companies', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
    position: [(N['Aggregate Jobs'].position || [0, 0])[0] + 460, (N['Aggregate Jobs'].position || [0, 0])[1] + 300],
    credentials: { postgres: { id: pgCred.id, name: pgCred.name } },
    onError: 'continueRegularOutput', alwaysOutputData: true,
  });

  const C = wf.connections;
  if (!C['Aggregate Jobs'].main[0].some((e) => e.node === 'Extract Registry Candidates')) {
    C['Aggregate Jobs'].main[0].push({ node: 'Extract Registry Candidates', type: 'main', index: 0 });
  }
  C['Extract Registry Candidates'] = { main: [[{ node: 'Upsert Discovered Companies', type: 'main', index: 0 }]] };

  // integrity: every edge resolves
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(C)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source ${src} missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: registry self-growth wired -- ${wf.nodes.length} nodes`);
}

TARGETS.forEach(patch);
console.log('S18 (registry self-growth) complete.');
