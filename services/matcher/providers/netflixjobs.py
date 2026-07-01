"""
Netflix Careers -- Eightfold apply/v2 JSON (free, no key). Same Eightfold backend as
Microsoft (PCSX), sibling endpoint. GET list + per-job detail for the full JD.
  list:   GET https://explore.jobs.netflix.net/api/apply/v2/jobs?domain=netflix.com&query=<role>&start=N&num=10
  detail: GET https://explore.jobs.netflix.net/api/apply/v2/jobs/<id>?domain=netflix.com -> positions[0].job_description
Role-ingest; location gated downstream. POST hits a reload-guard 400 -- use GET.
"""
import os
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT, DEFAULT_QUERIES, TITLE_RX,
               strip_html, parse_epoch_or_iso, clean_text)

log = logging.getLogger("providers.netflixjobs")
BASE = "https://explore.jobs.netflix.net"
LIST = f"{BASE}/api/apply/v2/jobs"
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)", "Accept": "application/json",
      "Referer": f"{BASE}/careers"}
PAGE = 10


class NetflixJobs(Provider):
    name = "netflix"
    kind = "free"

    def _detail(self, jid: str) -> str:
        if not jid:
            return ""
        try:
            r = httpx.get(f"{LIST}/{jid}", params={"domain": "netflix.com"}, headers=UA, timeout=30)
            if r.status_code != 200:
                return ""
            return strip_html((r.json() or {}).get("job_description") or "")   # detail returns the job at top level
        except Exception:
            return ""

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("INGEST_MAX_PER_PROVIDER", "250"))
        seen, out = set(), []
        for q in queries:
            start = 0
            while len(out) < cap:
                try:
                    r = httpx.get(LIST, headers=UA, timeout=30, params={
                        "domain": "netflix.com", "query": q, "start": start, "num": PAGE, "sort_by": "relevance"})
                    if r.status_code != 200:
                        break
                    positions = (r.json() or {}).get("positions") or []
                except Exception as e:
                    log.warning("netflix fetch failed (%s): %s", q, e)
                    break
                if not positions:
                    break
                for p in positions:
                    jid = str(p.get("display_job_id") or p.get("id") or "")
                    if not jid or jid in seen:
                        continue
                    seen.add(jid)
                    title = clean_text(p.get("name") or "")
                    if not TITLE_RX.search(title):
                        continue
                    locs = p.get("locations") or []
                    loc = locs[0] if locs else (p.get("location") or "")
                    wlo = (p.get("work_location_option") or "").lower()
                    wt = wlo if wlo in ("onsite", "hybrid", "remote") else None
                    url = p.get("canonicalPositionUrl") or f"{BASE}/careers"
                    jd = self._detail(str(p.get("id") or ""))
                    out.append(JobRecord(
                        source="netflix", external_id=jid, title=title,
                        company_name="Netflix", company_domain="netflix.com",
                        ats_type="eightfold", board="netflix:eightfold-apply-v2",
                        location=loc, remote=True if wlo == "remote" else None, workplace_type=wt,
                        jd_text=jd or title, url=url, apply_url=url,
                        posted_at=parse_epoch_or_iso(p.get("t_create")),
                        skills=[], trust=TRUST_DIRECT))
                    if len(out) >= cap:
                        break
                if len(positions) < PAGE:
                    break
                start += PAGE
        log.info("netflix: %d jobs", len(out))
        return out


register(NetflixJobs())
