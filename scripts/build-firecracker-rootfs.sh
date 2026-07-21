#!/usr/bin/env bash
# ============================================================
# Build a Firecracker-compatible ext4 rootfs image from the
# iris-runtime Docker image.
#
# Usage (run on the host VM as root or with sudo):
#   sudo bash scripts/build-firecracker-rootfs.sh
#
# Produces:
#   /var/lib/iris/firecracker/rootfs.ext4  (sized to the image + headroom, min 2 GiB)
#
# Requirements:
#   - iris-runtime:local Docker image already built
#   - e2fsprogs (mkfs.ext4), util-linux (mount)
# ============================================================
set -euo pipefail

ROOTFS_DIR="/var/lib/iris/firecracker"
ROOTFS_IMG="$ROOTFS_DIR/rootfs.ext4"
ROOTFS_MIN_SIZE_MB=2048
ROOTFS_HEADROOM_MB=1024
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[build-rootfs] $*"; }
die() { echo "[build-rootfs] ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Must be run as root (sudo)."

# ── Prerequisites ──
for cmd in mkfs.ext4 mount umount docker; do
  command -v "$cmd" &>/dev/null || die "Required command not found: $cmd"
done

mkdir -p "$ROOTFS_DIR"

# ── Create a temporary container so we can size the image from its
# actual exported (uncompressed) contents, not the compressed image size ──
log "Creating temporary container from iris-runtime:local..."
CONTAINER_ID=$(docker create iris-runtime:local)
EXPORT_TAR=$(mktemp /tmp/iris-rootfs-export-XXXXXX.tar)
trap 'rm -f "$EXPORT_TAR"; docker rm -f "$CONTAINER_ID" &>/dev/null || true' EXIT
docker export "$CONTAINER_ID" -o "$EXPORT_TAR"

EXPORT_SIZE_MB=$(( ($(stat -c%s "$EXPORT_TAR") + 1024 * 1024 - 1) / (1024 * 1024) ))
ROOTFS_SIZE_MB=$(( EXPORT_SIZE_MB + ROOTFS_HEADROOM_MB ))
[[ $ROOTFS_SIZE_MB -lt $ROOTFS_MIN_SIZE_MB ]] && ROOTFS_SIZE_MB=$ROOTFS_MIN_SIZE_MB

# ── Create blank ext4 image ──
log "Creating blank ${ROOTFS_SIZE_MB}MiB ext4 image at $ROOTFS_IMG (export is ${EXPORT_SIZE_MB}MiB + ${ROOTFS_HEADROOM_MB}MiB headroom)..."
dd if=/dev/zero of="$ROOTFS_IMG" bs=1M count="$ROOTFS_SIZE_MB" status=progress
mkfs.ext4 -F -L iris-rootfs "$ROOTFS_IMG"

# ── Mount and populate from Docker image ──
MOUNT_DIR=$(mktemp -d /tmp/iris-rootfs-XXXXXX)
log "Mounting rootfs at $MOUNT_DIR..."
mount -o loop "$ROOTFS_IMG" "$MOUNT_DIR"

trap 'log "Cleaning up..."; umount "$MOUNT_DIR" 2>/dev/null; rm -rf "$MOUNT_DIR"; rm -f "$EXPORT_TAR"; docker rm -f "$CONTAINER_ID" &>/dev/null || true' EXIT

log "Extracting iris-runtime:local export into rootfs..."
tar -xf "$EXPORT_TAR" -C "$MOUNT_DIR"
rm -f "$EXPORT_TAR"
docker rm -f "$CONTAINER_ID" &>/dev/null

# ── Install iris-exec-server ──
log "Installing iris-exec-server..."
cp "$REPO_DIR/scripts/iris-exec-server.py" "$MOUNT_DIR/usr/local/bin/iris-exec-server"
chmod +x "$MOUNT_DIR/usr/local/bin/iris-exec-server"

# ── Install lightweight /sbin/init for Firecracker (replaces systemd) ──
# Firecracker boots into this minimal init: mounts pseudo-fs, configures
# networking from guestip=/hostip= kernel args, starts exec-server.
# iproute2 must be present — ensured by the Dockerfile.
log "Installing Firecracker /sbin/init..."
cat > "$MOUNT_DIR/sbin/init" << 'INIT'
#!/bin/sh
mount -t proc proc /proc 2>/dev/null || true
mount -t sysfs sysfs /sys 2>/dev/null || true
mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
mkdir -p /dev/pts
mount -t devpts devpts /dev/pts 2>/dev/null || true

GUEST_IP=$(grep -o 'guestip=[^ ]*' /proc/cmdline | cut -d= -f2)
HOST_IP=$(grep -o 'hostip=[^ ]*' /proc/cmdline | cut -d= -f2)

if [ -n "$GUEST_IP" ] && [ -n "$HOST_IP" ]; then
  ip addr add "${GUEST_IP}/30" dev eth0 2>/dev/null || true
  ip link set eth0 up 2>/dev/null || true
  ip route add default via "$HOST_IP" 2>/dev/null || true
fi

mkdir -p /workspace /var/log

python3 /usr/local/bin/iris-exec-server >> /var/log/iris-exec-server.log 2>&1 &

while true; do sleep 3600; done
INIT
chmod +x "$MOUNT_DIR/sbin/init"

# ── /workspace directory for agent sessions ──
mkdir -p "$MOUNT_DIR/workspace"

log "Unmounting rootfs..."
umount "$MOUNT_DIR"
trap - EXIT
rm -rf "$MOUNT_DIR"

log "Done! Rootfs image: $ROOTFS_IMG"
log "Size: $(du -sh "$ROOTFS_IMG" | cut -f1)"
log ""
log "Next: provision a Firecracker agent via Terraform:"
log "  cd terraform && terraform apply"
