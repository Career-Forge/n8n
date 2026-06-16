// Validate ATS Signals — S6b-4. parseJSON the raw extractor output, then enforce
// deterministic types + penalty defaults. Ported from command-center validateSignals
// (index.ts 933-1019; console dropped). In: chainLlm {text}. Out: {signals}.
function validateSignals(rawSignals) {
  const safeNumber = (val, dflt) => (typeof val === 'number' && !isNaN(val) && isFinite(val)) ? val : dflt;
  const safeBool = (val, dflt) => (typeof val === 'boolean') ? val : dflt;

  const clusters = (Array.isArray(rawSignals.requirement_clusters) ? rawSignals.requirement_clusters : []).map((cluster) => {
    const yearsEvidence = safeNumber(cluster.years_evidence, 0);
    const evidence = Array.isArray(cluster.evidence) ? cluster.evidence : [];
    return {
      cluster_name: cluster.cluster_name || 'Unknown',
      coverage_score: safeNumber(cluster.coverage_score, 0),
      present: safeBool(cluster.present, false),
      years_evidence: evidence.length > 0 ? yearsEvidence : 0,
      years_required: safeNumber(cluster.years_required, 0),
      evidence: evidence.slice(0, 3),
    };
  });
  const dealbreakers = (Array.isArray(rawSignals.dealbreakers) ? rawSignals.dealbreakers : []).map((db) => ({
    requirement: db.requirement || 'Unknown',
    present: safeBool(db.present, false),
  }));
  const e = rawSignals.experience || {};
  const experience = { total_years: safeNumber(e.total_years, 0), relevant_years: safeNumber(e.relevant_years, 0), has_management: safeBool(e.has_management, false) };
  const q = rawSignals.quantification || {};
  const quantification = { metrics_count: safeNumber(q.metrics_count, 0), relevance_score: safeNumber(q.relevance_score, 0) };
  const cf = rawSignals.culture_fit || {};
  const culture_fit = { score: safeNumber(cf.score, 50), has_white_text_spam: safeBool(cf.has_white_text_spam, false) };
  const st = rawSignals.structure || {};
  const structure = { has_sections: safeBool(st.has_sections, true), page_count: safeNumber(st.page_count, 1), score: safeNumber(st.score, 50) };

  return { requirement_clusters: clusters, dealbreakers, experience, quantification, culture_fit, structure };
}

// PARSEJSON_PLACEHOLDER (patch script prepends the shared parseJSON above this line)
const t = $input.first().json || {};
const raw = (t.text != null) ? t.text : ((t.output != null) ? t.output : t);
const rawSignals = parseJSON(raw);
return [{ json: { signals: validateSignals(rawSignals) } }];
