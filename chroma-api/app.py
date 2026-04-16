"""
CareerForge ChromaDB HTTP Wrapper
----------------------------------
Lightweight Flask microservice that gives n8n a clean JSON API
to talk to ChromaDB 0.5.x via its v1 REST API.

ChromaDB 0.5.x computes embeddings server-side (all-MiniLM-L6-v2),
so we just pass plain text documents — no embedding code needed here.

Collections managed:
  master_resume       - chunked resume text by section
  job_history         - every job seen / applied
  generated_docs      - summaries of resume + CL generated
  user_preferences    - location, visa, role prefs, salary range
  conversation_memory - key decisions, context, avatar convos

Port: 5680
"""

import os
import uuid
import logging
from datetime import datetime, timezone

import requests
from flask import Flask, request, jsonify

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# ChromaDB REST config
# ---------------------------------------------------------------------------
CHROMA_HOST    = os.environ.get("CHROMA_HOST", "chroma-service")
CHROMA_PORT    = os.environ.get("CHROMA_PORT", "8000")
CHROMA_API_VER = os.environ.get("CHROMA_API_VERSION", "v1")

CHROMA_BASE = f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/{CHROMA_API_VER}"
log.info("ChromaDB REST base: %s", CHROMA_BASE)

# ---------------------------------------------------------------------------
# Tiny collection-ID cache  (name → uuid string)
# ---------------------------------------------------------------------------
_col_id_cache: dict[str, str] = {}


def get_or_create_collection(name: str) -> str:
    if name in _col_id_cache:
        return _col_id_cache[name]
    resp = requests.post(
        f"{CHROMA_BASE}/collections",
        json={"name": name, "get_or_create": True},
        timeout=30,
    )
    resp.raise_for_status()
    col_id = resp.json()["id"]
    _col_id_cache[name] = col_id
    return col_id


def col_url(name: str) -> str:
    return f"{CHROMA_BASE}/collections/{get_or_create_collection(name)}"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Flask app
# ---------------------------------------------------------------------------
app = Flask(__name__)


# ------------------------------------------------------------------
# Health
# ------------------------------------------------------------------
@app.get("/health")
def health():
    try:
        resp = requests.get(f"{CHROMA_BASE}/heartbeat", timeout=10)
        resp.raise_for_status()
        return jsonify({"status": "ok", "chroma": "connected", "heartbeat": resp.json()}), 200
    except Exception as exc:
        log.error("ChromaDB heartbeat failed: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 503


# ------------------------------------------------------------------
# Generic memory  (any collection)
# ------------------------------------------------------------------
@app.post("/memory/upsert")
def memory_upsert():
    """
    Body:
      collection : str   (default: conversation_memory)
      id         : str   (optional -- auto-generated)
      document   : str   (text to embed + store)
      metadata   : dict  (str/int/float/bool values only)
    """
    data = request.get_json(force=True)
    collection_name = data.get("collection", "conversation_memory")
    doc_id   = data.get("id") or str(uuid.uuid4())
    document = data.get("document", "")
    metadata = data.get("metadata", {})
    metadata["updated_at"] = now_iso()

    try:
        resp = requests.post(
            f"{col_url(collection_name)}/upsert",
            json={"ids": [doc_id], "documents": [document], "metadatas": [metadata]},
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:
        log.error("memory_upsert error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500

    log.info("upsert -> %s / %s", collection_name, doc_id)
    return jsonify({"status": "ok", "id": doc_id, "collection": collection_name}), 200


@app.post("/memory/query")
def memory_query():
    """
    Body:
      collection  : str
      query       : str   natural language query
      n_results   : int   (default 5)
      where       : dict  optional metadata filter
    """
    data = request.get_json(force=True)
    collection_name = data.get("collection", "conversation_memory")
    query_text = data.get("query", "")
    n_results  = int(data.get("n_results", 5))
    where      = data.get("where")

    body = {
        "query_texts": [query_text],
        "n_results":   n_results,
        "include":     ["documents", "metadatas", "distances"],
    }
    if where:
        body["where"] = where

    try:
        resp = requests.post(f"{col_url(collection_name)}/query", json=body, timeout=30)
        resp.raise_for_status()
    except Exception as exc:
        log.error("memory_query error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500

    results = resp.json()
    hits = [
        {
            "id":       results["ids"][0][i],
            "document": doc,
            "metadata": results["metadatas"][0][i],
            "distance": results["distances"][0][i],
        }
        for i, doc in enumerate(results.get("documents", [[]])[0])
    ]
    return jsonify({"status": "ok", "results": hits}), 200


# ------------------------------------------------------------------
# User preferences
# ------------------------------------------------------------------
@app.get("/preferences/<key>")
def preferences_get(key: str):
    try:
        resp = requests.post(
            f"{col_url('user_preferences')}/get",
            json={"where": {"key": key}, "include": ["documents", "metadatas"]},
            timeout=30,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("ids"):
            meta = result["metadatas"][0]
            return jsonify({"status": "ok", "key": key, "value": meta.get("value"), "metadata": meta}), 200
        return jsonify({"status": "not_found", "key": key}), 404
    except Exception as exc:
        log.error("preferences_get error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500


@app.post("/preferences")
def preferences_set():
    """Body: { key: str, value: str|int|float|bool, chat_id?: str }"""
    data    = request.get_json(force=True)
    key     = data["key"]
    value   = data["value"]
    chat_id = str(data.get("chat_id", "default"))

    doc_id   = f"pref_{key}_{chat_id}"
    metadata = {
        "key":        key,
        "value":      str(value),
        "chat_id":    chat_id,
        "updated_at": now_iso(),
    }

    try:
        resp = requests.post(
            f"{col_url('user_preferences')}/upsert",
            json={"ids": [doc_id], "documents": [f"{key}: {value}"], "metadatas": [metadata]},
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:
        log.error("preferences_set error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500

    log.info("preference set: %s = %s (chat_id=%s)", key, value, chat_id)
    return jsonify({"status": "ok", "key": key, "value": value}), 200


# ------------------------------------------------------------------
# Jobs
# ------------------------------------------------------------------
@app.post("/jobs/store")
def jobs_store():
    """
    Body:
      job_id    : str          (optional)
      company   : str
      role      : str
      url       : str
      score     : int|float
      location  : str
      visa      : bool
      jd_text   : str
      status    : str          (default: "seen")
      applied   : bool         (default: false)
      file_paths: str
    """
    data    = request.get_json(force=True)
    company = data.get("company", "Unknown")
    role    = data.get("role",    "Unknown")
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    job_id  = data.get("job_id") or f"{company}_{role}_{date_str}".replace(" ", "_")

    metadata = {
        "company":    company,
        "role":       role,
        "url":        data.get("url", ""),
        "score":      float(data.get("score", 0)),
        "location":   data.get("location", ""),
        "visa":       str(data.get("visa", False)),
        "status":     data.get("status", "seen"),
        "applied":    str(data.get("applied", False)),
        "date":       now_iso(),
        "file_paths": str(data.get("file_paths", "")),
    }
    jd_text = data.get("jd_text") or f"{role} at {company}"

    try:
        resp = requests.post(
            f"{col_url('job_history')}/upsert",
            json={"ids": [job_id], "documents": [jd_text], "metadatas": [metadata]},
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:
        log.error("jobs_store error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500

    log.info("job stored: %s", job_id)
    return jsonify({"status": "ok", "job_id": job_id}), 200


@app.get("/jobs/history")
def jobs_history():
    """Query params: applied (true/false), limit (default 20)"""
    applied_filter = request.args.get("applied")
    limit = int(request.args.get("limit", 20))

    body = {"limit": limit, "include": ["documents", "metadatas"]}
    if applied_filter is not None:
        body["where"] = {"applied": applied_filter}

    try:
        resp = requests.post(f"{col_url('job_history')}/get", json=body, timeout=30)
        resp.raise_for_status()
        result = resp.json()
    except Exception as exc:
        log.error("jobs_history error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500

    jobs = [
        {"job_id": jid, "document": result["documents"][i], "metadata": result["metadatas"][i]}
        for i, jid in enumerate(result.get("ids", []))
    ]
    return jsonify({"status": "ok", "jobs": jobs, "count": len(jobs)}), 200


# ------------------------------------------------------------------
# Resume
# ------------------------------------------------------------------
@app.post("/resume/update")
def resume_update():
    """
    Body:
      sections : list[{ section: str, text: str }]
      version  : str   (e.g. "2026-04-11")
    """
    data     = request.get_json(force=True)
    sections = data.get("sections", [])
    version  = data.get("version", now_iso()[:10])

    ids, documents, metadatas = [], [], []
    for chunk in sections:
        section = chunk.get("section", "general")
        text    = chunk.get("text", "")
        ids.append(f"resume_{section}_{version}")
        documents.append(text)
        metadatas.append({"section": section, "version": version, "date_updated": now_iso()})

    try:
        if ids:
            resp = requests.post(
                f"{col_url('master_resume')}/upsert",
                json={"ids": ids, "documents": documents, "metadatas": metadatas},
                timeout=30,
            )
            resp.raise_for_status()
    except Exception as exc:
        log.error("resume_update error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500

    log.info("resume updated: %d chunks, version=%s", len(ids), version)
    return jsonify({"status": "ok", "chunks_stored": len(ids), "version": version}), 200


# ------------------------------------------------------------------
# Collections introspection
# ------------------------------------------------------------------
@app.get("/collections")
def list_collections():
    try:
        resp = requests.get(f"{CHROMA_BASE}/collections", timeout=10)
        resp.raise_for_status()
        cols = [c["name"] for c in resp.json()]
        return jsonify({"status": "ok", "collections": cols}), 200
    except Exception as exc:
        return jsonify({"status": "error", "detail": str(exc)}), 500



# ------------------------------------------------------------------
# Job cache retrieval (last search by chat_id)
# ------------------------------------------------------------------
@app.get("/jobs/get_cache/<chat_id>")
def jobs_get_cache(chat_id: str):
    """Get the last search results stored for a given chat_id."""
    doc_id = f"last_search_{chat_id}"
    try:
        resp = requests.post(
            f"{col_url('job_history')}/get",
            json={"ids": [doc_id], "include": ["documents", "metadatas"]},
            timeout=30,
        )
        resp.raise_for_status()
        result = resp.json()
        if not result.get("ids"):
            return jsonify({"status": "not_found", "chat_id": chat_id}), 404
        import json as _json
        raw_doc = result["documents"][0]
        try:
            jobs = _json.loads(raw_doc)
        except Exception:
            jobs = []
        return jsonify({"status": "ok", "chat_id": chat_id, "jobs": jobs, "metadata": result["metadatas"][0]}), 200
    except Exception as exc:
        log.error("jobs_get_cache error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500
# ------------------------------------------------------------------
# Resume file read/write (local filesystem)
# ------------------------------------------------------------------
RESUME_DIR = os.environ.get("RESUME_DIR", "/app/storage/master_resume")
RESUME_FILE = os.path.join(RESUME_DIR, "master_resume.txt")


@app.get("/resume/file")
def resume_file_get():
    """Read the master resume from local storage."""
    try:
        if not os.path.exists(RESUME_FILE):
            return jsonify({
                "status": "not_found",
                "resume_text": "",
                "detail": f"No resume file at {RESUME_FILE}. Create storage/master_resume/master_resume.txt"
            }), 404
        with open(RESUME_FILE, "r", encoding="utf-8") as f:
            content = f.read()
        log.info("resume loaded: %d chars from %s", len(content), RESUME_FILE)
        return jsonify({"status": "ok", "resume_text": content, "path": RESUME_FILE}), 200
    except Exception as exc:
        log.error("resume_file_get error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500


@app.post("/resume/file")
def resume_file_save():
    """Save updated resume text to local storage with timestamped backup.
    Body: { resume_text: str }
    """
    data = request.get_json(force=True)
    resume_text = data.get("resume_text", "")
    if not resume_text:
        return jsonify({"status": "error", "detail": "resume_text is required"}), 400

    try:
        os.makedirs(RESUME_DIR, exist_ok=True)

        # Create timestamped backup of existing file
        if os.path.exists(RESUME_FILE):
            ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            backup_path = os.path.join(RESUME_DIR, f"master_resume_{ts}.bak.txt")
            import shutil
            shutil.copy2(RESUME_FILE, backup_path)
            log.info("resume backup created: %s", backup_path)

        with open(RESUME_FILE, "w", encoding="utf-8") as f:
            f.write(resume_text)

        log.info("resume saved: %d chars to %s", len(resume_text), RESUME_FILE)
        return jsonify({"status": "ok", "chars_written": len(resume_text), "path": RESUME_FILE}), 200
    except Exception as exc:
        log.error("resume_file_save error: %s", exc)
        return jsonify({"status": "error", "detail": str(exc)}), 500


# ------------------------------------------------------------------
# Entry point
# ------------------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5680, debug=False)

