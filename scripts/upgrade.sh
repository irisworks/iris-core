#!/usr/bin/env bash
# ============================================================
# upgrade.sh — upgrade an Iris install to the latest (or a given) release
# tag, without re-prompting for secrets. Auto-detects which of the two
# documented shapes (docs/overlay.md) you're running:
#
#   Pinned clone (install.sh)     — $IRIS_DIR/repo is a plain checkout of
#                                    iris-core; bumps it in place and
#                                    re-runs bootstrap.sh non-interactively.
#   Overlay + submodule           — run from inside the overlay repo (the
#                                    one with core/ as a submodule); bumps
#                                    the submodule pin, rebuilds, restarts.
#
#   bash scripts/upgrade.sh              # latest release tag
#   bash scripts/upgrade.sh v1.3.1       # specific tag
#
# Env overrides: IRIS_DIR (default /iris), IRIS_CORE_URL.
# ============================================================
set -euo pipefail

IRIS_DIR="${IRIS_DIR:-/iris}"
IRIS_CORE_URL="${IRIS_CORE_URL:-https://github.com/irisworks/iris-core.git}"
TARGET_REF="${1:-}"

log() { echo "[iris-upgrade] $*"; }

resolve_latest_tag() {
  git ls-remote --tags --sort=-v:refname "$IRIS_CORE_URL" 'v*' 2>/dev/null \
    | awk '{print $2}' | sed 's|refs/tags/||' | grep -v '\^{}$' | head -n1
}

verify_tag() {
  local repo_dir="$1" ref="$2"
  local verify_script="$repo_dir/scripts/verify-tag-signature.sh"
  if [[ -f "$verify_script" ]]; then
    bash "$verify_script" "$repo_dir" "$ref"
  else
    log "$verify_script not found — skipping signature verification"
  fi
}

PINNED_REPO_DIR="$IRIS_DIR/repo"
IS_PINNED_CLONE=false
IS_SUBMODULE_OVERLAY=false

[[ -d "$PINNED_REPO_DIR/.git" ]] && IS_PINNED_CLONE=true
if git submodule status -- core &>/dev/null && [[ -n "$(git submodule status -- core 2>/dev/null)" ]]; then
  IS_SUBMODULE_OVERLAY=true
fi

if [[ "$IS_PINNED_CLONE" == true && "$IS_SUBMODULE_OVERLAY" == true ]]; then
  log "Both a pinned clone ($PINNED_REPO_DIR) and a core/ submodule were found here."
  log "Run this script from the overlay repo root for the submodule upgrade,"
  log "or with IRIS_DIR pointed elsewhere for the pinned-clone upgrade."
  exit 1
elif [[ "$IS_SUBMODULE_OVERLAY" == true ]]; then
  # ── Overlay + submodule shape ──────────────────────────────────────
  [[ -n "$TARGET_REF" ]] || {
    log "Resolving latest release tag from $IRIS_CORE_URL"
    TARGET_REF="$(resolve_latest_tag)"
    [[ -n "$TARGET_REF" ]] || { log "No release tags found on $IRIS_CORE_URL."; exit 1; }
  }

  log "Bumping core/ submodule to $TARGET_REF"
  git -C core fetch --tags origin
  git -C core checkout "$TARGET_REF"
  verify_tag "$(pwd)/core" "$TARGET_REF"

  log "Rebuilding iris-runtime"
  (cd core/iris-runtime && npm ci && npm run build)

  git add core
  git commit -m "core: $TARGET_REF"
  log "Committed submodule bump. Restarting iris.service..."
  sudo systemctl restart iris

elif [[ "$IS_PINNED_CLONE" == true ]]; then
  # ── Pinned-clone shape ──────────────────────────────────────────────
  [[ -f "$IRIS_DIR/.env" ]] || {
    log "$IRIS_DIR/.env not found — nothing to reuse. Run install.sh with --setup instead."
    exit 1
  }

  [[ -n "$TARGET_REF" ]] || {
    log "Resolving latest release tag from $IRIS_CORE_URL"
    TARGET_REF="$(resolve_latest_tag)"
    [[ -n "$TARGET_REF" ]] || { log "No release tags found on $IRIS_CORE_URL."; exit 1; }
  }

  log "Upgrading $PINNED_REPO_DIR to $TARGET_REF"
  git -C "$PINNED_REPO_DIR" fetch --tags origin
  git -C "$PINNED_REPO_DIR" checkout "$TARGET_REF"
  git -C "$PINNED_REPO_DIR" pull --ff-only origin "$TARGET_REF" 2>/dev/null || true
  verify_tag "$PINNED_REPO_DIR" "$TARGET_REF"

  EXISTING_KV_NAME="$(grep -m1 '^IRIS_KEY_VAULT=' "$IRIS_DIR/.env" | cut -d= -f2- || true)"

  cd "$PINNED_REPO_DIR"
  if [[ -n "$EXISTING_KV_NAME" ]]; then
    log "Existing install uses Key Vault '$EXISTING_KV_NAME' — re-running bootstrap.sh without --setup"
    KV_NAME="$EXISTING_KV_NAME" bash bootstrap.sh
  else
    log "Existing install uses /iris/.env — re-running bootstrap.sh --no-keyvault (no prompts)"
    bash bootstrap.sh --no-keyvault
  fi

else
  log "Neither a pinned clone ($PINNED_REPO_DIR) nor a core/ submodule was found."
  log "See docs/overlay.md for the two supported upgrade shapes, or for a fork/"
  log "private mirror, rebase onto the release tag directly (docs/overlay.md)."
  exit 1
fi
