// Calculate ATS Score — S6b-4. Deterministic weighted scorer ported verbatim from
// command-center calculateATSScore (index.ts 1021-1160; console + frontend-compat
// fields dropped). 6 signals: semantic 35 / experience 30 / hard-req 15 / quant 10 /
// company 5 / structure 5; hard-req<8 caps total at 65. In: {signals}. Out: {ats, summary_text}.
function calculateATSScore(signals) {
  let semanticPoints = 0;
  const clusters = signals.requirement_clusters || [];
  for (const cluster of clusters) {
    const coverageScore = cluster.coverage_score || 0;
    const yearsRatio = cluster.years_required === 0 ? 1.0 : Math.min(cluster.years_evidence / cluster.years_required, 1.0);
    semanticPoints += (coverageScore / 100) * yearsRatio * 10;
  }
  const semanticCoverage = Math.min(semanticPoints, 35);

  const exp = signals.experience || { total_years: 0, relevant_years: 0, has_management: false };
  const relevanceRatio = exp.total_years > 0 ? exp.relevant_years / exp.total_years : 0;
  const managementBonus = exp.has_management ? 5 : 0;
  const experienceQuality = Math.min((relevanceRatio * 25) + managementBonus, 30);

  const dealbreakers = signals.dealbreakers || [];
  const missingDealbreakers = dealbreakers.filter((db) => !db.present);
  const missingCount = missingDealbreakers.length;
  const hardReqScore = missingCount === 0 ? 15 : missingCount === 1 ? 8 : 0;

  const quant = signals.quantification || { metrics_count: 0, relevance_score: 0 };
  const quantBase = Math.min(quant.metrics_count * 1.5, 7);
  const quantRelevance = (quant.relevance_score / 100) * 3;
  const quantification = Math.min(quantBase + quantRelevance, 10);

  const culture = signals.culture_fit || { score: 50, has_white_text_spam: false };
  let companyAlignment = (culture.score / 100) * 5;
  if (culture.has_white_text_spam) companyAlignment -= 8;
  companyAlignment = Math.max(Math.min(companyAlignment, 5), 0);

  const struct = signals.structure || { has_sections: true, score: 50 };
  const structure = struct.has_sections ? (struct.score / 100) * 5 : 0;

  let total = semanticCoverage + experienceQuality + hardReqScore + quantification + companyAlignment + structure;
  if (hardReqScore < 8) total = Math.min(total, 65);
  total = Math.round(total);

  const confidence = (semanticCoverage >= 28 && hardReqScore >= 12) ? 'high'
    : (semanticCoverage >= 21 && hardReqScore >= 8) ? 'medium' : 'low';
  const rating = total >= 85 ? 'Exceptional Match' : total >= 70 ? 'Strong Match'
    : total >= 55 ? 'Moderate Match' : total >= 40 ? 'Weak Match' : 'Poor Match';
  const gaps = [].concat(
    missingDealbreakers.map((d) => 'Missing dealbreaker: ' + d.requirement),
    clusters.filter((c) => c.coverage_score < 25).map((c) => 'Weak/missing requirement: ' + c.cluster_name)
  );

  return {
    overall_score: total,
    breakdown: {
      semanticCoverage: Math.round(semanticCoverage), experienceQuality: Math.round(experienceQuality),
      hardReqScore, quantification: Math.round(quantification),
      companyAlignment: Math.round(companyAlignment), structure: Math.round(structure),
    },
    confidence, rating, gaps,
  };
}

const signals = ($input.first().json || {}).signals || {};
const ats = calculateATSScore(signals);
const g = (ats.gaps || []).slice(0, 3);
let summary_text = '📊 *ATS ' + ats.overall_score + '/100* — ' + ats.rating
  + ' _(confidence: ' + ats.confidence + ')_';
if (g.length) summary_text += '\n\nTop gaps:\n' + g.map((x) => '• ' + x).join('\n');
if (ats.overall_score < 70) summary_text += '\n\n↻ Regenerating an improved version to address these…';
return [{ json: { ats, summary_text } }];
