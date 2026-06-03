#!/bin/bash
# hi-agent: says hi after every 20 seconds for 1 minute

CHANNEL="tg-8814933356"
INTERVAL=20
COUNT=3

for i in $(seq 1 $COUNT); do
  sleep "$INTERVAL"
  EVENT_FILE="/iris/data/events/hi-$(date +%s%N).json"
  cat > "$EVENT_FILE" <<EOF
{"type": "immediate", "channelId": "$CHANNEL", "text": "hi"}
EOF
done
