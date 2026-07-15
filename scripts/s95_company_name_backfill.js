/**
 * s95_company_name_backfill.js -- fixes digests showing ATS board slugs as
 * company names ("Platacard", "Eqvilentjobs", "Digitalocean98") instead of
 * real company names. Root cause: the bulk import that founded the registry
 * (data/registry_import/*.json, 15.5k companies) was a bare slug list with
 * no display-name column, so those rows got `name = slug` at import time.
 *
 * Live-verified before writing this (per the project's own "test, don't
 * guess" discipline): Greenhouse's jobs response -- the SAME response
 * Parse Jobs already fetches and parses, `boards-api.greenhouse.io/v1/boards/
 * {slug}/jobs?content=true` -- carries the real company display name on
 * EVERY job object (`j.company_name`, confirmed live against the real
 * Stripe board: "company_name":"Stripe"). Zero extra HTTP calls needed.
 * Ashby's posting-api response and Lever's postings response were BOTH
 * checked live and carry NO organization-name field anywhere in their
 * payload -- per the plan's own "skip if absent" rule, this patch only
 * backfills Greenhouse; Lever/Ashby stay on the web-lane slug-prettify
 * fallback (Build Telegraph Body's clean()) until/unless a real org-name
 * source is found for them.
 *
 * Parse Jobs captures one company_name per greenhouse board per tick
 * (every job on a board carries the same name, one capture is enough) into
 * a new `name_backfills` staticData side-channel -- same pattern Phase 2's
 * self_fetch_outcomes already established for "derived data that doesn't
 * fit the main per-job item shape." A new `Backfill Company Names` postgres
 * node (fanned out alongside Chunk For Embed off Parse Jobs' own output)
 * applies the whole batch in ONE UPDATE via jsonb_to_recordset -- naturally
 * a no-op on an empty array, so no separate IF gate is needed. The UPDATE's
 * own `AND c.name = c.slug` guard means it only ever touches rows still
 * exactly slug-shaped at write time -- never clobbers a name a user
 * corrected by hand, and is safe to run every tick indefinitely.
 *
 * +1 node (16 -> 17) in the ATS Poller workflow. Run: inside the n8n
 * container with the repo staged under /tmp.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_ATS_Poller.json'),
  path.join(ROOT, 'workflows', 'CareerForge_ATS_Poller.json'),
];

const POLLER_PG_CRED = { postgres: { id: 'caLsB31DYOphw0EV', name: 'CareerForge_Postgres' } };

// ═══ 1. Parse Jobs: declare the name_backfills collector alongside the existing count/jobs arrays ═══
const DECL_OLD = `const count = {};
const jobs = [];`;
const DECL_NEW = `const count = {};
const jobs = [];
// s95: one company_name capture per greenhouse board per tick -- see header.
const nameBackfills = [];
const nameBackfillSeen = new Set();`;

// ═══ 2. Parse Jobs: capture j.company_name inside the greenhouse branch ═══
const GH_OLD = `    if (t === 'greenhouse') {
      for (const j of (body.jobs || [])) push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id), title: j.title || '', jd_text: strip(j.content), location: (j.location && j.location.name) || '', remote: isRemote(j.location && j.location.name), apply_url: j.absolute_url || '', posted_at: iso(j.updated_at || j.first_published) });
    } else if (t === 'lever') {`;
const GH_NEW = `    if (t === 'greenhouse') {
      for (const j of (body.jobs || [])) {
        push(company.board, { company_id: company.company_id, board: company.board, external_id: String(j.id), title: j.title || '', jd_text: strip(j.content), location: (j.location && j.location.name) || '', remote: isRemote(j.location && j.location.name), apply_url: j.absolute_url || '', posted_at: iso(j.updated_at || j.first_published) });
        if (j.company_name && !nameBackfillSeen.has(company.board)) {
          nameBackfillSeen.add(company.board);
          nameBackfills.push({ company_id: company.company_id, name: String(j.company_name).trim() });
        }
      }
    } else if (t === 'lever') {`;

// ═══ 3. Parse Jobs: stash the collected backfills before the final return ═══
const RETURN_OLD = `return jobs.map(j => ({ json: Object.assign({}, j, { embed_input: ((j.title || '') + '\\n' + (j.jd_text || '')).slice(0, 8000) }) }));`;
const RETURN_NEW = `$getWorkflowStaticData('global').name_backfills = nameBackfills;

return jobs.map(j => ({ json: Object.assign({}, j, { embed_input: ((j.title || '') + '\\n' + (j.jd_text || '')).slice(0, 8000) }) }));`;

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.split(oldStr).join(newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Parse Jobs']) { console.error(`INTEGRITY FAIL ${base}: node "Parse Jobs" not found`); process.exit(1); }

  if (N['Parse Jobs'].parameters.jsCode.includes('s95:')) { console.log(`  ${base}: already patched`); return; }

  const pj = N['Parse Jobs'].parameters;
  replaceOnce(pj, 'jsCode', DECL_OLD, DECL_NEW, 'nameBackfills collector declaration', base);
  replaceOnce(pj, 'jsCode', GH_OLD, GH_NEW, 'greenhouse company_name capture', base);
  replaceOnce(pj, 'jsCode', RETURN_OLD, RETURN_NEW, 'name_backfills staticData stash', base);

  const pjPos = N['Parse Jobs'].position;
  const backfillNode = {
    id: crypto.randomUUID(), name: 'Backfill Company Names', type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
    position: [pjPos[0] + 200, pjPos[1] + 220],
    parameters: {
      operation: 'executeQuery',
      query: "UPDATE companies c SET name = v.name FROM jsonb_to_recordset($1::jsonb) AS v(company_id bigint, name text) WHERE c.id = v.company_id AND c.name = c.slug",
      options: { queryReplacement: "={{ [ JSON.stringify($getWorkflowStaticData('global').name_backfills || []) ] }}" },
    },
    credentials: POLLER_PG_CRED,
  };
  wf.nodes.push(backfillNode);

  // Fan Parse Jobs' output to BOTH the existing main pipeline and the new backfill write.
  const existingBranch = (wf.connections['Parse Jobs'] && wf.connections['Parse Jobs'].main && wf.connections['Parse Jobs'].main[0]) || [];
  if (!existingBranch.some((e) => e.node === 'Backfill Company Names')) {
    wf.connections['Parse Jobs'] = { main: [[...existingBranch, { node: 'Backfill Company Names', type: 'main', index: 0 }]] };
  }

  // integrity: every edge resolves, no dangling connections
  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: greenhouse company-name backfill (+1 node, Backfill Company Names) -- ${wf.nodes.length} nodes`);
}

// ── harness: simulate the greenhouse capture logic against the REAL live Greenhouse response shape ──
(function harness() {
  const strip = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const isRemote = (s) => /remote/i.test(String(s || ''));

  function simulate(body, company) {
    const push = () => {}; // no-op stand-in, only testing the name-capture side effect here
    const nameBackfills = [];
    const nameBackfillSeen = new Set();
    for (const j of (body.jobs || [])) {
      push();
      if (j.company_name && !nameBackfillSeen.has(company.board)) {
        nameBackfillSeen.add(company.board);
        nameBackfills.push({ company_id: company.company_id, name: String(j.company_name).trim() });
      }
    }
    return nameBackfills;
  }

  // Real shape confirmed live against boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true.
  const realShapedBody = {
    jobs: [
      { id: 1, title: 'Software Engineer', company_name: 'Stripe', content: '<p>desc</p>' },
      { id: 2, title: 'Data Scientist', company_name: 'Stripe', content: '<p>desc2</p>' },
    ],
  };
  const result = simulate(realShapedBody, { company_id: 42, board: 'greenhouse:stripe' });
  if (result.length !== 1) { console.error('HARNESS FAIL: expected exactly ONE backfill entry per board (dedup across multiple jobs)', result); process.exit(1); }
  if (result[0].company_id !== 42 || result[0].name !== 'Stripe') { console.error('HARNESS FAIL: wrong company_id/name captured', result); process.exit(1); }

  // Missing company_name (e.g. a future Greenhouse response shape change) must not crash or emit garbage.
  const noNameResult = simulate({ jobs: [{ id: 3, title: 'X' }] }, { company_id: 99, board: 'greenhouse:x' });
  if (noNameResult.length !== 0) { console.error('HARNESS FAIL: missing company_name should produce zero backfills, not a garbage entry', noNameResult); process.exit(1); }

  console.log('HARNESS OK: greenhouse company_name capture dedupes to one entry per board across multiple jobs, matches the real live Stripe response shape, produces zero entries when the field is absent');

  // The bulk-UPDATE's guard logic, proven against a plain JS simulation of the SQL semantics.
  const rows = [
    { id: 1, slug: 'platacard', name: 'platacard' },   // needs backfill
    { id: 2, slug: 'stripe', name: 'Stripe' },          // already correct -- must NOT be touched
    { id: 3, slug: 'eqvilentjobs', name: 'eqvilentjobs' },
  ];
  const backfills = [{ company_id: 1, name: 'Platacard Inc' }, { company_id: 2, name: 'Some Wrong Name' }, { company_id: 3, name: 'Eqvilent Jobs LLC' }];
  const byId = Object.fromEntries(backfills.map((b) => [b.company_id, b.name]));
  const applied = rows.map((r) => (r.name === r.slug && byId[r.id]) ? { ...r, name: byId[r.id] } : r);
  if (applied[1].name !== 'Stripe') { console.error('HARNESS FAIL: SQL guard simulation -- an already-correct name must never be overwritten', applied[1]); process.exit(1); }
  if (applied[0].name !== 'Platacard Inc' || applied[2].name !== 'Eqvilent Jobs LLC') { console.error('HARNESS FAIL: slug-shaped rows should be backfilled', applied); process.exit(1); }
  console.log('HARNESS OK: the WHERE c.name = c.slug guard, simulated in JS, only touches rows still exactly slug-shaped -- never clobbers an already-correct name');
})();

console.log('Patching workflows...');
for (const t of TARGETS) patch(t);
console.log('Done.');
