# Iris Core

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Azure VM  (Ubuntu 22.04)                           │
│                                                                             │
│  You ── Slack ─────────────────────────────────────────────────────────►   │
│  You ── Telegram Bot 1..5 (long-poll) ─────────────────────────────────►   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │  iris.service  (systemd)                                             │  │
│  │  Node.js · iris-runtime · --sandbox=host · working dir: /iris/data  │  │
│  │                                                                      │  │
│  │  Transports                                                          │  │
│  │  ├── Slack      Socket Mode (optional)                               │  │
│  │  │   Iris handles the message herself — full LLM + tools            │  │
│  │  │                                                                   │  │
│  │  └── Telegram   Long-poll, up to 5 bots (TELEGRAM_BOT_TOKEN_1..5)  │  │
│  │      Each bot is a GATEWAY — it does NOT run the LLM itself.        │  │
│  │      Unlinked bot → accepts only 64-char hex claim tokens           │  │
│  │      Linked bot   → every message forwarded to sub-agent bridge     │  │
│  │                                                                      │  │
│  │  Internal API  :3000  (0.0.0.0 — reachable from Docker network)    │  │
│  │  ├── GET/POST/DELETE  /agents                 sub-agent CRUD        │  │
│  │  ├── POST             /agents/:id/telegram/token  claim token       │  │
│  │  ├── DELETE           /agents/:id/telegram        unlink bot        │  │
│  │  ├── PATCH            /agents/:id/skills           update skills    │  │
│  │  ├── POST             /internal/write-event        schedule event   │  │
│  │  ├── POST             /event                       inject event     │  │
│  │  ├── POST             /escalate                    sub-agent SOS    │  │
│  │  └── CRUD             /sessions                    session API      │  │
│  │                                                                      │  │
│  │  EventsWatcher  →  slack/events/  telegram/events/  events/         │  │
│  │  Scheduler      →  croner jobs, Supabase agent_tasks                │  │
│  │  Watchdog       →  polls every 30s, detects crash / recovery        │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  Sub-Agent Layer  (slots 1–10, one runtime per slot)                       │
│                                                                             │
│  ┌─── Docker runtime (default) ────────────────────────────────────────┐  │
│  │  Container:  iris-agent-{agentId}                                   │  │
│  │  Bridge URL: http://127.0.0.1:{4200+slot}  (e.g. :4201 for slot 1) │  │
│  │  • iris-runtime in bridge mode  (IRIS_BRIDGE_PORT set)              │  │
│  │  • /iris/data/skills mounted read-only  →  hot-reload, no restart   │  │
│  │  • spawn-agent skill excluded  →  agent creation blocked at OS level│  │
│  │  • MEMORY.md injected with identity + hard no-agent-creation rule   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌─── Firecracker runtime (KVM required) ──────────────────────────────┐  │
│  │  VM name:    iris-fc-{agentId}   (slot N → 172.20.N.2)              │  │
│  │  Bridge URL: http://172.20.{slot}.2:4200                            │  │
│  │  • Booted via fc-up.sh, iris-runtime started via exec-server :8080  │  │
│  │  • Hardware VM boundary  (KVM + jailer + seccomp)                   │  │
│  │  • Same skill and MEMORY.md setup as Docker                         │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  Telegram message flow                                                      │
│  User → Bot → TelegramLinkManager.getLinkedAgent(botId)  [cached]          │
│             → callAgentBridge(bridgeUrl, text, user)                        │
│             → Sub-agent bridge HTTP server                                  │
│             → AgentRunner.run()  (LLM + tools)                              │
│             → response text → Bot sends to user                             │
│                                                                             │
│  Iris's own bash sandbox  (separate from sub-agent runtime)                 │
│  ├── --sandbox=host              full host access  (Iris herself)           │
│  ├── --sandbox=firecracker:<ip>  static VM at fixed IP                      │
│  └── --sandbox=firecracker-pool  fresh VM per Slack channel, 30 min TTL    │
│                                                                             │
│  Supabase  (external persistence)                                           │
│  ├── sub_agents               registry: name, runtime, slot, skills, status│
│  ├── sub_agent_telegram_links bot_id ↔ agent_id  (UNIQUE both sides)       │
│  └── agent_tasks              task queue: immediate + scheduled             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key design decisions

| Decision | Detail |
|---|---|
| Telegram bots are gateways | Bots do not run the LLM — they forward to the linked sub-agent's bridge. Iris herself is not exposed via Telegram. |
| One-to-one bot ↔ agent | UNIQUE constraint on both `bot_id` and `agent_id` in Supabase. One bot cannot serve two agents; one agent cannot be served by two bots. |
| Claim token workflow | Tokens generated via API (`POST /agents/:id/telegram/token`), single-use, 10-min TTL, 64 hex chars. Never printed to logs. |
| Sub-agent runtime choice | `docker` (default) or `firecracker`. Docker is simpler; Firecracker gives KVM hardware isolation. |
| Skills hot-reload | Skills directory (`/iris/data/skills`) is volume-mounted read-only into every sub-agent container. Adding a skill on the host takes effect immediately — no restart. |
| Agent creation forbidden | Sub-agents cannot create other agents. Enforced at two levels: (1) `spawn-agent` skill is not mounted into sub-agent containers, (2) MEMORY.md constitution hard-blocks it. |
| Supabase dual-write | Agent records and Telegram links in Supabase survive VM reboots. Pending claim tokens live in a local JSON file (fast, process-restart durable) and expire independently. |

---

## What This Repo Contains

| Path | Purpose |
|---|---|
| `iris-runtime/` | Node.js AI agent runtime — transports, bridge, API, scheduler, watchdog |
| `skills/` | Hot-reloadable skill directories (symlinked to `/iris/data/skills`) |
| `supabase/schema.sql` | Canonical Supabase schema — run this to create all tables |
| `scripts/` | Firecracker VM lifecycle: `fc-up.sh`, `fc-down.sh`, `build-firecracker-rootfs.sh`, `iris-exec-server.py` |
| `agents/` | Sub-agent scaffolds (newsletter, public-sandbox) |
| `terraform/` | Dynamic Azure resources Iris provisions on demand |
| `CONSTITUTION.md` | Operator rules injected read-only into every system prompt |
| `MEMORY.md` | Iris's mutable global memory |
| `CLAUDE.md` | Repo-level writing rules (read before making changes) |
| `bootstrap.sh` | Full VM setup from scratch |
| `data/models.json` | LLM provider and model configuration |

---

## Runtime Source Layout

```
iris-runtime/src/
├── main.ts                # Entry point — parses flags, starts transports, API, watchdog
├── agent.ts               # AgentRunner — LLM calls, tool dispatch, context management
├── slack.ts               # Slack Socket Mode transport
├── telegram.ts            # Telegram long-poll transport — gateway to sub-agent bridges
├── telegram-link.ts       # TelegramLinkManager — claim tokens, bot↔agent cache + Supabase
├── sub-agent-registry.ts  # Platform-agnostic sub-agent CRUD (Supabase sub_agents table)
├── agent-provision.ts     # Docker + Firecracker provisioners, bridgeUrlForAgent()
├── agent-watchdog.ts      # 30s poll — docker inspect / exec-server health check
├── scheduler.ts           # croner-based task scheduler, missed-task recovery
├── task-queue.ts          # agent_tasks CRUD (immediate + scheduled)
├── api.ts                 # Internal HTTP API on :3000
├── bridge.ts              # Bridge HTTP server (sub-agents) + callAgentBridge() (main Iris)
├── sandbox.ts             # HostExecutor, DockerExecutor, FirecrackerExecutor, pool
├── vm-manager.ts          # On-demand Firecracker pool for Iris's own bash sandbox
├── store.ts               # ChannelStore — per-channel conversation history
└── events.ts              # EventsWatcher — file-based event dispatch
```

---

## Quick Start

```bash
sudo mkdir -p /iris && sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/iris-core.git /iris/repo
cd /iris/repo
bash bootstrap.sh --setup --no-keyvault   # simplest path
```

See [Setup Options](#setup-options) for all four install paths.

---

## Managing the Iris Service

```bash
sudo systemctl stop iris
sudo systemctl start iris
sudo systemctl restart iris
sudo journalctl -u iris -f          # live logs
```

> If `start` silently does nothing, the compiled JS is missing — run:
> ```bash
> cd /iris/repo/iris-runtime && npm install && npm run build
> sudo systemctl start iris
> ```

---

## Supabase Setup

Supabase is **required** for sub-agents and Telegram linking. Set it up before adding Telegram bots.

### Step 1 — Create a project

1. Go to [supabase.com](https://supabase.com) and create a free project
2. From **Project Settings → API**, copy:
   - **Project URL** → `https://<ref>.supabase.co`
   - **`service_role`** secret key (not the `anon` key)

### Step 2 — Add credentials to `/iris/.env`

```bash
echo "SUPABASE_URL=https://<ref>.supabase.co"                          >> /iris/.env
echo "SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." >> /iris/.env
sudo systemctl restart iris
```

### Step 3 — Run the schema

Go to **SQL Editor** in the Supabase dashboard (`/project/<ref>/sql/new`) and run this entire block:

```sql
-- ============================================================================
-- Iris Supabase Schema  —  safe to re-run (IF NOT EXISTS / exception guards)
-- ============================================================================

-- Sub-agent registry
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

-- Telegram bot ↔ sub-agent links  (one-to-one, enforced by UNIQUE on both columns)
-- linked_at = NULL  →  bot registered but not yet linked to an agent
-- Pending claim tokens are NOT stored here — they live in a local JSON file
CREATE TABLE IF NOT EXISTS sub_agent_telegram_links (
    bot_id      TEXT        PRIMARY KEY,
    agent_id    UUID        UNIQUE REFERENCES sub_agents(agent_id) ON DELETE SET NULL,
    linked_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE sub_agent_telegram_links DISABLE ROW LEVEL SECURITY;

-- Task queue
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
    bot_id         TEXT        NOT NULL,       -- Telegram bot owning the delivery channel
    channel_id     TEXT        NOT NULL,       -- tg-{chatId}
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
CREATE INDEX IF NOT EXISTS agent_tasks_agent_idx    ON agent_tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS agent_tasks_schedule_idx ON agent_tasks(scheduled_for) WHERE status = 'pending';
ALTER TABLE agent_tasks DISABLE ROW LEVEL SECURITY;
```

### Step 4 — Verify

Supabase **Table Editor** should now show three tables: `sub_agents`, `sub_agent_telegram_links`, `agent_tasks`.

### Migrating from old schema (telegram_claim / telegram_agents)

```sql
-- Run BEFORE the schema block above to clear legacy tables
DROP TABLE IF EXISTS agent_tasks     CASCADE;
DROP TABLE IF EXISTS telegram_agents CASCADE;
DROP TABLE IF EXISTS telegram_claim  CASCADE;
DROP TYPE  IF EXISTS agent_status    CASCADE;
DROP TYPE  IF EXISTS task_type       CASCADE;
DROP TYPE  IF EXISTS task_status     CASCADE;
-- Then re-run the full schema block above
```

---

## Telegram Setup

Each Telegram bot is a **gateway**. It only responds to messages once linked to a sub-agent via a claim token.

> Supabase must be configured first — see [Supabase Setup](#supabase-setup).

### Step 1 — Create bots via @BotFather

1. Message `@BotFather` on Telegram
2. Send `/newbot`, pick a name and username (must end in `bot`)
3. Copy the token: `7123456789:AAFxyz...`

Repeat for each bot you want (max 5).

### Step 2 — Add tokens to `/iris/.env`

```bash
echo "TELEGRAM_BOT_TOKEN=7123456789:AAFxyz..."   >> /iris/.env
echo "TELEGRAM_BOT_TOKEN_2=7987654321:BBGabc..." >> /iris/.env   # optional
echo "TELEGRAM_BOT_TOKEN_3=7111222333:CCHdef..." >> /iris/.env   # optional
# _4 and _5 also supported
sudo systemctl restart iris
```

Verify bots started:
```bash
sudo journalctl -u iris | grep telegram
# [telegram:123456789] Started. Send a sub-agent claim token to this bot to link it.
```

Bots are now **running but unlinked** — they ignore all messages except 64-char hex claim tokens.

### Step 3 — Create a sub-agent

```bash
# Docker runtime (default — recommended)
curl -s -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"MyAgent","skills":["search-web","send-email"],"runtime":"docker"}' | jq .

# Firecracker runtime (KVM isolation — requires /dev/kvm)
curl -s -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"MyAgent","skills":["search-web","send-email"],"runtime":"firecracker"}' | jq .
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

| Runtime | Bridge URL (slot 1) | Isolation | Requires |
|---|---|---|---|
| `docker` | `http://127.0.0.1:4201` | Docker namespace + seccomp | Docker |
| `firecracker` | `http://172.20.1.2:4200` | KVM hardware VM boundary | `/dev/kvm` + rootfs |

### Step 4 — Generate a claim token

```bash
curl -s -X POST http://localhost:3000/agents/a1b2c3d4-.../telegram/token | jq .
```

```json
{
  "token": "a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1",
  "expiresIn": "10 minutes"
}
```

Token also written to `/iris/data/telegram-link-token.txt`. Expires after 10 minutes; regenerating invalidates the previous one immediately.

### Step 5 — Send the token to the bot

Paste the 64-char hex token as a plain message to your Telegram bot:

```
a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1
```

Bot replies: `✅ Linked to sub-agent "MyAgent". You can start chatting now!`

### Step 6 — Verify

```bash
curl -s http://localhost:3000/agents/a1b2c3d4-... | jq '{name,runtime,status,slotIndex}'
```

Send `/status` to the bot in Telegram:
```
🤖 MyAgent  (docker · slot 1)
Bridge: http://127.0.0.1:4201
Skills: search-web, send-email
Status: running
```

### Telegram linking rules

| Rule | Detail |
|---|---|
| One-to-one | One bot ↔ one agent. Neither side can be shared. |
| Unlinked bot | Ignores all messages except a valid claim token. |
| Token expiry | 10 minutes, single-use. Re-generate to get a fresh one. |
| Unlinking via Telegram | Send `/unlink` then `/unlink confirm` |
| Unlinking via API | `DELETE /agents/:id/telegram` |
| Re-linking | Unlink first, then generate a new token. |

### Telegram bot commands

| Command | What it does |
|---|---|
| `/status` | Show linked agent name, runtime, bridge URL, skills, status |
| `/skills` | List declared skills for this agent |
| `/install <skill>` | Add a skill (confirmation dialog shown first) |
| `/reset` | Clear conversation history |
| `/compact` | Summarise context to save tokens |
| `/stop` | Abort a running response |
| `/unlink` | Disconnect this bot from its sub-agent |

### Adding skills to an existing agent

Skills are volume-mounted from the host — no container restart needed:

```bash
# Add skill files on the host
cp -r my-new-skill /iris/data/skills/

# Update the agent's declared skill list
curl -s -X PATCH http://localhost:3000/agents/a1b2c3d4-.../skills \
  -H "Content-Type: application/json" \
  -d '{"skills": ["search-web", "send-email", "my-new-skill"]}'
```

Or from Telegram: `/install my-new-skill`

---

## Sub-Agent API Reference

Base URL: `http://localhost:3000`

### Sub-agent CRUD

| Method | Path | Body / Notes |
|---|---|---|
| `GET` | `/agents` | List all sub-agents |
| `POST` | `/agents` | `{name, skills?, runtime?}` — create + provision |
| `GET` | `/agents/:id` | Get one sub-agent |
| `DELETE` | `/agents/:id` | Stop container/VM, unlink Telegram, delete record |
| `PATCH` | `/agents/:id/skills` | `{skills: [...]}` — replace skill list |

### Telegram linking

| Method | Path | Notes |
|---|---|---|
| `POST` | `/agents/:id/telegram/token` | Generate claim token (10 min TTL, single-use) |
| `DELETE` | `/agents/:id/telegram` | Unlink bot from agent |

### Full lifecycle example

```bash
# 1. Create agent
AGENT=$(curl -s -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"Research","skills":["search-web","github"],"runtime":"docker"}')
ID=$(echo $AGENT | jq -r .agentId)

# 2. Link to Telegram
TOKEN=$(curl -s -X POST http://localhost:3000/agents/$ID/telegram/token | jq -r .token)
echo "Send this to your bot: $TOKEN"

# 3. Update skills later (no restart needed)
curl -s -X PATCH http://localhost:3000/agents/$ID/skills \
  -H "Content-Type: application/json" \
  -d '{"skills":["search-web","github","send-email"]}'

# 4. Unlink Telegram
curl -s -X DELETE http://localhost:3000/agents/$ID/telegram

# 5. Delete agent
curl -s -X DELETE http://localhost:3000/agents/$ID
```

---

## Setup Options

| | No Firecracker | With Firecracker |
|---|---|---|
| **No Azure** | Option 1 — simplest | Option 3 |
| **Azure Key Vault** | Option 2 | Option 4 — full production |

```bash
# Option 1 — no Azure, no Firecracker
bash bootstrap.sh --setup --no-keyvault

# Option 2 — Azure Key Vault, no Firecracker
bash bootstrap.sh --setup --keyvault

# Option 3 — no Azure, with Firecracker (requires /dev/kvm — use Ddsv5 on Azure)
bash bootstrap.sh --setup --no-keyvault --firecracker

# Option 4 — Azure Key Vault + Firecracker (full production)
bash bootstrap.sh --setup --keyvault --firecracker
```

All options start from:
```bash
sudo mkdir -p /iris && sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/iris-core.git /iris/repo
cd /iris/repo
```

Bootstrap installs: Docker, Node 22, GitHub CLI, Terraform, Azure CLI (if needed), Firecracker (if requested). It prompts for LLM provider key, Slack tokens, Telegram token, and optional integrations.

---

## Environment Variables (`/iris/.env`)

```bash
# LLM provider (required)
IRIS_PROVIDER=anthropic
IRIS_MODEL=claude-sonnet-4-5
ANTHROPIC_API_KEY=sk-ant-...

# Supabase (required for sub-agents + Telegram linking)
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Slack (optional)
IRIS_SLACK_APP_TOKEN=xapp-...
IRIS_SLACK_BOT_TOKEN=xoxb-...

# Telegram (optional, up to 5 bots)
TELEGRAM_BOT_TOKEN=7123456789:AAF...
TELEGRAM_BOT_TOKEN_2=798765...
TELEGRAM_BOT_TOKEN_3=711122...

# API / runtime
IRIS_API_PORT=3000
IRIS_API_URL=http://127.0.0.1:3000
IRIS_ENV=prod

# Optional integrations
GITHUB_TOKEN=ghp_...
RESEND_API_KEY=re_...
IRIS_KEY_VAULT=iris-kv-hostname     # Azure Key Vault name
```

Never commit `/iris/.env` to git.

---

## Secrets via Azure Key Vault

```bash
KV=$(grep ^IRIS_KEY_VAULT /iris/.env | cut -d= -f2)
az keyvault secret set --vault-name "$KV" --name "ANTHROPIC-API-KEY"         --value "sk-ant-..."
az keyvault secret set --vault-name "$KV" --name "SUPABASE-URL"              --value "https://..."
az keyvault secret set --vault-name "$KV" --name "SUPABASE-SERVICE-ROLE-KEY" --value "eyJ..."
az keyvault secret set --vault-name "$KV" --name "SLACK-APP-TOKEN"           --value "xapp-..."
az keyvault secret set --vault-name "$KV" --name "SLACK-BOT-TOKEN"           --value "xoxb-..."
az keyvault secret set --vault-name "$KV" --name "TELEGRAM-BOT-TOKEN"        --value "7123..."
az keyvault secret set --vault-name "$KV" --name "GITHUB-TOKEN"              --value "ghp_..."
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `iris.service` fails to start | Missing env vars | `journalctl -u iris` + check `/iris/.env` |
| Telegram bot ignores all messages | Bot is unlinked | Generate a claim token and send it to the bot |
| Claim token rejected | Expired or already used | `POST /agents/:id/telegram/token` — generates a fresh one |
| `already_linked` on token send | Bot or agent already linked | `/unlink confirm` in Telegram or `DELETE /agents/:id/telegram` |
| Sub-agent container not starting | `iris-runtime:local` missing | Rebuild image (see below) |
| Firecracker VM not booting | `/dev/kvm` unavailable | Resize VM to Ddsv5 series on Azure (B/D/F series have no KVM) |
| `firecracker: permission denied` | Not in kvm group | `sudo usermod -aG kvm $USER` then re-login |
| Supabase errors | Missing credentials | Add `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to `.env` |
| Schema mismatch | Old tables still present | Run migration block then re-run schema |
| `fatal: repository not found` | Wrong remote URL | `git remote set-url origin https://github.com/irisworks/iris-core.git` |

### Rebuild the `iris-runtime:local` Docker image

```bash
cd /iris/repo/iris-runtime
npm install && npm run build
docker build -t iris-runtime:local .
docker images iris-runtime:local   # verify
```

After rebuild, restart crashed sub-agent containers:
```bash
docker ps -a --filter name=iris-agent --format '{{.Names}}'
docker restart <container-name>
```

For Firecracker sub-agents, also rebuild the rootfs:
```bash
sudo bash /iris/repo/scripts/build-firecracker-rootfs.sh
```

### Reset a Firecracker public-sandbox VM

```bash
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

---

## Operational Notes

- **Skills hot-reload**: drop a skill directory into `/iris/data/skills/` on the host — all running sub-agent containers see it immediately (volume-mounted `:ro`). No restart needed.
- **Sub-agent naming**: Docker containers are `iris-agent-{agentId}`; Firecracker VMs are `iris-fc-{agentId}`. Bridge ports: Docker uses `127.0.0.1:420{1..10}`; Firecracker uses `172.20.{slot}.2:4200`.
- **Watchdog**: checks Docker via `docker inspect`, Firecracker via exec-server `/health`. On crash, notifies the linked Telegram bot. On recovery, marks missed scheduled tasks as skipped.
- **Telegram state**: active links in Supabase (survive reboots). Pending claim tokens in `/iris/data/telegram-link-tokens.json` (expire after 10 min regardless).
- **Agent creation restriction**: enforced at two independent levels — `spawn-agent` skill is not mounted into sub-agent containers, AND MEMORY.md constitution explicitly forbids it. Neither can be overridden by a user instruction.
- **VM is disposable**: GitHub is the source of truth. A full rebuild from this README produces an identical running system.
- **Never commit** secrets to git (`.env`, `models.json` with keys, etc.).

---

## Source Documents

Read these before making changes:

- [CLAUDE.md](CLAUDE.md) — code writing rules and conventions
- [CONSTITUTION.md](CONSTITUTION.md) — operator rules injected into every prompt
- [MEMORY.md](MEMORY.md) — Iris's current global memory
- [supabase/schema.sql](supabase/schema.sql) — canonical database schema
