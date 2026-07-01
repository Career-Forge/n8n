"""
ByteDance + TikTok Careers -- shared "throne" backend (free, no key). One provider, two
brand hosts. POST JSON; the `website-path: en` header is MANDATORY (400 without it) and
selects EN content. JD is in the list response (no detail call). No posted-date in the
feed -- rely on the cache first-seen layer for recency.
"""
import os
import json
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT, DEFAULT_QUERIES, TITLE_RX,
               strip_html, clean_text)

log = logging.getLogger("providers.bytedancejobs")
HOSTS = [
    ("ByteDance", "joinbytedance.com", "https://jobs.bytedance.com/api/v1/public/supplier/search/job/posts",
     "https://joinbytedance.com/position?id={id}"),
    ("TikTok", "lifeattiktok.com", "https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts",
     "https://lifeattiktok.com/position/{id}"),
]
HDRS = {"User-Agent": "Mozilla/5.0 (careerforge job cache)", "Content-Type": "application/json", "website-path": "en"}
PAGE = 50


class ByteDanceJobs(Provider):
    name = "bytedance"
    kind = "free"

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("INGEST_MAX_PER_PROVIDER", "250"))
        per_host = max(1, cap // len(HOSTS))
        seen, out = set(), []
        for brand, domain, url, urlfmt in HOSTS:
            hcount = 0
            for q in queries:
                if hcount >= per_host:
                    break
                offset = 0
                while hcount < per_host:
                    try:
                        r = httpx.post(url, headers=HDRS, timeout=30,
                                       content=json.dumps({"keyword": q, "limit": PAGE, "offset": offset}))
                        if r.status_code != 200:
                            break
                        d = r.json() or {}
                        if d.get("code") != 0:
                            break
                        posts = ((d.get("data") or {}).get("job_post_list")) or []
                    except Exception as e:
                        log.warning("%s fetch failed (%s): %s", brand, q, e)
                        break
                    if not posts:
                        break
                    for p in posts:
                        jid = str(p.get("id") or p.get("code") or "")
                        key = f"{brand}:{jid}"
                        if not jid or key in seen:
                            continue
                        seen.add(key)
                        title = clean_text(p.get("title") or "")
                        if not TITLE_RX.search(title):
                            continue
                        loc = (p.get("city_info") or {}).get("en_name") or ""
                        jd = "\n\n".join(x for x in (strip_html(p.get("description") or ""),
                                                     strip_html(p.get("requirement") or "")) if x)
                        url_j = urlfmt.format(id=jid)
                        out.append(JobRecord(
                            source="bytedance", external_id=key, title=title,
                            company_name=brand, company_domain=domain,
                            ats_type="bytedance_throne", board=f"{brand.lower()}:throne",
                            location=loc, remote=None,
                            jd_text=jd or title, url=url_j, apply_url=url_j,
                            posted_at=None, skills=[], trust=TRUST_DIRECT))
                        hcount += 1
                        if hcount >= per_host:
                            break
                    offset += PAGE
        log.info("bytedance/tiktok: %d jobs", len(out))
        return out


register(ByteDanceJobs())
