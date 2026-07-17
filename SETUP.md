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
2. Import the workflow: `workflows/CareerForge_Master_local.json`.
3. Activate it. Telegram needs an HTTPS `WEBHOOK_URL` (use ngrok/Cloudflare Tunnel for local dev), then set the bot webhook to `<WEBHOOK_URL>/webhook/<telegram-trigger-path>`.
4. Apply the DB schema if starting fresh: `db/schema.sql`.

> Ops note: the live workflow is edited via `sN_*.js` patch scripts (historical ones live under `scripts/applied/`), never by hand-editing the JSON directly. Each patch writes the canonical `workflows/*.json` file, then you `docker cp` + `n8n import:workflow` + `update:workflow --active=true` + `docker restart`. See `docs/archive/plan_handout.md` for the exact recipe.

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
| **CareerForge_Serper** | Header Auth — header `X-API-KEY`, value = your Serper key | ✅ Required for the Serper search lane | `Serper Job Search` node — one of the three main web-search lanes. |
| **Firecrawl API** | Firecrawl API (native credential type) | ✅ Required for the Firecrawl search lane | `Firecrawl Search` node — one of the three main web-search lanes. |
| **Hunter API** | Hunter API | ⬜ Optional (premium) | Email verification on `draft` (native Hunter node). |
| **Apollo API** | Header Auth — header `X-Api-Key` | ⬜ Optional (premium) | Contact email/title enrichment on `draft` (HTTP node). |

Only You.com genuinely skips n8n credentials — it reads `YOUCOM_API_KEY` straight from `.env` via `$env` in the HTTP node. Serper and Firecrawl both need a real n8n credential object (table above) even though their keys also live in `.env` — the `.env` copy alone is not enough for those two lanes to work.

---

## 5. `app_settings` table (DB config)

Key-value config the workflow reads at runtime. Insert with SQL (`careerforge` DB):

| key | value | purpose |
|---|---|---|
| `telegraph_token` | your Telegraph access token (manual, one-time — see below) | Telegraph long-list rendering. |
| `adzuna_app_id` / `adzuna_app_key` | your free Adzuna keys | Free structured job lane (real location + salary). [api.adzuna.com] |
| `jsearch_key` | your RapidAPI key for JSearch | `JSearch Fetch` node, another structured job lane. [rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch] |
| `apollo_enabled` | `true` / `false` (default off) | Turn on Apollo contact enrichment. |
| `hunter_enabled` | `true` / `false` (default off) | Turn on Hunter email verification. |
| `apollo_daily_limit` | integer (default 25) | Soft daily cap on Apollo credits (1 credit/match). |

```sql
INSERT INTO app_settings(key,value) VALUES ('adzuna_app_id','...'),('adzuna_app_key','...')
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;
```

**Telegraph token** — there is no auto-create step; `Load Telegraph Token` only reads this row, nothing ever writes it. Get one with a single call (no signup) and insert it yourself:

```bash
curl -s 'https://api.telegra.ph/createAccount?short_name=CareerForge' | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['access_token'])"
```

```sql
INSERT INTO app_settings(key,value) VALUES ('telegraph_token','<paste the token here>')
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;
```

Without this row, `find` still works but the long-result Telegraph page link is skipped — the top-3 Telegram message still sends.

---

## 6. Free vs premium providers

| Provider | Tier | Setup |
|---|---|---|
| RemoteOK | Free (keyless) | On by default — remote jobs + salary. |
| Adzuna | Free key | `app_settings` rows (section 5). |
| Serper / You.com / Firecrawl | Free credits | `.env` keys. |
| Ollama bge-m3 | Free (local) | `ollama pull bge-m3`. |
| **Apollo** | Premium (BYOK) | Credential + `apollo_enabled=true`. |
| **Hunter** | Premium (BYOK) | Credential + `hunter_enabled=true`. |
| USAJobs / Apify | Parked | Lanes not wired (need keys); see `docs/archive/PLAN.md`. |
| JSearch | Free trial (RapidAPI) | Actually wired (`JSearch Fetch` node) -- needs `jsearch_key` in `app_settings` (section 5). |

---

## 7. Models

There's no single `MODEL_MAP` file — each `*Model` node in the live workflow sets its own model directly, and those live nodes are the authoritative source (the old `scripts/s9_polish.js` MODEL_MAP approach was retired; that file now lives under `scripts/applied/` as deploy history only). To swap a model, edit the relevant `*Model` node's `model` parameter and redeploy — see [DEPLOYMENT.md](DEPLOYMENT.md) for the import/restart steps. Live defaults, by role:

- **Writer/selection lane** (Pass1, Pass2, Pass2 Regen, Cover Pass1, Cover Pass2, ReviseForge, OutreachWriter) → `anthropic/claude-sonnet-4-6`
- **Job scoring** (JobScorer) → `deepseek/deepseek-v4-pro`
- **JSON/classification lane** (SeniorityDetector, ForgeScore, CompanyIntel, ContactFinder, SalarySummarize, Step0, CompanyIntel Apply, Extract ATS Signals) → `deepseek/deepseek-v4-flash`
- **Intent routing + query expansion** (Intent Router, Expand Query, JD Paste Extract) → `openai/gpt-5.4-mini`
- **Embeddings** → local Ollama `bge-m3`

Verify current pricing/availability at [openrouter.ai/models](https://openrouter.ai/models) before relying on any of these — model IDs above are pulled directly from the live workflow.

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
