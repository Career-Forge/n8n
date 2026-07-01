// _source_policy.js -- CANONICAL n8n source policy (single source of truth).
//
// Company-direct default: company ATS + company career pages only; third-party
// boards/aggregators denied (P1). This file is the ONE place these rules live.
//
// n8n Code nodes cannot require() local files, so `node scripts/p2_source_policy.js`
// inlines the SOURCE_POLICY IIFE below (verbatim, between BEGIN/END markers) into the
// affected node files + the 3 modern workflow exports. Edit policy HERE, then re-run it.
//
// Helpers: classifyUrlTier(url) -> {tier,label}; isAtsDestination(job) -> bool (the hard
// gate, fail-closed); standardAtsDomains() -> string[] (find-time ATS includeDomains).
const SOURCE_POLICY = (function () {
  const ATS_URL = /(boards(-api)?\.greenhouse\.io|job-boards\.greenhouse\.io|greenhouse\.io|gh_jid=|jobs\.lever\.co|lever\.co|jobs\.ashbyhq\.com|ashbyhq\.com|ashby_jid=|workable\.com|recruitee\.com|smartrecruiters\.com|myworkdayjobs\.com|workday\.com|icims\.com|jobvite\.com|bamboohr\.com|breezy\.hr|teamtailor\.com|taleo\.net|successfactors|oraclecloud\.com|amazon\.jobs|jobs\.apple\.com|careers\.microsoft\.com|metacareers\.com|google\.com\/about\/careers|careers\.google\.com|netflix\.net|joinbytedance\.com|lifeattiktok\.com|eightfold)/i;
  const BOARD_DENY = /(instahyre|wellfound|angel\.co|hirist|cutshort|foundit|naukri|shine\.com|monster\.|indeed\.|glassdoor|ziprecruiter|dice\.com|simplyhired|jooble|jobgether|talent\.com|whatjobs|careerjet|jobrapido|neuvoo|trabajo|bebee|productbased|ambitionbox|expertia|linkedin\.com|remoteok|weworkremotely|himalayas\.app|remotive|jobicy|arbeitnow|remote\.co\b|flexjobs|nodesk|otta\.io|cord\.co\b)/i;
  const CAREERS_SUB = /(^|\.)(jobs|careers|career|join|work|workfor|boards|apply|talent|hire|recruiting|jobsearch)\./i;
  const CAREERS_PATH = /\/(jobs?|careers?|join|openings?|positions?|opportunities|vacancies|work-with-us|life-?at)\b/i;
  function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function classifyUrlTier(url) {
    if (!url) return { tier: 4, label: 'invalid' };
    const u = url.toLowerCase();
    // TIER 1 — Direct ATS platforms
    if (/(?:boards|job-boards)\.greenhouse\.io/.test(u)) return { tier: 1, label: 'ats:greenhouse' };
    if (/jobs\.lever\.co/.test(u)) return { tier: 1, label: 'ats:lever' };
    if (/jobs\.ashbyhq\.com/.test(u)) return { tier: 1, label: 'ats:ashby' };
    if (/[\w-]+\.wd\d+\.myworkdayjobs\.com/.test(u)) return { tier: 1, label: 'ats:workday' };
    if (/apply\.workable\.com/.test(u)) return { tier: 1, label: 'ats:workable' };
    if (/jobs\.smartrecruiters\.com/.test(u)) return { tier: 1, label: 'ats:smartrecruiters' };
    if (/workatastartup\.com\/jobs\//.test(u)) return { tier: 1, label: 'ats:yc' };
    if (/[\w-]+\.recruitee\.com/.test(u)) return { tier: 1, label: 'ats:recruitee' };
    if (/[\w-]+\.personio\.(com|de)/.test(u)) return { tier: 1, label: 'ats:personio' };
    if (/[\w-]+\.bamboohr\.com/.test(u)) return { tier: 1, label: 'ats:bamboohr' };
    if (/[\w-]+\.jobvite\.com/.test(u)) return { tier: 1, label: 'ats:jobvite' };
    if (/careers-[\w-]+\.icims\.com/.test(u)) return { tier: 1, label: 'ats:icims' };
    if (/[\w-]+\.taleo\.net/.test(u)) return { tier: 1, label: 'ats:taleo' };
    if (/successfactors\.(com|eu)/.test(u)) return { tier: 1, label: 'ats:successfactors' };
    if (/[\w-]+\.eightfold\.ai/.test(u)) return { tier: 1, label: 'ats:eightfold' };
    // TIER 2 — Curated remote/aggregator boards
    if (/weworkremotely\.com\/(remote-jobs|listings)\//.test(u)) return { tier: 2, label: 'curated:wwr' };
    if (/remoteok\.(com|io)/.test(u)) return { tier: 2, label: 'curated:remoteok' };
    if (/himalayas\.app\/jobs\//.test(u)) return { tier: 2, label: 'curated:himalayas' };
    if (/remotive\.(com|io)\/(jobs|remote-jobs)\//.test(u)) return { tier: 2, label: 'curated:remotive' };
    if (/jobicy\.com/.test(u)) return { tier: 2, label: 'curated:jobicy' };
    if (/wellfound\.com\/jobs\//.test(u)) return { tier: 2, label: 'curated:wellfound' };
    if (/arbeitnow\.com\/jobs\//.test(u)) return { tier: 2, label: 'curated:arbeitnow' };
    if (/ai-jobs\.net\/job\//.test(u)) return { tier: 2, label: 'curated:aijobs' };
    if (/builtin(nyc|sf|la|chicago|seattle|boston|austin)?\.com\/job\//.test(u)) return { tier: 2, label: 'curated:builtin' };
    // TIER 3 — General web aggregators (often listings pages, low signal)
    if (/linkedin\.com/.test(u)) return { tier: 3, label: 'aggregator:linkedin' };
    if (/indeed\.com/.test(u)) return { tier: 3, label: 'aggregator:indeed' };
    if (/glassdoor\.com/.test(u)) return { tier: 3, label: 'aggregator:glassdoor' };
    if (/ziprecruiter\.com/.test(u)) return { tier: 3, label: 'aggregator:ziprecruiter' };
    if (/dice\.com/.test(u)) return { tier: 3, label: 'aggregator:dice' };
    if (/monster\.com/.test(u)) return { tier: 3, label: 'aggregator:monster' };
    if (/simplyhired\.com/.test(u)) return { tier: 3, label: 'aggregator:simplyhired' };
    if (/careerbuilder\.com/.test(u)) return { tier: 3, label: 'aggregator:careerbuilder' };
    if (/snagajob\.com/.test(u)) return { tier: 3, label: 'aggregator:snagajob' };
    if (/theladders\.com/.test(u)) return { tier: 3, label: 'aggregator:theladders' };
    if (/jora\.com/.test(u)) return { tier: 3, label: 'aggregator:jora' };
    if (/talent\.com/.test(u)) return { tier: 3, label: 'aggregator:talent' };
    if (/jobs2careers\.com/.test(u)) return { tier: 3, label: 'aggregator:jobs2careers' };
    // TIER 2.5 — Plausible career page on unrecognized domain
    if (/^https?:\/\/(careers|jobs|apply|hiring|talent|work|join)\.[\w-]+\.[\w.]+/.test(u)) {
      return { tier: 2.5, label: 'career:subdomain' };
    }
    if (/\/(careers|jobs|join-us|join_us|apply|positions|openings|opportunities|vacancies|hiring|work-with-us)\//.test(u)) {
      return { tier: 2.5, label: 'career:path' };
    }
    // TIER 4 — Anything else
    return { tier: 4, label: 'unknown' };
  }
  function isAtsDestination(j){
    const raw = j.apply_url || j.url || '';
    if (!raw) return false;
    const low = raw.toLowerCase();
    if (BOARD_DENY.test(low)) return false;        // generic board / marketplace / easy-apply -> BAN
    if (ATS_URL.test(low)) return true;            // recognized ATS host / embed marker
    let host = '', pathx = '';
    try { const u = new URL(raw); host = u.hostname.toLowerCase(); pathx = u.pathname.toLowerCase(); }
    catch (e) { return false; }
    const dom = (j.company_domain || '').toLowerCase().replace(/^www\./, '');
    if (dom && (host === dom || host.endsWith('.' + dom))) return true;   // company's own domain
    if (CAREERS_SUB.test(host)) return true;       // careers.x.com / jobs.x.com sub-domain portal
    if (CAREERS_PATH.test(pathx)) return true;     // company.com/careers, company.com/jobs portal
    return false;                                  // unknown host -> fail closed (policy)
  }
  function standardAtsDomains() { return [ 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com', 'apply.workable.com', 'myworkdayjobs.com', 'jobs.smartrecruiters.com', 'workatastartup.com' ]; }
  return { ATS_URL, BOARD_DENY, CAREERS_SUB, CAREERS_PATH, escapeRegex, classifyUrlTier, isAtsDestination, standardAtsDomains };
})();
if (typeof module !== 'undefined' && module.exports) { module.exports = SOURCE_POLICY; }
