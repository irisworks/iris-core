#!/usr/bin/env bash
# start-all.sh — Start all Iris agents after VM boot.
# Typically called by a systemd service (iris-agents.service) on startup.
#
# Usage:
#   bash /iris/repo/agents/start-all.sh
#
# Add one line per agent. Each bootstrap.sh should return immediately
# (docker run -d) — agents start in parallel via Docker.

set -euo pipefail

echo "[start-all] $(date) — Starting Iris agents..."

# Resync secrets from Azure Key Vault before starting agents.
# Ensures every agent container gets fresh credentials on each restart.
bash /iris/data/skills/get-secret/sync-secrets

# Shared Docker network for inter-agent communication.
# Remove this line if your agents are fully isolated from each other.
docker network create iris-internal 2>/dev/null || true

# ── Add your agents below ─────────────────────────────────────────────────────
# bash /iris/repo/agents/<agent-name>/bootstrap.sh
# bash /iris/repo/agents/<agent-name-2>/bootstrap.sh
# ─────────────────────────────────────────────────────────────────────────────

echo "[start-all] $(date) — All agents started"
