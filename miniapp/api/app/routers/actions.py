from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import bridge, inject
from ..auth import require_owner
from ..shapes import LAST_JOBS_TTL_SECONDS

router = APIRouter()


class ApplyBody(BaseModel):
    rank: int


@router.post("/actions/apply", status_code=202)
async def apply(body: ApplyBody, _user: dict = Depends(require_owner)) -> dict:
    # Fast, local staleness check -- surfaces a clear error instead of
    # letting a stale "apply to N" produce a confusing chat-side reply.
    snap = await bridge.get_snapshot()
    import datetime
    created_at = snap.get("last_jobs_created_at")
    if created_at:
        try:
            created = datetime.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            age = (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds()
            if age > LAST_JOBS_TTL_SECONDS:
                raise HTTPException(status_code=409, detail={"error": "digest_expired", "age_seconds": age})
        except ValueError:
            pass

    jobs = snap.get("last_jobs") or {}
    if str(body.rank) not in jobs:
        raise HTTPException(status_code=404, detail="no job at that rank in the current digest")

    await inject.send_text(f"apply to {body.rank}")
    return {"injected": True, "note": "results arrive in the Telegram chat"}


class FindJobsBody(BaseModel):
    query: str | None = None


@router.post("/actions/find-jobs", status_code=202)
async def find_jobs(body: FindJobsBody, _user: dict = Depends(require_owner)) -> dict:
    await inject.send_text(body.query or "find jobs")
    return {"injected": True, "note": "results arrive in the Telegram chat"}


@router.post("/actions/track", status_code=202)
async def track(_user: dict = Depends(require_owner)) -> dict:
    await inject.send_text("track")
    return {"injected": True, "note": "results arrive in the Telegram chat"}
