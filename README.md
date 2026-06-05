# Iris Core

Iris is an always-on AI orchestrator that runs on a cloud VM, listens on Slack or Telegram, and manages a fleet of specialized sub-agents. Each sub-agent runs as an isolated Docker container with its own bridge HTTP server, skills, and conversation memory.

This repository is the source of truth for Iris's constitution, runtime, infrastructure, skills, and sub-agent scaffolding.

## What This Repo Contains

- `CONSTITUTION.md` — operator rules injected read-only into every system prompt
- `MEMORY.md` — Iris's mutable global memory
- `CLAUDE.md` — repo-level writing rules for infrastructure and documentation
- `bootstrap.sh` — rebuild Iris from a fresh VM
- `iris-runtime/` — `@iris-core/runtime`, a provider-agnostic AI agent runtime
- `scripts/` — Firecracker VM lifecycle scripts (`fc-up.sh`, `fc-down.sh`, `build-firecracker-rootfs.sh`, `iris-exec-server.py`)
- `skills/` — Iris's top-level skills (hot-reloaded without restart)
- `agents/` — sub-agent scaffolds (newsletter, public-sandbox)
- `data/models.json` — LLM provider and model configuration
- `supabase/schema.sql` — Supabase table definitions
- `terraform/` — dynamic Azure resources Iris provisions on demand

---

## Architecture

```
You (Slack)                  You (Telegram)
    │                              │
    ▼                              ▼
Iris  (Azure VM, systemd: iris.service)
├── iris-runtime (Node, --sandbox=host)
├── Internal API  :3000           (sub-agent management, task queue, bridge routing)
├── Slack transport               (Socket Mode)
├── Telegram transport            (long polling, up to 5 bot tokens)
│
└── Sub-Agent Docker Containers   (one per sub-agent, slots 1–10)
    ├── iris-agent-{id}  slot 1 → bridge :4201
    ├── iris-agent-{id}  slot 2 → bridge :4202
    │   ...
    └── iris-agent-{id}  slot 10 → bridge :4210
        Skills: /iris/data/skills mounted read-only (hot-reload, no restart)
        Memory: /iris/data/agents/{id}/MEMORY.md (agent constitution + no-agent-creation restriction)
        Bridge: HTTP server on IRIS_BRIDGE_PORT — receives messages, runs LLM, returns response
```

### How Telegram works (new sub-agent-centric model)

```
User → Telegram Bot → TelegramLinkManager (lookup linked sub-agent)
                     → callAgentBridge(bridgeUrl, text, user)
                     → Sub-Agent Docker Container (bridge HTTP server)
                     → LLM response
                     ← Telegram message to user
```

- Telegram bots are **gateways**, not direct Iris interfaces
- Each bot is linked **one-to-one** to a specific sub-agent — one bot, one agent
- An unlinked bot only accepts claim tokens (64-char hex) — ignores all other messages
- Claim tokens are generated via the Iris API, not printed to logs

### Sandbox modes

Iris's bash tool can execute commands in four isolation levels, configured via `--sandbox`:

| Mode | Flag | Use case |
|---|---|---|
| Host | `--sandbox=host` | Iris herself — trusted ops, full access |
| Docker | `--sandbox=docker:<name>` | Legacy containers |
| Static Firecracker | `--sandbox=firecracker:<ip>` | Persistent sub-agent at a fixed IP |
| Dynamic pool | `--sandbox=firecracker-pool` | One fresh microVM per Slack channel; auto-destroyed after 30 min idle |

---

## Current State

Implemented and verified:

- `iris-runtime/` — provider-agnostic, configurable via `--provider`/`--model` CLI flags or env vars
- `CONSTITUTION.md` — operator rules injected before all agent memory
- Firecracker microVM layer — `VmManager`, `fc-up.sh`/`fc-down.sh`, `iris-exec-server.py`
- Internal HTTP API on `:3000` — sub-agent CRUD, task queue, bridge routing, scheduled events
- **Sub-agent-centric Telegram architecture** — bots are gateways linked to Docker-based sub-agents
- Claim token workflow — cryptographically secure, single-use, 10-minute TTL
- Sub-agent Docker containers — `iris-agent-{id}`, slots 1–10, bridge ports 4201–4210
- Dynamic skill acquisition — skills added to host are immediately available to all sub-agents (volume-mounted)
- Agent creation hard-restricted in sub-agents at constitution and capability level
- Supabase persistence — sub-agent registry, Telegram links, task queue
- Skills: secrets, storage, Terraform, GitHub, Azure, spawn-agent, promote-skill, self-extend, self-heal, send-email, watchdog, serve-public
- Top-level skills hot-reload from `/iris/data/skills` without service restart

Still pending:

- Phase 5 hardening and full resurrection test
- Web UI for sub-agent management (currently API-only)

---

## Setup

Pick the path that matches your environment:

| | No Firecracker | With Firecracker (isolated microVMs) |
|---|---|---|
| **No Azure** | [Option 1](#option-1--no-azure-no-firecracker) — simplest | [Option 3](#option-3--no-azure-with-firecracker) |
| **Azure Key Vault** | [Option 2](#option-2--azure-key-vault-no-firecracker) | [Option 4](#option-4--azure-key-vault--firecracker-full-production) — full production |

All paths start the same way:

```bash
sudo mkdir -p /iris && sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/iris-core.git /iris/repo
cd /iris/repo
```

---

## Managing the Iris Service

```bash
# Stop iris
sudo systemctl stop iris

# Start iris
sudo systemctl start iris

# Restart iris
sudo systemctl restart iris

# Live logs
sudo journalctl -u iris -f
```

> **Note:** If `start` silently does nothing, rebuild the JS first:
> ```bash
> cd /iris/repo/iris-runtime && npm install && npm run build
> sudo systemctl start iris
> ```

---

## Option 1 — No Azure, No Firecracker

Iris runs on your VM and executes commands directly on the host.

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

[iris-bootstrap] Slack App token (xapp-...):
[iris-bootstrap] Slack Bot token (xoxb-...):

[iris-bootstrap] Set up Telegram integration? [Y/n]
[iris-bootstrap] Telegram Bot Token:

[iris-bootstrap] Add GitHub token for repo access? [Y/n]
[iris-bootstrap] Set up email sending (Resend.com)? [y/N]
[iris-bootstrap] Set up public domain (e.g. iris.example.com)? [y/N]
[iris-bootstrap] Git author email for Iris commits [iris@example.com]:

[iris-bootstrap] ── Building iris-runtime ──
(automated: npm install + npm run build + docker build iris-runtime:local)

[iris-bootstrap] ── Installing systemd service ──
(automated: installs iris.service, starts Iris)

[iris-bootstrap] ── Done ──
  ✓ Iris is running!
  Status:    sudo systemctl status iris
  Logs:      sudo journalctl -u iris -f
  Secrets:   /iris/.env
```

---

## Option 2 — Azure Key Vault, No Firecracker

Same as Option 1 but secrets live in Azure Key Vault.

**Requirements:** All of Option 1 + Azure account

```bash
bash bootstrap.sh --setup --keyvault
```

---

## Option 3 — No Azure, With Firecracker

Every bash command Iris runs executes inside an isolated Firecracker microVM. Requires a VM with KVM — on Azure use **Ddsv5 series** (e.g. `Standard_D4ds_v5`).

```bash
bash bootstrap.sh --setup --no-keyvault --firecracker
```

---

## Option 4 — Azure Key Vault + Firecracker (full production)

Azure Key Vault for secrets + Terraform to manage the sandbox VM lifecycle.

```bash
bash bootstrap.sh --setup --keyvault --firecracker
```

---

## Telegram Setup

Iris supports up to **5 Telegram bots simultaneously**. Each bot must be linked to a specific sub-agent before it will respond to messages. An unlinked bot accepts only claim tokens.

> **Important:** Supabase must be configured before Telegram linking works. See [Supabase Setup](#supabase-setup) first.

---

### Step 1 — Create a bot via @BotFather

1. Open Telegram and message `@BotFather`
2. Send `/newbot`
3. Choose a display name (e.g. `Iris Agent`)
4. Choose a username ending in `bot` (e.g. `iris_myagent_bot`)
5. Copy the token BotFather gives you — it looks like `7123456789:AAFxyz...`

Repeat for each bot you want (up to 5).

---

### Step 2 — Add bot tokens to `/iris/.env`

```bash
# First bot (required)
echo "TELEGRAM_BOT_TOKEN=7123456789:AAFxyz..."  >> /iris/.env

# Additional bots (optional, up to 5 total)
echo "TELEGRAM_BOT_TOKEN_2=7987654321:BBGabc..." >> /iris/.env
echo "TELEGRAM_BOT_TOKEN_3=7111222333:CCHdef..." >> /iris/.env
# TELEGRAM_BOT_TOKEN_4 and _5 also supported

sudo systemctl restart iris
```

Verify the bots started:
```bash
sudo journalctl -u iris -f | grep telegram
# Expected: [telegram:123456789] Started. Send a sub-agent claim token to this bot to link it.
```

At this point the bots are **running but unlinked** — they will reject all messages except claim tokens.

---

### Step 3 — Create a sub-agent

Sub-agents are created via the Iris internal API. Each sub-agent gets a runtime (Docker container or Firecracker microVM), a slot (1–10), and a bridge port.

**Docker** (default — recommended unless you need full VM isolation):
```bash
curl -s -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyAgent",
    "skills": ["search-web", "send-email"],
    "runtime": "docker"
  }' | jq .
```

**Firecracker microVM** (stronger isolation — requires KVM on the host):
```bash
curl -s -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "MyAgent",
    "skills": ["search-web", "send-email"],
    "runtime": "firecracker"
  }' | jq .
```

Response:
```json
{
  "agentId": "a1b2c3d4-...",
  "name": "MyAgent",
  "runtime": "docker",
  "slotIndex": 1,
  "status": "running",
  "skills": ["search-web", "send-email"]
}
```

| Runtime | Isolation | Bridge URL | Requires |
|---|---|---|---|
| `docker` | Docker namespace + seccomp | `http://127.0.0.1:4201` (slot 1) | Docker installed |
| `firecracker` | Hardware VM boundary (KVM) | `http://172.20.1.2:4200` (slot 1) | KVM + Firecracker rootfs |

> **Skills** are optional. Leave `skills` as `[]` for a general-purpose agent. Available skill names match subdirectory names under `/iris/data/skills`.
>
> **Firecracker prerequisite**: the base rootfs must exist at `/var/lib/iris/firecracker/rootfs.ext4`. Build it with `sudo bash scripts/build-firecracker-rootfs.sh` if it is missing.

---

### Step 4 — Generate a claim token

Generate a one-time claim token for the sub-agent you just created. The token is valid for **10 minutes** and can only be used **once**.

```bash
curl -s -X POST http://localhost:3000/agents/a1b2c3d4-.../telegram/token | jq .
```

Response:
```json
{
  "token": "a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1",
  "expiresIn": "10 minutes",
  "instructions": "Send this token to your Telegram bot to link it."
}
```

The token is also written to `/iris/data/telegram-link-token.txt` for convenience:
```bash
cat /iris/data/telegram-link-token.txt
```

> If the token expires before you use it, run the `POST` command again — a new token is generated and the old one is invalidated immediately.

---

### Step 5 — Link the bot by sending the token

Open Telegram and send the **exact token string** to your bot:

```
a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1
```

The bot responds:

```
✅ Linked to sub-agent "MyAgent". You can start chatting now!
```

From this point, every message you send to the bot is forwarded to `MyAgent`'s Docker container via the bridge HTTP server and answered by the LLM.

---

### Step 6 — Verify the link

```bash
curl -s http://localhost:3000/agents/a1b2c3d4-... | jq '{name, status, slotIndex}'
```

In Telegram, send `/status` to the bot:

```
🤖 MyAgent
Bridge: http://127.0.0.1:4201
Skills: search-web, send-email
Status: running
```

---

### Linking rules

| Rule | Details |
|---|---|
| One-to-one | One bot ↔ one sub-agent — a bot cannot be linked to multiple agents and vice versa |
| Unlinked state | An unlinked bot ignores all messages except 64-char hex claim tokens |
| Token expiry | Claim tokens expire after 10 minutes; generating a new one invalidates the previous |
| Already linked | Sending a token to an already-linked bot returns an error |
| Re-linking | Unlink first (`/unlink` in Telegram or `DELETE /agents/:id/telegram` via API), then generate a new token |

---

### Unlinking a bot

**From Telegram** — send `/unlink` to the bot:
```
⚠️ Are you sure you want to unlink this bot from MyAgent?
Reply /unlink confirm to proceed.
```

Then:
```
/unlink confirm
```

**Via API:**
```bash
curl -s -X DELETE http://localhost:3000/agents/a1b2c3d4-.../telegram
```

After unlinking, the bot returns to unlinked state and accepts a new claim token.

---

### Adding skills to an existing sub-agent

Skills are volume-mounted from the host — adding a skill to `/iris/data/skills` makes it available to all sub-agent containers immediately, without restart.

To update which skills a sub-agent is declared to have (updates Supabase + the sub-agent's MEMORY.md context):

```bash
curl -s -X PATCH http://localhost:3000/agents/a1b2c3d4-.../skills \
  -H "Content-Type: application/json" \
  -d '{"skills": ["search-web", "send-email", "github"]}'
```

Or from inside Telegram, send `/install github` — the bot will confirm before installing.

---

### Telegram bot commands

| Command | What it does |
|---|---|
| `/status` | Show linked sub-agent name, bridge URL, skills, and container status |
| `/skills` | List all skills currently declared for this sub-agent |
| `/install <skill>` | Add a skill to the sub-agent (shows confirmation dialog first) |
| `/reset` | Clear conversation history and start fresh |
| `/compact` | Summarise conversation context to save tokens |
| `/stop` | Abort a currently running response |
| `/unlink` | Disconnect this bot from its sub-agent (requires `/unlink confirm`) |

---

### Running multiple bots

Each `TELEGRAM_BOT_TOKEN_N` starts one bot. Each bot must be linked to a **different** sub-agent.

```
TELEGRAM_BOT_TOKEN=...    → links to sub-agent "ResearchAgent" (slot 1)
TELEGRAM_BOT_TOKEN_2=...  → links to sub-agent "EmailAgent"    (slot 2)
TELEGRAM_BOT_TOKEN_3=...  → links to sub-agent "DataAgent"     (slot 3)
```

---

## Supabase Setup

Iris uses Supabase to store the sub-agent registry, Telegram bot links, and task queue. **Sub-agents and Telegram linking will not work without it.**

### Step 1 — Create a project

1. Go to [supabase.com](https://supabase.com) and create a free project
2. Choose a region close to your VM
3. From **Project Settings → API**, copy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **`service_role`** secret key (under "Project API keys" — use the `service_role` key, not `anon`)

### Step 2 — Add credentials to `/iris/.env`

```bash
echo "SUPABASE_URL=https://<your-project-ref>.supabase.co" >> /iris/.env
echo "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." >> /iris/.env
sudo systemctl restart iris
```

### Step 3 — Run the schema in the SQL Editor

In your Supabase dashboard go to **SQL Editor** (`/project/<ref>/sql/new`) and paste and run the following SQL in full:

```sql
-- ============================================================================
-- Iris Supabase Schema
-- Run this entire block in the Supabase SQL Editor.
-- Safe to re-run: all statements use IF NOT EXISTS / DO NOTHING guards.
-- ============================================================================

-- ── Sub-agent registry (platform-agnostic) ───────────────────────────────────
-- Sub-agents are independent of any messaging platform.
-- Telegram, Slack, or any other interface can be linked separately.

DO $$ BEGIN
    CREATE TYPE agent_status AS ENUM ('running', 'stopped', 'crashed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS sub_agents (
    agent_id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT         NOT NULL,
    runtime             TEXT         NOT NULL DEFAULT 'docker'
                                     CHECK (runtime IN ('docker', 'firecracker')),
    docker_container_id TEXT,
    status              agent_status NOT NULL DEFAULT 'stopped',
    skills              JSONB        NOT NULL DEFAULT '[]',
    slot_index          SMALLINT     NOT NULL CHECK (slot_index BETWEEN 1 AND 10),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (name),
    UNIQUE (slot_index)
);

ALTER TABLE sub_agents DISABLE ROW LEVEL SECURITY;

-- ── Telegram bot ↔ Sub-agent links ───────────────────────────────────────────
-- One-to-one: one Telegram bot ↔ one sub-agent (enforced by UNIQUE on both sides).
-- linked_at = NULL means the bot is registered but not yet linked to an agent.
-- Claim tokens (pending links) are stored locally in iris-runtime, not in Supabase.

CREATE TABLE IF NOT EXISTS sub_agent_telegram_links (
    bot_id      TEXT        PRIMARY KEY,          -- Telegram bot numeric ID as text
    agent_id    UUID        UNIQUE                -- NULL = unlinked; UNIQUE = one-to-one
                            REFERENCES sub_agents(agent_id) ON DELETE SET NULL,
    linked_at   TIMESTAMPTZ,                      -- when the link was established
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sub_agent_telegram_links DISABLE ROW LEVEL SECURITY;

-- ── Per-agent task queue ──────────────────────────────────────────────────────

DO $$ BEGIN
    CREATE TYPE task_type AS ENUM ('immediate', 'scheduled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE task_status AS ENUM ('pending', 'running', 'done', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id       UUID        NOT NULL REFERENCES sub_agents(agent_id) ON DELETE CASCADE,
    bot_id         TEXT        NOT NULL,         -- Telegram bot that owns the delivery channel
    channel_id     TEXT        NOT NULL,         -- tg-{chatId} response delivery channel
    type           task_type   NOT NULL DEFAULT 'immediate',
    payload        TEXT        NOT NULL,
    scheduled_for  TIMESTAMPTZ,
    timezone       TEXT,
    local_time_str TEXT,
    status         task_status NOT NULL DEFAULT 'pending',
    assigned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at     TIMESTAMPTZ,
    completed_at   TIMESTAMPTZ,
    output         TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_tasks_agent_idx
    ON agent_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS agent_tasks_schedule_idx
    ON agent_tasks(scheduled_for) WHERE status = 'pending';

ALTER TABLE agent_tasks DISABLE ROW LEVEL SECURITY;
```

### Step 4 — Verify

In the Supabase **Table Editor**, you should now see:

| Table | Purpose |
|---|---|
| `sub_agents` | Registry of all sub-agents (name, slot, skills, container status) |
| `sub_agent_telegram_links` | Maps Telegram bot IDs to sub-agents (one-to-one) |
| `agent_tasks` | Scheduled and immediate task queue |

### Migrating from an older schema

If you previously ran the old schema (with `telegram_claim` and `telegram_agents` tables), run this **after** applying the new schema above:

```sql
-- Drop legacy tables (only after all running instances are updated)
DROP TABLE IF EXISTS agent_tasks CASCADE;   -- will be recreated by new schema above
DROP TABLE IF EXISTS telegram_agents CASCADE;
DROP TABLE IF EXISTS telegram_claim CASCADE;
DROP TYPE  IF EXISTS agent_status CASCADE;  -- will be recreated
DROP TYPE  IF EXISTS task_type CASCADE;     -- will be recreated
DROP TYPE  IF EXISTS task_status CASCADE;   -- will be recreated
```

Then re-run the full schema block above.

---

## Sub-Agent API Reference

The Iris internal API runs on `:3000` (or `IRIS_API_PORT`).

### Sub-agents

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/agents` | List all sub-agents |
| `POST` | `/agents` | Create and provision a new sub-agent |
| `GET` | `/agents/:id` | Get a single sub-agent |
| `DELETE` | `/agents/:id` | Delete sub-agent and stop its container |
| `PATCH` | `/agents/:id/skills` | Update sub-agent's skill list |

### Telegram linking

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/agents/:id/telegram/token` | Generate a claim token (10 min TTL, single-use) |
| `DELETE` | `/agents/:id/telegram` | Unlink the sub-agent from its Telegram bot |

### Example: full lifecycle

```bash
# 1. Create sub-agent
AGENT=$(curl -s -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"ResearchAgent","skills":["search-web","github"]}')
ID=$(echo $AGENT | jq -r .agentId)

# 2. Generate claim token
curl -s -X POST http://localhost:3000/agents/$ID/telegram/token | jq .

# 3. Send the token printed above to your Telegram bot

# 4. Verify link
curl -s http://localhost:3000/agents/$ID | jq '{name,status,slotIndex}'

# 5. Update skills later
curl -s -X PATCH http://localhost:3000/agents/$ID/skills \
  -H "Content-Type: application/json" \
  -d '{"skills":["search-web","github","send-email"]}'

# 6. Unlink Telegram
curl -s -X DELETE http://localhost:3000/agents/$ID/telegram

# 7. Delete agent entirely
curl -s -X DELETE http://localhost:3000/agents/$ID
```

---

## Runtime and Models

The runtime reads `IRIS_PROVIDER` and `IRIS_MODEL` env vars and loads provider config from `data/models.json`.

```bash
# CLI flags
iris-runtime --provider anthropic --model claude-sonnet-4-5 /iris/data

# Env vars (preferred in production, set in /iris/.env)
IRIS_PROVIDER=anthropic
IRIS_MODEL=claude-sonnet-4-5
IRIS_ENV=prod              # preview | prod
IRIS_API_PORT=3000         # internal API port
IRIS_API_URL=http://127.0.0.1:3000
```

Supported providers out of the box:

| Provider key | Backend |
|---|---|
| `anthropic` | Claude Sonnet / Opus |
| `openai` | GPT-4o / GPT-4o-mini |
| `foundry-e2` | Azure AI Foundry (chat/completions) |
| `foundry-e2-responses` | Azure AI Foundry (Responses API) |
| `amazon-bedrock` | AWS Bedrock (Claude, Nova, Llama) |

---

## Secrets

**Azure Key Vault** (recommended for production):

```bash
KV=$(grep ^IRIS_KEY_VAULT /iris/.env | cut -d= -f2)
az keyvault secret set --vault-name "$KV" --name "ANTHROPIC-API-KEY"        --value "sk-ant-..."
az keyvault secret set --vault-name "$KV" --name "SLACK-APP-TOKEN"          --value "xapp-..."
az keyvault secret set --vault-name "$KV" --name "SLACK-BOT-TOKEN"          --value "xoxb-..."
az keyvault secret set --vault-name "$KV" --name "TELEGRAM-BOT-TOKEN"       --value "7123456789:..."
az keyvault secret set --vault-name "$KV" --name "SUPABASE-URL"             --value "https://..."
az keyvault secret set --vault-name "$KV" --name "SUPABASE-SERVICE-ROLE-KEY" --value "eyJ..."
az keyvault secret set --vault-name "$KV" --name "GITHUB-TOKEN"             --value "ghp_..."
```

**`/iris/.env`** (simpler, no Azure required):

```bash
# LLM provider
IRIS_PROVIDER=anthropic
IRIS_MODEL=claude-sonnet-4-5
ANTHROPIC_API_KEY=sk-ant-...

# Slack (optional)
IRIS_SLACK_APP_TOKEN=xapp-...
IRIS_SLACK_BOT_TOKEN=xoxb-...

# Telegram (optional, up to 5 bots)
TELEGRAM_BOT_TOKEN=7123456789:AAFxyz...
TELEGRAM_BOT_TOKEN_2=7987654321:BBGabc...

# Supabase (required for sub-agents and Telegram linking)
SUPABASE_URL=https://abcdefgh.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# Optional
GITHUB_TOKEN=ghp_...
RESEND_API_KEY=re_...
IRIS_API_PORT=3000
```

Never commit `/iris/.env` to git.

---

## Repository Layout

```
iris-core/
├── bootstrap.sh                    # rebuild Iris on a fresh VM
├── CLAUDE.md                       # repo-level writing rules
├── CONSTITUTION.md                 # operator rules — injected into every prompt
├── MEMORY.md                       # Iris's mutable global memory
├── README.md
├── supabase/
│   └── schema.sql                  # Supabase table definitions (canonical source)
├── data/
│   └── models.json.template        # template — bootstrap generates models.json
├── iris-runtime/                   # @iris-core/runtime — Node.js AI agent runtime
│   └── src/
│       ├── main.ts                 # entry point — provider, model, sandbox, API flags
│       ├── agent.ts                # AgentRunner — LLM invocation, tool dispatch
│       ├── slack.ts                # Slack Socket Mode transport
│       ├── telegram.ts             # Telegram transport — gateway to linked sub-agent bridge
│       ├── telegram-link.ts        # TelegramLinkManager — claim tokens, bot↔agent linking
│       ├── sub-agent-registry.ts   # platform-agnostic sub-agent CRUD (Supabase)
│       ├── agent-provision.ts      # Docker container lifecycle for sub-agents
│       ├── agent-watchdog.ts       # polls Docker every 30s, detects crashes/recoveries
│       ├── scheduler.ts            # croner-based task scheduler
│       ├── task-queue.ts           # agent task CRUD (Supabase agent_tasks table)
│       ├── api.ts                  # internal HTTP API (:3000)
│       ├── bridge.ts               # sub-agent bridge HTTP server + callAgentBridge()
│       ├── sandbox.ts              # HostExecutor, DockerExecutor, FirecrackerExecutor, pool
│       ├── vm-manager.ts           # VmManager — on-demand Firecracker pool
│       ├── store.ts                # ChannelStore — per-channel conversation history
│       └── events.ts               # EventsWatcher — file-based scheduled event dispatch
├── scripts/
│   ├── fc-up.sh                    # boot a Firecracker microVM for a given slot
│   ├── fc-down.sh                  # kill VM, remove tap, clean state
│   ├── build-firecracker-rootfs.sh # build base rootfs from Docker image
│   └── iris-exec-server.py         # HTTP exec server baked into the rootfs
├── skills/
│   ├── azure/
│   ├── firecracker-agent/
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
    ├── agents.tf
    ├── backend.tf
    ├── main.tf
    ├── providers.tf
    ├── variables.tf
    ├── outputs.tf
    └── modules/
        ├── agent/                  # Docker sub-agent module
        └── firecracker-agent/      # Firecracker microVM module
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `iris.service` fails to start | Missing env vars | Check `/iris/.env` and `journalctl -u iris` |
| Telegram bot ignores all messages | Bot is unlinked | Generate a claim token and send it to the bot (see [Step 4](#step-4--generate-a-claim-token)) |
| Claim token rejected | Token expired or already used | Run `POST /agents/:id/telegram/token` again for a fresh token |
| `already_linked` error | Bot is already linked | Unlink first with `/unlink confirm` in Telegram or `DELETE /agents/:id/telegram` |
| Sub-agent container not starting | `iris-runtime:local` image missing | Rebuild the image (see below) |
| `/dev/kvm` not found | Wrong Azure VM series | Resize to Ddsv5 series (e.g. `Standard_D4ds_v5`) |
| `firecracker: permission denied` | Not in kvm group | `sudo usermod -aG kvm $USER` then log out and back in |
| Supabase errors on startup | Missing credentials | Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to `/iris/.env` |
| Schema errors from Supabase | Old schema still in place | Run the migration block then re-run the full schema |
| `fatal: repository not found` during bootstrap | Wrong remote URL | `git remote set-url origin https://github.com/irisworks/iris-core.git` |

### Emergency: rebuild the `iris-runtime:local` Docker image

If sub-agents fail to spawn because the `iris-runtime:local` image is missing or outdated:

```bash
cd /iris/repo/iris-runtime
npm install       # restore node_modules if needed
npm run build     # compile TypeScript → dist/
docker build -t iris-runtime:local .
```

Expected: `Successfully tagged iris-runtime:local` (~2–3 minutes first build, faster on rebuild).

```bash
# Verify
docker images iris-runtime:local

# Restart any crashed sub-agent containers
docker ps -a --filter name=iris-agent --format '{{.Names}}'
docker restart <container-name>
```

If you also use Firecracker sub-agents, rebuild the rootfs after the image is ready:

```bash
sudo bash /iris/repo/scripts/build-firecracker-rootfs.sh
```

---

## Resetting a VM Between Sessions

```bash
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

For dynamic pool VMs, `VmManager` calls `fc-down.sh` automatically on session reset or idle timeout.

---

## Operational Notes

- Skills hot-reload from `/iris/data/skills` — adding a skill directory on the host makes it available to all sub-agent containers immediately (volume-mounted read-only), no restart needed
- Sub-agent containers are named `iris-agent-{agentId}` and use bridge ports `4201`–`4210` (slot × + 4200)
- The watchdog polls Docker every 30 seconds and detects crashes; missed scheduled tasks are marked skipped on recovery
- Telegram link state is stored in Supabase (`sub_agent_telegram_links`) — persists across VM restarts
- Pending claim tokens are stored locally in `/iris/data/telegram-link-tokens.json` — they expire in 10 minutes regardless
- GitHub is the durable source of truth. The VM is disposable — a full rebuild from this README should produce an identical running system
- Do not store secrets in the repo, `.env` committed to git, or Terraform state

## Source Documents

If resuming work, read these first:

- [CLAUDE.md](CLAUDE.md)
- [CONSTITUTION.md](CONSTITUTION.md)
- [MEMORY.md](MEMORY.md)
- [supabase/schema.sql](supabase/schema.sql)
