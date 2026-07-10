# Roadmap

What's live, and what's next. For deep implementation history, see git log and commit messages — this file stays high-level on purpose.

## Live today

- **Full job search pipeline** — structured job APIs, a local pgvector/tsvector hybrid cache, and web search merged, deduped, and scored. Location filtering is three-state (known match / known mismatch / unverified-but-shown), with a hard location/remote pre-filter on the cache lane itself plus a downstream authoritative check on the merged results. Supports sorting by best match (default) or newest.
- **Tailored resume + cover letter generation** — a deterministic, tier-aware content plan (fresher/junior/mid/senior) decides how many roles/projects/bullets to select and how long each bullet runs; an LLM writes within that plan, never trusted to also decide the shape. ATS-score gated with an automatic retry-and-improve loop. Verbatim-facts-only — nothing on a generated document is invented.
- **Resume setup** — a one-time interactive JSON-template flow over Telegram (no file uploads to a server, no separate onboarding doc to read).
- **Company intel, cold outreach, salary data, application tracking** — all sourced from live multi-provider search with reciprocal-rank-fusion merge, cached with a TTL to avoid re-researching the same company repeatedly.
- **A self-growing job registry** — every search that surfaces a job from a known ATS (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Eightfold, and a few single-company integrations) permanently adds that company to the background poller's coverage. Workday's seeded-tenant list covers Intel, Adobe, Target, Walmart, Visa, and Mastercard today.
- **Resume section customization** — `sections:`/`order:` text commands, or a tap-to-toggle inline keyboard (send "sections") for the same thing.
- **18 intents**, all documented in the bot's own `/help` text and in [README.md](README.md)'s Features table.
- **4 deployment tiers** — local Docker, a small VPS, Render/Railway free tier, and n8n Cloud (with real caveats about what n8n Cloud can't run, documented in [DEPLOYMENT.md](DEPLOYMENT.md)).

## In progress / next up

- **Poller adapter coverage** — Greenhouse/Lever/Ashby/Workable/Recruitee/SmartRecruiters plus Workday, Apple, Amazon, and Oracle's own career sites are integrated; SmartRecruiters/Eightfold tenant ids are opaque per-company strings not derivable from a brand name, so growing that coverage needs a quick manual lookup per company rather than a bulk add — see the poller adapter notes in `workflows/CareerForge_ATS_Poller.json`.

## Planned, not started

- **GitHub Actions poller + Neon relay** — a standalone, zero-cost poller that runs independently of your local n8n instance, syncing down into your local cache. Needs a Neon account and GitHub Actions secrets — deliberately held until someone picks it up with that setup ready.
- **Granular location targeting** — today's location matching is single-city/single-country. Targeting a named region or an explicit list of places (e.g. "APAC", "NYC or remote-US") with results strictly enforced to that set is scoped but not started — it touches query parsing, job matching, and digest display, so it's its own sprint rather than a quick patch.

## Explicitly out of scope for now

- Multi-tenant SaaS. This is a fork-and-run, one-instance-per-person tool, BYOK (bring your own API keys).
- Scraping LinkedIn or Indeed. Every job source here is either a documented public API or a company's own ATS.
