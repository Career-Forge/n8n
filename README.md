# CareerForge n8n

A single Telegram bot that handles your entire job search — morning digests, tailored resume + cover letter PDFs, company intel, cold outreach, and application tracking. Built entirely in [n8n](https://n8n.io), self-hosted, runs for ~$2/month after a one-time $10 OpenRouter deposit.

Demoed live at **n8n NYC Meetup, April 2026**.

> **Setting it up?** See **[SETUP.md](SETUP.md)** for the full clone-and-BYOK guide — Docker stack, the credentials to create, `app_settings` rows, free-vs-premium providers, the central model map, and how to switch on premium contacts (Apollo/Hunter).

---

## How It Works

```mermaid
flowchart TD
    TG["Telegram Message"] --> ROUTER["Intent Router<br/><i>LLM classifier</i>"]
    CRON["Schedule Trigger<br/><i>8am + 11:30am ET</i>"] --> FIND

    ROUTER --> |help| HELP["Help Text"]
    ROUTER --> |find_jobs| FIND["Job Discovery<br/><i>structured + web search, /100 scoring</i>"]
    ROUTER --> |apply| APPLY["Resume + Cover PDF<br/><i>2-phase select+generate, ATS loop, LaTeX</i>"]
    ROUTER --> |revise| REVISE["Refine Last Output<br/><i>Chat Memory + Sonnet</i>"]
    ROUTER --> |score| SCORE["ForgeScore<br/><i>Resume vs JD</i>"]
    ROUTER --> |intel| INTEL["Company Intel<br/><i>Search Fan-out + RRF</i>"]
    ROUTER --> |outreach| OUTREACH["Contact Finder<br/><i>Switch + RRF + Outreach Writer</i>"]
    ROUTER --> |salary| SALARY["Salary Intel"]
    ROUTER --> |track| TRACK["Application Tracker"]
    ROUTER --> |status| STATUS["Pipeline Status"]

    FIND --> TG_OUT["Telegram Response"]
    APPLY --> PDF["PDF via LaTeX Service"]
    PDF --> TG_DOC["Telegram sendDocument"]
    REVISE --> PDF
    SCORE --> TG_OUT
    INTEL --> TG_OUT
    OUTREACH --> TG_OUT
    SALARY --> TG_OUT
    TRACK --> TG_OUT
    STATUS --> TG_OUT
    HELP --> TG_OUT
```

---

## Features

| Intent | What it does | Example message |
|--------|-------------|-----------------|
| **find_jobs** | Searches company ATS/career pages + web (optional RemoteOK/Adzuna lanes, default OFF), dedupes, scores fit **/100** with sub-scores, returns top matches | "find AI jobs in NYC" |
| **apply** | 2-phase engine: selects content against the JD, frames bullets to **researched company values + mission**, scores **ATS** and auto-improves if weak — then resume + cover PDFs | "3" (applies to job #3 from last search) |
| **revise** | Iterates on the last resume/cover with chat memory | "make it shorter" |
| **score** | Scores your resume against a job description (**0-100**, explainable) | "score my resume for this role" |
| **intel** | Multi-source company health report (layoffs, funding, H1B, culture, **mission/vision**), cached | "intel about Databricks" |
| **outreach** | Finds real recruiters/hiring managers + writes outreach citing a **real public hook**; optional verified contacts (Apollo/Hunter, BYOK) | "who should I contact at Anthropic" |
| **draft** | Writes the outreach variants for a chosen contact | "draft 1" |
| **salary** | Salary ranges + negotiation advice | "salary for ML Engineer at Stripe" |
| **costs** | API/LLM spend summary (last 30 days, from `tool_cost_log`) | "costs" |
| **track** | Logs and lists your applications | "track" |
| **status** | Pipeline status overview | "status" |
| **help** | Command list | "help" |

---

## Cost

| Service | Cost | What you get |
|---------|------|-------------|
| [OpenRouter](https://openrouter.ai) | $10 one-time deposit | 1,000 free model calls/day (forever) + paid models at ~$0.05/generation |
| [Telegram Bot API](https://core.telegram.org/bots) | Free | Unlimited messages + 50MB file delivery |
| [Firecrawl](https://firecrawl.dev) | Free (via OpenRouter plugin) | 100K scraping credits |
| [You.com](https://api.you.com) | Free ($100 credits) | 20K searches with LiveCrawl |
| [Serper](https://serper.dev) | Free (2,500 credits) | Google SERP fallback |
| **Monthly total** | **~$2/mo** | Paid model calls only (resume + cover letter generation) |

---

## Model Routing

Cheap/free models for classification and scoring. Paid models only where writing quality matters.

| Task | Model | Cost |
|------|-------|------|
| Intent routing | `meta-llama/llama-3.3-70b-instruct:free` | Free |
| Seniority detection | `deepseek/deepseek-chat-v3.1:free` | Free |
| Job scoring | `google/gemini-3.1-flash-lite-preview` | ~$0.001/batch |
| ForgeScore | `deepseek/deepseek-chat-v3.1:free` | Free |
| Contact extraction | `deepseek/deepseek-chat-v3.1:free` | Free |
| Company intel synthesis | `deepseek/deepseek-chat-v3.1:free` | Free |
| **ResumeForge** | `anthropic/claude-sonnet-4.6` | ~$0.05 |
| **CoverForge** | `anthropic/claude-sonnet-4.6` | ~$0.05 |
| **Outreach writer** | `anthropic/claude-sonnet-4.6` | ~$0.05 |

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) running
- [ngrok](https://ngrok.com/) account (free tier works)
- API keys: OpenRouter (required), Telegram Bot (required), at least one search provider

### 1. Clone and configure

```bash
git clone https://github.com/Career-Forge/n8n.git
cd n8n/docker
cp .env.example .env
# Fill in your API keys in .env
```

### 2. Start services

```bash
docker compose up -d
# n8n:          http://localhost:5678
# LaTeX service: http://localhost:5679
```

### 3. Start ngrok tunnel

```bash
ngrok http 5678
# Copy the https://xxx.ngrok-free.app URL → set as WEBHOOK_URL in .env
# Restart n8n: docker compose restart n8n
```

### 4. Import the workflow

In n8n: **Workflows > Import from file** > select `workflows/01_careerforge.json`

### 5. Set up credentials

In n8n **Settings > Credentials**, create:

| Credential | Type | Setting | Value |
|-----------|------|---------|-------|
| OpenRouter API | **OpenAI-compatible** | Base URL | `https://openrouter.ai/api/v1` |
| OpenRouter API | OpenAI-compatible | API Key | `sk-or-v1-...` |
| Firecrawl API | Header Auth | `Authorization` | `Bearer fc-...` |
| You.com API | Header Auth | `X-API-Key` | your key |
| Serper API | Header Auth | `X-API-KEY` | your key |
| Telegram Bot | Telegram API | — | Bot token from @BotFather |

Activate the workflow. Text your bot "help" to verify.

---

## Project Structure

```
careerforge-n8n/
|
|-- README.md                          # This file
|-- DEPLOYMENT.md                      # 4 hosting tiers (local to cloud)
|-- API.md                             # External services + cost math
|-- LICENSE                            # MIT
|-- PLAN.md                            # Refactor execution plan
|
|-- docs/
|   |-- QUICKSTART.md                  # Docker + ngrok 10-min setup
|   |-- MASTER_RESUME_GUIDE.md         # Template walkthrough
|   |-- CUSTOMIZE_PROMPTS.md           # Tune voice and style
|   |-- ARCHITECTURE.md                # System diagrams + deep dive
|   +-- diagrams/                      # Mermaid .mmd sources
|
|-- workflows/
|   +-- 01_careerforge.json            # THE workflow (single file)
|
|-- templates/
|   |-- master_resume_template.txt     # Fill-in-the-blank master resume
|   |-- master_resume_example.txt      # Worked example (fictional persona)
|   |-- resume_skeleton_fresher.tex    # LaTeX skeleton: <2 yrs experience
|   |-- resume_skeleton_experienced.tex # LaTeX skeleton: 2-10 yrs
|   |-- resume_skeleton_senior.tex     # LaTeX skeleton: 10+ yrs
|   +-- cover_skeleton.tex             # LaTeX skeleton: cover letter
|
|-- prompts/
|   |-- IntentRouter.md                # LLM intent classification
|   |-- SeniorityDetector.md           # Auto-detect fresher/experienced/senior
|   |-- ResumeForge_v3.md             # Tailored resume generation
|   |-- CoverForge_v3.md              # Cover letter generation
|   |-- ResumeRefine.md               # Iterative resume refinement
|   |-- CoverRefine.md                # Iterative cover refinement
|   |-- ForgeScore_v3.md              # Resume vs JD scoring (0-10)
|   |-- JobScorer.md                   # Batch job ranking
|   |-- ContactFinder.md              # Extract contacts from search results
|   |-- OutreachWriter.md             # Multi-variant outreach generation
|   +-- CompanyIntel.md               # Company health report
|
|-- services/
|   +-- latex/
|       |-- Dockerfile
|       +-- app.py                     # Flask + pdflatex PDF compiler
|
|-- docker/
|   |-- docker-compose.yml             # n8n + LaTeX (local dev)
|   |-- docker-compose.render.yml      # Render free tier (SQLite)
|   |-- Dockerfile.render              # Render/Railway image (bakes templates in)
|   |-- render.yaml                    # Render Blueprint
|   |-- railway.json                   # Railway config
|   |-- .env.example                   # All API keys documented
|   +-- README.md
|
+-- scripts/
    +-- uptime_ping.sh                 # Keep-alive ping for Render free tier
```

---

## How the Resume Pipeline Works

1. You text a job number (e.g., "3") after a job search
2. **SeniorityDetector** reads your master resume, picks the right LaTeX skeleton (fresher/experienced/senior)
3. **ForgeScore** scores your fit (0-10). Below 6? You get a warning with specific gaps
4. **ResumeForge** (Claude Sonnet 4.6) generates structured JSON — tailored bullets, keyword-aligned, metric-preserved
5. A JS node deterministically fills the LaTeX skeleton with the JSON content
6. **LaTeX service** compiles to PDF
7. Same flow for **CoverForge** (runs in parallel)
8. Both PDFs delivered via Telegram `sendDocument`
9. Reply "make it shorter" or "more Python" to iterate — chat memory preserves context

---

## Search Fan-out + RRF Merge

The outreach and intel branches use a Switch node to fire configured search providers in parallel:

```
Switch: Which providers are configured?
  |-- Firecrawl (if FIRECRAWL_API_KEY set)
  |-- You.com   (if YOUCOM_API_KEY set)
  |-- Serper    (if SERPER_API_KEY set)
  +-- Fallback  (none configured → helpful error)

Results merge via Reciprocal Rank Fusion (RRF):
  score(doc) = sum(1 / (k + rank_i)) across all providers

Top 15 deduped results → LLM extraction
```

Configure 1, 2, or 3 providers. The system gracefully degrades — works with any combination.

---

## Status

| Component | Status |
|-----------|--------|
| Intent router (10 intents) | Complete |
| find_jobs (Greenhouse + scoring) | Complete |
| apply (PDF pipeline) | Complete |
| revise (chat memory iteration) | Complete |
| score (ForgeScore standalone) | Complete |
| intel (company health) | Complete |
| outreach (contact finder + writer) | Complete |
| salary / track / status | Complete |
| LaTeX PDF service | Complete |
| Deployment configs (5 tiers) | Complete |

---

## Contributing

Issues and PRs welcome. See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for system design details.

## License

[MIT](LICENSE)
