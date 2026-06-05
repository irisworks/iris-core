#!/usr/bin/env bash
# check.sh — Detect if Iris is processing messages
set -uo pipefail

CHANNEL_ID="${OWNER_CHANNEL_ID:-${IRIS_ALERT_CHANNEL:-}}"
if [[ -z "$CHANNEL_ID" ]]; then
  echo "[ERROR] OWNER_CHANNEL_ID (or IRIS_ALERT_CHANNEL) must be set" >&2
  exit 1
fi
LOG_FILE="/iris/data/${CHANNEL_ID}/log.jsonl"
ALERT_THRESHOLD_MINUTES=2

# Check if log file exists
if [[ ! -f "$LOG_FILE" ]]; then
  echo "[ERROR] Log file not found: $LOG_FILE"
  exit 1
fi

# Get current timestamp and cutoff
NOW_TS=$(date +%s)
CUTOFF_TS=$((NOW_TS - ALERT_THRESHOLD_MINUTES * 60))

# Function to safely parse ISO8601 date to epoch
parse_date() {
  local date_str="$1"
  # Remove fractional seconds for compatibility
  date_str=$(echo "$date_str" | sed 's/\.[0-9]*Z$/Z/')
  date -d "$date_str" +%s 2>/dev/null || echo "0"
}

# Use temp file for counters
TMPFILE=$(mktemp)
echo "0" > "$TMPFILE.stuck"
echo "0" > "$TMPFILE.checked"

# Read last 20 lines to avoid incomplete writes at end of file
tail -20 "$LOG_FILE" 2>/dev/null | while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  
  # Skip if not valid JSON
  echo "$line" | jq -e '.' >/dev/null 2>&1 || continue
  
  # Check if it's a bot message
  IS_BOT=$(echo "$line" | jq -r '.isBot // false')
  [[ "$IS_BOT" == "true" ]] && continue
  
  # Get message timestamp (from date field, convert to epoch)
  MSG_DATE=$(echo "$line" | jq -r '.date // empty')
  [[ -z "$MSG_DATE" ]] && continue
  
  MSG_TS_EPOCH=$(parse_date "$MSG_DATE")
  [[ "$MSG_TS_EPOCH" -lt "$CUTOFF_TS" ]] && continue
  
  MSG_SLACK_TS=$(echo "$line" | jq -r '.ts // empty')
  
  # Increment checked counter
  CHECKED=$(cat "$TMPFILE.checked")
  echo $((CHECKED + 1)) > "$TMPFILE.checked"
  
  # Check for bot response with same or later timestamp
  HAS_RESPONSE=$(jq -r --arg ts "$MSG_SLACK_TS" 'select(.isBot == true and .ts >= $ts) | .ts' "$LOG_FILE" 2>/dev/null | head -1)
  
  if [[ -z "$HAS_RESPONSE" ]]; then
    STUCK=$(cat "$TMPFILE.stuck")
    echo $((STUCK + 1)) > "$TMPFILE.stuck"
    MSG_TEXT=$(echo "$line" | jq -r '.text // empty' | cut -c1-50)
    echo "[STUCK] Message '$MSG_TEXT' (ts: $MSG_SLACK_TS)"
  fi
done

STUCK_COUNT=$(cat "$TMPFILE.stuck")
CHECKED_COUNT=$(cat "$TMPFILE.checked")
rm -f "$TMPFILE" "$TMPFILE.stuck" "$TMPFILE.checked"

if [[ "$STUCK_COUNT" -gt 0 ]]; then
  echo "[ALERT] $STUCK_COUNT/$CHECKED_COUNT recent messages unprocessed"
  exit 1
elif [[ "$CHECKED_COUNT" -gt 0 ]]; then
  echo "[HEALTHY] $CHECKED_COUNT messages, all processed"
  exit 0
else
  echo "[HEALTHY] No human messages in last ${ALERT_THRESHOLD_MINUTES}m"
  exit 0
fi
