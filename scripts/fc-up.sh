#!/usr/bin/env bash
# ============================================================
# fc-up.sh <slot>
#
# Boot a single on-demand Firecracker microVM for the given
# network slot (1-254). Returns when the VM's exec-server
# responds on /health (or exits 1 after a timeout).
#
# Network (per slot):
#   Host tap:  172.20.<slot>.1/30
#   Guest eth: 172.20.<slot>.2/30
#
# State directory: /var/run/iris-fc/slot-<slot>/
#   firecracker.pid  — PID of the running Firecracker process
#   rootfs.ext4      — per-VM copy of the base image
#   vm-config.json   — Firecracker boot config
#
# Caller is responsible for calling fc-down.sh when done.
# ============================================================
set -euo pipefail

SLOT="${1:?Usage: fc-up.sh <slot>}"
BASE_ROOTFS="${BASE_ROOTFS:-/var/lib/iris/firecracker/rootfs.ext4}"
KERNEL="${KERNEL:-/var/lib/iris/firecracker/vmlinux}"
FC_BIN="${FC_BIN:-/usr/local/bin/firecracker}"
STATE_DIR="/var/run/iris-fc/slot-${SLOT}"
TAP_NAME="vmtap${SLOT}"
HOST_IP="172.20.${SLOT}.1"
GUEST_IP="172.20.${SLOT}.2"
HEALTH_URL="http://${GUEST_IP}:8080/health"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-15}"  # seconds to wait for /health

log() { echo "[fc-up] slot=${SLOT} $*" >&2; }
die() { echo "[fc-up] ERROR: $*" >&2; exit 1; }

[[ -f "$BASE_ROOTFS" ]] || die "Base rootfs not found: $BASE_ROOTFS (run scripts/build-firecracker-rootfs.sh first)"
[[ -f "$KERNEL" ]] || die "Kernel not found: $KERNEL (run bootstrap.sh --firecracker first)"
[[ -f "$FC_BIN" ]] || die "Firecracker binary not found: $FC_BIN"
[[ -e /dev/kvm ]] || die "/dev/kvm not available — VM cannot boot"

# ── Already running? ──
if [[ -f "${STATE_DIR}/firecracker.pid" ]]; then
  PID=$(cat "${STATE_DIR}/firecracker.pid")
  if kill -0 "$PID" 2>/dev/null; then
    log "Already running (pid=${PID})"
    exit 0
  fi
  log "Stale pid file found — cleaning up"
  rm -f "${STATE_DIR}/firecracker.pid"
fi

mkdir -p "$STATE_DIR"

# ── Per-VM rootfs copy ──
if [[ ! -f "${STATE_DIR}/rootfs.ext4" ]]; then
  log "Copying base rootfs..."
  cp --sparse=always "$BASE_ROOTFS" "${STATE_DIR}/rootfs.ext4"
fi

# ── Tap device ──
if ! ip link show "$TAP_NAME" &>/dev/null; then
  log "Creating tap device $TAP_NAME..."
  ip tuntap add dev "$TAP_NAME" mode tap
  ip addr flush dev "$TAP_NAME" 2>/dev/null || true
  ip addr add "${HOST_IP}/30" dev "$TAP_NAME"
  ip link set "$TAP_NAME" up
  sysctl -w "net.ipv4.conf.${TAP_NAME}.proxy_arp=1" > /dev/null
  sysctl -w "net.ipv6.conf.${TAP_NAME}.disable_ipv6=1" > /dev/null
else
  log "Tap device $TAP_NAME already exists"
fi

# ── VM config ──
GUEST_MAC=$(printf "AA:FC:00:00:%02X:02" "$SLOT")
cat > "${STATE_DIR}/vm-config.json" << JSON
{
  "boot-source": {
    "kernel_image_path": "${KERNEL}",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"
  },
  "drives": [
    {
      "drive_id": "rootfs",
      "path_on_host": "${STATE_DIR}/rootfs.ext4",
      "is_root_device": true,
      "is_read_only": false
    }
  ],
  "machine-config": {
    "vcpu_count": 1,
    "mem_size_mib": 256
  },
  "network-interfaces": [
    {
      "iface_id": "eth0",
      "guest_mac": "${GUEST_MAC}",
      "host_dev_name": "${TAP_NAME}"
    }
  ]
}
JSON

# ── Start Firecracker ──
log "Starting Firecracker..."
"$FC_BIN" \
  --no-api \
  --config-file "${STATE_DIR}/vm-config.json" \
  --log-path "${STATE_DIR}/firecracker.log" \
  --level Info \
  >> "${STATE_DIR}/firecracker.log" 2>&1 &

FC_PID=$!
echo "$FC_PID" > "${STATE_DIR}/firecracker.pid"
log "Firecracker started (pid=${FC_PID})"

# ── Wait for exec-server ──
log "Waiting for exec-server at ${HEALTH_URL} (max ${BOOT_TIMEOUT}s)..."
for i in $(seq 1 "$BOOT_TIMEOUT"); do
  if curl -sf --max-time 1 "$HEALTH_URL" > /dev/null 2>&1; then
    log "VM is healthy (${i}s)"
    echo "$GUEST_IP"
    exit 0
  fi
  # Check the process hasn't died
  if ! kill -0 "$FC_PID" 2>/dev/null; then
    log "Firecracker process died — check ${STATE_DIR}/firecracker.log"
    cat "${STATE_DIR}/firecracker.log" >&2 || true
    exit 1
  fi
  sleep 1
done

log "Timed out waiting for VM after ${BOOT_TIMEOUT}s"
kill "$FC_PID" 2>/dev/null || true
exit 1
