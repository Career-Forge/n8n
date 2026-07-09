/**
 * r7_intel_penalty.js — R7: company intelligence integrated into matching.
 *
 * (1) Hybrid Cache Search: LEFT JOIN company_intel and apply a health-score
 *     penalty to rrf_score (capped 30%; absent intel = no penalty). A company on
 *     a layoff spree / low health gets its jobs downranked automatically.
 * (2) New "Save Intel Cache": after CompanyIntel, upsert the dossier + health
 *     score into company_intel (7-day implicit TTL via fetched_at), so every
 *     `intel <company>` run feeds the matching penalty. onError continue +
 *     alwaysOutputData so Format Intel Report always runs.
 *
 * Run AFTER R5.  node scripts/r7_intel_penalty.js
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

const PENALTY =
  "(f.score * (1 - LEAST(0.3, GREATEST(0, 50 - COALESCE(ci.health_score,60))::numeric/100)))";

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
  "left(j.jd_text,1200) AS jd_text, j.posted_at, " + PENALTY + " AS rrf_score " +
  "FROM fused f JOIN jobs j ON j.id=f.id JOIN companies c ON c.id=j.company_id " +
  "LEFT JOIN company_intel ci ON ci.company_key = lower(regexp_replace(c.name,'[,.].*$','')) " +
  "ORDER BY rrf_score DESC LIMIT 30";

const SAVE_SQL =
  "INSERT INTO company_intel (company_key, dossier, health_score) " +
  "VALUES (lower(regexp_replace($1,'[,.].*$','')), $2::jsonb, NULLIF($3,'')::int) " +
  "ON CONFLICT (company_key) DO UPDATE SET dossier=EXCLUDED.dossier, health_score=EXCLUDED.health_score, fetched_at=now()";
const SAVE_PARAMS =
  "={{ [ (($json.output && $json.output.company) || $('Normalize Research Results').first().json.company || 'unknown'), " +
  "JSON.stringify(($json.output) || {}), String((($json.output && $json.output.health_score) ?? '')) ] }}";

for (const file of TARGETS) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  // (1) penalty in Hybrid Cache Search
  const hcs = N['Hybrid Cache Search'];
  if (!hcs) throw new Error(`Hybrid Cache Search missing in ${file} (run R5 first)`);
  hcs.parameters.query = HYBRID_SQL;

  // (2) Save Intel Cache between CompanyIntel and Format Intel Report
  if (!N['Save Intel Cache']) {
    const ci = N['CompanyIntel'];
    const [cx, cy] = ci.position;
    wf.nodes.push({
      parameters: { operation: 'executeQuery', query: SAVE_SQL, options: { queryReplacement: SAVE_PARAMS } },
      id: crypto.randomUUID(), name: 'Save Intel Cache', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
      position: [cx + 180, cy + 200], credentials: PG_CRED, onError: 'continueRegularOutput', alwaysOutputData: true,
    });
    // rewire CompanyIntel -> Save Intel Cache -> Format Intel Report
    wf.connections['CompanyIntel'] = { main: [[{ node: 'Save Intel Cache', type: 'main', index: 0 }]] };
    wf.connections['Save Intel Cache'] = { main: [[{ node: 'Format Intel Report', type: 'main', index: 0 }]] };
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`${file}: R7 applied (${wf.nodes.length} nodes).`);
}
console.log('R7 patch complete.');
