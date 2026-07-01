"""
Postgres ingestion layer for the discovery service.

  upsert_jobs(records)  — embed-on-ingest (bge-m3) + dedup + trust-gated upsert
                          into the shared `jobs` cache.
  cache_stats()         — pool health for /sources + verification.

Dedup: a canonical, job-specific apply/posting URL -> 'url:<canon>'; otherwise a
content hash 'kt:<sha1(company|title|location)>'. The DB enforces uniqueness on
dedup_key (partial unique index); on collision the highest-trust copy wins and
nulls are backfilled from the loser. canonical_url() mirrors the schema.sql
backfill so legacy + new rows share the same key space.
"""
import os
import re
import hashlib
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Optional

import psycopg

from embed import embed_text
from skills import extract_skills
import geo

log = logging.getLogger("db")

DSN = (
    f"host={os.environ.get('PGHOST', 'postgres-service')} "
    f"port={os.environ.get('PGPORT', '5432')} "
    f"dbname={os.environ.get('POSTGRES_DB', 'careerforge')} "
    f"user={os.environ.get('POSTGRES_USER', 'careerforge')} "
    f"password={os.environ.get('POSTGRES_PASSWORD', 'cf_local_dev')}"
)

EMBED_WORKERS = int(os.environ.get("INGEST_EMBED_WORKERS", "4"))
JD_EMBED_CHARS = int(os.environ.get("INGEST_JD_EMBED_CHARS", "2000"))

_SCHEME = re.compile(r"^https?://(www\.)?", re.I)
_GENERIC_TAIL = re.compile(r"/(jobs?|careers?|positions?|openings?|search|all)/?$", re.I)
_DIGIT_RUN = re.compile(r"\d{4,}")
_NONALNUM = re.compile(r"[^a-z0-9]+")


def canonical_url(url: str) -> str:
    """Mirror of the schema.sql backfill: strip scheme/www, query/fragment, trailing slash."""
    if not url:
        return ""
    u = _SCHEME.sub("", url.strip().lower())
    u = re.sub(r"[#?].*$", "", u)
    return u.rstrip("/")


def is_job_specific(url: str) -> bool:
    """A URL we trust as a per-job dedup anchor: has a path, isn't a generic
    listing page, and carries a numeric id or a long descriptive slug."""
    c = canonical_url(url)
    if not c or "/" not in c:
        return False
    if _GENERIC_TAIL.search("/" + c):
        return False
    if _DIGIT_RUN.search(c):
        return True
    return c.rsplit("/", 1)[-1].count("-") >= 3


def _norm(s: str) -> str:
    return _NONALNUM.sub(" ", (s or "").lower()).strip()


def dedup_key(rec) -> str:
    for u in (rec.apply_url, rec.url):
        if u and is_job_specific(u):
            return "url:" + canonical_url(u)
    h = hashlib.sha1("|".join(_norm(x) for x in (rec.company_name, rec.title, rec.location or "")).encode()).hexdigest()
    return "kt:" + h


def _vec_literal(vec: Optional[List[float]]) -> Optional[str]:
    if not vec:
        return None
    return "[" + ",".join(f"{x:.6g}" for x in vec) + "]"


_COLS = [
    "source", "external_id", "board", "ats_type", "company_name", "company_domain",
    "title", "jd_text", "location", "remote", "employment_type", "seniority", "skills",
    "salary_min", "salary_max", "salary_currency", "url", "apply_url", "posted_at",
    "dedup_key", "trust",
    "lat", "lng", "country_iso", "geonameid", "workplace_type", "allowed_countries",
]

_INSERT = f"""
INSERT INTO jobs (
  {", ".join(_COLS)}, company_id, status, first_seen, last_seen, embedding
) VALUES (
  %(source)s, %(external_id)s, %(board)s, %(ats_type)s, %(company_name)s, %(company_domain)s,
  %(title)s, %(jd_text)s, %(location)s, %(remote)s, %(employment_type)s, %(seniority)s, %(skills)s,
  %(salary_min)s, %(salary_max)s, %(salary_currency)s, %(url)s, %(apply_url)s, %(posted_at)s::timestamptz,
  %(dedup_key)s, %(trust)s,
  %(lat)s, %(lng)s, %(country_iso)s, %(geonameid)s, %(workplace_type)s, %(allowed_countries)s,
  NULL, 'active', now(), now(), %(embedding)s::vector
)
ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET
  last_seen = now(),
  status = 'active',
  closed_at = NULL,
  trust = GREATEST(jobs.trust, EXCLUDED.trust),
  title         = CASE WHEN EXCLUDED.trust >= jobs.trust AND EXCLUDED.title <> '' THEN EXCLUDED.title ELSE jobs.title END,
  company_name  = CASE WHEN EXCLUDED.trust >= jobs.trust AND EXCLUDED.company_name <> '' THEN EXCLUDED.company_name
                       ELSE COALESCE(NULLIF(jobs.company_name, ''), EXCLUDED.company_name) END,
  url           = CASE WHEN EXCLUDED.trust >= jobs.trust THEN EXCLUDED.url ELSE COALESCE(jobs.url, EXCLUDED.url) END,
  apply_url     = CASE WHEN EXCLUDED.trust >= jobs.trust THEN EXCLUDED.apply_url ELSE COALESCE(jobs.apply_url, EXCLUDED.apply_url) END,
  location        = COALESCE(NULLIF(EXCLUDED.location, ''), jobs.location),
  company_domain  = COALESCE(jobs.company_domain, EXCLUDED.company_domain),
  employment_type = COALESCE(jobs.employment_type, EXCLUDED.employment_type),
  seniority       = COALESCE(jobs.seniority, EXCLUDED.seniority),
  remote          = COALESCE(jobs.remote, EXCLUDED.remote),
  lat               = COALESCE(jobs.lat, EXCLUDED.lat),
  lng               = COALESCE(jobs.lng, EXCLUDED.lng),
  country_iso       = COALESCE(jobs.country_iso, EXCLUDED.country_iso),
  geonameid         = COALESCE(jobs.geonameid, EXCLUDED.geonameid),
  workplace_type    = COALESCE(jobs.workplace_type, EXCLUDED.workplace_type),
  allowed_countries = COALESCE(jobs.allowed_countries, EXCLUDED.allowed_countries),
  salary_min      = COALESCE(jobs.salary_min, EXCLUDED.salary_min),
  salary_max      = COALESCE(jobs.salary_max, EXCLUDED.salary_max),
  salary_currency = COALESCE(jobs.salary_currency, EXCLUDED.salary_currency),
  posted_at       = COALESCE(jobs.posted_at, EXCLUDED.posted_at),
  skills    = CASE WHEN COALESCE(array_length(EXCLUDED.skills, 1), 0) > COALESCE(array_length(jobs.skills, 1), 0)
                   THEN EXCLUDED.skills ELSE jobs.skills END,
  jd_text   = CASE WHEN length(EXCLUDED.jd_text) > length(jobs.jd_text) THEN EXCLUDED.jd_text ELSE jobs.jd_text END,
  embedding = CASE WHEN length(EXCLUDED.jd_text) > length(jobs.jd_text) AND EXCLUDED.embedding IS NOT NULL
                   THEN EXCLUDED.embedding ELSE COALESCE(jobs.embedding, EXCLUDED.embedding) END
RETURNING (xmax = 0) AS inserted
"""


def _embed_text_for(rec) -> Optional[List[float]]:
    blob = "\n".join(x for x in (rec.title, rec.company_name, rec.location, rec.jd_text[:JD_EMBED_CHARS]) if x)
    return embed_text(blob)


def _fetch_existing(keys: list) -> dict:
    """Batch-fetch jd_len + has_embedding for given dedup_keys (single query)."""
    valid = [k for k in keys if k]
    if not valid:
        return {}
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT dedup_key, length(jd_text) AS jd_len, embedding IS NOT NULL AS has_embedding "
                "FROM jobs WHERE dedup_key = ANY(%s)",
                (valid,),
            )
            return {row[0]: {"jd_len": row[1] or 0, "has_embedding": bool(row[2])}
                    for row in cur.fetchall()}


def upsert_jobs(records: list) -> Dict[str, int]:
    """Embed (parallel, skip-if-unchanged) + dedup + trust-gated upsert. Returns counts."""
    if not records:
        return {"received": 0, "inserted": 0, "updated": 0, "embedded": 0, "errors": 0}

    # 1) enrich off-DB: skills extraction
    for r in records:
        if not r.skills:
            r.skills = extract_skills(r.jd_text or r.title)

    # 2) precompute dedup_keys for all records (avoids recomputing inside the upsert loop)
    keys = [dedup_key(r) for r in records]

    # 3) batch-fetch existing row metadata (one query, outside the embed phase)
    existing = _fetch_existing(keys)

    # 4) decide which records need embedding
    #    embed if: new record | existing has no embedding | incoming JD is strictly longer
    to_embed: Dict[int, object] = {}
    for i, (r, k) in enumerate(zip(records, keys)):
        ex = existing.get(k)
        if ex is None:
            to_embed[i] = r                          # new record
        elif not ex["has_embedding"]:
            to_embed[i] = r                          # existing row lacks embedding
        elif len(r.jd_text or "") > ex["jd_len"]:
            to_embed[i] = r                          # incoming JD is longer → embed

    skip_count = len(records) - len(to_embed)
    if skip_count:
        log.debug("embed: skipping %d/%d (unchanged, existing embedding present)", skip_count, len(records))

    # 5) embed in parallel (only the needed subset; keeps the DB txn short)
    embeds: Dict[int, Optional[List[float]]] = {}
    if to_embed:
        with ThreadPoolExecutor(max_workers=EMBED_WORKERS) as ex:
            futs = {ex.submit(_embed_text_for, r): i for i, r in to_embed.items()}
            for fut in futs:
                try:
                    embeds[futs[fut]] = fut.result()
                except Exception:
                    embeds[futs[fut]] = None

    inserted = updated = embedded = errors = 0
    with psycopg.connect(DSN, autocommit=False) as conn:
        with conn.cursor() as cur:
            # L1: resolve place + classify work-mode for the whole batch, in place.
            # Enrichment, not correctness — a geo failure must not sink the ingest.
            try:
                geo.geocode_records(cur, records)
            except Exception as e:
                conn.rollback()
                log.warning("geocode_records failed, ingesting without geo: %s", e)
            for i, r in enumerate(records):
                vec = embeds.get(i)  # None for skipped records
                params = {
                    "source": r.source, "external_id": r.external_id,
                    "board": r.board, "ats_type": r.ats_type,
                    "company_name": r.company_name or "", "company_domain": r.company_domain,
                    "title": r.title or "", "jd_text": r.jd_text or "",
                    "location": r.location, "remote": r.remote,
                    "employment_type": r.employment_type, "seniority": r.seniority,
                    "skills": r.skills or [],
                    "salary_min": r.salary_min, "salary_max": r.salary_max,
                    "salary_currency": r.salary_currency,
                    "url": r.url, "apply_url": r.apply_url or r.url,
                    "posted_at": r.posted_at,
                    "dedup_key": keys[i],  # use precomputed key
                    "trust": int(r.trust),
                    "lat": r.lat, "lng": r.lng, "country_iso": r.country_iso,
                    "geonameid": r.geonameid, "workplace_type": r.workplace_type,
                    "allowed_countries": r.allowed_countries,
                    "embedding": _vec_literal(vec),  # None if skipped; SQL keeps existing embedding
                }
                try:
                    cur.execute(_INSERT, params)
                    row = cur.fetchone()
                    if row and row[0]:
                        inserted += 1
                    else:
                        updated += 1
                    if vec is not None:
                        embedded += 1
                except Exception as e:
                    conn.rollback()
                    errors += 1
                    log.warning("upsert failed (%s/%s): %s", r.source, r.external_id, e)
                    continue
            conn.commit()
    return {"received": len(records), "inserted": inserted, "updated": updated,
            "embedded": embedded, "errors": errors}


import json as _json


def select_due_companies(ats_type: str, limit: int = 25) -> List[dict]:
    """Registry boards of one ATS type due for a poll. Curated boards poll FIRST
    (dream > hot > warm > probe > cold) so the ~15k bulk-seeded tail can't starve
    the hand-picked top companies — they refresh every cycle, the tail fills in
    gradually behind them."""
    sql = """
        SELECT id AS company_id, name, ats_type, slug, COALESCE(api_base,'') AS api_base,
               (ats_type || ':' || slug) AS board, COALESCE(etag,'') AS etag
        FROM companies
        WHERE is_active AND next_poll_at <= now() AND ats_type = %s
        ORDER BY CASE tier WHEN 'dream' THEN 0 WHEN 'hot' THEN 1 WHEN 'warm' THEN 2
                           WHEN 'probe' THEN 3 ELSE 4 END,
                 next_poll_at ASC
        LIMIT %s
    """
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (ats_type, limit))
            cols = [d.name for d in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]


def advance_poll_state(etag_rows: List[dict]):
    """Mark polled boards fresh: bump next_poll_at, reset failures, store etag.
    etag_rows: [{'board': 'greenhouse:slug', 'etag': '...'|None}, ...]"""
    if not etag_rows:
        return
    sql = """
        UPDATE companies SET last_polled_at = now(), next_poll_at = now() + poll_interval,
               consecutive_failures = 0, etag = COALESCE(e.etag, companies.etag)
        FROM jsonb_to_recordset(%s::jsonb) AS e(board text, etag text)
        WHERE (companies.ats_type || ':' || companies.slug) = e.board
    """
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (_json.dumps(etag_rows),))
        conn.commit()


def penalize_boards(failed: List[str], gone: List[str]):
    """Back off failing boards (exponential), deactivate 404/410 boards or after 5 fails."""
    if not failed and not gone:
        return
    sql = """
        UPDATE companies SET consecutive_failures = consecutive_failures + 1, last_polled_at = now(),
            next_poll_at = now() + LEAST(poll_interval * POWER(2, LEAST(consecutive_failures + 1, 6)), interval '7 days'),
            is_active = CASE WHEN (ats_type || ':' || slug) = ANY(string_to_array(%(gone)s, ','))
                             THEN false ELSE (consecutive_failures + 1) < 5 END
        WHERE (ats_type || ':' || slug) = ANY(string_to_array(%(failed)s, ','))
           OR (ats_type || ':' || slug) = ANY(string_to_array(%(gone)s, ','))
    """
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, {"failed": ",".join(failed), "gone": ",".join(gone)})
        conn.commit()


def close_stale_jobs() -> int:
    """Per-board liveness diff (cf_close_stale_jobs): close active jobs that dropped
    out of their board's feed (last_seen trails the board's latest poll) or are
    absurdly stale. Called after each ingest. Self-healing -- a job that reappears in
    a later poll is reactivated by upsert_jobs' ON CONFLICT (status='active')."""
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT cf_close_stale_jobs()")
            n = cur.fetchone()[0]
        conn.commit()
    return int(n or 0)


def cache_stats() -> dict:
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT count(*),
                       count(*) FILTER (WHERE embedding IS NOT NULL),
                       count(*) FILTER (WHERE status = 'active'),
                       count(*) FILTER (WHERE posted_at > now() - interval '7 days'),
                       count(DISTINCT company_name)
                FROM jobs
            """)
            total, embedded, active, fresh7d, companies = cur.fetchone()
            cur.execute("SELECT source, count(*) FROM jobs GROUP BY source ORDER BY count(*) DESC")
            by_source = {s: n for s, n in cur.fetchall()}
    return {"total": total, "embedded": embedded, "active": active,
            "fresh_7d": fresh7d, "distinct_companies": companies, "by_source": by_source}
