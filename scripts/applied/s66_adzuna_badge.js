/**
 * s66_adzuna_badge.js -- Adzuna jobs (source_tier: 1.5, a real number literal set
 * in Normalize Adzuna) render with NO confidence badge in the digest and are
 * silently excluded from the "Sources: X ATS · Y Curated · ..." summary line --
 * tierGlyph() and finalTierCounts (Build Telegraph Body) only have branches for
 * tiers 1/2/2.5/3, and the sibling tierCounts bucket in Aggregate Jobs has the
 * identical gap. Found while researching ATS confidence badges for the technical
 * spec report; confirmed live via the actual jsCode and the Normalize Adzuna
 * node's literal `source_tier: 1.5`.
 *
 * Fix: add a 1.5 branch everywhere the existing 4 branches appear. Picked 💰 /
 * "Structured" -- Adzuna is real structured salary+location data, distinct
 * character from the other 5 glyphs (cache/live-ATS, curated boards, career
 * pages, aggregators).
 *
 * No node count change. Run: inside the n8n container with the repo staged
 * under /tmp.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Build Telegraph Body: tierGlyph() gains a 1.5 branch ═══
const GLYPH_OLD = "function tierGlyph(t, source) { return t === 1 ? (source === 'cache' ? '🔓' : '✅') : t === 2 ? '🌿' : t === 2.5 ? '🏢' : t === 3 ? '🌐' : ''; }";
const GLYPH_NEW = "function tierGlyph(t, source) { return t === 1 ? (source === 'cache' ? '🔓' : '✅') : t === 1.5 ? '💰' : t === 2 ? '🌿' : t === 2.5 ? '🏢' : t === 3 ? '🌐' : ''; }";

// ═══ 2. Build Telegraph Body: finalTierCounts gains a 1.5 bucket + badge line ═══
const FTC_OLD =
  "const finalTierCounts = { 1: 0, 2: 0, '2.5': 0, 3: 0 };\n" +
  "for (const j of rankedJobs) {\n" +
  "  const t = j.source_tier;\n" +
  "  if (t === 1) finalTierCounts[1]++;\n" +
  "  else if (t === 2) finalTierCounts[2]++;\n" +
  "  else if (t === 2.5) finalTierCounts['2.5']++;\n" +
  "  else if (t === 3) finalTierCounts[3]++;\n" +
  "}\n" +
  "const tierBadgeParts = [];\n" +
  "if (finalTierCounts[1])     tierBadgeParts.push('✅ ' + finalTierCounts[1] + ' ATS');\n" +
  "if (finalTierCounts[2])     tierBadgeParts.push('🌿 ' + finalTierCounts[2] + ' Curated');\n" +
  "if (finalTierCounts['2.5']) tierBadgeParts.push('🏢 ' + finalTierCounts['2.5'] + ' Career');\n" +
  "if (finalTierCounts[3])     tierBadgeParts.push('🌐 ' + finalTierCounts[3] + ' Aggregator');";
const FTC_NEW =
  "const finalTierCounts = { 1: 0, '1.5': 0, 2: 0, '2.5': 0, 3: 0 };\n" +
  "for (const j of rankedJobs) {\n" +
  "  const t = j.source_tier;\n" +
  "  if (t === 1) finalTierCounts[1]++;\n" +
  "  else if (t === 1.5) finalTierCounts['1.5']++;\n" +
  "  else if (t === 2) finalTierCounts[2]++;\n" +
  "  else if (t === 2.5) finalTierCounts['2.5']++;\n" +
  "  else if (t === 3) finalTierCounts[3]++;\n" +
  "}\n" +
  "const tierBadgeParts = [];\n" +
  "if (finalTierCounts[1])     tierBadgeParts.push('✅ ' + finalTierCounts[1] + ' ATS');\n" +
  "if (finalTierCounts['1.5']) tierBadgeParts.push('💰 ' + finalTierCounts['1.5'] + ' Structured');\n" +
  "if (finalTierCounts[2])     tierBadgeParts.push('🌿 ' + finalTierCounts[2] + ' Curated');\n" +
  "if (finalTierCounts['2.5']) tierBadgeParts.push('🏢 ' + finalTierCounts['2.5'] + ' Career');\n" +
  "if (finalTierCounts[3])     tierBadgeParts.push('🌐 ' + finalTierCounts[3] + ' Aggregator');";

// ═══ 3. Aggregate Jobs: sibling tierCounts gains the same 1.5 bucket ═══
const TC_OLD =
  "const tierCounts = { 1: 0, 2: 0, '2.5': 0, 3: 0 };\n" +
  "for (const j of filtered) {\n" +
  "  const t = j.source_tier;\n" +
  "  if (t === 1) tierCounts[1]++;\n" +
  "  else if (t === 2) tierCounts[2]++;\n" +
  "  else if (t === 2.5) tierCounts['2.5']++;\n" +
  "  else if (t === 3) tierCounts[3]++;\n" +
  "}";
const TC_NEW =
  "const tierCounts = { 1: 0, '1.5': 0, 2: 0, '2.5': 0, 3: 0 };\n" +
  "for (const j of filtered) {\n" +
  "  const t = j.source_tier;\n" +
  "  if (t === 1) tierCounts[1]++;\n" +
  "  else if (t === 1.5) tierCounts['1.5']++;\n" +
  "  else if (t === 2) tierCounts[2]++;\n" +
  "  else if (t === 2.5) tierCounts['2.5']++;\n" +
  "  else if (t === 3) tierCounts[3]++;\n" +
  "}";

function replaceOnce(container, key, oldStr, newStr, label, base) {
  const val = container[key];
  const count = val.split(oldStr).length - 1;
  if (count !== 1) { console.error(`INTEGRITY FAIL ${base}: anchor "${label}" found ${count} times, expected 1`); process.exit(1); }
  container[key] = val.replace(oldStr, newStr);
}

function patch(file) {
  if (!fs.existsSync(file)) { console.log(`SKIP (missing): ${file}`); return; }
  const wf = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.basename(file);
  const N = {}; wf.nodes.forEach((n) => { N[n.name] = n; });

  if (!N['Build Telegraph Body'] || !N['Aggregate Jobs']) { console.error(`INTEGRITY FAIL ${base}: required nodes not found`); process.exit(1); }
  if (N['Build Telegraph Body'].parameters.jsCode.includes("t === 1.5 ? '💰'")) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', GLYPH_OLD, GLYPH_NEW, 'tierGlyph 1.5 branch', base);
  replaceOnce(N['Build Telegraph Body'].parameters, 'jsCode', FTC_OLD, FTC_NEW, 'finalTierCounts 1.5 bucket', base);
  replaceOnce(N['Aggregate Jobs'].parameters, 'jsCode', TC_OLD, TC_NEW, 'tierCounts 1.5 bucket', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: Adzuna (tier 1.5) badge + count wired through -- ${wf.nodes.length} nodes`);
}

// ── harness: extract the ACTUAL patched functions and prove behavior before any write ──
(function harness() {
  const tierGlyph = new Function('return ' + GLYPH_NEW)();

  if (tierGlyph(1.5, 'adzuna') !== '💰') { console.error('HARNESS FAIL: tier 1.5 should render 💰'); process.exit(1); }
  if (tierGlyph(1, 'cache') !== '🔓') { console.error('HARNESS FAIL: tier 1/cache regressed'); process.exit(1); }
  if (tierGlyph(1, 'live') !== '✅') { console.error('HARNESS FAIL: tier 1/live regressed'); process.exit(1); }
  if (tierGlyph(2, '') !== '🌿') { console.error('HARNESS FAIL: tier 2 regressed'); process.exit(1); }
  if (tierGlyph(2.5, '') !== '🏢') { console.error('HARNESS FAIL: tier 2.5 regressed'); process.exit(1); }
  if (tierGlyph(3, '') !== '🌐') { console.error('HARNESS FAIL: tier 3 regressed'); process.exit(1); }
  if (tierGlyph(4, '') !== '') { console.error('HARNESS FAIL: unknown tier should still be empty'); process.exit(1); }

  // Extract and run the actual finalTierCounts + badge-building block against a fixture.
  const rankedJobs = [
    { source_tier: 1 }, { source_tier: 1 }, { source_tier: 1.5 }, { source_tier: 1.5 }, { source_tier: 1.5 },
    { source_tier: 2 }, { source_tier: 2.5 }, { source_tier: 3 }, { source_tier: 3 }, { source_tier: 3 },
  ];
  const fn = new Function('rankedJobs', FTC_NEW + '\nreturn tierBadgeParts.join(" · ");');
  const line = fn(rankedJobs);
  if (!line.includes('💰 3 Structured')) { console.error('HARNESS FAIL: badge line missing Structured count', line); process.exit(1); }
  if (!line.includes('✅ 2 ATS') || !line.includes('🌿 1 Curated') || !line.includes('🏢 1 Career') || !line.includes('🌐 3 Aggregator')) {
    console.error('HARNESS FAIL: other tier counts regressed', line); process.exit(1);
  }

  // Aggregate Jobs' sibling tierCounts block, same fixture shape (filtered instead of rankedJobs).
  const fn2 = new Function('filtered', TC_NEW + '\nreturn tierCounts;');
  const tc = fn2(rankedJobs);
  if (tc['1.5'] !== 3) { console.error('HARNESS FAIL: Aggregate Jobs tierCounts 1.5 bucket wrong', tc); process.exit(1); }
  if (tc[1] !== 2 || tc[2] !== 1 || tc['2.5'] !== 1 || tc[3] !== 3) { console.error('HARNESS FAIL: Aggregate Jobs tierCounts regressed', tc); process.exit(1); }

  console.log('HARNESS OK: tierGlyph 1.5 branch correct + all 5 existing branches unchanged; finalTierCounts and Aggregate Jobs tierCounts both bucket+badge tier 1.5 correctly');
})();

TARGETS.forEach(patch);
console.log('S66 (Adzuna tier-1.5 confidence badge) complete.');
