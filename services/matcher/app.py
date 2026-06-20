"""
CareerForge matcher service (Sprint 4) — model-based job match, not LLM scoring.

  POST /match  -> per-job: cross-encoder relevance (bge-reranker-v2-m3) +
                  explainable skill overlap (direct + multi-hop adjacent via a
                  bge-m3 embedding skill graph) -> a transparent match_pct.
  POST /extract_skills, GET /health

Embeddings reuse the Ollama bge-m3 already running in the stack (no second
embedder). The skill graph is built lazily from the vocab and cached to disk;
if Ollama is unreachable, adjacency is skipped (direct overlap still works).
"""
import os
import re
import json
import math
import hashlib
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional, Dict

import numpy as np
import httpx
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import CrossEncoder

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("matcher")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama-service:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
RERANK_MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
DEVICE = os.environ.get("MATCHER_DEVICE", "cpu")
ADJ_THRESHOLD = float(os.environ.get("SKILL_ADJ_THRESHOLD", "0.68"))
ADJ_DECAY = float(os.environ.get("SKILL_ADJ_DECAY", "0.6"))
ADJ_MIN_CREDIT = float(os.environ.get("SKILL_ADJ_MIN_CREDIT", "0.20"))
W_RERANK = float(os.environ.get("MATCH_W_RERANK", "0.65"))
W_SKILL = float(os.environ.get("MATCH_W_SKILL", "0.35"))
DATA_DIR = os.environ.get("MATCHER_DATA_DIR", "/app/data")
HERE = os.path.dirname(os.path.abspath(__file__))

# ── Firecrawl validation + JD enrichment (Sprint 5) ──
FIRECRAWL_API_KEY = os.environ.get("FIRECRAWL_API_KEY", "")
FIRECRAWL_SCRAPE_URL = os.environ.get("FIRECRAWL_SCRAPE_URL", "https://api.firecrawl.dev/v2/scrape")
VALIDATE_TOP_N = int(os.environ.get("VALIDATE_TOP_N", "12"))
JD_MAX_CHARS = int(os.environ.get("JD_MAX_CHARS", "6000"))
CLOSED_MARKERS = re.compile(
    r"no longer (accepting|available|open)|position (has been |is )?(filled|closed)|"
    r"this (job|posting|position|role|req) is (no longer|closed|filled)|applications? (are )?closed|"
    r"posting (is )?(no longer available|closed|expired)|job (posting )?(closed|expired|filled)|"
    r"we are no longer accepting|no longer taking applications|opportunity is closed",
    re.IGNORECASE,
)

app = FastAPI(title="careerforge-matcher")

# vocab + literal skill matchers live in skills.py (shared with the ingestion path)
from skills import VOCAB, extract_skills

# ── cross-encoder (baked into image) ──
log.info("loading cross-encoder %s on %s", RERANK_MODEL, DEVICE)
RERANKER = CrossEncoder(RERANK_MODEL, max_length=512, device=DEVICE)

def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))

# ── embeddings via Ollama + skill graph (lazy, cached) ──
_GRAPH = {"built": False, "adj": {}}  # canonical -> [(neighbor, weight)]

def _embed(text: str) -> Optional[np.ndarray]:
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/embed", json={"model": EMBED_MODEL, "input": text}, timeout=30)
        if r.status_code == 200:
            d = r.json()
            vec = (d.get("embeddings") or [None])[0] or d.get("embedding")
            if vec:
                return np.asarray(vec, dtype=np.float32)
    except Exception as e:
        log.warning("embed /api/embed failed: %s", e)
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/embeddings", json={"model": EMBED_MODEL, "prompt": text}, timeout=30)
        if r.status_code == 200:
            vec = r.json().get("embedding")
            if vec:
                return np.asarray(vec, dtype=np.float32)
    except Exception as e:
        log.warning("embed /api/embeddings failed: %s", e)
    return None

def _vocab_hash() -> str:
    return hashlib.md5(json.dumps(VOCAB, sort_keys=True).encode()).hexdigest()[:10]

def _cache_path() -> str:
    return os.path.join(DATA_DIR, f"skill_emb_{_vocab_hash()}.json")

def _load_embeddings() -> Optional[Dict[str, np.ndarray]]:
    p = _cache_path()
    if os.path.exists(p):
        try:
            with open(p, "r") as f:
                raw = json.load(f)
            return {k: np.asarray(v, dtype=np.float32) for k, v in raw.items()}
        except Exception:
            return None
    return None

def _save_embeddings(emb: Dict[str, np.ndarray]):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(_cache_path(), "w") as f:
            json.dump({k: v.tolist() for k, v in emb.items()}, f)
    except Exception as e:
        log.warning("could not cache skill embeddings: %s", e)

def ensure_graph():
    if _GRAPH["built"]:
        return
    emb = _load_embeddings()
    if emb is None:
        emb = {}
        for canonical, aliases in VOCAB.items():
            phrase = canonical + ((" (" + ", ".join(aliases) + ")") if aliases else "")
            v = _embed(phrase)
            if v is not None:
                emb[canonical] = v
        if emb:
            _save_embeddings(emb)
    if not emb:
        log.warning("skill graph unavailable (no embeddings) — adjacency disabled")
        _GRAPH["built"] = True  # don't retry every request; direct overlap still works
        return
    # normalize + cosine kNN edges
    names = list(emb.keys())
    mat = np.stack([emb[n] / (np.linalg.norm(emb[n]) + 1e-9) for n in names])
    sims = mat @ mat.T
    adj = {}
    for i, n in enumerate(names):
        nb = []
        for j, m in enumerate(names):
            if i != j and sims[i, j] >= ADJ_THRESHOLD:
                nb.append((m, float(sims[i, j])))
        nb.sort(key=lambda x: -x[1])
        adj[n] = nb[:8]
    _GRAPH["adj"] = adj
    _GRAPH["built"] = True
    log.info("skill graph built: %d skills, %d edges", len(adj), sum(len(v) for v in adj.values()))

def adjacency_credit(skill: str, resume_set: set):
    """Best decayed credit if a resume skill is within 2 hops of `skill`."""
    adj = _GRAPH["adj"]
    if not adj or skill not in adj:
        return 0.0, None
    best = 0.0
    via = None
    for nb, w in adj.get(skill, []):  # 1 hop
        if nb in resume_set:
            c = ADJ_DECAY * w
            if c > best:
                best, via = c, nb
    for nb, w in adj.get(skill, []):  # 2 hops
        for nb2, w2 in adj.get(nb, []):
            if nb2 in resume_set:
                c = (ADJ_DECAY ** 2) * w * w2
                if c > best:
                    best, via = c, nb2
    return min(best, 0.9), via

# ── Firecrawl scrape + validation ──
def _scrape_one(url: str):
    """Firecrawl-scrape one URL -> dict(alive, jd, status, note). alive=None means
    'could not determine' (Firecrawl error / thin content) -> treat as unverified, keep."""
    if not url or not FIRECRAWL_API_KEY:
        return {"alive": None, "jd": "", "status": None, "note": "no_scrape"}
    try:
        r = httpx.post(
            FIRECRAWL_SCRAPE_URL,
            headers={"Authorization": f"Bearer {FIRECRAWL_API_KEY}", "Content-Type": "application/json"},
            json={"url": url, "formats": ["markdown"], "onlyMainContent": True, "timeout": 25000},
            timeout=40,
        )
        if r.status_code != 200:
            return {"alive": None, "jd": "", "status": r.status_code, "note": f"scrape_http_{r.status_code}"}
        data = (r.json() or {}).get("data") or {}
        md = (data.get("markdown") or "")[:JD_MAX_CHARS]
        page_status = (data.get("metadata") or {}).get("statusCode")
        if page_status in (404, 410):
            return {"alive": False, "jd": md, "status": page_status, "note": f"http_{page_status}"}
        if md and CLOSED_MARKERS.search(md):
            return {"alive": False, "jd": md, "status": page_status, "note": "closed_marker"}
        if not md or len(md) < 120:
            return {"alive": None, "jd": md, "status": page_status, "note": "thin_content"}
        return {"alive": True, "jd": md, "status": page_status, "note": "ok"}
    except Exception as e:
        return {"alive": None, "jd": "", "status": None, "note": f"error:{type(e).__name__}"}

def validate_and_enrich(jobs, top_n):
    """Scrape the top_n jobs in parallel; drop hard-dead; enrich jd_text with the
    full scraped JD. Returns (kept_jobs, validation_map, dropped)."""
    targets = jobs[: max(0, top_n)]
    results = {}
    if targets and FIRECRAWL_API_KEY:
        with ThreadPoolExecutor(max_workers=min(12, len(targets))) as ex:
            futs = {ex.submit(_scrape_one, j.url): j.id for j in targets}
            for fut in futs:
                results[futs[fut]] = fut.result()
    kept, vmap, dropped = [], {}, []
    for j in jobs:
        res = results.get(j.id)
        if res is None:
            vmap[j.id] = "not_checked"; kept.append(j); continue
        if res["alive"] is False:
            dropped.append({"id": j.id, "reason": res["note"]}); continue
        if res["jd"]:
            j.jd_text = res["jd"]
        vmap[j.id] = "live" if res["alive"] else "unverified"
        kept.append(j)
    return kept, vmap, dropped

# ── API ──
class Job(BaseModel):
    id: str
    title: Optional[str] = ""
    jd_text: str = ""
    url: Optional[str] = ""
    sub_scores: Optional[Dict[str, float]] = None  # optional exp/loc/comp/visa (0-100) from n8n

class MatchRequest(BaseModel):
    resume_text: str
    resume_skills: Optional[List[str]] = None
    jobs: List[Job]
    enrich: bool = False  # scrape+validate top_n via Firecrawl (named 'enrich' to avoid shadowing BaseModel.validate)
    top_n: Optional[int] = None

@app.get("/health")
def health():
    return {"status": "ok", "service": "careerforge-matcher", "rerank_model": RERANK_MODEL,
            "device": DEVICE, "graph_built": _GRAPH["built"], "skills": len(VOCAB)}

class ExtractReq(BaseModel):
    text: str

@app.post("/extract_skills")
def extract_endpoint(req: ExtractReq):
    return {"skills": extract_skills(req.text)}

@app.post("/match")
def match(req: MatchRequest):
    ensure_graph()
    resume_skills = req.resume_skills if req.resume_skills else extract_skills(req.resume_text)
    resume_set = set(resume_skills)

    jobs = req.jobs
    vmap, dropped = {}, []
    if req.enrich:
        jobs, vmap, dropped = validate_and_enrich(jobs, req.top_n or VALIDATE_TOP_N)

    pairs = [(req.resume_text, (j.jd_text or j.title or "")) for j in jobs]
    scores = RERANKER.predict(pairs) if pairs else []

    out = []
    for j, raw in zip(jobs, scores):
        rerank_norm = _sigmoid(float(raw))
        required = extract_skills(j.jd_text)
        matched, missing, adjacent = [], [], []
        for s in required:
            if s in resume_set:
                matched.append(s)
            else:
                credit, via = adjacency_credit(s, resume_set)
                if credit >= ADJ_MIN_CREDIT:
                    adjacent.append({"skill": s, "via": via, "credit": round(credit, 3)})
                else:
                    missing.append(s)
        adj_credit = sum(a["credit"] for a in adjacent)
        coverage = min(1.0, (len(matched) + adj_credit) / max(1, len(required)))
        match_pct = round(100 * (W_RERANK * rerank_norm + W_SKILL * coverage))
        out.append({
            "id": j.id,
            "match_pct": match_pct,
            "rerank_score": round(rerank_norm, 4),
            "validated": vmap.get(j.id, "not_checked"),
            "skill_match": {
                "required": required,
                "matched": matched,
                "missing": missing,
                "adjacent": adjacent,
                "coverage": round(coverage, 3),
            },
            "components": {"rerank": round(rerank_norm, 4), "skill_coverage": round(coverage, 3)},
        })
    out.sort(key=lambda x: -x["match_pct"])
    return {"results": out, "resume_skills": resume_skills, "dropped": dropped}


# ── Discovery: pluggable ingestion (Phase 1) ──────────────────────
import threading
from fastapi import BackgroundTasks

_INGEST_LOCK = threading.Lock()
_INGEST_STATE = {"running": False, "started_at": None, "last": None}
# capture the configured defaults once so a limited call can't leak its override
# into later unlimited (scheduled) calls via the mutated process env.
_DEFAULT_MAX_PER_PROVIDER = os.environ.get("INGEST_MAX_PER_PROVIDER", "250")
_DEFAULT_ATS_DUE_LIMIT = os.environ.get("ATS_DUE_LIMIT", "25")


class IngestReq(BaseModel):
    providers: Optional[List[str]] = None   # subset by plugin name; default = all enabled
    queries: Optional[List[str]] = None     # override the default niche queries
    limit: Optional[int] = None             # per-provider cap override (testing)
    jobs: Optional[List[Dict]] = None        # external pre-normalized batch (n8n poller fold-in)
    background: bool = False                 # return immediately; run in a background task (n8n trigger)


def _records_from_batch(rows):
    """Map a pre-normalized external batch (e.g. the n8n ATS poller) -> JobRecord.
    Requires source + external_id + title; ignores unknown keys."""
    from providers import JobRecord
    fields = set(JobRecord.__dataclass_fields__.keys())
    out = []
    for j in rows or []:
        if not (j.get("source") and j.get("external_id") and j.get("title")):
            continue
        out.append(JobRecord(**{k: v for k, v in j.items() if k in fields}))
    return out


def _do_ingest(req: IngestReq) -> dict:
    """Run enabled providers (optionally a subset) and/or upsert an external batch.
    Embeds on ingest, dedups, resolves trust. Never errors on missing keys."""
    from providers import REGISTRY
    import db

    # set per-call caps deterministically: an explicit limit overrides, otherwise
    # restore configured defaults (so a prior limited call can't throttle this one).
    if req.limit:
        os.environ["INGEST_MAX_PER_PROVIDER"] = str(int(req.limit))  # query providers (remoteok/workday/amazon)
        os.environ["ATS_DUE_LIMIT"] = str(int(req.limit))            # registry providers (# boards polled)
    else:
        os.environ["INGEST_MAX_PER_PROVIDER"] = _DEFAULT_MAX_PER_PROVIDER
        os.environ["ATS_DUE_LIMIT"] = _DEFAULT_ATS_DUE_LIMIT

    per_source, total = {}, {"received": 0, "inserted": 0, "updated": 0, "embedded": 0, "errors": 0}

    def _accumulate(name, recs):
        stats = db.upsert_jobs(recs)
        per_source[name] = stats
        for k in total:
            total[k] += stats.get(k, 0)

    if req.jobs:
        _accumulate("_batch", _records_from_batch(req.jobs))

    selected = [p for p in REGISTRY if p.enabled() and (not req.providers or p.name in req.providers)]
    for p in selected:
        try:
            recs = p.fetch(req.queries)
        except Exception as e:
            log.warning("provider %s fetch failed: %s", p.name, e)
            per_source[p.name] = {"error": str(e)}
            continue
        _accumulate(p.name, recs)

    return {"ran": [p.name for p in selected], "per_source": per_source,
            "total": total, "cache": db.cache_stats()}


def _run_ingest_tracked(req: IngestReq):
    """Wrap _do_ingest with run-state bookkeeping (for background runs)."""
    try:
        summary = _do_ingest(req)
        _INGEST_STATE["last"] = {k: summary[k] for k in ("ran", "per_source", "total")}
    except Exception as e:
        log.exception("background ingest failed")
        _INGEST_STATE["last"] = {"error": str(e)}
    finally:
        _INGEST_STATE["running"] = False


@app.post("/ingest")
def ingest(req: IngestReq, background_tasks: BackgroundTasks):
    """Sync by default (returns the full summary). With background=true, returns
    immediately and runs in a background task — so a long multi-hundred-job run
    can't be truncated by a client/n8n timeout. Single-flight: a second call
    while one is running returns busy."""
    if req.background:
        if not _INGEST_LOCK.acquire(blocking=False):
            return {"status": "busy", "state": _INGEST_STATE}
        if _INGEST_STATE["running"]:
            _INGEST_LOCK.release()
            return {"status": "busy", "state": _INGEST_STATE}
        _INGEST_STATE["running"] = True
        _INGEST_LOCK.release()
        background_tasks.add_task(_run_ingest_tracked, req)
        return {"status": "started"}
    return _do_ingest(req)


@app.get("/sources")
def sources():
    """Which providers are live (free always; keyed iff key present) + cache yield."""
    from providers import REGISTRY
    import db
    try:
        cache = db.cache_stats()
    except Exception as e:
        cache = {"error": str(e)}
    by_source = cache.get("by_source", {}) if isinstance(cache, dict) else {}
    provs = [{
        "name": p.name, "kind": p.kind,
        "enabled": p.enabled(),
        "key_env": p.key_env,
        "cached_jobs": by_source.get(p.name, 0),
    } for p in REGISTRY]
    return {"providers": provs, "cache": cache, "ingest": _INGEST_STATE}
