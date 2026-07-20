import datetime
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import bridge, db
from ..auth import require_owner
from ..config import settings
from ..shapes import reshape_last_jobs

router = APIRouter()

VALID_STATUSES = ("saved", "applied", "interviewing", "offer", "rejected")


def _row_to_dict(r) -> dict:
    d = dict(r)
    if isinstance(d.get("status_history"), str):
        d["status_history"] = json.loads(d["status_history"])
    if isinstance(d.get("score_detail"), str):
        d["score_detail"] = json.loads(d["score_detail"])
    for k in ("created_at", "updated_at", "applied_at"):
        if d.get(k) is not None:
            d[k] = d[k].isoformat()
    return d


@router.get("/applications")
async def list_applications(status: str | None = None, _user: dict = Depends(require_owner)) -> dict:
    async with db.pool().acquire() as conn:
        if status:
            if status not in VALID_STATUSES:
                raise HTTPException(status_code=400, detail=f"invalid status: {status}")
            rows = await conn.fetch(
                "SELECT * FROM applications WHERE user_id = $1 AND status = $2 ORDER BY updated_at DESC",
                settings.owner_tg_user_id, status,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM applications WHERE user_id = $1 ORDER BY updated_at DESC",
                settings.owner_tg_user_id,
            )
        count_rows = await conn.fetch(
            "SELECT status, count(*) AS n FROM applications WHERE user_id = $1 GROUP BY status",
            settings.owner_tg_user_id,
        )

    counts = {s: 0 for s in VALID_STATUSES}
    for r in count_rows:
        counts[r["status"]] = r["n"]

    return {"items": [_row_to_dict(r) for r in rows], "counts": counts}


class LogApplicationBody(BaseModel):
    job_title: str
    company: str
    url: str | None = None
    status: str = "applied"
    notes: str | None = None
    applied_at: str | None = None  # ISO string; defaults to now() when status == 'applied'


@router.post("/applications")
async def log_application(body: LogApplicationBody, _user: dict = Depends(require_owner)) -> dict:
    if body.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"invalid status: {body.status}")

    norm = await db.url_norm(body.url)
    applied_at = body.applied_at or (datetime.datetime.now(datetime.timezone.utc).isoformat() if body.status == "applied" else None)
    history = [{"from": None, "to": body.status, "at": applied_at or datetime.datetime.now(datetime.timezone.utc).isoformat(), "via": "miniapp"}]

    async with db.pool().acquire() as conn:
        if norm:
            existing = await conn.fetchrow(
                "SELECT id FROM applications WHERE user_id = $1 AND url_norm = $2",
                settings.owner_tg_user_id, norm,
            )
            if existing:
                raise HTTPException(status_code=409, detail={"error": "duplicate", "existing_id": existing["id"]})

        row = await conn.fetchrow(
            """
            INSERT INTO applications (user_id, job_title, company, url, url_norm, source, status, notes, status_history, applied_at)
            VALUES ($1, $2, $3, $4, $5, 'miniapp', $6, $7, $8::jsonb, $9)
            RETURNING *
            """,
            settings.owner_tg_user_id, body.job_title, body.company, body.url, norm,
            body.status, body.notes, json.dumps(history), db.parse_dt(applied_at),
        )
    return _row_to_dict(row)


class MarkAppliedBody(BaseModel):
    rank: int


@router.post("/applications/mark-applied")
async def mark_applied(body: MarkAppliedBody, _user: dict = Depends(require_owner)) -> dict:
    snap = await bridge.get_snapshot()
    jobs = reshape_last_jobs(snap.get("last_jobs") or {})
    job = next((j for j in jobs if j["rank"] == body.rank), None)
    if job is None:
        raise HTTPException(status_code=404, detail="no job at that rank in the current digest")

    norm = await db.url_norm(job.get("url"))
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    async with db.pool().acquire() as conn:
        existing = None
        if job.get("job_id"):
            existing = await conn.fetchrow(
                "SELECT * FROM applications WHERE user_id = $1 AND job_id = $2",
                settings.owner_tg_user_id, job["job_id"],
            )
        if existing is None and norm:
            existing = await conn.fetchrow(
                "SELECT * FROM applications WHERE user_id = $1 AND url_norm = $2",
                settings.owner_tg_user_id, norm,
            )

        if existing:
            history = json.loads(existing["status_history"]) if isinstance(existing["status_history"], str) else existing["status_history"]
            history = history + [{"from": existing["status"], "to": "applied", "at": now, "via": "miniapp"}]
            row = await conn.fetchrow(
                """
                UPDATE applications SET status = 'applied', applied_at = COALESCE(applied_at, $2),
                       status_history = $3::jsonb, updated_at = now()
                WHERE id = $1 RETURNING *
                """,
                existing["id"], db.parse_dt(now), json.dumps(history),
            )
        else:
            history = [{"from": None, "to": "applied", "at": now, "via": "miniapp"}]
            row = await conn.fetchrow(
                """
                INSERT INTO applications (user_id, job_id, url, url_norm, job_title, company, location,
                                          source, status, status_history, applied_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'miniapp', 'applied', $8::jsonb, $9)
                RETURNING *
                """,
                settings.owner_tg_user_id, job.get("job_id"), job.get("url"), norm,
                job.get("title") or "", job.get("company") or "", job.get("location"),
                json.dumps(history), db.parse_dt(now),
            )
    return _row_to_dict(row)


class PatchApplicationBody(BaseModel):
    status: str | None = None
    notes: str | None = None
    applied_at: str | None = None


@router.patch("/applications/{app_id}")
async def patch_application(app_id: int, body: PatchApplicationBody, _user: dict = Depends(require_owner)) -> dict:
    if body.status is not None and body.status not in VALID_STATUSES:
        raise HTTPException(status_code=400, detail=f"invalid status: {body.status}")

    async with db.pool().acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT * FROM applications WHERE id = $1 AND user_id = $2", app_id, settings.owner_tg_user_id,
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="not found")

        new_status = body.status or existing["status"]
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        history = json.loads(existing["status_history"]) if isinstance(existing["status_history"], str) else existing["status_history"]

        applied_at = existing["applied_at"]
        if body.applied_at is not None:
            applied_at = body.applied_at
        elif body.status == "applied" and applied_at is None:
            applied_at = now

        if body.status is not None and body.status != existing["status"]:
            history = history + [{"from": existing["status"], "to": body.status, "at": now, "via": "miniapp"}]

        row = await conn.fetchrow(
            """
            UPDATE applications SET status = $2, notes = COALESCE($3, notes), applied_at = $4,
                   status_history = $5::jsonb, updated_at = now()
            WHERE id = $1 RETURNING *
            """,
            app_id, new_status, body.notes, db.parse_dt(applied_at), json.dumps(history),
        )
    return _row_to_dict(row)


@router.delete("/applications/{app_id}")
async def delete_application(app_id: int, _user: dict = Depends(require_owner)) -> dict:
    async with db.pool().acquire() as conn:
        result = await conn.execute(
            "DELETE FROM applications WHERE id = $1 AND user_id = $2", app_id, settings.owner_tg_user_id,
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": True, "id": app_id}
