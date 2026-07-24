#!/usr/bin/env bash
# bootstrap.sh — Crossword solver agent
set -euo pipefail

AGENT_NAME="crossword"
CONTAINER_NAME="iris-${AGENT_NAME}"

# Provider / model from host .env
IRIS_PROVIDER=$(grep "^IRIS_PROVIDER" /iris/.env | cut -d= -f2- || echo "anthropic")
IRIS_MODEL=$(grep "^IRIS_MODEL" /iris/.env | cut -d= -f2- || echo "claude-sonnet-4")

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

mkdir -p "/iris/agents/${AGENT_NAME}/data"

docker run -d --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network iris-internal \
  --add-host=iris-host:host-gateway \
  --env-file /iris/.env \
  -e AGENT_NAME="$AGENT_NAME" \
  -e IRIS_ENV=prod \
  -e IRIS_PROVIDER="$IRIS_PROVIDER" \
  -e IRIS_MODEL="$IRIS_MODEL" \
  -e IRIS_LLM_TIMEOUT_SECS=600 \
  -e IRIS_EVENTS_DIR=/iris/data/events \
  -v "/iris/agents/${AGENT_NAME}/data:/workspace" \
  -v "/iris/repo/agents/${AGENT_NAME}/MEMORY.md:/workspace/MEMORY.md:ro" \
  -v "/iris/repo/agents/${AGENT_NAME}/skills:/workspace/skills:ro" \
  -v "/iris/data/models.json:/workspace/models.json:ro" \
  -v "/iris/data/events:/iris/data/events" \
  iris-runtime:local --sandbox=host /workspace

echo "${CONTAINER_NAME} started"
docker logs "$CONTAINER_NAME" --tail 10
