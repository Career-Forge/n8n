/**
 * s20_schedule_resilience.js -- F1 (Roadmap v4): kill the scheduled-run crash for good.
 *
 * Root cause (confirmed live via exec 77): expressions of the shape
 *   $('Extract Input').first().json.chat_id || $('Schedule Payload').first().json.chat_id
 * crash on the FIRST call whenever 'Extract Input' didn't execute in this run --
 * n8n throws a synchronous no_execution_data error, and `||` only rescues falsy
 * values, never a thrown exception. On a scheduled tick, 'Extract Input' (the
 * Telegram-path normalizer) never runs, so this throws before the fallback is
 * ever reached. This is what silently kills the scheduled digest at Send Digest,
 * and the identical pattern in Record Matches (my own S13 fix -- same bug,
 * unconfirmed live only because Send Digest's crash aborted the run first).
 *
 * Fix: n8n's own supported safe pattern -- $('Node').isExecuted is a real boolean
 * (confirmed against n8n community docs/threads, 2026-07): guard every cross-path
 * .first() call with a ternary on isExecuted instead of relying on ||. Applied to
 * every node carrying the exact Extract-Input/Schedule-Payload/Telegram-Trigger
 * fallback chain (14 nodes, 2 shapes -- confirmed by scanning all node parameters
 * for cross-node .first() references, not just the 2 previously-known crash sites).
 *
 * Group A (12 nodes, 2-way, parameters.chatId): Send Help, Send Fallback,
 *   Send Resume Setup Error, Send Setup Ack, Send Setup Help, Send Parse Error,
 *   Send Verbose Confirm, Send Prefs View, Send Pref Confirm, Send Forget Confirm,
 *   Send Verbose Toggle, Send Resume Missing For Scoring.
 * Group B (1 node, 3-way, parameters.chatId): Send Digest.
 * Group C (1 node, 3-way, parameters.options.queryReplacement, array-embedded): Record Matches.
 *
 * These 12 Group-A nodes are Telegram-command-only today (no schedule tick ever
 * reaches "/help"), so isExecuted('Extract Input') is always true in practice --
 * the guard is a landmine defusal, not a behavior change. Group B/C are the
 * confirmed-live dual-path crash sites.
 *
 * Run: inside the n8n container with the repo staged under /tmp (see local_* scripts).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ── Group A: 2-way, parameters.chatId ──
const GROUP_A_OLD = "={{ $('Extract Input').first().json.chat_id || $('Schedule Payload').first().json.chat_id }}";
const GROUP_A_NEW = "={{ $('Extract Input').isExecuted ? $('Extract Input').first().json.chat_id : $('Schedule Payload').first().json.chat_id }}";
const GROUP_A_NODES = [
  'Send Help', 'Send Fallback', 'Send Resume Setup Error', 'Send Setup Ack',
  'Send Setup Help', 'Send Parse Error', 'Send Verbose Confirm', 'Send Prefs View',
  'Send Pref Confirm', 'Send Forget Confirm', 'Send Verbose Toggle',
  'Send Resume Missing For Scoring',
];

// ── Group B: 3-way, parameters.chatId (Send Digest) ──
const GROUP_B_OLD = "={{ $('Extract Input').first().json.chat_id || $('Schedule Payload').first().json.chat_id || $('Telegram Trigger').first().json.message.chat.id }}";
const GROUP_B_NEW = "={{ $('Extract Input').isExecuted ? $('Extract Input').first().json.chat_id : ($('Schedule Payload').isExecuted ? $('Schedule Payload').first().json.chat_id : ($('Telegram Trigger').isExecuted ? $('Telegram Trigger').first().json.message.chat.id : null)) }}";

// ── Group C: 3-way, parameters.options.queryReplacement, embedded in an array literal (Record Matches) ──
const GROUP_C_OLD = "={{ [ $('Extract Input').first().json.chat_id || $('Schedule Payload').first().json.chat_id || $('Telegram Trigger').first().json.message.chat.id, JSON.stringify($json.scored || []) ] }}";
const GROUP_C_NEW = "={{ [ $('Extract Input').isExecuted ? $('Extract Input').first().json.chat_id : ($('Schedule Payload').isExecuted ? $('Schedule Payload').first().json.chat_id : ($('Telegram Trigger').isExecuted ? $('Telegram Trigger').first().json.message.chat.id : null)), JSON.stringify($json.scored || []) ] }}";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  let edits = 0;

  for (const name of GROUP_A_NODES) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" not found`); process.exit(1); }
    const n = N[name];
    const cur = n.parameters.chatId;
    if (cur === GROUP_A_NEW) continue;
    if (cur !== GROUP_A_OLD) { console.error(`INTEGRITY FAIL ${base}: ${name}.chatId does not match expected old value.\nGot: ${cur}`); process.exit(1); }
    n.parameters.chatId = GROUP_A_NEW;
    edits++;
  }

  if (!N['Send Digest']) { console.error(`INTEGRITY FAIL ${base}: Send Digest not found`); process.exit(1); }
  {
    const n = N['Send Digest'];
    const cur = n.parameters.chatId;
    if (cur !== GROUP_B_NEW) {
      if (cur !== GROUP_B_OLD) { console.error(`INTEGRITY FAIL ${base}: Send Digest.chatId does not match expected old value.\nGot: ${cur}`); process.exit(1); }
      n.parameters.chatId = GROUP_B_NEW;
      edits++;
    }
  }

  if (!N['Record Matches']) { console.error(`INTEGRITY FAIL ${base}: Record Matches not found`); process.exit(1); }
  {
    const n = N['Record Matches'];
    const cur = n.parameters.options && n.parameters.options.queryReplacement;
    if (cur !== GROUP_C_NEW) {
      if (cur !== GROUP_C_OLD) { console.error(`INTEGRITY FAIL ${base}: Record Matches.options.queryReplacement does not match expected old value.\nGot: ${cur}`); process.exit(1); }
      n.parameters.options.queryReplacement = GROUP_C_NEW;
      edits++;
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: schedule-resilience guards applied (${edits} changed) -- ${wf.nodes.length} nodes`);
}

// ── harness: prove the isExecuted-ternary logic is actually crash-proof, for all
// three real scenarios, by evaluating the exact expression bodies as JS against a
// mock $ that mimics n8n's throw-on-unexecuted / isExecuted semantics. ──
(function harness() {
  const DATA = {
    'Extract Input': { chat_id: 111 },
    'Schedule Payload': { chat_id: 222 },
    'Telegram Trigger': { message: { chat: { id: 333 } } },
  };

  function mockDollar(executedSet) {
    return function $(name) {
      return {
        get isExecuted() { return executedSet.has(name); },
        first() {
          if (!executedSet.has(name)) {
            const e = new Error(`There is no execution data available for the node "${name}" (no_execution_data)`);
            e.code = 'no_execution_data';
            throw e;
          }
          return { json: DATA[name] };
        },
      };
    };
  }

  function evalExpr(rawExpr, executedSet, jsonMock) {
    // strip the leading "={{ " and trailing " }}" wrapper -- the body is valid JS as-is.
    const body = rawExpr.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const fn = new Function('$', '$json', 'return (' + body + ');');
    return fn(mockDollar(executedSet), jsonMock || {});
  }

  // Group A (2-way): telegram path (only Extract Input ran) must return 111, no throw.
  let v = evalExpr(GROUP_A_NEW, new Set(['Extract Input']));
  if (v !== 111) { console.error('HARNESS FAIL: Group A telegram-path expected 111, got', v); process.exit(1); }
  // Group A: schedule path (only Schedule Payload ran) must return 222, no throw.
  v = evalExpr(GROUP_A_NEW, new Set(['Schedule Payload']));
  if (v !== 222) { console.error('HARNESS FAIL: Group A schedule-path expected 222, got', v); process.exit(1); }
  // Group A: OLD pattern must actually throw on the schedule path (proves this is a real regression test, not a no-op).
  let threw = false;
  try { evalExpr(GROUP_A_OLD, new Set(['Schedule Payload'])); } catch (e) { threw = true; }
  if (!threw) { console.error('HARNESS FAIL: Group A OLD pattern did not throw on schedule-only path -- test is not discriminating'); process.exit(1); }

  // Group B (3-way): telegram path -> 111; schedule path -> 222; neither -> null (never throws).
  v = evalExpr(GROUP_B_NEW, new Set(['Extract Input']));
  if (v !== 111) { console.error('HARNESS FAIL: Group B telegram-path expected 111, got', v); process.exit(1); }
  v = evalExpr(GROUP_B_NEW, new Set(['Schedule Payload']));
  if (v !== 222) { console.error('HARNESS FAIL: Group B schedule-path expected 222, got', v); process.exit(1); }
  v = evalExpr(GROUP_B_NEW, new Set(['Telegram Trigger']));
  if (v !== 333) { console.error('HARNESS FAIL: Group B telegram-trigger-only fallback expected 333, got', v); process.exit(1); }
  v = evalExpr(GROUP_B_NEW, new Set([]));
  if (v !== null) { console.error('HARNESS FAIL: Group B neither-executed expected null (no throw), got', v); process.exit(1); }
  threw = false;
  try { evalExpr(GROUP_B_OLD, new Set(['Schedule Payload'])); } catch (e) { threw = true; }
  if (!threw) { console.error('HARNESS FAIL: Group B OLD pattern did not throw on schedule-only path'); process.exit(1); }

  // Group C: same 3-way logic, embedded in an array -- verify element [0] behaves identically, element [1] untouched.
  const arr = evalExpr(GROUP_C_NEW, new Set(['Schedule Payload']), { scored: [{ a: 1 }] });
  if (!Array.isArray(arr) || arr[0] !== 222) { console.error('HARNESS FAIL: Group C schedule-path expected [222, ...], got', JSON.stringify(arr)); process.exit(1); }
  if (arr[1] !== JSON.stringify([{ a: 1 }])) { console.error('HARNESS FAIL: Group C element [1] (scored payload) corrupted, got', arr[1]); process.exit(1); }
  threw = false;
  try { evalExpr(GROUP_C_OLD, new Set(['Schedule Payload']), { scored: [] }); } catch (e) { threw = true; }
  if (!threw) { console.error('HARNESS FAIL: Group C OLD pattern did not throw on schedule-only path'); process.exit(1); }

  console.log('HARNESS OK: isExecuted-guarded ternaries verified crash-proof on telegram-only, schedule-only, and neither-executed scenarios (Groups A/B/C); OLD patterns confirmed to actually throw on schedule-only (regression test is discriminating, not a no-op)');
})();

TARGETS.forEach(patch);
console.log('S20 (schedule resilience) complete.');
