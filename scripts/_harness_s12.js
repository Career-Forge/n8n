/* Harness for S12 parsePostedDate. Run: node scripts/_harness_s12.js */
const fs = require('fs');
const path = require('path');
eval(fs.readFileSync(path.join(__dirname, 'nodes', '_parse_posted_date.js'), 'utf8'));

let fails = 0;
const now = Date.now();
function valid(label, raw, maxAgeDays) {
  const r = parsePostedDate(raw);
  const d = new Date(r);
  let ok = r !== '' && !isNaN(d);
  if (ok && maxAgeDays != null) { const ageDays = (now - d.getTime()) / 86400000; ok = ageDays >= -0.1 && ageDays <= maxAgeDays + 1; }
  if (!ok) fails++;
  console.log((ok ? '  ok:   ' : '  FAIL: ') + label + '  => "' + r + '"');
}
function empty(label, raw) {
  const r = parsePostedDate(raw); const ok = r === '';
  if (!ok) fails++;
  console.log((ok ? '  ok:   ' : '  FAIL: ') + label + '  => "' + r + '"');
}

console.log('[parsePostedDate]');
valid('relative: 3 days ago', '3 days ago', 4);
valid('relative: yesterday', 'yesterday', 2);
valid('relative: just posted', 'just posted', 1);
valid('relative: 2 weeks ago', '2 weeks ago', 15);
valid('relative: 5 hours ago', '5 hours ago', 1);
valid('relative: 30+ days ago', 'Posted 30+ days ago', 31);
valid('absolute: Jun 10, 2024', 'Jun 10, 2024');
valid('iso passthrough', '2024-06-18T10:00:00Z');
valid('epoch seconds', '1718000000');
valid('epoch ms number', 1718000000000);
empty('empty string', '');
empty('null', null);
empty('junk', 'asdfqwer');
empty('whitespace', '   ');

console.log(fails ? ('\n*** ' + fails + ' FAILURES ***') : '\nALL PASSED');
process.exit(fails ? 1 : 0);
