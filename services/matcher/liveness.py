"""
Find-time per-source liveness -- verify a shown job is still live against its source's
real-time JSON API, drop dead ones, and enrich the JD when the API returns it.

  check_alive(job) -> (alive: bool|None, jd: str|None, note: str)
     alive True  -> live (jd may be the authoritative full JD; '' if none returned)
     alive False -> dead -> caller drops it
     alive None  -> undetermined -> caller falls through (headless renderer / Firecrawl)

Why this exists: Workday (and other) job pages are JS shells -- Firecrawl scrapes them
thin and KEEPS dead reqs. The source's own JSON API is authoritative: live -> 200 (+ JD),
filled -> 403/404. We probed this live (Workday CXS detail: live 200, FIS 403, CVS 404).

Dispatch picks a checker by `source`/`board` first, else by URL host -- so a web-discovered
ATS job (e.g. an ashbyhq.com link found via serper) still gets the authoritative check.

Liveness vs transience: a definitive non-200 / absent-from-board -> dead. A 429 or 5xx ->
undetermined (None) so a transient rate-limit/outage never false-drops a live job; the
cache row stays 'active' and it self-heals on the next search.
"""
import re
import logging
from typing import Optional, Tuple

import httpx

try:                                   # shared HTML->text (same as providers/ingest)
    from providers import strip_html
except Exception:                      # pragma: no cover - defensive
    def strip_html(s):                 # type: ignore
        return (s or "").strip()

log = logging.getLogger("matcher.liveness")

UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)", "Accept": "application/json"}
JSON_HDRS = {**UA, "Content-Type": "application/json"}
T = 15

Result = Tuple[Optional[bool], Optional[str], str]


def _g(job, k: str, default: str = "") -> str:
    v = getattr(job, k, None)
    return v if v is not None else default


def _classify(code: int) -> Optional[bool]:
    """HTTP status -> liveness for endpoints where 200=live. 404/410/403 = dead;
    429/5xx = undetermined (transient)."""
    if code == 200:
        return True
    if code in (404, 410, 403):
        return False
    return None  # 429 / 5xx / anything else -> undetermined


# ── Workday CXS detail (the key fix) ──────────────────────────────
def _workday(job) -> Result:
    url = _g(job, "apply_url") or _g(job, "url")
    if "myworkdayjobs.com" not in url.lower() or "/job/" not in url:
        return None, None, "wd_unparseable"
    left, _, rest = url.partition("/job/")          # left = https://{tenant}.{wd}.myworkdayjobs.com[/{locale}]/{site}
    mh = re.match(r"^(https?://([^/.]+)\.[^/]+)(?:/.*)?$", left)
    if not mh:
        return None, None, "wd_unparseable"
    host_url, tenant = mh.group(1), mh.group(2)
    site = left.rstrip("/").rsplit("/", 1)[-1]      # segment right before /job/ (handles a locale prefix)
    if not site or site == tenant:
        return None, None, "wd_unparseable"
    cxs = f"{host_url}/wday/cxs/{tenant}/{site}/job/{rest}"
    try:
        r = httpx.get(cxs, headers=JSON_HDRS, timeout=T)
    except Exception as e:
        return None, None, f"wd_err:{type(e).__name__}"
    alive = _classify(r.status_code)
    if alive is True:
        info = (r.json() or {}).get("jobPostingInfo") or {}
        return True, (strip_html(info.get("jobDescription") or "") or None), "wd_live"
    return alive, None, f"wd_http_{r.status_code}"


# ── Lever (by-id) ─────────────────────────────────────────────────
def _lever(job) -> Result:
    url = _g(job, "apply_url") or _g(job, "url")
    m = re.search(r"lever\.co/([^/?#]+)/([0-9a-fA-F-]{36})", url)
    slug = m.group(1) if m else None
    jid = (m.group(2) if m else None) or _g(job, "external_id") or None
    if not slug or not jid:
        return None, None, "lever_unparseable"
    try:
        r = httpx.get(f"https://api.lever.co/v0/postings/{slug}/{jid}?mode=json", headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"lever_err:{type(e).__name__}"
    alive = _classify(r.status_code)
    if alive is True:
        d = r.json() or {}
        return True, ((d.get("descriptionPlain") or strip_html(d.get("description") or "")) or None), "lever_live"
    return alive, None, f"lever_http_{r.status_code}"


# ── Greenhouse (by-id) ────────────────────────────────────────────
def _greenhouse(job) -> Result:
    url = _g(job, "apply_url") or _g(job, "url")
    board = _g(job, "board")
    slug = board.split(":", 1)[1] if board.startswith("greenhouse:") else None
    jid = _g(job, "external_id") or None
    if not jid:
        m = re.search(r"[?&]gh_jid=(\d+)", url) or re.search(r"greenhouse\.io/[^/]*?/?jobs/(\d+)", url)
        jid = m.group(1) if m else None
    if not slug:
        m = re.search(r"(?:boards(?:-api)?\.greenhouse\.io|greenhouse\.io)/(?:embed/job_app\?for=|boards/)?([^/?#]+)", url, re.I)
        slug = m.group(1) if m else None
    if not slug or not jid:
        return None, None, "gh_unparseable"           # embedded-on-company-domain w/o board -> Firecrawl
    try:
        r = httpx.get(f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{jid}", headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"gh_err:{type(e).__name__}"
    alive = _classify(r.status_code)
    if alive is True:
        return True, (strip_html((r.json() or {}).get("content") or "") or None), "gh_live"
    return alive, None, f"gh_http_{r.status_code}"


# ── Ashby (board-membership) ──────────────────────────────────────
def _ashby(job) -> Result:
    url = _g(job, "apply_url") or _g(job, "url")
    board = _g(job, "board")
    slug = board.split(":", 1)[1] if board.startswith("ashby:") else None
    if not slug:
        m = re.search(r"ashbyhq\.com/([^/?#]+)", url)
        slug = m.group(1) if m else None
    jid = _g(job, "external_id") or None
    if not jid:
        m = re.search(r"ashbyhq\.com/[^/]+/([0-9a-fA-F-]{36})", url)
        jid = m.group(1) if m else None
    if not slug:
        return None, None, "ashby_unparseable"
    try:
        r = httpx.get(f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=false", headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"ashby_err:{type(e).__name__}"
    if r.status_code != 200:
        return _classify(r.status_code), None, f"ashby_http_{r.status_code}"
    listed = [j for j in ((r.json() or {}).get("jobs") or []) if j.get("isListed") is not False]
    if not jid:
        return None, None, "ashby_no_id"              # board reachable but no id to match -> Firecrawl
    for j in listed:
        if str(j.get("id")) == str(jid):
            return True, ((j.get("descriptionPlain") or strip_html(j.get("descriptionHtml") or "")) or None), "ashby_live"
    return False, None, "ashby_absent"


# ── Workable (board-membership by shortcode) ──────────────────────
def _workable(job) -> Result:
    url = _g(job, "apply_url") or _g(job, "url")
    m = re.search(r"workable\.com/(?:api/v1/widget/accounts/|j/|companies/)?([^/?#]+)", url, re.I)
    slug = m.group(1) if m else None
    code = _g(job, "external_id") or None
    if not code:
        m2 = re.search(r"/j/([A-Z0-9]+)", url)
        code = m2.group(1) if m2 else None
    if not slug:
        return None, None, "workable_unparseable"
    try:
        r = httpx.get(f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true", headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"workable_err:{type(e).__name__}"
    if r.status_code != 200:
        return _classify(r.status_code), None, f"workable_http_{r.status_code}"
    if not code:
        return None, None, "workable_no_id"
    for j in ((r.json() or {}).get("jobs") or []):
        if str(j.get("shortcode") or j.get("id")) == str(code):
            return True, (strip_html(j.get("description") or "") or None), "workable_live"
    return False, None, "workable_absent"


# ── Recruitee (by-id) ─────────────────────────────────────────────
def _recruitee(job) -> Result:
    url = _g(job, "apply_url") or _g(job, "url")
    m = re.match(r"^https?://([^.]+)\.recruitee\.com", url, re.I)
    slug = m.group(1) if m else None
    jid = _g(job, "external_id") or None
    if not jid:
        m2 = re.search(r"/(\d{5,})(?:[/?#]|$)", url)
        jid = m2.group(1) if m2 else None
    if not slug or not jid:
        return None, None, "recruitee_unparseable"
    try:
        r = httpx.get(f"https://{slug}.recruitee.com/api/offers/{jid}", headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"recruitee_err:{type(e).__name__}"
    alive = _classify(r.status_code)
    if alive is True:
        off = (r.json() or {}).get("offer") or {}
        if off.get("status") and off.get("status") != "published":
            return False, None, "recruitee_unpublished"
        return True, (strip_html((off.get("description") or "")) or None), "recruitee_live"
    return alive, None, f"recruitee_http_{r.status_code}"


# ── Giants (existing detail endpoints) ────────────────────────────
def _microsoft(job) -> Result:
    pid = _g(job, "external_id")
    if not pid:
        return None, None, "ms_no_id"
    try:
        r = httpx.get("https://apply.careers.microsoft.com/api/pcsx/position_details",
                      params={"domain": "microsoft.com", "position_id": pid, "hl": "en"}, headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"ms_err:{type(e).__name__}"
    alive = _classify(r.status_code)
    if alive is True:
        jd = ((r.json() or {}).get("data") or {}).get("jobDescription") or ""
        return (True if jd else False), (strip_html(jd) or None), ("ms_live" if jd else "ms_empty")
    return alive, None, f"ms_http_{r.status_code}"


def _netflix(job) -> Result:
    jid = _g(job, "external_id")
    if not jid:
        return None, None, "nflx_no_id"
    try:
        r = httpx.get(f"https://explore.jobs.netflix.net/api/apply/v2/jobs/{jid}",
                      params={"domain": "netflix.com"}, headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"nflx_err:{type(e).__name__}"
    alive = _classify(r.status_code)
    if alive is True:
        jd = (r.json() or {}).get("job_description") or ""
        return (True if jd else False), (strip_html(jd) or None), ("nflx_live" if jd else "nflx_empty")
    return alive, None, f"nflx_http_{r.status_code}"


def _uber(job) -> Result:
    jid = _g(job, "external_id")
    if not jid:
        return None, None, "uber_no_id"
    try:
        r = httpx.get("https://iaziqy.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails",
                      params={"onlyData": "true", "expand": "all",
                              "finder": f'ById;Id="{jid}",siteNumber=CX_1'}, headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"uber_err:{type(e).__name__}"
    alive = _classify(r.status_code)
    if alive is True:
        items = (r.json() or {}).get("items") or []
        if not items:
            return False, None, "uber_absent"
        return True, (strip_html(items[0].get("ExternalDescriptionStr") or "") or None), "uber_live"
    return alive, None, f"uber_http_{r.status_code}"


def _meta(job) -> Result:
    jid = _g(job, "external_id")
    url = _g(job, "apply_url") or _g(job, "url")
    if not jid:
        m = re.search(r"metacareers\.com/jobs/(\d+)", url)
        jid = m.group(1) if m else None
    if not jid:
        return None, None, "meta_no_id"
    try:
        r = httpx.get(f"https://www.metacareers.com/jobs/{jid}/",
                      headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html"},
                      timeout=T, follow_redirects=True)
    except Exception as e:
        return None, None, f"meta_err:{type(e).__name__}"
    alive = _classify(r.status_code)
    if alive is True:
        live = '"@type": "JobPosting"' in r.text or '"@type":"JobPosting"' in r.text
        return (True if live else False), None, ("meta_live" if live else "meta_absent")
    return alive, None, f"meta_http_{r.status_code}"


# ── SmartRecruiters (public posting detail by id) ─────────────────
def _sr_ids(job):
    """(slug, posting_id) from external_id '{slug}:{postingId}'; else from a
    jobs.smartrecruiters.com/{slug}/{id...} apply URL or an api .../companies/{slug}/postings/{id} ref."""
    ext = _g(job, "external_id")
    if ext and ":" in ext:
        slug, pid = ext.split(":", 1)
        if slug and pid:
            return slug, pid
    url = _g(job, "apply_url") or _g(job, "url")
    m = re.search(r"/v1/companies/([^/]+)/postings/([^/?#]+)", url)        # api 'ref' form
    if m:
        return m.group(1), m.group(2)
    m = re.search(r"jobs\.smartrecruiters\.com/([^/]+)/([^/?#]+)", url)    # public apply form
    if m:
        seg = m.group(2)
        pm = re.match(r"(\d+)", seg)                                       # leading numeric posting id
        return m.group(1), (pm.group(1) if pm else seg)
    return None, None


def _smartrecruiters(job) -> Result:
    slug, pid = _sr_ids(job)
    if not slug or not pid:
        return None, None, "sr_unparseable"
    try:
        r = httpx.get(f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{pid}",
                      headers=UA, timeout=T)
    except Exception as e:
        return None, None, f"sr_err:{type(e).__name__}"
    alive = _classify(r.status_code)             # 200 live; 403/404/410 dead; 429/5xx -> None
    if alive is True:
        sections = ((r.json() or {}).get("jobAd") or {}).get("sections") or {}
        parts = []
        for key in ("jobDescription", "qualifications", "additionalInformation", "companyDescription"):
            sec = sections.get(key)
            txt = sec.get("text") if isinstance(sec, dict) else None
            if txt:
                parts.append(strip_html(txt))
        jd = "\n\n".join(t for t in parts if t)
        return True, (jd or None), "sr_live"
    return alive, None, f"sr_http_{r.status_code}"


# ── Personio (public job page open/closed). 403 is NOT treated as dead (anti-bot
#    can 403 a live page); only 404/410 are dead. JD already comes from the XML provider. ──
def _personio(job) -> Result:
    url = _g(job, "apply_url") or _g(job, "url")
    m = re.search(r"https?://[^/]*\.jobs\.personio\.(?:de|com)/job/[^/?#]+", url)
    if not m:
        return None, None, "personio_unparseable"
    try:
        r = httpx.get(m.group(0), headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html"},
                      timeout=T, follow_redirects=True)
    except Exception as e:
        return None, None, f"personio_err:{type(e).__name__}"
    code = r.status_code
    if code == 200:
        return True, None, "personio_live"
    if code in (404, 410):
        return False, None, f"personio_http_{code}"
    return None, None, f"personio_http_{code}"   # 403/429/5xx/other -> inconclusive (no false-drop)


# amazon / apple / google / bytedance: no clean JSON by-id -> undetermined (Firecrawl / headless).
_BY_SOURCE = {
    "workday": _workday, "lever": _lever, "ashby": _ashby, "greenhouse": _greenhouse,
    "workable": _workable, "recruitee": _recruitee,
    "microsoft": _microsoft, "netflix": _netflix, "uber": _uber, "meta": _meta,
    "smartrecruiters": _smartrecruiters, "personio": _personio,
}
# URL-host fallbacks so web-discovered ATS jobs (source=serper/youcom) still get the real check.
_HOST_HANDLERS = [
    ("myworkdayjobs.com", _workday), ("ashbyhq.com", _ashby), ("lever.co", _lever),
    ("greenhouse.io", _greenhouse), ("gh_jid=", _greenhouse), ("recruitee.com", _recruitee),
    ("workable.com", _workable), ("metacareers.com", _meta), ("explore.jobs.netflix.net", _netflix),
    ("jobs.smartrecruiters.com", _smartrecruiters), ("jobs.personio.", _personio),
]


def check_alive(job) -> Result:
    """Authoritative liveness for one candidate. See module docstring for the contract."""
    src = (_g(job, "source") or "").lower()
    handler = _BY_SOURCE.get(src)
    if handler is None:
        url = (_g(job, "apply_url") or _g(job, "url") or "").lower()
        for frag, fn in _HOST_HANDLERS:
            if frag in url:
                handler = fn
                break
    if handler is None:
        return None, None, "no_handler"
    try:
        return handler(job)
    except Exception as e:                       # never let a checker crash validation
        log.warning("liveness handler failed (%s): %s", src or "url", e)
        return None, None, f"error:{type(e).__name__}"
