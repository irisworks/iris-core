---
title: What is Iris?
description: An always-on AI orchestrator that runs commands, writes its own skills, and manages sub-agent fleets over Slack and Telegram.
---

# What is Iris?

Iris is an always-on AI orchestrator. It runs on any Linux machine — a laptop, VPS,
or cloud VM — listens on **Slack and/or Telegram**, and does real work: it runs
commands, writes and hot-reloads its own skills, provisions infrastructure, and
manages a fleet of specialized sub-agents, each optionally isolated in its own
Firecracker microVM.

The default install has **zero cloud dependencies**: secrets in `/iris/.env`,
sub-agents in Docker. Azure Key Vault, Terraform, and Firecracker isolation are
opt-in profiles for production hardening.

## Highlights

- **Provider-agnostic** — Anthropic, OpenAI, Azure AI Foundry, or AWS Bedrock, switchable via env vars
- **Skills** — plain directories with a `SKILL.md`; hot-reload without restart; Iris can write her own
- **Sub-agents** — spawned in Docker containers or Firecracker microVMs, talking over an HTTP bridge
- **Resilient** — LLM retry with backoff, automatic context compaction, self-healing escalation
- **Durable** — GitHub is the source of truth; the machine is disposable and rebuildable from the repo

## Install in one command

```bash
curl -fsSL https://raw.githubusercontent.com/irisworks/iris-core/main/install.sh | bash
```

See [Setup](SETUP.md) for all four install paths (± Azure Key Vault, ± Firecracker),
then [Configuration](configuration.md) and [Channel Modes](channel-modes.md) to
shape how Iris behaves.

## How it fits together

```
You (Slack or Telegram)
└── Iris  (any Linux machine, systemd service)
    ├── iris-runtime          the TypeScript engine
    ├── data/CONSTITUTION.md  read-only operator rules, injected every prompt
    ├── data/MEMORY.md        mutable global memory
    ├── skills/               hot-reloaded capabilities
    └── sub-agents            Docker containers or Firecracker microVMs,
                              reached via an internal HTTP bridge
```
