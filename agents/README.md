# Iris Sub-Agents

This directory contains sub-agent scaffolds, templates, and the multi-agent startup script.

## Quick Start

1. Copy the bootstrap template:
   ```bash
   cp agents/bootstrap.template.sh agents/<your-agent>/bootstrap.sh
   ```
2. Edit `AGENT_NAME` and fill in any agent-specific env vars.
3. Add your agent to `agents/start-all.sh`.
4. Create the agent's identity files (see structure below).

## Agent Directory Structure

```
agents/
├── start-all.sh              # Starts all agents on VM boot
├── bootstrap.template.sh     # Copy this to create a new agent
└── <your-agent>/
    ├── README.md             # What this agent does
    ├── CONSTITUTION.md       # Agent system prompt / persona
    ├── MEMORY.md             # Persistent memory and state
    ├── bootstrap.sh          # Starts the agent Docker container
    └── skills/               # Agent-specific skills (optional)
        └── <skill-name>/
            └── SKILL.md
```

## Deployment Patterns

### Pattern A — Slack Agent

The agent connects directly to Slack via Socket Mode. This is the default pattern.

```
Slack ──── iris-runtime (Docker) ──── LLM
```

Required env vars:
- `IRIS_SLACK_APP_TOKEN` — `xapp-...`
- `IRIS_SLACK_BOT_TOKEN` — `xoxb-...`

See the commented Pattern A section in `bootstrap.template.sh`.

### Pattern B — Bridge Agent

Use when the ingress channel is not Slack (Instagram DMs, Telegram, SMS, HTTP webhook, etc.).

```
External channel ──── bridge (Docker) ──── iris-runtime (Docker) ──── LLM
```

iris-runtime runs headless (no Slack tokens). The bridge container handles the
external protocol and forwards messages to iris-runtime via its HTTP session API.

See `iris-runtime/examples/bridge/` for a working reference implementation and
`iris-runtime/docs/bridge-pattern.md` for a full guide.

## Multi-Agent Startup (`start-all.sh`)

`agents/start-all.sh` is called by a systemd service on VM boot. It:
1. Resyncs secrets from Azure Key Vault
2. Creates the shared `iris-internal` Docker network
3. Starts each agent's `bootstrap.sh` in sequence

Edit the file to add or remove agents:
```bash
bash /iris/repo/agents/helpdesk/bootstrap.sh
bash /iris/repo/agents/ops/bootstrap.sh
```

Install it as a systemd service:
```ini
# /etc/systemd/system/iris-agents.service
[Unit]
Description=Iris Sub-Agents
After=iris.service docker.service
Wants=iris.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=azureuser
ExecStart=/bin/bash /iris/repo/agents/start-all.sh
StandardOutput=append:/iris/iris-agents.log
StandardError=append:/iris/iris-agents.log

[Install]
WantedBy=multi-user.target
```

## Shared Docker Network

All agents share the `iris-internal` Docker network. This allows:
- Agents to call each other's HTTP APIs by container name
- Bridge containers to reach iris-runtime at `http://iris-<agent>:3000`
- The host to reach agents via `host-gateway` (`--add-host=iris-host:host-gateway`)

## Private / Company-Specific Agents

Keep business-specific agents in your private overlay repo (not in iris-core).
See `CONTRIBUTING.md` for the overlay pattern.
