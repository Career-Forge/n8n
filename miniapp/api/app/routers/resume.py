import json
from pathlib import Path

from fastapi import APIRouter, Depends

from .. import bridge
from ..auth import require_owner

router = APIRouter()

RESUME_PATH = Path("/data/user-data/resume_structured.json")


def _read_resume() -> dict | None:
    if not RESUME_PATH.exists():
        return None
    try:
        with RESUME_PATH.open() as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


@router.get("/resume")
async def get_resume(_user: dict = Depends(require_owner)) -> dict:
    snap = await bridge.get_snapshot()
    last_apply = snap.get("last_apply")

    r = _read_resume()
    if r is None:
        return {"forge_score": None, "last_apply": None, "resume": None}

    personal = r.get("personal") or {}
    skills = r.get("skills") or {}
    metadata = r.get("metadata") or {}

    resume = {
        "name": personal.get("name"),
        "headline": personal.get("headline"),
        "links": personal.get("links") or {},
        "locations": personal.get("locations") or [],
        "skills": {group: len(vals) for group, vals in skills.items() if isinstance(vals, list)},
        "experience_count": len(r.get("experience") or []),
        "projects_count": len(r.get("projects") or []),
        "summary_bullets": r.get("summary_bullets") or [],
        "updated_at": metadata.get("updated_at"),
        "sections": (snap.get("user_prefs") or {}).get("enabled_sections") or (snap.get("user_prefs") or {}).get("section_order"),
    }

    return {
        "forge_score": (last_apply or {}).get("forge_score"),
        "last_apply": {
            "job_title": (last_apply or {}).get("job_title"),
            "company": (last_apply or {}).get("company"),
            "timestamp": (last_apply or {}).get("timestamp"),
        } if last_apply else None,
        "resume": resume,
    }
