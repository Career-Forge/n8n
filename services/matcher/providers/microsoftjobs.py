"""
Microsoft Careers -- Eightfold PCSX JSON (free, no key).
  list:   GET https://apply.careers.microsoft.com/api/pcsx/search?domain=microsoft.com&query=<role>&start=<offset>
  detail: GET .../api/pcsx/position_details?domain=microsoft.com&position_id=<id>  (JD; list lacks it)
Role-ingest (location gated downstream by the cache geo gate). Page size is fixed at 10
server-side; Eightfold caps ~100 req/min, so the per-job detail call bounds how many we
pull per cycle (MS_INGEST_CAP). workLocationOption gives an explicit onsite/hybrid/remote.
"""
import os
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT,
               DEFAULT_QUERIES, TITLE_RX, strip_html, parse_epoch_or_iso, clean_text)

log = logging.getLogger("providers.microsoftjobs")
SEARCH = "https://apply.careers.microsoft.com/api/pcsx/search"
DETAIL = "https://apply.careers.microsoft.com/api/pcsx/position_details"
BASE = "https://apply.careers.microsoft.com"
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)"}
PAGE = 10


class MicrosoftJobs(Provider):
    name = "microsoft"
    kind = "free"

    def _detail(self, pid: str) -> str:
        if not pid:
            return ""
        try:
            r = httpx.get(DETAIL, params={"domain": "microsoft.com", "position_id": pid, "hl": "en"},
                          headers=UA, timeout=30)
            if r.status_code != 200:
                return ""
            return strip_html(((r.json() or {}).get("data") or {}).get("jobDescription") or "")
        except Exception:
            return ""

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("MS_INGEST_CAP", os.environ.get("INGEST_MAX_PER_PROVIDER", "120")))
        seen, out = set(), []
        for q in queries:
            start = 0
            while len(out) < cap:
                try:
                    r = httpx.get(SEARCH, params={"domain": "microsoft.com", "query": q, "start": start},
                                  headers=UA, timeout=30)
                    if r.status_code != 200:
                        break
                    data = (r.json() or {}).get("data") or {}
                    positions = data.get("positions") or []
                except Exception as e:
                    log.warning("microsoft fetch failed (%s): %s", q, e)
                    break
                if not positions:
                    break
                for p in positions:
                    jid = str(p.get("displayJobId") or p.get("id") or "")
                    if not jid or jid in seen:
                        continue
                    seen.add(jid)
                    title = clean_text(p.get("name") or "")
                    if not TITLE_RX.search(title):
                        continue
                    locs = p.get("standardizedLocations") or p.get("locations") or []
                    loc = locs[0] if locs else ""
                    wlo = (p.get("workLocationOption") or "").lower()
                    wt = wlo if wlo in ("onsite", "hybrid", "remote") else None
                    path = p.get("positionUrl") or ""
                    jd = self._detail(str(p.get("id") or ""))
                    out.append(JobRecord(
                        source="microsoft",
                        external_id=jid,
                        title=title,
                        company_name="Microsoft",
                        company_domain="microsoft.com",
                        ats_type="eightfold",
                        board="microsoft:eightfold-pcsx",
                        location=loc,
                        remote=True if wlo == "remote" else None,
                        workplace_type=wt,
                        jd_text=jd or clean_text(p.get("name") or ""),
                        url=f"{BASE}{path}" if path else BASE,
                        apply_url=f"{BASE}{path}" if path else BASE,
                        posted_at=parse_epoch_or_iso(p.get("postedTs")),
                        skills=[],
                        trust=TRUST_DIRECT,
                    ))
                    if len(out) >= cap:
                        break
                if len(positions) < PAGE:
                    break
                start += PAGE
        log.info("microsoft: %d jobs", len(out))
        return out


register(MicrosoftJobs())
