---
title: Setup
description: All four install paths — from zero-cloud quickstart to Key Vault + Firecracker production.
---

# Setup Guide

Detailed walkthroughs for all four install paths. For the short version, see the
[README Quickstart](../README.md#quickstart).

All paths start the same way:

```bash
sudo mkdir -p /iris && sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/iris-core.git /iris/repo
cd /iris/repo
```

| | No Firecracker | With Firecracker (isolated microVMs) |
|---|---|---|
| **No Azure** | [Option 1](#option-1--no-azure-no-firecracker) — quickstart, zero cloud deps | [Option 3](#option-3--no-azure-with-firecracker) |
| **Azure Key Vault** | [Option 2](#option-2--azure-key-vault-no-firecracker) | [Option 4](#option-4--azure-key-vault--firecracker-full-production) — full production |

Every option prompts for Slack and/or Telegram tokens during setup — answer `Y` to
whichever you want (or both; they run in the same process). See
[Telegram Setup](#telegram-setup).

---

## Option 1 — No Azure, No Firecracker

Iris runs on your machine and executes commands directly on the host. No Azure
account, no KVM needed.

**Requirements:** Ubuntu 22.04 (laptop, VPS, or any VM) · LLM provider API key ·
Slack workspace (admin) or Telegram account · GitHub account (optional)

```bash
bash bootstrap.sh --setup --no-keyvault
```

The script will:

1. Install system dependencies (Docker, Node 22, jq, GitHub CLI). nginx and
   certbot are installed only if you configure a public domain; the Azure CLI
   and Terraform are installed only on the Key Vault paths (Options 2 and 4).
2. Log into GitHub (`gh auth login` — browser or device code).
3. Ask for your LLM provider (anthropic / openai / foundry-e2 / amazon-bedrock) and API key.
4. Walk you through creating a Slack app (exact token scopes shown in-terminal) and/or a Telegram bot.
5. Optionally set up email sending (Resend) and a public domain.
6. Write `/iris/.env` (chmod 600), build the runtime, install and start the `iris` systemd service.

**Verify:**

```bash
sudo systemctl status iris
```

Then in Slack: `@iris what model are you?` — or message your Telegram bot after
[claiming it](#telegram-setup).

### Slack app creation (reference)

When the bootstrap pauses for Slack tokens:

1. <https://api.slack.com/apps> → Create New App → From scratch → name it `Iris` → pick your workspace.
2. **Socket Mode** → Enable → generate an App-Level Token with scope `connections:write` → copy the `xapp-...` token.
3. **OAuth & Permissions** → Bot Token Scopes → add:
   `app_mentions:read` `channels:history` `channels:read` `chat:write` `groups:history`
   `groups:read` `im:history` `im:read` `im:write` `mpim:history` `reactions:write` `users:read`
   → Install to Workspace → copy the `xoxb-...` token.
4. **Event Subscriptions** → Enable → subscribe to bot events:
   `app_mention` `message.channels` `message.groups` `message.im` `message.mpim`.
5. **App Home** → enable the Messages Tab.

---

## Option 2 — Azure Key Vault, No Firecracker

Same as Option 1, but secrets live in Azure Key Vault instead of `/iris/.env`.

**Requirements:** all of Option 1 + an Azure account

```bash
bash bootstrap.sh --setup --keyvault
```

Additional steps over Option 1: the Azure CLI and Terraform are installed,
followed by Azure login (`az login`, skipped if the VM has a managed identity),
then prompts for a Key Vault name (default `iris-kv-<hostname>`)
and resource group. The script creates the vault and seeds all secrets into it.

---

## Option 3 — No Azure, With Firecracker

Every bash command Iris runs executes inside an isolated Firecracker microVM.
No Azure account needed.

**Requirements:** all of Option 1, plus a machine with `/dev/kvm`. On Azure use the
**Ddsv5 series** (e.g. `Standard_D4ds_v5`) — B-series and D-series have no KVM.

```bash
bash bootstrap.sh --setup --no-keyvault --firecracker
```

Additional steps over Option 1:

1. KVM check (re-execs via `sg kvm` if group membership isn't active yet — no logout needed).
2. Downloads Firecracker + jailer v1.7.0 and a Linux kernel; creates the `irisjailer` system user (uid/gid 10000).
3. Builds `rootfs.ext4` from the iris-runtime Docker image (~1 minute).
4. Provisions the `iris-fc-public-sandbox` systemd service, waits for the VM health
   check at `http://172.20.1.2:8080/health`, then switches Iris to
   `--sandbox=firecracker:172.20.1.2` via a systemd drop-in.

**Verify:** `@iris run: uname -a` — the kernel should differ from the host's.

---

## Option 4 — Azure Key Vault + Firecracker (full production)

Option 2 + Option 3 combined, with Terraform managing the sandbox VM lifecycle.

```bash
bash bootstrap.sh --setup --keyvault --firecracker
```

Additional prompt: a Terraform state storage account name (lowercase + numbers,
max 24 chars). The script creates the storage account, runs `terraform init` with
the Azure backend, and `terraform apply` provisions the sandbox VM service.

---

## Telegram Setup

Iris supports Telegram natively. The bot is private by design — it ignores all
messages until you claim it with a one-time token.

**1. Create a bot:** message `@BotFather`, send `/newbot`, pick a display name and a
username ending in `bot`, and copy the token (`7123456789:AAF...`).

**2. Add the token:** enter it when bootstrap asks (`Set up Telegram integration? [Y/n]`).
Bootstrap verifies it live against Telegram's `getMe` API before continuing —
useful if you're pasting from a phone, where a masked terminal prompt gives no
feedback on a mangled copy — and re-prompts if it's rejected. Once verified,
it's written to `/iris/.env` automatically.

**3. Claim the bot:** on first startup Iris prints a one-time claim token to the
terminal (`journalctl -u iris -f` if you missed it). Send that exact token to your
bot on Telegram; it replies `✅ Bot claimed`. Claim state persists across restarts.
Tokens expire after 10 minutes — restart Iris to generate a new one.

**Reclaiming** (transfer to a different Telegram account):

```bash
echo "IRIS_TELEGRAM_FORCE_RECLAIM=true" >> /iris/.env && sudo systemctl restart iris
```

Send the freshly printed token from the new account, then remove
`IRIS_TELEGRAM_FORCE_RECLAIM` from `/iris/.env`.

**Swapping bots:** the claim is scoped to the bot's identity. If you replace
`TELEGRAM_BOT_TOKEN` with a token for a *different* bot, the old claim is cleared
automatically on startup and a fresh claim token is printed — no
`IRIS_TELEGRAM_FORCE_RECLAIM` needed. (Force-reclaim is only for transferring the
*same* bot to a new owner.)

**Bot commands:** `/reset` (clear history) · `/compact` (summarise context) ·
`/stop` (abort a running response)

**Running Slack and Telegram simultaneously:** set all three tokens in `/iris/.env`
— both transports start in the same process:

```
IRIS_SLACK_APP_TOKEN=xapp-...
IRIS_SLACK_BOT_TOKEN=xoxb-...
TELEGRAM_BOT_TOKEN=...
```

---

## Secrets

Two backends, chosen at bootstrap:

**`/iris/.env`** (default, no cloud dependencies) — bootstrap prompts for all values
and writes the file with chmod 600. Never commit it.

**Azure Key Vault** (opt-in, recommended for Azure production):

```bash
KV=$(grep ^IRIS_KEY_VAULT /iris/.env | cut -d= -f2)
az keyvault secret set --vault-name "$KV" --name "SLACK-APP-TOKEN"  --value "xapp-..."
az keyvault secret set --vault-name "$KV" --name "SLACK-BOT-TOKEN"  --value "xoxb-..."
az keyvault secret set --vault-name "$KV" --name "GITHUB-TOKEN"     --value "ghp_..."
```

Iris itself always accesses secrets through the `get-secret` skill, which handles
both backends.

---

## Resetting a Firecracker VM Between Sessions

```bash
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

Dynamic-pool VMs are reset automatically by `VmManager` on session reset or idle
timeout.
