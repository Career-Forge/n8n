# API Reference

Every external service CareerForge talks to — what it does, what it costs, and how to set it up.

## TL;DR

| Service | Free Tier | Purpose | Required? | Signup |
|---------|-----------|---------|-----------|--------|
| OpenRouter | 1000 calls/day (after $10 deposit) | All LLM inference | Yes | [openrouter.ai](https://openrouter.ai/sign-up) |
| Telegram Bot API | Unlimited | User interface | Yes | [@BotFather](https://t.me/BotFather) |
| Firecrawl | 100K scraping credits | Web search (intel, outreach, find_jobs) | 1 of 3 | [firecrawl.dev](https://firecrawl.dev/app/api-keys) |
| Serper | 2500 searches (one-time) | Google SERP search | 1 of 3 | [serper.dev](https://serper.dev) |
| You.com | $100 free credit | Web search | 1 of 3 | [api.you.com](https://api.you.com) |
| Adzuna | Free key | Structured job search (real location + salary data) | Optional | [developer.adzuna.com](https://developer.adzuna.com) |

**"1 of 3"** = you need at least one of the three web-search providers. More providers = better results (RRF merges rankings). Adzuna is a separate, optional structured lane, not one of the three — see [SETUP.md](SETUP.md)'s `app_settings` table section for how its keys get into the DB (not `.env`, not an n8n credential).

## Monthly cost estimate

After the one-time $10 OpenRouter deposit:

| What | Model | Cost per call | Calls/day (typical) | Monthly |
|------|-------|--------------|---------------------|---------|
| Intent routing | `openai/gpt-5.4-mini` | ~$0.001 | 10-20 | ~$0.30 |
| Seniority detection | `deepseek/deepseek-v4-flash` | ~$0.001 | 1-3 | ~$0.06 |
| ForgeScore | `deepseek/deepseek-v4-flash` | ~$0.001 | 1-3 | ~$0.06 |
| Contact extraction | `deepseek/deepseek-v4-flash` | ~$0.001 | 1-2 | ~$0.04 |
| Company intel | `deepseek/deepseek-v4-flash` | ~$0.001 | 1-2 | ~$0.04 |
| Salary analysis | `deepseek/deepseek-v4-flash` | ~$0.001 | 0-1 | ~$0.02 |
| Job scoring | `deepseek/deepseek-v4-pro` | ~$0.005/batch | 5-10 | ~$0.75 |
| Resume generation | `anthropic/claude-sonnet-4-6` | ~$0.05 | 1-3 | ~$1.50 |
| Cover letter | `anthropic/claude-sonnet-4-6` | ~$0.05 | 1-3 | ~$1.50 |
| Outreach drafts | `anthropic/claude-sonnet-4-6` | ~$0.05 | 0-2 | ~$0.50 |

Model IDs are pulled from the live workflow's `*Model` nodes — verify current pricing at [openrouter.ai/models](https://openrouter.ai/models) before relying on the numbers above.

**Realistic monthly total: $2-4.** The $10 deposit is not a subscription — it's a prepaid balance that lasts months of daily use.

---

## OpenRouter

OpenRouter is the single gateway for all LLM calls. One API key, all models.

### Setup

1. **Sign up** at [openrouter.ai/sign-up](https://openrouter.ai/sign-up)
2. **Deposit $10** — Settings > Billing > Add credits. This is a one-time prepaid balance, not a subscription. It unlocks:
   - 1000 free-model calls per day
   - Access to paid models (Claude, GPT, DeepSeek Pro, etc.)
3. **Create an API key** — Settings > API Keys > Create Key
4. **Copy the key** — starts with `sk-or-v1-`

### The 51-call verification

OpenRouter requires 51 API calls before some free models fully unlock. During your first session, you might hit rate limits on free models. Just keep using the bot — after ~51 calls across any models, the limits lift permanently.

### Credential setup in n8n

This is the part most people get wrong. OpenRouter uses the **OpenAI-compatible** credential type, not "OpenAI":

1. In n8n, click any LLM node > Credential dropdown > Create New
2. Type: **OpenAI-compatible** (also called "OpenAi Api" in some n8n versions)
3. Base URL: `https://openrouter.ai/api/v1`
4. API Key: your `sk-or-v1-...` key
5. Save

All LLM nodes in the workflow share this one credential. You don't need separate credentials per model — the model slug in each node tells OpenRouter which model to use.

### Firecrawl (easiest search provider to set up)

OpenRouter's plugin page is the easiest way to get a Firecrawl key — it accepts OpenRouter's ToS and auto-creates a Firecrawl account with 100K free credits, no separate signup form:

1. Go to [openrouter.ai/settings/plugins](https://openrouter.ai/settings/plugins), enable **Web Search**
2. Grab your real key from [firecrawl.dev/app/api-keys](https://firecrawl.dev/app/api-keys)
3. Set `FIRECRAWL_API_KEY=fc-...` in `.env`

Note this is a real, separate Firecrawl API key (`fc-...`), not your OpenRouter key — CareerForge calls the native Firecrawl API via a real n8n credential (`Firecrawl Search` node), not an OpenRouter plugin passthrough. See [SETUP.md](SETUP.md) for wiring the n8n credential object itself (the `.env` key alone isn't enough for this lane).

### Models used

Model IDs are pulled directly from the live workflow's `*Model` nodes — the table in the [Monthly cost estimate](#monthly-cost-estimate) section above is generated the same way and is authoritative. Verify current pricing at [openrouter.ai/models](https://openrouter.ai/models) before relying on it.

---

## Telegram Bot API

Your bot is the user interface. All messages go through Telegram's Bot API.

### Setup

1. Open Telegram, find [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow the prompts — pick a name and username
4. Copy the bot token (looks like `123456789:ABCdefGHIjklMNOpqrstUVwxyz`)

### Credential setup in n8n

1. Click the Telegram Trigger node > Credential dropdown > Create New
2. Type: **Telegram API**
3. Paste your bot token
4. Save

All Telegram nodes (trigger + send) share this credential.

### Webhook vs polling

CareerForge uses webhook mode — Telegram pushes messages to your n8n URL. This requires a public HTTPS URL (ngrok for local, or your cloud deployment URL). n8n handles the webhook registration automatically when you activate the workflow.

If your webhook stops working:
```bash
# Check current webhook status
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getWebhookInfo" | python3 -m json.tool

# Manually set webhook (if needed)
curl "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://your-domain.com/webhook/<WEBHOOK_ID>"
```

Get the webhook ID from the Telegram Trigger node's URL field in n8n.

---

## Search Providers

CareerForge fans out to up to 3 search providers and merges results with RRF (Reciprocal Rank Fusion). You need at least one. More = better coverage.

### Firecrawl

**Easiest option.** Enable via the OpenRouter plugin (see above) — no separate signup.

For standalone Firecrawl:
1. Sign up at [firecrawl.dev](https://www.firecrawl.dev/)
2. Get your API key
3. Add to `.env`: `FIRECRAWL_API_KEY=fc-your-key`

### Serper

Google SERP results. 2500 free searches — enough for months of use.

1. Sign up at [serper.dev](https://serper.dev)
2. Get your API key from the dashboard
3. Add to `.env`: `SERPER_API_KEY=your-key`

### You.com

$100 free credit on signup. Returns AI-curated search results.

1. Sign up at [api.you.com](https://api.you.com)
2. Get your API key
3. Add to `.env`: `YOUCOM_API_KEY=your-key`

### Which should I pick?

Just Firecrawl via OpenRouter. Zero extra signup, zero extra cost. Add Serper or You.com later if you want better search coverage — the RRF merge gets stronger with more sources.

---

## Job search sources

`find_jobs` merges two kinds of sources, not a single API:

1. **Live web/structured lanes**, called on every search: Adzuna (structured, needs the `app_settings` keys above), RemoteOK (free, public, no auth), JSearch, plus the Firecrawl/Serper/You.com search fan-out described above.
2. **A local Postgres/pgvector cache**, filled by a separate, always-running **ATS Poller** workflow (`workflows/CareerForge_ATS_Poller.json`) that pulls directly from company career sites — Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Eightfold, Workable, Recruitee, Avature, plus a few single-company integrations (Amazon, Apple, Oracle). None of these need signup or keys; the poller hits each ATS's own public API. `find_jobs` reads this cache instantly (`Hybrid Cache Search`) rather than re-fetching live, and it grows automatically — every search that surfaces a job from a known ATS adds that company to the poller's coverage.

Nothing here needs configuring beyond importing and activating the poller workflow (see the Quick Start in [README.md](README.md)). See [ROADMAP.md](ROADMAP.md) for current adapter coverage.

---

## Troubleshooting

### 429 Rate Limit Errors

**Free models (Llama, DeepSeek):** OpenRouter limits free models per provider. Wait 60 seconds and retry. If persistent:
- Check your OpenRouter dashboard for quota status
- Make sure you've completed the 51-call verification
- Confirm your $10 deposit is active

**Paid models (Sonnet, Gemini):** These rarely hit limits. If you do, your prepaid balance might be low — check Settings > Billing on OpenRouter.

### "No search providers configured"

You need at least one of these in your `.env`:
- `FIRECRAWL_API_KEY`
- `SERPER_API_KEY`
- `YOUCOM_API_KEY`

The search Code node checks for these at runtime. If none are set, it returns an error.

### Credential errors in n8n

**"Invalid API key"** — Make sure you're using the **OpenAI-compatible** credential type, not plain "OpenAI". The base URL must be `https://openrouter.ai/api/v1`.

**"401 Unauthorized" on Telegram** — Your bot token is wrong or expired. Get a new one from @BotFather.

### Webhook not firing

1. Check that the workflow is toggled **Active** in n8n
2. Verify the webhook URL is reachable: `curl https://your-domain.com/healthz`
3. Check Telegram's webhook status: `curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
4. If `last_error_message` shows an error, your URL is unreachable — check ngrok/deployment

### LaTeX compilation fails

- Check the latex service is running: `docker compose logs latex`
- First boot downloads TeX packages (~30s delay)
- If a specific PDF fails, the LaTeX source likely has invalid characters. Check the n8n execution log for the `.tex` content.

### OpenRouter balance exhausted

Free models still work (they don't cost money). Only paid model calls (Sonnet, Gemini) draw from your balance. If you're out:
- Resume/cover letter generation stops working
- Job scoring degrades
- Everything else (routing, scoring, intel, contacts) keeps working on free models

Top up at [openrouter.ai/settings/billing](https://openrouter.ai/settings/billing). Another $10 lasts months.
