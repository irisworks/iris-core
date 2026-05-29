# Iris — Complete Setup Guide

Iris is an always-on AI assistant that lives on a cloud server and talks to your team through Slack. She can run code, manage files, call APIs, and spin up her own specialized sub-agents — all from a Slack message.

This guide walks you through every step of setting Iris up, from zero to a running system. No prior experience with cloud infrastructure is assumed.

---

## Table of Contents

- [What Iris Does](#what-iris-does)
- [How to Choose Your Setup Path](#how-to-choose-your-setup-path)
- [Before You Start — Prerequisites](#before-you-start--prerequisites)
  - [The Server](#the-server)
  - [Slack](#slack)
  - [An LLM Provider API Key](#an-llm-provider-api-key)
  - [Optional: Azure Account](#optional-azure-account)
  - [Optional: GitHub Account](#optional-github-account)
- [Setting Up Your Slack App](#setting-up-your-slack-app)
- [Option 1 — Simplest Setup (No Azure, No Firecracker)](#option-1--simplest-setup-no-azure-no-firecracker)
- [Option 2 — Azure Key Vault (No Firecracker)](#option-2--azure-key-vault-no-firecracker)
- [Option 3 — Firecracker Isolation (No Azure)](#option-3--firecracker-isolation-no-azure)
- [Option 4 — Full Production (Azure + Firecracker)](#option-4--full-production-azure--firecracker)
- [Verifying Iris is Working](#verifying-iris-is-working)
- [Managing the Iris Service](#managing-the-iris-service)
- [Changing Your LLM Provider or Model](#changing-your-llm-provider-or-model)
- [Adding and Managing Secrets](#adding-and-managing-secrets)
- [Troubleshooting](#troubleshooting)
- [Repository Layout](#repository-layout)
- [Operational Notes](#operational-notes)

---

## What Iris Does

When a team member @mentions Iris in Slack, she:

1. Receives the message over a persistent WebSocket connection (Slack Socket Mode)
2. Passes it to a large language model (Claude, GPT-4, or any compatible provider)
3. Runs tools — bash commands, file reads/writes, API calls — on your server
4. Posts the response back to Slack as a thread reply

She can also run code inside isolated Firecracker microVMs (lightweight virtual machines that boot in ~125 ms), schedule recurring tasks, manage secrets, call external APIs, and delegate to specialized sub-agents.

---

## How to Choose Your Setup Path

Read the two questions below and follow the column/row to your option number.

```
Q1. Do you have an Azure account?
    │
    ├── NO  ──► Q2. Do you want isolated sandbox VMs?
    │               ├── NO  ──►  Option 1  (simplest — start here)
    │               └── YES ──►  Option 3  (requires KVM on your server)
    │
    └── YES ──► Q2. Do you want isolated sandbox VMs?
                    ├── NO  ──►  Option 2
                    └── YES ──►  Option 4  (full production)
```

**Not sure?** Start with Option 1. You can migrate to a more secure option later without losing any data.

| Option | Azure | Firecracker | Best for |
|--------|-------|-------------|----------|
| 1 | ✗ | ✗ | First-time users, personal projects, prototypes |
| 2 | ✓ | ✗ | Teams that already use Azure and want central secret management |
| 3 | ✗ | ✓ | Security-conscious users who want VM isolation without Azure |
| 4 | ✓ | ✓ | Production deployments with full isolation and secret management |

---

## Before You Start — Prerequisites

Complete every item in this section before running any setup command.

### The Server

Iris needs a Linux server that is always online. A cloud VM is the right choice (not your laptop).

**Minimum spec:**
- Ubuntu 22.04 LTS (other Debian-based distros may work but are untested)
- 2 vCPU, 4 GB RAM, 30 GB disk
- A public IP address (so Slack can reach it — actually Iris connects *outward* to Slack, so no inbound ports are required unless you add webhooks)

**If you want Firecracker (Options 3 or 4):**
- Your VM must support KVM (hardware virtualisation)
- On Azure: use the **Ddsv5 series** (e.g. `Standard_D4ds_v5`)
- B-series, D-series without the second "d", and F-series do **not** support KVM
- Check KVM is available: `ls /dev/kvm` — you should see the file, not "No such file"

**How to SSH into your server:**
```bash
# Replace user and server-ip with your values
ssh azureuser@<your-server-ip>
```

All commands in this guide are typed into that SSH session unless otherwise noted.

---

### Slack

You need to be an **admin** of a Slack workspace, or ask your Slack admin to create an app for you.

You will need two tokens:
- **App Token** — starts with `xapp-`
- **Bot Token** — starts with `xoxb-`

The [Setting Up Your Slack App](#setting-up-your-slack-app) section below walks through exactly how to get these.

---

### An LLM Provider API Key

Iris needs access to a large language model. Pick one:

| Provider | Where to get a key | Key format |
|---|---|---|
| Anthropic (Claude) | https://console.anthropic.com | `sk-ant-api03-...` |
| OpenAI (GPT-4) | https://platform.openai.com/api-keys | `sk-proj-...` |
| Azure AI Foundry | Azure Portal → AI Foundry resource | UUID format |
| AWS Bedrock | AWS Console → IAM credentials | Access key + secret |

**Recommended for beginners:** Anthropic Claude. Create an account, add a payment method, and generate an API key. The bootstrap script will ask for it.

---

### Optional: Azure Account

Required only for Options 2 and 4. You need:
- An Azure subscription
- The Azure CLI installed on your server — the bootstrap script installs it for you

---

### Optional: GitHub Account

Iris uses GitHub to pull updates and commit memory changes. You need:
- A GitHub account (free)
- The GitHub CLI (`gh`) — the bootstrap script installs it for you
- A personal access token or browser-based login (the setup script handles this interactively)

---

## Setting Up Your Slack App

This section covers creating the Slack app completely from scratch. The bootstrap script will pause and show you this box — this section explains each step in detail.

> **Tip:** Open https://api.slack.com/apps in a browser tab before running the bootstrap script. The script will wait while you complete the Slack setup.

---

### Step 1 — Create the app

1. Go to https://api.slack.com/apps
2. Click **Create New App** (top right)
3. Select **From scratch**
4. App Name: type `Iris` (or any name you like)
5. Pick Workspace: choose your Slack workspace from the dropdown
6. Click **Create App**

You will land on the app's **Basic Information** page.

---

### Step 2 — Enable Socket Mode and get your App Token

Socket Mode lets Iris connect to Slack over a persistent WebSocket (no inbound firewall rules needed).

1. In the left sidebar, click **Socket Mode**
2. Toggle **Enable Socket Mode** to ON
3. A popup appears asking for a token name — type `iris-socket`
4. Under **Scopes**, check `connections:write`
5. Click **Generate**
6. Copy the token that appears — it starts with `xapp-1-...`
7. Save it somewhere safe (a text file on your desktop is fine for now)

---

### Step 3 — Add Bot Token Scopes

Scopes define what Iris is allowed to do in your workspace.

1. In the left sidebar, click **OAuth & Permissions**
2. Scroll down to **Bot Token Scopes**
3. Click **Add an OAuth Scope** and add each of these one by one:

| Scope | What it allows |
|---|---|
| `app_mentions:read` | See messages that @mention Iris |
| `channels:history` | Read messages in public channels |
| `channels:read` | See channel names and IDs |
| `chat:write` | Post messages |
| `files:read` | Read files shared with Iris |
| `files:write` | Upload files to Slack |
| `groups:history` | Read messages in private channels |
| `groups:read` | See private channel names |
| `im:history` | Read direct messages |
| `im:read` | See DM info |
| `im:write` | Send DMs |
| `mpim:history` | Read multi-person DMs |
| `reactions:write` | Add emoji reactions |
| `users:read` | Look up user names by ID |

---

### Step 4 — Install the app to your workspace

1. Still on **OAuth & Permissions**, scroll up
2. Click **Install to Workspace**
3. Click **Allow** on the permissions screen
4. Copy the **Bot User OAuth Token** — it starts with `xoxb-...`
5. Save it alongside your App Token

---

### Step 5 — Subscribe to events

1. In the left sidebar, click **Event Subscriptions**
2. Toggle **Enable Events** to ON
3. Under **Subscribe to bot events**, click **Add Bot User Event** and add:
   - `app_mention`
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
4. Click **Save Changes**

---

### Step 6 — Enable the App Home tab

1. In the left sidebar, click **App Home**
2. Under **Show Tabs**, toggle **Messages Tab** to ON
3. Check **Allow users to send Slash commands and messages from the messages tab**

---

### Step 7 — Invite Iris to a channel

After the bootstrap script finishes and Iris is running:

1. Open any channel in Slack
2. Type `/invite @Iris` and press Enter
3. Test with: `@iris what model are you?`

---

## Option 1 — Simplest Setup (No Azure, No Firecracker)

Iris runs directly on your server. Secrets are stored in `/iris/.env`. No cloud account needed beyond your LLM provider.

**You need:** Ubuntu 22.04 server · LLM API key · Slack workspace (admin)

**Time to complete:** ~10 minutes

---

### Step 1 — Clone the repository

SSH into your server and run:

```bash
sudo mkdir -p /iris
sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/irisflow.git /iris/repo
cd /iris/repo
```

What this does:
- Creates `/iris` — the directory where Iris stores everything
- Clones this repository to `/iris/repo`

---

### Step 2 — Run the bootstrap script

```bash
bash bootstrap.sh --setup --no-keyvault
```

The script is interactive. Here is exactly what it will ask and what to type:

---

**System dependencies** (automated — no input needed)

The script installs Docker, Node.js 22, jq, nginx, certbot, GitHub CLI, and Terraform. This takes 2–3 minutes.

```
[iris-bootstrap] ── System dependencies ──
Installing Docker...
Installing Node.js 22...
...
```

---

**GitHub login**

```
[iris-bootstrap] ── GitHub login ──
```

A browser window opens (or shows a device code if you're in a headless terminal). Log in with your GitHub account. If you don't have one, press Enter to skip — Iris will work without it.

---

**LLM provider selection**

```
[iris-bootstrap] Choose LLM provider:
  1) anthropic       — Claude Sonnet / Opus (recommended)
  2) openai          — GPT-4o / GPT-4
  3) foundry-e2      — Azure AI Foundry
  4) amazon-bedrock  — AWS Bedrock
[iris-bootstrap] Choice [1]:
```

Type `1` and press Enter (or the number for your provider).

---

**API key**

```
[iris-bootstrap] Anthropic API key (sk-ant-...):
```

Paste your API key and press Enter. The key will not be shown on screen as you type.

---

**Slack setup**

```
[iris-bootstrap] Set up Slack integration? [Y/n]
```

Press Enter (defaults to Yes). The bootstrap script shows the Slack setup instructions (summarised above). Complete the [Setting Up Your Slack App](#setting-up-your-slack-app) steps, then return here.

```
[iris-bootstrap] Press Enter when your app is created and tokens are ready...
[iris-bootstrap] Slack App token (xapp-...):
```

Paste your App Token (`xapp-...`) and press Enter.

```
[iris-bootstrap] Slack Bot token (xoxb-...):
```

Paste your Bot Token (`xoxb-...`) and press Enter.

---

**Optional integrations**

```
[iris-bootstrap] Add GitHub token for repo access? [Y/n]
```

Press Enter to use the GitHub CLI token you already authenticated. Press `n` to skip.

```
[iris-bootstrap] Set up email sending (Resend.com)? [y/N]
```

Press Enter to skip (you can add this later).

```
[iris-bootstrap] Set up public domain (e.g. iris.example.com)? [y/N]
```

Press Enter to skip unless you have a domain and want HTTPS.

```
[iris-bootstrap] Git author email for Iris commits [iris@example.com]:
```

Type your email or press Enter to use the default.

---

**Automated completion**

The script now does everything automatically:

```
[iris-bootstrap] ── Workspace ──
Writing /iris/.env...
Symlinking MEMORY.md → /iris/data/MEMORY.md...
Symlinking skills/ → /iris/data/skills...

[iris-bootstrap] ── Building iris-runtime ──
Running npm install...
Running npm run build...

[iris-bootstrap] ── Installing systemd service ──
Writing /etc/systemd/system/iris.service...
Starting iris.service...
```

---

**Done message**

```
[iris-bootstrap] ── Done ──
  ✓ Iris is running!
  Status:    sudo systemctl status iris
  Logs:      sudo journalctl -u iris -f
  Secrets:   /iris/.env
  Slack:     @iris in any channel
```

---

### Step 3 — Verify

```bash
sudo systemctl status iris
```

You should see `Active: active (running)`. If you see something else, jump to [Troubleshooting](#troubleshooting).

Then in Slack, invite Iris to a channel:
```
/invite @Iris
@iris what model are you?
```

Iris should reply within a few seconds.

---

## Option 2 — Azure Key Vault (No Firecracker)

Same as Option 1, but all secrets (API keys, tokens) are stored in Azure Key Vault instead of a file on disk. This means:
- Secrets survive a VM rebuild
- You can rotate secrets without SSH-ing into the server
- Audit logs show who accessed what

**You need:** Everything from Option 1 + an Azure account with Contributor access

**Time to complete:** ~15 minutes

---

### Step 1 — Clone the repository

```bash
sudo mkdir -p /iris
sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/irisflow.git /iris/repo
cd /iris/repo
```

---

### Step 2 — Log in to Azure before running the script

The bootstrap script can handle Azure login, but doing it manually first avoids timeouts:

```bash
az login
```

If you're on a headless server (no browser), use device code login:

```bash
az login --use-device-code
```

The command prints a URL and a code. Open the URL in any browser, enter the code, and log in. When done, come back to the terminal — it confirms with:

```
[
  {
    "cloudName": "AzureCloud",
    "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name": "My Subscription",
    ...
  }
]
```

Note your subscription ID — you may need it.

---

### Step 3 — Run the bootstrap script

```bash
bash bootstrap.sh --setup --keyvault
```

The script runs the same prompts as Option 1 with two additions:

**Key Vault name:**

```
[iris-bootstrap] Key Vault name [iris-kv-myhostname]:
```

Press Enter to use the suggested name (based on your server's hostname), or type a custom name. Key Vault names must be globally unique across all of Azure, 3–24 characters, letters and numbers only.

**Resource group:**

```
[iris-bootstrap] Resource group for Key Vault [iris-rg]:
```

Press Enter to use `iris-rg`, or type an existing resource group name.

---

**What happens next (all automated):**

```
[iris-bootstrap] ── Key Vault setup ──
Creating resource group iris-rg...
Creating Key Vault iris-kv-myhostname...
Storing ANTHROPIC-API-KEY in Key Vault...
Storing SLACK-APP-TOKEN in Key Vault...
Storing SLACK-BOT-TOKEN in Key Vault...
Storing GITHUB-TOKEN in Key Vault...
Granting iris VM identity access to Key Vault...
```

Then the rest of the build and service install happens as in Option 1.

---

### Step 4 — Verify

```bash
sudo systemctl status iris
```

Then in Slack:
```
/invite @Iris
@iris what model are you?
```

---

### Managing secrets in Key Vault

To update a secret later:

```bash
# Get your Key Vault name
KV=$(grep ^IRIS_KEY_VAULT /iris/.env | cut -d= -f2)

# Update a secret
az keyvault secret set --vault-name "$KV" --name "ANTHROPIC-API-KEY" --value "sk-ant-new-key..."
```

Iris reads secrets at startup. After changing a secret, restart Iris:

```bash
sudo systemctl restart iris
```

---

## Option 3 — Firecracker Isolation (No Azure)

Every bash command Iris runs executes inside a **Firecracker microVM** — a lightweight virtual machine that boots in ~125 ms. This means:

- If Iris runs untrusted code, it cannot affect your host server
- Each Slack channel gets its own clean VM
- VMs are automatically destroyed after 30 minutes of inactivity

This option does not use Azure for secrets — they stay in `/iris/.env`.

**You need:** Ubuntu 22.04 server **with KVM support** · LLM API key · Slack workspace

**Does your server support KVM?** Run this check:
```bash
ls /dev/kvm && echo "KVM is available" || echo "KVM NOT found — wrong VM type"
```

If you see "KVM NOT found" and you're on Azure, you need to resize to a **Ddsv5 series** VM (e.g. `Standard_D4ds_v5`).

**Time to complete:** ~20 minutes (includes building the microVM rootfs)

---

### Step 1 — Clone the repository

```bash
sudo mkdir -p /iris
sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/irisflow.git /iris/repo
cd /iris/repo
```

---

### Step 2 — Run the bootstrap script

```bash
bash bootstrap.sh --setup --no-keyvault --firecracker
```

---

**KVM check** (automated)

```
[iris-bootstrap] ── KVM check ──
✓ /dev/kvm found
Adding azureuser to kvm group...
```

If the kvm group was just added, the script automatically re-executes itself with the new group — you do not need to log out.

---

**Firecracker installation** (automated — ~2 minutes)

```
[iris-bootstrap] ── Firecracker setup ──
Downloading firecracker v1.7.0...
Downloading jailer v1.7.0...
Creating irisjailer system user (uid/gid 10000)...
Downloading Linux kernel vmlinux...
Setting /dev/kvm permissions...
```

Firecracker is the virtualisation engine. The jailer runs it as a non-root user in a chroot for extra isolation. These are automatically placed in `/usr/local/bin/`.

---

**Same prompts as Option 1 for GitHub, LLM provider, and Slack tokens.**

---

**Build with Docker image** (automated — ~3 minutes)

```
[iris-bootstrap] ── Building iris-runtime ──
Running npm install...
Running npm run build...
Building Docker image iris-runtime:local...
Building rootfs.ext4 from Docker image...
  (This takes about 60 seconds)
rootfs.ext4 written to /var/lib/iris/firecracker/
```

The rootfs is a 2 GB ext4 disk image containing the complete runtime environment. Each microVM gets its own copy so changes in one VM never affect others.

---

**Provisioning the sandbox VM** (automated)

```
[iris-bootstrap] ── Provisioning Firecracker sandbox VM ──
Writing vm-config.json...
Writing iris-fc-public-sandbox.service...
Starting iris-fc-public-sandbox...
```

A systemd service called `iris-fc-public-sandbox` manages the always-on sandbox VM at IP `172.20.1.2`.

---

**Health check**

```
[iris-bootstrap] ── Firecracker health check ──
Waiting for VM at http://172.20.1.2:8080/health (up to 20s)...
✓ VM is healthy (4s)
```

The exec server inside the VM listens on port 8080 and reports ready.

---

**Switching Iris to Firecracker mode** (automated)

```
[iris-bootstrap] ── Switching Iris to Firecracker sandbox ──
Writing /etc/systemd/system/iris.service.d/sandbox.conf...
Running systemctl daemon-reload...
Restarting iris...
```

A systemd drop-in file changes the sandbox flag from `--sandbox=host` to `--sandbox=firecracker:172.20.1.2`. This means Iris's bash tool now runs inside the microVM.

---

**Done message**

```
[iris-bootstrap] ── Done ──
  ✓ Iris is running!
  Firecracker: iris-fc-public-sandbox → 172.20.1.2
  Sandbox:     --sandbox=firecracker:172.20.1.2
  Secrets:     /iris/.env
  VM logs:     journalctl -u iris-fc-public-sandbox -f
  Test:        @iris run: uname -a
```

---

### Step 3 — Verify

**Check Iris:**
```bash
sudo systemctl status iris
```

**Check the Firecracker VM:**
```bash
sudo systemctl status iris-fc-public-sandbox
```

**Check the VM responds:**
```bash
curl http://172.20.1.2:8080/health
# Expected output: {"status":"ok"}
```

**In Slack:**
```
/invite @Iris
@iris run: uname -a
```

Iris should reply with the kernel info from inside the microVM — something like:
```
Linux iris-fc-public-sandbox 5.10.x #1 SMP ...
```

Notice the hostname — that confirms the command ran inside the VM, not on your host.

---

### Resetting a VM between sessions

Firecracker VMs are ephemeral by design. To restore a VM to a clean state:

```bash
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

Dynamic pool VMs (one-per-channel) are automatically reset when idle for 30 minutes — no manual steps needed.

---

## Option 4 — Full Production (Azure + Firecracker)

Combines everything: Firecracker microVM isolation + Azure Key Vault for secrets + Terraform to manage VM lifecycle as infrastructure-as-code.

**You need:** Everything from Option 3 + an Azure account

**Time to complete:** ~25 minutes

---

### Step 1 — Clone the repository

```bash
sudo mkdir -p /iris
sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/irisflow.git /iris/repo
cd /iris/repo
```

---

### Step 2 — Log in to Azure

```bash
az login
# Or on a headless server:
az login --use-device-code
```

---

### Step 3 — Run the bootstrap script

```bash
bash bootstrap.sh --setup --keyvault --firecracker
```

This runs all of the same steps as Options 2 and 3 combined. The script will ask for:

---

**Key Vault name:**

```
[iris-bootstrap] Key Vault name [iris-kv-myhostname]:
```

Press Enter or type a custom name. Must be globally unique in Azure.

**Resource group:**

```
[iris-bootstrap] Resource group for Key Vault [iris-rg]:
```

Press Enter or enter an existing resource group.

**Terraform state storage account:**

```
[iris-bootstrap] Terraform state storage account name (lowercase + numbers, max 24 chars) [iristfstatemyhostname]:
```

Press Enter or type a custom name. This Azure Storage account stores Terraform's state file so infrastructure can be rebuilt from scratch. Name must be globally unique, lowercase letters and numbers only, 3–24 characters.

---

**What Terraform does:**

```
[iris-bootstrap] ── Provisioning Firecracker sandbox VM ──
Creating Terraform state storage iristfstatemyhostname...
Running terraform init...
Running terraform plan...
Running terraform apply...
  azurerm_resource_group.iris: Creating...
  azurerm_virtual_machine.iris_fc_public_sandbox: Creating...
  ...
Apply complete! Resources: 3 added.
```

Terraform creates the Firecracker VM configuration as code. This means if your server is ever rebuilt from scratch, running `terraform apply` recreates all VMs in the same state — no manual steps.

---

**Done message:**

```
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

### Step 4 — Verify

```bash
# Iris service
sudo systemctl status iris

# Firecracker VM
sudo systemctl status iris-fc-public-sandbox

# VM health
curl http://172.20.1.2:8080/health

# Key Vault access
KV=$(grep ^IRIS_KEY_VAULT /iris/.env | cut -d= -f2)
az keyvault secret list --vault-name "$KV" --query "[].name" -o tsv
```

In Slack:
```
/invite @Iris
@iris run: uname -a
```

---

## Verifying Iris is Working

Run these checks after any option to confirm everything is healthy.

### 1 — Check the service is running

```bash
sudo systemctl status iris
```

Expected output (the important part):

```
● iris.service - Iris AI Agent
     Loaded: loaded (/etc/systemd/system/iris.service; enabled)
     Active: active (running) since Mon 2025-01-01 12:00:00 UTC; 1min ago
```

If you see `failed` or `inactive`, check the logs:

```bash
sudo journalctl -u iris -n 50 --no-pager
```

### 2 — Watch live logs

```bash
sudo journalctl -u iris -f
```

You should see a line like:
```
⚡️ Iris connected and listening!
```

Press `Ctrl+C` to stop watching logs.

### 3 — Test from Slack

In any channel where you've invited Iris:

```
@iris what model are you?
@iris what time is it?
@iris run: echo "hello from Iris"
```

The last one should show the output of the echo command.

---

## Managing the Iris Service

All service management uses `systemctl`. You must prefix these commands with `sudo`.

```bash
# See if Iris is running
sudo systemctl status iris

# Start Iris
sudo systemctl start iris

# Stop Iris (graceful — waits for current request to finish)
sudo systemctl stop iris

# Restart Iris (stop + start)
sudo systemctl restart iris

# Enable auto-start on server reboot (already done by bootstrap)
sudo systemctl enable iris

# Disable auto-start on reboot
sudo systemctl disable iris
```

### Watch live logs

```bash
# Follow logs in real time (press Ctrl+C to exit)
sudo journalctl -u iris -f

# Show last 100 lines
sudo journalctl -u iris -n 100 --no-pager

# Show logs since a specific time
sudo journalctl -u iris --since "2025-01-01 12:00:00"
```

### Iris is not responding after a reboot

If `start` silently does nothing, the compiled JavaScript may be missing:

```bash
cd /iris/repo/iris-runtime
npm install
npm run build
sudo systemctl start iris
```

### Firecracker VM commands (Options 3 and 4 only)

```bash
# Check the sandbox VM
sudo systemctl status iris-fc-public-sandbox

# Start/stop/restart the VM
sudo systemctl start iris-fc-public-sandbox
sudo systemctl stop iris-fc-public-sandbox
sudo systemctl restart iris-fc-public-sandbox

# View VM logs
sudo journalctl -u iris-fc-public-sandbox -f

# Test the VM's exec server directly
curl http://172.20.1.2:8080/health
```

---

## Changing Your LLM Provider or Model

### Check the current setting

```bash
grep IRIS_PROVIDER /iris/.env
grep IRIS_MODEL /iris/.env
```

### Change to a different model

Edit `/iris/.env`:

```bash
nano /iris/.env
```

Change these lines:

```bash
IRIS_PROVIDER=anthropic
IRIS_MODEL=claude-sonnet-4-5
```

Available providers and example models:

| `IRIS_PROVIDER` | `IRIS_MODEL` example | Notes |
|---|---|---|
| `anthropic` | `claude-sonnet-4-5` | Recommended default |
| `anthropic` | `claude-opus-4-8` | Most capable, slower |
| `openai` | `gpt-4o` | OpenAI's flagship |
| `openai` | `gpt-4o-mini` | Faster, cheaper |
| `foundry-e2` | `Kimi-K2.5` | Azure AI Foundry |
| `amazon-bedrock` | `anthropic.claude-3-5-sonnet-20241022-v2:0` | AWS Bedrock |

Full list of configured models: `cat /iris/repo/data/models.json`

After editing, restart Iris:

```bash
sudo systemctl restart iris
```

Verify the change took effect:

```
@iris what model are you?
```

### You can also set the model from the CLI

If you need to test a specific model without restarting the service, you can run iris-runtime directly:

```bash
# This is just for testing — your systemd service is still running with the old model
/iris/repo/iris-runtime/dist/main.js \
  --provider anthropic \
  --model claude-opus-4-8 \
  --sandbox=host \
  /iris/data
```

---

## Adding and Managing Secrets

### Where secrets are stored

| Setup option | Secret storage |
|---|---|
| Option 1 or 3 | `/iris/.env` on the server |
| Option 2 or 4 | Azure Key Vault |

### Option 1 / 3 — `/iris/.env`

View current secrets:

```bash
cat /iris/.env
```

Edit a secret:

```bash
nano /iris/.env
```

The file looks like:

```bash
IRIS_PROVIDER=anthropic
IRIS_MODEL=claude-sonnet-4-5
ANTHROPIC_API_KEY=sk-ant-api03-...
IRIS_SLACK_APP_TOKEN=xapp-1-...
IRIS_SLACK_BOT_TOKEN=xoxb-...
GITHUB_TOKEN=ghp_...
```

After editing, restart Iris:

```bash
sudo systemctl restart iris
```

### Option 2 / 4 — Azure Key Vault

Find your Key Vault name:

```bash
grep IRIS_KEY_VAULT /iris/.env
```

List all secrets:

```bash
az keyvault secret list --vault-name "YOUR-KEY-VAULT-NAME" --query "[].name" -o tsv
```

Read a secret value:

```bash
az keyvault secret show --vault-name "YOUR-KEY-VAULT-NAME" --name "ANTHROPIC-API-KEY" --query value -o tsv
```

Update a secret:

```bash
az keyvault secret set \
  --vault-name "YOUR-KEY-VAULT-NAME" \
  --name "ANTHROPIC-API-KEY" \
  --value "sk-ant-new-key-here"
```

Add a new secret:

```bash
az keyvault secret set \
  --vault-name "YOUR-KEY-VAULT-NAME" \
  --name "RESEND-API-KEY" \
  --value "re_..."
```

After any secret change:

```bash
sudo systemctl restart iris
```

---

## Troubleshooting

### Quick diagnosis checklist

Run these commands in order. The first one that shows a problem is where to focus:

```bash
# 1. Is the service running?
sudo systemctl status iris

# 2. Any errors in the logs?
sudo journalctl -u iris -n 50 --no-pager

# 3. Does the env file exist and have values?
cat /iris/.env

# 4. Is the compiled JavaScript present?
ls -la /iris/repo/iris-runtime/dist/main.js

# 5. Can Node.js run the file?
node /iris/repo/iris-runtime/dist/main.js --help
```

---

### Problem: `iris.service` fails to start

**Check the error:**
```bash
sudo journalctl -u iris -n 30 --no-pager
```

**Common causes:**

| Error in logs | Cause | Fix |
|---|---|---|
| `Cannot find module` | Build output missing | Run `cd /iris/repo/iris-runtime && npm install && npm run build` |
| `Missing env: IRIS_SLACK_BOT_TOKEN` | `/iris/.env` not written | Run `cat /iris/.env` to check; re-run bootstrap if empty |
| `Error: No API key found for anthropic` | API key missing or wrong var name | Check `/iris/.env` has `ANTHROPIC_API_KEY=sk-ant-...` |
| `EADDRINUSE: address already in use` | Another process on port 3000 | `sudo lsof -i :3000` to find it; `sudo kill <pid>` |

---

### Problem: `/dev/kvm` not found (Options 3 and 4)

Your VM does not support hardware virtualisation.

**On Azure:** You need to resize to a VM that supports nested virtualisation. Open the Azure Portal → your VM → Resize → filter for `Ddsv5` → pick `Standard_D4ds_v5`.

**Verify after resize:**
```bash
ls /dev/kvm && echo "KVM found"
```

---

### Problem: `firecracker: permission denied`

Your user is not in the `kvm` group.

```bash
sudo usermod -aG kvm $USER
```

Then **log out and SSH back in** — group changes only apply to new sessions.

**Verify:**
```bash
groups | grep kvm
```

---

### Problem: Firecracker VM starts but `/health` times out

The exec server inside the VM is not running.

**Check VM logs:**
```bash
sudo journalctl -u iris-fc-public-sandbox -n 50 --no-pager
```

**Restart the VM:**
```bash
sudo systemctl restart iris-fc-public-sandbox
```

**Wait and test:**
```bash
# Wait 5 seconds for boot
sleep 5
curl http://172.20.1.2:8080/health
```

If the VM keeps failing, rebuild the rootfs:

```bash
sudo bash /iris/repo/scripts/build-firecracker-rootfs.sh
sudo systemctl restart iris-fc-public-sandbox
```

---

### Problem: Jailer fails to chroot — `irisjailer` user missing

The system user for Firecracker isolation was not created.

```bash
sudo groupadd -g 10000 irisjailer 2>/dev/null || true
sudo useradd -u 10000 -g 10000 -r -s /usr/sbin/nologin irisjailer 2>/dev/null || true
sudo systemctl restart iris-fc-public-sandbox
```

---

### Problem: Iris is in Slack but not responding

**Check it's connected:**
```bash
sudo journalctl -u iris -n 10 --no-pager | grep -i "connected\|listening\|error"
```

**Common causes:**
- Slack tokens are wrong or expired → update `/iris/.env` and `sudo systemctl restart iris`
- Iris is not invited to the channel → type `/invite @Iris` in the channel
- The event subscriptions were not saved → go back to the Slack app settings and verify Step 5 of [Setting Up Your Slack App](#setting-up-your-slack-app)

---

### Problem: `fatal: repository not found` during bootstrap

The git remote is pointing to a private repo you don't have access to.

```bash
cd /iris/repo
git remote set-url upstream https://github.com/irisworks/irisflow.git
git fetch upstream
```

---

### Problem: Azure login fails or subscription not found

**List your subscriptions:**
```bash
az account list --output table
```

**Set the correct subscription:**
```bash
az account set --subscription "YOUR-SUBSCRIPTION-ID"
```

**Re-login if needed:**
```bash
az logout
az login --use-device-code
```

---

### Problem: Iris replies with an error about context or memory

Iris's context file may be corrupted. Reset it:

```bash
# Replace C12345 with your actual channel ID
rm -f /iris/data/C12345/context.jsonl
sudo systemctl restart iris
```

You can find channel IDs in Slack by right-clicking a channel → View channel details → copy the ID at the bottom.

---

### Getting more help

1. Check the full logs: `sudo journalctl -u iris --since today --no-pager`
2. Look at Iris's memory: `cat /iris/data/MEMORY.md`
3. Look at the channel log: `cat /iris/data/C12345/log.jsonl | tail -20`

---

## Repository Layout

```
irisflow/
├── bootstrap.sh                      # One-command setup for all 4 options
├── CLAUDE.md                         # Rules for Iris when editing this repo
├── CONSTITUTION.md                   # Read-only operator rules injected into every prompt
├── MEMORY.md                         # Iris's mutable global memory (she writes here)
├── README.md                         # This file
│
├── data/
│   └── models.json                   # LLM provider and model configurations
│
├── iris-runtime/                     # The core runtime package
│   └── src/
│       ├── main.ts                   # Entry point — CLI flags, startup wiring
│       ├── agent.ts                  # LLM agent — runs prompts, handles tools
│       ├── slack.ts                  # Slack bot — event handling, message routing
│       ├── sessions.ts               # Session management (one per thread)
│       ├── sandbox.ts                # Execution backends: host, Docker, Firecracker
│       ├── vm-manager.ts             # Dynamic Firecracker VM pool
│       ├── config.ts                 # Centralised environment configuration
│       ├── api.ts                    # Internal HTTP API for sub-agent communication
│       ├── bridge.ts                 # Sub-agent bridge server
│       ├── store.ts                  # File/attachment storage
│       ├── events.ts                 # Scheduled event watcher
│       └── tools/                    # bash, read, write, edit, attach tools
│
├── scripts/
│   ├── fc-up.sh                      # Boot a Firecracker microVM
│   ├── fc-down.sh                    # Stop and clean up a microVM
│   ├── build-firecracker-rootfs.sh   # Build the VM disk image from Docker
│   └── iris-exec-server.py           # HTTP server that runs inside each microVM
│
├── skills/                           # Iris's built-in capabilities (hot-reloaded)
│   ├── azure/                        # Azure CLI operations
│   ├── firecracker-agent/            # MicroVM lifecycle management
│   ├── get-secret/                   # Read secrets from Key Vault or env
│   ├── github/                       # GitHub operations
│   ├── promote-skill/                # Promote a channel skill to global
│   ├── search-web/                   # Web search
│   ├── self-extend/                  # Iris writes new skills
│   ├── self-heal/                    # Iris diagnoses and fixes its own errors
│   ├── send-email/                   # Email via Resend.com
│   ├── serve-public/                 # Expose a local port publicly via ngrok/cloudflare
│   ├── spawn-agent/                  # Create and start a new sub-agent VM
│   ├── store-file/                   # Azure Blob Storage operations
│   ├── terraform/                    # Terraform wrapper
│   ├── transcribe-audio/             # Audio-to-text
│   └── watchdog/                     # Monitor a service and alert on failure
│
├── agents/
│   ├── newsletter/                   # Newsletter sub-agent scaffold
│   └── public-sandbox/               # Firecracker-isolated public sub-agent
│
└── terraform/
    ├── main.tf                       # Core infrastructure definitions
    ├── variables.tf                  # Input variables
    ├── outputs.tf                    # Output values
    ├── backend.tf                    # Terraform state backend (Azure Storage)
    ├── providers.tf                  # Azure provider configuration
    └── modules/
        ├── agent/                    # Docker-based sub-agent module
        └── firecracker-agent/        # Firecracker microVM module
```

---

## Operational Notes

**Skills hot-reload** — Any change to a `SKILL.md` file in `skills/` takes effect immediately without restarting Iris.

**Iris writes to memory** — When Iris learns something important, she updates `/iris/data/MEMORY.md`. This file is her persistent memory across conversations. You can read and edit it freely.

**The VM is disposable** — All important state is stored in the Git repository (`CONSTITUTION.md`, `MEMORY.md`, skills) and in `/iris/data`. If your server is destroyed, you can rebuild Iris from scratch by running `bootstrap.sh` on a new VM. The result will be identical.

**Never commit secrets** — `/iris/.env` is in `.gitignore`. Do not add it. Do not add any file containing API keys to the repository.

**GitHub is the source of truth** — Iris commits memory and skill changes to GitHub. This means even if the VM is lost, nothing is permanently lost.

**Channel data location** — Each Slack channel Iris has talked in has a directory at `/iris/data/<channel-id>/` containing:
- `log.jsonl` — plain text history of every message
- `context.jsonl` — structured LLM context for resuming conversations
- `MEMORY.md` — channel-specific memory
- `attachments/` — files shared in that channel
- `skills/` — channel-specific tools Iris has created

---

*If you encounter anything confusing in this guide, open an issue at https://github.com/irisworks/irisflow/issues.*
