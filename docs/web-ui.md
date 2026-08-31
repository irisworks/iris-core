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

## What this transport is, and is not

Three limits to be explicit about before building on it:

- **The bundled page at `/` is a reference implementation.** It exists to
  exercise the protocol and to give a chat-only install something usable — not
  to be a product frontend. It has no bundler, no framework, and no upgrade
  path; treat it as a worked example you read, not a UI you ship to users.
- **Its auth is a door lock, not RBAC.** `IRIS_WEBUI_PASSWORD` is one shared
  secret with no accounts, roles, or per-user isolation. Anything user-facing
  needs your own authentication in front of it; never hand end users the web
  password directly.
- **Application developers should not build against this transport.** It is a
  *reference implementation* of one way to consume Iris's session events, not
  the thing to integrate with. The session API (`api.ts`) — documented in
  [Integration & Production Deployment](integration.md) — is the integration
  surface for a program driving Iris: it owns sessions, messages, attachments,
  stop, history, and streaming (`GET /sessions/:id/stream`, which emits the
  same live events as the `SESSION-` support documented below). Code that
  watches turns over this WebSocket should migrate to that SSE endpoint. A
  production frontend also needs its own backend in front of either surface —
  see [Integration & Production Deployment](integration.md#why-you-need-a-backend-for-your-frontend)
  for why.

## Enabling it

```bash
IRIS_WEBUI_PORT=8081
IRIS_WEBUI_PASSWORD=<a-shared-secret>   # optional but recommended
IRIS_WEBUI_HOST=0.0.0.0                 # optional; widens the bind beyond loopback
```

Presence of `IRIS_WEBUI_PORT` enables the transport; it's off by default so
Slack/Telegram-only installs pay nothing for it. The server binds to
`127.0.0.1` by default — expose it externally with the `serve-public` skill
(its nginx config already handles the `Upgrade`/`Connection` headers WebSocket
needs), or set `IRIS_WEBUI_HOST` if a consumer needs to reach it directly
(e.g. from another container). Widening the bind without also setting
`IRIS_WEBUI_PASSWORD` logs a warning, since the web UI has no auth gate by
default.

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

`POST /upload?channel=<channelId>` — `channelId` must be a `WEBUI-<id>` or
`SESSION-<id>` channel (the two namespaces this transport owns; anything else,
including other transports' channel dirs, is a 400). Body is the raw file bytes, header
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
`resolveChannelDir` in `store.ts`). Passing a full `SESSION-<id>` as `thread`
subscribes to that channel verbatim instead, read-only, so a consumer driving
turns through the session REST API can watch them live — see
[API-driven sessions](#api-driven-sessions) below. Only `SESSION-` is treated
this way; any other value is prefixed, so a thread literally named
`WEBUI-notes` still maps to `WEBUI-WEBUI-notes` as before. `agent`, if given, must match a name in
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

## API-driven sessions

Turns driven through the internal session API (`POST /sessions/:id/message`)
run on a `SESSION-<id>` channel, minted by the runtime itself. An
out-of-process consumer should prefer
[`GET /sessions/:id/stream`](sub-agents.md#driving-a-session-from-your-own-application)
on the session API itself — it needs neither this transport enabled nor its
password. This transport's own `GET /ws?thread=SESSION-<id>` remains available
for the same purpose: the socket receives that session's
`thinking`/`status`/`tool`/`final`/`file` frames as the turn runs, instead of
only seeing the reply when the POST returns. `GET /files/SESSION-<id>/<filename>`
serves files the agent attaches during the turn, and
`POST /upload?channel=SESSION-<id>` writes into the same `attachments/`
directory.

**The socket is read-only.** The session API owns the turn; a `{"type":
"message"}` or `{"type": "command"}` frame on a `SESSION-` socket is refused
with an `error` frame. This is deliberate: a session has exactly one pending
request slot, resolved by whichever run on that channel finishes first, so a
second writer could hand the API caller a reply to a message it never sent —
and `reset` would clear an API session's context mid-flight. Send messages
through `POST /sessions/:id/message` and watch the socket for progress.

Note that a `SESSION-` turn does not run on this transport — the session API
picks the transport (`getTransports()[0]`: Slack, Telegram, or Bridge), and
that transport's context posts wherever it normally posts. The web frames come
from a mirror hooked once in the engine (`engine/channel-observers.ts`), which
is skipped entirely when no socket is watching. A practical consequence: `tool`
frames reach a watcher even though Slack/Telegram/Bridge implement no
`onToolEvent` of their own.

### Watching a run from inside the runtime

If what you are writing runs *in-process* — another transport, or any consumer
compiled into the runtime — do not reach into a transport's internals to see a
run's progress. Register a `ChannelObserver` with
`engine/channel-observers.ts` and receive the events as a passive watcher:

```ts
import { registerChannelObserver, unregisterChannelObserver } from "../../engine/channel-observers.js";

registerChannelObserver({
  // Keeps the mirror off the hot path entirely when nobody is watching.
  watching: (channelId) => myWatchers.has(channelId),
  emit: (channelId, event) => {
    // event.kind: "thinking" | "status" | "tool" | "final" | "file"
    // "thinking" carries an optional `text` with the reasoning content once
    // the assistant message finishes — the earlier "thinking started" frame
    // (fired from setTyping()) has none.
    myWatchers.get(channelId)?.send(event);
  },
});

// On shutdown, so a stopped transport stops being consulted:
// unregisterChannelObserver(observer);
```

Two properties make this the right seam rather than a convenience: the mirror
wraps `onToolEvent` even for transports that don't implement it (which is how a
watcher gets structured tool cards for a turn running on Slack), and an
observer that throws cannot fail the run. It is transport-agnostic by design —
it speaks run events, not wire frames — so `engine/` never imports a concrete
transport. `WebTransport` is one consumer of it, not its owner.

This is an **in-process** API. An out-of-process consumer (your own backend)
cannot register an observer; it watches over the WebSocket above, or over
[`GET /sessions/:id/stream`](sub-agents.md#driving-a-session-from-your-own-application)
on the session API — prefer the latter, since it needs neither this transport
enabled nor its password.

Attachments *inbound to* a session travel on the message body: `POST
/sessions/:id/message` accepts `attachments: [{local}]`, where each `local` is
a handle returned by an upload. Two routes mint one:
`POST /upload?channel=SESSION-<id>` here, and
`POST /sessions/:id/attachments` on the internal API. Prefer the latter for
anything programmatic — it needs neither this transport enabled nor its
password. Either way a `local` path is accepted only if it resolves inside that
session's own directory, so one session cannot attach another's files.

The auth gate is unchanged — with `IRIS_WEBUI_PASSWORD` set, a `SESSION-`
socket or upload needs the same session cookie any other request does. No
other virtual namespace (`BRIDGE-`, `ESCALATE-`, `SELFHEAL-`) or transport
channel dir is reachable through these routes.

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
