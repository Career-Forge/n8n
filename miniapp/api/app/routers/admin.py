import json

from fastapi import APIRouter, Depends

from .. import bridge, db
from ..auth import require_owner
from ..config import settings

router = APIRouter()


@router.post("/admin/migrate-tracked")
async def migrate_tracked(_user: dict = Depends(require_owner)) -> dict:
    """One-time copy of staticData.tracked_applications into the applications
    table. Idempotent -- ON CONFLICT DO NOTHING on (user_id, job_id), so
    re-running is always safe and reports {migrated: 0} the second time."""
    snap = await bridge.get_snapshot(force=True)
    tracked = snap.get("tracked_applications") or []

    migrated, skipped = 0, 0
    async with db.pool().acquire() as conn:
        for entry in tracked:
            job_id = entry.get("job_id")
            applied_at = entry.get("applied_at")
            history = json.dumps([{"from": None, "to": "applied", "at": applied_at, "via": "migration"}])
            result = await conn.execute(
                """
                INSERT INTO applications (user_id, job_id, job_title, company, source, status,
                                          forge_score, status_history, applied_at)
                VALUES ($1, $2, $3, $4, 'migration', 'applied', $5, $6::jsonb, $7)
                ON CONFLICT (user_id, job_id) WHERE job_id IS NOT NULL DO NOTHING
                """,
                settings.owner_tg_user_id, job_id, entry.get("job_title") or "", entry.get("company") or "",
                entry.get("score"), history, db.parse_dt(applied_at),
            )
            if result == "INSERT 0 1":
                migrated += 1
            else:
                skipped += 1

    return {"migrated": migrated, "skipped": skipped, "total_seen": len(tracked)}
