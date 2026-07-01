"""
CareerForge renderer -- Tier 3 headless liveness lane.

The authoritative check for jobs the matcher's JSON-API liveness (Tier 2) can't resolve:
scrape-only sources (Apple/Google/ByteDance/Amazon), raw web, and JSON-403-blocked cases.
A real headless Chromium renders the actual (JS) page -- the only way to read a SPA's
"no longer available" state (a plain HTTP status or bs4 can't: dead Workday pages return 200).

  POST /check {"url": "..."} -> {"alive": true|false|null, "status": <http>, "note": "..."}
    alive true  -> rendered page is a live posting
    alive false -> 404/410 OR a closed-marker in the rendered DOM
    alive null  -> undetermined (thin/blocked/error) -> matcher falls back to Firecrawl

Optional + concurrency-capped (Chromium is heavy). The matcher only calls this when
RENDERER_URL is set; unset -> the matcher degrades to Firecrawl (clone-and-BYOK friendly).
"""
import os
import re
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel
from playwright.async_api import async_playwright

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("renderer")

# Same closed-job markers the matcher's Firecrawl path uses + a couple of SPA "not found" ones.
CLOSED = re.compile(
    r"no longer (accepting|available|open)|position (has been |is )?(filled|closed)|"
    r"this (job|posting|position|role|req) is (no longer|closed|filled)|applications? (are )?closed|"
    r"posting (is )?(no longer available|closed|expired)|we are no longer accepting|"
    r"no longer taking applications|opportunity is closed|job (posting )?(closed|expired|filled|not found)|"
    r"page not found|this job is not available|requisition is closed",
    re.IGNORECASE,
)
NAV_TIMEOUT = int(os.environ.get("RENDER_TIMEOUT_MS", "25000"))
IDLE_TIMEOUT = int(os.environ.get("RENDER_IDLE_MS", "8000"))
MAX_CONC = int(os.environ.get("RENDER_MAX_CONCURRENCY", "2"))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

_state = {}
_sem = asyncio.Semaphore(MAX_CONC)


@asynccontextmanager
async def lifespan(app: FastAPI):
    pw = await async_playwright().start()
    _state["pw"] = pw
    _state["browser"] = await pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
    log.info("renderer: chromium launched (max_concurrency=%d)", MAX_CONC)
    try:
        yield
    finally:
        try:
            await _state["browser"].close()
        finally:
            await pw.stop()


app = FastAPI(title="careerforge-renderer", lifespan=lifespan)


class CheckReq(BaseModel):
    url: str


@app.get("/health")
async def health():
    return {"status": "ok", "browser": bool(_state.get("browser")), "max_concurrency": MAX_CONC}


@app.post("/check")
async def check(req: CheckReq):
    url = (req.url or "").strip()
    if not url:
        return {"alive": None, "status": None, "note": "no_url"}
    browser = _state.get("browser")
    if browser is None:
        return {"alive": None, "status": None, "note": "no_browser"}
    async with _sem:
        ctx = await browser.new_context(user_agent=UA, viewport={"width": 1280, "height": 900},
                                        locale="en-US")
        page = await ctx.new_page()
        try:
            resp = await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
            status = resp.status if resp else None
            if status in (404, 410):
                return {"alive": False, "status": status, "note": f"http_{status}"}
            try:
                await page.wait_for_load_state("networkidle", timeout=IDLE_TIMEOUT)
            except Exception:
                pass  # SPAs may never go fully idle; the DOM is already rendered enough
            try:
                text = await page.inner_text("body")
            except Exception:
                text = ""
            low = (text or "").lower()
            if CLOSED.search(low):
                return {"alive": False, "status": status, "note": "closed_marker"}
            if len((text or "").strip()) < 200:
                return {"alive": None, "status": status, "note": "thin"}   # blocked / empty -> undetermined
            return {"alive": True, "status": status, "note": "ok"}
        except Exception as e:
            return {"alive": None, "status": None, "note": f"err:{type(e).__name__}"}
        finally:
            try:
                await ctx.close()
            except Exception:
                pass
