"""
Registry-driven direct-ATS providers — greenhouse / lever / ashby / workable /
recruitee. Each reads boards due for a poll from the `companies` registry, fetches
the board's public API, keeps only role-relevant postings (TITLE_RX) up to a
per-board cap, then ingests through db.py (embed + dedup + trust=DIRECT). Endpoints
+ field maps mirror the n8n ATS poller exactly (the proven, working logic); the
TITLE_RX is fixed here (the n8n version's regex escapes were mangled by JS string
literals). Poll-state bookkeeping (advance / penalize / deactivate) mirrors the
poller too, so this fully replaces it.
"""
import os
import re
import logging
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT,
               strip_html, clean_text, parse_epoch_or_iso,
               TITLE_RX, CAP_PER_BOARD)

log = logging.getLogger("providers.ats")
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)", "Accept": "application/json"}


def _is_remote(*parts) -> bool:
    return bool(re.search(r"remote", " ".join(str(p or "") for p in parts), re.I))


class _RegistryATS(Provider):
    kind = "free"
    ats_type = "base"

    def endpoint(self, slug: str, api_base: str) -> str:
        raise NotImplementedError

    def parse(self, body, company: dict) -> List[dict]:
        """-> list of dicts: external_id,title,jd_text,location,remote,apply_url,posted_at"""
        raise NotImplementedError

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        import db
        limit = int(os.environ.get("ATS_DUE_LIMIT", "25"))
        due = db.select_due_companies(self.ats_type, limit)
        if not due:
            log.info("%s: no boards due", self.ats_type)
            return []

        recs: List[JobRecord] = []
        ok_etags, failed, gone = [], [], []
        for c in due:
            board = c["board"]
            try:
                r = httpx.get(self.endpoint(c["slug"], c.get("api_base", "")), headers=UA, timeout=30)
                st = r.status_code
                if st in (404, 410):
                    gone.append(board)
                    continue
                if st < 200 or st >= 300:
                    failed.append(board)
                    continue
                body = r.json()
                if isinstance(body, dict) and body.get("error"):
                    failed.append(board)
                    continue
                kept = 0
                for d in self.parse(body, c):
                    if not TITLE_RX.search(d.get("title") or ""):
                        continue
                    if kept >= CAP_PER_BOARD:
                        break
                    kept += 1
                    recs.append(JobRecord(
                        source=self.ats_type,
                        external_id=str(d["external_id"]),
                        title=clean_text(d.get("title") or ""),
                        company_name=c.get("name") or "",
                        ats_type=self.ats_type,
                        board=board,
                        location=d.get("location") or "",
                        remote=d.get("remote"),
                        jd_text=d.get("jd_text") or "",
                        url=d.get("apply_url"),
                        apply_url=d.get("apply_url"),
                        posted_at=d.get("posted_at"),
                        trust=TRUST_DIRECT,
                    ))
                ok_etags.append({"board": board, "etag": r.headers.get("etag")})
            except Exception as e:
                log.warning("%s board %s failed: %s", self.ats_type, board, e)
                failed.append(board)

        # poll-state bookkeeping (don't let a DB hiccup lose the fetched jobs)
        try:
            db.advance_poll_state(ok_etags)
            db.penalize_boards(failed, gone)
        except Exception as e:
            log.warning("%s poll-state update failed: %s", self.ats_type, e)
        log.info("%s: %d boards due, %d relevant jobs (%d ok, %d failed, %d gone)",
                 self.ats_type, len(due), len(recs), len(ok_etags), len(failed), len(gone))
        return recs


class Greenhouse(_RegistryATS):
    name = ats_type = "greenhouse"

    def endpoint(self, slug, api_base):
        return f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"

    def parse(self, body, company):
        out = []
        for j in (body.get("jobs") or []):
            loc = (j.get("location") or {}).get("name") or ""
            out.append({
                "external_id": j.get("id"),
                "title": j.get("title") or "",
                "jd_text": strip_html(j.get("content") or ""),
                "location": loc,
                "remote": _is_remote(loc),
                "apply_url": j.get("absolute_url") or "",
                "posted_at": parse_epoch_or_iso(j.get("updated_at") or j.get("first_published")),
            })
        return out


class Lever(_RegistryATS):
    name = ats_type = "lever"

    def endpoint(self, slug, api_base):
        return f"https://api.lever.co/v0/postings/{slug}?mode=json"

    def parse(self, body, company):
        arr = body if isinstance(body, list) else (body.get("data") or [])
        out = []
        for j in arr:
            cat = j.get("categories") or {}
            loc = cat.get("location") or ""
            out.append({
                "external_id": j.get("id"),
                "title": j.get("text") or "",
                "jd_text": j.get("descriptionPlain") or strip_html(j.get("description") or ""),
                "location": loc,
                "remote": _is_remote(loc, j.get("workplaceType")),
                "apply_url": j.get("hostedUrl") or j.get("applyUrl") or "",
                "posted_at": parse_epoch_or_iso(j.get("createdAt")),
            })
        return out


class Ashby(_RegistryATS):
    name = ats_type = "ashby"

    def endpoint(self, slug, api_base):
        return f"https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true"

    def parse(self, body, company):
        out = []
        for j in (body.get("jobs") or []):
            if j.get("isListed") is False:
                continue
            out.append({
                "external_id": j.get("id"),
                "title": j.get("title") or "",
                "jd_text": j.get("descriptionPlain") or strip_html(j.get("descriptionHtml") or ""),
                "location": j.get("location") or "",
                "remote": bool(j.get("isRemote")),
                "apply_url": j.get("jobUrl") or j.get("applyUrl") or "",
                "posted_at": parse_epoch_or_iso(j.get("publishedAt")),
            })
        return out


class Workable(_RegistryATS):
    name = ats_type = "workable"

    def endpoint(self, slug, api_base):
        return f"https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true"

    def parse(self, body, company):
        out = []
        for j in (body.get("jobs") or []):
            loc = ", ".join(x for x in (j.get("city"), j.get("state"), j.get("country")) if x)
            out.append({
                "external_id": j.get("shortcode") or j.get("id"),
                "title": j.get("title") or "",
                "jd_text": strip_html(j.get("description") or ""),
                "location": loc,
                "remote": _is_remote(j.get("workplace"), (j.get("location") or {}).get("location")),
                "apply_url": j.get("url") or j.get("application_url") or "",
                "posted_at": parse_epoch_or_iso(j.get("published_on")),
            })
        return out


class Recruitee(_RegistryATS):
    name = ats_type = "recruitee"

    def endpoint(self, slug, api_base):
        return f"https://{slug}.recruitee.com/api/offers"

    def parse(self, body, company):
        out = []
        for j in (body.get("offers") or []):
            if j.get("status") and j.get("status") != "published":
                continue
            loc = j.get("location") or ", ".join(x for x in (j.get("city"), j.get("country")) if x)
            out.append({
                "external_id": j.get("id"),
                "title": j.get("title") or "",
                "jd_text": strip_html((j.get("description") or "") + " " + (j.get("requirements") or "")),
                "location": loc,
                "remote": _is_remote(j.get("location")),
                "apply_url": j.get("careers_url") or j.get("url") or "",
                "posted_at": parse_epoch_or_iso(j.get("published_at")),
            })
        return out


for _p in (Greenhouse(), Lever(), Ashby(), Workable(), Recruitee()):
    register(_p)
