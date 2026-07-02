#!/usr/bin/env bash
# Bridge-only smoke test: boots the runtime with no transport tokens and
# verifies the internal API comes up. Requires `npm run build` to have run.
set -euo pipefail

RUNTIME_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="$(mktemp -d)"
PORT="${SMOKE_API_PORT:-3999}"

cleanup() {
  [[ -n "${PID:-}" ]] && kill "$PID" 2>/dev/null || true
  rm -rf "$WORKSPACE"
}
trap cleanup EXIT

# Minimal workspace: models.json from template, empty constitution/memory.
cp "$RUNTIME_DIR/../data/models.json.template" "$WORKSPACE/models.json" 2>/dev/null || echo '{}' > "$WORKSPACE/models.json"
touch "$WORKSPACE/CONSTITUTION.md" "$WORKSPACE/MEMORY.md"

env -u IRIS_SLACK_APP_TOKEN -u IRIS_SLACK_BOT_TOKEN -u TELEGRAM_BOT_TOKEN \
  node "$RUNTIME_DIR/dist/main.js" "$WORKSPACE" --api-port "$PORT" &
PID=$!

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "smoke: /health OK"
    exit 0
  fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "smoke: runtime exited early" >&2
    exit 1
  fi
  sleep 1
done

echo "smoke: /health did not come up within 30s" >&2
exit 1
