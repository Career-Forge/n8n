# Quick Start — 10 Minutes to Your First PDF

Get CareerForge running locally with Docker and ngrok. By the end, you'll send a Telegram message and get back a tailored resume PDF.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- A Telegram account
- 10 minutes

## Step 1: Clone and configure

```bash
git clone https://github.com/Career-Forge/n8n.git careerforge-n8n
cd careerforge-n8n/docker
cp .env.example .env
```

Open `.env` in any editor. You need three things minimum:

1. **OpenRouter API key** — Sign up at [openrouter.ai](https://openrouter.ai/sign-up), do the $10 deposit, create a key. See [API.md](../API.md) for the full walkthrough.
2. **Telegram bot token** — Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow prompts, copy the token.
3. **At least one search provider key** — Easiest: enable the Firecrawl plugin in OpenRouter (Settings → Plugins → Web Search). See [API.md](../API.md).

Paste them into `.env`:

```env
OPENROUTER_API_KEY=sk-or-v1-your-key-here
TELEGRAM_BOT_TOKEN=123456789:your-token-here
FIRECRAWL_API_KEY=fc-your-key-here
```

## Step 2: Start the stack

```bash
docker compose up -d
docker exec -it careerforge_ollama ollama pull bge-m3   # one-time, ~1.2 GB
```

Four services start: n8n (workflow engine), postgres (pgvector — jobs, search, app state), ollama (local embeddings), and latex (PDF compiler). Wait ~30 seconds for n8n to boot.

Open **http://localhost:5678** — login is `careerforge` / `demo1234` (change in `.env`).

Apply the DB schema if starting fresh: `psql -h localhost -U careerforge -d careerforge -f db/schema.sql` (or run it in whatever Postgres client you prefer).

## Step 3: Import the workflows

1. In n8n, click **Workflows** in the left sidebar
2. Click the **+** button → **Import from file**
3. Select `workflows/CareerForge_Master_local.json` from the repo — this is the bot itself
4. Repeat for `CareerForge_ATS_Poller.json` (background job-registry poller) and `CareerForge_Registry_Seeder.json` (one-time registry seed)
5. Open each imported workflow

## Step 4: Set up credentials

In each workflow, you'll see nodes with orange warning badges. These need credentials.

**OpenRouter** (used by all LLM nodes):
1. Click any orange LLM node → click the credential dropdown → **Create new**
2. Type: **OpenAI-compatible** (not plain OpenAI)
3. Base URL: `https://openrouter.ai/api/v1`
4. API Key: your `sk-or-v1-...` key
5. Save. All LLM nodes share this credential.

**Telegram** (used by trigger + send nodes):
1. Click the Telegram Trigger node → credential dropdown → **Create new**
2. Paste your bot token
3. Save. All Telegram nodes share this credential.

**Postgres, Serper, Firecrawl, and the optional premium providers** each need their own credential too — see **[SETUP.md](../SETUP.md#4-n8n-credentials-credentials-tab)** for the complete list, including which ones use a real n8n credential object vs. a bare `.env` key.

## Step 5: Expose with ngrok

Your Telegram bot needs a public URL to receive messages. [ngrok](https://ngrok.com) gives you one for free.

```bash
# Install ngrok (one-time)
# macOS: brew install ngrok/ngrok/ngrok
# Windows: winget install ngrok.ngrok
# Linux: snap install ngrok

# Auth (one-time) — get token from dashboard.ngrok.com
ngrok config add-authtoken YOUR_TOKEN

# Start tunnel
ngrok http 5678
```

Copy the `https://xxxx.ngrok-free.app` URL from ngrok's output.

Go back to n8n → your `.env` file:
```env
WEBHOOK_URL=https://xxxx.ngrok-free.app
```

Restart: `docker compose down && docker compose up -d`

## Step 6: Activate and test

1. In n8n, toggle each of the three workflows **Active** (top-right switch)
2. Open Telegram, find your bot
3. Send: `help`

You should get back a help message listing all commands. If so, CareerForge is running.

## Step 7: Set up your resume

The bot walks you through this itself the first time it needs your résumé — no manual file editing required. Just send `find ML engineer jobs in NYC` (or `apply`, `score`, anything that needs your résumé) and the bot will reply with:

1. A JSON résumé template to copy
2. Instructions to paste it into ChatGPT/Claude along with your existing résumé and have it filled in
3. A prompt to send the filled JSON back as a `.json` file (or pasted text) — this is a one-time setup, the bot reads résumés deterministically from this JSON, not from re-parsing a PDF/text file on every request

Once that's saved, try `find ML engineer jobs in NYC` again. Then reply with a job number to apply.

## What's next

- **Go 24/7:** See [DEPLOYMENT.md](../DEPLOYMENT.md) for free cloud hosting with Render
- **Tune the voice:** See [CUSTOMIZE_PROMPTS.md](CUSTOMIZE_PROMPTS.md) to adjust resume/cover letter tone
- **Understand the system:** See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system diagram

## Troubleshooting

**Bot doesn't respond:**
- Is the workflow active? Check the toggle in n8n.
- Is ngrok running? The tunnel must stay open.
- Check n8n execution logs: Workflows → your workflow → Executions tab.

**"No search providers configured" error:**
- You need at least one of FIRECRAWL_API_KEY, SERPER_API_KEY, or YOUCOM_API_KEY in `.env`.

**LaTeX compilation fails:**
- Check that the latex service is running: `docker compose logs latex`
- The latex container takes ~30s to start on first boot (downloads TeX packages).

**429 rate limit errors:**
- OpenRouter free models have per-provider limits. Wait a few minutes and retry.
- If persistent, check your OpenRouter dashboard for quota status.
