#!/usr/bin/env bash
# start.sh — Create periodic watchdog event
set -euo pipefail

event_file="/iris/data/events/watchdog-check-$(date +%s).json"

cat > "$event_file" << 'EOF'
{"type": "periodic", "channelId": "D0AS2KC29MH", "text": "run-watchdog-check", "schedule": "*/5 * * * *", "timezone": "UTC"}
EOF

echo "Watchdog monitoring started (checking every 5 minutes)"
