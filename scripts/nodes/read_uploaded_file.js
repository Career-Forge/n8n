// Read Uploaded File v1 — read an uploaded document's bytes as UTF-8 text (no fs).
// For a .json resume this yields the JSON string; for PDF/DOCX it yields garbage that
// Ingest Resume JSON will reject -> the user gets the JSON template instead.
const item = $input.first();
let extractCtx = {};
try { extractCtx = $('Extract Input').first().json || {}; } catch (e) { extractCtx = {}; }
const chatId = extractCtx.chat_id || item.json?.chat_id || null;
const fileName = String(extractCtx.document?.file_name || item.binary?.data?.fileName || '').toLowerCase();
const mimeType = String(extractCtx.document_mime_type || item.binary?.data?.mimeType || '').toLowerCase();

let buf;
try {
  buf = await this.helpers.getBinaryDataBuffer(0, 'data');
} catch (e) {
  try { const b64 = item.binary?.data?.data; if (b64) buf = Buffer.from(b64, 'base64'); } catch (_) {}
}

let text = '';
if (buf && Buffer.isBuffer(buf) && buf.length) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.slice(2).toString('utf16le');
  else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const sw = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) { sw[i - 2] = buf[i + 1]; sw[i - 1] = buf[i]; }
    text = sw.toString('utf16le');
  } else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.slice(3).toString('utf8');
  else text = buf.toString('utf8');
}

return [{ json: { chat_id: chatId, upload_text: text, file_name: fileName, mime_type: mimeType } }];
