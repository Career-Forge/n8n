// Parse Scorer Output (repurposed, S13) — turns the matcher service response into
// the `scored` array the rest of the find pipeline expects. Keeps job_id + score100
// so Record Matches (Postgres insert) and Build Telegraph Body keep working, and
// adds the match%/skill fields for the JobRight display. Dead jobs (matcher dropped)
// are already absent. Degrades to empty scored on a matcher failure (never throws).
const m = $input.first().json || {};
const results = Array.isArray(m.results) ? m.results : [];
const dropped = Array.isArray(m.dropped) ? m.dropped : [];

const scored = results.map((r) => {
  const sk = r.skill_match || {};
  const matched = sk.matched || [];
  const missing = sk.missing || [];
  const adjacent = (sk.adjacent || []).map((a) => (a && a.skill ? a.skill : a)).filter(Boolean);
  const mp = Math.max(0, Math.min(100, Math.round(r.match_pct || 0)));
  let one = '';
  if (matched.length) one = 'Matches ' + matched.slice(0, 4).join(', ') + (missing.length ? ' -- gaps: ' + missing.slice(0, 2).join(', ') : '');
  else if (adjacent.length) one = 'Transferable: ' + adjacent.slice(0, 3).join(', ');
  else if (missing.length) one = 'Missing ' + missing.slice(0, 3).join(', ');
  return {
    job_id: r.id,
    match_pct: mp,
    score100: mp,                       // Record Matches reads score100
    fit_score: Math.round(mp / 10),
    rerank: r.rerank_score != null ? r.rerank_score : null,
    skill_coverage: sk.coverage != null ? sk.coverage : 0,
    matched_skills: matched,
    missing_skills: missing,
    adjacent_skills: adjacent,
    validated: r.validated || 'not_checked',
    one_liner: one,
    bin: mp >= 70 ? 'Strong' : mp >= 55 ? 'Good' : mp >= 40 ? 'Mixed' : 'Poor',
  };
});

return [{ json: { scored, total: scored.length, strategy: 'matcher', dropped } }];
