/**
 * s50_title_backstop_data.js -- makes the s49 title backstop actually fire.
 *
 * The backstop (resolveMasterExperienceTitleV2 in the Assemble twins) reads
 * $('Prepare Apply Context').resume_structured.experience -- but Select
 * Relevant Resume Bubbles REPLACES resume_structured with a minimizedResume
 * that has NO experience array (verified against real execution 251:
 * resume_structured keys at Prepare Apply Context = [compact_views,
 * education, kind, personal, profile, raw_text_available, schema_version,
 * selected_bubble_ids, skills]). masterExperienceRowsV2() therefore returned
 * [] on every real apply and every title silently fell back to Pass1's
 * paraphrase -- the backstop was correct logic wired to a data source that
 * doesn't exist in production. (Same failure class as the s42 resume_text
 * overwrite: a downstream minimizer undoing an upstream assumption.)
 *
 * Fix: minimizedResume carries a slim experience array -- title, company,
 * dates, is_current, and the first 4 bullets truncated to 140 chars each
 * (bullet overlap is the matcher's strongest signal, worth the ~3KB).
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

const MIN_OLD =
  "const minimizedResume = {\n" +
  "  kind: r.kind || 'structured',\n" +
  "  schema_version: r.schema_version || 'unknown',\n" +
  "  personal: r.personal || r.profile || {},\n" +
  "  profile: r.profile || r.personal || {},\n" +
  "  skills: r.skills || {},\n" +
  "  education: arr(r.education).slice(0, 4),\n" +
  "  compact_views: r.compact_views || {},\n" +
  "  selected_bubble_ids: Array.from(selectedIds),\n" +
  "  raw_text_available: Boolean(r.raw_text)\n" +
  "};";

const MIN_NEW =
  "const minimizedResume = {\n" +
  "  kind: r.kind || 'structured',\n" +
  "  schema_version: r.schema_version || 'unknown',\n" +
  "  personal: r.personal || r.profile || {},\n" +
  "  profile: r.profile || r.personal || {},\n" +
  "  skills: r.skills || {},\n" +
  "  education: arr(r.education).slice(0, 4),\n" +
  "  // s50: slim experience rows for the title-integrity backstop in the Assemble\n" +
  "  // twins (masterExperienceRowsV2) -- title/company/dates + a few truncated\n" +
  "  // bullets for overlap matching. Without this the backstop's data source\n" +
  "  // doesn't exist at merge time (verified against real execution data).\n" +
  "  experience: arr(r.experience).slice(0, 10).map(e => ({\n" +
  "    title: e.title || '',\n" +
  "    company: e.company || '',\n" +
  "    organization: e.organization || '',\n" +
  "    start_date: e.start_date || null,\n" +
  "    end_date: e.end_date || null,\n" +
  "    is_current: !!e.is_current,\n" +
  "    bullets: arr(e.bullets).slice(0, 4).map(b => String(b).slice(0, 140))\n" +
  "  })),\n" +
  "  compact_views: r.compact_views || {},\n" +
  "  selected_bubble_ids: Array.from(selectedIds),\n" +
  "  raw_text_available: Boolean(r.raw_text)\n" +
  "};";

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const n = wf.nodes.find((x) => x.name === 'Select Relevant Resume Bubbles');
  if (!n) { console.error(`INTEGRITY FAIL ${base}: node not found`); process.exit(1); }
  if (n.parameters.jsCode.includes('s50: slim experience rows')) { console.log(`  ${base}: already patched`); return; }
  const count = n.parameters.jsCode.split(MIN_OLD).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: minimizedResume anchor found ${count} times`); process.exit(1); }
  n.parameters.jsCode = n.parameters.jsCode.replace(MIN_OLD, MIN_NEW);
  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: slim experience added to minimizedResume`);
}

// ── harness ──
(function harness() {
  // 1. Slim construction from a realistic master doc.
  const arr = (x) => (Array.isArray(x) ? x : []);
  const buildSlim = new Function('r', 'arr', 'selectedIds',
    MIN_NEW.replace('const minimizedResume =', 'return') );
  const master = {
    kind: 'resume_bubbles', schema_version: '2.0', personal: { name: 'P' }, profile: { name: 'P' },
    skills: {}, education: [], compact_views: {}, raw_text: 'x',
    experience: [
      { title: 'Data Scientist / AI Engineer', company: '', organization: 'New Jersey Institute of Technology', start_date: '2025-03', end_date: '2026-03', is_current: false, bullets: ['Developed specialized transformer architecture mapping fMRI signals to functional brain regions achieving 94% classification accuracy across multiple cohorts', 'Engineered LLAMA 3.2 3B powered RAG pipeline with spatial-aware embeddings for neuroimaging'] },
      { title: 'R&D Software Engineer', company: 'Dassault Systèmes', organization: '', start_date: '2020-04', end_date: '2022-07', is_current: false, bullets: ['Fixed 10+ critical memory bugs in CATIA apps using C/C++ and profilers, cutting crash rates by 20%'] },
    ],
  };
  const slim = buildSlim(master, arr, new Set(['b1']));
  if (!Array.isArray(slim.experience) || slim.experience.length !== 2) { console.error('HARNESS FAIL: slim experience missing'); process.exit(1); }
  if (slim.experience[0].title !== 'Data Scientist / AI Engineer') { console.error('HARNESS FAIL: title not carried'); process.exit(1); }
  if (slim.experience[0].bullets[0].length > 140) { console.error('HARNESS FAIL: bullets not truncated'); process.exit(1); }
  console.log('HARNESS OK: minimizedResume carries slim experience rows (titles, dates, 4x140-char bullets)');

  // 2. END-TO-END: the actual live backstop functions (extracted from the patched
  //    workflow of the s49 commit) restore the stored NJIT title from the slim shape.
  const file = TARGETS.find((f) => fs.existsSync(f));
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const code = wf.nodes.find((x) => x.name === 'Assemble Resume LaTeX').parameters.jsCode;
  function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start === -1) { console.error('HARNESS FAIL: live node missing fn ' + name + ' (is the s49 title backstop applied?)'); process.exit(1); }
    let depth = 0, i = src.indexOf('{', start), j = i;
    for (;;) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; if (depth === 0) break; j++; }
    return src.slice(start, j + 1);
  }
  const fns = new Function(
    ['normKeyV2', 'normTextV2', 'dateKeyV2', 'datesCompatibleV2', 'achievementOverlapV2', 'resolveMasterExperienceTitleV2']
      .map((f) => extractFn(code, f)).join('\n') + '\nreturn { resolveMasterExperienceTitleV2, normKeyV2, dateKeyV2 };'
  )();

  // rows exactly as masterExperienceRowsV2 would build them FROM THE SLIM SHAPE
  const rows = slim.experience.map((e) => ({
    title: e.title,
    company: e.company || e.organization || '',
    companyKey: fns.normKeyV2(e.company || e.organization || ''),
    startKey: fns.dateKeyV2(e.start_date),
    endKey: fns.dateKeyV2(e.is_current ? 'present' : e.end_date),
    bullets: e.bullets,
  }));

  // The real bug: Pass1 paraphrased the NJIT title to "ML / AI Engineer" but kept
  // verbatim keyAchievements. The backstop must restore the stored title.
  const pos = {
    title: 'ML / AI Engineer',
    startDate: 'Mar 2025', endDate: 'Mar 2026',
    keyAchievements: ['Developed specialized transformer architecture mapping fMRI signals to functional brain regions achieving 94% classification accuracy across multiple cohorts'],
  };
  const resolved = fns.resolveMasterExperienceTitleV2(pos, 'New Jersey Institute of Technology', rows);
  if (resolved !== 'Data Scientist / AI Engineer') { console.error('HARNESS FAIL: backstop did not restore stored NJIT title, got', JSON.stringify(resolved)); process.exit(1); }

  // Wrong-company position must NOT get NJIT's title.
  const posOther = { title: 'Platform Engineer', startDate: 'Jan 2018', endDate: 'Dec 2018', keyAchievements: ['Completely unrelated work on billing systems'] };
  const resolvedOther = fns.resolveMasterExperienceTitleV2(posOther, 'Acme Corp', rows);
  if (resolvedOther !== 'Platform Engineer') { console.error('HARNESS FAIL: unmatched position must keep its own title, got', resolvedOther); process.exit(1); }

  // REGRESSION (the inert case this script exists to fix): empty rows -> fallback.
  const inert = fns.resolveMasterExperienceTitleV2(pos, 'New Jersey Institute of Technology', []);
  if (inert !== 'ML / AI Engineer') { console.error('HARNESS FAIL: empty rows should fall back'); process.exit(1); }

  console.log('HARNESS OK: end-to-end with the LIVE backstop functions -- slim rows restore "Data Scientist / AI Engineer" over the paraphrase, unmatched companies keep their own titles, empty rows (the pre-s50 production state) fall back gracefully');
})();

TARGETS.forEach(patch);
console.log('S50 (title backstop data source) complete.');
