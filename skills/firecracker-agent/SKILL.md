---
name: firecracker-agent
description: Opt-in Firecracker profile only — provision, verify, reset, and destroy Firecracker microVM sub-agents.
---

# Skill: firecracker-agent

> **Opt-in profile:** this skill only applies to installs using the Firecracker profile (`--firecracker`, needs KVM). Default Docker-only installs have no microVMs — do not use this skill there.

Provision, verify, and manage a Firecracker microVM sub-agent for Iris.

## When to use

Use this skill when asked to:
- Spin up a new isolated VM for public user sessions
- Verify a Firecracker agent is healthy
- Reset a VM to its clean base image
- Troubleshoot a failing microVM

---

## One-time host setup

Run once on the Azure VM (needs KVM, Ddsv5-series or nested-virt enabled):

```bash
# Installs Firecracker + Jailer, downloads kernel, builds rootfs
bash /iris/repo/bootstrap.sh --firecracker
```

Manual steps if you prefer:

```bash
# 1. Check KVM is available
ls /dev/kvm || echo "No KVM — wrong VM size"

# 2. Install Firecracker + Jailer
FC_VERSION="1.7.0"
ARCH=$(uname -m)   # x86_64 or aarch64
curl -Lo /tmp/fc.tgz \
  "https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${ARCH}.tgz"
tar -xzf /tmp/fc.tgz -C /tmp
sudo install /tmp/release-v${FC_VERSION}-${ARCH}/firecracker-v${FC_VERSION}-${ARCH} /usr/local/bin/firecracker
sudo install /tmp/release-v${FC_VERSION}-${ARCH}/jailer-v${FC_VERSION}-${ARCH}      /usr/local/bin/jailer

# 3. Create Jailer system user
sudo groupadd -g 10000 irisjailer
sudo useradd -u 10000 -g 10000 -r -s /usr/sbin/nologin irisjailer
sudo usermod -aG kvm $USER

# 4. Download kernel
sudo mkdir -p /var/lib/iris/firecracker
sudo curl -Lo /var/lib/iris/firecracker/vmlinux \
  "https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/${ARCH}/kernels/vmlinux.bin"

# 5. Build rootfs from iris-runtime Docker image
cd /iris/repo/iris-runtime && npm run build && docker build -t iris-runtime:local .
sudo bash /iris/repo/scripts/build-firecracker-rootfs.sh
```

---

## Provision an agent

Add to `terraform/agents.tf`:

```hcl
module "public_sandbox" {
  source       = "./modules/firecracker-agent"
  agent_name   = "public-sandbox"
  slot         = 1          # network: host 172.20.1.1, guest 172.20.1.2
  vcpu_count   = 2
  mem_size_mib = 512
  use_jailer   = true       # production: always true
}
```

Then apply:
```bash
cd /iris/repo/terraform && terraform apply
```

Terraform will:
1. Copy the base rootfs to `/var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4`
2. Create tap device `vmtap1` with host IP `172.20.1.1`
3. Write VM config JSON
4. Start systemd service `iris-fc-public-sandbox`
5. Wait up to 30s and verify the VM responds at `172.20.1.2:8080/health`

---

## Verify

```bash
# VM service status
systemctl status iris-fc-public-sandbox

# Health check
curl http://172.20.1.2:8080/health        # → {"status":"ok"}

# Run a test command
curl -s -X POST http://172.20.1.2:8080/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"uname -a","timeout":10}'
```

---

## Connect iris-runtime to the VM

Pass `--sandbox=firecracker:<guest-ip>` when starting iris-runtime:

```bash
node /iris/repo/iris-runtime/dist/main.js \
  --sandbox=firecracker:172.20.1.2 \
  /iris/agents/public-sandbox/data
```

Or update the systemd ExecStart for the agent's own service.

---

## Reset VM between sessions

```bash
# Stop, restore clean rootfs, restart (~2s downtime)
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

---

## Destroy a VM

```bash
cd /iris/repo/terraform
terraform destroy -target='module.public_sandbox'
```

This stops the service, removes the tap device, and deletes the agent rootfs.

---

## Security model

| Layer | What it does |
|---|---|
| KVM | Hardware-enforced VM boundary — process inside can't reach host kernel |
| Firecracker | Minimal VMM (no BIOS, no PCI) — tiny attack surface vs QEMU |
| Jailer | Chroots Firecracker, drops to uid 10000, applies seccomp filter |
| tap network | VM only sees its own /30 subnet — no other VMs, no internal services |
| ephemeral rootfs | Each session starts from a known-good image — no persistence |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `systemctl start` fails immediately | `/dev/kvm` missing | Resize to Ddsv5 VM or enable nested-virt |
| VM boots but `/health` times out | exec-server not started | Check `journalctl -u iris-fc-public-sandbox` |
| `firecracker: permission denied` | Not in kvm group | `sudo usermod -aG kvm $USER && newgrp kvm` |
| Jailer fails to chroot | irisjailer user missing | `sudo useradd -u 10000 -g 10000 -r irisjailer` |
| rootfs missing | build script not run | `sudo bash /iris/repo/scripts/build-firecracker-rootfs.sh` |
| Guest can reach internet (unwanted) | No iptables rules | Add FORWARD DROP rule on vmtap{slot} |
