# Deployment Guide

Five ways to run CareerForge, from "works on my laptop" to "zero ops cloud." Start with Tier 0, graduate when you're ready.

| Tier | Where | Cost | Trade-off |
|------|-------|------|-----------|
| 0 | Local Docker + ngrok | $0 | Laptop must stay on |
| 1 | Render free tier | $0 | Cold starts, 750 hrs/mo |
| 2 | Railway | $5/mo | Reliable, zero ops |
| 3 | Hetzner VPS | $4.59/mo | Full control, daily backups |
| 4 | n8n Cloud | $20/mo | Managed, import and go |

---

## Tier 0: Local Docker + ngrok

Keep your Docker stack running locally, expose it via ngrok's free static domain. Works as long as your machine is on.

### Prerequisites
- Docker Desktop running
- ngrok account at [ngrok.com](https://ngrok.com) (free)
- Your n8n stack already up via `docker compose up -d` (see [QUICKSTART](docs/QUICKSTART.md))

> Your static domain is already assigned — every free ngrok account gets one `*.ngrok-free.app` domain automatically. No browser UI needed.

---

### Windows (PowerShell)

**1. Install ngrok (one-time)**
```powershell
winget install ngrok.ngrok
# Restart terminal after install, then verify:
ngrok version
```

**2. Authenticate (one-time)**

Get your authtoken from [dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken):
```powershell
ngrok config add-authtoken YOUR_AUTHTOKEN_HERE
```

**3. Get your free static domain (one-time)**

Your free account already has a static `*.ngrok-free.app` domain. Retrieve it:
```powershell
# Get your ngrok API key from: https://dashboard.ngrok.com/api-keys
$apiKey = "YOUR_NGROK_API_KEY"
$headers = @{
    "Authorization" = "Bearer $apiKey"
    "Ngrok-Version" = "2"
}
$domains = Invoke-RestMethod -Uri "https://api.ngrok.com/reserved_domains" -Headers $headers
$domains.reserved_domains | Select-Object domain, region
# Output: crazy-fox-1234.ngrok-free.app  <-- copy this
```

**4. Set the domain in `.env`**
```powershell
$ngrokDomain = "crazy-fox-1234.ngrok-free.app"   # your domain from step 3
$envPath = "docker/.env"
(Get-Content $envPath) -replace 'WEBHOOK_URL=.*', "WEBHOOK_URL=https://$ngrokDomain/" |
    Set-Content $envPath
```

**5. Restart Docker and start the tunnel**
```powershell
cd docker
docker compose down
docker compose up -d
# Wait ~10 seconds for n8n to boot, then:
ngrok http --domain=crazy-fox-1234.ngrok-free.app 5678
```
Leave this PowerShell window open. ngrok forwards `https://crazy-fox-1234.ngrok-free.app` to `localhost:5678`.

**6. Optional: Auto-start ngrok on Windows boot**
```powershell
$action = New-ScheduledTaskAction -Execute 'ngrok' `
    -Argument 'http --domain=crazy-fox-1234.ngrok-free.app 5678'
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'CareerForge-ngrok' `
    -Action $action -Trigger $trigger -RunLevel Highest -Force
```
Now ngrok auto-starts every login.

**7. Verify Telegram webhook**
```powershell
$botToken = "YOUR_BOT_TOKEN"
Invoke-RestMethod "https://api.telegram.org/bot$botToken/getWebhookInfo" |
    Select-Object -ExpandProperty result | Select-Object url, last_error_message
# Should show: url = https://crazy-fox-1234.ngrok-free.app/webhook/...
```

---

### macOS (bash / zsh)

**1. Install ngrok (one-time)**
```bash
brew install ngrok/ngrok/ngrok
ngrok version
```

**2. Authenticate (one-time)**
```bash
ngrok config add-authtoken YOUR_AUTHTOKEN_HERE
```

**3. Get your static domain (one-time)**
```bash
NGROK_API_KEY="YOUR_NGROK_API_KEY"
curl -s -H "Authorization: Bearer $NGROK_API_KEY" \
     -H "Ngrok-Version: 2" \
     https://api.ngrok.com/reserved_domains \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(x['domain']) for x in d['reserved_domains']]"
# Output: crazy-fox-1234.ngrok-free.app
```

**4. Patch `.env`**
```bash
NGROK_DOMAIN="crazy-fox-1234.ngrok-free.app"
sed -i '' "s|WEBHOOK_URL=.*|WEBHOOK_URL=https://$NGROK_DOMAIN/|" docker/.env
```

**5. Restart Docker and start the tunnel**
```bash
cd docker
docker compose down && docker compose up -d
sleep 10
ngrok http --domain=crazy-fox-1234.ngrok-free.app 5678
```

**6. Optional: Auto-start ngrok on login (launchd)**
```bash
NGROK_DOMAIN="crazy-fox-1234.ngrok-free.app"
cat > ~/Library/LaunchAgents/com.careerforge.ngrok.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.careerforge.ngrok</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/ngrok</string>
    <string>http</string>
    <string>--domain=$NGROK_DOMAIN</string>
    <string>5678</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.careerforge.ngrok.plist
```

**7. Verify Telegram webhook**
```bash
BOT_TOKEN="YOUR_BOT_TOKEN"
curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -m json.tool | grep url
```

---

### Linux (Ubuntu / Debian / Fedora / Arch)

**1. Install ngrok (one-time)**

```bash
# Ubuntu / Debian
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok

# Fedora / RHEL
sudo snap install ngrok

# Arch
yay -S ngrok   # AUR
```

**2. Authenticate (one-time)**
```bash
ngrok config add-authtoken YOUR_AUTHTOKEN_HERE
```

**3. Get your static domain (one-time)**
```bash
NGROK_API_KEY="YOUR_NGROK_API_KEY"
curl -s -H "Authorization: Bearer $NGROK_API_KEY" \
     -H "Ngrok-Version: 2" \
     https://api.ngrok.com/reserved_domains \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(x['domain']) for x in d['reserved_domains']]"
```

**4. Patch `.env`**
```bash
NGROK_DOMAIN="crazy-fox-1234.ngrok-free.app"
sed -i "s|WEBHOOK_URL=.*|WEBHOOK_URL=https://$NGROK_DOMAIN/|" docker/.env
```
> Linux `sed -i` has no extra argument (unlike macOS `sed -i ''`).

**5. Restart Docker and start the tunnel**
```bash
cd docker
docker compose down && docker compose up -d
sleep 10
ngrok http --domain=crazy-fox-1234.ngrok-free.app 5678
```

**6. Optional: Auto-start ngrok on boot (systemd)**
```bash
NGROK_DOMAIN="crazy-fox-1234.ngrok-free.app"
NGROK_BIN=$(which ngrok)

sudo tee /etc/systemd/system/careerforge-ngrok.service > /dev/null << EOF
[Unit]
Description=CareerForge ngrok Tunnel
After=network.target

[Service]
ExecStart=$NGROK_BIN http --domain=$NGROK_DOMAIN 5678
Restart=always
RestartSec=5
User=$USER

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable careerforge-ngrok
sudo systemctl start careerforge-ngrok
```

**7. Verify Telegram webhook**
```bash
BOT_TOKEN="YOUR_BOT_TOKEN"
curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -m json.tool | grep url
```

### Gotchas (all platforms)
- Machine must stay on — if it sleeps, the tunnel dies and Telegram messages queue up
- Static domain persists across restarts — you never need to re-register the webhook
- ngrok free tier: 1 static domain, unlimited bandwidth for personal use

---

## Tier 1: Render Free + UptimeRobot

Zero-cost hosting that works even when your laptop is off. Not production-grade but good enough for job hunting.

> Render free tier spins down after 15 min of inactivity. UptimeRobot pings it every 5 min to keep it awake. You get 750 free hours per month — enough for 24/7 with keep-alive.

### Why SQLite, not Postgres

Render's free Postgres expires after 30 days. Then your data is gone. SQLite with a persistent disk has no expiry. CareerForge uses `staticData` for cross-execution state anyway — SQLite is plenty.

### Deploy with Render Blueprint

The repo includes a `docker/render.yaml` Blueprint that sets up both services automatically:

**1. Push to GitHub** (if not already)

**2. Deploy via Blueprint**
```
1. Go to https://render.com → New → Blueprint
2. Connect your GitHub repo
3. Point to docker/render.yaml
4. Render creates both services (n8n + latex) automatically
```

**3. Set environment variables** (Render Dashboard > your n8n service > Environment)

The Blueprint pre-configures most vars. You still need to add your API keys:
```env
OPENROUTER_API_KEY=sk-or-v1-your-key
TELEGRAM_BOT_TOKEN=123456789:your-token
FIRECRAWL_API_KEY=fc-your-key          # or SERPER/YOUCOM
```

The Blueprint auto-generates `N8N_ENCRYPTION_KEY` for you.

**4. Import the workflow**

Open your Render n8n URL > Workflows > Import from file > select each of `workflows/CareerForge_Master_local.json`, `CareerForge_ATS_Poller.json`, and `CareerForge_Registry_Seeder.json`.

**5. Set up UptimeRobot keep-alive**
```
1. Go to https://uptimerobot.com — sign up free
2. Add New Monitor:
   - Type: HTTP(s)
   - URL: https://your-app.onrender.com/healthz
   - Interval: Every 5 minutes
3. Save
```

UptimeRobot also emails you if your instance goes down — free monitoring.

Alternatively, use the included keep-alive script with an external cron:
```bash
# From any always-on machine (home server, another VPS, etc.)
*/5 * * * * /path/to/scripts/uptime_ping.sh https://your-app.onrender.com
```

**6. Activate the workflow** and test with `help` in Telegram.

### Limitations
- Cold starts can cause 20-30s delay even with UptimeRobot
- Not great for scheduled cron triggers — cold starts may miss the window
- 512MB RAM on free tier — tight but works for CareerForge

---

## Tier 2: Railway ($5/mo)

Reliable 24/7. Easiest setup. No cold starts, no ops headache.

### Deploy

**1. Sign up at** [railway.com](https://railway.com)

**2. Create project from GitHub**
```
New Project > Deploy from GitHub Repo > select your fork
```

Railway detects the `docker/railway.json` config and uses `docker/Dockerfile.render` to build.

**3. Add a PostgreSQL plugin**
```
Your project > + New > Database > PostgreSQL
```
Railway auto-injects the database connection vars.

**4. Set environment variables** (n8n service > Variables tab)
```env
N8N_ENCRYPTION_KEY=<run: openssl rand -hex 32>
WEBHOOK_URL=https://<your-railway-domain>.up.railway.app/
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=<your password>
OPENROUTER_API_KEY=<your key>
TELEGRAM_BOT_TOKEN=<your token>
```

**5. Generate a domain**
```
n8n service > Settings > Domains > Generate Domain
```

**6. Deploy** — Railway auto-builds and restarts.

**7. Import workflows** — open your Railway n8n URL, import each of `workflows/CareerForge_Master_local.json`, `CareerForge_ATS_Poller.json`, and `CareerForge_Registry_Seeder.json`, set credentials, activate.

### Notes
- Persistent PostgreSQL — no 30-day expiry
- Auto-deploys on `git push` if connected to GitHub
- $5/mo includes 8GB RAM, 8 vCPU — way more than you need
- Logs: Railway Dashboard > Deployments > latest > View Logs

---

## Tier 3: Hetzner VPS ($4.59/mo)

Full control. Cheapest paid option. Caddy for automatic HTTPS, systemd for process management, daily pg_dump backups.

### Create the server

```
Hetzner Cloud Console: https://console.hetzner.cloud
Plan: CX22 (2 vCPU, 4GB RAM) — $4.59/mo
Location: Ashburn, VA (or nearest to you)
OS: Ubuntu 22.04 LTS
Auth: SSH key (recommended)
```

### Install Docker

```bash
ssh root@YOUR_SERVER_IP

curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

### Clone and configure

```bash
git clone https://github.com/YOUR_USER/careerforge-n8n.git ~/careerforge
cd ~/careerforge/docker
cp .env.example .env
nano .env  # fill in your API keys
```

Add these VPS-specific vars to `.env`:
```env
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=postgres
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=n8n
DB_POSTGRESDB_USER=n8n
DB_POSTGRESDB_PASSWORD=CHANGE_ME_STRONG_PASSWORD
WEBHOOK_URL=https://n8n.yourdomain.com/
```

### Create VPS docker-compose

Create `~/careerforge/docker/docker-compose.vps.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${DB_POSTGRESDB_USER}
      POSTGRES_PASSWORD: ${DB_POSTGRESDB_PASSWORD}
      POSTGRES_DB: ${DB_POSTGRESDB_DATABASE}
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_POSTGRESDB_USER}"]
      interval: 10s
      timeout: 5s
      retries: 3

  n8n:
    image: n8nio/n8n:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:5678:5678"
    env_file: .env
    environment:
      - DB_TYPE=${DB_TYPE}
      - DB_POSTGRESDB_HOST=${DB_POSTGRESDB_HOST}
      - DB_POSTGRESDB_PORT=${DB_POSTGRESDB_PORT}
      - DB_POSTGRESDB_DATABASE=${DB_POSTGRESDB_DATABASE}
      - DB_POSTGRESDB_USER=${DB_POSTGRESDB_USER}
      - DB_POSTGRESDB_PASSWORD=${DB_POSTGRESDB_PASSWORD}
    volumes:
      - n8n_data:/home/node/.n8n
      - ../templates:/data/templates:ro
      - ../prompts:/data/prompts:ro
      - ../user-data:/data/user-data:ro
    depends_on:
      postgres:
        condition: service_healthy

  latex:
    build: ../services/latex
    restart: unless-stopped
    ports:
      - "127.0.0.1:5679:5679"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5679/health"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  pg_data:
  n8n_data:
```

### Start services

```bash
docker compose -f docker-compose.vps.yml up -d
```

### Install Caddy (automatic HTTPS)

Caddy handles TLS certificates automatically. No certbot, no renewal cron.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

Create `/etc/caddy/Caddyfile`:
```
n8n.yourdomain.com {
    reverse_proxy localhost:5678
}
```

```bash
sudo systemctl restart caddy
sudo systemctl enable caddy
```

That's it. Caddy auto-provisions a Let's Encrypt cert and auto-renews. No config files, no cron jobs.

### Point your domain

Add an A record: `n8n.yourdomain.com` -> `YOUR_SERVER_IP`

### systemd service for Docker Compose

Make CareerForge start on boot and restart on failure:

```bash
sudo tee /etc/systemd/system/careerforge.service > /dev/null << 'EOF'
[Unit]
Description=CareerForge n8n Stack
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/root/careerforge/docker
ExecStart=/usr/bin/docker compose -f docker-compose.vps.yml up -d
ExecStop=/usr/bin/docker compose -f docker-compose.vps.yml down

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable careerforge
```

### Daily database backups

```bash
sudo tee /etc/cron.daily/careerforge-backup > /dev/null << 'SCRIPT'
#!/bin/bash
BACKUP_DIR="/root/careerforge/backups"
mkdir -p "$BACKUP_DIR"
docker exec $(docker ps -qf "ancestor=postgres:16") \
  pg_dump -U n8n n8n | gzip > "$BACKUP_DIR/n8n_$(date +%Y%m%d).sql.gz"
# Keep last 14 days
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +14 -delete
SCRIPT
sudo chmod +x /etc/cron.daily/careerforge-backup
```

This runs daily via cron, keeps 14 days of compressed backups, and auto-prunes old ones.

### Import and activate

Open `https://n8n.yourdomain.com`, import each of `workflows/CareerForge_Master_local.json`, `CareerForge_ATS_Poller.json`, and `CareerForge_Registry_Seeder.json`, configure credentials, activate. You're live.

---

## Tier 4: n8n Cloud ($20/mo)

Zero ops. No Docker, no servers, no reverse proxies. You pay for convenience.

> **Compatibility note:** the current bot depends on a local Ollama instance (`bge-m3` embeddings) and a pgvector-enabled Postgres for hybrid job-cache search — n8n Cloud doesn't run custom sidecar containers, so this tier needs those adapted to external hosted equivalents (e.g. a hosted embeddings API + a pgvector-enabled managed Postgres) before it's a straight import-and-go. Not yet re-verified against the current architecture — treat this tier as needing a review pass, not copy-paste ready.

**1. Sign up at** [app.n8n.cloud](https://app.n8n.cloud) — 14-day free trial

**2. Import workflows** — Settings > Import > upload each of `workflows/CareerForge_Master_local.json`, `CareerForge_ATS_Poller.json`, and `CareerForge_Registry_Seeder.json`

**3. Add credentials:**
- OpenRouter: type "OpenAI-compatible", base URL `https://openrouter.ai/api/v1`, paste your API key
- Telegram: paste your bot token

**4. Activate** — toggle the workflow on. `apply`/`revise`/`score`/`intel`/`outreach`/`salary`/`track`/`status`/`setup_resume` and friends work at this point. `find_jobs` will run but its cache-first search lane won't — see the compatibility note above and "What you don't get" below.

### What you get
- 2500 executions/month (Starter plan)
- Managed Postgres, automatic backups
- Built-in HTTPS, no webhook setup needed
- n8n team handles updates and uptime

### What you don't get, out of the box
- **Local bge-m3 embeddings + pgvector hybrid job-cache search** — n8n Cloud's managed Postgres is not pgvector-enabled and there's no sidecar for Ollama. `find_jobs` degrades to web-search-only results (no cached/verified-active tier, no `🔓` badge) unless you wire in a hosted embeddings API and a separate pgvector-enabled Postgres (e.g. Neon, Supabase) yourself — not a supported preset, DIY.
- The background ATS poller (`CareerForge_ATS_Poller.json`) has nothing to write to without that pgvector Postgres, so it's not worth activating on this tier as-is.
- Volume mounts for templates/prompts — you'll edit prompts directly in the n8n UI
- Custom LaTeX service — you'd need to host that separately or use a cloud LaTeX API
- Shell access for debugging

---

## Post-Deploy Checklist

After any deployment method:

```
[ ] n8n UI accessible at your URL
[ ] Login works with your credentials
[ ] CareerForge_Master_local.json, CareerForge_ATS_Poller.json, and
    CareerForge_Registry_Seeder.json all imported and opened
[ ] Postgres reachable with the pgvector extension enabled, schema applied
[ ] Ollama reachable with bge-m3 pulled
[ ] Credentials configured:
    [ ] OpenRouter (OpenAI-compatible type, base URL: https://openrouter.ai/api/v1)
    [ ] Telegram bot token
    [ ] Postgres
[ ] At least one search provider key set (Firecrawl, Serper, or You.com) — see SETUP.md for which need a real n8n credential vs. a bare .env key
[ ] All three workflows toggled ACTIVE
[ ] Send "help" to your bot — it responds
[ ] Send "find <role> jobs" — the bot walks you through résumé setup on first use (no manual file placement needed)
[ ] Send "find ML engineer jobs" — job search works
[ ] Pick a job number — PDF generation works
```

---

## Backing Up

### SQLite (Tier 0, Tier 1)
```bash
# Copy the n8n data volume
docker cp $(docker ps -qf "name=n8n"):/home/node/.n8n ~/n8n-backup-$(date +%Y%m%d)
```

### Postgres (Tier 2, Tier 3)
```bash
docker exec $(docker ps -qf "ancestor=postgres:16") \
  pg_dump -U n8n n8n > n8n_backup_$(date +%Y%m%d).sql
```

### Workflow JSON (any tier)
Export from n8n UI: Workflows > your workflow > Download.

---

## Choosing a tier

- **Just testing?** Tier 0. Ten minutes to first PDF.
- **Job hunting but broke?** Tier 1. Free and always-on (mostly).
- **Want it to just work?** Tier 2. Five bucks, no drama.
- **Want full control?** Tier 3. Your server, your rules, daily backups.
- **Hate servers?** Tier 4. Pay n8n to deal with it.
