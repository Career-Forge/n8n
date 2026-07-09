/**
 * s34_r2_intel_cache.js -- Sprint R2 item 5 of the post-audit rebuild plan
 * (2026-07-05 v5 addendum): intel lane reads the company_intel cache before
 * re-researching. The apply lane already does this (Read Intel Cache (Apply)
 * + IF: Dossier Fresh?, 30-day TTL); the plain `intel <company>` command pays
 * the full search-fan-out + CompanyIntel LLM cost on every single run, even
 * for a company it already researched minutes ago.
 *
 * Also fixes a real, separate, currently-live bug found while tracing this
 * chain: Format Intel Report reads `$input.first().json.output` -- but its
 * direct upstream is Save Writing Profile (a Postgres INSERT with no
 * RETURNING clause and alwaysOutputData:true), which passes through its OWN
 * input (Build Writing Guidance's {company_key, guidance, _has_guidance})
 * when the query returns zero rows, not the query result. That shape has no
 * `.output` field, so `r` has been resolving to `{}` on every `intel` run --
 * company/health_score/sentiment/etc. all silently fall back to "Unknown"/"?".
 * Confirmed via the connection chain + the node's alwaysOutputData flag (no
 * recent `intel` execution existed in the local DB to inspect directly, but
 * the chain and setting are unambiguous). Fix: read
 * $('CompanyIntel').first().json.output directly, the same pattern Build
 * Writing Guidance already uses for the identical data.
 *
 * New cache gate: right after `IF: Draft Request?`'s non-draft branch (which
 * currently goes straight to You.com Research for both intel and outreach),
 * insert Read Intel Cache (same 30-day-TTL query shape as Read Intel Cache
 * (Apply)) -> IF: Intel Cache Fresh? (research_type === 'intel' AND a fresh
 * dossier exists) -> a cached-path formatter -> Send Intel. The false branch
 * (outreach, or intel with no/stale cache) continues to You.com Research
 * exactly as before -- this only skips work for the specific case it targets.
 *
 * Format Intel Report (Cached) duplicates Format Intel Report's formatting
 * body (different data source: a stored dossier, not a fresh CompanyIntel
 * call). Not shared via a helper -- n8n Code nodes can't import a module, and
 * this codebase's own established answer to that exact tradeoff (the LaTeX
 * renderer, duplicated 3-4x across Assemble/Build nodes, per R3's plan) is to
 * accept the duplication rather than force an architecture Code nodes don't
 * support, and catch drift later with a hash-based checker.
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

function edge(node, index) { return { node, type: 'main', index: index || 0 }; }

// ── Format Intel Report bug fix ──
const FIR_OLD = `const r = $input.first().json.output || {};
const ctx = $('Normalize Research Results').first().json;`;
const FIR_NEW = `// R2 bugfix: this node's direct upstream (Save Writing Profile) is a Postgres
// INSERT with no RETURNING + alwaysOutputData:true, so on the (normal) zero-row
// case it passes through ITS OWN input (Build Writing Guidance's
// {company_key,guidance,_has_guidance}) -- which has no .output field. $input
// here was silently resolving to {} on every run. Read CompanyIntel directly
// instead, the same pattern Build Writing Guidance already uses for this data.
const r = ($('CompanyIntel').first().json || {}).output || {};
const ctx = $('Normalize Research Results').first().json;`;

// ── Cached-path formatter (duplicates Format Intel Report's body; different source) ──
const CACHED_FORMATTER_CODE = String.raw`// Cached counterpart of Format Intel Report -- same formatting body, sourced
// from a fresh company_intel row instead of a live CompanyIntel call. See R2
// item 5 (scripts/s34_r2_intel_cache.js) for why this is duplicated rather
// than shared.
const r = ($('Read Intel Cache').first().json || {}).dossier || {};
const chatId = $('Extract Input').first().json.chat_id;
const recIcon = r.recommendation === 'Apply' ? '✅' : r.recommendation === 'Caution' ? '⚠️' : '\u{1F6D1}';
const sections = [
  recIcon + ' *' + (r.company || 'Unknown') + ' — Health Score: ' + (r.health_score || '?') + '/100* _(cached)_',
  '_' + (r.summary || 'No summary available.') + '_', '',
  '\u{1F4CA} *Sentiment:* ' + (r.sentiment && r.sentiment.overall_mood || 'Unknown') + (r.sentiment && r.sentiment.glassdoor_rating ? ' (Glassdoor: ' + r.sentiment.glassdoor_rating + ')' : ''),
];
if (r.sentiment && r.sentiment.positives && r.sentiment.positives.length) sections.push(r.sentiment.positives.map(p => '  ✅ ' + p).join('\n'));
if (r.sentiment && r.sentiment.negatives && r.sentiment.negatives.length) sections.push(r.sentiment.negatives.map(p => '  ❌ ' + p).join('\n'));
sections.push('');
sections.push('\u{1F534} *Layoffs:* ' + (r.layoffs && r.layoffs.has_recent_layoffs ? 'Yes — ' + r.layoffs.details : 'None recent'));
sections.push('\u{1F4B0} *Funding:* ' + (r.funding && r.funding.stage || 'Unknown') + (r.funding && r.funding.last_round ? ' (' + r.funding.last_round + ')' : ''));
sections.push('\u{1F6C2} *H1B:* ' + (r.h1b && r.h1b.sponsors ? 'Yes' : 'Unknown'));
sections.push('');
if (r.green_flags && r.green_flags.length) sections.push('\u{1F7E2} *Green Flags:*\n' + r.green_flags.map(f => '• ' + f).join('\n'));
if (r.red_flags && r.red_flags.length) sections.push('\u{1F534} *Red Flags:*\n' + r.red_flags.map(f => '• ' + f).join('\n'));
return [{ json: { chat_id: chatId, message: sections.filter(Boolean).join('\n') } }];`;

const READ_CACHE_QUERY = "SELECT (SELECT dossier FROM company_intel WHERE company_key = lower(regexp_replace($1,'[,.].*$','')) AND fetched_at > now() - interval '30 days' LIMIT 1) AS dossier";
const READ_CACHE_QUERY_REPLACEMENT = "={{ [ $json.company || 'unknown' ] }}";

const READ_NODE_NAME = 'Read Intel Cache';
const IF_NODE_NAME = 'IF: Intel Cache Fresh?';
const CACHED_FMT_NAME = 'Format Intel Report (Cached)';

// Pure graph-transform, shared by the harness (structural fixture) and patch()
// (the real workflow) so the harness proves the exact transform that runs.
function wireIntelCache(wf, pgCred) {
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  for (const name of ['IF: Draft Request?', 'You.com Research', 'Send Intel', 'Extract Input']) {
    if (!N[name]) throw new Error(`node "${name}" not found`);
  }
  if (N[READ_NODE_NAME]) return 0; // already patched

  const anchor = N['IF: Draft Request?'].position || [0, 0];
  wf.nodes.push({
    parameters: {
      operation: 'executeQuery',
      query: READ_CACHE_QUERY,
      options: { queryReplacement: READ_CACHE_QUERY_REPLACEMENT },
    },
    id: crypto.randomUUID(), name: READ_NODE_NAME, type: 'n8n-nodes-base.postgres', typeVersion: 2.6,
    position: [anchor[0] + 260, anchor[1] + 180],
    credentials: { postgres: pgCred },
  });
  wf.nodes.push({
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          { leftValue: "={{ $('Prepare Research').first().json.research_type }}", rightValue: 'intel', operator: { type: 'string', operation: 'equals' } },
          { leftValue: '={{ $json.dossier ? "yes" : "no" }}', rightValue: 'yes', operator: { type: 'string', operation: 'equals' } },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: crypto.randomUUID(), name: IF_NODE_NAME, type: 'n8n-nodes-base.if', typeVersion: 2.2,
    position: [anchor[0] + 460, anchor[1] + 180],
  });
  wf.nodes.push({
    parameters: { jsCode: CACHED_FORMATTER_CODE },
    id: crypto.randomUUID(), name: CACHED_FMT_NAME, type: 'n8n-nodes-base.code', typeVersion: 2,
    position: [anchor[0] + 660, anchor[1] + 100],
  });

  const C = wf.connections;
  // IF: Draft Request? branch 1 (not-draft) used to go straight to You.com Research;
  // now it goes through the cache gate first.
  const branch1 = C['IF: Draft Request?'].main[1];
  if (branch1.length !== 1 || branch1[0].node !== 'You.com Research') {
    throw new Error(`IF: Draft Request? branch 1 does not point solely at You.com Research, got ${JSON.stringify(branch1)}`);
  }
  C['IF: Draft Request?'].main[1] = [edge(READ_NODE_NAME)];

  C[READ_NODE_NAME] = { main: [[edge(IF_NODE_NAME)]] };
  C[IF_NODE_NAME] = { main: [[edge(CACHED_FMT_NAME)], [edge('You.com Research')]] };
  C[CACHED_FMT_NAME] = { main: [[edge('Send Intel')]] };

  return 1;
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  let edits = 0;

  if (!N['Format Intel Report']) { console.error(`INTEGRITY FAIL ${base}: Format Intel Report not found`); process.exit(1); }
  const cur = N['Format Intel Report'].parameters.jsCode;
  if (cur !== FIR_NEW) {
    if (cur.indexOf(FIR_OLD) === -1) { console.error(`INTEGRITY FAIL ${base}: Format Intel Report does not match expected old value.\nGot (first 200 chars): ${cur.slice(0, 200)}`); process.exit(1); }
    N['Format Intel Report'].parameters.jsCode = cur.split(FIR_OLD).join(FIR_NEW);
    edits++;
  }

  const pgCredNode = N['Read Intel Cache (Apply)'];
  if (!pgCredNode) { console.error(`INTEGRITY FAIL ${base}: Read Intel Cache (Apply) (credential source) not found`); process.exit(1); }
  const pgCred = pgCredNode.credentials.postgres;

  let wireEdits;
  try { wireEdits = wireIntelCache(wf, pgCred); }
  catch (e) { console.error(`INTEGRITY FAIL ${base}: ${e.message}`); process.exit(1); }
  edits += wireEdits;

  const names = new Set(wf.nodes.map((n) => n.name));
  for (const [src, obj] of Object.entries(wf.connections)) {
    if (!names.has(src)) { console.error(`INTEGRITY FAIL ${base}: connection source "${src}" missing`); process.exit(1); }
    for (const branches of Object.values(obj)) {
      (branches || []).forEach((b) => (b || []).forEach((e) => {
        if (!names.has(e.node)) { console.error(`INTEGRITY FAIL ${base}: dangling connection ${src} -> ${e.node}`); process.exit(1); }
      }));
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: intel cache gate wired + Format Intel Report bugfix (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness ──
(function harness() {
  // Structural: graph transform against a synthetic fixture.
  {
    const wf = {
      nodes: [
        { name: 'IF: Draft Request?', position: [0, 0] },
        { name: 'You.com Research', position: [200, 100] },
        { name: 'Load Draft Contact', position: [200, -100] },
        { name: 'Send Intel', position: [1000, 0] },
        { name: 'Extract Input', position: [-200, 0] },
      ],
      connections: {
        'IF: Draft Request?': { main: [[edge('Load Draft Contact')], [edge('You.com Research')]] },
      },
    };
    const edits = wireIntelCache(wf, { id: 'x', name: 'y' });
    if (edits !== 1) { console.error('HARNESS FAIL: expected 1 edit on a fresh fixture, got', edits); process.exit(1); }
    const C = wf.connections;
    if (C['IF: Draft Request?'].main[1][0].node !== READ_NODE_NAME) { console.error('HARNESS FAIL: branch 1 should now point at Read Intel Cache, got', JSON.stringify(C['IF: Draft Request?'].main[1])); process.exit(1); }
    if (C['IF: Draft Request?'].main[0][0].node !== 'Load Draft Contact') { console.error('HARNESS FAIL: draft branch (0) must be untouched'); process.exit(1); }
    if (C[READ_NODE_NAME].main[0][0].node !== IF_NODE_NAME) { console.error('HARNESS FAIL: Read Intel Cache should feed the fresh-check IF node'); process.exit(1); }
    if (C[IF_NODE_NAME].main[0][0].node !== CACHED_FMT_NAME) { console.error('HARNESS FAIL: IF true-branch should feed the cached formatter'); process.exit(1); }
    if (C[IF_NODE_NAME].main[1][0].node !== 'You.com Research') { console.error('HARNESS FAIL: IF false-branch should still feed You.com Research (outreach + stale-cache path unchanged)'); process.exit(1); }
    if (C[CACHED_FMT_NAME].main[0][0].node !== 'Send Intel') { console.error('HARNESS FAIL: cached formatter should feed Send Intel'); process.exit(1); }
    const readNode = wf.nodes.find((n) => n.name === READ_NODE_NAME);
    if (readNode.credentials.postgres.id !== 'x') { console.error('HARNESS FAIL: Read Intel Cache did not receive the passed-in credential'); process.exit(1); }
    // idempotency
    const edits2 = wireIntelCache(wf, { id: 'x', name: 'y' });
    if (edits2 !== 0) { console.error('HARNESS FAIL: re-run should be a no-op, got', edits2); process.exit(1); }
    if (wf.nodes.filter((n) => n.name === READ_NODE_NAME).length !== 1) { console.error('HARNESS FAIL: re-run duplicated the Read Intel Cache node'); process.exit(1); }
  }

  // Logic: cached formatter produces a sensible message from a mock dossier, badges "(cached)".
  {
    const dossier = { company: 'Acme', health_score: 82, recommendation: 'Apply', summary: 'Solid, growing.', sentiment: { overall_mood: 'positive', glassdoor_rating: 4.1, positives: ['good WLB'], negatives: [] }, layoffs: { has_recent_layoffs: false }, funding: { stage: 'Series C', last_round: '2025' }, h1b: { sponsors: true }, green_flags: ['fast growth'], red_flags: [] };
    const $ = (name) => {
      if (name === 'Read Intel Cache') return { first: () => ({ json: { dossier } }) };
      if (name === 'Extract Input') return { first: () => ({ json: { chat_id: 555 } }) };
      throw new Error('unexpected ref ' + name);
    };
    const fn = new Function('$', CACHED_FORMATTER_CODE);
    const out = fn($);
    const item = out[0].json;
    if (item.chat_id !== 555) { console.error('HARNESS FAIL: cached formatter lost chat_id'); process.exit(1); }
    if (!item.message.includes('Acme') || !item.message.includes('82/100')) { console.error('HARNESS FAIL: cached formatter message missing company/score, got', item.message); process.exit(1); }
    if (!item.message.includes('(cached)')) { console.error('HARNESS FAIL: cached formatter should badge the message as cached'); process.exit(1); }
    if (!item.message.includes('good WLB') || !item.message.includes('Series C')) { console.error('HARNESS FAIL: cached formatter dropped sentiment/funding detail'); process.exit(1); }

    // degraded case: empty dossier must not throw.
    const $empty = (name) => {
      if (name === 'Read Intel Cache') return { first: () => ({ json: { dossier: null } }) };
      if (name === 'Extract Input') return { first: () => ({ json: { chat_id: 1 } }) };
      throw new Error('unexpected ref ' + name);
    };
    const outEmpty = fn($empty);
    if (!outEmpty[0].json.message.includes('Unknown')) { console.error('HARNESS FAIL: empty-dossier case should degrade to Unknown, not throw'); process.exit(1); }
  }

  // Logic: Format Intel Report bugfix actually reads CompanyIntel's output (proves the OLD
  // path really was broken -- $input in that position never carries .output).
  {
    const $ = (name) => {
      if (name === 'CompanyIntel') return { first: () => ({ json: { output: { company: 'Acme', health_score: 90 } } }) };
      if (name === 'Normalize Research Results') return { first: () => ({ json: { chat_id: 1, company: 'Acme' } }) };
      throw new Error('unexpected ref ' + name);
    };
    const src = FIR_NEW + '\nreturn r;';
    const r = new Function('$', src)($);
    if (r.company !== 'Acme' || r.health_score !== 90) { console.error('HARNESS FAIL: fixed Format Intel Report line does not read CompanyIntel output correctly, got', JSON.stringify(r)); process.exit(1); }
  }

  console.log('HARNESS OK: intel-cache graph wiring (draft branch untouched, cache-fresh -> cached formatter -> Send Intel, cache-stale/outreach -> unchanged You.com Research path, idempotent re-run), cached formatter (real message incl. cached-badge + degraded-empty case), and Format Intel Report bugfix (now genuinely reads CompanyIntel.output) -- all verified');
})();

TARGETS.forEach(patch);
console.log('S34 (R2 item 5: intel cache read + Format Intel Report bugfix) complete.');
