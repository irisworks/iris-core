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
via `GET /secrets/:name`:

```json
{
  "newsletter": {
    "bridge_url": "http://172.18.0.2:4000",
    "secrets": ["SENDGRID_API_KEY"]
  }
}
```

Omitted or empty `secrets` = no access. Iris herself (not a sub-agent) is
unrestricted. See [get-secret](skills.md) and [Configuration](configuration.md) for
the resolution backends.

**This allow-list is best-effort, not a hard security boundary today.** Caller
identity comes from the self-reported `X-Iris-Caller` header, while
authentication is a single `IRIS_API_TOKEN` shared across every agent
container. Any caller holding that token can set `X-Iris-Caller: iris` and
bypass the allow-list entirely. With every sub-agent co-located on one VM under
`--sandbox=host` today, there's no isolation between agents for the allow-list
to defend against anyway, so this is reasonable as hygiene/audit-trail. It
stops being sufficient once agents run as separately isolated services — at
that point `caller` needs to be derived from *which token authenticated*
(per-service unique tokens), not from a self-reported header.

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
| `GET /secrets/:name` | Resolve a secret (`X-Iris-Caller` header; sub-agents must be allow-listed) |
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
