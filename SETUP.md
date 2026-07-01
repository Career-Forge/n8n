# CareerForge — Setup & BYOK Guide

CareerForge is **self-hosted and clone-and-BYOK**: you run your own instance with your own API keys. Nothing is centrally hosted; scalability beyond a single user is out of scope by design. It works at two levels — a **generous free tier** (free-credit search providers + a local cache) and **premium add-ons** (paid contact data) you can switch on later. Every provider and model is independently optional and degrades gracefully.

---

## 1. Architecture (Docker stack)

`docker/docker-compose.yml` brings up four services:

| Service | Role |
|---|---|
| **n8n** | The workflow engine (the whole bot is one workflow). |
| **postgres** (pgvector) | Jobs, company intel, writing profiles, app settings, cost log; vector + full-text search. |
| **ollama** | Local `bge-m3` embeddings (1024-dim) — free, the hybrid-search backbone. |
| **latex-service** | Flask + pdflatex microservice that compiles resume/cover PDFs (`:5679`). |

---

## 2. Quick start

```bash
cp .env.example .env          # fill in the required values (see below)
docker compose -f docker/docker-compose.yml up -d
docker exec -it careerforge_ollama ollama pull bge-m3   # one-time, ~1.2 GB
```

Then, in the n8n UI (`http://localhost:5678`, basic-auth from `.env`):
1. Create the **credentials** in section 4.
2. Import the workflow: `docker/workflows/CareerForge Master Local v6.3.json`.
3. Activate it. Telegram needs an HTTPS `WEBHOOK_URL` (use ngrok/Cloudflare Tunnel for local dev), then set the bot webhook to `<WEBHOOK_URL>/webhook/<telegram-trigger-path>`.
4. Apply the DB schema if starting fresh: `db/schema.sql`.

> Ops note: the live workflow is edited via the `scripts/sN_*.js` patch scripts, never by hand-editing the 356 KB JSON. Each patch writes all three master copies, then you `docker cp` + `n8n import:workflow` + `update:workflow --active=true` + `docker restart`. See `plan_handout.md` for the exact recipe.

---

## 3. Environment variables (`.env`)

Required: `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `N8N_ENCRYPTION_KEY`, Postgres creds.
Free-tier search (recommended): `SERPER_API_KEY`, `YOUCOM_API_KEY`, `FIRECRAWL_API_KEY`.
All documented inline in `.env.example`. These are read directly in HTTP nodes via `$env` (`N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is set in compose).

---

## 4. n8n Credentials (Credentials tab)

| Credential | Type | Required? | Unlocks |
|---|---|---|---|
| **CareerForge Postgres** | Postgres | ✅ Required | All state + search. |
| **Telegram** | Telegram API | ✅ Required | The bot. |
| **OpenRouter account** | OpenRouter API | ✅ Required | All LLM roles. |
| **Hunter API** | Hunter API | ⬜ Optional (premium) | Email verification on `draft` (native Hunter node). |
| **Apollo API** | Header Auth — header `X-Api-Key` | ⬜ Optional (premium) | Contact email/title enrichment on `draft` (HTTP node). |

Serper / You.com / Firecrawl use `.env` keys (no credential needed).

---

## 5. `app_settings` table (DB config)

Key-value config the workflow reads at runtime. Insert with SQL (`careerforge` DB):

| key | value | purpose |
|---|---|---|
| `telegraph_token` | (auto-created on first run) | Telegraph long-list rendering. |
| `adzuna_app_id` / `adzuna_app_key` | your free Adzuna keys | Free structured job lane (real location + salary). [api.adzuna.com] |
| `apollo_enabled` | `true` / `false` (default off) | Turn on Apollo contact enrichment. |
| `hunter_enabled` | `true` / `false` (default off) | Turn on Hunter email verification. |
| `apollo_daily_limit` | integer (default 25) | Soft daily cap on Apollo credits (1 credit/match). |

```sql
INSERT INTO app_settings(key,value) VALUES ('adzuna_app_id','...'),('adzuna_app_key','...')
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;
```

---

## 6. Free vs premium providers

| Provider | Tier | Setup |
|---|---|---|
| RemoteOK | Free (keyless) | Default OFF -- opt-in via `REMOTEOK_ENABLED=true`. Remote jobs + salary. |
| Adzuna | Free key | Default OFF -- opt-in via `ADZUNA_ENABLED=true` + `app_settings` keys (section 5). |
| Serper / You.com / Firecrawl | Free credits | `.env` keys. |
| Ollama bge-m3 | Free (local) | `ollama pull bge-m3`. |
| **Apollo** | Premium (BYOK) | Credential + `apollo_enabled=true`. |
| **Hunter** | Premium (BYOK) | Credential + `hunter_enabled=true`. |
| USAJobs / JSearch / Apify | Parked | Lanes not wired (need keys); see PLAN.md. |

---

## 7. Models (central map)

Every LLM model is defined in one place: the `MODEL_MAP` in `scripts/s9_polish.js` (keyed by model-node name). To swap a model, edit the map and re-run `node scripts/s9_polish.js` + redeploy. Defaults (all verified on openrouter.ai, June 2026):

- **Resume bullet generation / revise** → `anthropic/claude-sonnet-4.6`
- **Resume + cover selection, cover writing** → `anthropic/claude-haiku-4.5`
- **JD analysis, ATS extraction, apply-time intel** → `deepseek/deepseek-v4-flash`
- **Embeddings** → local Ollama `bge-m3`
- **Legacy roles** (intent, scoring, seniority, expand, salary, company-intel, contact-finder) → `openai/gpt-5.4-mini`; preferred cheaper swap noted inline in `MODEL_MAP` (`deepseek/deepseek-v4-flash` for JSON roles, `claude-haiku-4.5` for outreach).

---

## 8. Commands (Telegram)

`find <query>` · `apply <N>` · `revise <instruction>` · `score` · `intel <company>` · `outreach <company>` · `draft <N>` · `salary <role>` · `track` · `status` · `help`

- **apply** runs the 2-phase engine: select content against the JD → generate value-framed bullets → assemble → ATS score (regenerates once if < 70) → resume + cover PDFs.
- **outreach** finds real contacts; **draft N** writes outreach citing a real public hook (and, if Apollo/Hunter are on, a verified email).

---

## 9. Enabling premium contacts (Apollo + Hunter)

Off by default — `draft N` uses the free contact path labeled "unverified". To turn on:
1. **Hunter**: Credentials tab → new **Hunter API** credential → paste key → bind it to the `Hunter Verify` node. Then `INSERT INTO app_settings(key,value) VALUES ('hunter_enabled','true') ON CONFLICT (key) DO UPDATE SET value='true';`
2. **Apollo**: Credentials tab → new **Header Auth** credential named "Apollo API" (header `X-Api-Key`, value = your Apollo key) → bind it to the `Apollo Match` node. Then set `apollo_enabled='true'` (and optionally `apollo_daily_limit`). Apollo charges exactly **1 credit per matched person** (0 if not found); spend is logged to `tool_cost_log` and capped daily.
