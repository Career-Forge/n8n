/**
 * s49_title_backstop.js -- deterministic title integrity backstop.
 *
 * Pass1 can rewrite a stored position title to fit the JD despite prompt rules.
 * The rendered resume should use the user's uploaded master data for titles.
 *
 * Fix: in the shared apply assembler nodes, resolve each rendered experience
 * title from Prepare Apply Context's resume_structured.experience. Matching
 * prefers verbatim keyAchievement/bullet overlap, then company/date signals.
 *
 * Run: node scripts/s49_title_backstop.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];
const LATEX_NODES = ['Assemble Resume LaTeX', 'Assemble Regen'];

const HELPER = `function normKeyV2(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function normTextV2(value) {
  return normKeyV2(value).replace(/\\s+/g, ' ');
}
function dateKeyV2(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s) return '';
  if (/present|current/.test(s)) return 'present';
  const ym = s.match(/\\b((?:19|20)\\d{2})[-/](0?[1-9]|1[0-2])\\b/);
  if (ym) return ym[1] + '-' + String(Number(ym[2])).padStart(2, '0');
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12' };
  const my = s.match(/\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\s+((?:19|20)\\d{2})\\b/);
  if (my) return my[2] + '-' + months[my[1]];
  const y = s.match(/\\b((?:19|20)\\d{2})\\b/);
  return y ? y[1] : '';
}
function datesCompatibleV2(a, b) {
  return !!(a && b && (a === b || (a.length === 4 && b.startsWith(a)) || (b.length === 4 && a.startsWith(b))));
}
function masterExperienceRowsV2() {
  let r = {};
  try { r = ($('Prepare Apply Context').first().json || {}).resume_structured || {}; } catch (e) { r = {}; }
  return (Array.isArray(r.experience) ? r.experience : []).map((e) => ({
    title: e.title || '',
    company: e.company || e.organization || '',
    companyKey: normKeyV2(e.company || e.organization || ''),
    startKey: dateKeyV2(e.start_date || e.startDate),
    endKey: dateKeyV2(e.is_current ? 'present' : (e.end_date || e.endDate)),
    bullets: Array.isArray(e.bullets) ? e.bullets : [],
  })).filter((e) => e.title);
}
function achievementOverlapV2(pos, row) {
  const pass1 = (Array.isArray(pos.keyAchievements) ? pos.keyAchievements : []).map(normTextV2).filter((s) => s.length > 30);
  const master = (Array.isArray(row.bullets) ? row.bullets : []).map(normTextV2).filter((s) => s.length > 30);
  let score = 0;
  for (const a of pass1) {
    for (const b of master) {
      const as = a.slice(0, Math.min(90, a.length));
      const bs = b.slice(0, Math.min(90, b.length));
      if (a.includes(bs) || b.includes(as)) score++;
    }
  }
  return score;
}
function resolveMasterExperienceTitleV2(pos, companyName, rows) {
  const fallback = pos.title || '';
  if (!rows.length) return fallback;
  const companyKey = normKeyV2(companyName || pos.company || pos.organization || '');
  const start = dateKeyV2(pos.startDate || pos.start_date);
  const end = dateKeyV2(pos.endDate || pos.end_date);
  const scored = rows.map((row) => {
    const companyMatch = companyKey && row.companyKey && (row.companyKey === companyKey || row.companyKey.includes(companyKey) || companyKey.includes(row.companyKey));
    const dateMatch = datesCompatibleV2(start, row.startKey) || datesCompatibleV2(end, row.endKey);
    const ach = achievementOverlapV2(pos, row);
    return { row, score: (ach * 10) + (companyMatch ? 4 : 0) + (dateMatch ? 3 : 0) + (normKeyV2(fallback) === normKeyV2(row.title) ? 1 : 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return fallback;
  if (scored[0].score >= 10) return scored[0].row.title || fallback;
  if (scored[0].score >= 7 && (!scored[1] || scored[0].score > scored[1].score)) return scored[0].row.title || fallback;
  return fallback;
}
`;

const MERGE_ANCHOR = 'function mergeContent(pass1, pass2) {';
const P2_BLOCK_OLD =
  "  const p2exp = indexByPositionIdV2(pass2.experience_bullets);\n" +
  "  const p2int = indexByPositionIdV2(pass2.internship_bullets);\n" +
  "  const p2proj = indexByPositionIdV2(pass2.project_bullets);\n";
const P2_BLOCK_NEW = P2_BLOCK_OLD + "  const masterRows = masterExperienceRowsV2();\n";
const PUSH_OLD = "      experience.push({ title: pos.title || '', company: comp.company || '', startDate: pos.startDate || '', endDate: pos.endDate || '', location: pos.location || '', bullets });";
const PUSH_NEW = "      experience.push({ title: resolveMasterExperienceTitleV2(pos, comp.company, masterRows), company: comp.company || '', startDate: pos.startDate || '', endDate: pos.endDate || '', location: pos.location || '', bullets });";

function replaceOnce(container, oldStr, newStr, label, base) {
  const count = container.jsCode.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`INTEGRITY FAIL ${base}: ${label} anchor found ${count} times`);
    process.exit(1);
  }
  container.jsCode = container.jsCode.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {};
  wf.nodes.forEach((n) => { N[n.name] = n; });

  for (const name of LATEX_NODES) {
    if (!N[name]) { console.error(`INTEGRITY FAIL ${base}: node "${name}" missing`); process.exit(1); }
    if (N[name].parameters.jsCode.includes('resolveMasterExperienceTitleV2')) continue;
    replaceOnce(N[name].parameters, MERGE_ANCHOR, HELPER + MERGE_ANCHOR, `${name} helper`, base);
    replaceOnce(N[name].parameters, P2_BLOCK_OLD, P2_BLOCK_NEW, `${name} masterRows`, base);
    replaceOnce(N[name].parameters, PUSH_OLD, PUSH_NEW, `${name} title push`, base);
  }

  if (N['Assemble Resume LaTeX'].parameters.jsCode !== N['Assemble Regen'].parameters.jsCode) {
    console.error(`INTEGRITY FAIL ${base}: Assemble twins diverged after s49`);
    process.exit(1);
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: title backstop applied`);
}

TARGETS.forEach(patch);
console.log('S49 title backstop complete.');
