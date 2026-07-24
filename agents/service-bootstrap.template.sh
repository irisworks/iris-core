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
#     something below adds it explicitly via Environment=.
#
#   NEVER add `EnvironmentFile=/iris/.env` to the unit to "fix" this, even
#   alongside an explicit `Environment=TELEGRAM_BOT_TOKEN=` (or Slack) meant to
#   clear it back out — systemd merges Environment=/EnvironmentFile= in the
#   order they appear in the unit file, last-one-for-each-variable-wins, and
#   an EnvironmentFile= line placed after the clearing Environment= line
#   silently restores Iris's real token from the file, undoing the clear.
#   This is exactly how a prior "fix" reintroduced the same credential leak
#   it was meant to close (see iris-runtime/CHANGELOG.md). There is no safe
#   ordering to rely on here — don't reference the live file at all. If this
#   agent needs specific values out of /iris/.env (an LLM key, IRIS_PROVIDER),
#   resolve them once at bootstrap time (like the block below) and embed the
#   resolved values as literal Environment= lines instead.

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

# ── LLM config: resolve once from /iris/.env, embed as literal values ────
# Prefer the secrets API (get-secret / IRIS_SECRET_BROKER_URL, see
# docs/secrets.md) over this when the install runs store/proxy mode — this
# grep fallback only applies to plain env-mode installs, and only reads the
# two non-secret provider/model settings here. If this agent also needs an
# LLM key and the install is env-mode, resolve it the same way (a single
# `grep "^ANTHROPIC_API_KEY" /iris/.env | cut -d= -f2-` line below) and add it
# as its own Environment= line — never via EnvironmentFile=.
IRIS_PROVIDER="$(grep "^IRIS_PROVIDER=" "${IRIS_DIR}/.env" 2>/dev/null | cut -d= -f2- || echo "anthropic")"
IRIS_MODEL="$(grep    "^IRIS_MODEL="    "${IRIS_DIR}/.env" 2>/dev/null | cut -d= -f2- || echo "claude-sonnet-4-6")"

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
Environment=IRIS_PROVIDER=${IRIS_PROVIDER}
Environment=IRIS_MODEL=${IRIS_MODEL}
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
