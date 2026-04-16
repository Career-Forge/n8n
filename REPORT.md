# CareerForge Nexus — Development Report
> Generated: April 11, 2026  
> Covers: Sprint 1 → Sprint 3 (all AI-assisted sessions)  
> Author: Claude (Anthropic) — AI-powered development sessions

---

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Sprint 1 — Infrastructure & Persistence](#sprint-1)
3. [Sprint 2 — Unified Master Workflow](#sprint-2)
4. [Sprint 3 — Avatar Integration](#sprint-3)
5. [Deviations from Original Plan](#deviations)
6. [Known Issues & Active Bugs](#known-issues)
7. [What Remains](#what-remains)
8. [File Inventory](#file-inventory)

---

## Architecture Overview

The system is **n8n-first**. This is the single most important architectural constraint and must never be violated:

```
Telegram → ngrok → n8n Telegram Trigger (single entry point)
                    ↓
              Brian Router (intent classifier — regex now, LLM in Sprint 5)
                    ↓
         ┌──────────┴──────────────────────────────────────┐
         │                                                  │
    Simple intents                               Complex intents
    (n8n handles directly)                  (n8n delegates to avatar service)
         │                                                  │
    find_jobs ✅                            n8n → POST http://avatars:8000/api/dispatch
    set_preference ✅                              ↓
    tracker ✅                          Background task runs Rita/Marcus/Ryan
    help ✅                             Avatars send to Telegram via own bot tokens
                                        (Marcus appears as Marcus, etc.)
```

**Services (all on `careerforge_net` Docker network):**

| Service | Container | Port | Status |
|---|---|---|---|
| n8n workflow engine | `careerforge_n8n` | 5678 | ✅ Running |
| LaTeX PDF compiler | `careerforge_latex` | 5679 | ✅ Running (not yet wired to workflow) |
| ChromaDB vector store | `careerforge_chroma` | 8001 | ✅ Running |
| ChromaDB HTTP wrapper | `careerforge_chroma_api` | 5680 | ✅ Running |
| Avatar FastAPI service | `careerforge_avatars` | 8000 | ⏳ Added in Sprint 3, needs first build |

**External tunnel:** ngrok at `https://YOUR_TUNNEL_URL_HERE (ngrok or Cloudflare Tunnel)` → localhost:5678

---

## Sprint 1 — Infrastructure & Persistence {#sprint-1}

### What Was Done

**ChromaDB vector database** added to `docker/docker-compose.yml`:
- Image: `chromadb/chroma:0.5.23` (pinned — v1.0.0 changed the upsert API contract and would break the wrapper)
- Named volume `chroma_data` persists across restarts
- Healthcheck via Python urllib (no curl dependency)

**ChromaDB HTTP API wrapper** (`chroma-api/` directory):
- Flask microservice on port 5680
- Endpoints implemented:
  - `POST /memory/upsert` — store/update any memory document
  - `POST /memory/query` — semantic search across collections
  - `GET /preferences/location` — get location preference
  - `POST /preferences` — set/update any preference key-value
  - `POST /jobs/store` — store job with metadata
  - `GET /jobs/history` — retrieve application history
- n8n can call it via plain HTTP JSON (no Python SDK needed)
- Dockerfile written, added to docker-compose as `chroma-api` service

**Storage folder structure** created at `careerforge_n8n/storage/`:
```
storage/
├── master_resume/
├── applications/
├── job_cache/
└── exports/
```
- Mounted into n8n container at `/home/node/storage`
- Mounted into latex-service at `/app/storage`

### Deviations in Sprint 1

**ChromaDB version pinned to 0.5.23 instead of `latest`**  
*Reason:* ChromaDB v1.0.0 (released early 2026) changed the `/upsert` API to require caller-supplied embeddings instead of server-side embedding. The HTTP wrapper was designed around v0.5.x's simpler API. Using `latest` would silently break all upsert calls with no obvious error. Pinned to `0.5.23` which is the last stable v0.5.x release.

**Flask wrapper instead of direct ChromaDB SDK in n8n**  
*Reason:* n8n Code nodes can run JavaScript only. ChromaDB's SDK is Python-only. The Flask wrapper is the correct solution — it gives n8n a clean REST interface without any language boundary issues.

**`POST /preferences` instead of `POST /preferences/{key}`**  
*Reason:* The original plan specified per-key endpoints (`GET /preferences/{key}`, `POST /preferences/{key}`). The implemented design uses a flat `POST /preferences` with `{key, value, chat_id}` body and `GET /preferences/{key}` for reads. This is simpler and more consistent for n8n's HTTP Request nodes which handle JSON bodies more naturally than path parameters.

---

## Sprint 2 — Unified Master Workflow {#sprint-2}

### What Was Done

Created `workflows/07_careerforge_master_v1.json` — the unified master workflow replacing all previous `06_telegram_bot_v*` iterations.

**Workflow ID:** `CF07MasterV1Sprint2`  
**n8n Webhook secret:** `CF07MasterV1Sprint2_cf001-telegram-trigger`  
**Telegram Trigger webhookId:** `b05922ff-a701-4941-9900-a69e4873eb2e`

**Nodes implemented (29 nodes + 4 added in Sprint 3):**

| Node ID | Name | Type | Purpose |
|---|---|---|---|
| cf001 | Telegram Trigger | telegramTrigger | Receives all Telegram messages |
| cf002 | Schedule 8am ET | scheduleTrigger | `0 12 * * 1-5` (UTC = 8am ET) |
| cf003 | Schedule 11:30am ET | scheduleTrigger | `30 15 * * 1-5` (UTC = 11:30am ET) |
| cf004 | Manual Trigger | manualTrigger | n8n UI execution |
| cf005 | Normalize Input | code | Unifies 3 trigger formats into `{source, text, chat_id, trigger_type, intent, params}` |
| cf006 | Load Location Pref | httpRequest | GET from chroma-api |
| cf006b | Load Recent Jobs | httpRequest | GET from chroma-api |
| cf007 | Merge Context | code | Combines normalized input + chroma preferences |
| cf008 | Brian Router | code | Regex-based intent classifier (8 intents) |
| cf009 | Switch by Intent | switch | 8-way branch on intent value |
| cf010 | FJ: Pick Companies | code | Fisher-Yates shuffle, 10 of 25 companies |
| cf011 | FJ: Fetch Greenhouse | httpRequest | GET Greenhouse public API (with neverError) |
| cf012 | FJ: Filter & Format | code | Keyword filter + location scoring + message format |
| cf013 | FJ: Store to Chroma | httpRequest | POST to chroma-api |
| cf014 | FJ: Send to Telegram | telegram | Sends job list via Brian's token |
| cf015 | Apply: Build Response | code | Builds ack + passes context through |
| cf016 | Apply: Send | telegram | Sends ack to Telegram |
| cf015b | Apply: Call Avatars | httpRequest | POST to avatars:8000/api/dispatch (Sprint 3) |
| cf017 | Intel: Build Response | code | Builds ack + passes context through |
| cf018 | Intel: Send | telegram | Sends ack to Telegram |
| cf017b | Intel: Call Avatars | httpRequest | POST to avatars:8000/api/dispatch (Sprint 3) |
| cf019 | Interview: Build Response | code | Builds ack + passes context through |
| cf020 | Interview: Send | telegram | Sends ack to Telegram |
| cf019b | Interview: Call Avatars | httpRequest | POST to avatars:8000/api/dispatch (Sprint 3) |
| cf021 | Salary: Build Response | code | Builds ack + passes context through |
| cf022 | Salary: Send | telegram | Sends ack to Telegram |
| cf021b | Salary: Call Avatars | httpRequest | POST to avatars:8000/api/dispatch (Sprint 3) |
| cf023 | SetPref: Store to Chroma | httpRequest | Persists preference to chroma-api |
| cf024 | SetPref: Build Confirm | code | Formats confirmation message |
| cf025 | SetPref: Send Confirm | telegram | Sends confirmation to Telegram |
| cf026 | Tracker: Fetch History | httpRequest | GET job history from chroma-api |
| cf027 | Tracker: Format Table | code | Formats applied/seen jobs table |
| cf028 | Tracker: Send | telegram | Sends tracker table to Telegram |
| cf029 | Help: Send | telegram | Sends full command guide |

**End-to-end `find_jobs` flow is fully working** — verified by execution #40 which showed successful job discovery and Telegram delivery.

**Critical bugs fixed during Sprint 2:**

1. **403 "Provided secret is not valid" on Telegram webhook registration**  
   Root cause: n8n generates webhook secrets deterministically as `{workflowId}_{nodeId}`. When the workflow was imported, n8n activated it and registered the webhook with secret `CF07MasterV1Sprint2_cf001-telegram-trigger`. We had separately registered with Telegram without this secret, causing a header mismatch. Fix: re-registered via `setWebhook` API with the correct `secret_token` parameter.

2. **"0 published workflows" despite database manipulation**  
   Root cause: wrong Docker volume name used in the publish command (`careerforge_n8n_data` doesn't exist — correct volume is `docker_n8n_data`). Additionally, the `workflow_published_version` table column is `publishedVersionId` not `versionId`. Fix: Used `docker inspect` to find the correct volume name, then ran `n8n publish:workflow --id=CF07MasterV1Sprint2` via `docker run` on the correct volume.
   
   Command used:
   ```bash
   docker run --rm --volume docker_n8n_data:/home/node/.n8n n8nio/n8n:latest publish:workflow --id=CF07MasterV1Sprint2
   ```

3. **`chat_id` is null at FJ: Send to Telegram**  
   Root cause: n8n HTTP Request nodes replace `$json` with the HTTP response body, discarding all upstream data. After `FJ: Fetch Greenhouse` and `FJ: Store to Chroma`, `$json.chat_id` was the Chroma API response, not the original chat ID.  
   Fix: Used n8n node references `$('Merge Context').first().json.chat_id` and `$('FJ: Filter & Format').first().json.message` to reference upstream nodes by name, bypassing the `$json` replacement.

### Deviations in Sprint 2

**Brian Router uses regex, not LLM (originally planned as GPT-5.4-nano)**  
*Reason:* LLM-based intent classification was deferred to Sprint 5. Regex handles the primary intents reliably for the demo scope and has zero latency cost. The TODO.md and original plan explicitly note this as Sprint 5 work.

**ForgeScore, ResumeForge, CoverForge NOT implemented in the Apply branch**  
*Reason:* The Apply branch is a stub in the current workflow — it sends an ack and then delegates to the avatar service (Sprint 3). The full PDF pipeline (ForgeScore → ResumeForge → LaTeX compile → CoverForge → sendDocument) is planned for Sprint 4. This is the correct sequencing: get the avatar integration stable first, then wire the heavy compute.

**Intel, Interview, Salary branches are stubs (no Serper/You.com/Levels.fyi calls)**  
*Reason:* Same as above — these branches delegate to the avatar service (Rita for intel/interview, Marcus for salary). The avatars handle LLM reasoning. The richer data pipeline (Serper, Perplexity, Levels.fyi) is planned for Sprint 5.

**`import:workflow --separate` flag not used**  
*Reason:* `--separate` requires a directory path. When used with a file path it throws `EISDIR`. The correct single-file import command is `import:workflow --input=/path/to/file.json` (no `--separate`).

---

## Sprint 3 — Avatar Integration {#sprint-3}

### What Was Done

**`careerforge_n8n/docker/docker-compose.yml`** — Added `avatars` service:
- Builds from `../../careerforge_Telegram` (relative path from `docker/` directory)
- Uses the existing `Dockerfile` in careerforge_Telegram (already includes LaTeX — ~600MB image, 5 min first build)
- Loads env from `../../careerforge_Telegram/.env.local`
- Mounts `../../careerforge_Telegram/data:/app/data` for file-based vault persistence
- Port 8000 exposed on host for debugging
- Healthcheck hits `/health` endpoint
- Joins `careerforge_net` so n8n can reach it at `http://avatars:8000`
- `depends_on: n8n` (starts after n8n is healthy)

**`careerforge_Telegram/.env.local`** — Created from `.env` with Docker-internal overrides:
```
N8N_BASE_URL=http://n8n:5678
N8N_PIPELINE_WEBHOOK_URL=http://n8n:5678/webhook/pipeline
WEBHOOK_BASE_URL=http://localhost:8000
```
`WEBHOOK_BASE_URL` is intentionally set to `localhost:8000` — this causes the FastAPI lifespan startup to skip Telegram webhook registration (guarded by `!= "http://localhost:8000"` check). **n8n's Telegram Trigger owns Brian's webhook** and must not be overridden by the avatar service.

**`careerforge_Telegram/src/main.py`** — Added `POST /api/dispatch` endpoint:
- Accepts `DispatchRequest` Pydantic model: `{intent, chat_id, user_id, message, company, job_number, job_url, job_description}`
- Returns `{"status": "dispatched"}` immediately (n8n workflow completes without waiting for LLM)
- Background task `_execute_dispatch()` runs the right avatars via `_dispatch_parallel()`
- Each avatar response sent to Telegram via `bot_manager.send_message(avatar_slug, text, chat_id)` — uses the avatar's own bot token so Marcus/Ryan/Rita appear with their own names
- Intent → avatar routing table:
  ```python
  "apply":          ["rita", "ryan"]
  "intel":          ["rita"]
  "interview_prep": ["rita", "marcus"]
  "salary_coach":   ["marcus"]
  ```

**`careerforge_n8n/workflows/07_careerforge_master_v1.json`** — Updated 4 stub branches:
- Each Code node now outputs `_text`, `_job_number`, `_company` fields alongside `chat_id` and `message` — needed because HTTP Request nodes downstream replace `$json`, so these fields must be retrievable by name reference
- Each Send node now chains to a new HTTP Request node (`Call Avatars`) instead of ending
- `Call Avatars` nodes POST to `http://avatars:8000/api/dispatch` with `neverError: true` and 5s timeout (fire-and-forget — n8n doesn't wait for avatar LLM processing)

### Deviations in Sprint 3

**`careerforge_Telegram` is NOT cloned into `careerforge_n8n/avatars/`**  
*Reason:* The original plan (TODO.md §3.1) specified cloning/copying careerforge_Telegram into `careerforge_n8n/avatars/`. This was intentionally not done. The two repos serve different purposes (n8n infrastructure vs. Python avatar service) and keeping them separate is cleaner — no git submodule complexity, no duplication of code. Docker Compose uses a relative `context: ../../careerforge_Telegram` path which achieves the same result without the code duplication. The bind mount for `data/` also means file-based vault data persists in the original location where it already has real user data (resumes, research from Feb 2026).

**`_dispatch_parallel()` is called directly (private method)**  
*Reason:* The Dispatcher class exposes `handle_message()` as its public API, which always runs Brian's intent analysis first. Since n8n has already classified the intent, re-running Brian would be redundant and waste a budget LLM call. `_dispatch_parallel()` is the correct internal method to call for the "execute only, no routing" case. A future refactor could expose a public `dispatch_by_avatars(slugs, message, context)` method, but for Sprint 3 the private call is acceptable.

**Avatar service does NOT call back into n8n**  
*Reason:* The original plan (§3.1) mentioned "Wire Brian's FastAPI webhook to call n8n workflows via HTTP instead of running internally." In the Sprint 3 implementation, the flow is unidirectional: n8n calls the avatar service, the avatar service does work and sends Telegram messages, and returns. No n8n callback is needed for the LLM response path. The `/api/n8n/callback` endpoint exists as a stub for Sprint 4's heavy-compute pipeline (LaTeX PDF, Greenhouse fetch), where n8n would need to call back with results.

**Sub-agent approach abandoned mid-sprint**  
*Reason:* The Sprint 3 work was initially delegated to a sub-agent task session, which hit its usage limit before doing any actual work (only loaded tools then stopped). The implementation was then done directly in the parent session using Windows MCP file tools, which proved more reliable for this type of multi-file edit.

---

## Known Issues & Active Bugs {#known-issues}

| Issue | Severity | Details |
|---|---|---|
| ngrok URL resets on restart | Medium | Must manually update `N8N_WEBHOOK_URL` in docker-compose + restart n8n. Cloudflare Tunnel (free, persistent) is the recommended fix. |
| LaTeX service not wired to workflow | Medium | `careerforge_latex` is running on port 5679 but the Apply branch doesn't yet call it. PDF output blocked until Sprint 4. |
| Brian's regex regex has a syntax error in Intel branch | Low | `{1,40?}` in the company regex is malformed (the `?` makes it non-greedy inside a repetition quantifier, not a `?` quantifier). This causes the regex to either fail silently or match incorrectly. Company extraction for intel intent may not work in all cases. |
| n8n workflow must be re-imported + re-published after any JSON edit | Ongoing | Re-import command: `docker exec careerforge_n8n n8n import:workflow --input=/home/node/.n8n/workflows-import/07_careerforge_master_v1.json` then publish: `docker exec careerforge_n8n n8n publish:workflow --id=CF07MasterV1Sprint2` then restart: `docker restart careerforge_n8n` |
| Telegram credential ID hardcoded in workflow JSON | Low | `"id": "8vkAvDf0IpSAVPOB"` in all Telegram nodes. If credentials are re-created in n8n, this ID changes and all Telegram nodes break. Must update JSON and re-import. |
| `avatars` service first build takes ~5 minutes | One-time | The Dockerfile installs the full LaTeX stack. Subsequent restarts use the cached image layer and are instant. |
| `staticData` in n8n is volatile | Low | n8n's global state (`staticData`) is lost on restart. ChromaDB is now the persistence layer — staticData should not be used for anything important. |
| careerforge_Telegram `.env.local` has `N8N_API_KEY` empty | Low | Not needed for Sprint 3 (avatar service doesn't call n8n). Required in Sprint 4 if the callback endpoint needs to call n8n APIs. |

---

## What Remains {#what-remains}

### From the Original TODO.md (not yet done)

#### Sprint 1 items not completed
- [ ] `POST /resume/update` endpoint in chroma-api (chunk and embed master resume)
- [ ] `master_resume` collection population (load actual resume PDF)
- [ ] `conversation_memory` collection (key decisions, avatar conversations)
- [ ] `generated_docs` collection (summaries of resume + CL generated)
- [ ] Verify scheduled triggers (8am + 11:30am) actually fire in production

#### Sprint 2 items not completed (Apply branch full pipeline)
- [ ] Load stored job from ChromaDB by number (currently Apply just stubs out)
- [ ] Scrape JD via Firecrawl if URL provided
- [ ] ForgeScore (LLM scores resume vs JD, gate at ≥6)
- [ ] ResumeForge (Claude Sonnet — JSON bullets for resume)
- [ ] LaTeX build node (code node assembles .tex from template + bullets)
- [ ] Compile PDF (HTTP POST to `http://latex-service:5679/compile`)
- [ ] CoverForge (Claude Sonnet — 350-450 word cover letter)
- [ ] Save PDFs to `storage/applications/{company}_{date}/`
- [ ] Send resume PDF via Telegram `sendDocument`
- [ ] Send cover letter text via Telegram `sendMessage`

#### Sprint 2 items not completed (Intel/Interview/Salary full pipeline)
These are currently delegated to avatar service stubs. The original plan called for richer data sources:
- [ ] Intel: Serper news + You.com profile + You.com contact finder + Risk Assessor
- [ ] Interview: Actual Glassdoor questions via Serper + STAR answer generation
- [ ] Salary: Levels.fyi data via Firecrawl + negotiation simulator

#### Sprint 3 items not completed
- [ ] Budget tracking in ChromaDB per `chat_id` (currently BudgetTracker is in-memory only, resets on restart)
- [ ] Public `dispatch_by_avatars()` method on Dispatcher (technical debt from using private `_dispatch_parallel()`)
- [ ] Direct vs Council vs Pipeline interaction modes not wired into `/api/dispatch` (dispatcher's `handle_message()` handles this but `/api/dispatch` bypasses it)

### Sprint 4 — Multi-Channel A2A (not started)
- [ ] Google Calendar integration (interview scheduling, pre-interview reminders)
- [ ] Gmail monitoring (recruiter email detection, auto-draft responses)
- [ ] Full n8n callback handler in `main.py` (stub exists at `/api/n8n/callback`)
- [ ] Auto-save to Google Drive after Apply branch
- [ ] SMS via Twilio for 10/10 match alerts
- [ ] Discord avatar integration (scaffolded in Career_Forge_Agent)
- [ ] n8n MCP integration (expose workflow triggers via MCP)

### Sprint 5 — Intelligence Layer (not started)
- [ ] LLM-based Brian Router (replace regex with GPT-5.4-nano or Claude Haiku)
- [ ] ATS shadow scoring (keyword overlap between JD and resume)
- [ ] Career trajectory analysis (3 path options)
- [ ] LinkedIn outreach generator (personalized cold messages)
- [ ] Job expiry tracker (daily re-check of Greenhouse for stored active jobs)
- [ ] Referral finder (LinkedIn connection cross-reference)
- [ ] Levels.fyi salary intelligence + negotiation simulator

### Sprint 6 — Moonshot (not started)
- [ ] Voice mode (Whisper transcription → ElevenLabs TTS)
- [ ] Auto-Apply mode (Firecrawl Actions for ATS form filling)
- [ ] Offer comparison matrix (PDF export via latex-service)
- [ ] Market intelligence dashboard (weekly report)
- [ ] Network graph (warm introduction paths)

### Immediate Next Actions (to unlock Sprint 4)

1. **Build the avatars image** (one-time):
   ```bash
   cd D:\My-Projects\Career_Forge_Development\careerforge_n8n\docker
   docker compose build avatars
   docker compose up -d avatars
   ```

2. **Re-import and republish the updated workflow**:
   ```bash
   docker exec careerforge_n8n n8n import:workflow \
     --input=/home/node/.n8n/workflows-import/07_careerforge_master_v1.json
   docker exec careerforge_n8n n8n publish:workflow --id=CF07MasterV1Sprint2
   docker restart careerforge_n8n
   ```

3. **Test Sprint 3 end-to-end**: Send "research Anthropic" to the bot. Expected:
   - Brian (n8n's Telegram node) replies: "Rita is on it — pulling recent news..."
   - A few seconds later, Rita (her own bot token) replies with actual company intel

4. **Fix the Intel regex** in cf008-brian-router (line with `{1,40?}`):
   - `{1,40?}` → `{1,40}` (remove the errant `?`)

5. **Implement the Apply pipeline** (Sprint 4's first milestone):
   - Wire cf015-apply-stub to load job from ChromaDB
   - Call latex-service for PDF generation
   - Send resume PDF via `sendDocument`

---

## File Inventory {#file-inventory}

### Files Created or Modified (this session + previous sessions)

| File | Status | Description |
|---|---|---|
| `docker/docker-compose.yml` | Modified | Added chroma-service, chroma-api, avatars services; storage volume mounts |
| `chroma-api/app.py` | Created | Flask HTTP wrapper for ChromaDB |
| `chroma-api/Dockerfile` | Created | ChromaDB API service container |
| `chroma-api/requirements.txt` | Created | Flask + chromadb dependencies |
| `workflows/07_careerforge_master_v1.json` | Created (Sprint 2) + Modified (Sprint 3) | Unified master workflow, 33 nodes |
| `storage/` | Created | Local file storage tree |

### careerforge_Telegram Files Modified (Sprint 3)

| File | Status | Description |
|---|---|---|
| `src/main.py` | Modified | Added `POST /api/dispatch` endpoint + `DispatchRequest` model |
| `.env.local` | Created | Docker-internal env overrides (not committed to git) |

### Unchanged (but important context)

| File | Description |
|---|---|
| `careerforge_Telegram/src/orchestrator/dispatcher.py` | Unchanged — `_dispatch_parallel()` called by new endpoint |
| `careerforge_Telegram/src/n8n/triggers.py` | Unchanged — `trigger_pipeline_workflow()` ready for Sprint 4 |
| `careerforge_Telegram/src/platforms/telegram/bots.py` | Unchanged — `send_message(avatar_slug, text, chat_id)` used by dispatch endpoint |
| `careerforge_Telegram/Dockerfile` | Unchanged — builds avatar service container |
| `careerforge_Telegram/src/config.py` | Unchanged — pydantic-settings picks up `.env.local` via `env_file` |

---

*This report was generated at the end of Sprint 3. Update before beginning Sprint 4.*
