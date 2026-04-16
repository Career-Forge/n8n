# CareerForge Deployment Guide

This guide covers every way to run CareerForge 24/7. Start with **Option 0 (ngrok)** to test locally, then graduate to a cloud option when you're ready to go live.

---

## Option 0: Local Dev with ngrok ← **YOU ARE HERE**

Keep your Docker stack running locally, expose it to the internet via ngrok's free static domain. Works as long as your laptop is on.

### Prerequisites
- Docker Desktop running
- ngrok account at [ngrok.com](https://ngrok.com) (free)
- Your n8n stack already up via `docker compose up -d`

> **Your static domain is already assigned** — every free ngrok account gets one `*.ngrok-free.app` domain automatically. No browser UI needed for any of the steps below.

---

### 🪟 Windows (PowerShell)

**1. Install ngrok via winget (one-time)**
```powershell
winget install ngrok.ngrok
# Restart terminal after install, then verify:
ngrok version
```

**2. Authenticate ngrok with your token (one-time)**
Get your authtoken from [dashboard.ngrok.com → Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken):
```powershell
ngrok config add-authtoken YOUR_AUTHTOKEN_HERE
```

**3. Get your free static domain via PowerShell API call (one-time)**
> Your free account already has a static `*.ngrok-free.app` domain auto-assigned. Retrieve it:
```powershell
# Get your ngrok API key from: https://dashboard.ngrok.com/api-keys
$apiKey = "YOUR_NGROK_API_KEY"
$headers = @{
    "Authorization" = "Bearer $apiKey"
    "Ngrok-Version" = "2"
}
$domains = Invoke-RestMethod -Uri "https://api.ngrok.com/reserved_domains" -Headers $headers
$domains.reserved_domains | Select-Object domain, region
# Output: crazy-fox-1234.ngrok-free.app  ← copy this
```

**4. Set the domain in your `.env` file**
```powershell
# Edit .env in your project directory
$ngrokDomain = "crazy-fox-1234.ngrok-free.app"   # your domain from step 3
$envPath = ".env"
(Get-Content $envPath) -replace 'WEBHOOK_URL=.*', "WEBHOOK_URL=https://$ngrokDomain/" |
    Set-Content $envPath
(Get-Content $envPath) -replace 'N8N_HOST=.*', "N8N_HOST=$ngrokDomain" |
    Set-Content $envPath
```

**5. Restart Docker and start the tunnel**
```powershell
docker compose down
docker compose up -d
# Wait ~10 seconds for n8n to boot, then:
ngrok http --domain=crazy-fox-1234.ngrok-free.app 5678
```
Leave this PowerShell window open. ngrok forwards `https://crazy-fox-1234.ngrok-free.app` → `localhost:5678`.

**6. Optional: Auto-start ngrok on Windows boot**
```powershell
# Create a scheduled task that starts ngrok on login
$action = New-ScheduledTaskAction -Execute 'ngrok' `
    -Argument 'http --domain=crazy-fox-1234.ngrok-free.app 5678'
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'CareerForge-ngrok' `
    -Action $action -Trigger $trigger -RunLevel Highest -Force
```
Now ngrok auto-starts every time you log in to Windows — no manual step needed!

**7. Verify Telegram webhook is active**
```powershell
# Confirm Telegram can reach your n8n
$botToken = "YOUR_BOT_TOKEN"
Invoke-RestMethod "https://api.telegram.org/bot$botToken/getWebhookInfo" |
    Select-Object -ExpandProperty result | Select-Object url, last_error_message
# Should show: url = https://crazy-fox-1234.ngrok-free.app/webhook/...
```

**8. Test**
Send `/jobs` to your Telegram bot — it should trigger within 1-2 seconds.

### Gotchas (all platforms)
- **Machine must stay on** — if it sleeps/shuts down, the tunnel dies and Telegram messages queue up
- **Static domain persists** across restarts — you never need to re-register the webhook with Telegram
- **ngrok free tier**: 1 static domain, unlimited bandwidth for personal use

---

### 🍎 macOS (bash / zsh)

**1. Install ngrok via Homebrew (one-time)**
```bash
brew install ngrok/ngrok/ngrok
# Verify:
ngrok version
```

**2. Authenticate (one-time)**
```bash
ngrok config add-authtoken YOUR_AUTHTOKEN_HERE
```

**3. Get your static domain (one-time)**
```bash
# Get your API key from https://dashboard.ngrok.com/api-keys
NGROK_API_KEY="YOUR_NGROK_API_KEY"
curl -s -H "Authorization: Bearer $NGROK_API_KEY" \
     -H "Ngrok-Version: 2" \
     https://api.ngrok.com/reserved_domains \
  | python3 -c "import sys,json; d=json.load(sys.stdin); [print(x['domain']) for x in d['reserved_domains']]"
# Output: crazy-fox-1234.ngrok-free.app  ← copy this
```

**4. Patch your `.env` file**
```bash
NGROK_DOMAIN="crazy-fox-1234.ngrok-free.app"   # from step 3
sed -i '' "s|WEBHOOK_URL=.*|WEBHOOK_URL=https://$NGROK_DOMAIN/|" .env
sed -i '' "s|N8N_HOST=.*|N8N_HOST=$NGROK_DOMAIN|" .env
```

**5. Restart Docker and start the tunnel**
```bash
docker compose down && docker compose up -d
# Wait ~10 seconds, then:
ngrok http --domain=crazy-fox-1234.ngrok-free.app 5678
```

**6. Optional: Auto-start ngrok on Mac login (launchd)**
```bash
# Create a launchd plist
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
# ngrok now auto-starts on every macOS login
```

**7. Verify Telegram webhook**
```bash
BOT_TOKEN="YOUR_BOT_TOKEN"
curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -m json.tool | grep url
# Should show: "url": "https://crazy-fox-1234.ngrok-free.app/webhook/..."
```

---

### 🐧 Linux (bash — Ubuntu/Debian/Fedora/Arch)

**1. Install ngrok (one-time)**

```bash
# Ubuntu / Debian
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" \
  | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install ngrok

# Fedora / RHEL
sudo snap install ngrok        # OR download binary:
# curl -Lo ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-stable-linux-amd64.zip
# unzip ngrok.zip && sudo mv ngrok /usr/local/bin/

# Arch Linux
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
# Output: crazy-fox-1234.ngrok-free.app
```

**4. Patch your `.env` file**
```bash
NGROK_DOMAIN="crazy-fox-1234.ngrok-free.app"
sed -i "s|WEBHOOK_URL=.*|WEBHOOK_URL=https://$NGROK_DOMAIN/|" .env
sed -i "s|N8N_HOST=.*|N8N_HOST=$NGROK_DOMAIN|" .env
```
> Note: Linux `sed -i` has no extra argument (unlike macOS `sed -i ''`)

**5. Restart Docker and start the tunnel**
```bash
docker compose down && docker compose up -d
sleep 10
ngrok http --domain=crazy-fox-1234.ngrok-free.app 5678
```

**6. Optional: Auto-start ngrok on Linux boot (systemd)**
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
# Check status:
sudo systemctl status careerforge-ngrok
```
ngrok now auto-starts on every boot and auto-restarts if it crashes.

**7. Verify Telegram webhook**
```bash
BOT_TOKEN="YOUR_BOT_TOKEN"
curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -m json.tool | grep url
```

---


## Option 1: Render (Free) + UptimeRobot Keep-Alive

**Best for:** Zero-cost testing that works even when laptop is off. Not production-grade but good enough for job hunting.

> ⚠️ Render free tier spins down after 15 min inactivity. UptimeRobot pings it every 5 min to keep it awake.

### Step-by-Step

**1. Push your repo to GitHub** (if not already)

**2. Deploy on Render**
```
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Runtime: Docker
4. Instance Type: Free
```

**3. Add a PostgreSQL database**
```
Render Dashboard → New → PostgreSQL → Free tier
Copy the "Internal Database URL"
```

**4. Set Environment Variables** (Render → your service → Environment)
```env
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=<from Render Postgres internal URL>
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=n8n
DB_POSTGRESDB_USER=<from Render Postgres>
DB_POSTGRESDB_PASSWORD=<from Render Postgres>
N8N_ENCRYPTION_KEY=<run: openssl rand -hex 32>
WEBHOOK_URL=https://your-app.onrender.com/
N8N_HOST=your-app.onrender.com
N8N_PROTOCOL=https
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=<your password>
OPENROUTER_API_KEY=<your key>
```

**5. Deploy → wait ~3 min for first build**

**6. Set up UptimeRobot keep-alive**
```
1. Go to https://uptimerobot.com → Sign up free
2. Add New Monitor:
   - Type: HTTP(s)
   - URL: https://your-app.onrender.com/healthz
   - Interval: Every 5 minutes
3. Save
```
UptimeRobot also emails you if your instance goes down — free monitoring!

**7. Register Telegram webhook**
```
Visit this URL in your browser (replace values):
https://api.telegram.org/bot{YOUR_BOT_TOKEN}/setWebhook?url=https://your-app.onrender.com/webhook/{N8N_WEBHOOK_ID}
```
Get `N8N_WEBHOOK_ID` from the Telegram Trigger node URL in n8n.

### Auto-Backup: Postgres → Google Drive (Before Day 30 Expiry)

Rather than panicking on day 30, set up an **n8n workflow** that automatically exports and uploads your database to Google Drive on day 29. You get an alert, and recovery is just a Drive download.

**How it works:**
1. A `pg_dump` SQL export runs inside the Postgres container
2. n8n reads the dump file via an Execute Command node
3. Google Drive node uploads it to `CareerForge/Backups/n8n_backup_YYYYMMDD.sql`
4. Telegram notifies you: "⚠️ Render DB expires tomorrow. Backup saved to Drive."

**Create this n8n workflow on Render:**
```
Schedule Trigger (cron: 0 9 28 * *)   ← Day 28 of every month at 9am
    ↓
Execute Command node:
  Command: docker exec postgres pg_dump -U n8n n8n > /tmp/n8n_backup.sql && cat /tmp/n8n_backup.sql
    ↓
Code node (format as file):
  const sqlContent = $input.first().json.stdout;
  return [{ binary: { backup: { data: Buffer.from(sqlContent).toString('base64'),
    mimeType: 'application/sql',
    fileName: `n8n_backup_${new Date().toISOString().slice(0,10)}.sql` } } }];
    ↓
Google Drive node:
  Operation: Upload File
  Folder: CareerForge/Backups/
  Binary Property: backup
    ↓
Telegram node:
  "⚠️ Render DB expires in ~2 days. Backup saved:\nCareerForge/Backups/n8n_backup_[date].sql\nCreate a new Render Postgres and restore with: psql -U n8n n8n < backup.sql"
```

**To restore on a fresh Render Postgres:**
```powershell
# Download backup from Google Drive, then:
# Copy to your Render Postgres container
$backupFile = "n8n_backup_2026-04-15.sql"
# In your Render shell (via Dashboard → Shell):
psql -U n8n -d n8n < $backupFile
```

> This means Render's 30-day limit becomes a minor inconvenience, not a disaster. Your workflows, credentials, and execution history are always safe in Drive.

### Other Limitations
- Cold starts can cause 20-30s delay even with UptimeRobot
- **Not recommended for scheduled scans** — cold starts may miss the cron trigger window

---

## Option 2: Railway ($5/mo Hobby) ← **Best Balance**

**Best for:** Reliable 24/7, easiest setup, no ops headache.

> ✅ GitHub Education pack check: Railway is NOT in the GitHub Student Pack (as of 2026). But at $5/mo it's the cheapest reliable option.

### Step-by-Step

**1. Sign up at** [railway.com](https://railway.com)

**2. Deploy n8n template**
```
New Project → Deploy a Template → search "n8n" → 
Select the n8n + PostgreSQL template → Deploy Now
```
Railway auto-provisions n8n + PostgreSQL in ~2 minutes.

**3. Configure Variables** (n8n service → Variables tab)
```env
N8N_ENCRYPTION_KEY=<run: openssl rand -hex 32>
WEBHOOK_URL=https://<your-railway-domain>.up.railway.app/
N8N_HOST=<your-railway-domain>.up.railway.app
N8N_PROTOCOL=https
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=<your password>
OPENROUTER_API_KEY=<your key>
```
Railway auto-sets the Postgres DB vars from the linked database.

**4. Add your custom domain (optional)**
```
n8n service → Settings → Domains → Generate Domain
OR add your own domain with a CNAME record
```

**5. Redeploy** → Railway restarts with new vars automatically

**6. Import workflows**
Open `https://<your-domain>.up.railway.app` → Settings → Import workflow → upload `CareerForge_Master.json`

**7. Activate** — toggle the workflow on → Telegram bot is now live 24/7 ✅

### Notes
- Persistent PostgreSQL — no expiry like Render
- Auto-deploys on git push if connected to GitHub
- Logs: Railway Dashboard → Deployments → click latest → View Logs

---

## Option 3: DigitalOcean Droplet ($4–6/mo) ← **GitHub Education: $200 FREE**

**Best for:** Students with GitHub Education pack. $200 credit = ~2.5 years of free hosting on the cheapest droplet!

> ✅ **GitHub Education:** Go to [education.github.com/pack](https://education.github.com/pack) → claim DigitalOcean $200 credit. Valid for 1 year, requires credit card for verification (won't be charged within credits).

### Step-by-Step

**1. Create Droplet**
```
DigitalOcean Dashboard → Create → Droplets
OS: Ubuntu 22.04 LTS
Plan: Basic → Regular → $6/mo (1 vCPU, 1GB RAM)  ← minimum for n8n + Postgres
Region: NYC3 (closest to Jersey City!)
Auth: SSH Key (recommended) or Password
```

**2. SSH into your droplet**
```bash
ssh root@YOUR_DROPLET_IP
```

**3. Install Docker**
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker
```

**4. Create project directory**
```bash
mkdir ~/careerforge && cd ~/careerforge
```

**5. Create `.env`**
```bash
nano .env
```
```env
POSTGRES_USER=n8n
POSTGRES_PASSWORD=CHANGE_ME_STRONG_PASSWORD
POSTGRES_DB=n8n
N8N_HOST=n8n.yourdomain.com
N8N_PROTOCOL=https
N8N_ENCRYPTION_KEY=CHANGE_ME_RUN_openssl_rand_hex_32
N8N_BASIC_AUTH_ACTIVE=true
N8N_BASIC_AUTH_USER=admin
N8N_BASIC_AUTH_PASSWORD=CHANGE_ME
OPENROUTER_API_KEY=YOUR_KEY
WEBHOOK_URL=https://n8n.yourdomain.com/
```

**6. Create `docker-compose.yml`**
```bash
nano docker-compose.yml
```
```yaml
services:
  postgres:
    image: postgres:15
    restart: always
    env_file: .env
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - db_data:/var/lib/postgresql/data

  n8n:
    image: n8nio/n8n:latest
    restart: always
    ports:
      - "127.0.0.1:5678:5678"
    env_file: .env
    environment:
      - DB_TYPE=postgresdb
      - DB_POSTGRESDB_HOST=postgres
      - DB_POSTGRESDB_PORT=5432
      - DB_POSTGRESDB_DATABASE=${POSTGRES_DB}
      - DB_POSTGRESDB_USER=${POSTGRES_USER}
      - DB_POSTGRESDB_PASSWORD=${POSTGRES_PASSWORD}
      - N8N_HOST=${N8N_HOST}
      - N8N_PROTOCOL=${N8N_PROTOCOL}
      - WEBHOOK_URL=${WEBHOOK_URL}
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
      - N8N_BASIC_AUTH_ACTIVE=${N8N_BASIC_AUTH_ACTIVE}
      - N8N_BASIC_AUTH_USER=${N8N_BASIC_AUTH_USER}
      - N8N_BASIC_AUTH_PASSWORD=${N8N_BASIC_AUTH_PASSWORD}
    volumes:
      - n8n_data:/home/node/.n8n
    depends_on:
      - postgres

  latex-service:
    image: YOUR_LATEX_SERVICE_IMAGE   # or build from Dockerfile
    restart: always
    ports:
      - "127.0.0.1:5679:5679"

volumes:
  db_data:
  n8n_data:
```

**7. Start services**
```bash
docker compose up -d
```

**8. Install Nginx + HTTPS**
```bash
sudo apt update && sudo apt install nginx certbot python3-certbot-nginx -y

sudo nano /etc/nginx/sites-available/n8n
```
Paste:
```nginx
server {
    listen 80;
    server_name n8n.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:5678;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Upgrade $http_upgrade;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/n8n /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
sudo certbot --nginx -d n8n.yourdomain.com
```
Certbot auto-renews SSL — HTTPS is now live ✅

**9. Point your domain**
Add an A record: `n8n.yourdomain.com → YOUR_DROPLET_IP`

**10. Open n8n, import workflow, activate** → 24/7 live 🚀

---

## Option 4: Hetzner VPS (€3.79/mo) ← **Cheapest Paid Option**

Identical to Option 3 (DigitalOcean) — just cheaper. Not in GitHub Education pack but nearly half the price.

```
Hetzner Cloud: https://console.hetzner.cloud
Plan: CX22 (2 vCPU, 4GB RAM) = €3.79/mo  ← overkill but great headroom
Location: Ashburn, VA (closest US datacenter)
OS: Ubuntu 22.04
```
Then follow **all steps from Option 3** from Step 2 onwards. Identical process.

---

## Option 5: n8n Cloud ($20/mo) ← **Zero Ops**

If you never want to touch a server:
```
1. Go to https://app.n8n.cloud → Start free trial
2. Import CareerForge_Master.json
3. Add credentials (OpenRouter, Google, Telegram)
4. Activate → done
```
No Docker, no nginx, no certbot. But at $20/mo it's 4–5x more expensive than VPS options.

---

## Post-Deploy Checklist (All Options)

After any deployment:
```
□ n8n UI accessible at your domain/URL
□ Login works with your admin credentials
□ CareerForge_Master.json imported
□ All credentials configured:
  □ Telegram bot token
  □ OpenRouter API key  
  □ Google Cloud Service Account (Sheets + Drive)
□ Telegram Trigger workflow is ACTIVE
□ Send /start to your bot → it responds
□ Send /jobs → pipeline triggers
□ Check Google Sheet → row appears
□ Check Google Drive → PDF uploaded
```

---

## Backing Up Your Workflows

Run this on any server deployment to backup n8n data:
```bash
# Backup n8n workflows + credentials (encrypted)
docker cp n8n:/home/node/.n8n ~/n8n-backup-$(date +%Y%m%d)
```
Or export individual workflows from n8n UI → Settings → Export.
