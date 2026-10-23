---
title: Integration & Production Deployment
description: Building a production application on top of Iris — the session API as the integration surface, and why it belongs behind your own backend.
---

# Integration & Production Deployment

If you're building a product on top of Iris — a support tool, a customer-facing
chat frontend, a batch job that drives conversations programmatically — the
**session API**, part of the [internal HTTP API](sub-agents.md#internal-http-api)
on `IRIS_API_PORT` (default `3000`), is the integration surface. Everything in
this page talks to that one port, under one token.

This is **not** the [web UI transport](web-ui.md) (`web.ts`, `IRIS_WEBUI_PORT`).
That transport is a reference implementation — a worked example showing one way
to consume the session API's events, shipped as a bare HTML/JS page with a
single shared password and no accounts. Read it to see the event shapes in
action; don't build a product against it.

## Why you need a backend for your frontend

A browser cannot call the session API directly:

- `IRIS_API_TOKEN` is one shared, unrestricted secret (or a per-agent token —
  see [Sub-agents](sub-agents.md)) — not a per-user credential. Shipping it to
  a browser hands every visitor the same unrestricted access, including
  secrets management and event injection on arbitrary channels.
- The API has no CORS handling and binds to `127.0.0.1` by default (see
  [Internal API security](configuration.md#internal-api-security)) — it isn't
  set up to be a browser's fetch target even ignoring auth.
- The API does not authenticate your end users. A `sessionId` is Iris's unit of
  conversation state; mapping *your* users/accounts onto `sessionId`s, and
  deciding who may read or message which session, is your application's job,
  not something this API does for you. Your backend can tell Iris who sent each
  message (see [Per-user memory](#per-user-memory)), but Iris trusts whatever
  `userId` it is given.

So a production integration needs its own backend in front of Iris: it holds
`IRIS_API_TOKEN`, maps your user/auth model onto `sessionId`s, and proxies
requests (and re-streams the SSE feed) out to your actual frontend. `web.ts`'s
bundled page is, in effect, a minimal single-password version of exactly this
— proof that the shape works, not a starting point to fork.

## Session endpoints

| Endpoint | Purpose |
|---|---|
| `POST /sessions` · `GET /sessions` · `GET`/`PATCH /sessions/:id` | Session CRUD |
| `POST /sessions/open` | Post to a channel + create a session in one call |
| `POST /sessions/:id/message` | Inject a message, wait for Iris's response — body `{text, user?, userId?, userName?, role?, attachments?}` |
| `POST /sessions/:id/attachments` | Upload a file into the session's `attachments/` dir (raw body + `X-Filename`), returns the `local` handle for the `attachments` field |
| `POST /sessions/:id/stop` | Abort the session's in-flight turn |
| `GET /sessions/:id/stream` | Server-sent events: the session's live `thinking`/`status`/`tool`/`final`/`file` events as the turn runs |
| `GET /sessions/:id/history` | Full message history |
| `POST /sessions/:id/reset` | Wipe session context |
| `POST /sessions/:id/inject-turn` | Append a human-agent turn without triggering the LLM |
| `POST /sessions/email-inbound` | Route inbound email to its session |

Sessions are also the backbone of `thread`/`interactive-thread`
[channel modes](channel-modes.md) and of human-in-the-loop workflows (`reset` +
`inject-turn` let a human take over a conversation seamlessly).

## Driving a session from your own application

A typical turn is three calls on this one port, under one token:

```bash
# 1. Stage a file (optional). `local` is a handle, not a path you compose.
curl -X POST "$IRIS/sessions/$ID/attachments" \
  -H "Authorization: Bearer $IRIS_API_TOKEN" \
  -H "X-Filename: report.pdf" --data-binary @report.pdf
# → {"local": "SESSION-<id>/attachments/1755_report.pdf"}

# 2. Send the message. Blocks until the turn finishes.
curl -X POST "$IRIS/sessions/$ID/message" \
  -H "Authorization: Bearer $IRIS_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "review this", "attachments": [{"local": "SESSION-<id>/attachments/1755_report.pdf"}]}'

# 3. Abort it from another request if it runs too long.
curl -X POST "$IRIS/sessions/$ID/stop" -H "Authorization: Bearer $IRIS_API_TOKEN"
```

`stop` is the API's counterpart to Telegram's `/stop`, Slack's `stop`, and the
web UI's Stop button — all four call the same `engine.handleStop`. The aborted
run still resolves the pending `message` request with whatever text it had
produced, so that caller gets a reply rather than waiting out its timeout.

To watch a turn's progress instead of waiting for `message` to return, open
`GET /sessions/:id/stream` **before** sending the message — it's a
`text/event-stream` response, one SSE `event:`/`data:` pair per
`thinking`/`status`/`tool`/`final`/`file` event
(see [`ChannelObserverEvent`](web-ui.md#watching-a-run-from-inside-the-runtime)),
staying open until the client disconnects. Capped at 8 concurrent connections
per session (a 9th gets `429`) — each open stream holds a socket, a heartbeat
timer, and an observer registration for as long as it's connected:

```bash
curl -N "$IRIS/sessions/$ID/stream" -H "Authorization: Bearer $IRIS_API_TOKEN" &

curl -X POST "$IRIS/sessions/$ID/message" \
  -H "Authorization: Bearer $IRIS_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "review this"}'
```

There's no replay, and no partial visibility either: whether a turn mirrors to
watchers at all is decided once, at the moment it starts, from whoever is
already connected then (`engine/index.ts`'s `isChannelObserved` check). A
client that opens the stream after `POST /sessions/:id/message` has already
been sent may miss that entire turn's events, not just the events already
past — connect first, and nothing is persisted for a later reconnect either.
One thing this API still does not do: accept attachments by URL (it never
fetches; you send the bytes or place the file yourself).

## Per-user memory

Many users can share one agent, even one session. Pass a stable `userId` on
each `message` call so Iris knows who is talking:

```bash
curl -X POST "$IRIS/sessions/$ID/message" \
  -H "Authorization: Bearer $IRIS_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "I prefer metric units", "userId": "u-42", "userName": "Ada", "role": "admin"}'
```

| Field | Rule |
|---|---|
| `userId` | 1–128 chars of `A-Z a-z 0-9 . _ @ + -`, not starting with `.`. Rejected with `400` otherwise. Used as the directory name exactly as sent: `Ada` and `ada` are different users |
| `userName` | Optional display name (≤128 chars, whitespace collapsed to single spaces). Labels the turn; without it the label is `user`, then `userId` |
| `role` | Optional free-form role (≤64 chars, whitespace collapsed), shown to Iris |

`userName` and `role` need a `userId`. All three are written to the session's
`log.jsonl` entry for that message.

With a `userId`, each turn also loads that user's files on top of global and
channel memory:

- `<workspace>/users/<userId>/MEMORY.md`: facts about the user
- `<workspace>/users/<userId>/PREFERENCES.md`: how they want Iris to work

Iris is told the current user's id, name, role and these two paths, and is
instructed to save anything personal there instead of in global or channel
memory, which every user sees. Turns without a `userId` load no per-user files.
A turn belongs to one user: a message from anyone else that arrives while it
runs is queued for its own turn rather than folded into this one.

How strongly users are kept apart depends on the sandbox:

- `--sandbox=bwrap`: only the current user's directory is mounted for the
  turn, so Iris can't read or write anyone else's.
- `host`, `docker`, `firecracker`: every user's directory is reachable. Only
  the current user's files are loaded into the turn, and Iris is told to use
  only those, but nothing enforces it. Use `bwrap` if users must not be able
  to reach each other's memory.

The workspace must be on a **case-sensitive filesystem** (the Linux default).
On a case-insensitive one (the macOS and Windows defaults), `Ada` and `ada`
resolve to the same directory and share memory. If your ids can differ only by
case, normalize them before sending, or keep the workspace on a case-sensitive
volume.

`IRIS_API_TOKEN` also authorizes secrets management and channel-addressed event
injection, so it must stay server-side — never ship it to a browser. Your BFF
is the thing that holds it.
