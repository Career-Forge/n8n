/**
 * s67_registry_slug_normalize.js -- two related bugs found while auditing the
 * self-growing registry for the issues report, plus one missing auto-discovery
 * branch:
 *
 * 1. Extract Registry Candidates only decodes URI-encoding on the ashby branch
 *    and lowercases nowhere. The DB's UNIQUE (ats_type, slug) constraint is
 *    case-sensitive with no lower() index, so two runs of the same company with
 *    different URL casing insert as two separate rows. Confirmed live: company
 *    ids 15551 ("Pulsora Inc") and 15575 ("pulsora inc"), both ats_type=ashby,
 *    inserted ~3.5 hours apart, zero jobs cached under either (safe merge).
 *    Fix: normalize (decode + lowercase) once, after whichever branch matches,
 *    instead of per-branch -- single point of truth, can't regress per-branch.
 *
 * 2. The same root cause reaches further upstream: job.company itself is
 *    corrupted for this exact job ("Pulsora%20Inc" / "pulsora%20inc", literally
 *    un-decoded, confirmed live in the companies table). Root-caused to
 *    Normalize Serper results' inline `company = m[1]` (6 branches, no decode)
 *    and extractCompanyFromUrl() (shared helper, 2 copies: Normalize Firecrawl
 *    Results, Normalize You.com results) -- every branch in all 3 nodes returns
 *    a raw regex-captured URL segment with no decodeURIComponent. Fixed at the
 *    single call/assembly site in each node (not per-branch, same reasoning as
 *    above) -- company is a DISPLAY name, decode only, never lowercased (unlike
 *    slug, which exists purely as a DB dedup key).
 *
 * 3. Recruitee jobs are already classified ats:recruitee by classifyUrlTier()
 *    in all 3 normalize nodes and already have a real, working poller adapter
 *    (Build Requests' mkUrl.recruitee) -- they just have no matching branch in
 *    Extract Registry Candidates, so they can never auto-grow into permanent
 *    poller coverage the way a Greenhouse/Lever/etc job would. Added as a 7th
 *    branch, same style as the other 6.
 *
 * No node count change. Run: inside the n8n container with the repo staged
 * under /tmp. A separate one-time SQL statement (not part of this script)
 * merges the 2 existing Pulsora rows after this deploys.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  path.join(ROOT, 'docker', 'workflows', 'CareerForge Master Local v6.3.json'),
  path.join(ROOT, 'docker', 'workflows', 'CareerForge_Master_local.json'),
  path.join(ROOT, 'workflows', 'CareerForge_Master_local.json'),
];

// ═══ 1. Extract Registry Candidates: full-function replace -- normalize once, add recruitee ═══
const EC_OLD = `function extractCandidate(job) {
  const url = job.url || '';
  const label = job.tier_label || '';
  const name = String(job.company || '').trim();
  if (!name) return null;
  let m;
  if (label === 'ats:greenhouse' && (m = url.match(/(?:boards|job-boards)\\.greenhouse\\.io\\/([^\\/?#]+)/i))) {
    return { name, ats_type: 'greenhouse', slug: m[1], api_base: '' };
  }
  if (label === 'ats:lever' && (m = url.match(/jobs\\.lever\\.co\\/([^\\/?#]+)/i))) {
    return { name, ats_type: 'lever', slug: m[1], api_base: '' };
  }
  if (label === 'ats:ashby' && (m = url.match(/jobs\\.ashbyhq\\.com\\/([^\\/?#]+)/i))) {
    let slug; try { slug = decodeURIComponent(m[1]); } catch (e) { slug = m[1]; }
    return { name, ats_type: 'ashby', slug, api_base: '' };
  }
  if (label === 'ats:workday' && (m = url.match(/([\\w-]+)\\.(wd\\d+)\\.myworkdayjobs\\.com\\/(?:[a-z]{2}-[A-Z]{2}\\/)?([^\\/?#]+)/i))) {
    return { name, ats_type: 'workday', slug: m[3], api_base: m[1] + '.' + m[2] };
  }
  if (label === 'ats:smartrecruiters' && (m = url.match(/jobs\\.smartrecruiters\\.com\\/([^\\/?#]+)/i))) {
    return { name, ats_type: 'smartrecruiters', slug: m[1], api_base: '' };
  }
  if (label === 'ats:workable' && (m = url.match(/apply\\.workable\\.com\\/([^\\/?#]+)/i))) {
    return { name, ats_type: 'workable', slug: m[1], api_base: '' };
  }
  return null;
}`;

const EC_NEW = `function extractCandidate(job) {
  const url = job.url || '';
  const label = job.tier_label || '';
  const name = String(job.company || '').trim();
  if (!name) return null;
  let m, ats_type, slug, api_base = '';
  if (label === 'ats:greenhouse' && (m = url.match(/(?:boards|job-boards)\\.greenhouse\\.io\\/([^\\/?#]+)/i))) {
    ats_type = 'greenhouse'; slug = m[1];
  } else if (label === 'ats:lever' && (m = url.match(/jobs\\.lever\\.co\\/([^\\/?#]+)/i))) {
    ats_type = 'lever'; slug = m[1];
  } else if (label === 'ats:ashby' && (m = url.match(/jobs\\.ashbyhq\\.com\\/([^\\/?#]+)/i))) {
    ats_type = 'ashby'; slug = m[1];
  } else if (label === 'ats:workday' && (m = url.match(/([\\w-]+)\\.(wd\\d+)\\.myworkdayjobs\\.com\\/(?:[a-z]{2}-[A-Z]{2}\\/)?([^\\/?#]+)/i))) {
    ats_type = 'workday'; slug = m[3]; api_base = m[1] + '.' + m[2];
  } else if (label === 'ats:smartrecruiters' && (m = url.match(/jobs\\.smartrecruiters\\.com\\/([^\\/?#]+)/i))) {
    ats_type = 'smartrecruiters'; slug = m[1];
  } else if (label === 'ats:workable' && (m = url.match(/apply\\.workable\\.com\\/([^\\/?#]+)/i))) {
    ats_type = 'workable'; slug = m[1];
  } else if (label === 'ats:recruitee' && (m = url.match(/([\\w-]+)\\.recruitee\\.com/i))) {
    ats_type = 'recruitee'; slug = m[1];
  } else {
    return null;
  }
  // Normalize ONCE, regardless of which branch matched -- single point of
  // truth so a future branch can't reintroduce the case/encoding duplicate
  // bug (confirmed live: "Pulsora Inc" vs "pulsora inc" both inserted as
  // separate rows before this fix).
  try { slug = decodeURIComponent(slug); } catch (e) {}
  slug = slug.toLowerCase();
  return { name, ats_type, slug, api_base };
}`;

// ═══ 2. Normalize Serper results: decode company once, after the branch chain ═══
const SERPER_OLD = "else if ((m = url.match(/jobs\\.smartrecruiters\\.com\\/([^/?]+)/))) company = m[1];\n    const __tier = classifyUrlTier(url);";
const SERPER_NEW = "else if ((m = url.match(/jobs\\.smartrecruiters\\.com\\/([^/?]+)/))) company = m[1];\n    try { company = decodeURIComponent(company); } catch (e) {}\n    const __tier = classifyUrlTier(url);";

// ═══ 3. Normalize Firecrawl Results + Normalize You.com results: decode extractCompanyFromUrl's result ═══
const HELPER_CALL_OLD = "const company = extractCompanyFromUrl(url);";
const HELPER_CALL_NEW = "let company = extractCompanyFromUrl(url); try { company = decodeURIComponent(company); } catch (e) {}";

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

  const required = ['Extract Registry Candidates', 'Normalize Serper results', 'Normalize Firecrawl Results', 'Normalize You.com results'];
  for (const r of required) { if (!N[r]) { console.error(`INTEGRITY FAIL ${base}: node "${r}" not found`); process.exit(1); } }

  if (N['Extract Registry Candidates'].parameters.jsCode.includes("ats:recruitee")) { console.log(`  ${base}: already patched`); return; }

  replaceOnce(N['Extract Registry Candidates'].parameters, 'jsCode', EC_OLD, EC_NEW, 'extractCandidate rewrite', base);
  replaceOnce(N['Normalize Serper results'].parameters, 'jsCode', SERPER_OLD, SERPER_NEW, 'serper company decode', base);
  replaceOnce(N['Normalize Firecrawl Results'].parameters, 'jsCode', HELPER_CALL_OLD, HELPER_CALL_NEW, 'firecrawl company decode', base);
  replaceOnce(N['Normalize You.com results'].parameters, 'jsCode', HELPER_CALL_OLD, HELPER_CALL_NEW, 'youcom company decode', base);

  fs.writeFileSync(file, JSON.stringify(wf, null, 2));
  console.log(`OK ${base}: registry slug normalization + recruitee auto-discovery + company decode (3 normalize nodes) -- ${wf.nodes.length} nodes`);
}

// ── harness: extract the ACTUAL patched functions and prove behavior before any write ──
(function harness() {
  const extractCandidate = new Function('job', EC_NEW.replace('function extractCandidate(job) {', '').replace(/\}$/, ''));

  // Mixed-case, URL-encoded ashby slug -- the exact real-world shape that produced the duplicate.
  const ashbyMixed = extractCandidate({ url: 'https://jobs.ashbyhq.com/Pulsora%20Inc/abc123', tier_label: 'ats:ashby', company: 'Pulsora Inc' });
  if (ashbyMixed.slug !== 'pulsora inc') { console.error('HARNESS FAIL: ashby slug not decoded+lowercased', ashbyMixed); process.exit(1); }
  const ashbyLower = extractCandidate({ url: 'https://jobs.ashbyhq.com/pulsora%20inc/xyz789', tier_label: 'ats:ashby', company: 'pulsora inc' });
  if (ashbyLower.slug !== ashbyMixed.slug) { console.error('HARNESS FAIL: two real-world variants must now produce the SAME slug', ashbyMixed, ashbyLower); process.exit(1); }

  // All 6 pre-existing branches: name/api_base extraction unchanged, slug lowercased.
  const gh = extractCandidate({ url: 'https://boards.greenhouse.io/Stripe/jobs/123', tier_label: 'ats:greenhouse', company: 'Stripe' });
  if (gh.ats_type !== 'greenhouse' || gh.slug !== 'stripe' || gh.api_base !== '') { console.error('HARNESS FAIL: greenhouse regressed', gh); process.exit(1); }
  const lv = extractCandidate({ url: 'https://jobs.lever.co/Spotify/xyz', tier_label: 'ats:lever', company: 'Spotify' });
  if (lv.ats_type !== 'lever' || lv.slug !== 'spotify') { console.error('HARNESS FAIL: lever regressed', lv); process.exit(1); }
  const wd = extractCandidate({ url: 'https://ADOBE.wd5.myworkdayjobs.com/en-US/external_experienced', tier_label: 'ats:workday', company: 'Adobe' });
  if (wd.ats_type !== 'workday' || wd.slug !== 'external_experienced' || wd.api_base !== 'ADOBE.wd5') { console.error('HARNESS FAIL: workday regressed (api_base must stay case-preserved, only slug lowercases)', wd); process.exit(1); }
  const sr = extractCandidate({ url: 'https://jobs.smartrecruiters.com/LinkedIn3/job1', tier_label: 'ats:smartrecruiters', company: 'LinkedIn' });
  if (sr.ats_type !== 'smartrecruiters' || sr.slug !== 'linkedin3') { console.error('HARNESS FAIL: smartrecruiters regressed', sr); process.exit(1); }
  const wk = extractCandidate({ url: 'https://apply.workable.com/SomeCo/j/ABC', tier_label: 'ats:workable', company: 'SomeCo' });
  if (wk.ats_type !== 'workable' || wk.slug !== 'someco') { console.error('HARNESS FAIL: workable regressed', wk); process.exit(1); }

  // New recruitee branch.
  const rc = extractCandidate({ url: 'https://SomeTenant.recruitee.com/o/backend-engineer', tier_label: 'ats:recruitee', company: 'SomeTenant' });
  if (rc.ats_type !== 'recruitee' || rc.slug !== 'sometenant') { console.error('HARNESS FAIL: new recruitee branch wrong', rc); process.exit(1); }

  // No-match / no-company still return null.
  if (extractCandidate({ url: 'https://example.com/x', tier_label: 'ats:unknown', company: 'X' }) !== null) { console.error('HARNESS FAIL: unmatched label should return null'); process.exit(1); }
  if (extractCandidate({ url: 'https://boards.greenhouse.io/Stripe/jobs/1', tier_label: 'ats:greenhouse', company: '' }) !== null) { console.error('HARNESS FAIL: empty company should return null'); process.exit(1); }

  console.log('HARNESS OK: extractCandidate normalizes slug (decode+lowercase) uniformly across all 7 branches, new recruitee branch correct, name/api_base extraction unchanged, edge cases return null');

  // company decode: Serper's inline block + the shared extractCompanyFromUrl call-site wrap.
  const SERPER_FULL_OLD_PREFIX = "let company = 'unknown', m;\n    if ((m = url.match(/([^.\\/]+)\\.wd\\d+\\.myworkdayjobs\\.com/))) company = m[1];\n    else if ((m = url.match(/boards\\.greenhouse\\.io\\/([^/?]+)/))) company = m[1];\n    else if ((m = url.match(/jobs\\.lever\\.co\\/([^/?]+)/))) company = m[1];\n    else if ((m = url.match(/jobs\\.ashbyhq\\.com\\/([^/?]+)/))) company = m[1];\n    else if ((m = url.match(/apply\\.workable\\.com\\/([^/?]+)/))) company = m[1];\n    ";
  const serperFn = new Function('r', 'classifyUrlTier',
    "const url = r.link || ''; " + SERPER_FULL_OLD_PREFIX + SERPER_NEW + " return company;"
  );
  const decoded = serperFn({ link: 'https://jobs.ashbyhq.com/Pulsora%20Inc/abc' }, () => ({ tier: 1, label: 'ats:ashby' }));
  if (decoded !== 'Pulsora Inc') { console.error('HARNESS FAIL: Serper company not decoded', decoded); process.exit(1); }
  const unmatched = serperFn({ link: 'https://example.com/nope' }, () => ({ tier: 4, label: 'invalid' }));
  if (unmatched !== 'unknown') { console.error('HARNESS FAIL: Serper unmatched-company fallback regressed', unmatched); process.exit(1); }

  const helperWrap = new Function('url', 'extractCompanyFromUrl', HELPER_CALL_NEW + '\nreturn company;');
  const hDecoded = helperWrap('https://dummy', () => 'Pulsora%20Inc');
  if (hDecoded !== 'Pulsora Inc') { console.error('HARNESS FAIL: extractCompanyFromUrl call-site decode wrong', hDecoded); process.exit(1); }
  const hPlain = helperWrap('https://dummy', () => 'Stripe');
  if (hPlain !== 'Stripe') { console.error('HARNESS FAIL: plain (non-encoded) company regressed', hPlain); process.exit(1); }
  const hMalformed = helperWrap('https://dummy', () => 'bad%zzsequence');
  if (hMalformed !== 'bad%zzsequence') { console.error('HARNESS FAIL: malformed % sequence should fall back to raw value, not throw', hMalformed); process.exit(1); }

  console.log('HARNESS OK: company field decoded at Serper inline assembly and both extractCompanyFromUrl call sites; malformed encoding falls back safely; plain names unaffected');
})();

TARGETS.forEach(patch);
console.log('S67 (registry slug normalization + recruitee auto-discovery + company decode) complete.');
