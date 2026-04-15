#!/usr/bin/env bash
# alert.sh — Send stuck alert to operator
set -euo pipefail

REASON="${1:-Iris message processing may be stuck}"
MSG="🚨 Iris watchdog alert: $REASON

Debug commands:
- Check runtime: sudo tail -50 /iris/iris-runtime.log
- Check service: sudo systemctl status iris
- Check logs: tail -20 /iris/data/D0AS2KC29MH/log.jsonl
- Restart: sudo systemctl restart iris"

# Send via Telegram if configured
TOKEN_FILE="/iris/data/.secrets/telegram-token"
CHAT_FILE="/iris/data/.secrets/telegram-chat-id"

if [[ -f "$TOKEN_FILE" && -f "$CHAT_FILE" ]]; then
  TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || echo "")
  CHAT_ID=$(cat "$CHAT_FILE" 2>/dev/null || echo "")
  if [[ -n "$TOKEN" && -n "$CHAT_ID" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -d "chat_id=${CHAT_ID}" \
      -d "text=${MSG}" \
      -d "parse_mode=Markdown" > /dev/null 2>&1 || true
    echo "[ALERT] Telegram notification sent"
  fi
fi

# Always log to syslog
logger -t iris-watchdog "ALERT: $REASON"
echo "[ALERT] $REASON"
