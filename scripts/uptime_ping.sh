#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# uptime_ping.sh — Keep-alive for Render free tier
# Usage:  ./scripts/uptime_ping.sh https://your-app.onrender.com
# Cron:   */5 * * * * /path/to/uptime_ping.sh https://your-app.onrender.com
# ═══════════════════════════════════════════════════════════════

URL="${1:?Usage: $0 <base-url>}"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 "${URL}/healthz")

if [ "$STATUS" = "200" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK ${URL}/healthz"
else
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) FAIL status=${STATUS} ${URL}/healthz" >&2
  exit 1
fi
