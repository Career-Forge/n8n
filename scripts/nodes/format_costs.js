// Format Costs — S9b. Turns the Load Costs rows (per-provider spend, last 30 days)
// into a Telegram message. Graceful when nothing is logged yet.
const chatId = $('Extract Input').first().json.chat_id;
const rows = $input.all().map((i) => i.json).filter((r) => r && r.provider);

if (!rows.length) {
  return [{ json: { chat_id: chatId, message: '💸 No tracked spend yet. Paid-provider usage (e.g. Apollo) is logged to tool_cost_log when those lanes run. LLM calls go through your OpenRouter account.' } }];
}

let total = 0, today = 0;
const lines = rows.map((r) => {
  const c = Number(r.cost || 0); total += c; today += Number(r.cost_today || 0);
  const u = Number(r.units || 0);
  return '• ' + r.provider + ': $' + c.toFixed(2) + ' — ' + r.calls + ' calls' + (u ? (', ' + u + ' units') : '');
});

const msg = '💸 *Spend — last 30 days*\n' + lines.join('\n')
  + '\n\n*Total:* $' + total.toFixed(2) + '   *Today:* $' + today.toFixed(2)
  + '\n\n_Tracked from tool_cost_log (paid providers). LLM calls are billed on your OpenRouter account._';

return [{ json: { chat_id: chatId, message: msg } }];
