/**
 * local_remap_credentials.js — point every node at this machine's freshly-created
 * n8n credentials after a from-scratch setup (new machine = new credential IDs;
 * every node importing the workflow JSON still references the OLD machine's IDs).
 *
 * Fill in CREDENTIAL_MAP below with the IDs from:
 *   docker exec careerforge_n8n n8n export:credentials --all --output=/tmp/creds.json
 *   docker exec careerforge_n8n sh -c 'cat /tmp/creds.json' | jq -r '.[] | "\(.type) \(.id) \(.name)"'
 * (all nodes of a given type share ONE credential id in this workflow — confirmed via
 * `jq -r '.nodes[] | select(.credentials.postgres!=null) | .credentials.postgres.id' | sort -u`
 * returning a single value per type — so one map entry per type covers every node.)
 *
 * Run: node scripts/local_remap_credentials.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// credentials.<key> type -> new {id, name} on this machine. Fill in before running.
const CREDENTIAL_MAP = {
  postgres:       { id: 'caLsB31DYOphw0EV', name: 'CareerForge_Postgres' },
  telegramApi:    { id: 'XayaGFL8EdfqdoR7', name: 'CareerForge_Telegram' },
  openRouterApi:  { id: 'ypIVPJu8JYSWTkHT', name: 'CareerForge_OpenRouter' },
  firecrawlApi:   { id: 'vxacfyzUmSLNVHkV', name: 'CareerForge_Firecrawl' },
  youDotComApi:   { id: 'Hnjqssqf9Pxloh3J', name: 'CareerForge_You.com' },
  httpHeaderAuth: { id: 'yKRm3wIwsRT3cnZ7', name: 'CareerForge_Serper' },
};

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  let edits = 0;

  for (const node of wf.nodes) {
    if (!node.credentials) continue;
    for (const [type, ref] of Object.entries(node.credentials)) {
      const mapped = CREDENTIAL_MAP[type];
      if (mapped && mapped.id && ref.id !== mapped.id) {
        node.credentials[type] = { id: mapped.id, name: mapped.name };
        edits++;
      }
    }
  }

  // integrity: every referenced credential type now points at a non-empty id
  for (const node of wf.nodes) {
    if (!node.credentials) continue;
    for (const [type, ref] of Object.entries(node.credentials)) {
      if (!ref.id) { console.error(`INTEGRITY FAIL ${base}: ${node.name} (${type}) has empty credential id`); process.exit(1); }
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: ${edits} node credential refs remapped — ${wf.nodes.length} nodes`);
}

if (Object.values(CREDENTIAL_MAP).some((c) => !c.id)) {
  console.error('CREDENTIAL_MAP has empty ids — fill in every id before running. See header comment.');
  process.exit(1);
}

TARGETS.forEach(patch);
console.log('Credential remap complete. Re-import + restart n8n to apply:');
console.log('  docker cp "docker/workflows/CareerForge Master Local v6.3.json" careerforge_n8n:/tmp/wf.json');
console.log('  docker exec careerforge_n8n n8n import:workflow --input=/tmp/wf.json');
console.log('  docker exec careerforge_n8n n8n update:workflow --id=kmQDCNypCfZbqwAW --active=true');
console.log('  docker restart careerforge_n8n');
