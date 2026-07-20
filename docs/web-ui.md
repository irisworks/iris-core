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
WebSocket upgrade and every route below. If no password is configured, any
request succeeds.

`GET /agents` — lists `agents.json` entries as `{"agents": [{"name",
"description"?}]}`. Never includes `bridge_url` or `secrets` — this is a
browser-facing route, not the internal API, so nothing an unauthenticated
sub-agent's own allow-list depends on is exposed to it.

`POST /upload?channel=<channelId>` — body is the raw file bytes, header
`X-Filename: <name>` (no path separators). Saves under that channel's
`attachments/` directory (via `resolveChannelDir`/`resolveChannelPath` in
`store.ts` — nothing hand-builds the path) and returns `{"local": "..."}`,
suitable for the `attachments` array on an inbound `message` frame.

`GET /files/<channelId>/<filename>` — serves a previously uploaded or
Iris-attached file. `filename` may not contain `/` or `..`.

`GET`/`POST /secret-drop/<token>` — the out-of-band secret submission form
(see [Secrets](secrets.md)). Deliberately checked **before** the session-cookie
gate above: the one-time token in the URL *is* the auth, since the person
submitting a secret may only have Slack or Telegram, not the web UI password.
`GET` renders a minimal form for an unexpired, unused token; `POST` stores the
value and burns the token — both an invalid and an already-used token return
the same generic 404, so the response never confirms whether a given token
ever existed.

`GET /ws?thread=<id>&agent=<name>` (upgraded to WebSocket) — `thread` opens or
resumes a conversation, mapped to a `WEBUI-<id>` channel id (the existing
virtual-channel convention shared with `SESSION-`/`BRIDGE-`/`ESCALATE-`, see
`resolveChannelDir` in `store.ts`). `agent`, if given, must match a name in
`agents.json` and routes every message in that thread to that sub-agent's
bridge (see below) instead of Iris's own engine.

Inbound (browser → server), one JSON message per frame:

| Frame | Meaning |
|---|---|
| `{"type": "message", "text", "attachments"?}` | A user message. `attachments` is `[{"local"}]` from a prior `/upload` response |
| `{"type": "command", "action": "stop"\|"compact"\|"reset"}` | Admin action, routed to `engine.handleStop`/`handleCompact`/`handleReset` for the connection's channel. Not available on agent-routed threads (the bridge protocol has no such concept) |

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
| `{"type": "error", "message"}` | Request-level error (e.g. unknown `agent`/`command`) |

## Reference page (IRIS-113)

`GET /` serves a self-contained HTML/CSS/JS page implementing this protocol —
login, a thread sidebar, an agent picker (from `GET /agents`), tool-call cards,
file attachments, and Stop/Compact/Reset buttons. Deliberately plain: no
bundler, no framework, no new dependency — `iris-runtime` has no frontend
build toolchain today, and introducing one plus an adapter to a component
library (e.g. the AI SDK's `useChat`, built around HTTP streaming rather than
this WebSocket protocol) was assessed as materially more effort for
uncertain payoff. Revisit if the vanilla page's structure stops scaling.

Threads are tracked client-side (`localStorage`), not server-side — there's
no "list my sessions" endpoint. One consequence: history doesn't hydrate on
reconnect or page refresh. Iris's own memory is unaffected (`context.jsonl`
still backs the conversation and is loaded on the next run), only the
browser's visual replay of prior messages is skipped.

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
