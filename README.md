# Iris Core

Iris is an always-on orchestrator for sub-agents. This repository is the source of truth for its constitution, bootstrap flow, Terraform infrastructure, runtime model config, and sub-agent scaffolding.

As of **April 11, 2026**, Iris runs on `@iris-core/runtime` — a provider-agnostic fork of `pi-mom` that ships in this repo under `iris-runtime/`. The runtime reads `IRIS_PROVIDER` and `IRIS_MODEL` env vars and loads custom providers from `data/models.json`. The default is `foundry-e2/Kimi-K2.5`.

## What This Repo Contains

- `CONSTITUTION.md`: Iris's immutable operator rules (injected read-only into system prompt)
- `MEMORY.md`: Iris's mutable global memory (she can append notes; operators set the initial rules)
- `CLAUDE.md`: repo-level writing rules for infrastructure and documentation
- `plan.md`: original architecture and phased build plan
- `bootstrap.sh`: rebuild Iris from a fresh VM
- `iris-runtime/`: `@iris-core/runtime` — provider-agnostic fork of pi-mom (the key addition)
- `terraform/`: Azure VM, networking, Key Vault, and sub-agent module
- `skills/`: Iris's top-level skills
- `agents/newsletter/`: first sub-agent scaffold
- `data/models.json`: Azure AI Foundry provider and model configuration

## Current State

Implemented:

- `iris-runtime/` fork of pi-mom — provider-agnostic, configurable via `--provider`/`--model` CLI flags or `IRIS_PROVIDER`/`IRIS_MODEL` env vars
- `CONSTITUTION.md` — operator rules injected read-only before all agent memory
- Iris constitution and repo structure
- Azure AI Foundry provider config pinned to `<your-azure-ai-account>`
- top-level skills for secrets, storage, Terraform, GitHub, Azure, spawning, promotion, and self-extension
- newsletter agent scaffold with its own constitution, bootstrap, and starter skills
- bootstrap script that builds iris-runtime from source and runs it natively via systemd
- Terraform for a dedicated Iris VM, Key Vault, VNet, subnet, NSG, public IP, and reusable child-agent module
- live VM runtime repaired and verified on `/iris` with `iris.service` and `iris-sandbox`
- live runtime confirmed on `foundry-e2/Kimi-K2.5`
- Slack end-to-end test passed on the current VM: clean state reset, scratch file write/read, dashboard artifact build, iterative update, and restart persistence

Still pending or not yet verified:

- application of the newer dedicated-VM Terraform in `terraform/main.tf`
- Phase 4 internal HTTP API for sub-agent communication
- Phase 5 hardening and full resurrection test

## Architecture

```text
You
└── Iris (orchestrator, Azure VM, pi-mom runtime)
    ├── Slack interface (@iris)
    ├── TUI interface (SSH + pi tooling)
    ├── skills/ auto-loaded from this repo
    ├── MEMORY.md read before each response
    └── sub-agents
        └── newsletter (preview + prod design complete, scaffolded in repo)
```

Design rules that matter operationally:

- all infrastructure changes go through Terraform
- GitHub is the durable source of truth; the VM is disposable
- secrets belong in Azure Key Vault
- new capabilities must be documented in this README
- sub-agents get preview and prod environments
- sub-agent communication should move to an internal API rather than Slack

## Runtime And Models

The repo ships pi-mom model config in [data/models.json](/home/azureuser/dev/iris-core/data/models.json). It now uses only the `<your-azure-ai-account>` Azure AI account via two provider entries:

- `foundry-e2`: chat/completions-compatible models on `<your-azure-ai-account>`
- `foundry-e2-responses`: Azure Responses-only models on `<your-azure-ai-account>`

Configured model set:

- `gpt-4o`
- `gpt-4o-mini`
- `gpt-5.4`
- `gpt-5.4-nano`
- `gpt-5.4-pro`
- `gpt-5.3-codex`
- `Kimi-K2.5`
- `grok-4-1-fast-non-reasoning`

Compatibility note:

- `gpt-5.4` and `gpt-5.4-nano` require `max_completion_tokens` on the chat/completions route; that compatibility is encoded in `data/models.json`
- `gpt-5.4-pro` and `gpt-5.3-codex` are Azure Responses-only deployments, so they are registered under `foundry-e2-responses`

## Rebuild From Scratch

### Prerequisites

```bash
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash
sudo apt-get install -y gh
wget -qO- https://apt.releases.hashicorp.com/gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] \
  https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt-get update && sudo apt-get install -y terraform

az login
gh auth login
az account set -s <your-subscription-id>
```

### Step 1: Create Terraform State Storage

```bash
az group create -n iris-tfstate-rg -l eastus
az storage account create \
  -n iristfstate -g iris-tfstate-rg \
  -l eastus --sku Standard_LRS \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false
az storage container create \
  -n tfstate --account-name iristfstate --auth-mode login
```

### Step 2: Deploy A Fresh Iris VM And Key Vault

This is the clean-room path. The Terraform exists, but the newer dedicated VM config had not yet been applied as of April 11, 2026.

```bash
git clone https://github.com/iris-core/iris-core.git
cd iris-core/terraform
export TF_VAR_ssh_public_key="$(cat ~/.ssh/iris_vm.pub)"
terraform init
terraform plan
terraform apply
```

### Step 3: Seed Required Secrets

Fetch the Key Vault name from Terraform output, then seed at minimum:

- `FOUNDRY-E2-KEY`
- `SLACK-APP-TOKEN`
- `SLACK-BOT-TOKEN`

Optional but supported:

- `ANTHROPIC-API-KEY`
- `OPENAI-API-KEY`
- `GITHUB-TOKEN`
- `RESEND-API-KEY`

Example:

```bash
KV=$(terraform output -raw key_vault_name)

az keyvault secret set --vault-name "$KV" --name "FOUNDRY-E2-KEY"   --value "<key>"
az keyvault secret set --vault-name "$KV" --name "SLACK-APP-TOKEN"  --value "xapp-..."
az keyvault secret set --vault-name "$KV" --name "SLACK-BOT-TOKEN"  --value "xoxb-..."
```

### Step 4: Bootstrap Iris

```bash
cd /home/azureuser/dev/iris-core
KV_NAME="$KV" bash bootstrap.sh
```

What `bootstrap.sh` does:

- installs Docker, Node.js 22, Azure CLI, GitHub CLI, Terraform, and `jq` if missing
- logs into Azure if needed
- uses the current repo checkout when run inside `iris-core`, or `REPO_DIR` if provided
- discovers the Iris Key Vault from `KV_NAME` or `KV_RESOURCE_GROUP`
- pulls secrets into `/iris/.env`
- symlinks `/iris/repo` back to the chosen repo path for compatibility
- symlinks `/iris/data/{MEMORY.md,CONSTITUTION.md,skills}` back to the repo
- copies `data/models.json` into the runtime workspace
- creates the `iris-sandbox` Docker container (for bash tool execution)
- **builds `iris-runtime/` from source** (`npm install && npm run build`)
- installs and enables `iris.service` (runs iris-runtime natively via systemd, not Docker)
- fails if `iris.service` does not come up cleanly after restart

Model selection (with defaults):
```bash
KV_NAME="$KV" IRIS_PROVIDER=foundry-e2 IRIS_MODEL=Kimi-K2.5 bash bootstrap.sh
```

### Step 5: Verify

```bash
sudo systemctl status iris
journalctl -u iris -f
```

Then message Iris in Slack:

```text
@iris what model are you?
```

Current verified Slack smoke test on the live VM:

- ask Iris for provider/model and workspace path
- have Iris write and read back a scratch file in the current channel
- have Iris build and attach a single-file HTML dashboard artifact
- restart `iris.service`
- ask Iris to recall the dashboard path and prior test project state

## iris-runtime — Provider-Agnostic Fork of pi-mom

`iris-runtime/` is a minimal fork of `badlogic/pi-mono`'s `packages/mom`. The diff from upstream is:

| File | Change |
|------|--------|
| `src/main.ts` | Add `--provider`, `--model`, `--environment`, `--api-port` CLI flags and env var support |
| `src/agent.ts` | Use `ModelRegistry.find()` instead of hardcoded `getModel("anthropic", ...)`. Add constitution loading. |
| `src/api.ts` | New file — stub HTTP server for sub-agent API traffic (disabled by default) |
| `package.json` | Rename to `@iris-core/runtime`, pin upstream versions |

All pi-ai / pi-agent-core / pi-coding-agent packages are consumed as-is from npm. When Mario ships updates, bump the version in `iris-runtime/package.json` and rebuild.

### Configuring the Model

```bash
# CLI flags
iris-runtime --provider foundry-e2 --model Kimi-K2.5 /iris/data

# Env vars (preferred in production)
IRIS_PROVIDER=foundry-e2
IRIS_MODEL=Kimi-K2.5
IRIS_ENV=prod          # preview | prod
IRIS_API_PORT=3001     # 0 = disabled (default)
```

Custom providers are registered in `data/models.json`. The runtime loads this file automatically from the workspace directory.

### Fallback Providers

To add a fallback, run two iris-runtime instances pointing at different channels or handle it at the models.json level by registering both providers and using whichever has a valid API key.

## Repository Layout

```text
iris-core/
├── bootstrap.sh              # rebuild Iris on a fresh VM
├── CLAUDE.md
├── CONSTITUTION.md           # operator rules — injected read-only into system prompt
├── MEMORY.md                 # Iris's mutable global memory
├── README.md
├── plan.md
├── data/
│   └── models.json           # Azure AI Foundry provider/model config
├── iris-runtime/             # @iris-core/runtime — fork of pi-mom
│   ├── src/
│   │   ├── main.ts           # MODIFIED: --provider, --model, --environment, --api-port flags
│   │   ├── agent.ts          # MODIFIED: configurable model, constitution loading
│   │   ├── api.ts            # ADDED: internal HTTP API stub
│   │   ├── slack.ts          # upstream (unchanged)
│   │   ├── context.ts        # upstream (unchanged)
│   │   ├── store.ts          # upstream (unchanged)
│   │   └── ...
│   └── package.json          # name: @iris-core/runtime
├── skills/
│   ├── azure/
│   ├── get-secret/
│   ├── github/
│   ├── promote-skill/
│   ├── self-extend/
│   ├── spawn-agent/
│   ├── store-file/
│   └── terraform/
├── agents/
│   └── newsletter/
└── terraform/
    ├── main.tf
    ├── backend.tf
    ├── providers.tf
    ├── variables.tf
    ├── outputs.tf
    └── modules/agent/
```

## Newsletter Agent

The first sub-agent scaffold lives in [agents/newsletter](/home/azureuser/dev/iris-core/agents/newsletter). It includes:

- its own `MEMORY.md`
- its own `README.md`
- a bootstrap script
- starter skills for drafting content, managing subscribers, sending, deliverability, self-healing, and promotion

Its intended operating model is preview plus prod containers with file-queue escalation back to Iris until the internal API exists.

## Company-Specific Extensions

To create a private fork with company-specific configuration:

```bash
# Create your company repo
gh repo create iris-yourcompany --private
cd iris-yourcompany

# Add iris-core as submodule
git submodule add https://github.com/iris-core/iris-core.git core

# Create overlay structure
mkdir -p overlay/{agents,skills,data}

# Configure company-specific settings
cp core/.env.example .env
# Edit .env with your values

# Add company-specific agents and skills
# ...

# Use company-specific bootstrap wrapper
```

See `CONTRIBUTING.md` for the full extension pattern.


## Operational Notes

- The live VM workspace uses `/iris/data` with repo-backed symlinks for hot reload.
- `SKILL.md` edits are expected to hot-reload through pi-mom without a restart.
- Do not treat the current README as proof that all planned infrastructure has been applied; verify runtime assumptions directly on the VM.
- Do not store secrets in the repo, `.env`, or Terraform state committed to Git.

## Source Documents

If you are resuming work, read these first:

- [CLAUDE.md](/home/azureuser/dev/iris-core/CLAUDE.md)
- [CONSTITUTION.md](/home/azureuser/dev/iris-core/CONSTITUTION.md)
- [MEMORY.md](/home/azureuser/dev/iris-core/MEMORY.md)
- [plan.md](/home/azureuser/dev/iris-core/plan.md)

## Commit Log

**2025-04-13 19:35** — Remove aggressive 40-message `transformContext` trim from runtime

- Removed hardcoded `MAX_CONTEXT_MESSAGES=40` limit from `iris-runtime/src/agent.ts`
- This was running every turn and dropping old messages without summarization
- Context management now relies entirely on pi-framework's auto-compaction (configured via `settings.json` with `reserveTokens` and `keepRecentTokens`)

**2025-04-13 19:52** — Increase bridge timeout from 30s to 60s

- Changed `BRIDGE_TIMEOUT_MS` in `iris-runtime/src/bridge.ts` from 30,000ms to 60,000ms
- Sub-agents now have 60 seconds to respond before Iris considers the request timed out
