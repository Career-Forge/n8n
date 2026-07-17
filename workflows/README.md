# Workflows

Three workflows make up the live bot — see [SETUP.md](../SETUP.md) for the import + credential steps.

| File | Purpose |
|---|---|
| `CareerForge_Master_local.json` | The bot itself — Telegram trigger, intent routing, find/apply/revise/score/intel/outreach/etc. |
| `CareerForge_ATS_Poller.json` | Background poller that keeps the job registry cache fresh. |
| `CareerForge_Registry_Seeder.json` | One-time seed for the job registry — run once, then dormant. |

These are the canonical files — deployed by `docker cp`-ing directly into the `careerforge_n8n` container and running `n8n import:workflow`. No separate `docker/workflows/` mirror exists; there is exactly one copy of each workflow to keep in sync.

`archive/` holds historical snapshots from earlier architecture iterations (including the original `01_careerforge.json`, superseded well before the current local-Postgres/pgvector architecture). Reference only — do not import.
