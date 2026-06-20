"""
Workday CXS — the free, unauthenticated JSON API behind big-co Workday boards.
  POST https://{tenant}.{wd}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
  body: {"appliedFacets":{}, "limit":20, "offset":N, "searchText":"<query>"}

This is how we get Google/NVIDIA/etc.-scale employers the registry poller can't.
The list view is THIN (title, path, location, relative postedOn) — no JD — so we
embed on title+location and let the matcher's Firecrawl step enrich the shown
top-N with the full JD. (Detail-fetch per job is a Phase-1 follow-up.)

Each tenant is fetched in isolation: a wrong/closed tenant logs + skips, never
sinking the run.
"""
import os
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_WORKDAY,
               WORKDAY_TENANTS, DEFAULT_QUERIES, parse_relative_posted, clean_text)

log = logging.getLogger("providers.workday")
HDRS = {"Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (careerforge job cache)"}


def _job_id(jp: dict) -> Optional[str]:
    bf = jp.get("bulletFields") or []
    if bf and bf[0]:
        return str(bf[0])
    path = jp.get("externalPath") or ""
    if "_" in path:
        return path.rsplit("_", 1)[-1]  # …_JR2015702
    return path or None


class Workday(Provider):
    name = "workday"
    kind = "free"

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("INGEST_MAX_PER_PROVIDER", "250"))
        per_tenant = max(1, cap // max(1, len(WORKDAY_TENANTS)))
        out: List[JobRecord] = []
        for t in WORKDAY_TENANTS:
            try:
                out.extend(self._fetch_tenant(t, queries, per_tenant))
            except Exception as e:
                log.warning("workday tenant %s failed: %s", t.get("tenant"), e)
        log.info("workday: %d jobs across %d tenants", len(out), len(WORKDAY_TENANTS))
        return out

    def _fetch_tenant(self, t: dict, queries: List[str], cap: int) -> List[JobRecord]:
        tenant, wd, site, company = t["tenant"], t["wd"], t["site"], t["company"]
        base = f"https://{tenant}.{wd}.myworkdayjobs.com"
        api = f"{base}/wday/cxs/{tenant}/{site}/jobs"
        domain = f"{tenant}.{wd}.myworkdayjobs.com"
        seen, recs = set(), []
        for q in queries:
            offset = 0
            while len(recs) < cap:
                body = {"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": q}
                r = httpx.post(api, headers=HDRS, json=body, timeout=30)
                if r.status_code != 200:
                    break
                postings = (r.json() or {}).get("jobPostings") or []
                if not postings:
                    break
                for jp in postings:
                    jid = _job_id(jp)
                    if not jid or jid in seen:
                        continue
                    seen.add(jid)
                    path = jp.get("externalPath") or ""
                    loc = jp.get("locationsText") or ""
                    title = clean_text(jp.get("title") or "")
                    recs.append(JobRecord(
                        source="workday",
                        external_id=f"{tenant}:{jid}",
                        title=title,
                        company_name=company,
                        company_domain=domain,
                        ats_type="workday",
                        board=f"workday:{tenant}",
                        location=loc,
                        jd_text=f"{title}\n{loc}",  # thin; enriched at match time
                        url=f"{base}/{site}{path}" if path else base,
                        apply_url=f"{base}/{site}{path}" if path else base,
                        posted_at=parse_relative_posted(jp.get("postedOn", "")),
                        skills=[],
                        trust=TRUST_WORKDAY,
                    ))
                    if len(recs) >= cap:
                        break
                offset += 20
        return recs


register(Workday())
