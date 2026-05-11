# public-sandbox Agent

A public-facing Iris sub-agent running inside a Firecracker microVM.
Designed for untrusted users — isolation is enforced at the hypervisor level.

## Provisioning

**Prerequisites** (one-time on the host VM):
```bash
# Install Firecracker, build rootfs
bash /iris/repo/bootstrap.sh --firecracker
```

**Provision the VM** (Terraform):
```hcl
# In terraform/agents.tf — uncomment:
module "public_sandbox" {
  source       = "./modules/firecracker-agent"
  agent_name   = "public-sandbox"
  slot         = 1          # VM will be at 172.20.1.2
  vcpu_count   = 2
  mem_size_mib = 512
  use_jailer   = true
}
```
```bash
cd /iris/repo/terraform && terraform apply
```

**Verify**:
```bash
curl http://172.20.1.2:8080/health   # → {"status":"ok"}
systemctl status iris-fc-public-sandbox
```

## Running iris-runtime connected to this VM

```bash
node /iris/repo/iris-runtime/dist/main.js \
  --sandbox=firecracker:172.20.1.2 \
  /iris/agents/public-sandbox/data
```

## Resetting between sessions

```bash
# Stop VM, restore clean rootfs, restart
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

## Network isolation

| What | IP |
|---|---|
| Host tap | 172.20.1.1 |
| Guest VM | 172.20.1.2 |
| Guest can reach host on | 172.20.1.1 only |
| Guest can reach internet | depends on iptables rules |

To block internet access from the VM (recommended for public use):
```bash
# Drop all forwarded traffic from the tap except established connections
sudo iptables -I FORWARD -i vmtap1 -j DROP
sudo iptables -I FORWARD -i vmtap1 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
```
