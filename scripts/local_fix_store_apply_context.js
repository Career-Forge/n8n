/**
 * local_fix_store_apply_context.js — fix the apply-flow crash at "Store Apply Context".
 *
 * Root cause (verified from execution #20): S6b-2/S6c deleted the single-phase
 * ResumeForge/CoverForge nodes and S6c fixed the dangling refs in "Save Apply Context"
 * — but MISSED "Store Apply Context" (the final done-message node after Merge PDFs).
 * Its unguarded $('ResumeForge')/$('CoverForge') refs throw "Referenced node doesn't
 * exist", killing the ✅ Done message and the staticData.last_apply write that the
 * revise/track/score/salary/draft flows all read.
 *
 * Fix: read the 2-phase outputs (Parse Pass2 / Parse Cover Pass2) with the same
 * guarded best-effort pattern S6c used in Save Apply Context. Both nodes are upstream
 * of Merge PDFs so they've always run by the time this node fires; guards for safety.
 *
 * Also: "Finalize Enriched Contact" still referenced $('Hunter Verify') (removed by
 * local_remove_hunter_bind_apollo.js). It was inside try/catch so it never crashed,
 * but the dead ref is replaced with an inert stub to avoid future confusion.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const STORE_NEW = `// Store Apply Context — fixed: S6b-2 deleted ResumeForge/CoverForge; read the
// 2-phase outputs instead (guarded, mirrors S6c's Save Apply Context fix).
const staticData = $getWorkflowStaticData('global');
const ctx = $('Prepare Apply Context').first().json;
let resumeJson = null;
try { const p = $('Parse Pass2').first().json || {}; resumeJson = p.pass2 || p || null; } catch (e) { resumeJson = null; }
let coverJson = null;
try { coverJson = $('Parse Cover Pass2').first().json || null; } catch (e) { coverJson = null; }
staticData.last_apply = { job_id: ctx.job_number, job_title: ctx.job_title, company: ctx.company, seniority_mode: ctx.seniority_mode, resume_json: resumeJson, cover_json: coverJson, forge_score: ctx.forge_score || null, skeleton_mode: ctx.seniority_mode, resume_text: ctx.resume_text || '', personal: ctx.personal || {}, resume_skeleton: ctx.resume_skeleton || '', cover_skeleton: ctx.cover_skeleton || '', job_description: ctx.job_description || '', location: ctx.location || '', timestamp: new Date().toISOString() };
return [{ json: { chat_id: ctx.chat_id, message: "\\u2705 *Done!* Resume and cover letter delivered.\\n\\nReply with changes ('shorter', 'more Python', 'swap bullet 2') or 'track' to save this application." } }];`;

const HUNTER_OLD = "const h = $('Hunter Verify').first().json || {};";
const HUNTER_NEW = "const h = {}; // Hunter Verify removed from this deployment — email verification unavailable";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);

  const store = wf.nodes.find((n) => n.name === 'Store Apply Context');
  if (!store) { console.error(`INTEGRITY FAIL ${base}: Store Apply Context not found`); process.exit(1); }
  if (!store.parameters.jsCode.includes("$('ResumeForge')")) {
    console.log(`  ${base}: Store Apply Context already fixed, skipping`);
  } else {
    store.parameters.jsCode = STORE_NEW;
  }

  const fin = wf.nodes.find((n) => n.name === 'Finalize Enriched Contact');
  if (!fin) { console.error(`INTEGRITY FAIL ${base}: Finalize Enriched Contact not found`); process.exit(1); }
  fin.parameters.jsCode = fin.parameters.jsCode.split(HUNTER_OLD).join(HUNTER_NEW);

  // integrity: no remaining refs to deleted nodes in any jsCode (comments excluded —
  // Save Apply Context's header comment legitimately mentions the old ResumeForge ref)
  for (const n of wf.nodes) {
    const code = ((n.parameters || {}).jsCode || '')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    for (const dead of ["$('ResumeForge')", "$('CoverForge')", "$('Hunter Verify')"]) {
      if (code.includes(dead)) { console.error(`INTEGRITY FAIL ${base}: ${n.name} still references ${dead}`); process.exit(1); }
    }
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Store Apply Context rewritten, Hunter ref stubbed — ${wf.nodes.length} nodes`);
}

// ── harness test the new Store code before touching any file ──
(function harness() {
  const sd = {};
  const mock$ = (name) => {
    const data = {
      'Prepare Apply Context': { job_number: 2, job_title: 'Senior Applied AI Engineer', company: 'celonis', seniority_mode: 'experienced', forge_score: 7.5, resume_text: 'x', personal: { name: 'P' }, resume_skeleton: 's', cover_skeleton: 'c', job_description: 'jd', location: 'Bangalore', chat_id: 123 },
      'Parse Pass2': { pass2: { fragments: ['a'] } },
      'Parse Cover Pass2': { title: 'Cover' },
    };
    if (!(name in data)) throw new Error("Referenced node doesn't exist: " + name);
    return { first: () => ({ json: data[name] }) };
  };
  const out = new Function('$input', '$', '$getWorkflowStaticData', STORE_NEW)(null, mock$, () => sd);
  if (!sd.last_apply || sd.last_apply.job_id !== 2 || !sd.last_apply.resume_json || !sd.last_apply.cover_json) {
    console.error('HARNESS FAIL: last_apply not written correctly', JSON.stringify(sd)); process.exit(1);
  }
  if (!out[0].json.message.includes('Done!') || out[0].json.chat_id !== 123) {
    console.error('HARNESS FAIL: return message wrong'); process.exit(1);
  }
  // degraded path: Parse nodes throwing must not crash
  const sd2 = {};
  const mockThrow = (name) => { if (name === 'Prepare Apply Context') return { first: () => ({ json: { chat_id: 1 } }) }; throw new Error("Referenced node doesn't exist"); };
  const out2 = new Function('$input', '$', '$getWorkflowStaticData', STORE_NEW)(null, mockThrow, () => sd2);
  if (!sd2.last_apply || sd2.last_apply.resume_json !== null || !out2[0].json.message) {
    console.error('HARNESS FAIL: degraded path'); process.exit(1);
  }
  console.log('HARNESS OK: new Store Apply Context code verified (normal + degraded paths)');
})();

TARGETS.forEach(patch);
console.log('Fix complete.');
