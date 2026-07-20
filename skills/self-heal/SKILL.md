---
name: self-heal
description: Sub-agent self-diagnostic and escalation. Run when a sub-agent detects a failure it cannot recover from, to escalate to Iris or the human operator.
---

# Skill: self-heal

Self-diagnostic and escalation skill for sub-agents.

When a sub-agent encounters a failure it cannot recover from (persistent errors, missing dependencies,
model failures, resource exhaustion), it should call this skill to:

1. Log a structured diagnostic event to Iris's event queue
2. Optionally send an email to the human operator
3. Optionally restart the current service

Iris monitors the event queue and will receive the escalation.

## Usage

```bash
# Escalate to Iris (writes event to Iris's events dir)
self-heal --reason "Weather API returning 503 for 10 minutes" --agent weather

# Escalate + email human
self-heal --reason "Model provider unreachable" --agent digest --email operator@example.com

# Escalate + attempt service restart
self-heal --reason "Memory leak detected" --agent weather --restart

# Full escalation path
self-heal \
  --reason "Cannot connect to weather API after 5 retries" \
  --agent weather \
  --email operator@example.com \
  --context "Last successful response: 2 hours ago. Error: ECONNREFUSED 142.250.80.35:443"
```

## Options

- `--reason`   Human-readable description of the failure (required)
- `--agent`    Name of the failing agent (default: value of `$AGENT_NAME` env var)
- `--email`    If set, also send an alert email to this address
- `--restart`  If set, attempt to restart the current agent's systemd service
- `--context`  Additional diagnostic context (appended to the escalation event)
- `--severity` `warning` | `error` | `critical` (default: `error`)

## Escalation path

Two-path escalation (primary → fallback):

1. **HTTP API** (primary): `POST ${IRIS_API_URL}/escalate` — Iris's internal API running on port 3000,
   reachable from Docker containers at `http://iris-host:3000` or `http://172.18.0.1:3000`.
   Fast, reliable, returns acknowledgment.

2. **File queue** (fallback): Writes `ESCALATE-{agent}` event file to `$IRIS_EVENTS_DIR` on the
   shared filesystem. Used when the API is unreachable (network partition, Iris restart).

Both paths produce the same result: an `ESCALATE-{agentname}` immediate event in Iris's queue.

## What happens after escalation

Iris receives the escalation event in her event queue. Based on severity:

- `warning`: Iris logs it and monitors
- `error`: Iris attempts to diagnose and fix (e.g., restart container, check API keys)
- `critical`: Iris pages the human operator via Telegram + email

## Implementation

```bash
#!/usr/bin/env bash
set -euo pipefail

REASON=""
AGENT="${AGENT_NAME:-unknown}"
EMAIL=""
RESTART=false
CONTEXT=""
SEVERITY="error"
IRIS_EVENTS_DIR="${IRIS_EVENTS_DIR:-/iris/data/events}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reason)   REASON="$2";   shift 2 ;;
    --agent)    AGENT="$2";    shift 2 ;;
    --email)    EMAIL="$2";    shift 2 ;;
    --restart)  RESTART=true;  shift ;;
    --context)  CONTEXT="$2";  shift 2 ;;
    --severity) SEVERITY="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$REASON" ]] && { echo "self-heal: --reason is required" >&2; exit 1; }

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EVENT_ID="selfheal-$(date +%s)-$(head -c4 /dev/urandom | xxd -p)"

# Write escalation event to Iris's event queue
EVENT_FILE="${IRIS_EVENTS_DIR}/${EVENT_ID}.json"
jq -n \
  --arg type "immediate" \
  --arg channelId "SELFHEAL-${AGENT}" \
  --arg user "$AGENT" \
  --arg reason "$REASON" \
  --arg context "$CONTEXT" \
  --arg severity "$SEVERITY" \
  --arg timestamp "$TIMESTAMP" \
  --arg agent "$AGENT" \
  '{
    type: $type,
    channelId: $channelId,
    user: $user,
    text: ("🚨 Self-heal escalation from @" + $agent + " [" + $severity + "]: " + $reason + (if $context != "" then "\n\nContext: " + $context else "" end)),
    meta: { severity: $severity, agent: $agent, reason: $reason, context: $context, timestamp: $timestamp }
  }' > "$EVENT_FILE"

echo "[self-heal] Escalation event written: $EVENT_FILE"

# Send email if requested
if [[ -n "$EMAIL" ]]; then
  SUBJECT="[Iris] Sub-agent ${AGENT} escalation: ${SEVERITY}"
  BODY="Agent: ${AGENT}
Severity: ${SEVERITY}
Time: ${TIMESTAMP}
Reason: ${REASON}"
  if [[ -n "$CONTEXT" ]]; then
    BODY="${BODY}

Context:
${CONTEXT}"
  fi
  send-email --to "$EMAIL" --subject "$SUBJECT" --body "$BODY" \
    && echo "[self-heal] Alert email sent to $EMAIL" \
    || echo "[self-heal] Warning: email send failed" >&2
fi

# Restart service if requested
if [[ "$RESTART" == "true" ]]; then
  SERVICE="${AGENT}.service"
  echo "[self-heal] Attempting to restart ${SERVICE}..."
  systemctl restart "$SERVICE" 2>&1 \
    && echo "[self-heal] Service ${SERVICE} restarted" \
    || echo "[self-heal] Warning: could not restart ${SERVICE}" >&2
fi

echo "[self-heal] Done. Iris will receive the escalation event."
```

## Notes

- `IRIS_EVENTS_DIR` must be set or defaults to `/iris/data/events`
- For Docker sub-agents, mount the shared events dir: `-v /iris/data/events:/iris/data/events`
- The Terraform agent module sets `IRIS_EVENTS_DIR` automatically
- `--restart` requires the service to be managed by systemd on the host (works for host-mode agents)
- Event type `immediate` ensures Iris processes it right away, not on a schedule

## Iris-side handling

Iris receives `SELFHEAL-{agentname}` channel events. Her system prompt includes:
> When you receive a SELFHEAL event, diagnose the issue, attempt recovery, and if unable to fix,
> escalate to the human operator via Telegram or email.
