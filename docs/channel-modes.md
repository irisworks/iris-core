---
title: Channel Modes
description: Configure how Iris behaves per Slack channel — from mention-only to full passthrough.
---

# Channel Modes

How Iris behaves in a Slack channel is configured per channel in
`<workspace>/meta/channels.json`. Keys are channel IDs; prefix wildcards like `D*`
are supported. An exact channel ID always wins over wildcards; when several
wildcards match, the longest prefix wins (e.g. `DA*` beats `D*`).

| Mode | Behavior |
|---|---|
| `dm` | Default. Responds in DMs; channels need an `@iris` mention |
| `admin` | Like `dm`, plus `stop` / `compact` / `reset` control commands — these work as plain text, no `@iris` mention needed |
| `thread` | Only responds inside registered session threads (sessions created via the API) |
| `interactive-thread` | A top-level message opens a session; replies in that thread continue it without further mentions |
| `leads` | Every top-level message triggers Iris — no mention needed |
| `passthrough` | Every message is forwarded to an external HTTP endpoint; the reply is posted back. Iris's LLM never runs |

`requireMentionForTopLevel` (per channel entry) gates what a *top-level* channel
message does in `interactive-thread` and `passthrough` channels: when set, only
an `@iris` mention opens a session / gets forwarded, and plain top-level messages
are logged but otherwise ignored.

These six names are the only supported, documented surface — copy one of the
recipes below. Underneath, all six are the same dispatch pipeline running with
different settings; see [Under the hood](#under-the-hood) if you're curious
how they relate, but don't configure a channel with raw settings instead of a
named mode.

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

## Verbose tool output

By default (`IRIS_VERBOSE_TOOLS` unset), a run shows one status line that
updates in place as Iris works (e.g. `_→ running bash..._`), then gets
replaced by the final answer — no per-tool-call thread replies (Slack) or
flat messages (Telegram), no chain-of-thought dump, no per-run cost summary.

Toggle it with `verbose on` / `verbose off` / `verbose status` on Slack, or
`/verbose on|off|status` on Telegram. Unlike `stop`/`compact`/`reset`, this
is **not** gated behind `admin` mode — it's a UX preference, not a
destructive action, so it works from any DM or explicit `@iris` mention in
any channel mode. The setting persists per channel (in that channel's
`settings.json`) until toggled again; `IRIS_VERBOSE_TOOLS=true` in `/iris/.env`
changes the default for channels that haven't set their own override.

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

## Under the hood

The six named modes are three primitives plus orthogonal flags, all resolved
by one dispatch pipeline in the engine (`src/engine/dispatch.ts` and
`dispatch-config.ts`) instead of each mode re-implementing its own slice of
routing logic. This dispatch pipeline is currently wired up for Slack only;
see [Writing a Transport](writing-a-transport.md#channel-mode-dispatch-is-opt-in-not-part-of-the-contract)
if you're adding a new chat platform and deciding whether it needs the same
wiring.

| Primitive | Behavior |
|---|---|
| `chat` | Channel-context LLM run — replies land in the channel itself |
| `sessions` | Per-thread session LLM run — replies are scoped to a durable session (see [Sessions](#sessions)) |
| `relay` | Webhook forward — Iris's LLM never runs |

| Flag | Values | Meaning |
|---|---|---|
| `trigger` | `mention` \| `all-top-level` \| `api-only` | What opens/continues a container organically: an explicit `@iris` mention only, any top-level message, or nothing (only a pre-existing, API-created session continues) |
| `adminCommands` | boolean | `stop` / `compact` / `reset` text is intercepted and executed (`chat` only) — via a mention, a DM, or bare ambient top-level text alike |
| `acceptBotMessages` | boolean | Bot/integration messages are admitted as triggers, not filtered out |
| `replayMissed` | boolean | Pre-startup top-level messages are replayed instead of skipped |

The mapping, exactly as implemented — this is also the legacy-alias table:
`channels.json` only ever stores one of these six names, expanded to the
primitive shape on load, and the six names remain supported forever so no
existing config ever needs to change.

| Mode | container | trigger | adminCommands | acceptBotMessages | replayMissed |
|---|---|---|---|---|---|
| `dm` | chat | mention | — | — | — |
| `admin` | chat | mention | ✓ | — | — |
| `leads` | chat | all-top-level | — | ✓ | ✓ |
| `thread` | sessions | api-only | — | — | — |
| `interactive-thread` | sessions | mention if `requireMentionForTopLevel`, else all-top-level | — | — | — |
| `passthrough` | relay | mention if `requireMentionForTopLevel`, else all-top-level | — | — | — |

A mention or a DM always reaches its container regardless of `trigger` — the
flag only gates plain top-level chatter with no explicit address to the bot.
This mapping is an implementation detail, not a second configuration surface:
`channels.json` only ever takes a named `mode` (+ `requireMentionForTopLevel`
+ passthrough's `url`/`payload`/`secretName`/`replyPrefix`), which the engine
silently expands into this shape. There is no way to configure a channel with
raw `container`/`trigger`/flag values directly, and there won't be — new
behavior gets a new named mode (or a new flag on an existing one), documented
here as a recipe, not a raw combination for callers to assemble themselves.

## Channel workspace layout

Real Telegram and Slack channels live two levels under the data root:
`data/telegram/tg-<id>/` for Telegram chats and `data/slack/<id>/` for Slack
channels. The workspace root is resolved from the explicit working directory
passed through runner creation — not inferred from the channel directory's
depth — so custom model providers (`models.json`), memory (`MEMORY.md`), and
skills are discovered correctly for real conversations, exactly as they are for
synthetic session channels.
