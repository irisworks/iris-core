---
title: Sub-agents & Internal API
description: Spawning isolated sub-agents, the HTTP bridge, sandbox levels, and the session API.
---

# Sub-agents & Internal API

Sub-agents are separate runtime instances that Iris spawns and supervises — each
with its own constitution, memory, and skills, running in a Docker container or a
Firecracker microVM.

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

Sub-agents register in `agents.json` with a `bridge_url`; mentioning `@agentname`
routes the request over HTTP to that agent's bridge server, which processes it and
returns the reply. Escalations flow the other way: a sub-agent that can't self-heal
POSTs to Iris's `/escalate` endpoint.

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

Scaffolds for new sub-agents live in `agents/`; the `spawn-agent` skill automates
provisioning (two containers per agent: preview and prod).

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
| `POST /sessions/:id/message` | Inject a message, wait for Iris's response |
| `GET /sessions/:id/history` | Full message history |
| `POST /sessions/:id/reset` | Wipe session context |
| `POST /sessions/:id/inject-turn` | Append a human-agent turn without triggering the LLM |
| `POST /sessions/email-inbound` | Route inbound email to its session |

Sessions are the backbone of `thread`/`interactive-thread`
[channel modes](channel-modes.md) and of human-in-the-loop workflows (reset +
inject-turn let a human take over a conversation seamlessly).

## Scheduled events

Iris wakes herself: event files dropped in the workspace `events/` directories
(`slack/events/`, `telegram/events/`, `events/`) trigger immediate, one-shot, or
cron-scheduled (periodic) runs on any channel.
