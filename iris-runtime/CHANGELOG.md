# Changelog

## [Unreleased]

### Changed

- License changed from MIT to Apache License 2.0 (`LICENSE`, new `NOTICE` file, `package.json` license field, README/CONTRIBUTING mentions) (IRIS-109).

- Internal: shared transport types moved to `src/transport/types.ts` — `ChannelInfo`, `UserInfo`, and `MessageContext` (rename of `SlackContext`, which stays as a compat re-export alongside `TelegramContext`). Contexts now carry a `transportId` (`"slack" | "telegram" | "bridge"`), and a `TransportPromptProfile` registry is in place for the upcoming prompt de-Slacking. The engine (`agent.ts`) no longer imports transport modules. No behavior change.
- Internal: main.ts is now pure wiring — transports constructed from env (Slack if tokens, Telegram if token, Bridge always), then API/bridge/events hookup. The events watcher and the internal API route by `transport.ownsChannel(channelId)` instead of inline `tg-*` checks. One behavior fix from the routing: API endpoints that post to a channel (e.g. `POST /sessions/open`) now reach the transport that owns the channel — a `tg-*` channel goes to Telegram even when Slack is connected (previously it was always sent to the preferred bot and failed). Session endpoints keep the old preference order (Slack, then Telegram, then Bridge).
- Internal: `ChannelTransport` interface finalized in `transport/types.ts` (start/stop, ownsChannel, getChannels/getUsers, postMessage/updateMessage, enqueueEvent, createContext, promptProfile). `SlackBot` and `TelegramBot` implement it; the context factories moved verbatim from main.ts into slack.ts/telegram.ts; the bridge-only stub bot is replaced by a real `BridgeTransport` (`transport/bridge.ts`). Adding a transport requires zero engine edits. No behavior change.
- Internal: the near-identical Slack and Telegram run/stop/compact/reset handlers in main.ts are unified into one engine (`src/engine.ts`, `createEngine`) owning the per-channel state map and run dispatch; the transport handlers are now thin adapters. One user-visible convergence: on Telegram, `/stop` now edits the "_Stopping..._" status message to "_Stopped_" (matching Slack) instead of posting a second message.
- The system prompt is now composed from the transport's `TransportPromptProfile` (identity line, formatting rules, channel/user directory, `[SILENT]`/attach notes, attachment tag name, message-split limit) instead of hardcoded Slack text. Slack prompts are byte-identical to before; bridge-only runs keep the Slack fragments. The `"Slack API error (…)"` log line is now `"Transport API error (…)"` — update any log grep that matched on it.

### Fixed

- Telegram channels now receive Telegram-specific system-prompt guidance — `**bold**`/`_italic_`/backtick code per the HTML converter, chat directory, plain-URL advice — instead of Slack mrkdwn rules that rendered as literal asterisks and broken `<url|text>` links. Non-image attachments are wrapped in `<telegram_attachments>` rather than `<slack_attachments>`.

- Slack channel-mode consistency pass:
  - `passthrough` channels now forward **every** message shape. Top-level channel messages without an `@iris` mention were silently dropped, and DMs on a passthrough-configured channel ID ran the LLM — both contradicting "forwarded to the endpoint, LLM never runs". Top-level forwarding honours `requireMentionForTopLevel`.
  - `@iris stop` / `compact` / `reset` in a passthrough channel are forwarded verbatim instead of being swallowed by the admin-command filter.
  - Wildcard entries in `channels.json` (e.g. `"D*"`) now resolve *all* settings — passthrough `url`/`payload`/`secretName`, `requireMentionForTopLevel`, and the leads missed-message replay — not just the mode. When multiple wildcards match, the longest prefix wins (previously whichever came first in the file).
  - `interactive-thread`: a top-level human message without a mention now opens a session unless `requireMentionForTopLevel` is set. The flag was previously unreachable dead code, so every interactive-thread channel behaved as mention-gated regardless of configuration.
  - Interrupted-run resume at startup no longer re-dispatches LLM runs in `thread` / `interactive-thread` / `passthrough` channels. Their channel logs never contain in-channel bot replies, so every conversation looked "interrupted" and each restart started a spurious top-level LLM run there.
  - Scheduled events targeting a `passthrough` channel are refused with a warning instead of running the LLM into the relay channel.
  - Leads dispatch is bounded to the same 5-message queue as every other dispatch path (overflow logs a warning; the message text remains in `log.jsonl`).
  - Slack envelopes are now acked exactly once on every handler exit, including handler errors — an exception mid-handler previously left the envelope unacked, so Slack redelivered it and the failure repeated.
  - `channels.json` entries with an unknown `mode` are skipped with a warning instead of half-applying (`requireMentionForTopLevel` used to take effect even when the mode string was invalid).
- Fixed workspace-root resolution for real Telegram and Slack channels by threading `workingDir` through runner creation and path helpers. This restores correct loading of custom model providers, memory, and skills for real conversation channels ([#34](https://github.com/irisworks/iris-core/pull/34) by @avinashsingh-ai)
- Bootstrap now sanitizes the Azure AI Foundry account name (full URLs or hostnames pasted from the portal are trimmed to the bare account name) and validates the generated endpoint URL — aborting on a malformed hostname and warning when it doesn't resolve in DNS. Previously a pasted hostname produced an unresolvable `…cognitiveservices.cognitiveservices…` endpoint and every LLM call failed with a generic connection error ([#35](https://github.com/irisworks/iris-core/pull/35) by @avinashsingh-ai)
- Telegram claim state is now scoped to the bot's identity (the `getMe()` id). Swapping `TELEGRAM_BOT_TOKEN` for a different bot automatically clears the stale claim and issues a fresh claim token, instead of reporting "already claimed from a previous run" and requiring `IRIS_TELEGRAM_FORCE_RECLAIM` or a manual state-file delete. Corrupt claim-state files and failed state writes now log warnings instead of being silently swallowed or throwing ([#36](https://github.com/irisworks/iris-core/pull/36) by @avinashsingh-ai)

### UPGRADING

- Telegram installs: the system prompt for Telegram channels changed (Telegram formatting/directory guidance, `<telegram_attachments>` tag). No configuration changes required, but the bot's message formatting on Telegram will improve/change mid-conversation after upgrade.
- `interactive-thread` channels that relied on top-level non-mention messages being ignored (the previous, unintended behaviour) must now set `"requireMentionForTopLevel": true` in `data/channels.json`.
- If overlapping wildcard patterns exist in `channels.json` (e.g. `"D*"` and `"DA*"`), the longest matching prefix now wins regardless of file order — review any installs that depended on entry order.

## [0.90.0] - 2026-07-03

Consolidation baseline: generic features upstreamed from install forks, plus repo
hygiene and security hardening for public launch. Last release on the flat `src/`
layout before the transport-interface refactor.

### Added

- LLM retry with exponential backoff on 429/timeout/transient errors — up to `IRIS_LLM_MAX_RETRIES` (default 3) attempts, jittered backoff via `IRIS_LLM_RETRY_BASE_MS` (default 2s), visible `_Retrying (n/3)..._` notices (#26, ported from 30signals/iris-core `ebe7f25`; fixes #13)
- Pre-run auto-compaction: estimated context above `IRIS_COMPACT_THRESHOLD` (default 0.6 of the model window) compacts toward `IRIS_COMPACT_TARGET` (default 0.1) before prompting, up to 3 passes; the post-run ≥70% check remains as backstop (#28)
- Configurable passthrough mode in `data/channels.json`: `payload` JSON template with `{{placeholders}}`, `secretName` resolved via the get-secret skill, `replyPrefix`; session routes for interactive-thread channels rebuilt from `sessions.json` on startup (#29)
- CI workflow (build + bridge-only smoke test) and `docs/RELEASING.md` (#23)

### Fixed

- Thinking blocks truncated at 2,900 chars and posted only to threads; safe Slack message limit lowered 40,000 → 30,000, overridable via `IRIS_SLACK_MAX_CHARS` (#27, ported from 30signals/iris-core `4f96613`)
- Per-attempt LLM timeout default lowered 300s → 90s (`IRIS_LLM_TIMEOUT_SECS`) — with retries, shorter attempts recover faster from hung calls (#26)

### Security

- Internal API (`api.ts`) and bridge server (`bridge.ts`) now bind `127.0.0.1` by default instead of `0.0.0.0`. Override with `IRIS_API_HOST` / `IRIS_BRIDGE_HOST` (#24)
- New optional `IRIS_API_TOKEN`: when set, all internal API endpoints except `GET /health` require `Authorization: Bearer <token>`. The runtime logs a warning when the API is exposed beyond loopback without a token (#24)

### Changed

- Terraform/Azure repositioned as an opt-in profile; default install path is any Linux machine with Docker and `/iris/.env`, zero cloud dependencies (#25)
- De-personalized CONSTITUTION.md and skill docs; fixed repo identity URLs; removed install-specific terraform example module (#23)

### UPGRADING

- Installs whose sub-agent Docker containers call the internal API via the Docker gateway (e.g. `http://172.18.0.1:3000`) must set `IRIS_API_HOST=0.0.0.0` (or the gateway IP) and should set `IRIS_API_TOKEN`, passing the token to sub-agents.
- If you relied on the 300s LLM timeout, set `IRIS_LLM_TIMEOUT_SECS=300`.

## [0.63.1] - 2026-03-27

### Fixed

- Fixed Mom compaction status handling to follow the unified `compaction_start` and `compaction_end` session events, keeping compaction notifications working after the event rename ([#2617](https://github.com/badlogic/pi-mono/issues/2617))

## [0.55.4] - 2026-03-02

### Fixed

- Fixed mom startup crash caused by settings API drift by using `SettingsManager` with workspace-backed storage ([#1444](https://github.com/badlogic/pi-mono/issues/1444))

## [0.42.5] - 2026-01-11

### Fixed

- Use coding-agent's SessionManager instead of custom MomSessionManager to fix API mismatch crash ([#595](https://github.com/badlogic/pi-mono/issues/595))

## [0.31.0] - 2026-01-02

### Breaking Changes

- `AgentTool` import moved from `@mariozechner/pi-ai` to `@mariozechner/pi-agent-core`
- `AppMessage` type renamed to `AgentMessage`
- `Attachment` type replaced with `ImageContent` for image handling
- `MomSessionManager.loadSession()` renamed to `buildSessionContex()`
- `MomSessionManager.createBranchedSessionFromEntries()` signature changed to `createBranchedSession(leafId)`
- `ProviderTransport` removed from Agent config, replaced with direct `getApiKey` callback
- `messageTransformer` renamed to `convertToLlm`
- `ANTHROPIC_API_KEY`/`ANTHROPIC_OAUTH_TOKEN` no longer checked at startup (deferred to first API call)

### Changed

- Session entries now include `id` and `parentId` fields for tree structure support
- Auth lookup now uses `AuthStorage` class instead of direct environment variable access
- Image attachments use `ImageContent` type with `data` field instead of `Attachment` with `content`
- `session.prompt()` now uses `images` option instead of `attachments`

### Added

- Support for OAuth login via coding agent's `/login` command (link `~/.pi/agent/auth.json` to `~/.pi/mom/auth.json`)

## [0.20.2] - 2025-12-13

### Fixed

- **Skill paths now use container paths**: Skill file paths in system prompt are translated to container paths (e.g., `/workspace/skills/...`) so mom can read them from inside Docker.

## [0.20.1] - 2025-12-13

### Added

- **Skills auto-discovery**: Mom now automatically discovers skills from `workspace/skills/` and `channel/skills/` directories. Skills are directories containing a `SKILL.md` file with `name` and `description` in YAML frontmatter. Available skills are listed in the system prompt with their descriptions. Mom reads the `SKILL.md` file before using a skill.

## [0.19.2] - 2025-12-12

### Added

- Events system: schedule wake-ups via JSON files in `workspace/events/`
  - Immediate events: trigger when file is created (for webhooks, external signals)
  - One-shot events: trigger at specific time (for reminders)
  - Periodic events: trigger on cron schedule (for recurring tasks)
- `SlackBot.enqueueEvent()` for queueing events (max 5 per channel)
- `[SILENT]` response marker: deletes status message, posts nothing to Slack (for periodic events with nothing to report)
- Events documentation in `docs/events.md`
- System prompt section explaining events to mom

## [0.18.8] - 2025-12-12

### Changed

- Timestamp prefix now includes timezone offset (`[YYYY-MM-DD HH:MM:SS+HH:MM]`)

## [0.18.7] - 2025-12-12

### Added

- Timestamp prefix on user messages (`[YYYY-MM-DD HH:MM:SS]`) so mom knows current date/time

### Fixed

- Sync deduplication now strips timestamp prefix before comparing

## [0.18.6] - 2025-12-12

### Fixed

- Duplicate message in context when message has attachments (sync from log didn't strip attachment section before comparing)
- Use `<slack_attachments>` delimiter for attachments in messages (easier to parse/strip)

## [0.18.5] - 2025-12-12

### Added

- `--download <channel-id>` flag to download a channel's full history including thread replies as plain text

### Fixed

- Error handling: when agent returns `stopReason: "error"`, main message is updated to "Sorry, something went wrong" and error details are posted to the thread

## [0.18.4] - 2025-12-11

### Fixed

- Attachment downloads now work correctly
  - SlackBot now receives store for processing file downloads
  - Files are downloaded in background and stored in `<channel>/attachments/`
  - Attachment paths passed to agent as absolute paths in execution environment
  - Backfill also downloads attachments from historical messages

## [0.18.3] - 2025-12-11

### Changed

- Complete rewrite of message handling architecture (#115)
  - Now uses `AgentSession` from coding-agent for session management
  - Brings auto-compaction, overflow handling, and proper prompt caching
  - `log.jsonl` is the source of truth for all channel messages
  - `context.jsonl` stores LLM context (messages sent to Claude, same format as coding-agent)
  - Sync mechanism ensures context.jsonl stays in sync with log.jsonl at run start
  - Session header written immediately on new session creation (not lazily)
  - Tool results preserved in context.jsonl for multi-turn continuity

- Backfill improvements
  - Only backfills channels that already have a `log.jsonl` file
  - Strips @mentions from backfilled messages (consistent with live messages)
  - Uses largest timestamp in log for efficient incremental backfill
  - Fetches DM channels in addition to public/private channels

- Message handling improvements
  - Channel chatter (messages without @mention) logged but doesn't trigger processing
  - Messages sent while mom is busy are logged and synced on next run
  - Pre-startup messages (replayed by Slack on reconnect) logged but not auto-processed
  - Stop command executes immediately (not queued), can interrupt running tasks
  - Channel @mentions no longer double-logged (was firing both app_mention and message events)

- Usage summary now includes context window usage
  - Shows current context tokens vs model's context window
  - Example: `Context: 4.2k / 200k (2.1%)`

### Fixed

- Slack API errors (msg_too_long) no longer crash the process
  - Added try/catch error handling to all Slack API calls in the message queue
  - Main channel messages truncated at 35K with note to ask for elaboration
  - Thread messages truncated at 20K
  - replaceMessage also truncated at 35K

- Private channel messages not being logged
  - Added `message.groups` to required bot events in README
  - Added `groups:history` and `groups:read` to required scopes in README

- Stop command now updates "Stopping..." to "Stopped" instead of posting two messages

### Added

- Port truncation logic from coding-agent: bash and read tools now use consistent 2000 lines OR 50KB limits with actionable notices

## [0.10.2] - 2025-11-27

### Breaking Changes

- Timestamps now use Slack format (seconds.microseconds) and messages are sorted by `ts` field
  - **Migration required**: Run `npx tsx scripts/migrate-timestamps.ts ./data` to fix existing logs
  - Without migration, message context will be incorrectly ordered

### Added

- Channel and user ID mappings in system prompt
  - Fetches all channels bot is member of and all workspace users at startup
  - Mom can now reference channels by name and mention users properly
- Skills documentation in system prompt
  - Explains custom CLI tools pattern with SKILL.md files
  - Encourages mom to create reusable tools for recurring tasks
- Debug output: writes `last_prompt.txt` to channel directory with full context
- Bash working directory info in system prompt (/ for Docker, cwd for host)
- Token-efficient log queries that filter out tool calls/results for summaries

### Changed

- Turn-based message context instead of raw line count (#68)
  - Groups consecutive bot messages (tool calls/results) as single turn
  - "50 turns" now means ~50 conversation exchanges, not 50 log lines
  - Prevents tool-heavy runs from pushing out conversation context
- Messages sorted by Slack timestamp before building context
  - Fixes out-of-order issues from async attachment downloads
  - Added monotonic counter for sub-millisecond ordering
- Condensed system prompt from ~5k to ~2.7k chars
  - More concise workspace layout (tree format)
  - Clearer log query examples (conversation-only vs full details)
  - Removed redundant guidelines section
- User prompt simplified: removed duplicate "Current message" (already in history)
- Tool status labels (`_→ label_`) no longer logged to jsonl
- Thread messages and thinking no longer double-logged

### Fixed

- Duplicate message logging: removed redundant log from app_mention handler
- Username obfuscation in thread messages to prevent unwanted pings
  - Handles @username, bare username, and <@USERID> formats
  - Escapes special regex characters in usernames

## [0.10.1] - 2025-11-27

### Changed

- Reduced tool verbosity in main Slack messages (#65)
  - During execution: show tool labels (with → prefix), thinking, and text
  - After completion: replace main message with only final assistant response
  - Full audit trail preserved in thread (tool details, thinking, text)
  - Added promise queue to ensure message updates execute in correct order

## [0.10.0] - 2025-11-27

### Added

- Working memory system with MEMORY.md files
  - Global workspace memory (`workspace/MEMORY.md`) shared across all channels
  - Channel-specific memory (`workspace/<channel>/MEMORY.md`) for per-channel context
  - Automatic memory loading into system prompt on each request
  - Mom can update memory files to remember project details, preferences, and context
- ISO 8601 date field in log.jsonl for easy date-based grepping
  - Format: `"date":"2025-11-26T10:44:00.123Z"`
  - Enables queries like: `grep '"date":"2025-11-26' log.jsonl`
- Centralized logging system (`src/log.ts`)
  - Structured, colored console output (green for user messages, yellow for mom activity, dim for details)
  - Consistent format: `[HH:MM:SS] [context] message`
  - Type-safe logging functions for all event types
- Usage tracking and cost reporting
  - Tracks tokens (input, output, cache read, cache write) and costs per run
  - Displays summary at end of each agent run in console and Slack thread
  - Example: `💰 Usage: 12,543 in + 847 out (5,234 cache read, 127 cache write) = $0.0234`
- Working indicator in Slack messages
  - Channel messages show "..." while mom is processing
  - Automatically removed when work completes
- Improved stop command behavior
  - Separate "Stopping..." message that updates to "Stopped" when abort completes
  - Original working message continues to show tool results (including abort errors)
  - Clean separation between status and results

### Changed

- Enhanced system prompt with clearer directory structure and path examples
- Improved memory file path documentation to prevent confusion
- Message history format now includes ISO 8601 date for better searchability
- System prompt now includes log.jsonl format documentation with grep examples
- System prompt now includes current date and time for date-aware operations
- Added efficient log query patterns using jq to prevent context overflow
- System prompt emphasizes limiting NUMBER of messages (10-50), not truncating message text
- Log queries now show full message text and attachments for better context
- Fixed jq patterns to handle null/empty attachments with `(.attachments // [])`
- Recent messages in system prompt now formatted as TSV (43% token savings vs raw JSONL)
- Enhanced security documentation with prompt injection risk warnings and mitigations
- **Moved recent messages from system prompt to user message** for better prompt caching
  - System prompt is now mostly static (only changes when memory files change)
  - Enables Anthropic's prompt caching to work effectively
  - Significantly reduces costs on subsequent requests
- Switched from Claude Opus 4.5 to Claude Sonnet 4.5 (~40% cost reduction)
- Tool result display now extracts actual text instead of showing JSON wrapper
- Slack thread messages now show cleaner tool call formatting with duration and label
- All console logging centralized and removed from scattered locations
- Agent run now returns `{ stopReason }` instead of throwing exceptions
  - Clean handling of "aborted", "error", "stop", "length", "toolUse" cases
  - No more error-based control flow

### Fixed

- jq query patterns now properly handle messages without attachments (no more errors on empty arrays)

## [0.9.4] - 2025-11-26

### Added

- Initial release of Mom Slack bot
- Slack integration with @mentions and DMs
- Docker sandbox mode for isolated execution
- Bash tool with full shell access
- Read, write, edit file tools
- Attach tool for sharing files in Slack
- Thread-based tool details (clean main messages, verbose details in threads)
- Single accumulated message per agent run
- Stop command (`@mom stop`) to abort running tasks
- Persistent workspace per channel with scratchpad directory
- Streaming console output for monitoring

---

*Empty version headings for 0.10.0–0.66.1 (inherited library version bumps with no
release notes) were removed on 2026-07-03; see git history for those diffs. From
0.90.0 on, every release must have changelog content — CI enforces changelog and
docs updates on behavior-changing PRs (docs-guard workflow).*
