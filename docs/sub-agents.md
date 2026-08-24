---
title: Sub-agents & Internal API
description: Spawning isolated sub-agents, the HTTP bridge, sandbox levels, and the session API.
---

# Sub-agents & Internal API

Sub-agents are separate runtime instances that Iris spawns and supervises — each
with its own constitution, memory, and skills. The `spawn-agent` skill's default
path runs them as a plain systemd service on the host (no Terraform, no Docker);
`--mode=docker` and Firecracker microVMs are opt-in for agents that specifically
need container/VM isolation.

## Sandboxing levels

Iris's bash tool executes at one of four isolation levels (`--sandbox`):

| Mode | Flag | Use case |
|---|---|---|
| Host | `--sandbox=host` | Iris herself — trusted ops, full access |
| Docker | `--sandbox=docker:<name>` | Containerized sub-agents |
| Static Firecracker | `--sandbox=firecracker:<ip>` | Persistent sub-agent at a fixed IP |
| Dynamic pool | `--sandbox=firecracker-pool` | Fresh microVM per channel, auto-destroyed after 30 min idle |

Each microVM is defended in depth: KVM hardware boundary → minimal Firecracker VMM
→ jailer (chroot, uid 10000, seccomp) → per-VM `/30` TAP network → ephemeral
rootfs destroyed with the VM.

## The bridge

Sub-agents register in `agents.json` with a `bridge_url`; a message addressed to
that agent routes over HTTP to its bridge server, which processes it and returns
the reply. Escalations flow the other way: a sub-agent that can't self-heal POSTs
to Iris's `/escalate` endpoint.

`spawn-agent` writes this registration itself — via `agents/lib/register-bridge.sh
register`, under an `flock` so concurrent spawns can't clobber each other's entries
— as an unconditional step of both the default service-mode flow and `--mode=docker`.
There is no flag to skip it: `@agentname` is meant to work immediately after
creation, not after a separate manual registration step.

**How `@agentname` is actually detected differs by transport:**

- **Slack and Telegram**: a **leading** `@name` prefix (start of message, after
  trimming whitespace) is matched deterministically against `agents.json` —
  `parseAgentMention()` in `iris-runtime/src/engine/bridge.ts`, wired into
  `slack.ts`'s `app_mention`/`message` handlers and `telegram.ts`'s
  `handleUpdate` — and on a match, Iris's own LLM turn is skipped entirely for
  that message: the transport calls `callAgentBridge()` directly and posts the
  reply itself on the same channel/thread. A `@name` that doesn't match a
  known agent, or one that appears mid-message rather than as a prefix, falls
  through unchanged to Iris's normal handling — including the **intent-based**
  routing built into her own system prompt (`engine/agent.ts`: "route by
  intent, no @mention required, call the sub-agent's bridge via bash"), which
  still runs her LLM and lets it decide whether to delegate.
- **Web UI**: deterministic too, but not text-based — the browser client sets
  an explicit `?agent=` query param on its WebSocket connection
  (`transports/web/web.ts`), not a parsed `@name`.

Each transport passes a stable conversation key (Slack channel+thread,
Telegram channel, web session) into `callAgentBridge()`, so repeated
`@mentions` from the same origin reuse the same sub-agent session and its
prior turns — a fresh conversation elsewhere gets a fresh session.

**A reply is never dropped just because nothing posted it.** A bridge call is an
HTTP request that the sub-agent's run normally answers by posting to its
`BRIDGE-{requestId}` channel. If a run instead finishes silently or throws, the
engine resolves the waiting request from whatever the run did produce (or an
explicit `(run failed: …)`) rather than leaving the caller to time out with
nothing. Progress markers such as `_→ running bash_` are excluded from that
salvaged reply, so the caller gets the answer on its own.

### Long-running replies and progress

`POST /bridge` answers in one of two shapes, chosen by the request's `Accept`
header:

| Request | Response |
|---|---|
| `Accept: application/x-ndjson` | A chunked NDJSON stream: one JSON object per line. |
| anything else | A single `{"text": …, "requestId": …}` body, as before. |

`callAgentBridge()` asks for the stream by default, so every `@mention` and
`?agent=` route uses it; the plain body remains for `curl … \| jq -r '.text'` and
for sub-agents running an older runtime, which ignore the header. The client
branches on the response's content type rather than on what it asked for, so a new
Iris talking to an old sub-agent keeps working.

Stream lines are:

```jsonl
{"type":"accepted","requestId":"slack-C123","protocol":1}
{"type":"status","text":"→ running bash"}
{"type":"heartbeat"}
{"type":"final","text":"the answer","requestId":"slack-C123"}
```

Exactly one terminal line closes the stream — `final`, or
`{"type":"error","error":…,"code":…}`. **An error arrives on an already-200
response**, since the status line goes out before the run starts; that up-front
flush is the whole point, because Node's `fetch` caps time-to-first-header at
about 300 seconds and the blocking shape cannot answer later than that. Clients
must ignore line types they don't recognize, so the protocol can grow.

Status lines come from the same per-tool-call signal a local run shows
(`ctx.setStatus`), truncated to 200 characters. Slack and Telegram post a
placeholder, edit it in place as progress arrives, and replace it with the reply;
the Web UI gets `status` frames on its existing websocket. Chat edits are
throttled — Slack's `chat.update` and Telegram's `editMessageText` are limited to
roughly one call per second per channel — so what you see is "what it's doing
now", not every step.

Nothing has a fixed overall deadline any more. A request lives as long as the agent
keeps making progress, bounded by:

| Variable | Default | Meaning |
|---|---|---|
| `IRIS_BRIDGE_IDLE_TIMEOUT_MS` | `180000` | No progress for this long ⇒ `idle_timeout`. Heartbeats deliberately don't count — they prove the connection is alive, never the agent. |
| `IRIS_BRIDGE_MAX_MS` | `600000` | Hard ceiling on one request, so a looping agent can't hold it (and burn tokens) indefinitely. |
| `IRIS_BRIDGE_HEARTBEAT_MS` | `15000` | Keepalive cadence on a streaming response. |
| `IRIS_BRIDGE_LEGACY_TIMEOUT_MS` | `240000` | Ceiling for non-streaming requests. Keep it under ~300s. |
| `IRIS_BRIDGE_STATUS_THROTTLE_MS` | `3000` | Minimum gap between chat edits while forwarding progress. |

Two caveats worth knowing. The open connection *is* the job handle: if it drops, or
if Iris restarts mid-request, the reply is lost even though the sub-agent finished
the work. And behind a response-buffering proxy the stream degrades to arriving all
at once — the reply still lands, but the progress and liveness signals don't.
`X-Accel-Buffering: no` is set for nginx; the default loopback topology is
unaffected.

In every case, the sub-agent's own process never touches Slack/Telegram/the
Web UI directly — whichever transport originally received the message (already
holding its channel/thread context) is the one that posts the reply, using its
own credentials.

Each agent entry may also declare a `secrets` allow-list — the names it may request
via `GET /secrets/:name` — and a per-agent `token` so the API can tell agents apart:

```json
{
  "digest": {
    "bridge_url": "http://172.18.0.2:4000",
    "secrets": ["SENDGRID_API_KEY"],
    "token": "<value from terraform/modules/agent's api_token output>"
  }
}
```

Omitted or empty `secrets` = no access. Iris herself (not a sub-agent) is
unrestricted. See [get-secret](skills.md) and [Configuration](configuration.md) for
the resolution backends.

**Deciding the allow-list is `spawn-agent`'s job, not a manual afterthought.**
A skill's `SKILL.md` frontmatter may declare `secrets: [NAME, ...]` — the
secret names its script actually resolves (see [Skills](skills.md)). When
`spawn-agent` attaches a skill to a new agent, it collects every attached
skill's `secrets:` entries and passes them to
`agents/lib/register-bridge.sh register`'s `secrets_csv` argument, which
merges them into this `secrets` array. Skip this and the skill fails the
moment it's invoked (a 403 from `GET /secrets/:name`), not at spawn time —
the agent looks fully set up until then.

With the host's `IRIS_SECRETS_MODE` set to `store` or `proxy`,
`terraform/modules/agent`'s `secrets_mode` variable (default `"env"`, matching
today's behavior) stops passing the whole `--env-file /iris/.env` to the
container — the agent gets only its identity and an `IRIS_SECRET_BROKER_URL`
pointing at the parent's API, and resolves everything through the `secrets`
allow-list above. That means the allow-list must now include **every**
secret the agent needs, including its own LLM key (e.g. `"ANTHROPIC-API-KEY"`)
— nothing arrives implicitly anymore. This mode requires
`unique_api_token = true` (enforced by a Terraform precondition), since the
per-agent token is what the parent uses to scope the allow-list. See
[Secrets](secrets.md).

**Caller identity comes from which token authenticated the request, not from a
self-reported header.** Set `unique_api_token = true` on an agent's
`terraform/modules/agent` module block and its container gets its own
`IRIS_API_TOKEN` (overriding the shared one from `.env`, exposed as the
module's `api_token` output); register that value as the agent's `token` above
and the API matches the presented bearer token to derive `caller`, so a caller
holding only its own per-agent token cannot claim to be another agent or the
unrestricted `iris` caller — including a compromised sub-agent. Enable it
agent-by-agent: once the flag is on, that agent's API calls return 401 until
its `token` is registered in `agents.json`, so copy the token in as part of
the same change. With the flag off (the default) — or for an agent entry with
no `token` set — the agent authenticates with the shared `IRIS_API_TOKEN`,
which is always treated as unrestricted `iris`; give every agent that needs
the allow-list enforced its own token.

Treat `agents.json` as a secrets file once `token` fields are in it: keep file
permissions tight and never commit it to version control (the token values are
random strings that secret scanners won't reliably flag).

**Credential isolation for Slack/Telegram.** A sub-agent that only needs to be
reachable via the bridge (the default, both service-mode and `--mode=docker`)
needs no Slack/Telegram credentials at all — the bridge server is a plain HTTP
listener, unrelated to either platform. If an agent should *also* connect
directly to Slack/Telegram itself (Pattern A in `agents/README.md`), it needs
its own **separate** bot: never reuse Iris's own `IRIS_SLACK_APP_TOKEN` /
`IRIS_SLACK_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN`. Two processes authenticating as
the same bot compete for the same Socket Mode connection / Telegram
`getUpdates` poll (Telegram returns 409 "terminated by other getUpdates
request" to whichever loses), and the symptom looks like the agent
intermittently not responding rather than an obvious error. `--mode=docker`'s
Terraform module (`terraform/modules/agent`) always passes these three as
explicit, empty-by-default `-e` overrides specifically so `--env-file
/iris/.env` can't leak Iris's own tokens into a bridge-only container by
default — set `slack_app_token`/`slack_bot_token`/`telegram_bot_token` to a
distinct bot's credentials only when Pattern A is actually wanted. The
equivalent applies to `agents/bootstrap.template.sh` and to
`agents/service-bootstrap.template.sh`'s `Environment=` lines.

**This ordering guarantee does not extend to a systemd unit.** Docker
guarantees `-e` overrides apply after `--env-file`, but systemd merges
`Environment=`/`EnvironmentFile=` in unit-file order, last-one-per-variable
wins — an `EnvironmentFile=/iris/.env` line added after an explicit
`Environment=TELEGRAM_BOT_TOKEN=` clear silently restores the real token from
the file. Never add `EnvironmentFile=/iris/.env` to a service-mode sub-agent's
unit at all; if it needs a specific value out of `/iris/.env` (an LLM key,
`IRIS_PROVIDER`), resolve it once at bootstrap time and embed the resolved
value as its own literal `Environment=` line, the way
`agents/service-bootstrap.template.sh` resolves `IRIS_PROVIDER`/`IRIS_MODEL`.

The `iris-runtime:local` Docker image used by `--mode=docker` agents is built
once, by a single shared `null_resource.iris_runtime_image` in `terraform/main.tf`,
not per agent module — every agent module instance just depends on it instead of
re-running its own `npm run build && docker build`. That resource is gated behind
`var.enable_docker_agents` (default `false`), so an install that never uses
`--mode=docker` doesn't pay an image-build cost on unrelated `terraform apply` runs.

Scaffolds for new sub-agents live in `agents/`; the `spawn-agent` skill automates
provisioning. The default flow provisions one systemd service per agent
(`agents/service-bootstrap.template.sh`) — no Docker, no Terraform, no
preview/prod split. `--mode=docker` provisions one Docker container per agent
via `terraform/modules/agent` (also no preview/prod split — that can be
re-introduced later if needed). Commits made along the way (scaffold files,
`terraform/agents.tf`) are skipped entirely when no GitHub PAT is configured
in the environment, rather than attempted and left to fail.

Every `agents/...` path the skill runs (`agents/lib/register-bridge.sh`,
`agents/service-bootstrap.template.sh`, the new agent's own scaffold) is
relative to the repo checkout, not to Iris's own working directory
(`/iris/data`) — the skill opens with `cd "${IRIS_REPO_DIR:-/iris/repo}"`
for exactly this reason; skip that and every relative path below it resolves
against the wrong directory. Filling in a copied `bootstrap.sh`'s
`AGENT_NAME`/`BRIDGE_PORT` placeholders must also happen as a single `sed`
pass, not as two separate edits to the same file — concurrent edits race on
the read-modify-write and one substitution can get silently clobbered back to
its placeholder. And when verifying a freshly spawned agent, its `/health`
lives on the internal API port (`IRIS_API_PORT`, `BRIDGE_PORT+100` for
service mode), not the bridge port — the bridge server only implements
`POST /bridge` and 404s on anything else, including `GET /health`.

## Internal HTTP API

The runtime exposes an internal API (default `127.0.0.1:3000`, always on — see
[Configuration](configuration.md) for bind/auth):

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness (never requires auth) |
| `GET /channels` | Active channel states |
| `POST /event` | Inject an immediate event into Iris's queue |
| `POST /escalate` | Sub-agent escalation |
| `GET /secrets/:name` (alias `GET /secret/:name`) | Resolve a secret (caller derived from the authenticating token; sub-agents must be allow-listed; 403 for proxy-only/runtime-only secrets — see [Secrets](secrets.md)) |
| `PUT`/`DELETE /secrets/:name` · `GET /secrets` | Write/delete/list secrets (iris only) |
| `POST /secret-drops` | Mint a one-time out-of-band submission link (iris only) |
| `POST /sessions` · `GET /sessions` · `GET/PATCH /sessions/:id` | Session CRUD |
| `POST /sessions/open` | Post to a channel + create a session in one call |
| `POST /sessions/:id/message` | Inject a message, wait for Iris's response — body `{text, user?, attachments?}` |
| `POST /sessions/:id/attachments` | Upload a file into the session's `attachments/` dir (raw body + `X-Filename`), returns the `local` handle for the `attachments` field |
| `POST /sessions/:id/stop` | Abort the session's in-flight turn |
| `GET /sessions/:id/history` | Full message history |
| `POST /sessions/:id/reset` | Wipe session context |
| `POST /sessions/:id/inject-turn` | Append a human-agent turn without triggering the LLM |
| `POST /sessions/email-inbound` | Route inbound email to its session |

Sessions are the backbone of `thread`/`interactive-thread`
[channel modes](channel-modes.md) and of human-in-the-loop workflows (reset +
inject-turn let a human take over a conversation seamlessly).

Every turn is durably logged: the injected user message and Iris's final reply
are both appended to the session's `SESSION-<id>/log.jsonl`, no matter which
transport served the turn (Slack, Telegram, or a headless bridge/web install).
This is what `GET /sessions/:id/history` returns and what gets replayed into
context after a restart.

### Driving a session from your own application

This API — not the [web UI transport](web-ui.md) — is the integration surface
for a program driving Iris. A typical turn is three calls on this one port,
under one token:

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

Two things this API does not do yet: stream a turn's progress (the reply
arrives only when the turn ends — watch the [web UI](web-ui.md) socket
meanwhile, or wait for `GET /sessions/:id/stream`), and accept attachments by
URL (it never fetches; you send the bytes or place the file yourself).

`IRIS_API_TOKEN` also authorizes secrets management and channel-addressed event
injection, so it must stay server-side — never ship it to a browser.

## Scheduled events

Iris wakes herself: event files dropped in the workspace `events/` directories
(`slack/events/`, `telegram/events/`, `events/`) trigger immediate, one-shot, or
cron-scheduled (periodic) runs on any channel.
