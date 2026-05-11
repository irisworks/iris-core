#!/usr/bin/env bash
# ============================================================
# Build a Firecracker-compatible ext4 rootfs image from the
# iris-runtime Docker image.
#
# Usage (run on the host VM as root or with sudo):
#   sudo bash scripts/build-firecracker-rootfs.sh
#
# Produces:
#   /var/lib/iris/firecracker/rootfs.ext4  (2 GiB, reusable base)
#
# Requirements:
#   - iris-runtime:local Docker image already built
#   - e2fsprogs (mkfs.ext4), util-linux (mount)
# ============================================================
set -euo pipefail

ROOTFS_DIR="/var/lib/iris/firecracker"
ROOTFS_IMG="$ROOTFS_DIR/rootfs.ext4"
ROOTFS_SIZE_MB=2048
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[build-rootfs] $*"; }
die() { echo "[build-rootfs] ERROR: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Must be run as root (sudo)."

# ── Prerequisites ──
for cmd in mkfs.ext4 mount umount docker; do
  command -v "$cmd" &>/dev/null || die "Required command not found: $cmd"
done

mkdir -p "$ROOTFS_DIR"

# ── Create blank ext4 image ──
log "Creating blank ${ROOTFS_SIZE_MB}MiB ext4 image at $ROOTFS_IMG..."
dd if=/dev/zero of="$ROOTFS_IMG" bs=1M count="$ROOTFS_SIZE_MB" status=progress
mkfs.ext4 -F -L iris-rootfs "$ROOTFS_IMG"

# ── Mount and populate from Docker image ──
MOUNT_DIR=$(mktemp -d /tmp/iris-rootfs-XXXXXX)
log "Mounting rootfs at $MOUNT_DIR..."
mount -o loop "$ROOTFS_IMG" "$MOUNT_DIR"

trap 'log "Cleaning up..."; umount "$MOUNT_DIR" 2>/dev/null; rm -rf "$MOUNT_DIR"' EXIT

log "Exporting iris-runtime:local Docker image into rootfs..."
CONTAINER_ID=$(docker create iris-runtime:local)
docker export "$CONTAINER_ID" | tar -xf - -C "$MOUNT_DIR"
docker rm -f "$CONTAINER_ID" &>/dev/null

# ── Install iris-exec-server ──
log "Installing iris-exec-server..."
cp "$REPO_DIR/scripts/iris-exec-server.py" "$MOUNT_DIR/usr/local/bin/iris-exec-server"
chmod +x "$MOUNT_DIR/usr/local/bin/iris-exec-server"

# ── Wire exec-server into rc.local for auto-start on boot ──
cat > "$MOUNT_DIR/etc/rc.local" << 'RC'
#!/bin/sh
mkdir -p /workspace
python3 /usr/local/bin/iris-exec-server >> /var/log/iris-exec-server.log 2>&1 &
exit 0
RC
chmod +x "$MOUNT_DIR/etc/rc.local"

# ── Ensure rc.local runs at boot (Debian/Ubuntu style) ──
if [[ -d "$MOUNT_DIR/etc/systemd/system" ]]; then
  cat > "$MOUNT_DIR/etc/systemd/system/iris-exec-server.service" << 'SVC'
[Unit]
Description=Iris Exec Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 /usr/local/bin/iris-exec-server
Restart=always
RestartSec=2
StandardOutput=append:/var/log/iris-exec-server.log
StandardError=append:/var/log/iris-exec-server.log

[Install]
WantedBy=multi-user.target
SVC
  # Symlink to multi-user.target.wants so it starts automatically
  mkdir -p "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants"
  ln -sf /etc/systemd/system/iris-exec-server.service \
    "$MOUNT_DIR/etc/systemd/system/multi-user.target.wants/iris-exec-server.service"
fi

# ── /workspace directory for agent work ──
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
