# Iris Core

Iris is a self-hosted AI agent runtime. It runs on a single Azure VM as a systemd service and manages a main agent plus isolated sub-agents. Each sub-agent gets its own runtime (Docker container or Firecracker micro-VM), its own dedicated Telegram Bot and/or Slack App (BYO credentials attached via the integration API), and its own set of skills. Main Iris has no Telegram or Slack bots of her own — she routes internally via a bridge transport.

---

## Table of Contents

1. [Architecture](#architecture)
2. [What This Repo Contains](#what-this-repo-contains)
3. [Prerequisites](#prerequisites)
4. [Setup Guide](#setup-guide)
   - [Step 1 — Supabase](#step-1--supabase-required-first)
   - [Step 2 — LLM Provider](#step-2--llm-provider)
   - [Step 3 — Slack App (per sub-agent)](#step-3--slack-app-optional--per-sub-agent)
   - [Step 4 — Telegram Bots (per sub-agent)](#step-4--telegram-bots-optional--per-sub-agent)
   - [Step 5 — Clone the Repo](#step-5--clone-the-repo)
   - [Step 6 — Configure `/iris/.env`](#step-6--configure-irisenv)
   - [Step 7 — Build iris-runtime](#step-7--build-iris-runtime)
   - [Step 8 — Start the Service](#step-8--start-the-service)
   - [Step 9 — Verify Everything Works](#step-9--verify-everything-works)
5. [Creating Sub-Agents](#creating-sub-agents)
6. [Attaching Telegram to a Sub-Agent](#attaching-telegram-to-a-sub-agent)
7. [Attaching Slack to a Sub-Agent](#attaching-slack-to-a-sub-agent)
8. [API Reference — v1 (Current)](#api-reference--v1-current)
9. [API Reference — v2 (Gateway-Ready)](#api-reference--v2-gateway-ready)
10. [Gateway Integration](#gateway-integration)
11. [Environment Variables](#environment-variables)
12. [Runtime Source Layout](#runtime-source-layout)
13. [Managing the Service](#managing-the-service)
14. [Troubleshooting](#troubleshooting)
15. [Operational Notes](#operational-notes)

---

## Architecture

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                     CURRENT STATE  (single-tenant VM)                    ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  You ── Sub-agent's dedicated Slack App (Socket Mode) ─────────────────► ║
║  You ── Sub-agent's dedicated Telegram Bot (long-poll) ─────────────────► ║
║                                                                           ║
║  ┌─────────────────────────────────────────────────────────────────────┐ ║
║  │  iris.service  (systemd)  · Node.js · working dir: /iris/data      │ ║
║  │                                                                     │ ║
║  │  Internal API  :3000  (/agents, /sessions, /event …)               │ ║
║  │  v2 API        :3000  (/v2/sub-agents, /v2/main-agent …)           │ ║
║  │  EventsWatcher → slack/events/  telegram/events/  events/          │ ║
║  │  Scheduler     → croner + Supabase agent_tasks                     │ ║
║  │  Watchdog      → 30 s poll, crash/recovery detection               │ ║
║  └────────────────────────────┬────────────────────────────────────────┘ ║
║                               │ bridge HTTP                              ║
║  ┌────────────────────────────▼────────────────────────────────────────┐ ║
║  │  Sub-Agent Layer  (slots 1–10)                                      │ ║
║  │                                                                     │ ║
║  │  Docker runtime (default)                                           │ ║
║  │    Container:  iris-agent-{agentId}                                 │ ║
║  │    Bridge URL: http://127.0.0.1:{4200+slot}  (e.g. :4201 slot 1)  │ ║
║  │                                                                     │ ║
║  │  Firecracker runtime (KVM required)                                 │ ║
║  │    VM name:    iris-fc-{agentId}  (slot N → 172.20.N.2)            │ ║
║  │    Bridge URL: http://172.20.{slot}.2:4200                         │ ║
║  └─────────────────────────────────────────────────────────────────────┘ ║
╠═══════════════════════════════════════════════════════════════════════════╣
║                                                                           ║
║  Storage                                                                  ║
║  ├── Supabase   sub_agents · claim_tokens · tasks · sessions · routing   ║
║  ├── Local FS   /iris/data  (channel history, MEMORY.md, context)        ║
║  └── Azure Blob (optional write-through, enable with BLOB_ENABLED=true)  ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

```
╔═══════════════════════════════════════════════════════════════════════════╗
║        FUTURE STATE  (multi-tenant, Gateway + VM Orchestrator)           ║
╠═══════════════════════════════════════════════════════════════════════════╣
║  User → API Gateway (Express) → Internal JWT → Firecracker VM per user   ║
║  Each VM runs iris-runtime.  Gateway routes by userId → vmId → vmIP.    ║
║  iris-runtime's /v2/* endpoints, JWT auth chain (Internal/Runtime/        ║
║  Integration), one-user-one-VM scoping, and routing-table writes are     ║
║  wired and gated — see "Gateway Integration" for what's live vs. open.   ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

### Key design decisions

| Decision | Why |
|---|---|
| Each sub-agent owns its own dedicated bot/app | BYO: owner creates their own Telegram Bot / Slack App and attaches credentials via the API. Main Iris has neither — she routes via internal bridge transport only. |
| Claim token = ownership verification, not a claim from a pool | Anyone could paste a stolen token into the attach form; only the real owner can make *their* bot deliver the token back. Single-use, 10-min TTL, stored in Supabase `claim_tokens`. |
| No shared-pool bot limits | Old 5-bot / 10-agent caps removed. Sub-agent slots: 1–250 (Firecracker IPv4-octet limit). Each agent brings its own bot — no global pool to contend for. |
| Sub-agents cannot create agents | Enforced at 3 levels: missing skill mount, filtered in AgentRunner, MEMORY.md hard-block |
| Skills hot-reload | Volume-mounted read-only. Add a skill dir to the host and it's live immediately. Sub-agents can acquire global skills at runtime via `POST /internal/skills/acquire`. |
| `LEGACY_SHARED_BOT_MODE` | Set `=1` on Main Iris during Phase 8 migration to keep old shared-pool bots alive while owners self-migrate to dedicated-bot attach flow. |
| Dual API (v1 + v2) | v1 keeps the system running today. v2's auth/routing/scoping chain is wired and gated, but unverified against a live Gateway — see "Gateway Integration" |

---

## What This Repo Contains

| Path | Purpose |
|---|---|
| `iris-runtime/` | Node.js AI agent runtime — all the moving parts |
| `iris-runtime/src/auth.ts` | Internal/Runtime/Integration JWT chain + one-user-one-VM scoping (`SCOPE_ENFORCED`) — gated, see "Gateway Integration" |
| `iris-runtime/src/blob.ts` | Azure Blob write-through (off by default) |
| `iris-runtime/src/managers/` | Session, Memory, Skill, Thread, Integration managers |
| `iris-runtime/src/routes/` | v2 API route handlers — auth/scoping/integration checks wired and gated, see "Gateway Integration" |
| `skills/` | Hot-reloadable skill directories (symlinked → `/iris/data/skills`) |
| `supabase/schema.sql` | Canonical Supabase schema — single SQL block, safe to re-run |
| `scripts/` | Firecracker VM lifecycle scripts |
| `agents/` | Example sub-agent scaffolds |
| `terraform/` | Dynamic Azure resources Iris provisions on demand |
| `CONSTITUTION.md` | Operator rules injected read-only into every agent system prompt |
| `MEMORY.md` | Iris's mutable global memory |
| `CLAUDE.md` | Code conventions — read before changing anything |
| `bootstrap.sh` | Full VM setup script |

---

## Prerequisites

Before starting, make sure you have or can create the following. Nothing needs to be installed yet — the bootstrap script handles that.

| Requirement | Where to get it | Required? |
|---|---|---|
| An Azure VM (Ubuntu 22.04, 2+ vCPUs, 8 GB RAM) | Azure portal | Yes |
| A Supabase project | supabase.com (free tier works) | Yes |
| An LLM provider API key | Anthropic / OpenAI / etc. | Yes |
| A Slack app (per sub-agent) | api.slack.com/apps | Optional — created per sub-agent |
| A Telegram bot (per sub-agent) | @BotFather on Telegram | Optional — created per sub-agent |
| `/dev/kvm` access on the VM | Azure Ddsv5 series | Only for Firecracker |

> **Minimum to get running**: Supabase + an LLM key. Slack and Telegram bots are attached per sub-agent after setup — neither is required to start the service.

---

## Setup Guide

Follow these steps **in order**. Supabase must be done first because the runtime reads from it on startup.

---

### Step 1 — Supabase (required first)

Supabase is the persistence layer. Agent records, Telegram/Slack links, scheduled tasks, sessions, and the routing table (`runtime_mapping`, actively written on agent provisioning — see "Gateway Integration") all live here. The runtime fails gracefully without it, but sub-agents cannot be created.

#### 1a — Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up or log in
2. Click **New project**
3. Choose a name (e.g. `iris-core`), a database password, and a region close to your VM
4. Wait for provisioning (~1 minute)

#### 1b — Copy your credentials

In your project, go to **Project Settings → API**:

- Copy the **Project URL** — looks like `https://abcdefgh.supabase.co`
- Under **Project API keys**, copy the **`service_role`** key (the long one that starts with `eyJ`) — **not** the `anon` key

Keep these handy for Step 6.

#### 1c — Run the schema

Go to **SQL Editor** (`/project/<ref>/sql/new` in the Supabase dashboard) and paste + run the entire block below.

This is **idempotent** — safe to re-run any time without data loss.

```sql
-- ============================================================================
-- Iris Core — Supabase Schema
-- Run this in the Supabase SQL Editor.
-- CREATE TABLE / INDEX statements use IF NOT EXISTS — safe to re-run.
-- CREATE TYPE statements will error if types already exist; wrap in
-- DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$ if needed.
-- ============================================================================

-- ── ENUM types ───────────────────────────────────────────────────────────────

CREATE TYPE agent_status      AS ENUM ('running', 'stopped', 'crashed');
CREATE TYPE task_type         AS ENUM ('immediate', 'scheduled');
CREATE TYPE task_status       AS ENUM ('pending', 'running', 'done', 'failed', 'skipped');
-- HOST_VM=process on VM, DOCKER=container in VM, FIRECRACKER=nested micro-VM
CREATE TYPE runtime_type      AS ENUM ('HOST_VM', 'DOCKER', 'FIRECRACKER');
CREATE TYPE claim_token_type  AS ENUM ('telegram', 'slack');

-- ── Sub-agent registry ────────────────────────────────────────────────────────
-- Platform-agnostic. Each sub-agent owns its own dedicated Telegram Bot /
-- Slack App (BYO credentials). Credentials are stored as Key Vault secret URIs
-- (never raw tokens) in the *_ref columns; resolved at provision/attach time.

CREATE TABLE IF NOT EXISTS sub_agents (
    agent_id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT         NOT NULL,
    runtime                 TEXT         NOT NULL DEFAULT 'docker'
                                         CHECK (runtime IN ('docker', 'firecracker')),
    docker_container_id     TEXT,
    status                  agent_status NOT NULL DEFAULT 'stopped',
    skills                  JSONB        NOT NULL DEFAULT '[]',
    slot_index              SMALLINT     NOT NULL CHECK (slot_index BETWEEN 1 AND 250),
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT now(),
    -- Dedicated-bot credentials (Key Vault URIs — never raw tokens)
    telegram_bot_token_ref  TEXT,
    slack_app_token_ref     TEXT,
    slack_bot_token_ref     TEXT,
    telegram_status         TEXT CHECK (telegram_status IN ('unattached', 'pending_verification', 'linked')),
    slack_status            TEXT CHECK (slack_status    IN ('unattached', 'pending_verification', 'linked')),
    UNIQUE (name),
    UNIQUE (slot_index)
);

ALTER TABLE sub_agents DISABLE ROW LEVEL SECURITY;

-- ── Legacy shared-pool link tables (DEPRECATED) ───────────────────────────────
-- Superseded by the *_token_ref + *_status columns above.
-- Kept alive for LEGACY_SHARED_BOT_MODE during Phase 8 migration.
-- Drop both tables once the last migrated agent has self-migrated to
-- the dedicated-bot flow (no new rows should be written after cutover).

CREATE TABLE IF NOT EXISTS sub_agent_telegram_links (
    bot_id      TEXT        PRIMARY KEY,
    agent_id    UUID        UNIQUE REFERENCES sub_agents(agent_id) ON DELETE SET NULL,
    linked_at   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sub_agent_telegram_links DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS sub_agent_slack_links (
    workspace_id    TEXT        PRIMARY KEY,
    agent_id        UUID        UNIQUE REFERENCES sub_agents(agent_id) ON DELETE SET NULL,
    linked_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sub_agent_slack_links DISABLE ROW LEVEL SECURITY;

-- ── Per-agent task queue ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id       UUID        NOT NULL REFERENCES sub_agents(agent_id) ON DELETE CASCADE,
    bot_id         TEXT        NOT NULL,
    channel_id     TEXT        NOT NULL,
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

-- ── Users ─────────────────────────────────────────────────────────────────────
-- Managed by the API Gateway. iris-runtime reads only (to resolve userId).

CREATE TABLE IF NOT EXISTS users (
    user_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT        NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users DISABLE ROW LEVEL SECURITY;

-- ── VM routing table ──────────────────────────────────────────────────────────
-- Managed by the VM Orchestrator. Maps each user to their dedicated VM.

CREATE TABLE IF NOT EXISTS vm_routing (
    vm_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID        NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    vm_ip      TEXT        NOT NULL,
    status     TEXT        NOT NULL DEFAULT 'stopped'
                           CHECK (status IN ('starting', 'running', 'stopping', 'stopped', 'error')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vm_routing_user_idx ON vm_routing(user_id);

ALTER TABLE vm_routing DISABLE ROW LEVEL SECURITY;

-- ── Runtime mapping ───────────────────────────────────────────────────────────
-- Written by iris-runtime on agent provisioning (agentId → runtimeId → type).

CREATE TABLE IF NOT EXISTS runtime_mapping (
    runtime_id   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id     UUID         NOT NULL UNIQUE REFERENCES sub_agents(agent_id) ON DELETE CASCADE,
    vm_id        UUID         NOT NULL REFERENCES vm_routing(vm_id) ON DELETE CASCADE,
    runtime_type runtime_type NOT NULL DEFAULT 'DOCKER',
    bridge_url   TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS runtime_mapping_vm_idx    ON runtime_mapping(vm_id);
CREATE INDEX IF NOT EXISTS runtime_mapping_agent_idx ON runtime_mapping(agent_id);

ALTER TABLE runtime_mapping DISABLE ROW LEVEL SECURITY;

-- ── Claim tokens ──────────────────────────────────────────────────────────────
-- Single-use ownership-verification tokens, 64 hex chars, 10-min TTL.
-- iris-runtime writes on attach; the bot delivers it back to prove bot ownership.

CREATE TABLE IF NOT EXISTS claim_tokens (
    token      TEXT             PRIMARY KEY,
    agent_id   UUID             NOT NULL REFERENCES sub_agents(agent_id) ON DELETE CASCADE,
    type       claim_token_type NOT NULL,
    expires_at TIMESTAMPTZ      NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claim_tokens_agent_idx   ON claim_tokens(agent_id);
CREATE INDEX IF NOT EXISTS claim_tokens_expires_idx ON claim_tokens(expires_at) WHERE used_at IS NULL;

ALTER TABLE claim_tokens DISABLE ROW LEVEL SECURITY;

-- ── Sessions ──────────────────────────────────────────────────────────────────
-- Written by iris-runtime (SessionManager). Scoped to agent_id when created
-- via the v2 message API (newThread flow). Queryable by the Gateway frontend.

CREATE TABLE IF NOT EXISTS sessions (
    session_id        TEXT        PRIMARY KEY,
    user_id           UUID        REFERENCES users(user_id)       ON DELETE SET NULL,
    agent_id          UUID        REFERENCES sub_agents(agent_id) ON DELETE SET NULL,
    origin_channel    TEXT        NOT NULL,
    origin_thread_ts  TEXT,
    working_channel   TEXT,
    working_thread_ts TEXT,
    client_email      TEXT,
    metadata          JSONB       NOT NULL DEFAULT '{}',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_agent_idx ON sessions(agent_id);

ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;

-- ── Migration: add dedicated-bot columns to existing sub_agents table ─────────
-- If sub_agents already existed from a prior schema, CREATE TABLE above was a
-- no-op — run this to add the new columns idempotently.

ALTER TABLE sub_agents
    ADD COLUMN IF NOT EXISTS telegram_bot_token_ref TEXT,
    ADD COLUMN IF NOT EXISTS slack_app_token_ref    TEXT,
    ADD COLUMN IF NOT EXISTS slack_bot_token_ref    TEXT,
    ADD COLUMN IF NOT EXISTS telegram_status        TEXT,
    ADD COLUMN IF NOT EXISTS slack_status           TEXT;

-- Raise slot_index ceiling from old cap of 10 to 250 (Firecracker limit).
DO $$ BEGIN
    ALTER TABLE sub_agents DROP CONSTRAINT IF EXISTS sub_agents_slot_index_check;
    ALTER TABLE sub_agents ADD CONSTRAINT sub_agents_slot_index_check
        CHECK (slot_index BETWEEN 1 AND 250);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add FIRECRACKER to runtime_type enum (idempotent — safe to re-run).
ALTER TYPE runtime_type ADD VALUE IF NOT EXISTS 'FIRECRACKER';
```

#### 1d — Verify

After running the SQL, open **Table Editor** in the Supabase dashboard. You should see these tables:

| Table | Description |
|---|---|
| `sub_agents` | Sub-agent registry — includes `telegram_bot_token_ref`, `slack_app_token_ref`, `slack_bot_token_ref`, `telegram_status`, `slack_status` columns for dedicated-bot credentials |
| `sub_agent_telegram_links` | **DEPRECATED** — legacy shared-pool Telegram links. Kept live for `LEGACY_SHARED_BOT_MODE` migration window only. |
| `sub_agent_slack_links` | **DEPRECATED** — legacy shared-pool Slack links. Same migration status. |
| `agent_tasks` | Scheduled and immediate task queue |
| `users` | User accounts. iris-runtime reads only (to resolve `userId` from an Internal JWT) — no read path wired yet |
| `vm_routing` | Per-user VM assignments — exclusively VM-Orchestrator-owned, iris-runtime never writes here |
| `runtime_mapping` | Agent → runtime mapping — **actively written** by iris-runtime on agent provisioning, gated on a real Gateway-issued VM UUID. See "Gateway Integration" |
| `claim_tokens` | Ownership-verification tokens — **wired**: iris-runtime writes/reads these on dedicated-bot attach/verify |
| `sessions` | Conversation sessions — **wired**: iris-runtime creates sessions on new-thread API calls, scoped by `agent_id` |

If any table is missing, re-run the SQL block — CREATE TABLE statements use IF NOT EXISTS.

#### Migrating from old schema (if you already have tables)

If you ran an older schema that had `telegram_claim` or `telegram_agents` tables, run this cleanup first, **then** re-run the full schema block above:

```sql
-- !! Only run this if you have the OLD schema with telegram_claim / telegram_agents !!
-- This drops legacy tables and stale types so the current schema can be applied cleanly.
DROP TABLE IF EXISTS agent_tasks     CASCADE;
DROP TABLE IF EXISTS telegram_agents CASCADE;
DROP TABLE IF EXISTS telegram_claim  CASCADE;
DROP TYPE  IF EXISTS agent_status    CASCADE;
DROP TYPE  IF EXISTS task_type       CASCADE;
DROP TYPE  IF EXISTS task_status     CASCADE;
```

> **Note:** A compatibility shim in `sub-agent-registry.ts` keeps things working during migration.
> After running the migration, remove `upsertCompatRow` / `deleteCompatRow` from that file.

---

### Step 2 — LLM Provider

iris-runtime supports Anthropic, OpenAI, and any OpenAI-compatible provider.

#### Anthropic (recommended)

1. Go to [console.anthropic.com](https://console.anthropic.com) → **API Keys** → create a key
2. Note your key: `sk-ant-api03-...`
3. You will add it to `/iris/.env` in Step 6

Default model: `claude-sonnet-4-5`. Supported values for `IRIS_MODEL`:
- `claude-opus-4-8` (most capable)
- `claude-sonnet-4-6` (fast + capable)
- `claude-haiku-4-5-20251001` (fastest, cheapest)

#### OpenAI

```bash
IRIS_PROVIDER=openai
IRIS_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```

#### Other OpenAI-compatible providers

Set `OPENAI_BASE_URL` to the provider's API base URL, then set provider/model/key as above.

---

### Step 3 — Slack App (optional — per sub-agent)

> **Architecture note**: Main Iris has **no** Slack app of her own. Slack apps are created by sub-agent owners and attached to a specific sub-agent via the API (see "Attaching Slack to a Sub-Agent"). You do not need to create a Slack app here — skip this step and do it after you have created your first sub-agent.
>
> If you are migrating from the old shared-pool model and want to keep existing linked workspaces running during migration, set `LEGACY_SHARED_BOT_MODE=1` in `/iris/.env` and add the old `IRIS_SLACK_APP_TOKEN` / `IRIS_SLACK_BOT_TOKEN` values. New setups should skip both variables entirely.

#### Quick reference

```
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
  └───────────────────────────────────────────────────────────────┘
```

#### 3a — Create a Slack App (for a sub-agent)

Each sub-agent that you want to reach via Slack needs its own dedicated Slack App in the workspace(s) it operates in. Iris uses Socket Mode — no public HTTPS endpoint needed.

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it after your sub-agent (e.g. `Research Agent`) and pick the target workspace
4. Click **Create App**

#### 3b — Enable Socket Mode

1. In the left sidebar, click **Socket Mode** (under Settings)
2. Toggle **Enable Socket Mode** to ON
3. Create an App-Level Token:
   - Name it anything (e.g. `socket-token`)
   - Add the scope: `connections:write`
   - Click **Generate**
4. Copy the token — it starts with `xapp-` → this is `slackAppToken` for the attach call

#### 3c — Add Bot Token Scopes

1. In the sidebar, go to **OAuth & Permissions**
2. Scroll to **Bot Token Scopes** and add:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Detect when the bot is mentioned |
| `channels:history` | Read messages in channels the bot is in |
| `channels:read` | List public channels |
| `chat:write` | Post messages |
| `files:write` | Upload files |
| `groups:history` | Read private channel messages |
| `groups:read` | List private channels |
| `im:history` | Read direct messages |
| `im:read` | List direct message conversations |
| `im:write` | Open direct message channels |
| `mpim:history` | Read group direct messages |
| `reactions:write` | Add emoji reactions |
| `users:read` | Resolve user names |

#### 3d — Subscribe to Events

1. Go to **Event Subscriptions**, toggle **Enable Events** to ON
2. Under **Subscribe to bot events** add: `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`
3. Click **Save Changes**

#### 3e — Install the app and collect tokens

1. **OAuth & Permissions** → **Install to Workspace** → **Allow**
2. Copy the **Bot User OAuth Token** (starts with `xoxb-`) → this is `slackBotToken`

#### 3f — What you have now

| Variable | Looks like | Used in |
|---|---|---|
| `slackAppToken` | `xapp-1-A012...` | `POST /v2/sub-agents/:id/integrations/slack` body |
| `slackBotToken` | `xoxb-1234...` | Same attach call |

These are passed directly to the attach API (Step 3 of "Attaching Slack to a Sub-Agent") — they are **not** added to `/iris/.env`.

---

### Step 4 — Telegram Bots (optional — per sub-agent)

> **Architecture note**: Main Iris has **no** Telegram bot of her own. Telegram bots are created by sub-agent owners and attached to a specific sub-agent via the API (see "Attaching Telegram to a Sub-Agent"). You do not need a bot token here — skip this step and do it after you have created your first sub-agent.

#### 4a — Create a bot via @BotFather

1. Open Telegram and search for `@BotFather`
2. Send: `/newbot`
3. Choose a display name (e.g. `Research Bot`)
4. Choose a username — must end in `bot` (e.g. `research_iris_bot`)
5. BotFather replies with your token: `7123456789:AAFxyz_rest_of_token`

#### 4b — (Optional) Enable group access

If you want the bot to see all messages in groups (not just commands):

1. Message `@BotFather` → `/mybots` → select your bot
2. **Bot Settings** → **Group Privacy** → turn **OFF**

#### 4c — What you have now

| Variable | Token format | Used in |
|---|---|---|
| `telegramBotToken` | `7123456789:AAFxyz...` | `POST /v2/sub-agents/:id/integrations/telegram` body |

This is passed directly to the attach API — it is **not** added to `/iris/.env`.

---

### Step 5 — Clone the Repo

SSH into your Azure VM:

```bash
sudo mkdir -p /iris && sudo chown $USER:$USER /iris
git clone https://github.com/irisworks/iris-core.git /iris/repo
cd /iris/repo
```

Run the bootstrap script to install all system dependencies:

```bash
# Simplest — no Azure Key Vault, no Firecracker
bash bootstrap.sh --setup --no-keyvault

# With Firecracker VM isolation (Azure Ddsv5 series required for /dev/kvm)
bash bootstrap.sh --setup --no-keyvault --firecracker

# With Azure Key Vault for secret management
bash bootstrap.sh --setup --keyvault

# Full production — Key Vault + Firecracker
bash bootstrap.sh --setup --keyvault --firecracker
```

Bootstrap installs: Docker, Node.js 22, GitHub CLI, Azure CLI (if needed), Firecracker (if requested). It will prompt you for keys and tokens during setup.

---

### Step 6 — Configure `/iris/.env`

Create the env file if it does not exist:

```bash
touch /iris/.env
chmod 600 /iris/.env   # keep secrets private
```

Open it with a text editor (`nano /iris/.env`) and add your values. Copy the template below, fill in your real values, and delete lines you do not need:

```bash
# ─────────────────────────────────────────────────────────────────────────────
# LLM PROVIDER  (required — pick one)
# ─────────────────────────────────────────────────────────────────────────────
IRIS_PROVIDER=anthropic
IRIS_MODEL=claude-sonnet-4-5
ANTHROPIC_API_KEY=sk-ant-api03-YOUR_KEY_HERE

# For OpenAI instead:
# IRIS_PROVIDER=openai
# IRIS_MODEL=gpt-4o
# OPENAI_API_KEY=sk-YOUR_KEY_HERE

# ─────────────────────────────────────────────────────────────────────────────
# SUPABASE  (required — from Step 1b)
# ─────────────────────────────────────────────────────────────────────────────
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.YOUR_KEY

# ─────────────────────────────────────────────────────────────────────────────
# SLACK / TELEGRAM  (Main Iris has no bots of her own)
# ─────────────────────────────────────────────────────────────────────────────
# Each sub-agent attaches its own dedicated Telegram Bot / Slack App via the
# integration API after it is created — see "Attaching Telegram/Slack" sections.
# Do NOT add IRIS_SLACK_APP_TOKEN, IRIS_SLACK_BOT_TOKEN, or TELEGRAM_BOT_TOKEN
# here for a new setup.
#
# Migration only: if upgrading from the old shared-pool model and want to keep
# legacy linked agents working while owners self-migrate, set:
# LEGACY_SHARED_BOT_MODE=1
# IRIS_SLACK_APP_TOKEN=xapp-1-A0123-YOUR_OLD_APP_LEVEL_TOKEN
# IRIS_SLACK_BOT_TOKEN=xoxb-YOUR_OLD_BOT_TOKEN
# TELEGRAM_BOT_TOKEN=7123456789:AAFxyz_OLD_BOT_TOKEN
# (Remove these and LEGACY_SHARED_BOT_MODE after all agents have migrated.)

# ─────────────────────────────────────────────────────────────────────────────
# RUNTIME  (sensible defaults — change only if needed)
# ─────────────────────────────────────────────────────────────────────────────
IRIS_API_PORT=3000
IRIS_API_URL=http://127.0.0.1:3000
IRIS_ENV=prod
IRIS_DIR=/iris

# ─────────────────────────────────────────────────────────────────────────────
# OPTIONAL INTEGRATIONS
# ─────────────────────────────────────────────────────────────────────────────
# GITHUB_TOKEN=ghp_YOUR_GITHUB_TOKEN
# RESEND_API_KEY=re_YOUR_RESEND_KEY     # email sending
# IRIS_KEY_VAULT=your-keyvault-name     # Azure Key Vault for sub-agent credentials

# ─────────────────────────────────────────────────────────────────────────────
# GATEWAY INTEGRATION  (leave unset — only needed when API Gateway is deployed)
# ─────────────────────────────────────────────────────────────────────────────
# GATEWAY_MODE=false                    # set true when Gateway is live
# GATEWAY_JWT_SECRET=                   # shared secret with the Gateway
# RUNTIME_JWT_SECRET=                   # secret for Runtime JWTs
# IRIS_RUNTIME_ID=                      # injected by VM Orchestrator
# IRIS_VM_ID=                           # injected by VM Orchestrator

# ─────────────────────────────────────────────────────────────────────────────
# AZURE BLOB STORAGE  (optional write-through — off by default)
# ─────────────────────────────────────────────────────────────────────────────
# BLOB_ENABLED=false
# AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
# BLOB_CONTAINER=iris-runtime
```

> Never commit `/iris/.env` to git. It is already in `.gitignore`.

---

### Step 7 — Build iris-runtime

```bash
cd /iris/repo/iris-runtime
npm install
npm run build
```

A successful build produces `dist/main.js`. If you see TypeScript errors, check that you are on Node.js 20 or later:

```bash
node --version   # must be 20+
```

Build the Docker image that sub-agents use:

```bash
docker build -t iris-runtime:local /iris/repo/iris-runtime
docker images iris-runtime:local   # verify it was built
```

---

### Step 8 — Start the Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable iris
sudo systemctl start iris
```

---

### Step 9 — Verify Everything Works

Check the service is running:

```bash
sudo systemctl status iris
# ● iris.service — Active: active (running)
```

Watch live logs:

```bash
sudo journalctl -u iris -f
```

You should see lines like:

```
iris-runtime: provider=anthropic model=claude-sonnet-4-5 environment=prod
[api] Internal API listening on http://0.0.0.0:3000
[main] No dedicated Telegram/Slack bots — Main Iris routes via bridge transport only
```

(No Telegram or Slack startup messages on Main Iris — that is expected. Bots are started inside sub-agent containers after attachment.)

Test the API:

```bash
curl -s http://localhost:3000/health | jq .
# { "ok": true, "channels": 0 }

curl -s http://localhost:3000/agents | jq .
# { "agents": [] }
```

Test the v2 health endpoint:

```bash
curl -s http://localhost:3000/v2/health | jq .
# { "ok": true, "data": { "runtimeId": "default", "gatewayMode": false, ... } }
```

If Slack tokens are set, Iris will connect and start listening. Try mentioning her in a Slack channel.

---

## Creating Sub-Agents

A sub-agent is an isolated AI agent running in its own Docker container (or Firecracker VM). It has its own memory, skills, and can be linked to a Telegram bot or Slack workspace.

### Create via API

```bash
# Docker runtime (default — recommended for most cases)
curl -s -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "research-agent",
    "skills": ["search-web", "github"],
    "runtime": "docker"
  }' | jq .
```

```json
{
  "agentId": "a1b2c3d4-1234-5678-abcd-ef0123456789",
  "name": "research-agent",
  "runtime": "docker",
  "slotIndex": 1,
  "status": "running",
  "skills": ["search-web", "github"]
}
```

Save the `agentId` — you need it for attaching a Telegram bot or Slack app.

```bash
# Firecracker runtime (hardware VM isolation — requires /dev/kvm)
curl -s -X POST http://localhost:3000/agents \
  -H "Content-Type: application/json" \
  -d '{"name":"secure-agent","skills":["bash"],"runtime":"firecracker"}' | jq .
```

### Runtime comparison

| | Docker | Firecracker |
|---|---|---|
| Bridge URL (slot 1) | `http://127.0.0.1:4201` | `http://172.20.1.2:4200` |
| Isolation | Docker namespace + seccomp | KVM hardware VM |
| Startup time | ~2 s | ~5 s |
| Requires | Docker (always installed) | `/dev/kvm` on the host |
| Best for | Most workloads | Untrusted code execution |

### List agents

```bash
curl -s http://localhost:3000/agents | jq '.agents[] | {name, status, runtime, slotIndex}'
```

### Delete an agent

```bash
curl -s -X DELETE http://localhost:3000/agents/a1b2c3d4-... | jq .
```

This stops the container/VM, unlinks any connected Telegram bot or Slack workspace, and removes the record from Supabase.

---

## Attaching Telegram to a Sub-Agent

Each sub-agent owns its own dedicated Telegram Bot (BYO). The attach flow stores the bot token as a Key Vault secret, re-provisions the sub-agent container with the token as an env var, and issues a **claim token** — a short-lived code you send to *your own bot* to prove you control it (anti-spoofing ownership check).

### Prerequisites

- A sub-agent already created (from "Creating Sub-Agents" above)
- A Telegram bot token from @BotFather (from Step 4, or create one now)

### Step 1 — Attach credentials

```bash
AGENT_ID="a1b2c3d4-1234-5678-abcd-ef0123456789"

curl -s -X POST http://localhost:3000/v2/sub-agents/$AGENT_ID/integrations/telegram \
  -H "Content-Type: application/json" \
  -d '{"telegramBotToken": "7123456789:AAFxyz_YOUR_BOT_TOKEN"}' | jq .
```

```json
{
  "agentId": "a1b2c3d4-...",
  "agentName": "research-agent",
  "platform": "telegram",
  "claimToken": "a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1",
  "expiresAt": "2026-06-09T12:10:00.000Z",
  "status": "pending_verification"
}
```

The sub-agent container is re-provisioned with the token. `status: "pending_verification"` means the bot is running but ownership has not been verified yet.

### Step 2 — Prove ownership (send the claim token to the bot)

Open Telegram, find your bot, and send it **exactly** the 64-character hex token as a plain message:

```
a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1b8d7f4a3f9c2e1
```

The bot replies: `✅ Ownership verified for sub-agent "research-agent". You can start chatting now!`

Internally, the bot calls `POST /internal/integrations/telegram/verify` which flips `telegram_status` to `"linked"` in Supabase.

### Step 3 — Confirm the status

```bash
curl -s http://localhost:3000/v2/sub-agents/$AGENT_ID | jq '.data.integrations'
```

```json
{
  "telegram": { "status": "linked", "dedicatedVerified": true },
  "slack":    { "status": "unattached" }
}
```

### Detaching

```bash
curl -s -X DELETE http://localhost:3000/v2/sub-agents/$AGENT_ID/integrations/telegram | jq .
```

This deletes the Key Vault secret and re-provisions the container without the token. The bot itself is not deleted — it just becomes unused.

### Telegram bot commands

Once the sub-agent's bot is verified, it responds to these built-in commands:

| Command | What it does |
|---|---|
| `/status` | Show agent name, runtime, bridge URL, skills, status |
| `/skills` | List this agent's current skills |
| `/install <skill>` | Add a skill to this agent |
| `/reset` | Clear conversation context |
| `/compact` | Summarise context to save tokens |
| `/stop` | Abort a running response |

### Rules

| Rule | Detail |
|---|---|
| One-to-one | One bot ↔ one agent. Neither side can be shared. |
| Claim token expires | 10 minutes from the attach call. Re-attach to get a fresh one. |
| Claim token is single-use | Once delivered to the bot, it cannot be reused. |
| Unverified bot behaviour | Accepts only the pending claim token; ignores all other messages until verified. |

---

## Attaching Slack to a Sub-Agent

Each sub-agent owns its own dedicated Slack App (BYO). The same claim-token ownership-verification flow applies.

### Prerequisites

- A sub-agent already created
- A Slack App token pair from Step 3 (`slackAppToken` + `slackBotToken`)

### Step 1 — Attach credentials

```bash
AGENT_ID="a1b2c3d4-1234-5678-abcd-ef0123456789"

curl -s -X POST http://localhost:3000/v2/sub-agents/$AGENT_ID/integrations/slack \
  -H "Content-Type: application/json" \
  -d '{
    "slackAppToken": "xapp-1-A0123-YOUR_APP_TOKEN",
    "slackBotToken": "xoxb-YOUR_BOT_TOKEN"
  }' | jq .
```

```json
{
  "agentId": "a1b2c3d4-...",
  "agentName": "research-agent",
  "platform": "slack",
  "claimToken": "b7e4d1f2a9c3e8b7e4d1f2a9c3e8b7e4d1f2a9c3e8b7e4d1f2a9c3e8b7e4d1f2",
  "expiresAt": "2026-06-09T12:10:00.000Z",
  "status": "pending_verification"
}
```

### Step 2 — Prove ownership (send the claim token as a DM)

In Slack, open a Direct Message with your bot (search by name) and send the 64-character token:

```
b7e4d1f2a9c3e8b7e4d1f2a9c3e8b7e4d1f2a9c3e8b7e4d1f2a9c3e8b7e4d1f2
```

The bot replies: `✅ Ownership verified for sub-agent "research-agent".`

### Step 3 — Confirm the status

```bash
curl -s http://localhost:3000/v2/sub-agents/$AGENT_ID | jq '.data.integrations'
```

### Detaching

```bash
curl -s -X DELETE http://localhost:3000/v2/sub-agents/$AGENT_ID/integrations/slack | jq .
```

---

## API Reference — v1 (Current)

Base URL: `http://localhost:3000`

These routes are active right now, require no authentication, and are used by the running system.

### Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check. Returns `{ ok: true, channels: N }` |
| `GET` | `/channels` | List active channel states |

### Sub-agent CRUD

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/agents` | — | List all sub-agents |
| `POST` | `/agents` | `{ name, skills?, runtime? }` | Create + provision a sub-agent |
| `GET` | `/agents/:id` | — | Get one sub-agent |
| `DELETE` | `/agents/:id` | — | Stop container/VM, unlink all, delete record |
| `PATCH` | `/agents/:id/skills` | `{ add?: [...], remove?: [...] }` | Update skill list (hot-reload, no restart) |

### Telegram / Slack (v1 — legacy)

These v1 routes exist for backward compatibility with the old shared-pool model. New integrations should use the v2 `integrations/:platform` endpoints.

| Method | Path | Description |
|---|---|---|
| `POST` | `/agents/:id/telegram/token` | Generate a Telegram claim token (10 min TTL) — legacy |
| `DELETE` | `/agents/:id/telegram` | Unlink bot from agent — legacy |
| `POST` | `/agents/:id/slack/token` | Generate a Slack claim token (10 min TTL) — legacy |
| `DELETE` | `/agents/:id/slack` | Unlink workspace from agent — legacy |

### Sessions

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/sessions` | `{ originChannel, originThreadTs, clientEmail?, metadata? }` | Create a session |
| `GET` | `/sessions` | — | List all sessions |
| `GET` | `/sessions/:id` | — | Get one session |
| `PATCH` | `/sessions/:id` | partial Session | Update session metadata |
| `POST` | `/sessions/:id/message` | `{ text, user? }` | Inject message, wait for response |
| `GET` | `/sessions/:id/history` | — | Full conversation log as JSON array |
| `POST` | `/sessions/:id/reset` | — | Clear context and log |
| `POST` | `/sessions/:id/inject-turn` | `{ text, user? }` | Append turn without triggering LLM |
| `POST` | `/sessions/open` | `{ channel, text, workingChannel?, clientEmail? }` | Post + create session in one call |
| `POST` | `/sessions/email-inbound` | `{ from, text, subject? }` | Route email to matching session |

### Events and tasks

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/event` | `{ channelId, text, user? }` | Inject immediate event |
| `POST` | `/escalate` | `{ agent, issue, context?, severity? }` | Sub-agent escalation to Iris |
| `POST` | `/internal/write-event` | `{ name, type, channelId, text, ...type-fields }` | Write event file (immediate/one-shot/periodic/interval) |
| `POST` | `/internal/agent-task` | `{ agentId, channelId, payload, scheduledFor? }` | Create task |
| `PATCH` | `/internal/agent-task/:taskId/status` | `{ status, output? }` | Mark task done/failed/skipped |

---

## API Reference — v2 (Gateway-Ready)

Base URL: `http://localhost:3000/v2`

These routes are active now and serve the existing v1-equivalent functionality regardless of Gateway status. They return a consistent `{ ok, data }` envelope. Authentication is off by default (`GATEWAY_MODE=false`) — all requests pass through, and the bot-ingestion kill-switches and scoping checks described in "Gateway Integration" stay inert. Set `GATEWAY_MODE=true` (plus the relevant secrets/IDs) to progressively activate `Authorization: Bearer <InternalJWT>` enforcement, Runtime JWT validation, Integration-scope checks, one-user-one-VM scoping, and the bot-ingestion kill-switch — see "Gateway Integration" for exactly which env var activates which check.

### Runtime health

| Method | Path | Description |
|---|---|---|
| `GET` | `/v2/health` | Liveness. Returns runtimeId, vmId, uptime, channel count |
| `GET` | `/v2/status` | Full runtime state: channels, all agents, uptime |
| `POST` | `/v2/shutdown` | Graceful shutdown (VM Orchestrator calls this before snapshotting) |

### Main agent

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/v2/main-agent/message` | `{ text, user?, sessionId? }` | Send message to main Iris agent, wait for response |
| `GET` | `/v2/main-agent/history/:threadId` | — | Conversation history for a session or channel |

### Sub-agents

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/v2/sub-agents` | — | List all sub-agents (includes integration status) |
| `POST` | `/v2/sub-agents` | `{ name, skills?, runtime? }` | Create sub-agent, returns Runtime JWT |
| `GET` | `/v2/sub-agents/:id` | — | Get one sub-agent + integration status |
| `DELETE` | `/v2/sub-agents/:id` | — | Delete sub-agent (stops runtime, detaches all bots, removes record) |
| `PATCH` | `/v2/sub-agents/:id/skills` | `{ add?, remove? }` | Update skills (hot-reload, no restart) |
| `POST` | `/v2/sub-agents/:id/message` | `{ text, user?, channelId?, newThread? }` | Send message via bridge; `newThread:true` generates a fresh channelId and creates a session |
| `GET` | `/v2/sub-agents/:id/history` | `?channelId=...` | Conversation history for a channel (required) |
| `GET` | `/v2/sub-agents/:id/sessions` | — | List all sessions (threads) scoped to this agent |
| `POST` | `/v2/sub-agents/:id/skills/define` | `{ name, description, content? }` | Create an agent-private skill (not in global library) |
| `POST` | `/v2/sub-agents/:id/integrations/:platform` | platform=`telegram`: `{ telegramBotToken }`; platform=`slack`: `{ slackAppToken, slackBotToken }` | Attach dedicated bot/app: stores BYO credentials as Key Vault secrets, re-provisions container, issues claim token for ownership verification |
| `DELETE` | `/v2/sub-agents/:id/integrations/:platform` | — | Detach: deletes Key Vault secrets, re-provisions without bot |

### Integration inbound (Gateway → iris-runtime)

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/v2/telegram/inbound` | `{ botId, chatId, text, user?, messageId? }` | Gateway forwards Telegram message here |
| `POST` | `/v2/slack/inbound` | `{ workspaceId, channelId, text, user?, ts? }` | Gateway forwards Slack message here |

### v2 response format

All v2 routes return the same envelope:

```json
{ "ok": true, "data": { ... } }          // success
{ "ok": false, "error": "reason" }       // error
```

---

## Gateway Integration

The v2 layer is not just dormant scaffolding — every gate below is wired end to
end and activates progressively as the operator/Gateway sets the corresponding
env var, with **zero behaviour change while unconfigured** (verified by
round-trip tests against the compiled output: valid tokens accepted, tampered/
mis-scoped/cross-VM tokens rejected, unconfigured deployments untouched). What
remains open is a live round-trip against a real Gateway — see "What's still
open" below.

### How it works

When `GATEWAY_MODE=true`, all `/v2/*` requests require:

```
Authorization: Bearer <InternalJWT>
```

The Internal JWT is issued by the API Gateway and signed with `GATEWAY_JWT_SECRET`. Its payload:

```json
{
  "userId":      "uuid-of-the-user",
  "vmId":        "uuid-of-this-vm",
  "runtimeId":   "uuid-of-this-runtime",
  "agentId":     "uuid-of-target-agent",
  "runtimeType": "HOST_VM" | "DOCKER",
  "scope":       "integration",
  "iat":         1234567890,
  "exp":         1234571490
}
```

`scope` is optional and currently has one meaningful value: `"integration"`,
set by the Gateway when forwarding Telegram/Slack bot traffic (see "Integration
JWT" below). Tokens that omit `scope` are treated as generic Internal JWTs.

Beyond signature/expiry validation, `resolveGatewayAuth()` (in `src/auth.ts`)
also enforces:

- **One-user-one-VM scoping** (`SCOPE_ENFORCED`, `src/auth.ts`) — once both
  `IRIS_VM_ID` and `IRIS_RUNTIME_ID` are set to real (non-`"default"`) UUIDs,
  a *validly-signed* Internal JWT is still rejected (401, logged) if its
  `vmId`/`runtimeId` don't match this runtime's own identity. This is what
  stops a token minted for one user's VM from being replayed against another
  — pure signature checking is not isolation when `GATEWAY_JWT_SECRET` is
  shared across VMs. Stays inert (no check) until both IDs are configured.

### Runtime JWT — Gateway/sub-agent calls

When a sub-agent is created via `POST /v2/sub-agents`, iris-runtime returns a
**Runtime JWT** (`{ agentId, runtimeId, runtimeType, scope: "runtime" }`,
HS256, 5-minute TTL) in the response. The Gateway attaches it as
`Authorization: Bearer <RuntimeJWT>` for subsequent calls to that specific
agent's bridge.

Once `RUNTIME_JWT_SECRET` is set, `RUNTIME_AUTH_ENABLED` flips on and **the
sub-agent bridge server actively rejects** any bridge request without a valid,
correctly-scoped Runtime JWT (`startBridgeServer` in `src/bridge.ts`) — this
is enforcement, not just a courtesy token in the response. Every internal path
that calls into a bridge (`callAgentBridge`, `callBridge`, both v2 inbound
handlers) signs its outgoing request via `runtimeAuthHeader()`. While
`RUNTIME_JWT_SECRET` is unset, bridge calls remain unauthenticated exactly as
before.

### Integration JWT — Telegram/Slack bot traffic

`POST /v2/telegram/inbound` and `/v2/slack/inbound` additionally check
`isIntegrationScoped()` (`src/auth.ts`): when `GATEWAY_MODE=true`, an Internal
JWT that explicitly carries a `scope` other than `"integration"` is rejected
(403, logged) on these two routes — e.g. a token minted for sub-agent
management can't be replayed here to inject fake user messages into someone's
linked-agent conversation. Tokens that omit `scope` still pass, so a Gateway
that doesn't yet mint scoped tokens keeps working unchanged; the Gateway
should mint `scope: "integration"` specifically when relaying bot traffic to
get the extra isolation.

### Routing table (`runtime_mapping`)

iris-runtime now actively populates Supabase's `runtime_mapping` table
(`agentId -> runtimeId -> runtimeType`, per the table's own schema comment
"Written by iris-runtime when agents are provisioned") via
`upsertRuntimeMapping()` in `src/sub-agent-registry.ts`, called on every
`createSubAgent()`. It writes `agent_id`, `vm_id`, `runtime_type`, and
`bridge_url`.

This write is gated on `IRIS_VM_ID` being a real UUID — `vm_id` is a
`NOT NULL` foreign key into `vm_routing`, which is exclusively owned by the VM
Orchestrator, and a standalone deployment (`IRIS_VM_ID="default"`) has no
matching row, so the write would violate the FK. The gate makes it a safe
no-op until the Gateway assigns this runtime a real VM UUID and creates the
matching `vm_routing` row. Cleanup needs no extra code — `runtime_mapping.agent_id`
cascades on `sub_agents` deletion (`ON DELETE CASCADE`).

### Env vars to set when the Gateway deploys

```bash
GATEWAY_MODE=true
GATEWAY_JWT_SECRET=<shared-secret-with-gateway-min-32-chars>
RUNTIME_JWT_SECRET=<secret-for-runtime-jwts-min-32-chars>
IRIS_RUNTIME_ID=<runtime-uuid-injected-by-vm-orchestrator>
IRIS_VM_ID=<vm-uuid-injected-by-vm-orchestrator>
```

Setting `IRIS_RUNTIME_ID`/`IRIS_VM_ID` does double duty: it's both this
runtime's identity (returned from `/v2/health`, used in Runtime JWTs and
`runtime_mapping`) *and* the trigger that activates one-user-one-VM scoping
and the routing-table write once both are real UUIDs.

### Telegram/Slack via Gateway

When `GATEWAY_MODE=true`, **iris-runtime stops running its own Telegram
long-polling bots and Slack Socket Mode sub-agent routing** — `main.ts` skips
the bot-startup loop entirely, and `slack.ts`'s `dispatchEvent` short-circuits
the sub-agent-routing branch (its virtual `BRIDGE-`/`SESSION-` channel handling
for the *main* agent is untouched, since the main agent still needs that
internally). This is a deliberate kill-switch added to prevent duplicate
message processing — **the two ingestion paths are mutually exclusive by
design**, not parallel. The Gateway becomes the sole ingestion path and calls:

```bash
# Telegram message
POST /v2/telegram/inbound
Authorization: Bearer <InternalJWT with scope:"integration">
{ "botId": "123456789", "chatId": "987654321", "text": "Hello", "user": "John" }

# Slack message
POST /v2/slack/inbound
Authorization: Bearer <InternalJWT with scope:"integration">
{ "workspaceId": "T01234567", "channelId": "C01234567", "text": "Hello", "user": "U01234567" }
```

### What's still open

Everything above compiles, builds, and passes round-trip tests against
synthetic tokens shaped to match the documented payloads — but none of it has
been exercised against a *real* Gateway yet (no Gateway repo exists here to
cross-check token shapes against, no integration test). Before flipping
`GATEWAY_MODE=true` in production, do one real round-trip on staging: mint an
actual Internal JWT, an actual `scope: "integration"` token, and create a real
`vm_routing` row, and confirm the Gateway and runtime agree on every field
name and value.

`claim_tokens` and `sessions` are now actively written by iris-runtime (the
dedicated-bot attach/verify flow and the `newThread` v2 message path
respectively). `users` remains read-only with no actual read path wired — still
a placeholder for Gateway-issued userId resolution.

### Azure Blob Storage (optional write-through)

Enable to mirror all state (memory files, thread history, sessions) to Azure Blob Storage. This is required for the multi-tenant future where VMs are ephemeral.

```bash
BLOB_ENABLED=true
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
BLOB_CONTAINER=iris-runtime   # default, change if needed
```

Blob layout:

```
iris-runtime/
├── agents/{agentId}/memory/MEMORY.md
├── agents/{agentId}/threads/{channelId}/log.jsonl
├── agents/{agentId}/threads/{channelId}/context.jsonl
├── agents/{agentId}/skills/{skillName}.md
├── agents/{agentId}/logs/{date}.log
├── agents/{agentId}/snapshots/{timestamp}.tar.gz
├── sessions/{sessionId}.json
├── memory/global/MEMORY.md
└── memory/channels/{channelId}/MEMORY.md
```

When `BLOB_ENABLED=false` (the default), all Blob writes are no-ops and local files remain the source of truth.

---

## Environment Variables

Complete reference for `/iris/.env`. Variables marked **required** must be set for the service to work correctly.

### LLM provider

| Variable | Required | Default | Description |
|---|---|---|---|
| `IRIS_PROVIDER` | Yes | `anthropic` | LLM provider: `anthropic`, `openai`, or any OpenAI-compatible |
| `IRIS_MODEL` | Yes | `claude-sonnet-4-5` | Model ID |
| `ANTHROPIC_API_KEY` | If provider=anthropic | — | Anthropic API key |
| `OPENAI_API_KEY` | If provider=openai | — | OpenAI API key |
| `OPENAI_BASE_URL` | No | — | Override for OpenAI-compatible providers |

### Supabase

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | `service_role` key from Project Settings → API |

### Slack / Telegram (dedicated-bot model — new setups)

Main Iris has no Slack or Telegram bots. Do not set these for new setups. Sub-agent bot credentials are attached via `POST /v2/sub-agents/:id/integrations/:platform` and stored in Key Vault — they never live in `.env`.

### Slack / Telegram (legacy shared-pool — migration only)

| Variable | Required | Description |
|---|---|---|
| `LEGACY_SHARED_BOT_MODE` | No | Set `1` to start old shared-pool bots on Main Iris during Phase 8 migration window |
| `IRIS_SLACK_APP_TOKEN` | If `LEGACY_SHARED_BOT_MODE=1` | Old shared-pool App-Level Token (`xapp-`) |
| `IRIS_SLACK_BOT_TOKEN` | If `LEGACY_SHARED_BOT_MODE=1` | Old shared-pool Bot Token (`xoxb-`) |
| `TELEGRAM_BOT_TOKEN` | If `LEGACY_SHARED_BOT_MODE=1` | First legacy bot token |
| `TELEGRAM_BOT_TOKEN_2`–`_5` | No | Additional legacy bot tokens (up to 4 more) |

Remove `LEGACY_SHARED_BOT_MODE` and all legacy bot tokens once all agents have self-migrated to the dedicated-bot flow.

### BotFactory — automated Telegram bot creation (optional)

Enables the `autoCreate: true` path in `POST /v2/sub-agents/:id/integrations/telegram`.
When absent, the endpoint still works — users paste their own bot token instead.

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_API_ID` | For auto-create | Integer API ID from https://my.telegram.org/apps |
| `TELEGRAM_API_HASH` | For auto-create | API hash string from https://my.telegram.org/apps |
| `TELEGRAM_SESSION` | For auto-create | GramJS StringSession for the service account (generated once via `scripts/gen-tg-session.ts`, stored in Key Vault) |

The service account is a dedicated Telegram user account (one phone number, set up once). BotFactory creates bots under this account and queues all creations serially to respect BotFather rate limits.

### Sub-agent injected variables (set by iris-runtime — do not set manually)

| Variable | Description |
|---|---|
| `IS_SUB_AGENT` | Set by provisionAgent to `1` inside sub-agent containers |
| `AGENT_ID` | The sub-agent's UUID — used to branch bot construction and self-identify |
| `AGENT_NAME` | Human-readable name — used in bot greeting messages |

### Runtime

| Variable | Required | Default | Description |
|---|---|---|---|
| `IRIS_API_PORT` | No | `3000` | Port the internal API listens on |
| `IRIS_API_URL` | No | `http://127.0.0.1:3000` | URL sub-agents use to reach the API |
| `IRIS_ENV` | No | `prod` | `prod` or `preview` — affects error reporting |
| `IRIS_DIR` | No | `/iris` | Root directory for data, skills, agents |
| `IRIS_SKILLS_DIR` | No | `$IRIS_DIR/data/skills` | Override the skills directory |
| `IRIS_BRIDGE_PORT` | No | `0` (disabled) | Set > 0 on sub-agents to enable bridge mode |

### Gateway integration (leave unset until Gateway is deployed)

| Variable | Required | Default | Description |
|---|---|---|---|
| `GATEWAY_MODE` | No | `false` | Set `true` to enforce JWT on all `/v2/*` routes |
| `GATEWAY_JWT_SECRET` | If GATEWAY_MODE=true | — | Shared secret for validating Internal JWTs |
| `RUNTIME_JWT_SECRET` | If GATEWAY_MODE=true | — | Secret for signing Runtime JWTs |
| `IRIS_RUNTIME_ID` | No | `default` | This runtime's UUID (injected by Orchestrator) |
| `IRIS_VM_ID` | No | `default` | This VM's UUID (injected by Orchestrator) |

### Azure Blob Storage (leave unset to use local files)

| Variable | Required | Default | Description |
|---|---|---|---|
| `BLOB_ENABLED` | No | `false` | Enable Blob write-through |
| `AZURE_STORAGE_CONNECTION_STRING` | If BLOB_ENABLED=true | — | Azure Storage connection string |
| `BLOB_CONTAINER` | No | `iris-runtime` | Blob container name |

### Optional integrations

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub Personal Access Token — used by skills that interact with GitHub |
| `RESEND_API_KEY` | Resend.com API key — used by the email skill |
| `IRIS_KEY_VAULT` | Azure Key Vault name — used when secrets are stored in Key Vault |

---

## Runtime Source Layout

```
iris-runtime/src/
├── main.ts                  Entry point: starts transports, API, watchdog, scheduler
├── agent.ts                 AgentRunner: LLM calls, tool dispatch, context management
├── api.ts                   Internal HTTP API on :3000 (v1 routes)
├── auth.ts                  JWT utilities for Gateway integration (v2)
├── blob.ts                  Azure Blob write-through (off by default)
├── bridge.ts                Bridge HTTP server (sub-agents) + callAgentBridge() (main Iris)
├── slack.ts                 Slack Socket Mode transport
├── slack-link.ts            SlackLinkManager: claim tokens, workspace↔agent cache
├── telegram.ts              Telegram long-poll transport (gateway to sub-agent bridges)
├── telegram-link.ts         TelegramLinkManager: claim tokens, bot↔agent cache + Supabase
├── sub-agent-registry.ts    Sub-agent CRUD in Supabase (sub_agents table)
├── agent-provision.ts       Docker + Firecracker provisioners
├── agent-watchdog.ts        30 s poll: crash/recovery detection, missed-task notification
├── scheduler.ts             croner-based task scheduler + missed-task recovery
├── task-queue.ts            agent_tasks CRUD (immediate + scheduled)
├── sessions.ts              Session registry
├── store.ts                 ChannelStore: per-channel conversation history
├── events.ts                EventsWatcher: file-based event dispatch
├── sandbox.ts               HostExecutor, DockerExecutor, FirecrackerExecutor, pool
├── vm-manager.ts            On-demand Firecracker pool for Iris's own bash sandbox
├── db.ts                    Supabase client singleton
├── log.ts                   Centralised logging with timestamps and context
├── managers/
│   ├── session.ts           SessionManager: wraps sessions.ts + Blob write-through
│   ├── memory.ts            MemoryManager: reads/writes MEMORY.md + Blob write-through
│   ├── skill.ts             SkillManager: wraps skill provisioning utilities
│   ├── thread.ts            ThreadManager: channel history + Blob fallback
│   └── integration.ts       IntegrationManager: unified Telegram + Slack lifecycle
└── routes/
    ├── v2-types.ts          Shared types for v2 route handlers
    ├── v2-router.ts         Dispatcher: routes /v2/* → correct handler
    ├── v2-health.ts         GET /v2/health, /v2/status, POST /v2/shutdown
    ├── v2-main-agent.ts     POST /v2/main-agent/message, GET /v2/main-agent/history
    ├── v2-sub-agents.ts     Full sub-agent CRUD + message + integration tokens
    ├── v2-telegram.ts       POST /v2/telegram/inbound
    └── v2-slack.ts          POST /v2/slack/inbound
```

---

## Managing the Service

```bash
sudo systemctl start iris      # start
sudo systemctl stop iris       # stop
sudo systemctl restart iris    # restart
sudo systemctl status iris     # check status
sudo journalctl -u iris -f     # live logs
sudo journalctl -u iris -n 50  # last 50 lines
```

> If `start` silently does nothing, the compiled JS is missing. Run:
> ```bash
> cd /iris/repo/iris-runtime && npm install && npm run build
> sudo systemctl start iris
> ```

### Rebuild the Docker image (after code changes)

```bash
cd /iris/repo/iris-runtime
npm run build
docker build -t iris-runtime:local .
```

Restart crashed sub-agent containers:

```bash
docker ps -a --filter name=iris-agent --format '{{.Names}}'
docker restart <container-name>
```

### Rebuild Firecracker rootfs (after code changes)

```bash
sudo bash /iris/repo/scripts/build-firecracker-rootfs.sh
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `iris.service` fails to start | Missing required env vars | `journalctl -u iris` then check `/iris/.env` |
| No Slack/Telegram startup log on Main Iris | Expected — Main Iris has no bots | Bots start inside sub-agent containers after `POST /v2/sub-agents/:id/integrations/:platform` |
| Sub-agent bot ignores all messages after attach | Ownership not verified yet | Send the 64-char claim token (from the attach response) as a plain message to the bot |
| Claim token rejected with "expired" | Token is >10 min old | Re-run `POST /v2/sub-agents/:id/integrations/:platform` — issues a fresh token |
| Bot responds but says "unverified" | `telegram_status` stuck at `pending_verification` | Check that the bot is actually running (`docker logs iris-agent-<id>`) and that the claim token was sent correctly |
| `POST /v2/sub-agents/:id/integrations/:platform` returns 409 | Agent already has credentials attached | `DELETE /v2/sub-agents/:id/integrations/:platform` first, then re-attach |
| `LEGACY_SHARED_BOT_MODE` bots not starting | Missing token vars | Set `IRIS_SLACK_APP_TOKEN` / `IRIS_SLACK_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` alongside `LEGACY_SHARED_BOT_MODE=1` |
| `POST /agents` returns 409 | Agent name taken or no slots free | Use a different name, or `DELETE` an existing agent to free a slot |
| Sub-agent container not starting | `iris-runtime:local` image missing | Rebuild: `cd iris-runtime && npm run build && docker build -t iris-runtime:local .` |
| Firecracker VM not booting | `/dev/kvm` unavailable | Resize VM to Ddsv5 series on Azure (B/D/F series have no KVM) |
| `firecracker: permission denied` | User not in `kvm` group | `sudo usermod -aG kvm $USER` then log out and back in |
| Supabase errors on startup | Missing or wrong credentials | Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `/iris/.env` |
| `claim_tokens` insert fails | Missing dedicated-bot columns on `sub_agents` | Run the migration ALTER TABLE block from Step 1c in the Supabase SQL Editor |
| Task creation fails with FK error | Old schema — `agent_tasks` still has FK to `telegram_agents` | Run the old migration cleanup block in Supabase SQL Editor, then re-run the full schema |
| `GET /v2/health` returns 401 | `GATEWAY_MODE=true` but no JWT sent | Either set `GATEWAY_MODE=false` or send `Authorization: Bearer <JWT>` |
| v2 routes return 404 for unknown paths | URL typo | Check the [v2 API reference](#api-reference--v2-gateway-ready) |
| `BLOB_ENABLED=true` but writes fail | Wrong connection string | Verify `AZURE_STORAGE_CONNECTION_STRING` is the full connection string, not just the account name |

---

## Operational Notes

**Skills hot-reload** — Drop a skill directory into `/iris/data/skills/` on the host. All running sub-agent containers see it immediately (volume-mounted read-only). Then call `PATCH /agents/:id/skills` to register it with the agent. No container restart needed. Sub-agents can self-acquire global skills at runtime via `POST /internal/skills/acquire` (requires `x-agent-id` header; idempotent).

**Agent-private skills** — Use `POST /v2/sub-agents/:id/skills/define` to create a skill that lives only in that agent's workspace and is not shared with other agents.

**Agent naming** — Docker containers are named `iris-agent-{agentId}`. Firecracker VMs are `iris-fc-{agentId}`. Bridge ports: Docker uses `127.0.0.1:420{1..250}` (slot 1 = port 4201). Firecracker uses `172.20.{slot}.2:4200`. No artificial cap — up to 250 slots (Firecracker IPv4-octet limit; slots are recycled on delete).

**Watchdog** — Checks Docker via `docker inspect`, Firecracker via exec-server `/health` every 30 seconds. On crash, delivers a missed-task notification to the affected sub-agent via its bridge `/notify` endpoint (direct if Main Iris IS the agent, or HTTP relay if it is a different sub-agent). On recovery, marks missed scheduled tasks as `skipped`.

**Dedicated-bot credentials are durable** — Bot tokens are stored as Azure Key Vault secrets referenced from `sub_agents.*_token_ref` columns. Pending claim tokens live in Supabase `claim_tokens` (expire after 10 min). Active `telegram_status` / `slack_status` survive reboots; `dedicatedVerified` is re-confirmed at startup via `/internal/integrations/:agentId/status`.

**Multi-thread conversations** — `POST /v2/sub-agents/:id/message` with `newThread:true` generates a random `channelId`, creates a scoped session, and returns both in the response. Pass the returned `channelId` on subsequent calls to continue that thread. Omit `channelId` to use the legacy single-channel fallback.

**Agent creation is blocked at three levels** — (1) `spawn-agent` skill filtered out of AgentRunner for all `BRIDGE-*`, `tg-*`, and `SESSION-*` channels; (2) `spawn-agent` skill directory not accessible inside sub-agent containers; (3) `MEMORY.md` constitution explicitly forbids it. No user message can override any of these.

**v2 routes are dormant by default** — `GATEWAY_MODE=false` means all `/v2/*` requests are allowed without any JWT. No behaviour change until you explicitly set `GATEWAY_MODE=true`.

**This VM is disposable** — GitHub is the source of truth. A full rebuild from this README produces an identical running system. The bootstrap VM is intentionally outside Terraform state to prevent self-destruction.

**Never commit secrets** — `/iris/.env`, `data/models.json` (if it contains API keys), and any credential files are in `.gitignore`. Keep them there. Sub-agent bot tokens are stored in Key Vault — they never touch the filesystem.

---

## Source Documents

Read these before making changes:

- [CLAUDE.md](CLAUDE.md) — code conventions and rules
- [CONSTITUTION.md](CONSTITUTION.md) — operator rules injected into every agent prompt
- [MEMORY.md](MEMORY.md) — Iris's current global memory
- [supabase/schema.sql](supabase/schema.sql) — canonical database schema (source of truth)
