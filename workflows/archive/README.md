# Archive — historical snapshots, do not import

These are earlier iterations of the workflow, kept for reference. None of them are live; none are read by any active script or doc.

| File | Workflow id | Nodes | Notes |
|---|---|---|---|
| `01_careerforge.json` | — | 111 | The original single-file workflow (Sessions 4-6). Superseded by the local-Postgres/pgvector architecture. Several older docs used to point here by mistake — fixed to point at the live `workflows/CareerForge_Master_local.json` instead. |
| `CareerForge Master.json` | `LGVvs8TItZX1Ufmx` | 193 | Mid-lineage fork, predates the S13-S22 liveness/retry/cohort/resume-engine work. |
| `CareerForge Master.corrected.json` | `LGVvs8TItZX1Ufmx` | 193 | `Master.json` plus ~39 hand-applied review fixes from `scripts/apply_all_fixes.js`. Never merged forward — the live lineage forked from the pre-fix `Master.json` one commit later. Any fix still relevant today has been (or should be) re-applied directly to the live workflow via a proper patch script, not by merging this file. |
| `CareerForge_Master_backup-v5.json` | `KP95xIJeTQyWIur9` | 166 | One-off UI export snapshot, never referenced by any script or doc. |
| `CareerForge Master v6.3.json` | `TfQzygYaPF05t13b` | 210 | The fork `scripts/localize_v63.js` built the current local-Docker architecture from. Predates S13 onward. |

If you're trying to understand current behavior, none of these are it — see `workflows/CareerForge_Master_local.json` (the live 275-node master) and `SETUP.md`.
