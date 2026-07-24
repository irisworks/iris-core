#!/usr/bin/env bash
# register-bridge.sh — shared helper for the `spawn-agent` skill: bridge port
# allocation, agents.json registration, and GitHub PAT detection.
#
# Used by both provisioning modes (service default, docker opt-in) so
# "Iris exposes it through the bridge" is one code path, not duplicated logic.
#
# Usage:
#   register-bridge.sh has-pat
#     Exit 0 if a GitHub PAT is configured (GITHUB_TOKEN env var, or
#     `get-secret GITHUB-TOKEN` resolves), exit 1 otherwise. Callers use this
#     to decide whether to attempt github-commit at all — no PAT means skip
#     it cleanly, not attempt-and-fail.
#
#   register-bridge.sh next-port [base]
#     Print the next free bridge port (default base 4200), scanning ports
#     already used by bridge_url entries in agents.json.
#
#   register-bridge.sh register <name> <bridge_url> <description> [token] [secrets_csv]
#     Merge { <name>: { bridge_url, description, [token], [secrets] } } into
#     agents.json under an flock, without disturbing any other agent's entry.
#     This is what makes `@name` resolvable immediately after spawn-agent runs.

set -euo pipefail

REGISTRY="${IRIS_AGENTS_REGISTRY:-/iris/data/agents.json}"
LOCK="${REGISTRY}.lock"

cmd="${1:-}"
[[ $# -gt 0 ]] && shift

case "$cmd" in
  has-pat)
    if [[ -n "${GITHUB_TOKEN:-}" ]]; then
      exit 0
    fi
    if command -v get-secret >/dev/null 2>&1 && get-secret GITHUB-TOKEN >/dev/null 2>&1; then
      exit 0
    fi
    exit 1
    ;;

  next-port)
    BASE="${1:-4200}"
    USED=""
    if [[ -f "$REGISTRY" ]]; then
      USED=$(jq -r '.[].bridge_url // empty' "$REGISTRY" 2>/dev/null | sed -E 's/.*:([0-9]+)$/\1/')
    fi
    PORT="$BASE"
    while grep -qx "$PORT" <<< "$USED"; do
      PORT=$((PORT + 1))
    done
    echo "$PORT"
    ;;

  register)
    NAME="${1:?Usage: register-bridge.sh register <name> <bridge_url> <description> [token] [secrets_csv]}"
    URL="${2:?bridge_url is required}"
    DESC="${3:-}"
    TOKEN="${4:-}"
    SECRETS_CSV="${5:-}"

    mkdir -p "$(dirname "$REGISTRY")"
    [[ -f "$REGISTRY" ]] || echo '{}' > "$REGISTRY"

    exec 200>"$LOCK"
    flock -x 200

    SECRETS_JSON="[]"
    if [[ -n "$SECRETS_CSV" ]]; then
      SECRETS_JSON=$(jq -R -c 'split(",")' <<< "$SECRETS_CSV")
    fi

    jq --arg name "$NAME" --arg url "$URL" --arg desc "$DESC" \
       --arg token "$TOKEN" --argjson secrets "$SECRETS_JSON" \
       '.[$name] = ((.[$name] // {}) + {bridge_url: $url, description: $desc}
         + (if $token != "" then {token: $token} else {} end)
         + (if ($secrets | length) > 0 then {secrets: $secrets} else {} end))' \
       "$REGISTRY" > "${REGISTRY}.tmp"
    mv "${REGISTRY}.tmp" "$REGISTRY"

    echo "[register-bridge] Registered '${NAME}' -> ${URL}"
    ;;

  *)
    echo "Usage: register-bridge.sh {has-pat|next-port [base]|register <name> <bridge_url> <description> [token] [secrets_csv]}" >&2
    exit 1
    ;;
esac
