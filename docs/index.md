---
title: What is Iris?
description: An AI operator that never clocks out — runs commands, writes its own skills, and manages sub-agent fleets over Slack, Telegram, and a built-in web UI.
---

# What is Iris?

**An AI operator that never clocks out.** Message it on Slack, Telegram, or its
built-in web UI and it
runs commands, writes its own skills on the fly, provisions infrastructure, and
spins up a fleet of specialized sub-agents — each one optionally sealed inside
its own Firecracker microVM — to get the work done.

It runs on any Linux machine — a laptop, VPS, or cloud VM. The default install
has **zero cloud dependencies**: secrets in `/iris/.env`, sub-agents in Docker.
Azure Key Vault, Terraform, and Firecracker isolation are opt-in profiles for
production hardening.

## Highlights

- **Self-extending** — Iris writes and hot-reloads her own skills; no redeploy to teach her something new
- **Fleet, not chatbot** — spins up specialized sub-agents on demand, each talking over an HTTP bridge
- **Defense in depth, opt-in** — Docker by default; flip a flag and every sub-agent runs in its own Firecracker microVM with a hardware KVM boundary
- **Provider-agnostic** — Anthropic, OpenAI, Azure AI Foundry, or AWS Bedrock, switchable via env vars
- **Three transports, one engine** — Slack, Telegram, and an optional built-in [web UI](web-ui.md); adding a transport requires zero engine edits
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
You (Slack, Telegram, or web UI)
└── Iris  (any Linux machine, systemd service)
    ├── iris-runtime          the TypeScript engine
    ├── data/CONSTITUTION.md  read-only operator rules, injected every prompt
    ├── data/MEMORY.md        mutable global memory
    ├── skills/               hot-reloaded capabilities
    └── sub-agents            Docker containers or Firecracker microVMs,
                              reached via an internal HTTP bridge
```
