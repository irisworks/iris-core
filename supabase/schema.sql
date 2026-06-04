-- ============================================================================
-- Iris Supabase Schema
-- Run this in the Supabase SQL editor for your project.
-- ============================================================================

-- ── Phase 1: Telegram claim / ownership ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS telegram_claim (
    bot_id                  TEXT        PRIMARY KEY,
    claimed                 BOOLEAN     NOT NULL DEFAULT false,
    chat_id                 BIGINT,
    pending_token           TEXT,
    token_expires_at        TIMESTAMPTZ,
    pending_transfer_chat_id BIGINT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Disable row-level security — this table is only accessed via the service role key
ALTER TABLE telegram_claim DISABLE ROW LEVEL SECURITY;

-- ── Phase 2: Agent registry ───────────────────────────────────────────────────

CREATE TYPE agent_status AS ENUM ('running', 'stopped', 'crashed');

CREATE TABLE IF NOT EXISTS telegram_agents (
    agent_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id                  TEXT        NOT NULL REFERENCES telegram_claim(bot_id) ON DELETE CASCADE,
    chat_id                 BIGINT      NOT NULL,
    name                    TEXT        NOT NULL,
    docker_container_id     TEXT,
    status                  agent_status NOT NULL DEFAULT 'stopped',
    skills                  JSONB       NOT NULL DEFAULT '[]',
    slot_index              SMALLINT    NOT NULL CHECK (slot_index BETWEEN 1 AND 5),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (bot_id, name),
    UNIQUE (bot_id, slot_index)
);

ALTER TABLE telegram_agents DISABLE ROW LEVEL SECURITY;

-- ── Phase 4: Per-agent task queue ─────────────────────────────────────────────

CREATE TYPE task_type   AS ENUM ('immediate', 'scheduled');
CREATE TYPE task_status AS ENUM ('pending', 'running', 'done', 'failed', 'skipped');

CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id        UUID        NOT NULL REFERENCES telegram_agents(agent_id) ON DELETE CASCADE,
    bot_id          TEXT        NOT NULL,
    channel_id      TEXT        NOT NULL,   -- tg-{chatId} — where the response is delivered
    type            task_type   NOT NULL DEFAULT 'immediate',
    payload         TEXT        NOT NULL,   -- the task instruction / message
    scheduled_for   TIMESTAMPTZ,            -- null for immediate tasks
    timezone        TEXT,                   -- IANA tz or offset string, e.g. "Asia/Kolkata"
    local_time_str  TEXT,                   -- user's original expression, e.g. "at 3pm"
    status          task_status NOT NULL DEFAULT 'pending',
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    output          TEXT,                   -- truncated agent response for status display
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_tasks_agent_idx   ON agent_tasks(agent_id, status);
CREATE INDEX agent_tasks_schedule_idx ON agent_tasks(scheduled_for) WHERE status = 'pending';

ALTER TABLE agent_tasks DISABLE ROW LEVEL SECURITY;
