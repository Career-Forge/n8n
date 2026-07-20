from fastapi import APIRouter, Depends

from .. import bridge
from ..auth import require_owner

router = APIRouter()

# Matches Format Prefs View's own skip list exactly (workflows/CareerForge_Master_local.json).
_SKIP_KEYS = {"_schema_version", "_history", "_updated_at"}


@router.get("/settings")
async def get_settings(_user: dict = Depends(require_owner)) -> dict:
    snap = await bridge.get_snapshot()
    prefs = snap.get("user_prefs") or {}
    visible = {k: v for k, v in prefs.items() if k not in _SKIP_KEYS}
    return {
        "prefs": visible,
        "timezone": prefs.get("timezone"),
        "schedule_times": prefs.get("schedule_times"),
    }
