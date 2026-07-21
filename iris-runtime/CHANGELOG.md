# Changelog

## [Unreleased]

### Added

- DeepSeek and Mistral (including Devstral) as first-class LLM providers, alongside a rename of the Azure AI Foundry provider from `foundry-e2` to `azure-foundry` (issue #86). `data/models.json.template` gained `deepseek` and `mistral` provider blocks, both routed through `pi-ai`'s `openai-completions` provider module (`DEEPSEEK_API_KEY`/`deepseek-chat`/`deepseek-reasoner`, `MISTRAL_API_KEY`/`devstral-medium-latest`/`mistral-large-latest`) — config-only, no new SDK integration. Mistral requires `"compat": { "supportsStore": false }` alongside it; see the Fixed entry below for why. `bootstrap.sh` gained matching menu options, API-key prompts, and models.json generation branches. The `foundry-e2` → `azure-foundry` rename (a leftover from the original `eastus2` install) is a breaking key change for anyone with a hand-edited `models.json`, but `bootstrap.sh` migrates `IRIS_PROVIDER=foundry-e2` and the `FOUNDRY_E2_KEY`/`FOUNDRY-E2-KEY` secret to the new names automatically on re-run (`.env` sourcing and Key Vault fetch both fall back to the old names).
- `custom` bootstrap provider option for any other OpenAI-compatible endpoint (Kimi/Moonshot direct, self-hosted vLLM/Ollama, etc.) — prompts for a short provider name, base URL, API key, and exact model id, and generates an `openai-completions` provider block under that name (`CUSTOM_API_KEY`/`CUSTOM_BASE_URL`/`CUSTOM_PROVIDER_NAME` persisted in `/iris/.env` so re-running `--setup` reuses them). `IRIS_PROVIDER` is written as the sanitized provider name itself, not the literal string `custom`.

### Removed

- Trimmed the `iris-runtime` Docker image from 2.75GB to ~930MB: dropped the unconditional Azure CLI install (693MB) — `az` runs on the host, installed by `bootstrap.sh` only on the Key Vault paths (Options 2/4 in `docs/SETUP.md`), and sub-agent containers mount `~/.azure` only when a bootstrap opts in (`agents/bootstrap.template.sh`); dropped the `wkhtmltopdf`/`xvfb`/`weasyprint`/`pypdf` PDF-generation stack (633MB) — unreferenced by any skill or `src/` code (the documented markdown→PDF self-extension demo in the README uses `pandoc`, never installed here); dropped the unused `@mariozechner/pi-web-ui` dependency from `iris-runtime/package.json` — never imported by `src/` (the reference web UI is hand-written static HTML/CSS/JS per `docs/web-ui.md`), and its own transitive deps (`pdfjs-dist`, `lucide`, `xlsx`, `docx-preview`, `ollama`, `@lmstudio/sdk`) were the single largest chunk of `node_modules`. This also fixes the `scripts/build-firecracker-rootfs.sh` headroom margin having less room to work with on hosts with less free disk.

### Fixed

- Every Mistral run got stuck at "Thinking…" forever with nothing in the logs, tracked down through three layers: (1) the default/template model id `devstral-medium-2507` doesn't exist — Mistral's API rejects it with `invalid_model` (400); fixed to `devstral-medium-latest`. (2) `baseUrl` was `https://api.mistral.ai/v1`, but the `@mistralai/mistralai` SDK's native `mistral` provider module (`pi-ai`'s `api: "mistral"`) already appends `/v1` to `serverURL` itself, so requests hit `.../v1/v1/chat/completions` and got a 404 `no Route matched`; fixing the URL to `https://api.mistral.ai` made the SDK's `chat.stream()` call succeed in isolation. (3) Even with both of those fixed, live runs through the full engine (`session.prompt()` → `pi-coding-agent`'s `Agent.prompt()` → `pi-ai`'s native `streamMistral`) still hung indefinitely with no network connection, no CPU activity, and — confirmed via a live V8 inspector attach mid-hang — no error, timeout, or completion ever surfacing, even with `IRIS_LLM_TIMEOUT_SECS` turned down to 15s. Root cause was never isolated inside the vendored native Mistral provider module; the pragmatic fix is to not use it. **`mistral`'s `api` is now `"openai-completions"` instead of `"mistral"`**, with `baseUrl` back to `https://api.mistral.ai/v1` (openai-completions expects the `/v1` suffix, unlike the native SDK) and a required `"compat": { "supportsStore": false }`, since `openai-completions` sends `store: false` by default and Mistral's endpoint 422s on it (`"Extra inputs are not permitted"`) even though the endpoint is otherwise OpenAI-schema-compatible. Verified with a live `streamSimple()` call completing in under a second with real generated content. Do not switch Mistral's `api` back to `"mistral"` without first confirming upstream `pi-ai`/`@mistralai/mistralai` has fixed the native provider hang.
- `scripts/build-firecracker-rootfs.sh` sized the ext4 rootfs at a hardcoded 2048MiB, smaller than the uncompressed `iris-runtime:local` image (2.75GB+), so `tar -xf -` into the loop-mounted image failed partway through with `Cannot write: No space left on device`. The script now exports the container to a tarball first, sizes the ext4 image from the tarball's actual size plus 1024MiB headroom (floored at the previous 2048MiB minimum), then extracts into it.

### Changed

- `install.sh` now defaults `IRIS_CORE_REF` to the latest release tag (resolved via `git ls-remote --tags --sort=-v:refname`) instead of `main`, so the curl-pipe installer pins to a released version rather than whatever last merged to `main` (IRIS-122). Falls back to `main` if no `v*` tags exist on the remote (e.g. a fork with no releases yet). The `IRIS_CORE_REF` env override still works for developers who want a specific branch or tag. The full-repo clone (no sparse checkout) is kept as-is — every top-level directory is load-bearing at runtime (`scripts/`, `skills/` symlinked live into `/iris/data/skills`, `terraform/` for the opt-in cloud profile), and a filtered clone would diverge from the documented overlay/submodule pattern.

## [1.0.0] - 2026-07-21

First tagged release — the tag Phase 3 (iris-30signals migration) pins first. Consolidates the transport refactor (`ChannelTransport` interface, Slack/Telegram/Bridge/Web transports, `src/engine/` + `src/transports/*` layout), MCP server support, the reference web UI, and the release-hygiene/npm-readiness cleanup below.

### Removed

- Skills distribution cleanup: deleted two skills that were internal-install artifacts, not shippable platform skills. `skills/watchdog/` hardcoded a specific install's Slack DM channel ID in four files, read legacy `/iris/data/.secrets/telegram-*` paths no current bootstrap creates, and referenced a `telegram/bot.js` skill that doesn't exist in this repo — its health-check role is replaced by the new generic `status` skill. `skills/promote-skill/` automated a preview→prod promotion flow that no longer exists (`spawn-agent` provisions one container per agent) and probed for `iris-<agent>-prod` container names that don't match current naming; its still-valid checklist (test with a safe case, no hardcoded secrets, kebab-case name, committed before use) is folded into `self-extend` rule 7. Remaining internal residue scrubbed from kept skills: `azure` resource group parameterized as `${IRIS_RESOURCE_GROUP:-iris-rg}`, `send-email` no longer claims the sending domain's DNS is "already configured", `firecracker-agent/SKILL.md` gained the YAML frontmatter every other skill has, and internal agent names in usage examples replaced with neutral ones. The opt-in profile skills (`azure`, `terraform`, `firecracker-agent`) stay in core — they're required by the documented Key Vault/Terraform and Firecracker profiles — but now state "Opt-in … profile only" in their frontmatter `description` (the line injected into the system prompt), and `firecracker-agent` gained the same opt-in banner `azure`/`terraform` already had, so zero-cloud installs aren't steered toward cloud tooling they don't have. No AWS skills exist or were added: Bedrock support is pure env-var provider config, and AWS infrastructure tooling belongs in an install overlay until there's a real AWS profile.

- Pre-release cleanup (IRIS-121): deleted the legacy upstream pi-mom docs that shipped inside `iris-runtime/` — `docs/artifacts-server.md` (documented a feature this runtime doesn't have), `docs/slack-bot-minimal-guide.md`, `docs/sandbox.md`, `docs/new.md` (completed redesign plan), `docs/v86.md` (rejected sandbox evaluation) — plus `docker.sh` (Mom-era container helper; Iris runs via systemd, and `src/sandbox.ts` now prints the equivalent `docker run` command instead of referencing it) and `scripts/migrate-timestamps.ts` (one-time pre-fork data migration). `iris-runtime/README.md` rewritten for `@iris-core/runtime` (it was still the upstream "mom (Master Of Mischief)" README with `MOM_SLACK_*` env vars). Remaining "mom"/"pi-mom" identifiers renamed across `dev.sh` (`iris-dev-sandbox` container), source comments, skills, and `.gitignore`. `docs/events.md` updated to the current transport-agnostic architecture (`ChannelTransport.enqueueEvent`, `IrisEvent`). `agents/start-all.sh` now runs `sync-secrets` only when `IRIS_KEY_VAULT` is configured, so the zero-cloud path no longer invokes a Key Vault sync on boot. `data/README.md` reframed env-var-first (Key Vault as the opt-in profile).

### Added

- Opt-in credential broker (`IRIS_SECRETS_MODE=store|proxy`, default `env` unchanged from today) so secrets don't have to live in plaintext `/iris/.env`, where any agent bash command that runs `env` or `cat /iris/.env` can read and echo every credential the runtime holds. `store` mode adds a local AES-256-GCM encrypted secret store (`engine/secret-store.ts`, Node built-in `crypto`, no new dependency) and scrubs migrated vars from the runtime's `process.env` after transport startup, so shells spawned by `HostExecutor` no longer inherit them. `proxy` mode goes further with a standalone `iris-broker` daemon (`src/broker/`) running as its own systemd unit under a dedicated `iris-broker` system user — a real uid boundary the agent can't cross even under `--sandbox=host` — plus a header-injection gateway (`ANY /proxy/:service/*`, bundled service map for Resend/GitHub/Anthropic/OpenAI/Slack, operator-extensible via `/iris/broker/services.json`) so a secret marked `proxyOnly` can be *used* by the agent without its plaintext ever being readable by any caller, including one holding a valid broker token. Backstopped by a Tier-3 output redaction pass (`engine/redact.ts`, wired into a new `RedactingExecutor` in `sandbox.ts`) that masks any provider-resolved plaintext in command output before it reaches the model or transcripts. The internal API gains `PUT`/`DELETE /secrets/:name` and `GET /secrets` (iris-only; list/metadata never includes values) and a `GET /secret/:name` alias — the URL shape `createBrokerSecretProvider` already fetches, so a sub-agent runtime can point `IRIS_SECRET_BROKER_URL` at its parent and resolve through its own `agents.json` allow-list.
- Out-of-band secret submission, so a credential never has to be pasted into chat (which lands it in LLM context, transcripts, and channel logs). `POST /secret-drops` (iris-only) mints a one-time, expiring capability token; `GET`/`POST /secret-drop/:token` on the web transport (checked before the session-cookie gate — the token in the URL is the auth) renders a minimal form and stores the submitted value, then drops a name-only notification event back into the requesting channel. New `skills/set-secret` is what Iris reaches for instead of asking a user to type a secret in chat (`set-secret request NAME --channel <id>` for drop links, `set-secret NAME` for secrets Iris provisions herself); `skills/get-secret` gained hygiene guidance and 403 semantics for proxy-only/runtime-only secrets.
- `iris-secret` CLI (`src/cli/iris-secret.ts`) for operators over SSH: `init`/`set`/`get`/`list`/`rm`/`import-env --prune`. Values are read from stdin or a hidden TTY prompt, never argv, so nothing lands in shell history or process listings. `bootstrap.sh` gained `--secrets-mode=env|store|proxy`: it generates the key file (and, for `proxy`, the `iris-broker` user, `/iris/broker/`, and the `iris-broker.service` unit), then runs `iris-secret import-env /iris/.env --prune` to move known credential vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, Slack/Telegram/GitHub/Resend tokens, `FOUNDRY_E2_KEY`) out of `.env` — idempotent, and re-runnable on upgrade. `terraform/modules/agent` gained a `secrets_mode` variable (default `"env"`, unchanged behavior): under `store`/`proxy` the container stops receiving `--env-file /iris/.env` entirely and instead gets `IRIS_SECRET_BROKER_URL` pointed at the parent plus a required per-agent token (`unique_api_token` enforced via a Terraform precondition), resolving secrets through its own allow-list instead of inheriting the whole file. Docs: new `docs/secrets.md`.
- `src/index.ts` package entry barrel (IRIS-57): `package.json` has declared `main: ./dist/index.js` / `types: ./dist/index.d.ts` since the npm-readiness work began, but no `src/index.ts` existed — the entry was dangling and `dist/index.js` never got built. The barrel re-exports `createEngine` plus the `Engine`/`EngineConfig`/`EngineTransport`/`ChannelState` and `ChannelTransport`/`MessageContext`/`TransportEvent`/`ToolEvent`/`TransportPromptProfile`/`ChannelInfo`/`UserInfo` types (and `registerPromptProfile`/`getPromptProfile`) a host would need to drive the engine or implement a new transport as a library consumer — the CLI (`bin: dist/main.js`) is unaffected and unchanged. Audited that nothing under `src/` reaches outside `iris-runtime/` at build time: `tsconfig.build.json`'s `rootDir: ./src` already rejects that, and the one runtime (non-TS-import) reference outside `src/` — `vm-manager.ts`'s `resolve(dirname(...), "../../scripts")` — resolves to `iris-runtime/scripts/`, still inside the package. Publishing to npm itself stays deferred (Phase 7); this only keeps the package buildable/importable so the submodule-vs-npm decision stays open.
- Two zero-dependency platform skills aimed at first-time installs. `skills/schedule/` makes the existing events queue (`engine/events.ts`) a first-class capability: `schedule once --channel <id> --at <ISO 8601> --text ...` writes a `one-shot` event, `schedule every --channel <id> --cron <expr> [--tz <IANA>] --text ...` writes a `periodic` one, with `list`/`cancel` subcommands (cancel is a guarded delete — the watcher already treats file deletion as cancellation). `skills/status/` is a read-only health snapshot — `iris.service` state, disk, `iris-*` containers, recent journal errors, and a parameterized stuck-message check against `<workspace>/<channel>/log.jsonl` (channel from argument or `IRIS_STATUS_CHANNEL`, exit 1 when the last human message has no bot response so it can serve as a scheduled probe); each section degrades gracefully where systemd/docker/journalctl are absent, e.g. inside sub-agent containers.
- MCP server support: Iris can connect to [Model Context Protocol](https://modelcontextprotocol.io) servers and expose their tools directly to the model as `mcp__<server>__<tool>`, alongside the built-in tools. Servers are declared in `<workspace>/data/mcp.json` (optional — absent file means zero servers and zero overhead) with two transports: `stdio` (local subprocess) and `http` (remote Streamable HTTP, with header-based auth); secrets are referenced as `${VAR}` and expanded from `.env`, never stored in the config. The config hot-reloads before each message (content-hash gated), so a server added through chat is usable on the next message; connections are lazy and per-server failures are isolated — a bad or unreachable server is reported in the system prompt's new "MCP Servers" section and via the new `GET /mcp/status` internal API route (which refreshes on request, for immediate verification after an edit), never crashing the runtime or blocking startup. Failed servers self-heal with a ~60s retry backoff; tools with schemas AJV can't compile are dropped individually with a log line; tool output is truncated with the same limits as bash output. New `skills/mcp` skill teaches Iris to add/remove/verify servers herself (configure-through-chat, same idiom as `channels.json`), including the security posture: MCP servers run on the host as the iris user outside the bash sandbox, so new servers require operator approval and remote tool descriptions are treated as untrusted input. New module `src/engine/mcp/` (config loader, tool wrapper, connection manager); new dependencies `@modelcontextprotocol/sdk` and `ajv` (already in the tree via pi). Docs: new `docs/mcp.md`.
- Reference web UI (IRIS-113), replacing the bare test page `WebTransport` (IRIS-112) shipped with: plain HTML/CSS/JS (no bundler/framework — see `docs/web-ui.md` for why), thread sidebar (client-side/`localStorage`, no server-side session list), an agent picker for routing a thread to a sub-agent, tool-call cards (collapsible, fed by `onToolEvent`), file attachments (upload + download), and Stop/Compact/Reset buttons. Three small backend additions discovered while building the frontend: `GET /agents` (name/description only — never `bridge_url`/`secrets`) so the picker has something to list; `POST /upload` / `GET /files/:channel/:filename` for attachments, saved via `resolveChannelDir`/`resolveChannelPath` like every other transport's attachments; a `{type: "command", action: "stop"|"compact"|"reset"}` WS frame so admin actions are real buttons instead of parsed chat text, wired to the same `engine.handleStop`/`handleCompact`/`handleReset` Slack's admin mode already uses (not available on agent-routed threads — the bridge protocol has no such concept).
- Built-in web chat transport (IRIS-112): `WebTransport` implements `ChannelTransport` (same interface as Slack/Telegram/Bridge, zero engine edits) over WebSocket, gated by `IRIS_WEBUI_PORT` (off by default). Shared-secret login via `IRIS_WEBUI_PASSWORD` (a door lock, not RBAC — no user accounts/roles). Ships a bare functional test page; the reference UI is IRIS-113, a separate follow-up built against the protocol documented in `docs/web-ui.md`. New `MessageContext.onToolEvent` hook (optional, additive — Slack/Telegram/Bridge unaffected) delivers structured tool-call start/end events instead of the flattened markdown string other transports get, for live-updating tool cards. Threads can target a registered sub-agent directly via `?agent=<name>`, routed over the existing `agents.json`/`bridge_url` HTTP bridge (single request/response — no intermediate tool-event stream, since the bridge protocol doesn't expose one).
- `GET /secrets/:name` internal API route (IRIS-111): agent-scoped secret resolution, replacing direct env-var/Key Vault access inside skills. Backend is pluggable — `env` (default: env var, then Azure Key Vault if `IRIS_KEY_VAULT` is set) or `broker` (proxies to `IRIS_SECRET_BROKER_URL`/`IRIS_SECRET_BROKER_TOKEN`, vendor-neutral — Vault, Infisical, or any HTTP service speaking the same contract). Sub-agents must be allow-listed via a new `secrets` array on their `agents.json` entry (`{"secrets": ["SENDGRID_API_KEY"]}`); Iris herself is unrestricted. Caller identity is derived from the authenticating token (see IRIS-120 below), not a self-reported header. The `get-secret` skill is now a thin client for this route instead of resolving secrets itself — `sync-secrets`/`--env-file /iris/.secrets.env` still work for other consumers but are no longer required for `get-secret`.
- Dispatch regression suite (`iris-runtime/test/`, run via `npm test`, wired into CI): 42 tests porting the synthetic-event harness that verified PR #37's channel-mode consistency fixes into a committed, always-run suite. Covers config resolution (wildcard precedence, unknown-mode rejection), passthrough forwarding shapes, admin commands, leads replay and queue bounds, session creation/gating for thread and interactive-thread modes, single-ack behavior (including on handler errors), and startup resume of interrupted runs. This is the safety net for the upcoming presets-over-flags dispatch rewrite — the suite must stay green (modulo the six-questions decisions) as that work lands.

### Added

- New `docs/writing-a-transport.md` (IRIS-58): the `ChannelTransport` contract for anyone adding a new chat platform (Discord, WhatsApp, ...) — the interface, `MessageContext`'s chunking/threading responsibilities (transport-owned, no shared engine helper), `TransportPromptProfile`, `ownsChannel` routing precedence, registering a transport in `main.ts`, and a pre-PR checklist. Documents that channel-mode dispatch (`resolveDispatch`, `dispatch-config.ts`) is Slack-only today despite being expressed against fully generic shapes — a new transport isn't required to wire it up. `docs/overlay.md` gained a "What belongs in the overlay vs. core" section: unlike skills/sub-agents/config, a transport is constructed in `main.ts` rather than discovered from the workspace, so adding one is a core PR, not overlay content.

### Changed

- `docs/channel-modes.md` cross-links the new transport doc and calls out its mode-mapping table as the permanent legacy-alias mapping (IRIS-58) — no content/schema change, the page already matched the IRIS-54 presets-over-flags implementation.
- Channel-mode dispatch rewritten as presets over flags, one pipeline in the engine (IRIS-54). The six named modes (`dm`/`admin`/`thread`/`interactive-thread`/`leads`/`passthrough`) were each re-implementing their own slice of routing across two duplicated code paths (Slack's `app_mention` handler and its `message` handler) — that duplication is exactly why PR #37 had to fix the same class of consistency bug six times. New `src/engine/dispatch-config.ts` expands each legacy mode name into three primitives (`container`: `chat` | `sessions` | `relay`) plus orthogonal flags (`trigger`: `mention` | `all-top-level` | `api-only`; `adminCommands`; `acceptBotMessages`; `replayMissed`) — see `docs/channel-modes.md`'s new "Under the hood" section for the full mapping. New `src/engine/dispatch.ts` is the single transport-agnostic `resolveDispatch()` decision function (filter → trigger check → container resolution → decision), expressed only against generic shapes, never Slack types. `slack.ts`'s two event handlers now normalize their Slack-specific event fields and call this one pipeline instead of branching on `channelMode === "..."` six ways in each handler; `getChannelMode`/`getPassthroughConfig`/`requiresMentionForTopLevel` are unchanged as public methods (thin wrappers over the resolved config) for API/backward compatibility. `channels.json`'s schema is unchanged — the six mode names remain the only supported, documented configuration surface; there is no raw `container`/`trigger`/flag syntax exposed to callers. No behavior change: the 42-test dispatch regression suite (IRIS-55) passes unmodified.
- `CONSTITUTION.md` and `MEMORY.md` moved from the repo root into `data/` (#60), matching where `data/README.md` already documented them as living. `bootstrap.sh` now symlinks `$IRIS_DIR/data/{CONSTITUTION,MEMORY}.md` from `$REPO_DIR/data/{CONSTITUTION,MEMORY}.md` instead of the repo root. Per-agent `agents/<name>/CONSTITUTION.md`/`MEMORY.md` and the runtime's `workspaceDir`-relative reads (`agent.ts`) are a separate, already-namespaced concept and are unaffected.
- The `last_prompt.jsonl` debug write no longer blocks message handling (#59). Previously every incoming message serialized the full system prompt + channel history (pretty-printed) and awaited the disk write before issuing the LLM call — a cost that grows with channel history and was measured as a noticeable share of pre-response latency in iris-cloud (irisworks/iris-cloud#70). The write is now deferred off the hot path (`setImmediate`) and fire-and-forget: failures log a warning instead of failing the run, and the file is written as compact JSON rather than pretty-printed — pipe it through `jq .` when inspecting it.
- CodeQL moved from GitHub's "default setup" to a checked-in `.github/workflows/codeql.yml`. Behavior is unchanged (same languages — actions, javascript-typescript, python — same triggers: PR, push to main, weekly schedule) but the config is now versioned and reviewable in the repo instead of only in repo settings. The weekly schedule is kept intentionally (it catches newly-added CodeQL query-pack rules matching against code no PR touched) — that's also the source of "Copilot Autofix" PRs like alert-autofix-N that arrive without an originating PR to review against; treat them as ordinary PRs (review + docs/changelog entries) same as any code change.
- `GET /secrets/:name` caller identity is now derived from *which token authenticated* the request, not from the self-reported `X-Iris-Caller` header (IRIS-120, follow-up to IRIS-111). Opt in per agent with `unique_api_token = true` on its `terraform/modules/agent` module block: the container then gets its own `IRIS_API_TOKEN` (module output `api_token`, overriding the shared `.env` token for that container); register the value as a new `token` field on the agent's `agents.json` entry so the API can match it — the agent's API calls are 401 until you do, so copy the token in as part of the same change. With the flag off (the default) nothing changes on apply: agents keep the shared `IRIS_API_TOKEN` and resolve as unrestricted `iris`, same as before — the allow-list only becomes a real security boundary (rather than hygiene/audit-trail) once each agent that needs it gets its own token. Note `agents.json` holds live bearer tokens once `token` fields are set: tight permissions, never commit it. The `get-secret` skill no longer sends `X-Iris-Caller` (the server never reads it).
- Bootstrap no longer installs Terraform, nginx, or certbot unconditionally. Terraform is installed only on the Key Vault (cloud-profile) path; nginx and certbot are installed only when a public domain (`IRIS_BASE_DOMAIN`) is configured — the zero-cloud quickstart (`--setup --no-keyvault`, no domain) now pulls in just Docker, Node, jq, and the GitHub CLI. As part of this, an install with a public domain but no Key Vault now also gets nginx installed with the base config written (previously the domain was noted but nginx was left unconfigured); DNS + NSG automation remains Azure-only.
- License changed from MIT to Apache License 2.0 (`LICENSE`, new `NOTICE` file, `package.json` license field, README/CONTRIBUTING mentions) (IRIS-109).

- Internal (IRIS-56): single isolated directory-move commit, no logic edits — the last structural change before the v1.0.0 tag. `src/engine/` now holds the transport-agnostic core (`index.ts`, formerly `engine.ts`; `agent.ts`, `api.ts`, `bridge.ts` — the internal `@agentname` HTTP bridge — `context.ts`, `events.ts`, `log.ts`, `sandbox.ts`, `secrets.ts`, `sessions.ts`, `store.ts`, `vm-manager.ts`, `tools/`). `src/transports/` now holds one directory per `ChannelTransport` implementation: `slack/` (`slack.ts`, `download.ts`), `telegram/` (`telegram.ts`, `telegram-claim.ts`), `bridge/` (`bridge-transport.ts`, formerly `transport/bridge.ts` — renamed off the bare `bridge.ts` basename to avoid colliding with `engine/bridge.ts`, an unrelated module), `web/` (`web.ts`, formerly `transport/web.ts`). `src/transport/types.ts` keeps its one shared-contract role that both `engine/` and `transports/*` import, with its own internal import updated to the new `engine/index.ts` path. No behavior change; import paths only.

- Internal: shared transport types moved to `src/transport/types.ts` — `ChannelInfo`, `UserInfo`, and `MessageContext` (rename of `SlackContext`, which stays as a compat re-export alongside `TelegramContext`). Contexts now carry a `transportId` (`"slack" | "telegram" | "bridge"`), and a `TransportPromptProfile` registry is in place for the upcoming prompt de-Slacking. The engine (`agent.ts`) no longer imports transport modules. No behavior change.
- Internal: main.ts is now pure wiring — transports constructed from env (Slack if tokens, Telegram if token, Bridge always), then API/bridge/events hookup. The events watcher and the internal API route by `transport.ownsChannel(channelId)` instead of inline `tg-*` checks. One behavior fix from the routing: API endpoints that post to a channel (e.g. `POST /sessions/open`) now reach the transport that owns the channel — a `tg-*` channel goes to Telegram even when Slack is connected (previously it was always sent to the preferred bot and failed). Session endpoints keep the old preference order (Slack, then Telegram, then Bridge).
- Internal: `ChannelTransport` interface finalized in `transport/types.ts` (start/stop, ownsChannel, getChannels/getUsers, postMessage/updateMessage, enqueueEvent, createContext, promptProfile). `SlackBot` and `TelegramBot` implement it; the context factories moved verbatim from main.ts into slack.ts/telegram.ts; the bridge-only stub bot is replaced by a real `BridgeTransport` (`transport/bridge.ts`). Adding a transport requires zero engine edits. No behavior change.
- Internal: the near-identical Slack and Telegram run/stop/compact/reset handlers in main.ts are unified into one engine (`src/engine.ts`, `createEngine`) owning the per-channel state map and run dispatch; the transport handlers are now thin adapters. One user-visible convergence: on Telegram, `/stop` now edits the "_Stopping..._" status message to "_Stopped_" (matching Slack) instead of posting a second message.
- The system prompt is now composed from the transport's `TransportPromptProfile` (identity line, formatting rules, channel/user directory, `[SILENT]`/attach notes, attachment tag name, message-split limit) instead of hardcoded Slack text. Slack prompts are byte-identical to before; bridge-only runs keep the Slack fragments. The `"Slack API error (…)"` log line is now `"Transport API error (…)"` — update any log grep that matched on it.

### Fixed

- Slack `compact` (and `stop`/`reset`) now work as bare text in an `admin`-mode channel, not just via an explicit `@iris` mention or in a DM ([#78](https://github.com/irisworks/iris-core/issues/78)). `resolveDispatch()` (`engine/dispatch.ts`) previously only intercepted admin-command text when `isMention || isDM` was true, so a plain `compact` typed into an admin channel fell through to the trigger-check stage, matched no branch (the channel's `trigger` is `mention`, not `all-top-level`), and was silently dropped — no compaction, no error, no response. Admin commands are now intercepted whenever the channel has `adminCommands` enabled, regardless of mention/DM, matching Telegram's unprefixed `/compact` which needs no such targeting either.

- Slack replies with rich formatting no longer vanish with a silent `msg_too_long` error ([#61](https://github.com/irisworks/iris-core/issues/61)). Slack enforces its message-length limits against the HTML-escaped text it stores (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`), so a reply heavy on code blocks or comparison operators could be rejected even when the raw string was under the 4,000-character split point — and the failure was log-only, leaving the user on the "Thinking..." placeholder forever. Three-layer fix in `slack.ts`: (1) message splitting and truncation now budget on the escaped length, so such replies split correctly up front; (2) if Slack still answers `msg_too_long`, already-posted thread chunks are removed and the reply is re-posted at half the chunk size (halving down to a 1,000-char floor); (3) if message delivery fails outright, the reply is attached as a file (`iris-reply.md`, threaded under the reply message) and the placeholder is replaced with a visible error notice — the user always receives the content or an explanation, never a stuck "Thinking...".

- Bridge HTTP error responses no longer echo internal error details (code scanning alert #5). A failed event-file write now returns a generic `Failed to write event.` (500) and a failed/timed-out wait for the sub-agent returns `Bridge request failed.` (504), instead of the raw exception message (which could include filesystem paths). Full details are still logged on the sub-agent side (`[bridge] Failed to write event file: …` / `[bridge] Request failed: …`); check the sub-agent's logs when diagnosing bridge errors.

- Credential broker follow-ups from PR #69 review, including a CodeQL "polynomial regular expression" alert on `iris-broker`'s Bearer-token parsing (`/^Bearer\s+(.+)$/i` — adjacent overlapping quantifiers, both `\s+` and `(.+)` match spaces), fixed by switching to the same bounded prefix-match-then-slice approach `api.ts`'s `resolveCaller` already used. Also: the injection gateway (`broker/gateway.ts`) now merges forwarded and injected request headers case-insensitively, so a caller can't get a second same-name-different-case header alongside an injected credential header reaching the upstream; the gateway and the internal API's `readBody` both cap request body size (10MB) instead of buffering unboundedly; the output-redaction backstop's tracked-secret-values set (`engine/redact.ts`) is now LRU-capped at 256 entries instead of growing for the life of the process; and `getSecretMeta`'s fail-open behavior on broker errors (relying on the broker's own independent `proxyOnly` re-check as the actual enforcement) is now documented in-line as a deliberate defense-in-depth choice, not the single point of enforcement. New test coverage: gateway header-case collision, gateway/API oversized-body rejection, invalid secret names on write, malformed JSON bodies, secret-drops without a writable backend, and drop-link TTL expiry.

- Internal API error responses no longer echo internal error details (code scanning alert #12). `PATCH /sessions/:id`, `POST /sessions/:id/message`, and the top-level request handler in `iris-runtime/src/api.ts` now return stable generic messages (`"session not found"` / `"session message failed"` / `"internal server error"`) instead of the raw exception message, which could include filesystem paths or other internals. Full details are still logged via `log.logWarning`; check `journalctl -u iris` when diagnosing API errors.

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
