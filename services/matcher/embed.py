"""
bge-m3 embeddings via the Ollama already running in the stack (no second
embedder). Used by the ingestion path (embed-on-upsert) and the skill graph.
Returns a python list[float] (1024-d) or None if Ollama is unreachable.
"""
import os
import logging
from typing import Optional, List

import httpx

log = logging.getLogger("embed")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama-service:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")


def embed_text(text: str) -> Optional[List[float]]:
    text = (text or "").strip()
    if not text:
        return None
    # newer /api/embed (batchable, returns embeddings[])
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/embed", json={"model": EMBED_MODEL, "input": text}, timeout=60)
        if r.status_code == 200:
            d = r.json()
            vec = (d.get("embeddings") or [None])[0] or d.get("embedding")
            if vec:
                return vec
    except Exception as e:
        log.warning("embed /api/embed failed: %s", e)
    # legacy /api/embeddings (single prompt)
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/embeddings", json={"model": EMBED_MODEL, "prompt": text}, timeout=60)
        if r.status_code == 200:
            vec = r.json().get("embedding")
            if vec:
                return vec
    except Exception as e:
        log.warning("embed /api/embeddings failed: %s", e)
    return None
