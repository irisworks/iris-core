---
title: "Design: run-scoped events and a durable session stream"
description: Design proposal for a run/turn abstraction and an event-sourced stream endpoint, layered on Iris's existing session and channel abstractions.
---

# Design: run-scoped events and a durable session stream

Status: draft, not yet implemented.

## Context

A question came up: does Iris have session/run management and streaming
comparable to what other modern agent-runtime platforms expose, and can
external/custom channels be added the way those platforms describe? This
doc answers that by mapping what Iris already has against three concepts —
**sessions**, **runs (turns)**, and **streaming** — and proposes closing the
gaps without disturbing what already works. It intentionally does not
reference any third-party product by name; the comparison is between "what
we have" and "what a run/event-stream layer generally looks like."

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
  half of a session/run model. Session and channel are already effectively
  1:1 for API/Slack-thread traffic — `injectSessionMessage` and Slack's
  session dispatch both route through the same `SESSION-<id>` channel — so
  "busy" state keyed by channel is already session-scoped; no separate
  cross-channel lookup is needed.

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

- **No run/turn object.** A run today is just one pass through
  `AgentRunner` gated by a single per-channel flag:
  `ChannelState { running, runner, store, stopRequested }`
  (`iris-runtime/src/engine/index.ts:17-21`). There's no id for an
  individual run, no persisted state machine (`started` → `completed` /
  `failed` / `cancelled`), and no shared concurrency policy — the top
  comment in `engine/index.ts` says "per-channel event queueing stays inside
  the transports," meaning each transport independently decides what happens
  when a new message arrives mid-run. There is nothing analogous to a
  documented "cancel the active run and start fresh" vs. "queue until the
  active run finishes" policy that a caller can choose per request. There's
  also no reconciliation step after a process restart: anything left
  "running" when Iris last exited stays permanently, incorrectly, "running."

- **No token-level streaming anywhere.** `agent.ts` only surfaces coarse
  `tool_execution_start`/`tool_execution_end` and `message_start`/
  `message_end` events to transports. The underlying `@mariozechner/pi-agent-core`
  `AgentEvent` union does *not* have a top-level `text_delta`/`thinking_delta`
  variant — those live one level down, inside `message_update`'s
  `assistantMessageEvent` field (typed by `@mariozechner/pi-ai`'s
  `AssistantMessageEvent`, which does have `text_delta`/`thinking_delta`/
  `toolcall_delta`). Nothing in Iris currently reads that inner field. The
  IRIS-180 work above pushes whole final/updated message text over a
  WebSocket — a real improvement over polling — but it is still
  message-granular, not delta-granular, and has no replay/offset mechanism
  for a client that reconnects mid-run.

## Proposal

Two additive layers on top of what exists. Neither requires changing
`ChannelTransport` or how Slack/Telegram/Bridge work today.

### 1. A `Run` record and a shared concurrency policy

Add a `Run` type alongside `Session` in `engine/sessions.ts` (or a sibling
`engine/runs.ts`). Named `Run`, not `Turn` — `pi-agent-core` already emits
`turn_start`/`turn_end` for a single model round-trip inside one call to
`AgentRunner`; reusing "turn" for the whole user-request-to-completion cycle
would collide with that vocabulary in the same codebase.

```ts
interface Run {
  runId: string;         // uuid
  sessionId: string;
  channelId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  endedAt?: string;
  cancelReason?: string;
  firstSeq?: number;     // events.jsonl seq of this run's first event
  lastSeq?: number;       // events.jsonl seq of this run's last event, set on completion
}
```

`firstSeq`/`lastSeq` give an O(1) way to locate "what happened during run X"
without duplicating the event payloads onto the record itself — hydrate by
reading `events.jsonl` between the two offsets. `events.jsonl` stays the one
copy of run activity; the run record is just an index into it.

`ChannelState.running: boolean` becomes `ChannelState.activeRun: Run |
undefined` — a strict superset, so existing `running`/`stopRequested` call
sites keep working (`activeRun !== undefined` ⇔ old `running`). Each run
through `AgentRunner` gets a `runId` up front, appended to `log.jsonl` and
(new) a per-session `runs.jsonl` index so a caller can look up what happened
to a specific run after the fact.

**Crash recovery is a startup step, not a background sweep.** On process
start, before accepting requests, scan every session's `runs.jsonl` for
`status: "running"` and mark it `"interrupted"` — a run can't have kept
executing if the process that owned it is gone. A *periodic* liveness sweep
that flips long-running-but-healthy runs to `"failed"` based on wall-clock
age was considered and rejected: Iris already has runs expected to take
several minutes (`registerSessionRequest` defaults to 120s, Slack's caller
waits up to 600s), so an age-based sweep produces false positives on
legitimate long runs, and doing so without actually cancelling the
underlying `AgentRunner` would let the record say "failed" while the agent
keeps executing and posting — a worse state than no sweep at all. If
in-process staleness detection is wanted later, it should key off
last-event time (not `startedAt`) and go through the existing
`stopRequested` cancellation path, not flip status directly.

Concurrency policy becomes an explicit, per-request choice instead of an
implicit per-transport one: `POST /sessions/:id/message` gains an optional
`{ "onBusy": "cancel" | "queue" }` (default `"cancel"`, matching today's
Slack `stopRequested` behavior). Because session and channel are already
1:1 (see above), checking `activeRun` on the session's channel is sufficient
— no cross-channel scan is needed. `"queue"` is new and needs two things
pinned down that a bare FIFO doesn't answer on its own:

- **Bounded, not unbounded.** An unbounded queue gives one caller unlimited
  ability to pile up work with no backpressure signal. Cap depth and reject
  (`429`) past it.
- **Response shape for a queued call.** `POST /sessions/:id/message`
  currently blocks until the run resolves. A queued message may not even
  start before that timeout elapses, so queueing forces a choice: either the
  call returns immediately with `202` + `runId` and the caller watches
  `GET /sessions/:id/stream` for the result, or it keeps blocking and
  accepts that queue-depth × run-duration can exceed the timeout. This doc
  picks the former — `202` + `runId` for `onBusy: "queue"` — since it's the
  only option that doesn't put an implicit ceiling on queue depth.

Whether `onBusy: "cancel"` also drops anything already queued, or only the
active run, should be pinned down at implementation time; default to
dropping both (cancel means "start fresh"), since a caller that wanted the
queue preserved would have used `"queue"`.

This is additive to the transport-level queueing that already exists inside
Slack/Telegram — those are unaffected.

### 2. A session event log + stream endpoint

Introduce one append-only, per-session event log that both existing and new
consumers read from, instead of teaching every transport to independently
listen to raw `pi-agent-core` events.

**Deltas are ephemeral; only durable events are persisted.** This is the
key resource/UX trade-off in this proposal, so it's worth stating plainly:

- `agent.ts` subscribes to `message_update` and reads
  `event.assistantMessageEvent` for `text_delta`/`thinking_delta`. Doing so
  costs nothing extra on the wire — the model provider is already streaming
  these tokens into `pi-ai`; Iris is just choosing to look at data already
  flowing through the existing handler.
- Each delta is fanned out **in memory only** to whatever is currently
  subscribed to that session's `/stream` (WS or SSE/NDJSON long-poll) —
  cheap: one small write per delta per live subscriber, no disk I/O.
  Deltas are *not* written to `events.jsonl`.
- `events.jsonl` persists only durable events: run start/end, tool
  execution start/end, and the final assembled message text once a
  `text_end`/`message_end` closes it out. This is the same granularity the
  proposal already needed for run recovery (previous section) — a process
  restart can only usefully recover to the last completed tool call or
  message anyway, since a partial token stream has no meaningful "resume
  from token N" on the provider side either. Persisting deltas would add
  10–100x the write volume for a durability guarantee nothing actually
  uses.
- Practical effect: `?since=<seq>` replay reconstructs the durable timeline
  (what tools ran, what was said) plus, for a client reconnecting mid-run,
  the current partial message text held in memory for that run — not a
  token-by-token replay of everything typed so far. That's the behavior a
  reconnecting UI actually wants; nobody watches a backlog replay at typing
  speed.
- Each event is `{ type, runId, data, seq, at }`, `seq` monotonic per
  session so a client can request `?since=<seq>` on reconnect — the same
  problem the IRIS-180 WebSocket doesn't yet solve for a dropped connection.

**Replay is Iris's own behavior, not a middleware concern.** `events.jsonl`
lives inside the session's own directory on the same host as the process
serving `/stream`; a separate middleware tier would either duplicate access
to that file or reimplement Iris's own seq semantics, neither of which
buys anything. Iris runs as a single process on a single host by default
(`iris.service`, no cloud dependency required) — the case where a shared
streaming tier earns its complexity is multi-instance horizontal scaling
(several Iris processes behind a load balancer needing a shared log), which
is out of scope until that's an actual deployment shape. Until then, `GET
/sessions/:id/stream?since=<seq>` reads and seeks `events.jsonl` itself; any
reverse proxy in front should stay transport-only (not buffering the
stream, forwarding heartbeat bytes) rather than owning replay.

**The endpoint needs a heartbeat, independent of `?since`.** `?since=<seq>`
solves *not losing* events after a dropped connection; it doesn't help a
client *notice* the drop quickly, since a quiet HTTP connection gives an
intermediate proxy no signal to distinguish "idle" from "dead," and neither
side finds out until the next write fails. SSE and NDJSON need distinct
heartbeat framing since only SSE has an "invisible" line an
`EventSource` will silently ignore:

```ts
// SSE: a comment line
res.write(":hb\n\n");
// NDJSON: an explicit type the client filters
res.write(JSON.stringify({ type: "heartbeat", at: new Date().toISOString() }) + "\n");
```

Send one every ~15s while a stream connection is open (`clearInterval` on
`req.on("close")`), and disable any server-side idle timeout for this route
so it isn't killed independent of the client.

- `GET /sessions/:id/stream` (NDJSON or SSE, caller's choice via `Accept`)
  tails `events.jsonl` starting at an optional `?since=<seq>`, matching the
  existing `/sessions/:id/message` route's auth/session-lookup path in
  `iris-runtime/src/engine/sessions.ts`.
- `WebTransport`'s `SESSION-` handling (from IRIS-180) becomes one consumer
  of this same log rather than a second source of truth — it already knows
  how to push `postMessage`/`updateMessage`; once `events.jsonl` and the
  in-memory delta fan-out exist, it can push delta events the same way,
  giving Slack/Telegram a path to incremental edit-in-place updates later
  without a second design.
- Delivering true incremental deltas to Slack/Telegram is a separate,
  smaller follow-up once the event log exists, and is not simply "forward
  every delta": both transports rate-limit message edits (Slack's
  `chat.update` is roughly 1/sec/channel), so it requires the same
  throttled coalesce-and-edit loop regardless of whether deltas are
  persisted — both already support message editing (`updateMessage`/
  `replaceMessage`), so that loop is the only new transport-side work, and
  it's optional per transport — nothing forces Slack to adopt it.

## Explicitly out of scope for this doc

- Changing `ChannelTransport` itself, or anything about how a new
  channel/transport is registered — that story is already solid
  (`docs/writing-a-transport.md`).
- Cross-session/cross-run structured "approval" (human-in-the-loop) request
  IDs — worth a follow-up once the run record exists, since a pending
  approval is naturally a `Run` sub-state, not a new top-level concept.
- Rewriting Slack/Telegram to consume deltas — left as a later, optional
  follow-up per the note above.
- Any change to `Session`'s existing fields or persistence format — `Run`
  is additive, not a replacement.
- Wall-clock-based stuck-run detection and shared/multi-instance replay
  infrastructure — both considered and deferred above with the reasoning
  for why they don't fit the current single-process deployment shape.

## Sequencing

1. Land IRIS-180 (`issue-180-session-ws`) first — it already establishes
   `SESSION-<id>` as the channel namespace for API-driven runs and gets a
   WebSocket consumer working end to end.
2. Add the `Run` record, startup recovery, and `onBusy` policy (section 1)
   — purely additive, testable in isolation via the existing `ChannelState`
   test surface.
3. Add `events.jsonl` (durable events only) + `/sessions/:id/stream` with
   `?since=<seq>` replay and heartbeat framing (section 2), with
   `WebTransport` switched to read from it instead of directly wrapping
   `postMessage`/`updateMessage` calls.
4. Add in-memory delta fan-out (`text_delta`/`thinking_delta` via
   `message_update`) to `/sessions/:id/stream` — additive to step 3, no
   change to what's persisted.
5. Only after 1-4 land and are stable: consider incremental (delta) editing
   in Slack/Telegram as a separate, opt-in follow-up.
