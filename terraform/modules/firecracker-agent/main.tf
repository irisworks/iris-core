# ============================================================
# Firecracker Agent Module
#
# Provisions a single Firecracker microVM as an Iris sub-agent.
# Each agent gets:
#   - An isolated ext4 rootfs copy (ephemeral — reset on destroy/recreate)
#   - A tap network device (vmtap<slot>) with its own /30 subnet
#   - A systemd service (iris-fc-<name>) that boots the VM
#   - Optional Jailer wrapping for maximum isolation
#
# Network layout per slot:
#   Host tap:  172.20.<slot>.1/30
#   Guest eth: 172.20.<slot>.2/30
#
# Connect iris-runtime to this VM via:
#   --sandbox=firecracker:172.20.<slot>.2
# ============================================================

locals {
  agent_id     = "iris-fc-${var.agent_name}"
  host_ip      = "172.20.${var.slot}.1"
  guest_ip     = "172.20.${var.slot}.2"
  tap_name     = "vmtap${var.slot}"
  agent_rootfs = "${var.rootfs_dir}/${var.agent_name}/rootfs.ext4"
  config_path  = "${var.rootfs_dir}/${var.agent_name}/vm-config.json"
  log_path     = "/var/log/${local.agent_id}.log"
}

# ── Per-agent directory and rootfs copy ──
resource "null_resource" "agent_rootfs" {
  triggers = {
    agent_name = var.agent_name
    base_rootfs_md5 = fileexists(var.base_rootfs) ? filemd5(var.base_rootfs) : "missing"
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      mkdir -p "${var.rootfs_dir}/${var.agent_name}"
      if [ ! -f "${local.agent_rootfs}" ]; then
        echo "Copying base rootfs for ${var.agent_name}..."
        cp --sparse=always "${var.base_rootfs}" "${local.agent_rootfs}"
      fi
    SHELL
  }

  provisioner "local-exec" {
    when    = destroy
    command = "rm -rf '${var.rootfs_dir}/${var.agent_name}'"
  }
}

# ── Firecracker VM config JSON ──
resource "null_resource" "vm_config" {
  depends_on = [null_resource.agent_rootfs]

  triggers = {
    agent_name   = var.agent_name
    vcpu_count   = var.vcpu_count
    mem_size_mib = var.mem_size_mib
    slot         = var.slot
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      cat > "${local.config_path}" << 'JSON'
      {
        "boot-source": {
          "kernel_image_path": "${var.kernel_image}",
          "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"
        },
        "drives": [
          {
            "drive_id": "rootfs",
            "path_on_host": "${local.agent_rootfs}",
            "is_root_device": true,
            "is_read_only": false
          }
        ],
        "machine-config": {
          "vcpu_count": ${var.vcpu_count},
          "mem_size_mib": ${var.mem_size_mib}
        },
        "network-interfaces": [
          {
            "iface_id": "eth0",
            "guest_mac": "AA:FC:00:00:${format("%02X", var.slot)}:02",
            "host_dev_name": "${local.tap_name}"
          }
        ]
      }
      JSON
    SHELL
  }

  provisioner "local-exec" {
    when    = destroy
    command = "rm -f '${local.config_path}'"
  }
}

# ── systemd service (manages tap device + Firecracker process) ──
resource "null_resource" "systemd_service" {
  depends_on = [null_resource.vm_config]

  triggers = {
    agent_name   = var.agent_name
    slot         = var.slot
    vcpu_count   = var.vcpu_count
    mem_size_mib = var.mem_size_mib
    use_jailer   = var.use_jailer
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e

      # Build ExecStart depending on jailer mode
      if [ "${var.use_jailer}" = "true" ]; then
        EXEC_START="${var.jailer_bin} \
          --id ${var.agent_name} \
          --exec-file ${var.firecracker_bin} \
          --uid ${var.jailer_uid} \
          --gid ${var.jailer_gid} \
          --chroot-base-dir /srv/jailer \
          -- \
          --config-file ${local.config_path} \
          --log-path ${local.log_path} \
          --level Info"
      else
        EXEC_START="${var.firecracker_bin} \
          --config-file ${local.config_path} \
          --log-path ${local.log_path} \
          --level Info"
      fi

      sudo tee /etc/systemd/system/${local.agent_id}.service > /dev/null << UNIT
      [Unit]
      Description=Iris Firecracker Agent: ${var.agent_name}
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      Restart=on-failure
      RestartSec=5

      ExecStartPre=/bin/bash -c " \
        ip link show ${local.tap_name} &>/dev/null || \
          ip tuntap add dev ${local.tap_name} mode tap; \
        ip addr flush dev ${local.tap_name} 2>/dev/null || true; \
        ip addr add ${local.host_ip}/30 dev ${local.tap_name}; \
        ip link set ${local.tap_name} up; \
        sysctl -w net.ipv4.conf.${local.tap_name}.proxy_arp=1 > /dev/null; \
        sysctl -w net.ipv6.conf.${local.tap_name}.disable_ipv6=1 > /dev/null"

      ExecStart=$EXEC_START

      ExecStopPost=/bin/bash -c " \
        ip link set ${local.tap_name} down 2>/dev/null || true; \
        ip tuntap del dev ${local.tap_name} mode tap 2>/dev/null || true"

      StandardOutput=append:${local.log_path}
      StandardError=append:${local.log_path}

      [Install]
      WantedBy=multi-user.target
      UNIT

      sudo systemctl daemon-reload
      sudo systemctl enable ${local.agent_id}
      sudo systemctl restart ${local.agent_id}
      echo "Waiting for VM to boot (up to 30s)..."
      for i in $(seq 1 30); do
        if curl -sf --max-time 2 http://${local.guest_ip}:8080/health > /dev/null 2>&1; then
          echo "VM is healthy at ${local.guest_ip}"
          break
        fi
        sleep 1
      done
    SHELL
  }

  provisioner "local-exec" {
    when    = destroy
    command = <<-SHELL
      sudo systemctl stop ${local.agent_id} 2>/dev/null || true
      sudo systemctl disable ${local.agent_id} 2>/dev/null || true
      sudo rm -f /etc/systemd/system/${local.agent_id}.service
      sudo systemctl daemon-reload
    SHELL
  }
}
