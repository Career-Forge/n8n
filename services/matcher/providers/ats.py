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
                        # Provider may pass an explicit work-mode (SmartRecruiters remote/hybrid).
                        # Existing providers omit this key -> None -> geo.classify_workplace infers
                        # exactly as before (behavior-preserving).
                        workplace_type=d.get("workplace_type"),
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


class _SRGone(Exception):
    """Sentinel: SmartRecruiters first-page 404/410 -> deactivate the board."""


class SmartRecruiters(_RegistryATS):
    """Public SmartRecruiters Posting API (keyless for PUBLISHED postings):
      list:   GET https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset=N
              -> {totalFound, limit, offset, content[]}
      detail: GET .../postings/{postingId}  (the item 'ref' is exactly this URL)
              -> jobAd.sections {jobDescription,qualifications,additionalInformation,companyDescription}
    Registry-driven (companies.ats_type='smartrecruiters', slug=companyIdentifier).

    P3e BOUNDED PAGINATION: a board is paged (limit=100) until ANY of -- SMARTRECRUITERS_MAX_PAGES
    (default 3, hard-capped at 10) reached / empty content / offset+100 >= totalFound /
    CAP_PER_BOARD relevant jobs kept / a non-first-page HTTP error (stop, keep what we have).
    TITLE_RX filters BEFORE any detail fetch and the kept-cap is shared ACROSS pages, so detail
    GETs stay <= CAP_PER_BOARD total even for a 4k-posting board. First-page 404/410 -> gone;
    first-page other non-2xx / api-error -> failed (existing poll-state backoff). Record mapping,
    JD extraction, workplace_type, external_id and apply_url are UNCHANGED from the single-page MVP.
    location.remote / location.hybrid are explicit booleans -> workplace_type set precisely (no
    fabrication when both absent). No liveness handler here (P3c added it to liveness.py)."""
    name = ats_type = "smartrecruiters"
    HARD_MAX_PAGES = 10

    def _page_url(self, slug, offset):
        return f"https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset={offset}"

    def endpoint(self, slug, api_base):           # interface completeness; fetch() (below) is overridden
        return self._page_url(slug, 0)

    def _max_pages(self):
        try:
            n = int(os.environ.get("SMARTRECRUITERS_MAX_PAGES", "3"))
        except ValueError:
            n = 3
        return max(1, min(n, self.HARD_MAX_PAGES))         # hard safety cap regardless of env

    def parse(self, body, company, remaining=None):
        """One page's content[] -> record-dicts (<= `remaining`). Filters by TITLE_RX BEFORE any
        detail fetch; detail-fetches ONLY matches; never exceeds `remaining` (shared cap budget)."""
        if remaining is None:
            remaining = CAP_PER_BOARD
        slug = company["slug"]
        out = []
        for p in (body.get("content") or []):
            if len(out) >= remaining:
                break                                      # shared cap budget (bounds detail GETs)
            title = clean_text(p.get("name") or "")
            if not TITLE_RX.search(title):
                continue                                   # filter BEFORE any detail fetch
            pid = str(p.get("id") or p.get("uuid") or "")
            if not pid:
                continue
            loc = p.get("location") or {}
            location = ", ".join(x for x in (loc.get("city"), loc.get("region"), loc.get("country")) if x)
            remote = loc.get("remote") if isinstance(loc.get("remote"), bool) else None
            hybrid = loc.get("hybrid") if isinstance(loc.get("hybrid"), bool) else None
            workplace_type = "remote" if remote else ("hybrid" if hybrid else None)
            apply_url = f"https://jobs.smartrecruiters.com/{slug}/{pid}"
            jd_text = f"{title}\n{location}"                # thin fallback if detail unavailable
            ref = p.get("ref") or f"https://api.smartrecruiters.com/v1/companies/{slug}/postings/{pid}"
            try:
                dr = httpx.get(ref, headers=UA, timeout=20)
                if 200 <= dr.status_code < 300:            # non-2xx detail -> keep the thin record
                    dj = dr.json() or {}
                    if dj.get("applyUrl"):
                        apply_url = dj["applyUrl"]
                    sections = ((dj.get("jobAd") or {}).get("sections")) or {}
                    parts = []
                    for key in ("jobDescription", "qualifications", "additionalInformation", "companyDescription"):
                        sec = sections.get(key)
                        txt = sec.get("text") if isinstance(sec, dict) else None
                        if txt:
                            parts.append(strip_html(txt))
                    jd = "\n\n".join(t for t in parts if t)
                    if jd:
                        jd_text = jd
            except Exception:
                pass                                       # 429/5xx/timeout -> thin record (transient)
            out.append({
                "external_id": f"{slug}:{pid}",
                "title": title,
                "jd_text": jd_text,
                "location": location,
                "remote": remote,
                "workplace_type": workplace_type,
                "apply_url": apply_url,
                "posted_at": parse_epoch_or_iso(p.get("releasedDate")),
            })
        return out

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        import db
        due = db.select_due_companies(self.ats_type, int(os.environ.get("ATS_DUE_LIMIT", "25")))
        if not due:
            log.info("smartrecruiters: no boards due")
            return []
        max_pages = self._max_pages()
        recs: List[JobRecord] = []
        ok_etags, failed, gone = [], [], []
        for c in due:
            board, slug = c["board"], c["slug"]
            try:
                dicts, first_etag, pages = [], None, 0
                for page in range(max_pages):
                    offset = page * 100
                    r = httpx.get(self._page_url(slug, offset), headers=UA, timeout=30)
                    st = r.status_code
                    if page == 0:
                        if st in (404, 410):
                            raise _SRGone()
                        if st < 200 or st >= 300:
                            raise RuntimeError(f"http {st}")           # first-page non-2xx -> failed
                        first_etag = r.headers.get("etag")
                    elif st < 200 or st >= 300:
                        break                                          # after-page transient -> stop, keep collected
                    pages += 1
                    body = r.json()
                    if isinstance(body, dict) and body.get("error"):
                        if page == 0:
                            raise RuntimeError("api error")
                        break
                    content = body.get("content") or []
                    if not content:
                        break                                          # no more postings
                    remaining = CAP_PER_BOARD - len(dicts)
                    if remaining <= 0:
                        break
                    dicts.extend(self.parse(body, c, remaining))
                    if len(dicts) >= CAP_PER_BOARD:
                        break                                          # cap reached (across pages)
                    total = body.get("totalFound")
                    if isinstance(total, int) and offset + 100 >= total:
                        break                                          # offset >= totalFound
                for d in dicts:
                    recs.append(JobRecord(
                        source=self.ats_type,
                        external_id=str(d["external_id"]),
                        title=clean_text(d.get("title") or ""),
                        company_name=c.get("name") or "",
                        ats_type=self.ats_type,
                        board=board,
                        location=d.get("location") or "",
                        remote=d.get("remote"),
                        workplace_type=d.get("workplace_type"),        # provider-set (SR remote/hybrid); None elsewhere
                        jd_text=d.get("jd_text") or "",
                        url=d.get("apply_url"),
                        apply_url=d.get("apply_url"),
                        posted_at=d.get("posted_at"),
                        trust=TRUST_DIRECT,
                    ))
                log.info("smartrecruiters %s: %d page(s), %d jobs", board, pages, len(dicts))
                ok_etags.append({"board": board, "etag": first_etag})
            except _SRGone:
                gone.append(board)
            except Exception as e:
                log.warning("smartrecruiters board %s failed: %s", board, e)
                failed.append(board)
        try:
            db.advance_poll_state(ok_etags)
            db.penalize_boards(failed, gone)
        except Exception as e:
            log.warning("smartrecruiters poll-state update failed: %s", e)
        log.info("smartrecruiters: %d due, %d jobs (%d ok, %d failed, %d gone)",
                 len(due), len(recs), len(ok_etags), len(failed), len(gone))
        return recs


for _p in (Greenhouse(), Lever(), Ashby(), Workable(), Recruitee(), SmartRecruiters()):
    register(_p)
