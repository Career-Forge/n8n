"""
Workday CXS — the free, unauthenticated JSON API behind big-co Workday boards.
  list:   POST https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
          body {"appliedFacets":{}, "limit":20, "offset":N, "searchText":"<q>"}
  detail: GET  .../wday/cxs/{tenant}/{site}/job/{externalPath}   (W3, flag-gated)

REGISTRY-DRIVEN: tenants live in the `companies` table (ats_type='workday',
slug=tenant, api_base=full CXS base URL). This is how we reach the whole Workday
universe — pharma / insurance / Fortune-500 / Adobe / Salesforce / Indian MNC
dev centers — that the direct-ATS poller can't. The list view is THIN
(title, path, location, relative postedOn) — no JD — so we embed on title+location
and let the matcher's Firecrawl step enrich the shown top-N. (Full-JD CXS
detail-fetch is W3, behind WORKDAY_DETAIL_FETCH.)

We query per DEFAULT_QUERIES (searchText) because the targets are low-tech-density
giants (pharma/insurance): server-side narrowing finds the few AI/data roles far
cheaper than paging thousands of non-tech postings. TITLE_RX still filters the
fuzzy results. Each tenant is fetched in isolation (a wrong/closed tenant logs +
skips); poll-state bookkeeping mirrors the registry ATS providers so the
tier-priority cadence comes for free.
"""
import os
import re
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Optional, Tuple

import httpx

from . import (Provider, JobRecord, register, TRUST_WORKDAY,
               WORKDAY_TENANTS, DEFAULT_QUERIES, TITLE_RX, CAP_PER_BOARD,
               parse_relative_posted, parse_human_date, clean_text, strip_html)

log = logging.getLogger("providers.workday")
HDRS = {"Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (careerforge job cache)"}
# Hard page cap per (tenant, query). searchText ranks the relevant roles first, so
# a few pages catch them; without this a big low-tech tenant (Abbott: 2000 jobs,
# few AI roles) would page the whole board x5 queries hunting 25 matches that
# aren't there — hundreds of requests/tenant that stall the whole ingest.
WORKDAY_MAX_PAGES = int(os.environ.get("WORKDAY_MAX_PAGES", "5"))
WORKDAY_WORKERS = int(os.environ.get("WORKDAY_WORKERS", "12"))  # tenants fetched concurrently
# W3: enrich each kept job with the full JD via the CXS detail endpoint (off by
# default — adds one GET per kept job). externalUrl == our constructed url, so the
# dedup_key is unchanged; upsert just upgrades the thin row's jd_text in place.
WORKDAY_DETAIL_FETCH = os.environ.get("WORKDAY_DETAIL_FETCH", "").lower() in ("1", "true", "yes", "on")

# api_base full-URL form: https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}
_CXS_RX = re.compile(r"^(https?://[^/]+)/wday/cxs/([^/]+)/(.+?)/?$", re.I)


def _job_id(jp: dict) -> Optional[str]:
    bf = jp.get("bulletFields") or []
    if bf and bf[0]:
        return str(bf[0])
    path = jp.get("externalPath") or ""
    if "_" in path:
        return path.rsplit("_", 1)[-1]  # …_JR2015702
    return path or None


def _parse_api_base(api_base: str, slug: str) -> Optional[Tuple[str, str]]:
    """Return (cxs_base, posting_base) from a company's api_base.
    Accepts the preferred full-URL form
        https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}
    and the legacy pipe form 'tenant|wd|site'. Returns None (caller marks the
    board 'gone') on malformed input.
      cxs_base     -> POST {cxs_base}/jobs ; GET {cxs_base}/job/{path}
      posting_base -> public URL = {posting_base}{externalPath}
    """
    s = (api_base or "").strip()
    if "://" in s:
        m = _CXS_RX.match(s)
        if not m:
            return None
        host_url, tenant, site = m.group(1), m.group(2), m.group(3)
        return f"{host_url}/wday/cxs/{tenant}/{site}", f"{host_url}/{site}"
    if "|" in s:
        parts = s.split("|")
        if len(parts) != 3 or not all(parts):
            return None
        tenant, wd, site = parts
        host_url = f"https://{tenant}.{wd}.myworkdayjobs.com"
        return f"{host_url}/wday/cxs/{tenant}/{site}", f"{host_url}/{site}"
    return None


class _WorkdayGone(Exception):
    """Sentinel: tenant CXS returned 404/410 -> deactivate the board."""


class Workday(Provider):
    name = "workday"
    kind = "free"

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        import db
        limit = int(os.environ.get("ATS_DUE_LIMIT", "25"))
        due = db.select_due_companies("workday", limit)
        if not due:
            # zero-row fallback: the in-code seed (NVIDIA) so a fresh DB still works
            due = [{"name": t["company"], "slug": t["tenant"],
                    "board": f"workday:{t['tenant']}",
                    "api_base": f"{t['tenant']}|{t['wd']}|{t['site']}", "etag": ""}
                   for t in WORKDAY_TENANTS]
            log.info("workday: registry empty -> %d in-code fallback tenants", len(due))

        recs: List[JobRecord] = []
        ok_etags, failed, gone = [], [], []
        # tenants are independent hosts -> fetch concurrently (big wall-clock win)
        with ThreadPoolExecutor(max_workers=min(WORKDAY_WORKERS, len(due))) as ex:
            futs = {ex.submit(self._fetch_one, c): c for c in due}
            for fut in as_completed(futs):
                board = futs[fut]["board"]
                try:
                    recs.extend(fut.result())
                    ok_etags.append({"board": board, "etag": None})
                except _WorkdayGone:
                    gone.append(board)
                except Exception as e:
                    log.warning("workday board %s failed: %s", board, e)
                    failed.append(board)

        # poll-state bookkeeping (don't let a DB hiccup lose the fetched jobs)
        try:
            db.advance_poll_state(ok_etags)
            db.penalize_boards(failed, gone)
        except Exception as e:
            log.warning("workday poll-state update failed: %s", e)
        log.info("workday: %d boards due, %d relevant jobs (%d ok, %d failed, %d gone)",
                 len(due), len(recs), len(ok_etags), len(failed), len(gone))
        return recs

    def _fetch_one(self, c: dict) -> List[JobRecord]:
        """Parse api_base + fetch one tenant. Bad api_base -> _WorkdayGone (deactivate)."""
        parsed = _parse_api_base(c.get("api_base", ""), c["slug"])
        if not parsed:
            log.warning("workday %s: bad api_base %r", c["board"], c.get("api_base"))
            raise _WorkdayGone()
        cxs_base, posting_base = parsed
        return self._fetch_tenant(cxs_base, posting_base, c, CAP_PER_BOARD)

    def _fetch_detail(self, cxs_base: str, external_path: str):
        """CXS job detail -> (full jd_text | None, posted_at | None). externalPath
        already starts with '/job/...', so the detail URL is {cxs_base}{externalPath}."""
        try:
            r = httpx.get(f"{cxs_base}{external_path}", headers=HDRS, timeout=20)
            if r.status_code != 200:
                return None, None
            info = (r.json() or {}).get("jobPostingInfo") or {}
            jd = strip_html(info.get("jobDescription") or "")
            return (jd or None), parse_human_date(info.get("startDate") or "")
        except Exception:
            return None, None

    def _fetch_tenant(self, cxs_base: str, posting_base: str, c: dict, cap: int) -> List[JobRecord]:
        api = f"{cxs_base}/jobs"
        slug, company, board = c["slug"], c.get("name") or "", c["board"]
        domain = posting_base.split("/")[2]  # host
        seen, recs = set(), []
        for q in DEFAULT_QUERIES:
            if len(recs) >= cap:
                break
            offset = 0
            for _page in range(WORKDAY_MAX_PAGES):       # hard page cap (R3/R5)
                if len(recs) >= cap:
                    break
                body = {"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": q}
                r = httpx.post(api, headers=HDRS, json=body, timeout=30)
                if r.status_code in (404, 410):
                    raise _WorkdayGone()
                if r.status_code != 200:
                    break  # transient (rate-limit/5xx): keep what we have, board stays active
                postings = (r.json() or {}).get("jobPostings") or []
                if not postings:
                    break
                for jp in postings:
                    title = clean_text(jp.get("title") or "")
                    if not TITLE_RX.search(title):
                        continue
                    jid = _job_id(jp)
                    if not jid or jid in seen:
                        continue
                    seen.add(jid)
                    path = jp.get("externalPath") or ""
                    loc = jp.get("locationsText") or ""
                    url = f"{posting_base}{path}" if path else posting_base
                    jd_text = f"{title}\n{loc}"   # thin; enriched at match time (or W3 detail below)
                    posted = parse_relative_posted(jp.get("postedOn", ""))
                    if WORKDAY_DETAIL_FETCH and path:
                        d_jd, d_posted = self._fetch_detail(cxs_base, path)
                        if d_jd:
                            jd_text = d_jd
                        if d_posted:
                            posted = d_posted
                    recs.append(JobRecord(
                        source="workday",
                        external_id=f"{slug}:{jid}",
                        title=title,
                        company_name=company,
                        company_domain=domain,
                        ats_type="workday",
                        board=board,
                        location=loc,
                        jd_text=jd_text,
                        url=url,
                        apply_url=url,
                        posted_at=posted,
                        skills=[],
                        trust=TRUST_WORKDAY,
                    ))
                    if len(recs) >= cap:
                        break
                offset += 20
        return recs


register(Workday())
