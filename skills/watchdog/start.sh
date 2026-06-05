#!/usr/bin/env bash
# start.sh — Create periodic watchdog event
set -euo pipefail

CHANNEL_ID="${OWNER_CHANNEL_ID:-${IRIS_ALERT_CHANNEL:-}}"
if [[ -z "$CHANNEL_ID" ]]; then
  echo "ERROR: OWNER_CHANNEL_ID (or IRIS_ALERT_CHANNEL) must be set" >&2
  exit 1
fi

event_file="/iris/data/events/watchdog-check-$(date +%s).json"

cat > "$event_file" << EOF
{"type": "periodic", "channelId": "${CHANNEL_ID}", "text": "run-watchdog-check", "schedule": "*/5 * * * *", "timezone": "UTC"}
EOF

echo "Watchdog monitoring started (checking every 5 minutes)"
