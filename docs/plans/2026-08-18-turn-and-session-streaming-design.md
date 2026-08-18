---
title: "Design: turn-scoped events and a durable session stream"
description: Design proposal for a turn/run abstraction and an event-sourced stream endpoint, layered on Iris's existing session and channel abstractions.
---

# Design: turn-scoped events and a durable session stream

Status: draft, not yet implemented.

## Context

A question came up: does Iris have session/run management and streaming
comparable to what other modern agent-runtime platforms expose, and can
external/custom channels be added the way those platforms describe? This
doc answers that by mapping what Iris already has against three concepts —
**sessions**, **turns (runs)**, and **streaming** — and proposes closing the
gaps without disturbing what already works. It intentionally does not
reference any third-party product by name; the comparison is between "what
we have" and "what a turn/event-stream layer generally looks like."

### What already exists

- **Sessions are already durable.** `iris-runtime/src/engine/sessions.ts`
  defines a `Session` (UUID `sessionId`, `createdAt`, and
  `integrations.slack`/`integrations.email` linking a thread or email address
  to a session directory). Each session's directory holds `context.jsonl`
  (message history) and `log.jsonl`, via `ChannelStore`/`resolveChannelDir`
  (`iris-runtime/src/engine/store.ts`). CRUD lives at `findByThread`,
  `findByEmail`, `createSession`, `updateSession`. A pending-request registry
  (`registerSessionRequest`/`resolveSessionRequest`) lets `POST
  /sessions/:id/message` block until a run finishes and return its result.
  This already matches the "durable container + history, addressable by id"
  half of a session/turn model.

- **Channels are already a first-class, documented extension point.**
  `iris-runtime/src/transport/types.ts:141-165` defines `ChannelTransport`
  (`start`/`stop`, `ownsChannel`, `postMessage`/`updateMessage`,
  `enqueueEvent`, `createContext`), explicitly designed so "adding a
  transport requires zero engine edits." Four implementations exist today
  (Slack, Telegram, Bridge, Web), and `docs/writing-a-transport.md` walks
  through adding a new one. **No new abstraction is needed here** — this
  already covers what a "custom channel" story needs to offer. The
  recommendation below leaves `ChannelTransport` untouched.

- **In-flight, uncommitted work already extends the Web transport's
  WebSocket to session-API-driven channels** (worktree
  `issue-180-session-ws`, referenced internally as IRIS-180): every turn
  driven through the session REST API is minted a `SESSION-<id>` channel by
  `injectSessionMessage`, and that work teaches `WebTransport` to serve
  `SESSION-` channels the same way it serves its own `WEBUI-` ones — WS
  subscribe, uploads, file serving — so an API-first caller gets a live push
  of `postMessage`/`updateMessage` events instead of polling. This doc
  assumes that work lands first; it fills in gaps such an approach still
  leaves.

### What's missing

- **No turn/run object.** A "run" today is just one pass through
  `AgentRunner` gated by a single per-channel flag:
  `ChannelState { running, runner, store, stopRequested }`
  (`iris-runtime/src/engine/index.ts:17-21`). There's no id for an
  individual run, no persisted state machine (`started` → `completed` /
  `failed` / `cancelled`), and no shared concurrency policy — the top
  comment in `engine/index.ts` says "per-channel event queueing stays inside
  the transports," meaning each transport independently decides what happens
  when a new message arrives mid-run. There is nothing analogous to a
  documented "cancel the active run and start fresh" vs. "queue until the
  active run finishes" policy that a caller can choose per request.

- **No token-level streaming anywhere.** `agent.ts` only surfaces coarse
  `tool_execution_start`/`tool_execution_end` and `message_start`/
  `message_end` events to transports. The underlying `@mariozechner/pi-agent-core`
  library already emits finer-grained `text_delta`/`thinking_delta`/
  `toolcall_delta` events (see its `AgentEvent` types), but nothing in Iris
  listens for them. The IRIS-180 work above pushes whole final/updated
  message text over a WebSocket — a real improvement over polling — but it
  is still message-granular, not delta-granular, and has no replay/offset
  mechanism for a client that reconnects mid-run.

## Proposal

Two additive layers on top of what exists. Neither requires changing
`ChannelTransport` or how Slack/Telegram/Bridge work today.

### 1. A `Turn` record and a shared concurrency policy

Add a `Turn` type alongside `Session` in `engine/sessions.ts` (or a sibling
`engine/turns.ts`):

```ts
interface Turn {
  turnId: string;       // uuid
  sessionId: string;
  channelId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  endedAt?: string;
  cancelReason?: string;
}
```

`ChannelState.running: boolean` becomes `ChannelState.activeTurn: Turn |
undefined` — a strict superset, so existing `running`/`stopRequested` call
sites keep working (`activeTurn !== undefined` ⇔ old `running`). Each run
through `AgentRunner` gets a `turnId` up front, appended to `log.jsonl` and
(new) a per-session `turns.jsonl` index so a caller can look up what
happened to a specific run after the fact.

Concurrency policy becomes an explicit, per-request choice instead of an
implicit per-transport one: `POST /sessions/:id/message` gains an optional
`{ "onBusy": "cancel" | "queue" }` (default `"cancel"`, matching today's
Slack `stopRequested` behavior). `"queue"` is new: the message is held and
dispatched once `activeTurn` clears, rather than requiring the caller to
poll. This is additive to the transport-level queueing that already exists
inside Slack/Telegram — those are unaffected.

### 2. A session event log + stream endpoint

Introduce one append-only, per-session event log that both existing and new
consumers read from, instead of teaching every transport to independently
listen to raw `pi-agent-core` events:

- New emitter in `agent.ts` wraps the existing event handling
  (`tool_execution_start/end`, `message_start/end`) *and* newly subscribes to
  `text_delta`/`thinking_delta`, writing normalized events to
  `<session-dir>/events.jsonl`: `{ type, turnId, data, seq, at }`, `seq`
  monotonic per session so a client can request `?since=<seq>` on
  reconnect — the same problem the IRIS-180 WebSocket doesn't yet solve for
  a dropped connection.
- `GET /sessions/:id/stream` (NDJSON or SSE, caller's choice via `Accept`)
  tails `events.jsonl` starting at an optional `?since=<seq>`, matching the
  existing `/sessions/:id/message` route's auth/session-lookup path in
  `iris-runtime/src/engine/sessions.ts`.
- `WebTransport`'s `SESSION-` handling (from IRIS-180) becomes one consumer
  of this same log rather than a second source of truth — it already knows
  how to push `postMessage`/`updateMessage`; once `events.jsonl` exists, it
  can push `text_delta` events the same way, giving Slack/Telegram a path to
  incremental edit-in-place updates later without a second design.
- Delivering true incremental deltas to Slack/Telegram is a separate,
  smaller follow-up once the event log exists: both already support
  message editing (`updateMessage`/`replaceMessage`), so a throttled
  coalesce-and-edit loop is the only new transport-side work, and it's
  optional per transport — nothing forces Slack to adopt it.

## Explicitly out of scope for this doc

- Changing `ChannelTransport` itself, or anything about how a new
  channel/transport is registered — that story is already solid
  (`docs/writing-a-transport.md`).
- Cross-session/cross-turn structured "approval" (human-in-the-loop) request
  IDs — worth a follow-up once the turn record exists, since a pending
  approval is naturally a `Turn` sub-state, not a new top-level concept.
- Rewriting Slack/Telegram to consume deltas — left as a later, optional
  follow-up per the note above.
- Any change to `Session`'s existing fields or persistence format —
  `Turn` is additive, not a replacement.

## Sequencing

1. Land IRIS-180 (`issue-180-session-ws`) first — it already establishes
   `SESSION-<id>` as the channel namespace for API-driven turns and gets a
   WebSocket consumer working end to end.
2. Add the `Turn` record and `onBusy` policy (section 1) — purely additive,
   testable in isolation via the existing `ChannelState` test surface.
3. Add `events.jsonl` + `/sessions/:id/stream` (section 2), with
   `WebTransport` switched to read from it instead of directly wrapping
   `postMessage`/`updateMessage` calls.
4. Only after 1-3 land and are stable: consider incremental (delta) editing
   in Slack/Telegram as a separate, opt-in follow-up.
