/**
 * r5_cache_lane.js — R5: wire find_jobs to the local Postgres job cache.
 *
 * New cache lane (parallel to the live-provider lane), both converging at a
 * dedicated 2-input "Merge Cache" node feeding Aggregate Jobs:
 *
 *   Pre-flight: Providers ─┬─> IF: Providers? -> (live providers) -> Merge Sources ─┐
 *                          │                                                         ├─> Merge Cache -> Aggregate Jobs
 *                          └─> Embed Search Query -> Hybrid Cache Search             │
 *                                -> Cache Prefilter ──────────────────────────────────┘
 *
 *   Parse Scorer Output ─(also)-> Record Matches  (upsert cache-sourced matches)
 *
 * Cache jobs ride the EXISTING scoring funnel unchanged (Aggregate -> Experience
 * Filter -> Build Scorer Input -> JobScorer -> Score Gate -> Digest). Their
 * scorer job_id is "cache_<pgId>" so Record Matches can map back to jobs.id.
 *
 * Robustness: Hybrid Cache Search uses alwaysOutputData + onError continue so the
 * cache branch never stalls Merge Cache (always emits one item, even on empty/err).
 *
 * Patches both master copies. Run AFTER R4.  node scripts/r5_cache_lane.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
];
const PG_CRED = { postgres: { id: '5pQq6UUmmGU7e04S', name: 'CareerForge Postgres' } };

const HYBRID_SQL =
  "WITH q AS (SELECT $1::vector AS qvec, websearch_to_tsquery('english', COALESCE($2,'')) AS qtext), " +
  "vec AS (SELECT j.id, row_number() OVER (ORDER BY j.embedding <=> (SELECT qvec FROM q)) AS rnk " +
  "FROM jobs j WHERE j.status='active' AND j.embedding IS NOT NULL AND (SELECT qvec FROM q) IS NOT NULL " +
  "ORDER BY j.embedding <=> (SELECT qvec FROM q) LIMIT 50), " +
  "kw AS (SELECT j.id, row_number() OVER (ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC) AS rnk " +
  "FROM jobs j WHERE j.status='active' AND (SELECT qtext FROM q)::text <> '' AND j.jd_tsv @@ (SELECT qtext FROM q) " +
  "ORDER BY ts_rank(j.jd_tsv,(SELECT qtext FROM q)) DESC LIMIT 50), " +
  "fused AS (SELECT COALESCE(v.id,k.id) AS id, COALESCE(1.0/(60+v.rnk),0)+COALESCE(1.0/(60+k.rnk),0) AS score " +
  "FROM vec v FULL OUTER JOIN kw k ON v.id=k.id) " +
  "SELECT j.id AS job_id, j.title, c.name AS company, j.location, j.remote, j.apply_url, " +
  "left(j.jd_text,1200) AS jd_text, j.posted_at, f.score AS rrf_score " +
  "FROM fused f JOIN jobs j ON j.id=f.id JOIN companies c ON c.id=j.company_id " +
  "ORDER BY f.score DESC LIMIT 30";

const HYBRID_PARAMS =
  "={{ [ ($json.embeddings && $json.embeddings[0] && $json.embeddings[0].length===1024) ? ('[' + $json.embeddings[0].join(',') + ']') : null, " +
  "(($('Pre-flight: Providers').first().json.role_families)||[]).join(' ') ] }}";

const PREFILTER_CODE = [
  "const rows = $input.all().map(i => i.json).filter(r => r && r.job_id);",
  "const NEG = /(u\\.?s\\.?\\s*citizen(ship)?\\s*(required|only)|must\\s*be\\s*a\\s*(u\\.?s\\.?\\s*)?citizen|security\\s*clearance|active\\s*clearance|ts\\/sci|secret\\s*clearance|no\\s*sponsorship|not?\\s*(able|willing)\\s*to\\s*sponsor|unable\\s*to\\s*sponsor)/i;",
  "const seen = new Set();",
  "const jobs = [];",
  "for (const r of rows) {",
  "  const jd = String(r.jd_text || '');",
  "  if (NEG.test(jd)) continue;",
  "  const url = r.apply_url || '';",
  "  if (!url) continue;",
  "  const key = url.replace(/[?#].*$/,'').replace(/\\/+$/,'').toLowerCase();",
  "  if (seen.has(key)) continue;",
  "  seen.add(key);",
  "  jobs.push({ job_id: 'cache_' + r.job_id, title: r.title || '', company: r.company || '', location: r.location || '', remote: !!r.remote, url: url, updated_at: r.posted_at || null, source: 'cache', source_tier: 1, description_snippet: jd.slice(0,600), rrf_score: r.rrf_score || 0 });",
  "}",
  "return [{ json: { jobs: jobs, source: 'cache', count: jobs.length } }];",
].join('\n');

const RECORD_SQL =
  "INSERT INTO matches (user_id, job_id, score) " +
  "SELECT $1::bigint, (regexp_replace(s->>'job_id','^cache_',''))::bigint, ((s->>'fit_score')::real)/10.0 " +
  "FROM jsonb_array_elements($2::jsonb) s WHERE s->>'job_id' ~ '^cache_[0-9]+$' " +
  "ON CONFLICT (user_id, job_id) DO UPDATE SET score = EXCLUDED.score, created_at = now()";
const RECORD_PARAMS =
  "={{ [ $('Extract Input').first().json.chat_id, JSON.stringify($json.scored || []) ] }}";

for (const file of TARGETS) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });
  if (N['Merge Cache']) { console.log(`${file}: R5 already applied, skipping`); continue; }

  const preflight = N['Pre-flight: Providers'];
  const mergeSources = N['Merge Sources'];
  const aggregate = N['Aggregate Jobs'];
  const pso = N['Parse Scorer Output'];
  if (!preflight || !mergeSources || !aggregate || !pso) throw new Error(`anchor node missing in ${file}`);
  const [px, py] = preflight.position;
  const [ax, ay] = aggregate.position;

  const mk = (name, type, typeVersion, parameters, pos, extra = {}) =>
    ({ parameters, id: crypto.randomUUID(), name, type, typeVersion, position: pos, ...extra });

  // Cache lane nodes
  wf.nodes.push(mk('Embed Search Query', 'n8n-nodes-base.httpRequest', 4.4, {
    method: 'POST', url: 'http://ollama-service:11434/api/embed', sendBody: true, contentType: 'json',
    specifyBody: 'json',
    jsonBody: "={{ { \"model\": \"bge-m3\", \"input\": [ ((($json.role_families)||[]).join(', ')) || 'software engineer' ] } }}",
    options: { timeout: 60000, response: { response: { neverError: true } } },
  }, [px + 200, py + 420], { retryOnFail: true, maxTries: 2, waitBetweenTries: 1500, onError: 'continueRegularOutput' }));

  wf.nodes.push(mk('Hybrid Cache Search', 'n8n-nodes-base.postgres', 2.6, {
    operation: 'executeQuery', query: HYBRID_SQL, options: { queryReplacement: HYBRID_PARAMS },
  }, [px + 400, py + 420], { credentials: PG_CRED, onError: 'continueRegularOutput', alwaysOutputData: true }));

  wf.nodes.push(mk('Cache Prefilter', 'n8n-nodes-base.code', 2, {
    mode: 'runOnceForAllItems', language: 'javaScript', jsCode: PREFILTER_CODE,
  }, [px + 600, py + 420], { alwaysOutputData: true }));

  wf.nodes.push(mk('Merge Cache', 'n8n-nodes-base.merge', 3, { numberInputs: 2 }, [ax - 120, ay]));

  wf.nodes.push(mk('Record Matches', 'n8n-nodes-base.postgres', 2.6, {
    operation: 'executeQuery', query: RECORD_SQL, options: { queryReplacement: RECORD_PARAMS },
  }, [pso.position[0] + 200, pso.position[1] + 260], { credentials: PG_CRED, onError: 'continueRegularOutput' }));

  // Rewire: Merge Sources -> Merge Cache(0) -> Aggregate Jobs
  wf.connections['Merge Sources'] = { main: [[{ node: 'Merge Cache', type: 'main', index: 0 }]] };
  wf.connections['Merge Cache'] = { main: [[{ node: 'Aggregate Jobs', type: 'main', index: 0 }]] };

  // Cache lane wiring
  const pfConns = wf.connections['Pre-flight: Providers'].main[0];
  pfConns.push({ node: 'Embed Search Query', type: 'main', index: 0 });
  wf.connections['Embed Search Query'] = { main: [[{ node: 'Hybrid Cache Search', type: 'main', index: 0 }]] };
  wf.connections['Hybrid Cache Search'] = { main: [[{ node: 'Cache Prefilter', type: 'main', index: 0 }]] };
  // Cache Prefilter -> Merge Cache input 1
  wf.connections['Cache Prefilter'] = { main: [[{ node: 'Merge Cache', type: 'main', index: 1 }]] };

  // Parse Scorer Output -> Record Matches (parallel)
  wf.connections['Parse Scorer Output'].main[0].push({ node: 'Record Matches', type: 'main', index: 0 });

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`${file}: R5 cache lane added (${wf.nodes.length} nodes).`);
}
console.log('R5 patch complete.');
