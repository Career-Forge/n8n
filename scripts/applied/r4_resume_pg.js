/**
 * r4_resume_pg.js — R4: resume ingest -> Postgres resumes table with embedding.
 *
 * Adds a parallel branch off "IF: Resume Parse OK?" (true output):
 *   Embed Resume Profile (Ollama bge-m3 on compact_views.scoring_profile)
 *   -> Upsert Resume Row (users + resumes upsert via idx_resume_primary)
 *
 * Both nodes use onError: continueRegularOutput — a Postgres/Ollama hiccup
 * never breaks the existing file-based resume setup flow.
 *
 * Patches both master workflow copies. Run:  node scripts/r4_resume_pg.js
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

const UPSERT_SQL =
  "WITH u AS (INSERT INTO users (tg_user_id) VALUES ($1::bigint) ON CONFLICT (tg_user_id) DO UPDATE SET tg_user_id = EXCLUDED.tg_user_id RETURNING tg_user_id) " +
  "INSERT INTO resumes (user_id, doc_text, embedding, is_primary) " +
  "SELECT tg_user_id, $2, NULLIF($3, '')::vector, true FROM u " +
  "ON CONFLICT (user_id) WHERE is_primary DO UPDATE SET doc_text = EXCLUDED.doc_text, embedding = COALESCE(EXCLUDED.embedding, resumes.embedding), updated_at = now()";

const UPSERT_PARAMS =
  "={{ [" +
  "$('Ingest Resume JSON').first().json.chat_id, " +
  "$('Ingest Resume JSON').first().json.resume_doc.compact_views.scoring_profile || '', " +
  "($json.embeddings && $json.embeddings[0] && $json.embeddings[0].length === 1024) ? '[' + $json.embeddings[0].join(',') + ']' : ''" +
  "] }}";

for (const file of TARGETS) {
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  if (N['Embed Resume Profile']) {
    console.log(`${file}: R4 nodes already present, skipping`);
    continue;
  }
  const anchor = N['IF: Resume Parse OK?'];
  if (!anchor) throw new Error(`IF: Resume Parse OK? missing in ${file}`);
  const [ax, ay] = anchor.position;

  wf.nodes.push({
    parameters: {
      method: 'POST',
      url: 'http://ollama-service:11434/api/embed',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: "={{ { \"model\": \"bge-m3\", \"input\": [($json.resume_doc && $json.resume_doc.compact_views && $json.resume_doc.compact_views.scoring_profile) || ''] } }}",
      options: { timeout: 60000, response: { response: { neverError: true } } },
    },
    id: crypto.randomUUID(),
    name: 'Embed Resume Profile',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    position: [ax + 220, ay + 240],
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 2000,
    onError: 'continueRegularOutput',
  });

  wf.nodes.push({
    parameters: {
      operation: 'executeQuery',
      query: UPSERT_SQL,
      options: { queryReplacement: UPSERT_PARAMS },
    },
    id: crypto.randomUUID(),
    name: 'Upsert Resume Row',
    type: 'n8n-nodes-base.postgres',
    typeVersion: 2.6,
    position: [ax + 440, ay + 240],
    credentials: PG_CRED,
    onError: 'continueRegularOutput',
  });

  // Wire: IF true branch additionally feeds Embed Resume Profile
  const conns = wf.connections['IF: Resume Parse OK?'];
  if (!conns || !conns.main || !conns.main[0]) throw new Error(`IF connections missing in ${file}`);
  conns.main[0].push({ node: 'Embed Resume Profile', type: 'main', index: 0 });
  wf.connections['Embed Resume Profile'] = { main: [[{ node: 'Upsert Resume Row', type: 'main', index: 0 }]] };

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`${file}: R4 branch added (${wf.nodes.length} nodes).`);
}
console.log('R4 patch complete.');
