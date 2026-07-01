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
# M: piecewise-linear calibration. The raw rerank+skill blend compresses good matches
# into the 50-75% band ("<80%, forget 90"); the cross-encoder rerank is a narrow signal
# (~0.5-0.7) so the useful spread lives in base ~0.30-0.70. Map that band up to 45-93%
# (strong matches reach the 85-95% the user expects) while keeping weak matches low +
# discriminative. Above IN_HI maps OUT_HI..1.0; below IN_LO maps 0..OUT_LO. All tunable.
CAL_IN_LO  = float(os.environ.get("MATCH_CAL_IN_LO", "0.30"))
CAL_IN_HI  = float(os.environ.get("MATCH_CAL_IN_HI", "0.70"))
CAL_OUT_LO = float(os.environ.get("MATCH_CAL_OUT_LO", "0.45"))
CAL_OUT_HI = float(os.environ.get("MATCH_CAL_OUT_HI", "0.93"))

def _calibrate(base):
    if base <= CAL_IN_LO:
        return (base / CAL_IN_LO) * CAL_OUT_LO if CAL_IN_LO > 0 else CAL_OUT_LO
    if base >= CAL_IN_HI:
        return CAL_OUT_HI + (min(base, 1.0) - CAL_IN_HI) / max(1e-6, 1.0 - CAL_IN_HI) * (1.0 - CAL_OUT_HI)
    return CAL_OUT_LO + (base - CAL_IN_LO) / (CAL_IN_HI - CAL_IN_LO) * (CAL_OUT_HI - CAL_OUT_LO)
DATA_DIR = os.environ.get("MATCHER_DATA_DIR", "/app/data")
HERE = os.path.dirname(os.path.abspath(__file__))

# ── Firecrawl validation + JD enrichment (Sprint 5) ──
FIRECRAWL_API_KEY = os.environ.get("FIRECRAWL_API_KEY", "")
FIRECRAWL_SCRAPE_URL = os.environ.get("FIRECRAWL_SCRAPE_URL", "https://api.firecrawl.dev/v2/scrape")
VALIDATE_TOP_N = int(os.environ.get("VALIDATE_TOP_N", "12"))
# Tier 3 headless renderer (optional): authoritative final check for jobs the JSON-API
# liveness can't resolve (scrape-only sources / JSON-403-blocked). Unset -> degrade to Firecrawl.
RENDERER_URL = os.environ.get("RENDERER_URL", "").rstrip("/")
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
import liveness  # find-time per-source liveness (Tier 2)

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

def _render_check(url: str):
    """Tier 3 headless renderer (optional). POST the public URL to the renderer service,
    which loads the real (JS-rendered) page and decides liveness. Returns
    {alive, jd, note} or None when disabled/unreachable (caller falls through to Firecrawl)."""
    if not url or not RENDERER_URL:
        return None
    try:
        r = httpx.post(f"{RENDERER_URL}/check", json={"url": url}, timeout=45)
        if r.status_code != 200:
            return None
        d = r.json() or {}
        return {"alive": d.get("alive"), "jd": d.get("jd") or "", "note": d.get("note") or "render"}
    except Exception as e:
        log.warning("renderer check failed: %s", e)
        return None


def validate_and_enrich(cands):
    """Find-time liveness for the post-rerank top-N. Per candidate, cascade:
      1) liveness.check_alive -> the source's authoritative JSON (Workday CXS detail,
         lever/greenhouse/recruitee by-id, ashby/workable board-membership, giants' detail).
         Definitive True (enrich JD) / False (drop) resolved here.
      2) undetermined (alive None) -> Tier 3 headless renderer (if RENDERER_URL set).
      3) still undetermined -> Firecrawl scrape (_scrape_one).
    Everything kept is liveness-checked or explicitly unverified; dead jobs go to `dropped`
    and never reach the user. (Replaces the old blanket _ATS_LIVE 'assume live' skip --
    cached ATS copies CAN be stale, so each gets a real check now.)"""
    # PASS A -- authoritative per-source JSON check, concurrently.
    live_res = {}
    if cands:
        with ThreadPoolExecutor(max_workers=min(12, len(cands))) as ex:
            futs = {ex.submit(liveness.check_alive, j): j.id for j in cands}
            for fut in futs:
                try:
                    live_res[futs[fut]] = fut.result()
                except Exception:
                    live_res[futs[fut]] = (None, None, "error")

    # PASS B -- the undetermined fall through to headless (Tier 3) then Firecrawl.
    undetermined = [j for j in cands if (live_res.get(j.id) or (None,))[0] is None]
    fallback = {}
    if undetermined:
        def _resolve(j):
            rc = _render_check(j.apply_url or j.url)                 # Tier 3 headless (authoritative if enabled)
            if rc is not None and rc.get("alive") is not None:
                return rc
            if FIRECRAWL_API_KEY:
                return _scrape_one(j.apply_url or j.url)             # Firecrawl fallback
            return rc                                                # None -> unchecked
        with ThreadPoolExecutor(max_workers=min(12, len(undetermined))) as ex:
            futs = {ex.submit(_resolve, j): j.id for j in undetermined}
            for fut in futs:
                try:
                    fallback[futs[fut]] = fut.result()
                except Exception:
                    fallback[futs[fut]] = None

    kept, vmap, dropped = [], {}, []
    for j in cands:
        alive, jd, note = live_res.get(j.id, (None, None, "no_handler"))
        if alive is True:
            if jd:
                j.jd_text = jd
            vmap[j.id] = "live"; kept.append(j); continue
        if alive is False:
            dropped.append({"id": j.id, "reason": note}); continue
        res = fallback.get(j.id)                                     # undetermined -> headless/Firecrawl
        if res is None:
            vmap[j.id] = "not_checked"; kept.append(j); continue
        if res.get("alive") is False:
            dropped.append({"id": j.id, "reason": res.get("note")}); continue
        if res.get("jd"):
            j.jd_text = res["jd"]
        vmap[j.id] = "live" if res.get("alive") else "unverified"
        kept.append(j)
    return kept, vmap, dropped

# ── API ──
class Job(BaseModel):
    id: str
    title: Optional[str] = ""
    jd_text: str = ""
    url: Optional[str] = ""
    source: Optional[str] = None        # real ATS provider (workday/lever/ashby/...) for find-time liveness routing
    board: Optional[str] = None         # ats_type:slug (greenhouse/ashby slug, etc.)
    external_id: Optional[str] = None   # provider-native id
    apply_url: Optional[str] = None     # canonical apply URL (preferred over url for liveness)
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

def _skill_breakdown(jd_text, resume_set):
    required = extract_skills(jd_text)
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
    return required, matched, missing, adjacent, coverage


def _result(j, rerank_norm, resume_set, validated):
    required, matched, missing, adjacent, coverage = _skill_breakdown(j.jd_text, resume_set)
    base = W_RERANK * rerank_norm + W_SKILL * coverage
    match_pct = round(100 * _calibrate(base))   # M: calibrated (see _calibrate)
    # M: an explicit, deterministic "why" -- verdict from the calibrated score + the skill
    # evidence (the hard caps for field/location/experience are already applied upstream).
    verdict = ("Strong match" if match_pct >= 85 else "Good match" if match_pct >= 72
               else "Partial match" if match_pct >= 55 else "Stretch")
    why = verdict
    if matched:
        why += " -- have " + ", ".join(matched[:3])
    if missing:
        why += "; gap: " + ", ".join(missing[:2])
    return {
        "id": j.id,
        "match_pct": match_pct,
        "verdict": verdict,
        "why": why,
        "rerank_score": round(rerank_norm, 4),
        "validated": validated,
        "skill_match": {
            "required": required, "matched": matched, "missing": missing,
            "adjacent": adjacent, "coverage": round(coverage, 3),
        },
        "components": {"rerank": round(rerank_norm, 4), "skill_coverage": round(coverage, 3), "base": round(base, 3)},
    }


_RERANK_RESUME_CHARS = int(os.environ.get("RERANK_RESUME_CHARS", "3000"))
_RERANK_JD_CHARS    = int(os.environ.get("RERANK_JD_CHARS", "2000"))

def _rerank(resume_text, jobs):
    """Cross-encoder rerank -> {id: rerank_norm} (sigmoid-normalized).
    Truncate inputs before feeding the cross-encoder -- it truncates at max_length=512
    tokens anyway, so sending multi-KB strings just wastes tokenization time on CPU."""
    if not jobs:
        return {}
    r = resume_text[:_RERANK_RESUME_CHARS]
    pairs = [(r, (j.jd_text or j.title or "")[:_RERANK_JD_CHARS]) for j in jobs]
    raw = RERANKER.predict(pairs)
    return {j.id: _sigmoid(float(s)) for j, s in zip(jobs, raw)}


@app.post("/match")
def match(req: MatchRequest):
    """True 2-pass match (fixes validate-set != display-set):
      PASS 1 -- rerank ALL jobs on whatever JD we have (snippet or full).
      SELECT -- the post-rerank top-N by provisional match% are the candidates.
      PASS 2 -- validate+enrich ONLY those candidates (drop dead, swap in full JD).
      PASS 3 -- re-rank the survivors on the full JD and re-score.
    Verified survivors are returned first, so everything displayed at the top was
    liveness-checked and full-JD-matched. Non-candidates keep provisional scores."""
    ensure_graph()
    resume_skills = req.resume_skills if req.resume_skills else extract_skills(req.resume_text)
    resume_set = set(resume_skills)
    top_n = req.top_n or VALIDATE_TOP_N
    jobs = req.jobs
    if not jobs:
        return {"results": [], "resume_skills": resume_skills, "dropped": []}

    # PASS 1 -- provisional rerank + score over everything
    prov = _rerank(req.resume_text, jobs)

    def prov_pct(j):
        _, _, _, _, cov = _skill_breakdown(j.jd_text, resume_set)
        return W_RERANK * prov.get(j.id, 0.0) + W_SKILL * cov

    # SELECT -- the actual top-N we will show become the validation set
    ordered = sorted(jobs, key=lambda j: -prov_pct(j))
    candidates = ordered[:top_n]
    cand_ids = {j.id for j in candidates}

    # PASS 2 -- validate + enrich exactly those candidates
    vmap, dropped = {}, []
    if req.enrich:
        survivors, vmap, dropped = validate_and_enrich(candidates)
    else:
        survivors = candidates

    # PASS 3 -- re-rank survivors on the (now full) JD, re-score
    re_norm = _rerank(req.resume_text, survivors) if req.enrich else prov
    survivor_out = [_result(j, re_norm.get(j.id, prov.get(j.id, 0.0)), resume_set, vmap.get(j.id, "not_checked"))
                    for j in survivors]
    # non-candidates keep their provisional score and stay unverified
    rest_out = [_result(j, prov.get(j.id, 0.0), resume_set, "not_checked")
                for j in jobs if j.id not in cand_ids]

    survivor_out.sort(key=lambda x: -x["match_pct"])
    rest_out.sort(key=lambda x: -x["match_pct"])
    return {"results": survivor_out + rest_out, "resume_skills": resume_skills, "dropped": dropped}


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

    # liveness diff: close jobs that dropped out of their board's feed (keeps the
    # cache fresh -- filled reqs disappear instead of lingering as 'active').
    try:
        closed_stale = db.close_stale_jobs()
    except Exception as e:
        log.warning("close_stale_jobs failed: %s", e)
        closed_stale = 0

    return {"ran": [p.name for p in selected], "per_source": per_source,
            "total": total, "closed_stale": closed_stale, "cache": db.cache_stats()}


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
