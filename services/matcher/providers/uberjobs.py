"""
Uber Careers -- Oracle Recruiting Cloud / Fusion HCM JSON (free, no key). The vanity host
jobs.uber.com is Cloudflare-WAF'd, so hit the Oracle pod directly. Reusable ORC pattern --
POD + SITE are the only per-tenant config (future Oracle-recruiting companies clone this).
List + per-job detail for the JD. ~12k reqs, so capped (UBER_INGEST_CAP).
"""
import os
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT, DEFAULT_QUERIES, TITLE_RX,
               strip_html, parse_human_date, looks_remote, clean_text)

log = logging.getLogger("providers.uberjobs")
POD = "https://iaziqy.fa.ocs.oraclecloud.com"
SITE = "CX_1"
LIST = f"{POD}/hcmRestApi/resources/latest/recruitingCEJobRequisitions"
DETAIL = f"{POD}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)", "REST-Framework-Version": "6"}
PAGE = 200


class UberJobs(Provider):
    name = "uber"
    kind = "free"

    def _detail(self, jid: str) -> str:
        try:
            finder = f'ById;Id="{jid}",siteNumber={SITE}'
            r = httpx.get(DETAIL, params={"onlyData": "true", "expand": "all", "finder": finder},
                          headers=UA, timeout=30)
            if r.status_code != 200:
                return ""
            items = (r.json() or {}).get("items") or []
            return strip_html(items[0].get("ExternalDescriptionStr") or "") if items else ""
        except Exception:
            return ""

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("UBER_INGEST_CAP", os.environ.get("INGEST_MAX_PER_PROVIDER", "150")))
        seen, out = set(), []
        for q in queries:
            offset = 0
            while len(out) < cap:
                finder = f"findReqs;siteNumber={SITE},keyword={q},limit={PAGE},offset={offset},sortBy=POSTING_DATES_DESC"
                try:
                    r = httpx.get(LIST, params={"onlyData": "true", "expand": "requisitionList", "finder": finder},
                                  headers=UA, timeout=30)
                    if r.status_code != 200:
                        break
                    items = (r.json() or {}).get("items") or []
                    if not items:
                        break
                    rl = items[0].get("requisitionList") or []
                    reqs = rl if isinstance(rl, list) else (rl.get("items") or [])
                    total = int(items[0].get("TotalJobsCount") or 0)
                except Exception as e:
                    log.warning("uber fetch failed (%s): %s", q, e)
                    break
                if not reqs:
                    break
                for j in reqs:
                    jid = str(j.get("Id") or "")
                    if not jid or jid in seen:
                        continue
                    seen.add(jid)
                    title = clean_text(j.get("Title") or "")
                    if not TITLE_RX.search(title):
                        continue
                    loc = j.get("PrimaryLocation") or ""
                    url = f"{POD}/hcmUI/CandidateExperience/en/sites/{SITE}/job/{jid}"
                    jd = self._detail(jid)
                    out.append(JobRecord(
                        source="uber", external_id=jid, title=title,
                        company_name="Uber", company_domain="uber.com",
                        ats_type="oracle_orc", board=f"uber:orc-{SITE.lower()}",
                        location=loc, remote=looks_remote(loc, title),
                        jd_text=jd or title, url=url, apply_url=url,
                        posted_at=parse_human_date(j.get("PostedDate") or ""),
                        skills=[], trust=TRUST_DIRECT))
                    if len(out) >= cap:
                        break
                offset += PAGE
                if total and offset >= total:
                    break
        log.info("uber: %d jobs", len(out))
        return out


register(UberJobs())
