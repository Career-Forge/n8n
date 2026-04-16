# CareerForge n8n

An AI-powered career automation system built entirely in n8n. Scrape job descriptions, score resume fit, tailor your resume with Claude, research companies, find contacts, and get a Telegram digest every morning -- all automated.

Built and demoed live at **n8n NYC Meetup, April 2026**.

---

## Workflows

| # | Workflow | What it does |
|---|----------|--------------|
| 01 | **Application Forge** | Scrapes a JD, scores resume fit (ForgeScore), tailors resume (ResumeForge), writes cover letter (CoverForge) |
| 02 | **Job Discovery** | Parallel search via Serper.dev + You.com, deduplicates, scores fit, generates market intel |
| 03 | **Company Intel** | 3-way parallel research -- news, company profile, contact search -- risk score + outreach drafts |
| 04 | **Morning Digest** | Scheduled 8am Telegram message with top 3 jobs + market pulse |
| 05 | **Master Orchestration** | Brian the Router (GPT-4.1-nano) routes any message to the right workflow |
| 06 | **Telegram Bot** | Self-contained bot -- find jobs or generate application packages via Telegram |

---

## Models

All LLM calls route through [OpenRouter](https://openrouter.ai) -- one API key, any model.

| Node | Model |
|------|-------|
| JD Analyzer, ForgeScore, Risk Assessor, Market Intel | `google/gemini-2.0-flash-001` |
| ResumeForge, CoverForge, Intel Synthesizer, Outreach Writer | `anthropic/claude-sonnet-4.6` |
| Fit Scorer | `anthropic/claude-haiku-4-5` |
| Brian the Router | `openai/gpt-4.1-nano` |
| The Judge (output validation) | `google/gemini-2.0-flash-001` |

---

## Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) running
- API keys (see below)

### 1. Clone and configure

```bash
git clone https://github.com/YOUR_USERNAME/careerforge-n8n.git
cd careerforge-n8n/docker
cp .env.example .env
# Fill in your API keys in .env
```

### 2. Start n8n

```bash
docker compose up -d
# Open http://localhost:5678
# Login: careerforge / demo1234  (change in .env)
```

### 3. Install the Firecrawl community node

In n8n: **Settings → Community Nodes → Install** → search `n8n-nodes-firecrawl`

### 4. Import workflows

Go to **Workflows → Create workflow → Import from file** and import in order:

```
workflows/01_application_forge.json
workflows/02_job_discovery.json
workflows/03_company_intel.json
workflows/04_morning_job_digest.json
workflows/05_master_orchestration.json
workflows/06_telegram_bot_v4.json
```

### 5. Set up credentials

In **Settings → Credentials**, create a Header Auth credential for each:

| Name | Header | Value |
|------|--------|-------|
| `OpenRouter API` | `Authorization` | `Bearer YOUR_KEY` |
| `Firecrawl API` | `Authorization` | `Bearer YOUR_KEY` |
| `Serper API` | `X-API-KEY` | `YOUR_KEY` |
| `You.com API` | `X-API-Key` | `YOUR_KEY` |
| `Supabase API` | `apikey` | `YOUR_ANON_KEY` |

For Telegram: use the built-in **Telegram** credential type with your bot token.

### 6. Set workflow variables (WF04 + WF05 only)

After importing, open WF04 and WF05 → **Settings → Variables** and set:

```
JOB_DISCOVERY_WORKFLOW_ID   = <ID from your imported WF02>
APP_FORGE_WORKFLOW_ID       = <ID from your imported WF01>
COMPANY_INTEL_WORKFLOW_ID   = <ID from your imported WF03>
MORNING_DIGEST_WORKFLOW_ID  = <ID from your imported WF04>
```

Workflow IDs appear in the URL bar when you open each workflow.

### 7. Add your master resume

Open WF01 → `Merge JD + Resume Context` node → replace the placeholder resume text with your own.

For a production setup, store your resume in Supabase under a `user_profiles` table with a `master_resume` text column -- the Supabase node in WF01 fetches it automatically.

### 8. Activate

Toggle each workflow to **Active**. Webhook URLs go live, the 8am digest schedule starts.

---

## API Keys (all free tiers)

| Service | Free tier | Used in |
|---------|-----------|---------|
| [OpenRouter](https://openrouter.ai) | Free credits on signup | All LLM calls |
| [Firecrawl](https://firecrawl.dev) | 100k credits free | WF01, WF02 |
| [Serper.dev](https://serper.dev) | 2,500 searches free | WF02, WF03 |
| [You.com](https://api.you.com) | Free credits, no card | WF02, WF03 |
| [Supabase](https://supabase.com) | Free tier sufficient | WF01 |
| Telegram Bot | Free via @BotFather | WF04, WF05, WF06 |

---

## Test it

**Demo mode** (no scraping, no Supabase needed):

```bash
curl -X POST http://localhost:5678/webhook/application-forge \
  -H "Content-Type: application/json" \
  -d '{
    "demo_mode": true,
    "target_role": "Senior ML Engineer",
    "target_company": "Anthropic"
  }'
```

**Live mode** (real JD URL):

```bash
curl -X POST http://localhost:5678/webhook/application-forge \
  -H "Content-Type: application/json" \
  -d '{
    "jd_url": "https://jobs.lever.co/example/job-id",
    "user_id": "your-user-id"
  }'
```

---

## Architecture

```
POST /webhook/careerforge  or  Telegram message
              │
              ▼
    Brian the Router (GPT-4.1-nano)
    Classifies intent, extracts entities
              │
              ▼
    ┌─────────┴──────────────────────┐
    │      Switch by Intent           │
    └──┬───────────┬──────────┬──────┘
       ▼           ▼          ▼
  Application   Job        Company
    Forge     Discovery     Intel
  (01)        (02)         (03)
       │           │          │
       └───────────┴──────────┘
                   │
                   ▼
           The Judge (Gemini Flash)
           Output quality check
                   │
                   ▼
           Respond to user
```

---

## Project structure

```
careerforge-n8n/
├── workflows/          # n8n workflow JSON files
├── docker/             # Docker Compose stack + .env.example
├── latex-service/      # LaTeX PDF compilation (optional)
├── chroma-api/         # ChromaDB sidecar for preferences (optional)
└── scripts/            # Demo scripts
```

---

## License

MIT -- use it, fork it, build on it.

---

## Built by

**Pranav Kowadkar** -- [pkowadkar.com](https://pkowadkar.com) · [LinkedIn](https://linkedin.com/in/pkowadkar)

Demoed at n8n NYC Meetup, April 2026. Spoke about multi-agent architectures at LLM Day NYC, March 2026.
