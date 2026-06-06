-- ============================================================================
-- Iris Supabase Schema
-- Run this in the Supabase SQL editor for your project.
-- ============================================================================

-- ── Sub-agent registry (platform-agnostic) ───────────────────────────────────
-- Sub-agents are independent of any messaging platform.
-- Telegram, Slack, or any other interface can be linked to them separately.

CREATE TYPE agent_status AS ENUM ('running', 'stopped', 'crashed');

CREATE TABLE IF NOT EXISTS sub_agents (
    agent_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT        NOT NULL,
    runtime                 TEXT        NOT NULL DEFAULT 'docker'
                                        CHECK (runtime IN ('docker', 'firecracker')),
    docker_container_id     TEXT,
    status                  agent_status NOT NULL DEFAULT 'stopped',
    skills                  JSONB       NOT NULL DEFAULT '[]',
    slot_index              SMALLINT    NOT NULL CHECK (slot_index BETWEEN 1 AND 10),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (name),
    UNIQUE (slot_index)
);

ALTER TABLE sub_agents DISABLE ROW LEVEL SECURITY;

-- ── Telegram bot ↔ Sub-agent links ───────────────────────────────────────────
-- One-to-one: one Telegram bot can link to exactly one sub-agent, and vice versa.
-- Claim tokens are used to establish the link (generated on demand, single-use).
-- Links are stored here; pending tokens live in local file storage (see telegram-link.ts).

CREATE TABLE IF NOT EXISTS sub_agent_telegram_links (
    bot_id          TEXT        PRIMARY KEY,                   -- Telegram bot numeric ID as text
    agent_id        UUID        UNIQUE REFERENCES sub_agents(agent_id) ON DELETE SET NULL,
    linked_at       TIMESTAMPTZ,                               -- null = bot registered but not yet linked
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE sub_agent_telegram_links DISABLE ROW LEVEL SECURITY;

-- ── Per-agent task queue ──────────────────────────────────────────────────────

CREATE TYPE task_type   AS ENUM ('immediate', 'scheduled');
CREATE TYPE task_status AS ENUM ('pending', 'running', 'done', 'failed', 'skipped');

CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID        NOT NULL REFERENCES sub_agents(agent_id) ON DELETE CASCADE,
    bot_id          TEXT        NOT NULL,                      -- which Telegram bot owns the delivery channel
    channel_id      TEXT        NOT NULL,                      -- tg-{chatId} — response delivery channel
    type            task_type   NOT NULL DEFAULT 'immediate',
    payload         TEXT        NOT NULL,
    scheduled_for   TIMESTAMPTZ,
    timezone        TEXT,
    local_time_str  TEXT,
    status          task_status NOT NULL DEFAULT 'pending',
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    output          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_tasks_agent_idx    ON agent_tasks(agent_id, status);
CREATE INDEX agent_tasks_schedule_idx ON agent_tasks(scheduled_for) WHERE status = 'pending';

ALTER TABLE agent_tasks DISABLE ROW LEVEL SECURITY;

-- ── Migration notes ───────────────────────────────────────────────────────────
-- Legacy tables (telegram_claim, telegram_agents) are superseded by sub_agents
-- and sub_agent_telegram_links.
--
-- If this schema was applied on a DB that already had agent_tasks pointing to
-- telegram_agents (old FK), the CREATE TABLE IF NOT EXISTS above will NOT have
-- recreated agent_tasks. Run the block below in the Supabase SQL editor to
-- complete the migration. The runtime code includes a compatibility shim
-- (sub-agent-registry.ts: upsertCompatRow) that keeps telegram_agents in sync
-- until this migration has been executed.
--
-- !! Run in Supabase SQL Editor to complete the migration !!
--
-- DROP TABLE IF EXISTS agent_tasks CASCADE;
-- DROP TABLE IF EXISTS telegram_agents CASCADE;
-- DROP TABLE IF EXISTS telegram_claim CASCADE;
-- DROP TYPE  IF EXISTS agent_status CASCADE;   -- re-created above
--
-- Then re-run the full schema.sql (all CREATE TABLE statements are idempotent
-- for the remaining new tables).
--
-- After running the migration, remove the upsertCompatRow / deleteCompatRow
-- shim from src/sub-agent-registry.ts.
