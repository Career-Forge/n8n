"""
Apple Careers -- jobs.apple.com SSR-embedded JSON (free, no key, no token).
  GET https://jobs.apple.com/en-us/search?search=<role>&page=<N>&sort=newest
The page server-renders the full result set into
  window.__staticRouterHydrationData = JSON.parse("...")
-> loaderData.search.searchResults[]. jobSummary (list-level) is enough JD for first-pass
matching, so no detail call. The native POST /api/v1/search is CSRF + ALB-flaky -- avoid.
Role-ingest; location is gated downstream by the cache geo gate.
"""
import os
import re
import json
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT,
               DEFAULT_QUERIES, TITLE_RX, strip_html, parse_human_date, clean_text)

log = logging.getLogger("providers.applejobs")
BASE = "https://jobs.apple.com"
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)"}
PAGE = 20
# escape-aware grab of the JS string literal inside JSON.parse("...")
_HYDRATION = re.compile(r'window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(\s*("(?:[^"\\]|\\.)*")\s*\)', re.S)
_SLUG = re.compile(r'[^a-z0-9]+')


def _slug(s: str) -> str:
    return _SLUG.sub('-', (s or '').lower()).strip('-')


class AppleJobs(Provider):
    name = "apple"
    kind = "free"

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("INGEST_MAX_PER_PROVIDER", "250"))
        seen, out = set(), []
        for q in queries:
            page = 1
            while len(out) < cap:
                try:
                    r = httpx.get(f"{BASE}/en-us/search", params={"search": q, "page": page, "sort": "newest"},
                                  headers=UA, timeout=30)
                    if r.status_code != 200:
                        break
                    m = _HYDRATION.search(r.text)
                    if not m:
                        log.warning("apple: hydration blob not found (p%d) -- layout changed?", page)
                        break
                    data = json.loads(json.loads(m.group(1)))   # JS-string literal -> JSON text -> object
                    results = (((data.get("loaderData") or {}).get("search") or {}).get("searchResults")) or []
                except Exception as e:
                    log.warning("apple fetch failed (%s p%d): %s", q, page, e)
                    break
                if not results:
                    break
                for j in results:
                    jid = str(j.get("id") or j.get("positionId") or "")
                    if not jid or jid in seen:
                        continue
                    seen.add(jid)
                    locs = j.get("locations") or []
                    loc = ""
                    if locs:
                        l0 = locs[0]
                        loc = ", ".join(x for x in (l0.get("city"), l0.get("stateProvince"), l0.get("countryName")) if x)
                    title = clean_text(j.get("postingTitle") or "")
                    if not TITLE_RX.search(title):
                        continue
                    pid = j.get("positionId") or jid
                    home = bool(j.get("homeOffice"))
                    url = f"{BASE}/en-us/details/{pid}/{_slug(j.get('postingTitle'))}"
                    out.append(JobRecord(
                        source="apple",
                        external_id=jid,
                        title=title,
                        company_name="Apple",
                        company_domain="jobs.apple.com",
                        ats_type=None,
                        board="apple:jobs",
                        location=loc,
                        remote=True if home else None,
                        workplace_type="remote" if home else None,
                        jd_text=strip_html(j.get("jobSummary") or "") or title,
                        url=url,
                        apply_url=url,
                        posted_at=parse_human_date(j.get("postDateInGMT") or j.get("postingDate") or ""),
                        skills=[],
                        trust=TRUST_DIRECT,
                    ))
                    if len(out) >= cap:
                        break
                if len(results) < PAGE:
                    break
                page += 1
        log.info("apple: %d jobs", len(out))
        return out


register(AppleJobs())
