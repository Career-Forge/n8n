"""
Personio public recruiting XML feed (free, keyless) -- registry-driven, company-direct.

  feed: GET {api_base}/xml?language=en   -> whole board, no pagination
  root <workzag-jobs>, repeating <position> with <id>/<office>/<name>/<employmentType>/
  <seniority>/<createdAt> and <jobDescriptions><jobDescription><name/><value CDATA-HTML/>.

REGISTRY-DRIVEN: tenants live in `companies` (ats_type='personio', slug=tenant identifier,
api_base=the VERIFIED origin e.g. https://acme.jobs.personio.de). We NEVER guess .de vs .com:
a row without a usable api_base is failed (backed off) with a warning, not guessed. Public job
URL = {api_base}/job/{id}. Thin work-mode (remote/workplace_type left None) -> geo.py infers
from office/title; no remote is fabricated. No liveness handler yet (find-time falls to
Firecrawl as today). Poll-state cadence mirrors the other registry providers.
"""
import os
import logging
import xml.etree.ElementTree as ET
from typing import List, Optional

import httpx

from . import (Provider, JobRecord, register, TRUST_DIRECT,
               TITLE_RX, CAP_PER_BOARD, strip_html, clean_text, parse_epoch_or_iso)

log = logging.getLogger("providers.personio")
UA = {"User-Agent": "Mozilla/5.0 (careerforge job cache)", "Accept": "application/xml,text/xml,*/*"}


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]                 # namespace-robust local name


def _child(el, name):
    for c in (el if el is not None else []):
        if _local(c.tag) == name:
            return c
    return None


def _ctext(el, name) -> str:
    c = _child(el, name)
    return (c.text or "").strip() if (c is not None and c.text) else ""


class _PersonioGone(Exception):
    """Sentinel: feed 404/410 -> deactivate the board."""


class Personio(Provider):
    name = "personio"
    kind = "free"

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        import db
        limit = int(os.environ.get("ATS_DUE_LIMIT", "25"))
        due = db.select_due_companies("personio", limit)
        if not due:
            log.info("personio: no boards due")
            return []
        recs: List[JobRecord] = []
        ok, failed, gone = [], [], []
        for c in due:                              # sequential: gentle on Personio's shared rate-limit
            board = c["board"]
            try:
                recs.extend(self._fetch_one(c))
                ok.append({"board": board, "etag": None})
            except _PersonioGone:
                gone.append(board)
            except Exception as e:
                log.warning("personio board %s failed: %s", board, e)
                failed.append(board)
        try:
            db.advance_poll_state(ok)
            db.penalize_boards(failed, gone)
        except Exception as e:
            log.warning("personio poll-state update failed: %s", e)
        log.info("personio: %d due, %d jobs (%d ok, %d failed, %d gone)",
                 len(due), len(recs), len(ok), len(failed), len(gone))
        return recs

    def _fetch_one(self, c: dict) -> List[JobRecord]:
        slug = c["slug"]
        company = c.get("name") or ""
        board = c["board"]
        api_base = (c.get("api_base") or "").strip().rstrip("/")
        if not api_base or "://" not in api_base:
            # No verified host -> fail (back off) rather than guess .de/.com.
            raise RuntimeError("missing/invalid api_base (no host guessing)")
        r = httpx.get(f"{api_base}/xml?language=en", headers=UA, timeout=30)
        if r.status_code in (404, 410):
            raise _PersonioGone()
        if r.status_code < 200 or r.status_code >= 300:
            raise RuntimeError(f"http {r.status_code}")        # transient -> failed
        try:
            root = ET.fromstring(r.content)
        except Exception as e:
            raise RuntimeError(f"xml parse: {e}")              # malformed -> failed (NOT gone, MVP)
        domain = api_base.split("://", 1)[1].split("/")[0]
        return list(self._parse(root, slug, company, board, api_base, domain))

    def _parse(self, root, slug, company, board, api_base, domain):
        recs = []
        for pos in root:
            if _local(pos.tag) != "position":
                continue
            if len(recs) >= CAP_PER_BOARD:
                break
            title = clean_text(_ctext(pos, "name"))
            if not title or not TITLE_RX.search(title):
                continue
            pid = _ctext(pos, "id")
            if not pid:
                continue
            office = _ctext(pos, "office")                     # primary office (NOT additionalOffices)
            # JD: concat each <jobDescription> section "label\n<stripped html>"
            parts = []
            jd_el = _child(pos, "jobDescriptions")
            if jd_el is not None:
                for d in jd_el:
                    if _local(d.tag) != "jobDescription":
                        continue
                    label = _ctext(d, "name")
                    vel = _child(d, "value")
                    txt = strip_html((vel.text or "") if vel is not None else "")
                    if txt:
                        parts.append(f"{label}\n{txt}" if label else txt)
            jd_text = "\n\n".join(parts) or (f"{title}\n{office}".strip())
            url = f"{api_base}/job/{pid}"
            recs.append(JobRecord(
                source="personio",
                external_id=f"{slug}:{pid}",
                title=title,
                company_name=company,                          # registry name, not XML subcompany
                company_domain=domain,
                ats_type="personio",
                board=board,
                location=office,
                remote=None,                                   # no fabrication; geo.py infers from office/title
                employment_type=(_ctext(pos, "employmentType") or None),
                seniority=(_ctext(pos, "seniority") or None),
                jd_text=jd_text,
                url=url,
                apply_url=url,
                posted_at=(parse_epoch_or_iso(_ctext(pos, "createdAt")) or None),
                skills=[],
                trust=TRUST_DIRECT,
            ))
        return recs


register(Personio())
