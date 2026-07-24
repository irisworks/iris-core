# Iris Sub-Agents

This directory contains sub-agent scaffolds, templates, and startup scripts.

## Quick Start

Use the `spawn-agent` skill — it asks for a name and one-line purpose, then
scaffolds and starts the agent for you (default: a systemd service, no
Terraform, no Docker; `@name` is bridge-reachable immediately). See
`skills/spawn-agent/SKILL.md` for the full flow and flags.

The manual steps below are what `spawn-agent` runs under the hood — read them
if you're debugging a spawn, adding a flag, or provisioning by hand.

## Agent Directory Structure

```
agents/
├── start-all.sh                    # Starts all --mode=docker agents on VM boot
├── service-bootstrap.template.sh   # Default: copy this for a new service-mode agent
├── bootstrap.template.sh           # Advanced: copy this for a new --mode=docker agent
├── lib/register-bridge.sh          # Shared: bridge port allocation + agents.json registration + PAT check
└── <your-agent>/
    ├── README.md             # What this agent does
    ├── MEMORY.md             # Persistent memory / constitution
    ├── bootstrap.sh          # Starts this agent (service or docker, copied from a template above)
    └── skills/               # Agent-specific skills (empty by default — opt in via --with-skill/--with-self-heal)
```

## Default path — service mode (no Terraform, no Docker)

1. `spawn-agent <name> <purpose>` (or copy `agents/service-bootstrap.template.sh`
   to `agents/<name>/bootstrap.sh` by hand and fill in `AGENT_NAME`/`BRIDGE_PORT`).
2. `bash agents/<name>/bootstrap.sh` installs and starts `iris-agent-<name>.service`,
   reusing the same already-built `iris-runtime` binary Iris herself runs — no
   per-agent build, no container, active in about a second.
3. `agents/lib/register-bridge.sh register <name> <bridge_url> <purpose>` patches
   the agent into `/iris/data/agents.json` so `@<name>` works immediately.

This is the right default for trusted, low-risk agents where the point is to
get something running fast. It shares Iris's host user/process/filesystem —
there is no isolation boundary. Use the advanced path below when that's not
acceptable for a given agent.

## Advanced — `--mode=docker` (container isolation)

Use when an agent specifically needs its own filesystem/network namespace
(untrusted, public-facing, or higher-blast-radius work).

### Pattern A — Slack Agent

The agent connects directly to Slack via Socket Mode.

```
Slack ──── iris-runtime (Docker) ──── LLM
```

Required env vars: `IRIS_SLACK_APP_TOKEN` (`xapp-...`), `IRIS_SLACK_BOT_TOKEN` (`xoxb-...`).
See the commented Pattern A section in `bootstrap.template.sh`. (Service-mode
agents can use this pattern too — set the same two vars as `Environment=` lines
in the systemd unit instead of container `-e` flags.)

### Pattern B — Bridge Agent

Use when the ingress channel is not Slack (Instagram DMs, Telegram, SMS, HTTP webhook, etc.).

```
External channel ──── bridge (Docker) ──── iris-runtime (Docker) ──── LLM
```

iris-runtime runs headless (no Slack tokens). The bridge container handles the
external protocol and forwards messages to iris-runtime via its HTTP session API.

See `iris-runtime/examples/bridge/` for a working reference implementation and
`iris-runtime/docs/bridge-pattern.md` for a full guide.

### Provisioning

`--mode=docker` provisions via `terraform/modules/agent` (see
`skills/spawn-agent/SKILL.md`'s advanced section), not `bootstrap.template.sh`
directly — the module runs the equivalent `docker run` for you. Set
`enable_docker_agents = true` once, the first time this mode is used, so the
shared `iris-runtime:local` image build in `terraform/main.tf` actually runs
(it's gated off by default so service-mode-only installs never pay that cost).

`start-all.sh`/`bootstrap.template.sh` remain as a plain-bash alternative to
the Terraform module for `--mode=docker` agents specifically — not a third
provisioning system, just a non-Terraform way to run the same containers.
Prefer the Terraform module for anything you want tracked as infrastructure
state; use `start-all.sh` only for a quick manual container you don't need
Terraform to manage.

## Multi-Agent Startup (`start-all.sh`)

`agents/start-all.sh` is for `--mode=docker` agents only — service-mode agents
are managed by systemd directly (`enable`d units start themselves on boot, no
separate startup script needed). Called by a systemd service on VM boot:
1. Resyncs secrets from Azure Key Vault
2. Creates the shared `iris-internal` Docker network
3. Starts each docker-mode agent's `bootstrap.sh` in sequence

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

`--mode=docker` agents share the `iris-internal` Docker network. This allows:
- Agents to call each other's HTTP APIs by container name
- Bridge containers to reach iris-runtime at `http://iris-<agent>:3000`
- The host to reach agents via `host-gateway` (`--add-host=iris-host:host-gateway`)

Service-mode agents don't need this — they're host processes, reachable at
`127.0.0.1:<bridge_port>` like any other local service.

## Private / Company-Specific Agents

Keep business-specific agents in your private overlay repo (not in iris-core).
See `CONTRIBUTING.md` for the overlay pattern.
