# CareerForge n8n — Local Docker Setup

Run the full CareerForge multi-agent pipeline locally in under 5 minutes.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- API keys for the services you want to use (see `.env.example`)

## Quick Start

```bash
# 1. Clone or copy this folder to your machine
cd careerforge_n8n/docker

# 2. Create your environment file
cp .env.example .env

# 3. Fill in your API keys in .env (open in any text editor)

# 4. Start the stack
docker compose up -d

# 5. Open n8n in your browser
open http://localhost:5678
# Login: careerforge / demo1234
```

## Import the Workflows

Once n8n is running:

1. Go to **http://localhost:5678**
2. Click **Workflows** in the left sidebar
3. Click **Add workflow** → **Import from file**
4. Import each JSON file from the `../workflows/` folder in this order:
   - `01_application_forge.json`
   - `02_job_discovery.json`
   - `03_company_intel.json`
   - `04_morning_job_digest.json`
   - `05_master_orchestration.json`
5. For each workflow, open it and assign credentials (see below)

## Assign Credentials

Go to **Settings → Credentials** and create:

| Credential Name | Type | Value |
|:---|:---|:---|
| `OpenRouter API` | Header Auth | `Authorization: Bearer <your-openrouter-key>` |
| `Supabase API` | Header Auth | `apikey: <your-supabase-anon-key>` |
| `Firecrawl API` | Header Auth | `Authorization: Bearer <your-firecrawl-key>` |
| `Serper API` | Header Auth | `X-API-KEY: <your-serper-key>` |
| `Hunter API` | Header Auth | `Authorization: Bearer <your-hunter-key>` |

## Test the Master Webhook

```bash
curl -X POST http://localhost:5678/webhook/careerforge \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "demo-user",
    "message": "Find me Senior ML Engineer jobs in New York"
  }'
```

## Useful Commands

```bash
# View logs
docker compose logs -f n8n

# Stop the stack
docker compose down

# Stop and remove all data (fresh start)
docker compose down -v

# Update n8n to latest version
docker compose pull && docker compose up -d
```

## Architecture

```
POST /webhook/careerforge
        │
        ▼
  Brian the Router (GPT-4.1-nano)
        │
        ▼
  ┌─────┴──────────────────────┐
  │     Switch by Intent        │
  └──┬──────────┬──────────┬───┘
     │          │          │
     ▼          ▼          ▼
Application  Job        Company
  Forge    Discovery    Intel
(Resume +  (Scrape +   (Research +
 Cover)     Score)      Outreach)
     │          │          │
     └──────────┴──────────┘
                │
                ▼
         The Judge (Gemini Flash)
         Hallucination detection
                │
                ▼
         Respond to User
```
