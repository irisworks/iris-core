#!/usr/bin/env bash
# ============================================================
# reset-iris.sh — tear down a bootstrap.sh install on this box so it can be
# re-bootstrapped from scratch. For local testing only; never destructive by
# accident — prints what it found and asks for confirmation unless -y/--yes.
#
#   bash scripts/reset-iris.sh          # dry-run-ish: shows what's found, asks to confirm
#   bash scripts/reset-iris.sh --yes    # no prompt, just do it
#
# Leaves the git checkout under $IRIS_DIR/repo alone if you pass --keep-repo
# (useful when iterating on bootstrap.sh itself without re-cloning each time).
# ============================================================
set -euo pipefail

IRIS_DIR="${IRIS_DIR:-/iris}"
ASSUME_YES=false
KEEP_REPO=false

for arg in "$@"; do
  case "$arg" in
    -y|--yes)   ASSUME_YES=true ;;
    --keep-repo) KEEP_REPO=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

log() { echo "[reset-iris] $*"; }

log "Found on this box:"
FOUND=false
for unit in iris iris-broker iris-agents; do
  if systemctl list-unit-files "${unit}.service" &>/dev/null && systemctl list-unit-files "${unit}.service" | grep -q "${unit}.service"; then
    log "  systemd unit: ${unit}.service"
    FOUND=true
  fi
done
if ls /etc/systemd/system/iris-fc-agent-*.service &>/dev/null 2>&1; then
  log "  systemd units: iris-fc-agent-*.service (Firecracker pool agents)"
  FOUND=true
fi
if [[ -d /etc/systemd/system/iris.service.d ]]; then
  log "  systemd dropin: iris.service.d/ (Firecracker sandbox override)"
  FOUND=true
fi
if id iris-broker &>/dev/null; then
  log "  system user: iris-broker"
  FOUND=true
fi
if id irisjailer &>/dev/null; then
  log "  system user: irisjailer (Firecracker)"
  FOUND=true
fi
for bin in iris-git iris-secret get-secret set-secret; do
  if [[ -e "/usr/local/bin/$bin" ]]; then
    log "  /usr/local/bin/$bin"
    FOUND=true
  fi
done
if [[ -d "$IRIS_DIR" ]]; then
  log "  $IRIS_DIR/ ($(du -sh "$IRIS_DIR" 2>/dev/null | cut -f1))"
  FOUND=true
fi
if [[ -d /var/lib/iris ]]; then
  log "  /var/lib/iris/ (Firecracker kernel/rootfs/agents, $(du -sh /var/lib/iris 2>/dev/null | cut -f1))"
  FOUND=true
fi
if docker image inspect iris-runtime:local &>/dev/null 2>&1; then
  log "  docker image: iris-runtime:local"
  FOUND=true
fi

if [[ "$FOUND" == false ]]; then
  log "Nothing to clean up — this box has no Iris install."
  exit 0
fi

if [[ "$KEEP_REPO" == true ]]; then
  log "(--keep-repo: leaving $IRIS_DIR/repo in place)"
fi

if [[ "$ASSUME_YES" == false ]]; then
  read -r -p "[reset-iris] Delete all of the above? [y/N] " confirm
  [[ "${confirm,,}" == "y" ]] || { log "Aborted."; exit 1; }
fi

log "Stopping and removing systemd units..."
sudo systemctl stop iris iris-broker iris-agents 2>/dev/null || true
sudo systemctl disable iris iris-broker iris-agents 2>/dev/null || true
for f in /etc/systemd/system/iris-fc-agent-*.service; do
  [[ -e "$f" ]] || continue
  unit="$(basename "$f")"
  sudo systemctl stop "$unit" 2>/dev/null || true
  sudo systemctl disable "$unit" 2>/dev/null || true
  sudo rm -f "$f"
done
sudo rm -f /etc/systemd/system/iris.service /etc/systemd/system/iris-broker.service /etc/systemd/system/iris-agents.service
sudo rm -rf /etc/systemd/system/iris.service.d
sudo systemctl daemon-reload

log "Removing system users..."
sudo userdel iris-broker 2>/dev/null || true
sudo userdel irisjailer 2>/dev/null || true

log "Removing /usr/local/bin symlinks/wrappers..."
sudo rm -f /usr/local/bin/iris-git /usr/local/bin/iris-secret /usr/local/bin/get-secret /usr/local/bin/set-secret

log "Removing Firecracker data (/var/lib/iris)..."
sudo rm -rf /var/lib/iris

if docker image inspect iris-runtime:local &>/dev/null 2>&1; then
  log "Removing docker image iris-runtime:local..."
  docker rmi iris-runtime:local 2>/dev/null || sudo docker rmi iris-runtime:local 2>/dev/null || true
fi

if [[ "$KEEP_REPO" == true && -d "$IRIS_DIR/repo" ]]; then
  log "Removing $IRIS_DIR except repo/..."
  find "$IRIS_DIR" -mindepth 1 -maxdepth 1 ! -name repo -exec sudo rm -rf {} +
else
  log "Removing $IRIS_DIR..."
  sudo rm -rf "$IRIS_DIR"
fi

log "Done. Sanity check:"
systemctl list-units --all 2>/dev/null | grep -i iris || echo "  no iris units"
ls "$IRIS_DIR" 2>&1 || true
id iris-broker 2>&1 || true

log ""
log "Fresh bootstrap:"
log "  curl -fsSL https://raw.githubusercontent.com/irisworks/iris-core/main/install.sh | bash -s -- --setup --no-keyvault"
