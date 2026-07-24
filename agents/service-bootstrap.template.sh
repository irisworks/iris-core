#!/usr/bin/env bash
# service-bootstrap.template.sh — Template for starting an iris-runtime agent
# as a plain systemd service. No Docker, no Terraform, no image build.
#
# Copy to agents/<your-agent>/bootstrap.sh and fill in the placeholders. This
# is the default path the `spawn-agent` skill uses: it reuses the same
# already-built iris-runtime binary Iris herself runs (see bootstrap.sh's
# "Build iris-runtime" step) with a different WorkingDirectory/AGENT_NAME, so
# there is no per-agent build or container — the unit is active in about a
# second.
#
# For an agent that specifically needs container isolation, use
# agents/bootstrap.template.sh + terraform/modules/agent instead
# (spawn-agent --mode=docker).
#
# Prerequisites:
#   - iris-runtime already built: iris.service itself won't run otherwise
#   - /iris/.env populated (by bootstrap.sh --setup) — for reference only.
#     Unlike iris.service, this agent does NOT inherit /iris/.env: dotenv's
#     default config resolves relative to process.cwd(), and this unit's
#     WorkingDirectory is ${AGENT_DATA_DIR} (not /iris where the file lives),
#     so nothing here loads it. That's intentional — the agent comes up
#     bridge-only, with no Slack/Telegram credentials, no LLM API key, unless
#     something below adds it explicitly via Environment=. Do not add
#     `EnvironmentFile=/iris/.env` to the unit to "fix" this — see the
#     Slack/Telegram warning below for why.

set -euo pipefail

# ── Agent identity ────────────────────────────────────────
AGENT_NAME="<your-agent>"            # e.g. "helpdesk", "ops", "support"
BRIDGE_PORT="<port>"                 # from: agents/lib/register-bridge.sh next-port
SERVICE_NAME="iris-agent-${AGENT_NAME}"

IRIS_DIR="${IRIS_DIR:-/iris}"
REPO_DIR="${IRIS_REPO_DIR:-/iris/repo}"
AGENT_DATA_DIR="${IRIS_DIR}/agents/${AGENT_NAME}/data"

NODE_BIN="$(which node)"
IRIS_RUNTIME_BIN="${REPO_DIR}/iris-runtime/dist/main.js"
DOTENV_CONFIG="${REPO_DIR}/iris-runtime/node_modules/dotenv/config"

# ── Workspace: symlink identity + skills from the repo checkout ──────────
mkdir -p "${AGENT_DATA_DIR}/events"
ln -sfn "${REPO_DIR}/agents/${AGENT_NAME}/MEMORY.md" "${AGENT_DATA_DIR}/MEMORY.md"
ln -sfn "${REPO_DIR}/agents/${AGENT_NAME}/skills"    "${AGENT_DATA_DIR}/skills"

# ── systemd unit ──────────────────────────────────────────
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null << UNIT
[Unit]
Description=Iris Sub-Agent: ${AGENT_NAME}
After=network-online.target iris.service
Wants=network-online.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${AGENT_DATA_DIR}
Environment=AGENT_NAME=${AGENT_NAME}
Environment=IRIS_ENV=prod
Environment=IRIS_BRIDGE_PORT=${BRIDGE_PORT}
ExecStart=${NODE_BIN} --require ${DOTENV_CONFIG} ${IRIS_RUNTIME_BIN} --sandbox=host ${AGENT_DATA_DIR}
Restart=always
RestartSec=10
StandardOutput=append:${IRIS_DIR}/agents/${AGENT_NAME}/${AGENT_NAME}.log
StandardError=append:${IRIS_DIR}/agents/${AGENT_NAME}/${AGENT_NAME}.log
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo "${SERVICE_NAME} started on port ${BRIDGE_PORT}"
sleep 1
sudo systemctl status "${SERVICE_NAME}" --no-pager -l | head -10

# ──────────────────────────────────────────────────────────
# Optional additions (uncomment / add as Environment= lines above):
#
# Slack/Telegram (agent connects directly instead of running bridge-only):
#   Environment=IRIS_SLACK_APP_TOKEN=xapp-...
#   Environment=IRIS_SLACK_BOT_TOKEN=xoxb-...
#   Environment=TELEGRAM_BOT_TOKEN=123456:AA...
#
#   IMPORTANT: these must be a SEPARATE Slack app / Telegram bot minted for
#   this agent specifically — never paste in Iris's own real
#   IRIS_SLACK_APP_TOKEN / IRIS_SLACK_BOT_TOKEN / TELEGRAM_BOT_TOKEN from
#   /iris/.env. Two processes authenticating as the same bot compete for the
#   same Socket Mode connection / Telegram getUpdates poll — one of them
#   (usually this agent) will intermittently stop responding, which looks
#   like a hang or a random silent failure rather than an obvious error.
#
# self-heal escalation (added automatically by `spawn-agent --with-self-heal`):
#   Environment=IRIS_API_URL=http://127.0.0.1:3000
#   Environment=IRIS_EVENTS_DIR=${IRIS_DIR}/data/events
# ──────────────────────────────────────────────────────────
