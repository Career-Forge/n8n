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


def match_pct(score100, fit_score) -> int | None:
    """Prefer the fine-grained 0-100 JobScorer score (score100) -- matches
    what the bot's own digest text shows ("\U0001F4CA X/100"). Falls back to
    fit_score*10 (a coarse 0-10 bucket) only for last_jobs entries written
    before s134 started persisting score100 -- same precedence Record
    Matches already uses (COALESCE(score100, fit_score*10))."""
    if isinstance(score100, (int, float)):
        return round(score100)
    if fit_score is None:
        return None
    try:
        return round(float(fit_score) * 10)
    except (TypeError, ValueError):
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
            "match_pct": match_pct(job.get("score100"), job.get("fit_score")),
            "description_snippet": job.get("description_snippet"),
            "source": job.get("source"),
            "source_tier": source_tier,
            "badge": badge_glyph(source_tier, job.get("source")),
            "badge_label": badge_label(source_tier),
        })
    return out
