"""Shared reshaping helpers for the digest-derived data the bridge snapshot
carries. Mirrors `tierGlyph()` in the master workflow's Build Telegraph Body
/ Aggregate Jobs nodes byte-for-byte -- keep in sync if that changes."""

LAST_JOBS_TTL_SECONDS = 14400  # matches Retrieve Job's staleness gate


def badge_glyph(source_tier, source: str | None) -> str:
    if source_tier == 1:
        return "\U0001F513" if source == "cache" else "✅"  # 🔓 / ✅
    if source_tier == 1.5:
        return "\U0001F4B0"  # 💰
    if source_tier == 2:
        return "\U0001F33F"  # 🌿
    if source_tier == 2.5:
        return "\U0001F3E2"  # 🏢
    if source_tier == 3:
        return "\U0001F310"  # 🌐
    return ""


def badge_label(source_tier) -> str:
    return {
        1: "ATS",
        1.5: "Structured",
        2: "Curated",
        2.5: "Career",
        3: "Aggregator",
    }.get(source_tier, "")


def match_pct(score100) -> int | None:
    """score100 (JobScorer's fine-grained 0-100 composite) is now the SOLE
    source -- s138 removed the fit_score*10 fallback after confirming it was
    dead code: rankedJobs (Build Telegraph Body) is built via scored.map(...)
    over Parse Scorer Output's output, which computes score100
    UNCONDITIONALLY for every scored job on every parse path. A live job can
    never reach last_jobs with fit_score but no score100. A genuinely-stale
    last_jobs entry (written before s134 started persisting score100 at all)
    now correctly returns None instead of a fabricated fit_score*10 guess --
    it ages out on the next digest run same as before."""
    if isinstance(score100, (int, float)):
        return round(score100)
    return None


def reshape_last_jobs(last_jobs: dict) -> list[dict]:
    """sd.last_jobs is a rank-keyed map ({"1": {...}, "2": {...}}) --
    the app wants an ordered array with the badge/match fields precomputed."""
    out = []
    for rank_str, job in sorted((last_jobs or {}).items(), key=lambda kv: int(kv[0])):
        source_tier = job.get("source_tier")
        out.append({
            "rank": int(rank_str),
            "job_id": job.get("job_id"),
            "title": job.get("title"),
            "company": job.get("company"),
            "location": job.get("location"),
            "url": job.get("url"),
            "fit_score": job.get("fit_score"),
            "score100": job.get("score100"),
            "match_pct": match_pct(job.get("score100")),
            "description_snippet": job.get("description_snippet"),
            "source": job.get("source"),
            "source_tier": source_tier,
            "badge": badge_glyph(source_tier, job.get("source")),
            "badge_label": badge_label(source_tier),
        })
    return out
