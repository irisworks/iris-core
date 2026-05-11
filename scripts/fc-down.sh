#!/usr/bin/env bash
# ============================================================
# fc-down.sh <slot>
#
# Kill the Firecracker VM for the given slot, remove the tap
# device, and clean up the per-VM state directory.
#
# Safe to call even if the VM is not running.
# ============================================================
set -euo pipefail

SLOT="${1:?Usage: fc-down.sh <slot>}"
STATE_DIR="/var/run/iris-fc/slot-${SLOT}"
TAP_NAME="vmtap${SLOT}"

log() { echo "[fc-down] slot=${SLOT} $*" >&2; }

# ── Kill Firecracker process ──
if [[ -f "${STATE_DIR}/firecracker.pid" ]]; then
  PID=$(cat "${STATE_DIR}/firecracker.pid")
  if kill -0 "$PID" 2>/dev/null; then
    log "Stopping Firecracker (pid=${PID})..."
    kill "$PID" 2>/dev/null || true
    # Give it a moment to exit cleanly
    for i in 1 2 3; do
      sleep 0.5
      kill -0 "$PID" 2>/dev/null || break
    done
    kill -9 "$PID" 2>/dev/null || true
    log "Stopped"
  else
    log "Process ${PID} already gone"
  fi
  rm -f "${STATE_DIR}/firecracker.pid"
else
  log "No pid file — VM may not have been running"
fi

# ── Remove tap device ──
if ip link show "$TAP_NAME" &>/dev/null; then
  log "Removing tap device $TAP_NAME..."
  ip link set "$TAP_NAME" down 2>/dev/null || true
  ip tuntap del dev "$TAP_NAME" mode tap 2>/dev/null || true
fi

# ── Clean up state directory ──
if [[ -d "$STATE_DIR" ]]; then
  log "Cleaning up $STATE_DIR..."
  rm -rf "$STATE_DIR"
fi

log "Done"
