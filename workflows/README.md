# Workflows

Three workflows make up the live bot — see [SETUP.md](../SETUP.md) for the import + credential steps.

| File | Purpose |
|---|---|
| `CareerForge_Master_local.json` | The bot itself — Telegram trigger, intent routing, find/apply/revise/score/intel/outreach/etc. |
| `CareerForge_ATS_Poller.json` | Background poller that keeps the job registry cache fresh. |
| `CareerForge_Registry_Seeder.json` | One-time seed for the job registry — run once, then dormant. |

`docker/workflows/` holds byte-identical copies of the same three files, imported into the Docker n8n instance directly.

`archive/` holds historical snapshots from earlier architecture iterations (including the original `01_careerforge.json`, superseded well before the current local-Postgres/pgvector architecture). Reference only — do not import.
