"""Client for the n8n "Miniapp Bridge" webhook (s131) -- the only path this
service reads n8n's staticData through. n8n stays the sole writer; this is
a read-only snapshot fetch, cached briefly so rapid tab-switching in the
app doesn't hammer the workflow on every render."""
import time

import httpx
from fastapi import HTTPException

from .config import settings

_cache: dict | None = None
_cache_at: float = 0.0
_TTL_SECONDS = 60


class BridgeError(Exception):
    pass


async def get_snapshot(force: bool = False) -> dict:
    global _cache, _cache_at
    now = time.monotonic()
    if not force and _cache is not None and (now - _cache_at) < _TTL_SECONDS:
        return _cache

    url = f"{settings.n8n_internal_url}/webhook/miniapp-bridge"
    headers = {"X-Miniapp-Secret": settings.bridge_secret, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.post(url, json={"action": "snapshot"}, headers=headers)
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"bridge unreachable: {e}")

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"bridge returned {resp.status_code}: {resp.text[:200]}")

    body = resp.json()
    if not body.get("ok"):
        raise HTTPException(status_code=502, detail=f"bridge error: {body.get('error')}")

    _cache = body
    _cache_at = now
    return body


def invalidate() -> None:
    """Called after an action that will change staticData (e.g. an injected
    apply/find-jobs) so the next read doesn't serve stale cached state for
    up to a minute."""
    global _cache
    _cache = None
