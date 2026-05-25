# Iris Core

Iris is an always-on AI orchestrator that runs on a cloud VM, listens on Slack, and manages a fleet of specialized sub-agents. Each sub-agent runs in an isolated Firecracker microVM — lightweight virtual machines with their own Linux kernel, booting in ~125ms.

This repository is the source of truth for Iris's constitution, runtime, infrastructure, skills, and sub-agent scaffolding.

## What This Repo Contains

- `CONSTITUTION.md` — operator rules injected read-only into every system prompt
- `MEMORY.md` — Iris's mutable global memory
- `CLAUDE.md` — repo-level writing rules for infrastructure and documentation
- `bootstrap.sh` — rebuild Iris from a fresh VM
- `iris-runtime/` — `@iris-core/runtime`, a provider-agnostic fork of pi-mom
- `scripts/` — Firecracker VM lifecycle scripts (`fc-up.sh`, `fc-down.sh`, `build-firecracker-rootfs.sh`, `iris-exec-server.py`)
- `skills/` — Iris's top-level skills (hot-reloaded without restart)
- `agents/` — sub-agent scaffolds (newsletter, public-sandbox)
- `data/models.json` — LLM provider and model configuration
- `terraform/` — dynamic Azure resources Iris provisions on demand

## Architecture

```
You (Slack)
└── Iris  (Azure VM, systemd service)
    ├── iris-runtime          provider-agnostic fork of pi-mom
    ├── CONSTITUTION.md       read-only operator rules, injected every prompt
    ├── MEMORY.md             mutable global memory
    ├── skills/               hot-reloaded capabilities
    │
    └── Firecracker MicroVM Layer
        ├── Static VMs  (Terraform-managed, always-on)
        │   └── iris-fc-public-sandbox   slot 1 → 172.20.1.2
        │       jailer + seccomp + ephemeral rootfs
        │       iris-exec-server :8080  (GET /health, POST /exec)
        │
        └── Dynamic pool  (VmManager, on-demand per Slack channel)
            slot 2 … 254 → booted by fc-up.sh on first bash command
            released automatically after 30 min of inactivity
```

### Sandbox modes

Iris's bash tool can execute commands in four isolation levels, configured via `--sandbox`:

| Mode | Flag | Use case |
|---|---|---|
| Host | `--sandbox=host` | Iris herself — trusted ops, full access |
| Docker | `--sandbox=docker:<name>` | Legacy containers |
| Static Firecracker | `--sandbox=firecracker:<ip>` | Persistent sub-agent at a fixed IP |
| Dynamic pool | `--sandbox=firecracker-pool` | One fresh microVM per Slack channel; auto-destroyed after 30 min idle |

### Security layers (per microVM)

| Layer | What it enforces |
|---|---|
| KVM | Hardware VM boundary — guest kernel cannot touch host kernel |
| Firecracker | Minimal VMM, no BIOS/PCI — tiny attack surface vs QEMU |
| Jailer | Chroots Firecracker to `/srv/jailer`, drops to uid 10000, applies seccomp |
| TAP `/30` | Each VM sees only its own 2-host subnet — no cross-VM traffic |
| Ephemeral rootfs | Each session starts from a clean copy; dirty state is destroyed with the VM |

## Current State

Implemented and verified:

- `iris-runtime/` fork — provider-agnostic, configurable via `--provider`/`--model` CLI flags or env vars
- `CONSTITUTION.md` — operator rules injected before all agent memory
- Firecracker microVM layer — `VmManager`, `fc-up.sh`/`fc-down.sh`, `iris-exec-server.py`
- `build-firecracker-rootfs.sh` — builds a 2 GiB ext4 rootfs from the iris-runtime Docker image
- `terraform/modules/firecracker-agent` — provisions static Firecracker VMs via Terraform
- `agents/public-sandbox` — first Firecracker sub-agent scaffold
- `skills/firecracker-agent` — skill for managing microVM lifecycle
- Top-level skills: secrets, storage, Terraform, GitHub, Azure, spawn-agent, promote-skill, self-extend, self-heal, send-email, watchdog, serve-public
- `agents/newsletter` — newsletter sub-agent scaffold
- Bootstrap script with interactive first-time setup (Key Vault or `.env` path)
- Live runtime confirmed on `foundry-e2/Kimi-K2.5`; Slack smoke test passed

Still pending:

- Phase 4 internal HTTP API for sub-agent communication
- Phase 5 hardening and full resurrection test

## Setup

---

## Option 1 — Simple Setup (no isolated VMs)

Iris runs on your VM and executes bash commands directly on the host. No Azure account required.

**What you need before starting:**
- A VM running Ubuntu 22.04 LTS
- An API key for your LLM provider (Anthropic, OpenAI, Azure AI Foundry, or AWS Bedrock)
- A Slack workspace where you have admin access (optional but recommended)
- A GitHub account (optional, for Iris to commit skills back to the repo)

**Step 1 — Clone the repo**

```bash
sudo mkdir -p /iris && sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/irisflow.git /iris/repo
cd /iris/repo
```

**Step 2 — Create your Slack app** (optional but recommended)

Go to [https://api.slack.com/apps](https://api.slack.com/apps) and create a new app. You need admin access to a Slack workspace.

1. Click **Create New App → From scratch**, name it `Iris`, pick your workspace
2. **Socket Mode** (left sidebar) → Enable Socket Mode → Generate App-Level Token → name it `iris-socket`, scope: `connections:write` → copy the `xapp-...` token
3. **OAuth & Permissions** (left sidebar) → Bot Token Scopes → Add these scopes:
   `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`,
   `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`,
   `mpim:history`, `reactions:write`, `users:read`
   → Install to Workspace → copy the `xoxb-...` token
4. **Event Subscriptions** → Enable → subscribe to:
   `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`
5. **App Home** → enable the Messages Tab

Keep both tokens (`xapp-...` and `xoxb-...`) ready — the bootstrap script will ask for them.

---

**Step 3 — Run the bootstrap script**

```bash
bash bootstrap.sh --setup --no-keyvault
```

What happens in order:

1. **Dependencies install automatically** — Docker, Node 22, nginx, jq, GitHub CLI, Terraform, etc. This takes a few minutes with no prompts.
2. **GitHub CLI login** — `gh auth login` opens a browser or shows a one-time device code. Go to [github.com/login/device](https://github.com/login/device) and enter the code, or approve in your browser.
3. **Interactive prompts** — you'll be asked for:
   - Your LLM provider and API key
   - Your Slack tokens from Step 2 (or press Enter to skip and add later)
   - Optionally a GitHub PAT (for Iris to push commits back to the repo)
4. **Automated finish** — writes `/iris/.env`, builds the runtime, starts `iris.service`.

**Step 4 — Verify**

```bash
sudo systemctl status iris
sudo journalctl -u iris -f
```

Then message Iris in Slack:

```
@iris what model are you?
```

That's it. Iris is running.

---

## Option 2 — Full Setup with Firecracker (isolated microVMs)

Every Slack channel gets its own sandboxed Linux VM, booted fresh on demand and destroyed after 30 minutes of inactivity. Nothing one user does can affect another.

**What you need before starting:**
- A VM running Ubuntu 22.04 LTS **with KVM support** — on Azure you must use the **Ddsv5 series** (e.g. `Standard_D4ds_v5`) or a bare-metal SKU. Regular D-series, B-series, or F-series VMs do not have KVM and will not work for Firecracker
- An API key for your LLM provider
- A Slack workspace where you have admin access
- A GitHub account
- An Azure account — **only needed if you want to use Azure Key Vault for secrets and Terraform for agent provisioning.** If you prefer to store secrets in a local `.env` file you can skip Steps 1 and 2.

---

**Step 1 — Install Azure CLI and log in** _(skip if not using Azure)_

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
az login
```

---

**Step 2 — Create Terraform state storage** _(skip if not using Azure)_

Pick a globally unique name for your storage account and keep it — you will need it later.
The name must be 3-24 characters, lowercase letters and numbers only (no hyphens or underscores).

```bash
SA_NAME="iristfstatericky"   # replace — lowercase letters and numbers only, max 24 chars

az group create -n iris-tfstate-rg -l eastus

az storage account create \
  -n "$SA_NAME" -g iris-tfstate-rg \
  -l eastus --sku Standard_LRS \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false

az storage container create \
  -n tfstate --account-name "$SA_NAME" --auth-mode login
```

---

**Step 3 — Create your Slack app**

Go to [https://api.slack.com/apps](https://api.slack.com/apps) and create a new app. You need admin access to a Slack workspace.

1. Click **Create New App → From scratch**, name it `Iris`, pick your workspace
2. **Socket Mode** (left sidebar) → Enable Socket Mode → Generate App-Level Token → name it `iris-socket`, scope: `connections:write` → copy the `xapp-...` token
3. **OAuth & Permissions** (left sidebar) → Bot Token Scopes → Add these scopes:
   `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`,
   `groups:history`, `groups:read`, `im:history`, `im:read`, `im:write`,
   `mpim:history`, `reactions:write`, `users:read`
   → Install to Workspace → copy the `xoxb-...` token
4. **Event Subscriptions** → Enable → subscribe to:
   `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`
5. **App Home** → enable the Messages Tab

Keep both tokens (`xapp-...` and `xoxb-...`) ready — the bootstrap script will ask for them.

---

**Step 4 — Clone the repo and run bootstrap**

```bash
sudo mkdir -p /iris && sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/irisflow.git /iris/repo
cd /iris/repo
bash bootstrap.sh --setup
```

What happens in order:

1. **Dependencies install automatically** — Docker, Node 22, nginx, jq, GitHub CLI, Terraform, etc. No prompts, takes a few minutes.
2. **GitHub CLI login** — `gh auth login` opens a browser or shows a one-time device code. Go to [github.com/login/device](https://github.com/login/device) and enter the code, or approve in your browser.
3. **Secret storage choice** — choose **Azure Key Vault** (recommended, uses your existing Azure login from Step 1) or **`/iris/.env`** (if you skipped Steps 1 and 2).
4. **Interactive prompts** — LLM provider + API key, Slack tokens from Step 3, optional GitHub PAT.
5. **Automated finish** — creates Key Vault and seeds secrets (or writes `/iris/.env`), builds the runtime, starts `iris.service`.

Verify Iris is running before continuing:

```bash
sudo systemctl status iris
# Then in Slack: @iris what model are you?
```

---

**Step 5 — Set up Firecracker**

First confirm KVM is available:

```bash
ls /dev/kvm   # must exist — if missing, your VM is the wrong series
              # on Azure: resize to Ddsv5 (e.g. Standard_D4ds_v5)
```

Then run:

```bash
bash /iris/repo/bootstrap.sh --firecracker --no-keyvault
```

This downloads Firecracker, creates the jailer system user, downloads a Linux kernel, and builds the base VM image. It takes a few minutes.

When it finishes, **log out and back in** so your `kvm` group membership takes effect:

```bash
exit   # then SSH back in
groups | grep kvm   # should show kvm
```

---

**Step 6 — Provision the sandbox VM via Terraform** _(requires Steps 1 and 2 — Azure login and storage account)_

Open `terraform/agents.tf` and uncomment the `public_sandbox` block:

```hcl
module "public_sandbox" {
  source       = "./modules/firecracker-agent"
  agent_name   = "public-sandbox"
  slot         = 1          # host: 172.20.1.1  guest: 172.20.1.2
  vcpu_count   = 2
  mem_size_mib = 512
  use_jailer   = true
}
```

Then apply:

```bash
cd /iris/repo/terraform

SA_NAME="iristfstatericky"   # same name from Step 2

terraform init \
  -backend-config="resource_group_name=iris-tfstate-rg" \
  -backend-config="storage_account_name=${SA_NAME}" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=iris-dynamic.terraform.tfstate" \
  -backend-config="use_azuread_auth=true"

export TF_VAR_subscription_id=$(az account show --query id -o tsv)

terraform apply
```

Verify the VM is running:

```bash
systemctl status iris-fc-public-sandbox
curl http://172.20.1.2:8080/health   # → {"status":"ok"}
```

To add more sandbox VMs, add another module block with a different `agent_name` and `slot` number.

---

**Step 7 — Connect Iris to the microVM**

```bash
sudo nano /etc/systemd/system/iris.service
```

Find the `ExecStart` line and change `--sandbox=host` to either:

- **Static** (Iris always uses the VM at slot 1):
  ```
  --sandbox=firecracker:172.20.1.2
  ```

- **Dynamic pool** (fresh VM per Slack channel, auto-released after 30 min idle):
  ```
  --sandbox=firecracker-pool
  ```

Then restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart iris
```

Verify by asking Iris to run a command in Slack — the output should come from inside the microVM:

```
@iris run: uname -a
```

---

## Runtime and Models

The runtime reads `IRIS_PROVIDER` and `IRIS_MODEL` env vars and loads provider config from `data/models.json`.

Default: `foundry-e2/Kimi-K2.5` (Azure AI Foundry).

```bash
# CLI flags
iris-runtime --provider foundry-e2 --model Kimi-K2.5 /iris/data

# Env vars (preferred in production, set in /iris/.env)
IRIS_PROVIDER=foundry-e2
IRIS_MODEL=Kimi-K2.5
IRIS_ENV=prod          # preview | prod
IRIS_API_PORT=3001     # 0 = disabled (default)
```

Supported providers out of the box (configure in `data/models.json`):

| Provider key | Backend |
|---|---|
| `anthropic` | Claude Sonnet / Opus |
| `openai` | GPT-4o / GPT-4o-mini |
| `foundry-e2` | Azure AI Foundry (chat/completions) |
| `foundry-e2-responses` | Azure AI Foundry (Responses API) |
| `amazon-bedrock` | AWS Bedrock (Claude, Nova, Llama) |

---

## Resetting a VM Between Sessions

```bash
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

For dynamic pool VMs, `VmManager` calls `fc-down.sh` automatically on session reset or idle timeout — no manual steps needed.

---

## Secrets

Iris supports two secret storage backends:

**Azure Key Vault** (recommended for production):

```bash
KV=$(terraform output -raw key_vault_name)
az keyvault secret set --vault-name "$KV" --name "FOUNDRY-E2-KEY"   --value "<key>"
az keyvault secret set --vault-name "$KV" --name "SLACK-APP-TOKEN"  --value "xapp-..."
az keyvault secret set --vault-name "$KV" --name "SLACK-BOT-TOKEN"  --value "xoxb-..."
az keyvault secret set --vault-name "$KV" --name "GITHUB-TOKEN"     --value "ghp_..."
```

**`/iris/.env`** (simpler, no Azure required):

Run `bash bootstrap.sh --setup --no-keyvault` and the script will prompt for all values and write `/iris/.env` (chmod 600). Never commit this file.

Optional secrets (all providers):

- `ANTHROPIC-API-KEY` / `OPENAI-API-KEY` / `RESEND-API-KEY`

---

## Repository Layout

```
irisflow/
├── bootstrap.sh                    # rebuild Iris on a fresh VM
├── CLAUDE.md                       # repo-level writing rules
├── CONSTITUTION.md                 # operator rules — injected into every prompt
├── MEMORY.md                       # Iris's mutable global memory
├── README.md
├── data/
│   ├── models.json                 # LLM provider + model config
│   └── models.json.template        # template for new installs
├── iris-runtime/                   # @iris-core/runtime — fork of pi-mom
│   └── src/
│       ├── main.ts                 # --provider, --model, --sandbox flags
│       ├── agent.ts                # configurable model, constitution loading
│       ├── sandbox.ts              # HostExecutor, DockerExecutor, FirecrackerExecutor, pool
│       ├── vm-manager.ts           # VmManager — on-demand Firecracker pool
│       ├── api.ts                  # internal HTTP API stub
│       └── bridge.ts               # sub-agent bridge
├── scripts/
│   ├── fc-up.sh                    # boot a Firecracker microVM for a given slot
│   ├── fc-down.sh                  # kill VM, remove tap, clean state
│   ├── build-firecracker-rootfs.sh # build base rootfs from Docker image
│   └── iris-exec-server.py         # HTTP exec server baked into the rootfs
├── skills/
│   ├── azure/
│   ├── firecracker-agent/          # manage microVM lifecycle
│   ├── get-secret/
│   ├── github/
│   ├── promote-skill/
│   ├── search-web/
│   ├── self-extend/
│   ├── self-heal/
│   ├── send-email/
│   ├── serve-public/
│   ├── spawn-agent/
│   ├── store-file/
│   ├── terraform/
│   ├── transcribe-audio/
│   └── watchdog/
├── agents/
│   ├── newsletter/                 # newsletter sub-agent scaffold
│   └── public-sandbox/             # Firecracker-isolated public sub-agent
└── terraform/
    ├── agents.tf                   # sub-agent definitions (uncomment to provision)
    ├── backend.tf
    ├── main.tf
    ├── providers.tf
    ├── variables.tf
    ├── outputs.tf
    └── modules/
        ├── agent/                  # Docker sub-agent module (legacy)
        └── firecracker-agent/      # Firecracker microVM module
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `iris.service` fails to start | Missing env vars | Check `/iris/.env` and `journalctl -u iris` |
| `/dev/kvm` not found | Wrong Azure VM series | Resize to Ddsv5 series (e.g. `Standard_D4ds_v5`) — B-series, D-series, F-series do not support KVM |
| `firecracker: permission denied` | Not in kvm group | `sudo usermod -aG kvm $USER` then log out and SSH back in |
| VM boots but `/health` times out | exec-server not started | Check `journalctl -u iris-fc-<name>` |
| Jailer fails to chroot | `irisjailer` user missing | `sudo useradd -u 10000 -g 10000 -r irisjailer` |
| rootfs missing | Build script not run | `sudo bash scripts/build-firecracker-rootfs.sh` |

---

## Company-Specific Extensions

```bash
gh repo create iris-yourcompany --private
cd iris-yourcompany
git submodule add https://github.com/irisworks/irisflow.git core
mkdir -p overlay/{agents,skills,data}
```

Add company-specific agents, skills, and a `bootstrap.sh` wrapper that sets `REPO_DIR` before calling `core/bootstrap.sh`.

---

## Operational Notes

- `SKILL.md` edits hot-reload through pi-mom without a service restart.
- The live VM workspace uses `/iris/data` with symlinks back to the repo for hot reload.
- GitHub is the durable source of truth. The VM is disposable — a full rebuild from this README should produce an identical running system.
- Do not store secrets in the repo, `.env` committed to git, or Terraform state.

## Source Documents

If resuming work, read these first:

- [CLAUDE.md](CLAUDE.md)
- [CONSTITUTION.md](CONSTITUTION.md)
- [MEMORY.md](MEMORY.md)

## Commit Log

**2026-05-25** — Add Firecracker microVM layer

- `iris-runtime/src/vm-manager.ts` — VmManager singleton, on-demand pool (slots 1-254, 30min idle TTL)
- `iris-runtime/src/sandbox.ts` — FirecrackerExecutor, FirecrackerPoolExecutor, DockerExecutor, HostExecutor
- `scripts/fc-up.sh` / `fc-down.sh` — VM lifecycle (tap device, rootfs copy, Firecracker process)
- `scripts/build-firecracker-rootfs.sh` — build 2 GiB ext4 rootfs from iris-runtime Docker image
- `scripts/iris-exec-server.py` — HTTP exec server baked into rootfs (GET /health, POST /exec)
- `skills/firecracker-agent/` — skill for provisioning and managing microVMs
- `agents/public-sandbox/` — first Firecracker sub-agent scaffold (MEMORY.md, README, handle-request skill)
- `terraform/modules/firecracker-agent/` — Terraform module for static Firecracker agents with optional jailer
- `terraform/agents.tf` — updated with Firecracker module documentation and commented example

**2025-04-13 19:52** — Increase bridge timeout from 30s to 60s

- Changed `BRIDGE_TIMEOUT_MS` in `iris-runtime/src/bridge.ts` from 30,000ms to 60,000ms

**2025-04-13 19:35** — Remove aggressive 40-message context trim

- Removed hardcoded `MAX_CONTEXT_MESSAGES=40` limit from `iris-runtime/src/agent.ts`
- Context management now relies on pi-framework's auto-compaction
