// ═══════════════════════════════════════════════════════════════
// RRF Merge — Reciprocal Rank Fusion for multi-provider search
// Adapted from PLAN.md section 6.1
// ═══════════════════════════════════════════════════════════════

const k = 60;  // RRF smoothing constant (standard)
const topN = 15;
const ctx = $input.first().json;
const allResults = ctx.search_results || [];

// Handle search errors
if (ctx.search_error) {
  return [{ json: { ...ctx, merged_results: [], result_count: 0 } }];
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']
      .forEach(p => u.searchParams.delete(p));
    return (u.origin + u.pathname.replace(/\/$/, '') + u.search).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

const fused = new Map();

for (const batch of allResults) {
  const source = batch.source;
  (batch.results || []).forEach((result, rank) => {
    if (!result.url) return;
    const key = normalizeUrl(result.url);

    const existing = fused.get(key) || {
      url: result.url,
      title: '',
      snippet: '',
      content: '',
      sources: [],
      score: 0
    };

    // RRF formula: 1 / (k + rank + 1)
    existing.score += 1 / (k + rank + 1);

    // Track which providers found this result
    if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }

    // Prefer the longest content version from any provider
    if ((result.content || '').length > existing.content.length) {
      existing.content = result.content;
    }
    // Prefer non-empty title
    if (!existing.title && result.title) {
      existing.title = result.title;
    }
    // Prefer longer snippet
    if ((result.snippet || '').length > existing.snippet.length) {
      existing.snippet = result.snippet;
    }

    fused.set(key, existing);
  });
}

// Sort by score desc, take top N
const merged = Array.from(fused.values())
  .sort((a, b) => b.score - a.score)
  .slice(0, topN);

return [{ json: {
  ...ctx,
  merged_results: merged,
  result_count: merged.length
}}];
