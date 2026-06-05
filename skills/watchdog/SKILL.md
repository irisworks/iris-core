---
name: watchdog
description: Monitor Iris message processing and alert if messages are stuck or not being processed.
---

# Skill: watchdog

Monitors `log.jsonl` for human messages that don't get bot responses. Alerts when Iris appears stuck.

## Usage

```bash
# Check current health (run manually)
iris-watchdog check

# Start monitoring daemon (creates periodic event)
iris-watchdog start

# Stop monitoring
iris-watchdog stop
```

## Implementation

Scripts are in: {baseDir}/

### check.sh — Verify message processing health

```bash
#!/usr/bin/env bash
# check.sh — Detect if Iris is processing messages
set -euo pipefail

LOG_FILE="/iris/data/${OWNER_CHANNEL_ID}/log.jsonl"
RUNTIME_LOG="/iris/iris-runtime.log"
ALERT_THRESHOLD_MINUTES=2

# Get recent human messages (non-bot, last N minutes)
CUTOFF_TIME=$(date -u -d "-${ALERT_THRESHOLD_MINUTES} minutes" +%s)
RECENT_MSGS=$(jq -r --argjson cutoff "$CUTOFF_TIME" '
  select(.isBot == false and (.date | fromdateiso8601) >= $cutoff)
  | {ts: .ts, text: .text, date: .date}
' "$LOG_FILE" 2>/dev/null || echo "")

if [[ -z "$RECENT_MSGS" ]]; then
  echo "[HEALTHY] No recent messages to check"
  exit 0
fi

# For each recent human message, check if there's a bot response after it
STUCK_COUNT=0
while IFS= read -r msg; do
  MSG_TS=$(echo "$msg" | jq -r '.ts')
  MSG_TEXT=$(echo "$msg" | jq -r '.text')
  
  # Check for bot response with same or later timestamp
  HAS_RESPONSE=$(jq -r --arg ts "$MSG_TS" '
    select(.isBot == true and .ts >= $ts) | .ts
  ' "$LOG_FILE" | head -1)
  
  if [[ -z "$HAS_RESPONSE" ]]; then
    echo "[STUCK] Message '$MSG_TEXT' (ts: $MSG_TS) has no response"
    ((STUCK_COUNT++))
  fi
done <<< "$RECENT_MSGS"

if [[ $STUCK_COUNT -gt 0 ]]; then
  echo "[ALERT] $STUCK_COUNT messages unprocessed - Iris may be stuck"
  exit 1
else
  echo "[HEALTHY] All messages processed"
  exit 0
fi
```

### alert.sh — Send alert via email/Telegram

```bash
#!/usr/bin/env bash
# alert.sh — Send stuck alert to operator
set -euo pipefail

MSG="🚨 Iris watchdog alert: Messages are not being processed. Last activity may be stuck. Check logs with: sudo tail -f /iris/iris-runtime.log"

# Send via Telegram if configured
if [[ -f /iris/data/skills/telegram/bot.js ]]; then
  TOKEN=$(cat /iris/data/.secrets/telegram-token 2>/dev/null || echo "")
  CHAT_ID=$(cat /iris/data/.secrets/telegram-chat-id 2>/dev/null || echo "")
  if [[ -n "$TOKEN" && -n "$CHAT_ID" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" \
      -d "text=${MSG}" > /dev/null
  fi
fi

# Log alert
logger -t iris-watchdog "ALERT: Iris message processing stuck"
```

## Notes

- Checks last 2 minutes of messages by default
- Compares human message timestamps to bot response timestamps
- Alerts via Telegram if configured, always logs to syslog
- Run via periodic event every 2 minutes for continuous monitoring
