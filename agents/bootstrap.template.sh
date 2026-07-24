#!/usr/bin/env bash
# bootstrap.template.sh — Template for starting an iris-runtime agent container.
#
# Copy to agents/<your-agent>/bootstrap.sh and fill in the placeholders.
# This file is a reference — do not run it directly.
#
# Two deployment patterns:
#
#   Pattern A — Slack agent
#     iris-runtime connects directly to Slack via Socket Mode.
#     Use for agents that live in a Slack workspace.
#
#   Pattern B — Bridge agent
#     iris-runtime runs headless (no Slack tokens).
#     A companion bridge container handles the external interface
#     (HTTP webhook, Telegram polling, SMS gateway, etc.) and forwards
#     messages to iris-runtime via its HTTP session API.
#     See: iris-runtime/examples/bridge/
#
# Prerequisites:
#   - iris-runtime image built: docker build -t iris-runtime:local ./iris-runtime
#   - /iris/.env populated (by bootstrap.sh --setup)
#   - /iris/.secrets.env populated (by sync-secrets) — legacy, env mode only

set -euo pipefail

# ── Agent identity ────────────────────────────────────────
AGENT_NAME="<your-agent>"           # e.g. "helpdesk", "ops", "support"
CONTAINER_NAME="iris-${AGENT_NAME}"

# ── Load secrets ──────────────────────────────────────────
# DEPRECATED: /iris/.secrets.env only exists on env-mode installs. With
# IRIS_SECRETS_MODE=store/proxy, secrets are fetched at use time via the
# get-secret skill (parent API allow-list) instead of being sourced here —
# see docs/secrets.md.
source /iris/.secrets.env 2>/dev/null || true

# ── Read provider / model from shared .env ────────────────
IRIS_PROVIDER=$(grep "^IRIS_PROVIDER" /iris/.env | cut -d= -f2- || echo "anthropic")
IRIS_MODEL=$(grep    "^IRIS_MODEL"    /iris/.env | cut -d= -f2- || echo "claude-sonnet-4-6")

# ──────────────────────────────────────────────────────────
# Pattern A: Slack/Telegram agent — uncomment and fill in token names.
#
# IMPORTANT: these must be a SEPARATE Slack app / Telegram bot minted for
# this agent specifically — never Iris's own IRIS_SLACK_APP_TOKEN /
# IRIS_SLACK_BOT_TOKEN / TELEGRAM_BOT_TOKEN. `--env-file /iris/.env` below
# already puts Iris's real tokens into this container's environment
# (regardless of whether Pattern A is used); if APP_TOKEN/BOT_TOKEN/
# TG_BOT_TOKEN below are left unset (the default, Pattern B / bridge-only),
# the -e overrides in the docker run command explicitly clear them back out.
# If you instead set these to Iris's own token values, this agent and Iris
# will both try to authenticate as the same bot — duplicate Socket Mode
# connections / Telegram getUpdates 409 conflicts — and one of them will
# intermittently stop responding.
# ──────────────────────────────────────────────────────────
# APP_TOKEN="${<AGENT>_SLACK_APP_TOKEN:-}"
# BOT_TOKEN="${<AGENT>_SLACK_BOT_TOKEN:-}"
# TG_BOT_TOKEN="${<AGENT>_TELEGRAM_BOT_TOKEN:-}"
#
# if [[ -z "$APP_TOKEN" || -z "$BOT_TOKEN" ]]; then
#   echo "ERROR: <AGENT>_SLACK_APP_TOKEN / <AGENT>_SLACK_BOT_TOKEN not set" >&2
#   exit 1
# fi

# ── Stop old container ────────────────────────────────────
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# ── Create workspace directory ────────────────────────────
mkdir -p "/iris/agents/${AGENT_NAME}/data"

# ── Start iris-runtime ────────────────────────────────────
docker run -d --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network iris-internal \
  --add-host=iris-host:host-gateway \
  --env-file /iris/.env \
  --env-file /iris/.secrets.env \
  -e AGENT_NAME="$AGENT_NAME" \
  -e IRIS_ENV=prod \
  -e IRIS_PROVIDER="$IRIS_PROVIDER" \
  -e IRIS_MODEL="$IRIS_MODEL" \
  -e IRIS_LLM_TIMEOUT_SECS=600 \
  -e IRIS_SLACK_APP_TOKEN="${APP_TOKEN:-}" \
  -e IRIS_SLACK_BOT_TOKEN="${BOT_TOKEN:-}" \
  -e TELEGRAM_BOT_TOKEN="${TG_BOT_TOKEN:-}" \
  -v "/iris/agents/${AGENT_NAME}/data:/workspace" \
  -v "/iris/repo/agents/${AGENT_NAME}/MEMORY.md:/workspace/MEMORY.md:ro" \
  -v "/iris/repo/agents/${AGENT_NAME}/CONSTITUTION.md:/workspace/CONSTITUTION.md:ro" \
  -v "/iris/repo/agents/${AGENT_NAME}/skills:/workspace/skills:ro" \
  -v "/iris/data/models.json:/workspace/models.json:ro" \
  iris-runtime:local --sandbox=host /workspace
  #
  # The three -e overrides above (IRIS_SLACK_APP_TOKEN / IRIS_SLACK_BOT_TOKEN /
  # TELEGRAM_BOT_TOKEN) are always passed, even empty — --env-file /iris/.env
  # injects Iris's own real tokens regardless of Pattern A/B, and Docker
  # applies -e after --env-file, so these clear them back out unless
  # APP_TOKEN/BOT_TOKEN/TG_BOT_TOKEN were set above (Pattern A). Do not
  # remove these three lines even if you're only using Pattern B.
  #
  # Caveat on Key-Vault-profile installs: if IRIS_KEY_VAULT is also set below
  # and the vault happens to store a secret under the exact name
  # IRIS-SLACK-APP-TOKEN/IRIS-SLACK-BOT-TOKEN/TELEGRAM-BOT-TOKEN (Iris's own),
  # engine/secrets.ts's env-mode fallback will still resolve it via Key Vault
  # even with the env var cleared here. Use secrets_mode store/proxy with an
  # allow-list (docs/secrets.md) if that isolation matters for this agent.
  #
  # Azure Key Vault (if agent uses get-secret skill):
  # -e IRIS_KEY_VAULT=<your-vault-name> \
  #
  # Azure credentials (if agent runs az CLI inside sandbox):
  # -v /home/azureuser/.azure:/root/.azure \

echo "${CONTAINER_NAME} started"
docker logs "$CONTAINER_NAME" --tail 5

# ──────────────────────────────────────────────────────────
# Pattern B: Bridge agent
#
# After iris-runtime is running above (without Slack tokens),
# build and start your bridge container. The bridge reaches
# iris-runtime at http://${CONTAINER_NAME}:3000 on the shared
# Docker network.
#
# See iris-runtime/examples/bridge/ for a full working example.
# ──────────────────────────────────────────────────────────
#
# BRIDGE_IMAGE="${AGENT_NAME}-bridge:local"
# BRIDGE_PORT=4300
# BRIDGE_API_KEY="${BRIDGE_API_KEY:-}"   # from .secrets.env
#
# if ! docker image inspect "$BRIDGE_IMAGE" &>/dev/null; then
#   echo "Building bridge image..."
#   docker build -t "$BRIDGE_IMAGE" "/iris/repo/agents/${AGENT_NAME}/bridge/"
# fi
#
# docker rm -f "${AGENT_NAME}-bridge" 2>/dev/null || true
#
# docker run -d --name "${AGENT_NAME}-bridge" \
#   --network iris-internal \
#   --restart unless-stopped \
#   -p "127.0.0.1:${BRIDGE_PORT}:${BRIDGE_PORT}" \
#   -e BRIDGE_PORT="$BRIDGE_PORT" \
#   -e BRIDGE_API_KEY="$BRIDGE_API_KEY" \
#   -e IRIS_BRIDGE_URL="http://${CONTAINER_NAME}:3000" \
#   "$BRIDGE_IMAGE"
#
# echo "${AGENT_NAME}-bridge started on :${BRIDGE_PORT}"
