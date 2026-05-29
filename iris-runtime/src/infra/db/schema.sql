-- ============================================================================
-- Iris Production Schema
-- PostgreSQL 15+
-- ============================================================================

-- Enforce UTC timestamps everywhere
SET timezone = 'UTC';

-- ============================================================================
-- Sessions
-- One row per conversation thread (Slack thread, email chain, API session).
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ NOT NULL    DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL    DEFAULT NOW(),

    -- Slack origin
    origin_channel  VARCHAR(255) NOT NULL,
    origin_thread   VARCHAR(64)  NOT NULL,

    -- Optional separate working channel (different from origin)
    working_channel VARCHAR(255),
    working_thread  VARCHAR(64),

    -- Inbound email routing key
    client_email    VARCHAR(320),

    -- Arbitrary workspace-defined metadata (trip ID, ticket number, etc.)
    metadata        JSONB        NOT NULL DEFAULT '{}',

    -- Lifecycle state
    status          VARCHAR(32)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived', 'deleted')),

    UNIQUE (origin_channel, origin_thread)
);

-- Hot-path lookup: find session by working channel+thread
CREATE INDEX IF NOT EXISTS idx_sessions_working
    ON sessions (working_channel, working_thread)
    WHERE working_channel IS NOT NULL;

-- Email routing lookup
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_email
    ON sessions (client_email)
    WHERE client_email IS NOT NULL;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE OR REPLACE TRIGGER sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ============================================================================
-- Messages
-- Append-only log of every user message and bot response.
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
    id          BIGSERIAL   PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Slack identifiers
    channel_id  VARCHAR(255) NOT NULL,
    slack_ts    VARCHAR(64)  NOT NULL,

    -- Optional session link (null for channel-chatter not in a session)
    session_id  UUID REFERENCES sessions(id) ON DELETE SET NULL,

    -- Author
    user_id     VARCHAR(255) NOT NULL,
    user_name   VARCHAR(255),
    display_name VARCHAR(255),

    text        TEXT        NOT NULL DEFAULT '',
    is_bot      BOOLEAN     NOT NULL DEFAULT FALSE,
    attachments JSONB       NOT NULL DEFAULT '[]',

    -- Dedup: each Slack ts is globally unique per channel
    UNIQUE (channel_id, slack_ts)
);

CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages (session_id, created_at DESC)
    WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_channel_time
    ON messages (channel_id, created_at DESC);

-- ============================================================================
-- Channel Configuration
-- Cached view of data/channels.json in the DB for multi-instance consistency.
-- ============================================================================

CREATE TABLE IF NOT EXISTS channel_config (
    channel_id          VARCHAR(255) PRIMARY KEY,
    mode                VARCHAR(32)  NOT NULL DEFAULT 'dm'
                        CHECK (mode IN ('dm','admin','thread','interactive-thread','passthrough','leads')),
    passthrough_url     TEXT,
    require_mention     BOOLEAN      NOT NULL DEFAULT FALSE,
    allowed_instances   TEXT[],     -- NULL = all instances respond
    metadata            JSONB        NOT NULL DEFAULT '{}',
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Usage Logs
-- Token + cost accounting per agent run. Append-only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_logs (
    id                  BIGSERIAL   PRIMARY KEY,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    session_id          UUID        REFERENCES sessions(id) ON DELETE SET NULL,
    channel_id          VARCHAR(255) NOT NULL,
    worker_id           VARCHAR(128),
    model               VARCHAR(128) NOT NULL,

    input_tokens        INTEGER     NOT NULL DEFAULT 0,
    output_tokens       INTEGER     NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER     NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER     NOT NULL DEFAULT 0,
    cost_usd            NUMERIC(12, 8) NOT NULL DEFAULT 0,

    -- Optional: link to the message that triggered the run
    trigger_slack_ts    VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_usage_channel_time
    ON usage_logs (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_session
    ON usage_logs (session_id)
    WHERE session_id IS NOT NULL;

-- ============================================================================
-- Scheduled Events
-- Persistent store for immediate/one-shot/periodic events.
-- Replaces the file-system events/ directory for multi-instance setups.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduled_events (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- The filename key from the existing file-based system (for migration)
    filename    VARCHAR(255) UNIQUE,

    event_type  VARCHAR(32)  NOT NULL
                CHECK (event_type IN ('immediate', 'one-shot', 'periodic')),

    channel_id  VARCHAR(255) NOT NULL,
    text        TEXT         NOT NULL,

    -- For one-shot: exact fire time
    trigger_at  TIMESTAMPTZ,

    -- For periodic: cron schedule + timezone
    schedule    VARCHAR(128),
    timezone    VARCHAR(64),

    status      VARCHAR(32)  NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'fired', 'cancelled')),
    fired_at    TIMESTAMPTZ,
    last_fired  TIMESTAMPTZ  -- for periodic: when it last ran
);

CREATE INDEX IF NOT EXISTS idx_events_pending
    ON scheduled_events (trigger_at)
    WHERE status = 'pending' AND event_type = 'one-shot';

-- ============================================================================
-- Rate Limit Buckets
-- Soft rate-limit enforcement backed by DB (Redis is the primary path;
-- this serves as audit / overflow when Redis is unavailable).
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    key         VARCHAR(512) PRIMARY KEY,  -- e.g. "user:U123:channel:C456"
    count       INTEGER      NOT NULL DEFAULT 0,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Views
-- ============================================================================

-- Session summary for API responses
CREATE OR REPLACE VIEW v_session_summary AS
SELECT
    s.id,
    s.created_at,
    s.updated_at,
    s.origin_channel,
    s.origin_thread,
    s.working_channel,
    s.working_thread,
    s.client_email,
    s.metadata,
    s.status,
    COUNT(m.id) FILTER (WHERE NOT m.is_bot)  AS user_message_count,
    COUNT(m.id) FILTER (WHERE m.is_bot)      AS bot_message_count,
    MAX(m.created_at)                         AS last_message_at,
    COALESCE(SUM(u.cost_usd), 0)             AS total_cost_usd
FROM sessions s
LEFT JOIN messages m  ON m.session_id = s.id
LEFT JOIN usage_logs u ON u.session_id = s.id
GROUP BY s.id;
