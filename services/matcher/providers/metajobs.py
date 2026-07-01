"""
Meta Careers -- metacareers.com Relay GraphQL (free, no login). The most fragile giant:
a per-run bootstrap scrapes the short-lived `lsd` CSRF token from the page HTML; the
persisted-query `doc_id` drifts on Meta redeploys (env-overridable -- bump META_DOC_ID if
listings dry up). The list lacks JD + posted date, so we fetch the per-job detail page and
read its JSON-LD JobPosting. Role-ingest; location gated downstream. Heavily capped.
"""
import os
import re
import json
import logging
from urllib.parse import urlencode
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT,
               DEFAULT_QUERIES, TITLE_RX, strip_html, parse_human_date, clean_text)

log = logging.getLogger("providers.metajobs")
BASE = "https://www.metacareers.com"
GRAPHQL = f"{BASE}/graphql"
# Persisted-query id for CareersJobSearchResultsV2DataQuery (drifts on redeploy; override via env).
DOC_ID = os.environ.get("META_DOC_ID", "27129360303422352")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-ch-ua": '"Chromium";v="124", "Not:A-Brand";v="99"',
    "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none",
    "upgrade-insecure-requests": "1",
}
_LSD = re.compile(r'\["LSD",\[\],\{"token":"(.*?)"\}\]')
_LDJSON = re.compile(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.S)


class MetaJobs(Provider):
    name = "meta"
    kind = "free"

    def _lsd(self, client) -> Optional[str]:
        try:
            r = client.get(f"{BASE}/jobs/", headers=HEADERS, timeout=30)
            m = _LSD.search(r.text)
            return m.group(1) if m else None
        except Exception as e:
            log.warning("meta bootstrap failed: %s", e)
            return None

    def _detail(self, client, jid):
        try:
            r = client.get(f"{BASE}/jobs/{jid}/", headers=HEADERS, timeout=30)
            if r.status_code != 200:
                return "", None
            for blk in _LDJSON.findall(r.text):
                try:
                    d = json.loads(blk.replace("\\u0040", "@"))
                except Exception:
                    continue
                if isinstance(d, dict) and d.get("@type") == "JobPosting":
                    return strip_html(d.get("description") or ""), parse_human_date(d.get("datePosted") or "")
            return "", None
        except Exception:
            return "", None

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("META_INGEST_CAP", os.environ.get("INGEST_MAX_PER_PROVIDER", "60")))
        seen, out = set(), []
        with httpx.Client(follow_redirects=True) as client:
            lsd = self._lsd(client)
            if not lsd:
                log.warning("meta: no lsd token -- skipping")
                return []
            post_headers = dict(HEADERS)
            post_headers["x-fb-lsd"] = lsd
            post_headers["Content-Type"] = "application/x-www-form-urlencoded"
            for q in queries:
                page = 1
                while len(out) < cap and page <= 10:
                    variables = {
                        "search_input": {"q": q, "offices": [], "divisions": [], "roles": [], "teams": [],
                                         "sub_teams": [], "leadership_levels": [], "saved_jobs": [],
                                         "saved_searches": [], "is_leadership": False, "is_remote_only": False,
                                         "sort_by_new": False, "page": page, "results_per_page": None},
                        "hasLoggedInUser": False, "isLoggedIn": False, "viewasUserID": None}
                    body = {"lsd": lsd, "__a": "1", "__comet_req": "1", "doc_id": DOC_ID,
                            "fb_api_req_friendly_name": "CareersJobSearchResultsV2DataQuery",
                            "variables": json.dumps(variables)}
                    try:
                        r = client.post(GRAPHQL, headers=post_headers, content=urlencode(body), timeout=30)
                        if r.status_code != 200:
                            break
                        d = (r.json() or {}).get("data") or {}
                        node = d.get("job_search_with_featured_jobs_v2") or {}
                        jobs = (node.get("all_jobs") or []) + (node.get("featured_jobs") or [])
                    except Exception as e:
                        log.warning("meta fetch failed (%s p%d): %s", q, page, e)
                        break
                    if not jobs:
                        break
                    for j in jobs:
                        jid = str(j.get("id") or "")
                        if not jid or jid in seen:
                            continue
                        seen.add(jid)
                        title = clean_text(j.get("title") or "")
                        if not TITLE_RX.search(title):
                            continue
                        locs = j.get("locations") or []
                        loc = locs[0] if locs else ""
                        is_rem = any("remote" in str(x).lower() for x in locs)
                        jd, posted = self._detail(client, jid)
                        out.append(JobRecord(
                            source="meta",
                            external_id=jid,
                            title=title,
                            company_name="Meta",
                            company_domain="metacareers.com",
                            ats_type=None,
                            board="meta:careers",
                            location=loc,
                            remote=True if is_rem else None,
                            jd_text=jd or title,
                            url=f"{BASE}/jobs/{jid}/",
                            apply_url=f"{BASE}/jobs/{jid}/",
                            posted_at=posted,
                            skills=[],
                            trust=TRUST_DIRECT,
                        ))
                        if len(out) >= cap:
                            break
                    page += 1
        log.info("meta: %d jobs", len(out))
        return out


register(MetaJobs())
