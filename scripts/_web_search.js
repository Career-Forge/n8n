// ═══════════════════════════════════════════════════════════════
// Web Search — Multi-provider search via require('https')
// Checks env vars, calls all configured providers, normalizes results
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const ctx = $input.first().json;
const queries = ctx.queries || [];

function httpReq(method, url, headers, body) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const opts = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: { ...headers, 'Content-Type': 'application/json' }
      };
      const req = https.request(opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve({}); }
        });
      });
      req.on('error', () => resolve({}));
      req.setTimeout(15000, () => { req.destroy(); resolve({}); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    } catch { resolve({}); }
  });
}

const allResults = [];
const serperKey = $env.SERPER_API_KEY || '';
const youcomKey = $env.YOUCOM_API_KEY || '';
const firecrawlKey = $env.FIRECRAWL_API_KEY || '';

if (!serperKey && !youcomKey && !firecrawlKey) {
  return [{ json: {
    ...ctx,
    search_results: [],
    search_error: 'No search providers configured. Set SERPER_API_KEY, YOUCOM_API_KEY, or FIRECRAWL_API_KEY in n8n environment variables.'
  }}];
}

// Serper (most reliable, simplest API)
if (serperKey) {
  for (const q of queries) {
    try {
      const resp = await httpReq('POST', 'https://google.serper.dev/search',
        { 'X-API-KEY': serperKey }, { q, num: 10 });
      const results = (resp.organic || []).map(r => ({
        url: r.link, title: r.title || '', snippet: r.snippet || '', content: ''
      }));
      allResults.push({ source: 'serper', query: q, results });
    } catch { /* skip failed query */ }
  }
}

// You.com (includes full page content via livecrawl)
if (youcomKey) {
  for (const q of queries) {
    try {
      const resp = await httpReq('GET',
        'https://api.ydc-index.io/search?query=' + encodeURIComponent(q) + '&num_web_results=10',
        { 'X-API-Key': youcomKey }, null);
      const results = (resp.hits || []).slice(0, 10).map(r => ({
        url: r.url || '', title: r.title || '',
        snippet: r.description || (r.snippets ? r.snippets[0] : '') || '',
        content: (r.snippets || []).join('\n') || ''
      }));
      allResults.push({ source: 'youcom', query: q, results });
    } catch { /* skip failed query */ }
  }
}

// Firecrawl (full markdown content)
if (firecrawlKey) {
  for (const q of queries) {
    try {
      const resp = await httpReq('POST', 'https://api.firecrawl.dev/v1/search',
        { 'Authorization': 'Bearer ' + firecrawlKey }, { query: q, limit: 10 });
      const results = (resp.data || []).map(r => ({
        url: r.url || '', title: (r.metadata && r.metadata.title) || '',
        snippet: (r.metadata && r.metadata.description) || '',
        content: r.markdown || ''
      }));
      allResults.push({ source: 'firecrawl', query: q, results });
    } catch { /* skip failed query */ }
  }
}

return [{ json: {
  ...ctx,
  search_results: allResults,
  search_error: allResults.length === 0 ? 'All search queries failed. Check API keys and quotas.' : null
}}];
