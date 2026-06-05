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
-- and sub_agent_telegram_links. Drop them only after all running instances have
-- been updated to the new schema.
--
-- DROP TABLE IF EXISTS agent_tasks;          -- re-created above with new FK
-- DROP TABLE IF EXISTS telegram_agents;
-- DROP TABLE IF EXISTS telegram_claim;
-- DROP TYPE  IF EXISTS agent_status;         -- re-created above
