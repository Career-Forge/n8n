"""
Google Careers -- www.google.com/about/careers SSR AF_initDataCallback JSON (free, no key).
  GET https://www.google.com/about/careers/applications/jobs/results/?q=<role>&page=<N>
Full JD is in the list response (no detail call). Parsing is by POSITIONAL index inside the
ds:1 blob -- fragile to a Google frontend redeploy -- so we PROBE stable anchors first
(signin URL with jobId= at j[2], location-tuple list at j[9]) and bail loud rather than emit
garbage. Covers Google/DeepMind/Waymo/etc. Role-ingest; location gated downstream.
"""
import os
import re
import json
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT,
               DEFAULT_QUERIES, TITLE_RX, strip_html, parse_epoch_or_iso, looks_remote, clean_text)

log = logging.getLogger("providers.googlejobs")
URL = "https://www.google.com/about/careers/applications/jobs/results/"
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)"}
# non-greedy array capture anchored on ],sideChannel (handles the nested array)
_DS1 = re.compile(r"AF_initDataCallback\(\{key:\s*'ds:1'.*?data:(\[.*?\]),\s*sideChannel", re.S)


def _txt(node) -> str:
    """j[3]/j[4]/j[19] are [label, html] pairs (or missing)."""
    try:
        return strip_html(node[1]) if isinstance(node, list) and len(node) > 1 else ""
    except Exception:
        return ""


class GoogleJobs(Provider):
    name = "google"
    kind = "free"

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        queries = queries or DEFAULT_QUERIES
        cap = int(os.environ.get("INGEST_MAX_PER_PROVIDER", "250"))
        seen, out = set(), []
        for q in queries:
            page = 1
            while len(out) < cap and page <= 60:
                try:
                    r = httpx.get(URL, params={"q": q, "page": page}, headers=UA, timeout=30)
                    if r.status_code != 200:
                        break
                    m = _DS1.search(r.text)
                    if not m:
                        log.warning("google: ds:1 blob not found (p%d) -- layout changed?", page)
                        break
                    data = json.loads(m.group(1))
                    jobs = data[0] if isinstance(data, list) and data else []
                except Exception as e:
                    log.warning("google fetch failed (%s p%d): %s", q, page, e)
                    break
                if not jobs:
                    break
                # defensive: confirm the positional schema still holds before trusting indices
                probe = jobs[0]
                if not (isinstance(probe, list) and len(probe) > 12
                        and isinstance(probe[2], str) and "jobId=" in probe[2]
                        and isinstance(probe[9], list)):
                    log.warning("google: positional schema changed (j[2]/j[9]) -- bailing to avoid garbage")
                    break
                for j in jobs:
                    try:
                        jid = str(j[0])
                        if not jid or jid in seen:
                            continue
                        seen.add(jid)
                        locs = j[9] if isinstance(j[9], list) else []
                        loc = locs[0][0] if locs and isinstance(locs[0], list) and locs[0] else ""
                        jd = "\n\n".join(x for x in (_txt(j[3]), _txt(j[4]),
                                                     _txt(j[19]) if len(j) > 19 else "") if x)
                        posted = parse_epoch_or_iso(j[12][0]) if (len(j) > 12 and isinstance(j[12], list) and j[12]) else None
                        title = clean_text(j[1] or "")
                        if not TITLE_RX.search(title):
                            continue
                        out.append(JobRecord(
                            source="google",
                            external_id=jid,
                            title=title,
                            company_name=clean_text(j[7] if (len(j) > 7 and j[7]) else "Google"),
                            company_domain="google.com",
                            ats_type=None,
                            board="google:careers",
                            location=loc,
                            remote=looks_remote(loc, title),
                            jd_text=jd or title,
                            url=j[2],
                            apply_url=j[2],
                            posted_at=posted,
                            skills=[],
                            trust=TRUST_DIRECT,
                        ))
                        if len(out) >= cap:
                            break
                    except Exception:
                        continue
                page += 1
        log.info("google: %d jobs", len(out))
        return out


register(GoogleJobs())
