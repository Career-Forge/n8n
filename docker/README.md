# CareerForge n8n — Docker Setup

Run CareerForge locally in under 10 minutes. See [docs/QUICKSTART.md](../docs/QUICKSTART.md) for the full walkthrough.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- API keys (see `.env.example` for the full list)

## Quick Start

```bash
cd careerforge_n8n/docker
cp .env.example .env        # fill in your API keys
docker compose up -d         # starts n8n + LaTeX compiler
open http://localhost:5678   # login: careerforge / demo1234
```

## Import the Workflow

1. Open **http://localhost:5678**
2. **Workflows** → **Import from file** → upload `workflows/01_careerforge.json`
3. Open the imported workflow → set credentials (see below)
4. Toggle the workflow **Active**

## Set Up Credentials

In n8n: **Settings → Credentials → Add Credential**

| Credential | Type | Notes |
|:---|:---|:---|
| OpenRouter API | OpenAI-compatible | Base URL: `https://openrouter.ai/api/v1`, API key: your `sk-or-v1-...` |
| CareerForge Bot | Telegram API | Bot token from @BotFather |

That's it. Search provider keys (Firecrawl, Serper, You.com) are read from environment variables — no n8n credentials needed for those.

## Useful Commands

```bash
docker compose logs -f n8n       # live logs
docker compose down              # stop
docker compose down -v           # stop + wipe data
docker compose pull && docker compose up -d  # update n8n
```

## Stack

```
n8n        → http://localhost:5678   (workflow engine)
latex      → http://localhost:5679   (PDF compiler, internal)
```

Both services restart automatically on crash or reboot.
