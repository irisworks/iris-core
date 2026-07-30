---
title: Observability (Langfuse)
description: Emit Langfuse traces for every Iris turn, correlated by session id, with token, cost, and tool-call detail.
---

# Observability (Langfuse)

Iris can emit a [Langfuse](https://langfuse.com) trace for every turn she runs.
Tracing is **off by default** and turns on as soon as a public/secret key pair is
present in the environment. When it is off, nothing is sent and no code path
changes.

Each trace is stamped with a **session id**, so a run's cost, tokens, and tool
calls can be read back with a single Langfuse call:

```
GET {LANGFUSE_HOST}/api/public/sessions/{sessionId}
```

## Configuration

Set these in `/iris/.env` (or the service environment):

| Variable | Required | Meaning |
| --- | --- | --- |
| `LANGFUSE_PUBLIC_KEY` | yes | Langfuse project public key (`pk-...`). Tracing stays off without it. |
| `LANGFUSE_SECRET_KEY` | yes | Langfuse project secret key (`sk-...`). Tracing stays off without it. |
| `LANGFUSE_HOST` | no | Base URL of the Langfuse instance. Defaults to `https://cloud.langfuse.com`. `LANGFUSE_BASE_URL` is accepted as an alias. |
| `LANGFUSE_ENVIRONMENT` | no | Environment bucket recorded on traces (e.g. `production`, `staging`). |
| `LANGFUSE_RELEASE` | no | Release/version string recorded on traces. |
| `LANGFUSE_TIMEOUT_MS` | no | Per-request ingestion timeout. Default `5000`. |
| `LANGFUSE_ENABLED` | no | Set to `false` or `0` to disable tracing even when keys are present. |

Iris talks to the public ingestion API (`POST /api/public/ingestion`) over
plain HTTP with basic auth — no Langfuse SDK is installed.

## What a trace contains

One trace per turn, named `iris-turn`:

- `sessionId` — the correlation key (see below)
- `userId` — the display name of the user who sent the message
- `input` / `output` — the user message and Iris's final reply
- `tags` — `iris`, plus `transport:<slack|telegram|web|…>`
- `metadata` — channel id, channel name, message timestamp, provider, model,
  stop reason, error message, and turn totals (cost, input/output/cache tokens)

Inside the trace:

- a **generation** per assistant message, with that message's model,
  `usageDetails` (input, output, cache-read, cache-write tokens) and
  `costDetails` in USD — so Langfuse's own trace and session totals add up
- a **`TOOL` observation** per tool call, named after the tool, with its
  arguments, result, timing, and `ERROR` level when the call failed

Input/output fields are truncated at 20,000 characters.

## Session correlation

The `sessionId` on a trace is:

- for session channels (`SESSION-<uuid>`, created by `POST /sessions` or
  `POST /sessions/open`) — the bare session UUID, exactly the value the API
  returned to the caller
- for any other channel — the channel id itself

`POST /sessions/:id/message` echoes `sessionId` alongside `text` in its
response, so a caller that only holds a turn response can still resolve the
session to look up its traces.

Multi-turn sessions accumulate one trace per turn under the same session id;
Langfuse aggregates them at the session level.

## Failure behaviour

Tracing is best-effort and never affects a run:

- missing keys — no-op, no requests
- ingestion errors, timeouts, or an unreachable host — logged once per failure
  streak as a warning, run outcome unchanged
- traces are flushed at the end of each turn (both the success and error paths),
  so the trace is queryable as soon as the turn's response is returned

## Verifying

With keys set, run a turn and look for this line in `journalctl -u iris -f`:

```
Langfuse tracing enabled → https://cloud.langfuse.com
[SESSION-<uuid>] Langfuse trace <traceId> (session <uuid>)
```

Then confirm the trace landed:

```bash
curl -s -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  "${LANGFUSE_HOST:-https://cloud.langfuse.com}/api/public/sessions/<uuid>" | jq '.traces[].totalCost'
```
