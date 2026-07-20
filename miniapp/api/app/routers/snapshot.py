import time

from fastapi import APIRouter, Depends

from .. import bridge
from ..auth import require_owner
from ..shapes import LAST_JOBS_TTL_SECONDS, reshape_last_jobs

router = APIRouter()


@router.get("/snapshot")
async def get_snapshot(_user: dict = Depends(require_owner)) -> dict:
    snap = await bridge.get_snapshot()

    expired = True
    age_seconds = None
    created_at = snap.get("last_jobs_created_at")
    if created_at:
        try:
            import datetime
            created = datetime.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            age_seconds = (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds()
            expired = age_seconds > LAST_JOBS_TTL_SECONDS
        except ValueError:
            pass

    return {
        "generated_at": snap.get("generated_at"),
        "user_prefs": snap.get("user_prefs"),
        "last_jobs": reshape_last_jobs(snap.get("last_jobs") or {}),
        "last_jobs_created_at": created_at,
        "last_jobs_expired": expired,
        "last_jobs_age_seconds": age_seconds,
        "tracked_applications": snap.get("tracked_applications") or [],
        "last_apply": snap.get("last_apply"),
        "last_search_intent": snap.get("last_search_intent"),
    }
