from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .routers import actions, admin, applications, jobs, resume, settings as settings_router, snapshot

STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.connect()
    yield
    await db.disconnect()


app = FastAPI(title="CareerForge Mini App API", lifespan=lifespan)

app.include_router(snapshot.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(applications.router, prefix="/api")
app.include_router(actions.router, prefix="/api")
app.include_router(resume.router, prefix="/api")
app.include_router(settings_router.router, prefix="/api")
app.include_router(admin.router, prefix="/api")


@app.get("/api/healthz")
async def healthz() -> dict:
    db_ok = True
    try:
        async with db.pool().acquire() as conn:
            await conn.fetchval("SELECT 1")
    except Exception:
        db_ok = False
    return {"ok": db_ok, "db": db_ok}


# Serve the built frontend (Vite output baked into the image at build time --
# see ../Dockerfile). SPA fallback: any non-/api path that isn't a real static
# file resolves to index.html so client-side routing (tab switches) works on
# a hard refresh too.
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        candidate = STATIC_DIR / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
