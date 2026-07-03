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
2. **Workflows** → **Import from file** → upload `docker/workflows/CareerForge_Master_local.json`, then repeat for `CareerForge_ATS_Poller.json` and `CareerForge_Registry_Seeder.json`
3. Open each imported workflow → set credentials (see below)
4. Toggle each workflow **Active**

## Set Up Credentials

This compose file also brings up Postgres (pgvector) and Ollama (`bge-m3` embeddings), on top of n8n and the LaTeX service. See **[SETUP.md](../SETUP.md)** for the full credential list (Postgres, Telegram, OpenRouter, Serper, Firecrawl, optional Apollo/Hunter) and which ones need a real n8n credential object vs. a bare `.env` key.

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
