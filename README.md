# Iris Core

Iris is an always-on AI orchestrator that runs on a cloud VM, listens on Slack or Telegram, and manages a fleet of specialized sub-agents. Each sub-agent runs in an isolated Firecracker microVM — lightweight virtual machines with their own Linux kernel, booting in ~125ms.

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
You (Slack or Telegram)
└── Iris  (Azure VM, systemd service)
    ├── iris-runtime
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
- Native Telegram transport (`--transport=telegram`) — long polling, DMs, groups, topic threads, file downloads, `/reset` `/compact` `/stop` commands

Still pending:

- Phase 4 internal HTTP API for sub-agent communication
- Phase 5 hardening and full resurrection test
- Simultaneous Slack + Telegram in a single process (currently requires two separate service instances)

## Setup

Pick the path that matches your environment — one command does everything:

| | No Firecracker | With Firecracker (isolated microVMs) |
|---|---|---|
| **No Azure** | [Option 1](#option-1--no-azure-no-firecracker) — simplest | [Option 3](#option-3--no-azure-with-firecracker) |
| **Azure Key Vault** | [Option 2](#option-2--azure-key-vault-no-firecracker) | [Option 4](#option-4--azure-key-vault--firecracker-full-production) — full production |

All options prompt for both Slack and Telegram tokens during setup — answer `Y` to whichever you want. See [Telegram Setup](#telegram-setup) for details.

All four paths start the same way:

```bash
sudo mkdir -p /iris && sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/irisflow.git /iris/repo
cd /iris/repo
```

Then run the single command for your chosen path below.

---

## Managing the Iris Service

Once installed, use these commands to control the iris service manually:

```bash
# Stop iris (graceful shutdown — stays stopped until you start it again)
sudo systemctl stop iris

# Start iris
sudo systemctl start iris

# Restart iris (stop + start in one step)
sudo systemctl restart iris
```

> **Note:** If `start` silently does nothing, the built JS may be missing. Rebuild first:
> ```bash
> cd /iris/repo/iris-runtime && npm install && npm run build
> sudo systemctl start iris
> ```

---

## Option 1 — No Azure, No Firecracker

Iris runs on your VM and executes commands directly on the host. No Azure account, no KVM needed.

**Requirements:** Ubuntu 22.04 VM · LLM provider API key · Slack workspace (admin) · GitHub account (optional)

```bash
bash bootstrap.sh --setup --no-keyvault
```

**Exactly what you will see:**

```
[iris-bootstrap] ── System dependencies ──
(automated: Docker, Node 22, jq, nginx, certbot, GitHub CLI, Terraform)

[iris-bootstrap] ── GitHub login ──
(gh auth login opens browser or shows device code)
> Go to https://github.com/login/device and enter the code shown

[iris-bootstrap] Choose LLM provider:
  1) anthropic       — Claude Sonnet / Opus (recommended)
  2) openai          — GPT-4o / GPT-4
  3) foundry-e2      — Azure AI Foundry (Azure OpenAI)
  4) amazon-bedrock  — AWS Bedrock (Claude, Llama, Nova)
[iris-bootstrap] Choice [1]:

[iris-bootstrap] Anthropic API key (sk-ant-...):

[iris-bootstrap] Set up Slack integration? [Y/n]

  ┌─ Slack App Setup ────────────────────────────────────────────┐
  │                                                               │
  │  1. Go to https://api.slack.com/apps → Create New App        │
  │     → From scratch → name it 'Iris' → pick your workspace    │
  │                                                               │
  │  2. Socket Mode (left sidebar)                                │
  │     → Enable Socket Mode → generate App-Level Token          │
  │     → name it 'iris-socket' → scope: connections:write       │
  │     → copy the  xapp-...  token  (App Token)                 │
  │                                                               │
  │  3. OAuth & Permissions (left sidebar)                        │
  │     → Bot Token Scopes → Add:                                 │
  │         app_mentions:read  channels:history  channels:read    │
  │         chat:write         groups:history    groups:read      │
  │         im:history         im:read           im:write         │
  │         mpim:history       reactions:write   users:read       │
  │     → Install to Workspace → copy the  xoxb-...  token       │
  │                                                               │
  │  4. Event Subscriptions → Enable → subscribe to bot events:   │
  │         app_mention  message.channels  message.groups        │
  │         message.im   message.mpim                            │
  │                                                               │
  │  5. App Home → enable Messages Tab                           │
  └───────────────────────────────────────────────────────────────────┘

[iris-bootstrap] Press Enter when your app is created and tokens are ready...
[iris-bootstrap] Slack App token (xapp-...):
[iris-bootstrap] Slack Bot token (xoxb-...):

[iris-bootstrap] Set up Telegram integration? [Y/n]
[iris-bootstrap] Telegram Bot Token:

[iris-bootstrap] Add GitHub token for repo access? [Y/n]
[iris-bootstrap] Set up email sending (Resend.com)? [y/N]
[iris-bootstrap] Set up public domain (e.g. iris.example.com)? [y/N]
[iris-bootstrap] Git author email for Iris commits [iris@example.com]:

[iris-bootstrap] ── Workspace ──
(automated: writes /iris/.env, symlinks MEMORY.md / CONSTITUTION.md / skills)

[iris-bootstrap] ── Building iris-runtime ──
(automated: npm install + npm run build)

[iris-bootstrap] ── Installing systemd service ──
(automated: installs iris.service, starts Iris)

[iris-bootstrap] ── Done ──
  ✓ Iris is running!
  Status:    sudo systemctl status iris
  Logs:      sudo journalctl -u iris -f
  Secrets:   /iris/.env
  Slack:     @iris in any channel
```

**Verify:**
```bash
sudo systemctl status iris
```
Then in Slack: `@iris what model are you?`

---

## Option 2 — Azure Key Vault, No Firecracker

Same as Option 1 but secrets live in Azure Key Vault instead of `/iris/.env`.

**Requirements:** All of Option 1 + Azure account

```bash
bash bootstrap.sh --setup --keyvault
```

**Exactly what you will see:**

```
[iris-bootstrap] ── System dependencies ──
(automated: same as Option 1 + Azure CLI)

[iris-bootstrap] ── Azure login ──
(az login opens browser or shows device code)
(skipped automatically if this VM has a managed identity)
Active subscription: My-Subscription (xxxxxxxx-xxxx-...)

[iris-bootstrap] ── GitHub login ──
(gh auth login)

[iris-bootstrap] Choose LLM provider:   (same as Option 1)
[iris-bootstrap] Anthropic API key (sk-ant-...):
[iris-bootstrap] Set up Slack integration? [Y/n]
  (same Slack setup box as Option 1)
[iris-bootstrap] Slack App token (xapp-...):
[iris-bootstrap] Slack Bot token (xoxb-...):
[iris-bootstrap] Add GitHub token for repo access? [Y/n]
[iris-bootstrap] Set up email sending (Resend.com)? [y/N]
[iris-bootstrap] Set up public domain? [y/N]

[iris-bootstrap] Key Vault name [iris-kv-myhostname]:
[iris-bootstrap] Resource group for Key Vault [iris-rg]:
[iris-bootstrap] Git author email for Iris commits [iris@example.com]:

[iris-bootstrap] ── Key Vault setup ──
(automated: creates Key Vault, seeds all secrets)

[iris-bootstrap] ── Workspace ──  (automated)
[iris-bootstrap] ── Building iris-runtime ──  (automated)
[iris-bootstrap] ── Installing systemd service ──  (automated)

[iris-bootstrap] ── Done ──
  ✓ Iris is running!
  Key Vault: iris-kv-myhostname
  Slack:     @iris in any channel
```

---

## Option 3 — No Azure, With Firecracker

Every bash command Iris runs executes inside an isolated Firecracker microVM. No Azure account needed. Requires a VM with KVM — on Azure use **Ddsv5 series** (e.g. `Standard_D4ds_v5`). B-series and D-series do not have KVM.

**Requirements:** Ubuntu 22.04 VM with `/dev/kvm` · LLM API key · Slack workspace (admin) · GitHub account (optional)

```bash
bash bootstrap.sh --setup --no-keyvault --firecracker
```

**Exactly what you will see:**

```
[iris-bootstrap] ── KVM check ──
✓ /dev/kvm found
(if kvm group not yet active, script re-execs itself via sg kvm — no logout needed)

[iris-bootstrap] ── System dependencies ──
(automated: same as Option 1 + e2fsprogs)

[iris-bootstrap] ── Firecracker setup ──
(automated: downloading firecracker v1.7.0...)
(automated: downloading jailer v1.7.0...)
(automated: creating irisjailer system user uid/gid 10000)
(automated: adding azureuser to kvm group)
(automated: downloading Linux kernel → /var/lib/iris/firecracker/vmlinux)

[iris-bootstrap] ── GitHub login ──  (gh auth login)

[iris-bootstrap] Choose LLM provider:   (same as Option 1)
[iris-bootstrap] Anthropic API key (sk-ant-...):
[iris-bootstrap] Set up Slack integration? [Y/n]
  (same Slack setup box as Option 1)
[iris-bootstrap] Slack App token (xapp-...):
[iris-bootstrap] Slack Bot token (xoxb-...):
[iris-bootstrap] Add GitHub token for repo access? [Y/n]
[iris-bootstrap] Set up email sending (Resend.com)? [y/N]
[iris-bootstrap] Set up public domain? [y/N]
[iris-bootstrap] Git author email for Iris commits [iris@example.com]:

[iris-bootstrap] ── Workspace ──
(automated: writes /iris/.env)

[iris-bootstrap] ── Building iris-runtime ──
(automated: npm install + npm run build + docker build iris-runtime:local)
(automated: building rootfs.ext4 from Docker image — takes ~1 minute)

[iris-bootstrap] ── Installing systemd service ──
(automated: installs iris.service, starts Iris temporarily on --sandbox=host)

[iris-bootstrap] ── Provisioning Firecracker sandbox VM ──
(automated: writing /var/lib/iris/firecracker/agents/public-sandbox/vm-config.json)
(automated: writing /etc/systemd/system/iris-fc-public-sandbox.service)
(automated: starting iris-fc-public-sandbox)

[iris-bootstrap] ── Firecracker health check ──
Waiting for VM at http://172.20.1.2:8080/health (up to 20s)...
✓ VM is healthy (4s)

[iris-bootstrap] ── Switching Iris to Firecracker sandbox ──
(automated: writes drop-in /etc/systemd/system/iris.service.d/sandbox.conf)
(automated: daemon-reload + restart iris)

[iris-bootstrap] ── Done ──
  ✓ Iris is running!
  Firecracker: iris-fc-public-sandbox → 172.20.1.2
  Sandbox:     --sandbox=firecracker:172.20.1.2
  Secrets:     /iris/.env
  VM logs:     journalctl -u iris-fc-public-sandbox -f
  Test:        @iris run: uname -a
```

---

## Option 4 — Azure Key Vault + Firecracker (full production)

Azure Key Vault for secrets + Terraform to manage the sandbox VM lifecycle. Everything automated.

**Requirements:** All of Option 3 + Azure account

```bash
bash bootstrap.sh --setup --keyvault --firecracker
```

**Exactly what you will see:**

```
[iris-bootstrap] ── KVM check ──
✓ /dev/kvm found

[iris-bootstrap] ── System dependencies ──
(automated: same as Option 1 + Azure CLI + e2fsprogs)

[iris-bootstrap] ── Firecracker setup ──
(automated: downloads firecracker + jailer + kernel, creates irisjailer user)

[iris-bootstrap] ── Azure login ──
(az login — skipped if managed identity detected)
Active subscription: My-Subscription (xxxxxxxx-xxxx-...)

[iris-bootstrap] ── GitHub login ──  (gh auth login)

[iris-bootstrap] Choose LLM provider:   (same as Option 1)
[iris-bootstrap] Anthropic API key (sk-ant-...):
[iris-bootstrap] Set up Slack integration? [Y/n]
  (same Slack setup box as Option 1)
[iris-bootstrap] Slack App token (xapp-...):
[iris-bootstrap] Slack Bot token (xoxb-...):
[iris-bootstrap] Add GitHub token for repo access? [Y/n]
[iris-bootstrap] Set up email sending (Resend.com)? [y/N]
[iris-bootstrap] Set up public domain? [y/N]

[iris-bootstrap] Key Vault name [iris-kv-myhostname]:
[iris-bootstrap] Resource group for Key Vault [iris-rg]:
[iris-bootstrap] Terraform state storage account name (lowercase + numbers, max 24 chars) [iristfstatemyhostname]:
[iris-bootstrap] Git author email for Iris commits [iris@example.com]:

[iris-bootstrap] ── Key Vault setup ──
(automated: creates Key Vault iris-kv-myhostname, seeds all secrets)

[iris-bootstrap] ── Workspace ──
(automated: writes /iris/.env)

[iris-bootstrap] ── Building iris-runtime ──
(automated: npm install + npm run build + docker build + rootfs.ext4 — ~2 minutes)

[iris-bootstrap] ── Installing systemd service ──
(automated: installs iris.service)

[iris-bootstrap] ── Provisioning Firecracker sandbox VM ──
(automated: creating Terraform state storage iristfstatemyhostname)
(automated: terraform init with Azure backend)
(automated: terraform apply — provisions iris-fc-public-sandbox.service)

[iris-bootstrap] ── Firecracker health check ──
Waiting for VM at http://172.20.1.2:8080/health (up to 20s)...
✓ VM is healthy (5s)

[iris-bootstrap] ── Switching Iris to Firecracker sandbox ──
(automated: writes drop-in, daemon-reload, restarts iris)

[iris-bootstrap] ── Done ──
  ✓ Iris is running!
  Firecracker: iris-fc-public-sandbox → 172.20.1.2
  Sandbox:     --sandbox=firecracker:172.20.1.2
  Key Vault:   iris-kv-myhostname
  Terraform:   iris-tfstate-rg / iristfstatemyhostname
  VM logs:     journalctl -u iris-fc-public-sandbox -f
  Test:        @iris run: uname -a
```

---

## Telegram Setup

Iris can use Telegram instead of (or in addition to) Slack. No workspace invite needed — any Telegram user can message the bot directly.

> **Bootstrap handles this automatically.** During `bash bootstrap.sh --setup`, you will be asked `Set up Telegram integration?` — answer `Y` and paste your token. Bootstrap writes it to `/iris/.env` and sets `IRIS_TRANSPORT` for you. The steps below are for manual or post-install setup only.

**Step 1 — Create a bot via @BotFather**

1. Open Telegram and message `@BotFather`
2. Send `/newbot`
3. Enter a display name (e.g. `Iris`)
4. Enter a username ending in `bot` (e.g. `iris_mybot`)
5. Copy the token BotFather gives you — looks like `7123456789:AAFxyz...`

**Step 2 — Add the token to `/iris/.env`**

Open `/iris/.env` and add:

```
TELEGRAM_BOT_TOKEN=7123456789:AAFxyz...
IRIS_TRANSPORT=telegram
```

If using Azure Key Vault, store the token there instead:

```bash
KV=$(grep ^IRIS_KEY_VAULT /iris/.env | cut -d= -f2)
az keyvault secret set --vault-name "$KV" --name "TELEGRAM-BOT-TOKEN" --value "7123456789:AAFxyz..."
```

Then set `IRIS_TRANSPORT=telegram` in `/iris/.env`.

**Step 3 — Restart the service**

```bash
sudo systemctl restart iris
```

**Session mapping**

| Telegram context | Iris channel ID |
|---|---|
| DM with bot | `tg-{chat_id}` |
| Group chat (no topics) | `tg-{chat_id}` |
| Group with topics | `tg-{chat_id}-{thread_id}` |

**Bot commands**

| Command | Action |
|---|---|
| `/reset` | Clear conversation history |
| `/compact` | Summarise context to save tokens |
| `/stop` | Abort a running response |

**Running Slack and Telegram side by side**

Start two separate service instances pointing at the same `workingDir` — one with `--transport=slack`, one with `--transport=telegram`. Each user gets their own isolated channel directory; both share the same Iris brain and skills.

```bash
# iris-slack.service  → --transport=slack
# iris-telegram.service → --transport=telegram
# Both point to the same /iris/data working directory
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
IRIS_TRANSPORT=slack   # slack (default) | telegram
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
KV=$(grep ^IRIS_KEY_VAULT /iris/.env | cut -d= -f2)   # set by bootstrap --setup
az keyvault secret set --vault-name "$KV" --name "FOUNDRY-E2-KEY"   --value "<key>"
az keyvault secret set --vault-name "$KV" --name "SLACK-APP-TOKEN"  --value "xapp-..."
az keyvault secret set --vault-name "$KV" --name "SLACK-BOT-TOKEN"  --value "xoxb-..."
az keyvault secret set --vault-name "$KV" --name "GITHUB-TOKEN"     --value "ghp_..."
```

**`/iris/.env`** (simpler, no Azure required):

Run `bash bootstrap.sh --setup --no-keyvault` and the script will prompt for all values and write `/iris/.env` (chmod 600). Never commit this file.

Optional secrets (all providers):

- `ANTHROPIC-API-KEY` / `OPENAI-API-KEY` / `RESEND-API-KEY`
- `TELEGRAM-BOT-TOKEN` — required when `IRIS_TRANSPORT=telegram`

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
│   └── models.json.template        # template — bootstrap generates models.json from this
├── iris-runtime/                   # @iris-core/runtime — fork of pi-mom
│   └── src/
│       ├── main.ts                 # --provider, --model, --sandbox, --transport flags
│       ├── agent.ts                # configurable model, constitution loading
│       ├── slack.ts                # Slack Socket Mode transport
│       ├── telegram.ts             # Telegram Bot API transport (long polling)
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
| Jailer fails to chroot | `irisjailer` user missing | `sudo groupadd -g 10000 irisjailer 2>/dev/null; sudo useradd -u 10000 -g 10000 -r -s /usr/sbin/nologin irisjailer` |
| rootfs missing | Build script not run | `sudo bash scripts/build-firecracker-rootfs.sh` |
| `fatal: repository not found` during bootstrap | Upstream remote points to a private repo you don't have access to | Update with: `git remote set-url upstream https://github.com/irisworks/irisflow.git && git fetch upstream` |

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

