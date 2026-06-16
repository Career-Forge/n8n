// Shared parseJSON (ported from command-center index.ts 319-378). Escapes literal
// \n\r\t INSIDE JSON string values only — handles LaTeX-heavy LLM output that
// strict parsers choke on. Prepended to each Parse* node by the patch script.
function parseJSON(content) {
  if (content && typeof content === 'object') return content;
  let cleaned = String(content || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    let extracted = cleaned.substring(firstBrace, lastBrace + 1);
    try { return JSON.parse(extracted); } catch (e) {}
    let fixed = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < extracted.length; i++) {
      const ch = extracted[i];
      if (escape) { fixed += ch; escape = false; continue; }
      if (ch === '\\' && inString) { fixed += ch; escape = true; continue; }
      if (ch === '"') { inString = !inString; fixed += ch; continue; }
      if (inString) {
        if (ch === '\n') { fixed += '\\n'; continue; }
        if (ch === '\r') { fixed += '\\r'; continue; }
        if (ch === '\t') { fixed += '\\t'; continue; }
      }
      fixed += ch;
    }
    fixed = fixed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    try { return JSON.parse(fixed); } catch (e) {}
  }
  const firstBracket = cleaned.indexOf('[');
  const lastBracket = cleaned.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(cleaned.substring(firstBracket, lastBracket + 1)); } catch (e) {}
  }
  return {};
}
