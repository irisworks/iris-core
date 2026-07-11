---
title: Channel Modes
description: Configure how Iris behaves per Slack channel — from mention-only to full passthrough.
---

# Channel Modes

How Iris behaves in a Slack channel is configured per channel in
`<workspace>/data/channels.json`. Keys are channel IDs; prefix wildcards like `D*`
are supported. An exact channel ID always wins over wildcards; when several
wildcards match, the longest prefix wins (e.g. `DA*` beats `D*`).

| Mode | Behavior |
|---|---|
| `dm` | Default. Responds in DMs; channels need an `@iris` mention |
| `admin` | Like `dm`, plus `stop` / `compact` / `reset` control commands |
| `thread` | Only responds inside registered session threads (sessions created via the API) |
| `interactive-thread` | A top-level message opens a session; replies in that thread continue it without further mentions |
| `leads` | Every top-level message triggers Iris — no mention needed |
| `passthrough` | Every message is forwarded to an external HTTP endpoint; the reply is posted back. Iris's LLM never runs |

`requireMentionForTopLevel` (per channel entry) gates what a *top-level* channel
message does in `interactive-thread` and `passthrough` channels: when set, only
an `@iris` mention opens a session / gets forwarded, and plain top-level messages
are logged but otherwise ignored.

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

Passthrough channels forward every message — top-level channel messages,
thread replies, `@iris` mentions, and DMs — to `url` as a JSON POST and post the
endpoint's reply back into the thread. Nothing is interpreted by Iris herself:
even `stop` / `compact` / `reset` are forwarded verbatim, and scheduled events
cannot target a passthrough channel.

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

## Queueing and overflow

Each channel queues at most 5 pending messages for the LLM. This includes
`leads` channels: under burst load, messages beyond the cap are logged with a
warning but do not trigger a run — no notice is posted into the channel itself,
which is often an external-facing feed. The full message text is always
preserved in the channel's `log.jsonl`, so no lead is lost; only the automated
response is skipped.

## Sessions

`thread` and `interactive-thread` modes are built on **sessions** — durable
conversation containers created via the [internal API](sub-agents.md) or by a
top-level mention in an interactive-thread channel. Session state lives on disk
and survives restarts; routes are rebuilt from `sessions.json` at startup.

## Channel workspace layout

Real Telegram and Slack channels live two levels under the data root:
`data/telegram/tg-<id>/` for Telegram chats and `data/slack/<id>/` for Slack
channels. The workspace root is resolved from the explicit working directory
passed through runner creation — not inferred from the channel directory's
depth — so custom model providers (`models.json`), memory (`MEMORY.md`), and
skills are discovered correctly for real conversations, exactly as they are for
synthetic session channels.
