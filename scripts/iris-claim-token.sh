#!/usr/bin/env bash
# Recovery command: generate a fresh Telegram claim token when the user misses
# the 10-minute bootstrap window.
#
# Usage:
#   iris-claim-token              # uses the first registered bot
#   iris-claim-token <botId>      # targets a specific bot by its Telegram bot ID
#
# The script calls the Iris internal API, which resets the current claim state
# and issues a new 10-minute token. Send the token to your Telegram bot to claim it.

set -euo pipefail

IRIS_API_PORT="${IRIS_API_PORT:-3000}"
BOT_ID="${1:-}"
TOKEN_FILE="/iris/data/claim-token.txt"

payload="{}"
if [[ -n "$BOT_ID" ]]; then
  payload="{\"botId\":\"${BOT_ID}\"}"
fi

response=$(curl -sf -X POST \
  -H "Content-Type: application/json" \
  -d "$payload" \
  "http://localhost:${IRIS_API_PORT}/internal/claim-token" 2>&1) || {
  echo ""
  echo "  ERROR: Could not reach Iris API on port ${IRIS_API_PORT}."
  echo "  Make sure iris.service is running:  systemctl status iris"
  echo ""
  exit 1
}

token=$(echo "$response" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

if [[ -z "$token" ]]; then
  echo ""
  echo "  ERROR: Unexpected response from API:"
  echo "  $response"
  echo ""
  exit 1
fi

echo ""
echo "  ┌─ Telegram Claim Token ──────────────────────────────────────────┐"
echo "  │                                                                 │"
echo "  │  Send this token to your bot on Telegram to claim it:          │"
echo "  │                                                                 │"
echo "  │  ${token}  │"
echo "  │                                                                 │"
echo "  │  Token expires in 10 minutes.                                  │"
echo "  └─────────────────────────────────────────────────────────────────┘"
echo ""
