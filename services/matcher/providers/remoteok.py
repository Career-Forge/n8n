"""
RemoteOK — GET https://remoteok.com/api  (free, no key, ~100 latest jobs).
Element [0] is a legal/last_updated notice; skip anything without an id+position.
"""
import os
import json
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_AGGREGATOR,
               strip_html, clean_text)

log = logging.getLogger("providers.remoteok")
API = "https://remoteok.com/api"
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)"}


class RemoteOK(Provider):
    name = "remoteok"
    kind = "free"

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        cap = int(os.environ.get("INGEST_MAX_PER_PROVIDER", "250"))
        try:
            r = httpx.get(API, headers=UA, timeout=30)
            r.raise_for_status()
            # force UTF-8 on the raw bytes — RemoteOK omits a charset header, so
            # httpx guesses latin1 and mojibakes non-ASCII names (Jägermeister).
            rows = json.loads(r.content.decode("utf-8", errors="replace"))
        except Exception as e:
            log.warning("remoteok fetch failed: %s", e)
            return []

        out: List[JobRecord] = []
        for j in rows:
            if not isinstance(j, dict) or not j.get("id") or not j.get("position"):
                continue  # skips the legal notice + malformed rows
            posted = j.get("date")  # already ISO-8601 with tz
            url = j.get("url") or ""
            out.append(JobRecord(
                source="remoteok",
                external_id=str(j.get("id")),
                title=clean_text(str(j.get("position", ""))),
                company_name=clean_text(str(j.get("company", ""))),
                ats_type=None,
                board="remoteok:board",
                location=str(j.get("location") or "Remote").strip(),
                remote=True,
                jd_text=strip_html(j.get("description", "")),
                url=url,
                apply_url=j.get("apply_url") or url,
                posted_at=posted if isinstance(posted, str) else None,
                salary_min=j.get("salary_min") or None,
                salary_max=j.get("salary_max") or None,
                salary_currency="USD" if (j.get("salary_min") or j.get("salary_max")) else None,
                skills=[],  # db extracts from jd_text via the matcher vocab
                trust=TRUST_AGGREGATOR,
            ))
            if len(out) >= cap:
                break
        log.info("remoteok: %d jobs", len(out))
        return out


# P1: third-party aggregator -> register ONLY when explicitly opted in. Defensive
# self-guard so a stray import can never register RemoteOK into the CORE cache ingest.
if os.environ.get("REMOTEOK_ENABLED", "").strip() == "true":
    register(RemoteOK())
else:
    log.info("remoteok not registered (REMOTEOK_ENABLED != 'true')")
