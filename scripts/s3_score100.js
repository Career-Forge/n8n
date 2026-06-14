/**
 * s3_score100.js — S3: /100 research-augmented composite scoring (explainable).
 *
 * - JobScorer LLM now also returns skills_score / experience_score / workauth_score
 *   (0-100); the structured parser + Parse Scorer Output carry them.
 * - Parse Scorer Output gains a deterministic composite pass: per job it computes
 *   sub_scores {skills, experience, workauth, location, company_health, compensation},
 *   a weighted score100 (35/20/15/10/10/10), an ordinal bin, and the bottleneck
 *   (weakest dimension). Location from S2c2 location_match; compensation from real
 *   salary (S2d) vs requested floor; company_health neutral 60 until S5.
 * - Digest shows NN/100 + sub-score breakdown + weakest dimension + currency-aware
 *   salary (₹ lakhs for INR). Record Matches stores /100.
 *
 * Folded into Parse Scorer Output (no new node / no rewiring). split/join for all
 * BTB edits (the salary helper contains '$', which String.replace would mangle).
 * Run: node scripts/s3_score100.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

const SCORES_BLOCK =
  "\n\n## Sub-scores (0-100 each) — for the explainable /100 composite\n" +
  "In ADDITION to fit_score, return three 0-100 integer sub-scores per job:\n" +
  "- skills_score: how well the candidate's skills match the JD's implied requirements.\n" +
  "- experience_score: role / seniority / domain-experience alignment.\n" +
  "- workauth_score: work-authorization fit — if the candidate needs sponsorship, does this employer likely sponsor? (large/established firms higher, tiny startups lower; unknown → 60).\n" +
  "Output item shape now: { \"job_id\", \"fit_score\" (0-10), \"skills_score\", \"experience_score\", \"workauth_score\" (0-100), \"detected_location\", \"location_match\", \"one_liner\" }";

const COMPOSITE_CODE =
`// S3: deterministic /100 composite with explainable sub-scores
const _eq = (() => { try { return $('Parse Expand Query').first().json || {}; } catch(_) { return {}; } })();
const _floor = Number(_eq.salary_min || (_eq.compensation && _eq.compensation.salary_min) || 0) || 0;
const _clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const _W = { skills: 0.35, experience: 0.20, workauth: 0.15, location: 0.10, company_health: 0.10, compensation: 0.10 };
const _locMap = { match: 100, unknown: 60, mismatch: 20 };
function _comp(job) { if (!_floor) return 60; const lo = job && job.salary_min; if (!lo) return 60; if (lo >= _floor) return 100; return Math.max(20, Math.round((lo / _floor) * 100)); }
scored = scored.map(s => {
  const job = jobById[s.job_id] || {};
  const base = (Number(s.fit_score) || 0) * 10;
  const sub = {
    skills: _clamp(s.skills_score != null ? s.skills_score : base),
    experience: _clamp(s.experience_score != null ? s.experience_score : base),
    workauth: _clamp(s.workauth_score != null ? s.workauth_score : base),
    location: (_locMap[s.location_match] != null ? _locMap[s.location_match] : 60),
    company_health: 60,
    compensation: _comp(job)
  };
  const score100 = Math.round(sub.skills*_W.skills + sub.experience*_W.experience + sub.workauth*_W.workauth + sub.location*_W.location + sub.company_health*_W.company_health + sub.compensation*_W.compensation);
  let _bn = null, _bv = 101; for (const k of Object.keys(sub)) { if (sub[k] < _bv) { _bv = sub[k]; _bn = k; } }
  const bin = score100 >= 70 ? 'Strong' : score100 >= 55 ? 'Good' : score100 >= 40 ? 'Mixed' : 'Poor';
  return Object.assign({}, s, { sub_scores: sub, score100: score100, bin: bin, bottleneck: _bn });
});
`;

const NEW_SALARY =
  "function salaryStr(job) { const lo = job.salary_min, hi = job.salary_max; if (!lo && !hi) return ''; const sym = {USD:'$',INR:'₹',GBP:'£',EUR:'€',AUD:'A$',CAD:'C$',SGD:'S$',CHF:'CHF ',NZD:'NZ$',ZAR:'R',BRL:'R$',MXN:'MX$',PLN:'zł '}[job.salary_currency] || (job.salary_currency ? job.salary_currency + ' ' : '$'); const lakh = job.salary_currency === 'INR'; const f = lakh ? (n => { const v = n/100000; return (v % 1 ? v.toFixed(1) : v) + 'L'; }) : (n => n >= 1000 ? (Math.round(n/1000) + 'k') : ('' + n)); return sym + ((lo && hi) ? (f(lo) + '–' + f(hi)) : (f(lo || hi) + '+')); }";

const OLD_SALARY =
  "function salaryStr(job) { const lo = job.salary_min, hi = job.salary_max; if (!lo && !hi) return ''; const f = n => n >= 1000 ? ('$' + Math.round(n/1000) + 'k') : ('$' + n); return (lo && hi) ? (f(lo) + '–' + f(hi)) : (f(lo || hi) + '+'); }";

const SUBSCORE_PUSH =
  "if (job.one_liner) contentNodes.push({ tag: 'blockquote', children: [job.one_liner] });\n" +
  "  if (job.sub_scores) { const ss = job.sub_scores; contentNodes.push({ tag: 'p', children: [{ tag: 'i', children: ['Skills ' + ss.skills + ' · Exp ' + ss.experience + ' · Visa ' + ss.workauth + ' · Loc ' + ss.location + ' · Comp ' + ss.compensation + (job.bottleneck ? ' — weakest: ' + job.bottleneck : '')] }] }); }";

function sj(s, a, b) { return s.split(a).join(b); }

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });
  const base = path.basename(file);

  // 1) JobScorer prompt — request sub-scores
  const js = N['JobScorer'];
  if (js) { const mv = js.parameters.messages.messageValues[0]; if (!mv.message.includes('skills_score')) mv.message += SCORES_BLOCK; }

  // 2) Scorer Output Parser schema — add sub-score fields
  const sop = N['Scorer Output Parser'];
  if (sop && !sop.parameters.inputSchema.includes('skills_score')) {
    sop.parameters.inputSchema = sj(sop.parameters.inputSchema,
      '"location_match": {"type": "string"}}',
      '"location_match": {"type": "string"}, "skills_score": {"type": "integer"}, "experience_score": {"type": "integer"}, "workauth_score": {"type": "integer"}}');
  }

  // 3) Parse Scorer Output — carry sub-scores + composite pass
  const pso = N['Parse Scorer Output'];
  if (pso) {
    let code = pso.parameters.jsCode;
    if (!code.includes('skills_score:')) {
      code = sj(code,
        "location_match: (['match','mismatch','unknown'].indexOf(s.location_match) !== -1 ? s.location_match : 'unknown')\n  }));",
        "location_match: (['match','mismatch','unknown'].indexOf(s.location_match) !== -1 ? s.location_match : 'unknown'),\n    skills_score: (s.skills_score != null ? Number(s.skills_score) : null),\n    experience_score: (s.experience_score != null ? Number(s.experience_score) : null),\n    workauth_score: (s.workauth_score != null ? Number(s.workauth_score) : null)\n  }));");
    }
    if (!code.includes('score100')) {
      code = sj(code,
        "return [{ json: { scored, total: scored.length, strategy, parse_error: parseError } }];",
        COMPOSITE_CODE + "return [{ json: { scored, total: scored.length, strategy, parse_error: parseError } }];");
    }
    pso.parameters.jsCode = code;
  }

  // 4) Record Matches — store /100
  const rm = N['Record Matches'];
  if (rm && rm.parameters.query.includes("(s->>'fit_score')::real)/10.0")) {
    rm.parameters.query = sj(rm.parameters.query,
      "((s->>'fit_score')::real)/10.0",
      "(COALESCE((s->>'score100')::real, (s->>'fit_score')::real*10))/100.0");
  }

  // 5) Build Telegraph Body — /100 + sub-scores + currency salary
  const btb = N['Build Telegraph Body'];
  if (btb) {
    let c = btb.parameters.jsCode;
    c = sj(c, "function scoreEmoji(s) { return s >= 8 ? '🟢' : s >= 6 ? '🟡' : '⚪'; }",
              "function scoreEmoji(s) { return s >= 70 ? '🟢' : s >= 55 ? '🟡' : '⚪'; }");
    c = sj(c, OLD_SALARY, NEW_SALARY);
    c = sj(c,
      "fit_score: s.fit_score, one_liner: s.one_liner, detected_location: s.detected_location, location_match: s.location_match }))",
      "fit_score: s.fit_score, one_liner: s.one_liner, detected_location: s.detected_location, location_match: s.location_match, score100: s.score100, sub_scores: s.sub_scores, bottleneck: s.bottleneck, bin: s.bin }))");
    c = sj(c, "const scoreDiff = (b.fit_score || 0) - (a.fit_score || 0);",
              "const scoreDiff = (b.score100 || 0) - (a.score100 || 0);");
    c = sj(c, "const score = job.fit_score || 0;",
              "const score = (job.score100 != null) ? job.score100 : (job.fit_score || 0) * 10;");
    c = sj(c, "metaParts.push(score + '/10');", "metaParts.push(score + '/100');");
    c = sj(c, "if (job.one_liner) contentNodes.push({ tag: 'blockquote', children: [job.one_liner] });", SUBSCORE_PUSH);
    c = sj(c, "(job.fit_score || 0) + '/10 — '",
              "((job.score100 != null) ? job.score100 : (job.fit_score || 0) * 10) + '/100 — '");
    btb.parameters.jsCode = c;
  }

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: S3 /100 scoring applied`);
}

TARGETS.forEach(patch);
console.log('S3 patch complete.');
