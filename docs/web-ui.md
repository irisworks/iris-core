---
title: Web UI
description: The built-in browser chat transport — setup, protocol, and sub-agent routing.
---

# Web UI

Iris ships a built-in web chat transport (`WebTransport`) alongside Slack and
Telegram — a Slack-like interface in the browser for installs that don't have
or want Slack. It implements the same `ChannelTransport` interface as every
other transport, so it plugs into engine dispatch with no special-casing.

This page documents the transport shipped in `iris-core`. The AI Elements-based
reference frontend (thread sidebar, agent picker, file attachments) is a
separate, richer UI built against the protocol below — the page served at `/`
by this transport directly is a bare functional page, not that reference UI.

## Enabling it

```bash
IRIS_WEBUI_PORT=8081
IRIS_WEBUI_PASSWORD=<a-shared-secret>   # optional but recommended
```

Presence of `IRIS_WEBUI_PORT` enables the transport; it's off by default so
Slack/Telegram-only installs pay nothing for it. The server binds to
`127.0.0.1` — expose it externally with the `serve-public` skill (its nginx
config already handles the `Upgrade`/`Connection` headers WebSocket needs).

`IRIS_WEBUI_PASSWORD` gates access with a single shared secret — this is a
door lock, not RBAC. There are no user accounts or roles; multi-user auth
belongs to a reverse-proxying layer in front of this transport, not to
`iris-core` itself. If unset, the page auto-authenticates on load — fine for
loopback-only use, but set it before running `serve-public` against this port.

## Protocol

`POST /login` — body `{"password": "..."}`. On success, sets an
`iris_webui_session` cookie (`HttpOnly`, `SameSite=Strict`) required for the
WebSocket upgrade. If no password is configured, any request succeeds.

`GET /ws?thread=<id>&agent=<name>` (upgraded to WebSocket) — `thread` opens or
resumes a conversation, mapped to a `WEBUI-<id>` channel id (the existing
virtual-channel convention shared with `SESSION-`/`BRIDGE-`/`ESCALATE-`, see
`resolveChannelDir` in `store.ts`). `agent`, if given, must match a name in
`agents.json` and routes every message in that thread to that sub-agent's
bridge (see below) instead of Iris's own engine.

Inbound (browser → server): `{"type": "message", "text": "..."}`.

Outbound (server → browser), one frame per JSON message over the socket:

| Frame | Meaning |
|---|---|
| `{"type": "thinking", "id"}` | A run started; render a thinking indicator keyed by `id` |
| `{"type": "tool", "phase": "start"\|"end", "id", "toolName", "label"?, "args"?, "result"?, "isError"?, "durationMs"?}` | Structured tool-call event — same data Slack flattens into a thread reply, here kept structured for a live-updating card |
| `{"type": "final", "id", "text"}` | The run's final answer — swaps out the `id`'s thinking/previous state |
| `{"type": "update", "id", "text"}` | Status update to an existing message (e.g. compaction/stop) |
| `{"type": "thread", "text"}` | Auxiliary detail (errors, usage summaries) — Slack's `respondInThread` equivalent |
| `{"type": "file", "url", "title"?}` | A file Iris attached to her response |
| `{"type": "delete", "id"}` | The message should be removed (`[SILENT]`) |
| `{"type": "error", "message"}` | Request-level error (e.g. unknown `agent`) |

## Sub-agent routing

Sub-agents are already full `iris-runtime` instances reachable via
`bridge_url` in `agents.json` — the same mechanism `@agentname` mentions use
inside a Iris conversation (see [Sub-agents](sub-agents.md)). Opening a
thread with `?agent=<name>` routes every message in that thread directly to
that agent's bridge instead of Iris's own engine.

This reuses the existing single request/response bridge protocol — it does
**not** get the `thinking`/`tool` event stream a Iris-routed thread gets,
because the bridge protocol only returns a final reply, not intermediate
events. A thread targeting a sub-agent gets `thinking` (while waiting) then
`final` only.

## What's intentionally not here

Slack's channel-mode subsystem (`admin`/`leads`/`interactive-thread`/
`passthrough`, mention-gating) doesn't apply — a web UI thread is never
ambient shared traffic, so there's nothing to filter or gate. Admin actions
(stop/compact/reset) are exposed as regular API-driven actions for a frontend
to wire to buttons, not as parsed chat commands.
