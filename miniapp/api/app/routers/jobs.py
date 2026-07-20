from fastapi import APIRouter, Depends, HTTPException

from .. import bridge, db
from ..auth import require_owner
from ..config import settings
from ..shapes import reshape_last_jobs

router = APIRouter()


async def _application_lookup() -> tuple[dict, dict]:
    """Returns (by_job_id, by_url_norm) maps of the owner's tracked applications."""
    async with db.pool().acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, job_id, url_norm, status FROM applications WHERE user_id = $1",
            settings.owner_tg_user_id,
        )
    by_job_id, by_url_norm = {}, {}
    for r in rows:
        entry = {"id": r["id"], "status": r["status"]}
        if r["job_id"]:
            by_job_id[r["job_id"]] = entry
        if r["url_norm"]:
            by_url_norm[r["url_norm"]] = entry
    return by_job_id, by_url_norm


async def _attach_application(job: dict, by_job_id: dict, by_url_norm: dict) -> dict:
    app_entry = None
    if job.get("job_id") and job["job_id"] in by_job_id:
        app_entry = by_job_id[job["job_id"]]
    elif job.get("url"):
        norm = await db.url_norm(job["url"])
        if norm and norm in by_url_norm:
            app_entry = by_url_norm[norm]
    job["application"] = app_entry
    return job


@router.get("/jobs")
async def list_jobs(_user: dict = Depends(require_owner)) -> dict:
    snap = await bridge.get_snapshot()
    jobs = reshape_last_jobs(snap.get("last_jobs") or {})
    by_job_id, by_url_norm = await _application_lookup()
    jobs = [await _attach_application(j, by_job_id, by_url_norm) for j in jobs]
    return {
        "jobs": jobs,
        "created_at": snap.get("last_jobs_created_at"),
    }


@router.get("/jobs/{rank}")
async def get_job(rank: int, _user: dict = Depends(require_owner)) -> dict:
    snap = await bridge.get_snapshot()
    jobs = reshape_last_jobs(snap.get("last_jobs") or {})
    job = next((j for j in jobs if j["rank"] == rank), None)
    if job is None:
        raise HTTPException(status_code=404, detail="no job at that rank in the current digest")

    by_job_id, by_url_norm = await _application_lookup()
    job = await _attach_application(job, by_job_id, by_url_norm)

    # A per-job ForgeScore breakdown only exists for the one job the LAST
    # apply ran against (there is no persisted forge_score per digest job).
    last_apply = snap.get("last_apply")
    if last_apply and last_apply.get("job_id") == job.get("job_id"):
        job["forge_score"] = last_apply.get("forge_score")
    else:
        job["forge_score"] = None

    return job
