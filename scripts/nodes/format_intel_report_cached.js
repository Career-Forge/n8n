// Auto-generated from the live workflow node "Format Intel Report (Cached)" via scripts/export_prompts.js.
// Edits here don't get read back in -- the live node is the source of truth.

// Cached counterpart of Format Intel Report -- same formatting body, sourced
// from a fresh company_intel row instead of a live CompanyIntel call. See R2
// item 5 (scripts/s34_r2_intel_cache.js) for why this is duplicated rather
// than shared.
const r = ($('Read Intel Cache').first().json || {}).dossier || {};
let chatId; try { chatId = $('Extract Input').first().json.chat_id; } catch (e) { chatId = $('Prepare Research').first().json.chat_id; }
const recIcon = r.recommendation === 'Apply' ? '✅' : r.recommendation === 'Caution' ? '⚠️' : '\u{1F6D1}';
const sections = [
  recIcon + ' *' + (r.company || 'Unknown') + ' — Health Score: ' + (r.health_score || '?') + '/100* _(cached)_',
  '_' + (r.summary || 'No summary available.') + '_', '',
  '\u{1F4CA} *Sentiment:* ' + (r.sentiment && r.sentiment.overall_mood || 'Unknown') + (r.sentiment && r.sentiment.glassdoor_rating ? ' (Glassdoor: ' + r.sentiment.glassdoor_rating + ')' : ''),
];
if (r.sentiment && r.sentiment.positives && r.sentiment.positives.length) sections.push(r.sentiment.positives.map(p => '  ✅ ' + p).join('\n'));
if (r.sentiment && r.sentiment.negatives && r.sentiment.negatives.length) sections.push(r.sentiment.negatives.map(p => '  ❌ ' + p).join('\n'));
sections.push('');
sections.push('\u{1F534} *Layoffs:* ' + (r.layoffs && r.layoffs.has_recent_layoffs ? 'Yes — ' + r.layoffs.details : 'None recent'));
sections.push('\u{1F4B0} *Funding:* ' + (r.funding && r.funding.stage || 'Unknown') + (r.funding && r.funding.last_round ? ' (' + r.funding.last_round + ')' : ''));
sections.push('\u{1F6C2} *H1B:* ' + (r.h1b && r.h1b.sponsors ? 'Yes' : 'Unknown'));
sections.push('');
if (r.green_flags && r.green_flags.length) sections.push('\u{1F7E2} *Green Flags:*\n' + r.green_flags.map(f => '• ' + f).join('\n'));
if (r.red_flags && r.red_flags.length) sections.push('\u{1F534} *Red Flags:*\n' + r.red_flags.map(f => '• ' + f).join('\n'));
return [{ json: { chat_id: chatId, message: sections.filter(Boolean).join('\n') } }];
