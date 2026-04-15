---
name: send-email
description: Send an email via Resend API from ${IRIS_EMAIL_FROM:-iris@example.com}. Use when human escalation is needed or to deliver results outside Slack/Telegram.
---

# Skill: send-email

Send an email from `${IRIS_EMAIL_FROM:-iris@example.com}` using the Resend API.
Available to Iris and all sub-agents. Use when you need to reach a human outside the chat interface
(escalation, reports, alerts) or when asked to send an email.

## Usage

```
send-email --to <address> --subject "<subject>" --body "<plain text body>"
```

Or pipe the body:

```
echo "body text" | send-email --to <address> --subject "<subject>"
```

## Options

- `--to`      Recipient email address (required)
- `--subject` Email subject line (required)
- `--body`    Email body as plain text. If omitted, reads from stdin.
- `--html`    Optional HTML body (if set, overrides plain-text rendering)
- `--from`    Override sender (default: `Iris <${IRIS_EMAIL_FROM:-iris@example.com}>`)

## Implementation

```bash
#!/usr/bin/env bash
set -euo pipefail

TO=""
SUBJECT=""
BODY=""
HTML=""
FROM="Iris <${IRIS_EMAIL_FROM:-iris@example.com}>"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)      TO="$2";      shift 2 ;;
    --subject) SUBJECT="$2"; shift 2 ;;
    --body)    BODY="$2";    shift 2 ;;
    --html)    HTML="$2";    shift 2 ;;
    --from)    FROM="$2";    shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$TO" ]]      && { echo "send-email: --to is required" >&2; exit 1; }
[[ -z "$SUBJECT" ]] && { echo "send-email: --subject is required" >&2; exit 1; }

# Read body from stdin if not provided via --body
if [[ -z "$BODY" ]]; then
  BODY=$(cat)
fi

RESEND_API_KEY=$(get-secret RESEND-API-KEY)
[[ -z "$RESEND_API_KEY" ]] && { echo "send-email: RESEND-API-KEY not found in Key Vault" >&2; exit 1; }

# Build JSON payload
if [[ -n "$HTML" ]]; then
  PAYLOAD=$(jq -n \
    --arg from "$FROM" \
    --arg to "$TO" \
    --arg subject "$SUBJECT" \
    --arg html "$HTML" \
    --arg text "$BODY" \
    '{"from":$from,"to":[$to],"subject":$subject,"html":$html,"text":$text}')
else
  PAYLOAD=$(jq -n \
    --arg from "$FROM" \
    --arg to "$TO" \
    --arg subject "$SUBJECT" \
    --arg text "$BODY" \
    '{"from":$from,"to":[$to],"subject":$subject,"text":$text}')
fi

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "https://api.resend.com/emails" \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESP=$(echo "$RESPONSE" | head -1)

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
  EMAIL_ID=$(echo "$BODY_RESP" | jq -r '.id // "unknown"')
  echo "Email sent successfully (id: $EMAIL_ID)"
else
  echo "send-email: API error $HTTP_CODE: $BODY_RESP" >&2
  exit 1
fi
```

## Notes

- Requires `jq` and `curl` (available on all Iris hosts)
- API key retrieved via `get-secret RESEND-API-KEY` — stored in Azure Key Vault
- Sending domain `example.com` must be verified in Resend (DNS records already configured)
- Rate limit: 100 emails/day on free tier; escalate if limit is hit
- Never include secrets or API keys in the email body

## Examples

```bash
# Escalate a failure to the human operator
send-email \
  --to rohit@example.com \
  --subject "Iris: sub-agent cricket is unresponsive" \
  --body "Cricket agent failed to respond after 3 retries. Manual intervention required."

# Send a report
generate-report | send-email --to team@example.com --subject "Daily digest"
```
