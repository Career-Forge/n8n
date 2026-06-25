"""
Provider registry — the pluggable, key-gated ingestion layer.

Every source (direct ATS, Workday CXS, aggregator, web) is a uniform plugin:
  - kind 'free'  -> always enabled, no key
  - kind 'keyed' -> enabled iff its key_env is set in the environment
A provider's enabled() self-checks its key at run time, so any subset of keys
works and a fully keyless run still ingests every free lane (never errors).

fetch(query) returns normalized JobRecord[]; db.upsert_jobs() handles embedding,
dedup and trust resolution. Trust order on a dedup collision:
  direct ATS / employer site (30) > Workday (25) > aggregator (20) > web (10).
"""
import os
import re
import html
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import List, Optional

log = logging.getLogger("providers")

# Trust tiers — higher wins a dedup collision (and may overwrite fields).
TRUST_DIRECT = 30      # employer's own ATS board / careers API (greenhouse, lever, amazon.jobs)
TRUST_WORKDAY = 25     # Workday CXS (employer-hosted, list view is thin)
TRUST_AGGREGATOR = 20  # RemoteOK, Fantastic.jobs, JSearch, Adzuna
TRUST_WEB = 10         # serper / firecrawl / you.com snippets

# Default niche queries for query-based providers (amazon.jobs, Workday searchText,
# aggregators). Single-user today; later read from app_settings.
DEFAULT_QUERIES = [
    "AI Engineer",
    "Machine Learning Engineer",
    "LLM Engineer",
    "Software Engineer",
    "Data Scientist",
]

# Seeded big-co Workday tenants: (company, tenant, wd_host, site). The public
# CXS endpoint is POST https://{tenant}.{wd_host}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
# Only NVIDIA is proven live here; others are best-effort and fail isolated
# (a wrong tenant just logs + skips — never sinks the run). Grow this list as
# tenants are verified (Phase 4 auto-discovery will feed it).
WORKDAY_TENANTS = [
    {"company": "NVIDIA", "tenant": "nvidia", "wd": "wd5", "site": "NVIDIAExternalCareerSite"},
]

# Role-relevance filter + per-board cap — shared by the registry ATS providers
# (ats.py) AND the registry Workday provider (workday.py). The registry has 15k+
# boards, so we keep only niche + general eng/data roles. Defined here (this
# module is imported first by _load_plugins) so both submodules import it safely
# regardless of load order.
TITLE_RX = re.compile(
    r"(machine\s*learning|\bml\b|\bai\b|artificial\s*intelligence|data\s*(scien|engineer|analy|platform)|"
    r"analytics\s*engineer|deep\s*learning|\bnlp\b|\bllm\b|gen\s*ai|generative|computer\s*vision|"
    r"research\s*(scientist|engineer)|applied\s*scientist|software\s*engineer|\bswe\b|\bsde\b|"
    r"backend|back-end|full[\s-]*stack|platform\s*engineer|infrastructure\s*engineer|devops|mlops|\bsre\b)",
    re.IGNORECASE,
)
CAP_PER_BOARD = int(os.environ.get("ATS_CAP_PER_BOARD", "25"))


@dataclass
class JobRecord:
    source: str                              # plugin name: remoteok | workday | amazon | greenhouse | ...
    external_id: str                         # provider-native job id (source_job_id in the contract)
    title: str
    company_name: str = ""
    company_domain: Optional[str] = None
    ats_type: Optional[str] = None           # greenhouse|lever|ashby|workday|… (None for pure aggregators)
    board: Optional[str] = None              # ats_type:slug — scopes the per-board liveness diff
    location: Optional[str] = None
    remote: Optional[bool] = None
    employment_type: Optional[str] = None    # full-time|contract|intern|…
    seniority: Optional[str] = None
    jd_text: str = ""
    url: Optional[str] = None                # canonical posting URL
    apply_url: Optional[str] = None
    posted_at: Optional[str] = None          # ISO-8601 string or None
    salary_min: Optional[float] = None
    salary_max: Optional[float] = None
    salary_currency: Optional[str] = None
    skills: List[str] = field(default_factory=list)
    trust: int = TRUST_WEB


class Provider:
    name: str = "base"
    kind: str = "free"                       # 'free' | 'keyed'
    key_env: Optional[str] = None

    def enabled(self) -> bool:
        if self.kind == "free":
            return True
        return bool(self.key_env and os.environ.get(self.key_env, "").strip())

    def fetch(self, queries: Optional[List[str]] = None) -> List[JobRecord]:
        raise NotImplementedError


REGISTRY: List[Provider] = []


def register(provider: Provider) -> Provider:
    REGISTRY.append(provider)
    return provider


# ── shared parsing helpers ────────────────────────────────────────
def iso_or_none(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


_REL_DAYS = re.compile(r"(\d+)\s*day", re.I)
_REL_MONTHS = re.compile(r"(\d+)\+?\s*month", re.I)


def parse_relative_posted(text: str, now: Optional[datetime] = None) -> Optional[str]:
    """Workday 'postedOn' strings: 'Posted Today' | 'Posted Yesterday' |
    'Posted 5 Days Ago' | 'Posted 30+ Days Ago' -> approximate ISO timestamp."""
    if not text:
        return None
    now = now or datetime.now(timezone.utc)
    t = text.lower()
    if "today" in t:
        return iso_or_none(now)
    if "yesterday" in t:
        return iso_or_none(now - timedelta(days=1))
    m = _REL_DAYS.search(t)
    if m:
        return iso_or_none(now - timedelta(days=int(m.group(1))))
    m = _REL_MONTHS.search(t)
    if m:
        return iso_or_none(now - timedelta(days=30 * int(m.group(1))))
    return None


def parse_human_date(text: str) -> Optional[str]:
    """amazon.jobs 'June 19, 2026' / ISO / 'YYYY-MM-DD' -> ISO, else None."""
    if not text:
        return None
    text = text.strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y-%m-%d", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return iso_or_none(datetime.strptime(text, fmt))
        except ValueError:
            continue
    # last resort: ISO with trailing Z
    try:
        return iso_or_none(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except Exception:
        return None


def parse_epoch_or_iso(v) -> Optional[str]:
    """ATS dates: epoch seconds/millis (lever createdAt) OR ISO string -> ISO."""
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        ts = v / 1000.0 if v > 1e11 else float(v)  # millis vs seconds
        try:
            return iso_or_none(datetime.fromtimestamp(ts, timezone.utc))
        except Exception:
            return None
    s = str(v).strip()
    if s.isdigit():
        return parse_epoch_or_iso(int(s))
    return parse_human_date(s)


def clean_text(s: str) -> str:
    """Decode HTML entities (&amp; -> &) + trim. For short fields (title, company)."""
    if not s:
        return s or ""
    return html.unescape(s).strip()


def strip_html(raw: str) -> str:
    if not raw:
        return ""
    txt = re.sub(r"<br\s*/?>", "\n", raw, flags=re.I)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = html.unescape(txt)
    txt = re.sub(r"[ \t]+", " ", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt)
    return txt.strip()


def looks_remote(*parts: str) -> Optional[bool]:
    blob = " ".join(p for p in parts if p).lower()
    if not blob:
        return None
    if "remote" in blob or "work from home" in blob or "wfh" in blob:
        return True
    return None


# Import provider modules so they self-register. Keep at the bottom to avoid
# partial-init cycles; each import is isolated (a broken module logs + skips).
def _load_plugins():
    for mod in ("remoteok", "workday", "amazonjobs", "ats"):
        try:
            __import__(f"providers.{mod}")
        except Exception as e:  # pragma: no cover
            log.warning("provider module %s failed to load: %s", mod, e)


_load_plugins()
