"""
amazon.jobs — GET https://www.amazon.jobs/en/search.json (free, no key).
Rich at list level: title, company_name (Amazon entity), location, posted_date,
description + basic/preferred_qualifications, is_intern, job_path, id_icims.
Covers Amazon/AWS/Audible/Twitch — big-co the registry poller can't reach.
"""
import os
import re
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT,
               DEFAULT_QUERIES, strip_html, parse_human_date, looks_remote, clean_text)

log = logging.getLogger("providers.amazonjobs")
SEARCH = "https://www.amazon.jobs/en/search.json"
BASE = "https://www.amazon.jobs"
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)"}
_SUFFIX = re.compile(r",?\s+(inc\.?|llc|ltd\.?|gmbh)\.?$", re.I)


def _company(name: str) -> str:
    name = (name or "Amazon").strip()
    return _SUFFIX.sub("", name) or "Amazon"


class AmazonJobs(Provider):
    name = "amazon"
    kind = "free"

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("INGEST_MAX_PER_PROVIDER", "250"))
        limit = 100
        seen, out = set(), []
        for q in queries:
            offset = 0
            while len(out) < cap:
                params = {"radius": "24km", "result_limit": limit, "offset": offset,
                          "sort": "recent", "base_query": q}
                try:
                    r = httpx.get(SEARCH, params=params, headers=UA, timeout=30)
                    if r.status_code != 200:
                        break
                    jobs = (r.json() or {}).get("jobs") or []
                except Exception as e:
                    log.warning("amazon fetch failed (%s): %s", q, e)
                    break
                if not jobs:
                    break
                for j in jobs:
                    jid = str(j.get("id_icims") or j.get("id") or "")
                    if not jid or jid in seen:
                        continue
                    seen.add(jid)
                    jd = "\n\n".join(strip_html(j.get(k, "")) for k in
                                     ("description", "basic_qualifications", "preferred_qualifications")
                                     if j.get(k))
                    path = j.get("job_path") or ""
                    loc = j.get("normalized_location") or j.get("location") or ""
                    out.append(JobRecord(
                        source="amazon",
                        external_id=jid,
                        title=clean_text(j.get("title") or ""),
                        company_name=clean_text(_company(j.get("company_name"))),
                        company_domain="amazon.jobs",
                        ats_type=None,
                        board="amazon:jobs",
                        location=loc,
                        remote=looks_remote(loc, j.get("title", "")),
                        employment_type="intern" if j.get("is_intern") else (j.get("job_schedule_type") or None),
                        jd_text=jd,
                        url=f"{BASE}{path}" if path else BASE,
                        apply_url=f"{BASE}{path}" if path else BASE,
                        posted_at=parse_human_date(j.get("posted_date") or j.get("updated_time", "")),
                        skills=[],
                        trust=TRUST_DIRECT,
                    ))
                    if len(out) >= cap:
                        break
                if len(jobs) < limit:
                    break
                offset += limit
        log.info("amazon: %d jobs", len(out))
        return out


register(AmazonJobs())
