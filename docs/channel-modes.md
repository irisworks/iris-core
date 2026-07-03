---
title: Channel Modes
description: Configure how Iris behaves per Slack channel — from mention-only to full passthrough.
---

# Channel Modes

How Iris behaves in a Slack channel is configured per channel in
`<workspace>/data/channels.json`. Keys are channel IDs; prefix wildcards like `D*`
are supported.

| Mode | Behavior |
|---|---|
| `dm` | Default. Responds in DMs; channels need an `@iris` mention |
| `admin` | Like `dm`, plus `stop` / `compact` / `reset` control commands |
| `thread` | Only responds inside registered session threads (sessions created via the API) |
| `interactive-thread` | Top-level `@iris` mention opens a session; replies in that thread continue it without further mentions |
| `leads` | Every top-level message triggers Iris — no mention needed |
| `passthrough` | Messages are forwarded to an external HTTP endpoint; the reply is posted back. Iris's LLM never runs |

```json
{
  "C0XXXXXXX": { "mode": "interactive-thread", "requireMentionForTopLevel": true },
  "C0YYYYYYY": {
    "mode": "passthrough",
    "url": "https://example.com/webhook",
    "secretName": "MY-WEBHOOK-KEY",
    "payload": { "sender_id": "{{sender_id}}", "message_text": "{{text}}" },
    "replyPrefix": "*Bot:* "
  },
  "D*": { "mode": "admin" }
}
```

## Passthrough configuration

Passthrough channels forward every message to `url` as a JSON POST and post the
endpoint's reply back into the thread.

- **`payload`** — a JSON template for the request body. String values may use
  placeholders, substituted recursively: `{{text}}`, `{{user_id}}`, `{{user_name}}`,
  `{{user_handle}}` (lowercased, dot-separated), `{{sender_id}}`, `{{channel}}`,
  `{{ts}}`. Default: `{ "text": "{{text}}", "user": "{{user_name}}", "sender_id": "{{sender_id}}" }`
- **`secretName`** — API key resolved through the `get-secret` skill (cached for the
  process lifetime); sent as an `X-API-Key` header. Falls back to the
  `PASSTHROUGH_API_KEY` env var.
- **`replyPrefix`** — optional prefix prepended to replies posted back to the thread.

The endpoint's response is read as JSON; the first of `response`, `text`, or
`error` is posted back.

## Sessions

`thread` and `interactive-thread` modes are built on **sessions** — durable
conversation containers created via the [internal API](sub-agents.md) or by a
top-level mention in an interactive-thread channel. Session state lives on disk
and survives restarts; routes are rebuilt from `sessions.json` at startup.
