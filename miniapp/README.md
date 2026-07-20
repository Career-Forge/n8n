# CareerForge Mini App

A Telegram Mini App (web UI, rendered inside Telegram) that gives the
CareerForge bot a real interface -- job digest table, an application
tracker (kanban), résumé/ForgeScore view, and prefs -- replacing the
plain-text/Telegraph rendering for anything that needs color, tables, or
persistent state.

## Architecture

- `api/` -- FastAPI sidecar. Serves the built frontend statics and a small
  JSON API under `/api/*`. Reads n8n's session state (last digest,
  preferences, last apply) through a dedicated internal-only webhook
  ("Miniapp Bridge", `scripts/s131_miniapp_bridge_webhook.js`) rather than
  touching n8n's staticData directly -- n8n stays the sole writer.
  Owns a Postgres `applications` table (see `db/migrations/001_applications.sql`)
  for the tracker -- this is the one piece of state that does NOT live in
  n8n staticData, by design (Postgres survives redeploys and is queryable).
- `web/` -- React + Vite + TypeScript + zustand frontend, loaded via
  Telegram's `telegram-web-app.js` script for theme/haptics/initData.

## How actions reach the bot

There is no second copy of the intent-parsing pipeline. When the app wants
something to happen (apply to job #3, run a search, log a track), it POSTs
a synthetic Telegram Update to the bot's real webhook
(`/webhook/careerforge-telegram/webhook`) as if the owner had typed it. The
existing pipeline runs unmodified; results are delivered in the Telegram
chat exactly as they are today. See `api/app/inject.py`.

## Auth

Every `/api/*` route (except `/api/healthz`) requires a valid Telegram
`initData` header (`X-Tg-Init-Data`), HMAC-validated against the bot token
(`api/app/auth.py`), plus a hard owner-id allowlist -- this is a
single-user bot, and successful signature validation alone only proves
"this came from this bot's Mini App," not "this is the owner."

## Local dev

```
cd miniapp/web && npm install && npm run dev   # vite dev server, proxies /api to :5681
cd miniapp/api && pip install -r requirements.txt && uvicorn app.main:app --reload --port 5681
```

Set `MINIAPP_DEV_MODE=true` in the API's env to bypass initData validation
(returns the configured owner) for local curl/browser testing without a
real Telegram client. Never enable this outside local dev.

`scripts/miniapp_sign_initdata.py` (repo root) forges a real, correctly
signed initData string using the actual bot token, for testing the auth
path itself without `MINIAPP_DEV_MODE`.
