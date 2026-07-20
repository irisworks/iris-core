# Iris

**An AI operator that never clocks out.** Message it on Slack, Telegram, or its
built-in web UI and it
runs commands, writes its own skills on the fly, provisions infrastructure, and
spins up a fleet of specialized sub-agents — each one optionally sealed inside
its own Firecracker microVM — to get the work done.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![CI](https://github.com/irisworks/iris-core/actions/workflows/ci.yml/badge.svg)](https://github.com/irisworks/iris-core/actions/workflows/ci.yml)
[![Runtime version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Firisworks%2Firis-core%2Fmain%2Firis-runtime%2Fpackage.json&query=%24.version&label=runtime)](iris-runtime/CHANGELOG.md)

One `curl | bash` on any Linux box turns it into a self-hosted, self-healing
AI teammate — no cloud account, no Kubernetes, no vendor lock-in required.

- **Self-extending** — Iris writes and hot-reloads her own skills; no redeploy to teach her something new
- **Fleet, not chatbot** — spins up specialized sub-agents on demand, each talking over an HTTP bridge
- **Defense in depth, opt-in** — Docker by default; flip a flag and every sub-agent runs in its own Firecracker microVM with a hardware KVM boundary
- **Provider-agnostic** — Anthropic, OpenAI, Azure AI Foundry, or AWS Bedrock, switchable via env vars
- **Three transports, one engine** — Slack, Telegram, and an optional built-in web UI (thread sidebar, live tool-call cards, attachments); adding a transport requires zero engine edits
- **MCP servers** — external toolsets (stdio or remote HTTP) plug in via `data/mcp.json`, hot-reloaded and manageable through chat (see `docs/mcp.md`)
- **Resilient** — LLM retry with backoff, automatic context compaction, self-healing escalation
- **Durable by design** — GitHub is the source of truth; the machine itself is cattle, not a pet
- **Zero cloud dependencies to start** — secrets in `/iris/.env`, sub-agents in Docker; Azure Key Vault and Terraform are opt-in hardening, not requirements

## Quickstart

One command on any Ubuntu 22.04 machine — no Azure, no KVM:

```bash
curl -fsSL https://raw.githubusercontent.com/irisworks/iris-core/main/install.sh | bash
```

This clones the repo to `/iris/repo` and runs the interactive bootstrap: it installs
dependencies, asks for your LLM API key, walks you through creating a Slack app
and/or Telegram bot (exact scopes shown in-terminal), builds the runtime, and starts
Iris as a systemd service.

**Verify:** `sudo systemctl status iris`, then in Slack: `@iris what model are you?`

Want secrets in Azure Key Vault, or every command isolated in a Firecracker microVM?
Pass bootstrap flags through the installer — see **[docs/SETUP.md](docs/SETUP.md)**
for full walkthroughs of all four paths, including Telegram bot claiming:

| | No Firecracker | With Firecracker |
|---|---|---|
| **No Azure** | *(default)* | `\| bash -s -- --setup --no-keyvault --firecracker` |
| **Azure Key Vault** | `\| bash -s -- --setup --keyvault` | `\| bash -s -- --setup --keyvault --firecracker` |

Already cloned? `bash bootstrap.sh --setup --no-keyvault` does the same without the installer.

## Talking to Iris

- **Slack:** `@iris <anything>` in a channel, or DM her directly. Attachments work both ways.
- **Telegram:** message your claimed bot; groups and topic threads supported.
- **Web UI:** set `IRIS_WEBUI_PORT` and open it in a browser — thread sidebar,
  agent picker, live tool-call cards, file attachments, and Stop/Compact/Reset
  buttons. Off by default; see [docs/web-ui.md](docs/web-ui.md).
- **Control commands:** `stop`, `compact`, `reset` in an admin-mode Slack DM;
  `/stop`, `/compact`, `/reset` on Telegram; buttons in the web UI.

## Channel Modes

How Iris behaves in a Slack channel is configured per channel in
`<workspace>/data/channels.json`:

| Mode | Behavior |
|---|---|
| `dm` | Default. Responds in DMs; channels need an `@iris` mention |
| `admin` | Like `dm`, plus `stop` / `compact` / `reset` control commands |
| `thread` | Only responds inside registered session threads (sessions created via the API) |
| `interactive-thread` | Top-level `@iris` mention opens a session; replies in that thread continue it without further mentions |
| `leads` | Every top-level message triggers Iris — no mention needed |
| `passthrough` | Messages are forwarded to an external HTTP endpoint; the reply is posted back. Iris's LLM never runs |

```json
{
  "C0XXXXXXX": { "mode": "interactive-thread", "requireMentionForTopLevel": true },
  "C0YYYYYYY": {
    "mode": "passthrough",
    "url": "https://example.com/webhook",
    "secretName": "MY-WEBHOOK-KEY",
    "payload": { "sender_id": "{{sender_id}}", "message_text": "{{text}}" },
    "replyPrefix": "*Bot:* "
  },
  "D*": { "mode": "admin" }
}
```

Keys are channel IDs (prefix wildcards like `D*` supported). Passthrough `payload`
is a JSON template — string values may use `{{text}}`, `{{user_id}}`, `{{user_name}}`,
`{{user_handle}}`, `{{sender_id}}`, `{{channel}}`, `{{ts}}`. The API key comes from
`secretName` (via the `get-secret` skill) or the `PASSTHROUGH_API_KEY` env var.

## Configuration

Set in `/iris/.env` (written by bootstrap) or as CLI flags (`--provider`, `--model`,
`--sandbox`, `--transport`, `--api-port`). Flags override env.

| Variable | Default | Purpose |
|---|---|---|
| `IRIS_PROVIDER` / `IRIS_MODEL` | `anthropic` / provider default | LLM provider and model (see `data/models.json`) |
| `IRIS_SLACK_APP_TOKEN` / `IRIS_SLACK_BOT_TOKEN` | — | Slack tokens; presence enables the Slack transport |
| `TELEGRAM_BOT_TOKEN` | — | Telegram token; presence enables the Telegram transport |
| `IRIS_ENV` | `prod` | `preview` \| `prod` |
| `IRIS_API_PORT` / `IRIS_API_HOST` | `3000` / `127.0.0.1` | Internal HTTP API bind (always on) |
| `IRIS_API_TOKEN` | — | When set, API requires `Authorization: Bearer <token>` (except `/health`) |
| `IRIS_BRIDGE_PORT` / `IRIS_BRIDGE_HOST` | — / `127.0.0.1` | Sub-agent bridge server (sub-agents only) |
| `IRIS_LLM_TIMEOUT_SECS` | `90` | Per-attempt LLM timeout |
| `IRIS_LLM_MAX_RETRIES` / `IRIS_LLM_RETRY_BASE_MS` | `3` / `2000` | Retry with exponential backoff on 429/timeout/transient errors |
| `IRIS_COMPACT_THRESHOLD` / `IRIS_COMPACT_TARGET` | `0.6` / `0.1` | Pre-run auto-compaction trigger/target (fraction of context window) |
| `IRIS_SLACK_MAX_CHARS` | `30000` | Safe Slack message length before splitting |
| `IRIS_TELEGRAM_FORCE_RECLAIM` | — | Set `true` + restart to transfer bot ownership |
| `IRIS_WEBUI_PORT` / `IRIS_WEBUI_PASSWORD` | — (off) / — | Enable the built-in web UI on this port; shared-secret login (set it before exposing beyond loopback) |
| `IRIS_SECRET_BROKER_URL` / `IRIS_SECRET_BROKER_TOKEN` | — | External secret broker for `GET /secrets/:name` (Vault, Infisical, or any HTTP service speaking the contract); default backend is env vars, then Key Vault if `IRIS_KEY_VAULT` is set |
| `IRIS_GITHUB_ORG` / `IRIS_GITHUB_REPO` | — | Identity injected into the constitution |
| `IRIS_KEY_VAULT` | — | Azure Key Vault name (Key Vault profile only) |
| `IRIS_BASE_DOMAIN` / `IRIS_EMAIL_FROM` | — | Public serving domain / outbound email sender |

> **Security note:** the internal API binds to loopback by default. If sub-agent
> containers reach Iris via the Docker gateway (`172.18.0.1:3000`), set
> `IRIS_API_HOST=0.0.0.0` **and** `IRIS_API_TOKEN` — never expose the API beyond
> loopback without a token.

## Sandboxing

Iris's bash tool executes at one of four isolation levels (`--sandbox`):

| Mode | Flag | Use case |
|---|---|---|
| Host | `--sandbox=host` | Iris herself — trusted ops, full access |
| Docker | `--sandbox=docker:<name>` | Containerized sub-agents |
| Static Firecracker | `--sandbox=firecracker:<ip>` | Persistent sub-agent at a fixed IP |
| Dynamic pool | `--sandbox=firecracker-pool` | Fresh microVM per channel, auto-destroyed after 30 min idle |

Each microVM is defended in depth: KVM hardware boundary → minimal Firecracker VMM
→ jailer (chroot, uid 10000, seccomp) → per-VM `/30` TAP network → ephemeral rootfs
destroyed with the VM.

## Skills

A skill is a directory with a `SKILL.md` (YAML frontmatter: `name`, `description`)
plus any scripts it needs. Workspace-level skills live in `<workspace>/skills/`
(symlinked to this repo's `skills/` for hot reload); per-channel skills in
`<channel>/skills/` override workspace skills on name collision. Edits apply
without a restart.

Core ships platform skills only — things Iris needs to operate, extend, and heal
herself (`spawn-agent`, `self-heal`, `self-extend`, `get-secret`, `github`,
`send-email`, `serve-public`, `watchdog`, ...). Domain and business skills belong
in your install's overlay (see below).

## Sub-agents and the Internal API

Sub-agents are separate runtime instances in Docker/Firecracker, registered in
`agents.json` and reachable through an HTTP bridge (`@agentname` routing). Scaffolds
live in `agents/`.

The runtime exposes an internal HTTP API (default `127.0.0.1:3000`) for events,
escalations, and session management — create sessions, inject messages, read
history, reset context. Endpoint list in [`iris-runtime/src/engine/api.ts`](iris-runtime/src/engine/api.ts).

Secrets are agent-scoped: sub-agents resolve them via `GET /secrets/:name` and
must be allow-listed per secret in their `agents.json` entry (`"secrets": [...]`);
caller identity comes from the authenticating API token, not a self-reported header.

## Company-Specific Extensions (Overlay)

Don't fork core — link it. Create a private repo with core as a submodule and your
own agents/skills/config as an overlay:

```bash
gh repo create iris-yourcompany --private
cd iris-yourcompany
git submodule add https://github.com/irisworks/iris-core.git core
mkdir -p overlay/{agents,skills,data}
```

Add a `bootstrap-yourcompany.sh` wrapper that sets `REPO_DIR` before calling
`core/bootstrap.sh`, then symlinks your overlay into the workspace. Pin `core` to a
release tag and bump deliberately (see [docs/RELEASING.md](docs/RELEASING.md)).

## Operating

```bash
sudo systemctl status iris      # health
sudo journalctl -u iris -f      # logs
sudo systemctl restart iris     # restart (state is on disk; nothing is lost)
```

If `start` silently does nothing, rebuild first:
`cd /iris/repo/iris-runtime && npm install && npm run build`

| Symptom | Likely cause | Fix |
|---|---|---|
| `iris.service` fails to start | Missing env vars | Check `/iris/.env` and `journalctl -u iris` |
| `/dev/kvm` not found | VM series without KVM | On Azure, resize to Ddsv5 (e.g. `Standard_D4ds_v5`) |
| `firecracker: permission denied` | Not in kvm group | `sudo usermod -aG kvm $USER`, re-login |
| VM boots but `/health` times out | exec-server not started | `journalctl -u iris-fc-<name>` |
| Jailer fails to chroot | `irisjailer` user missing | `sudo groupadd -g 10000 irisjailer; sudo useradd -u 10000 -g 10000 -r -s /usr/sbin/nologin irisjailer` |
| rootfs missing | Build script not run | `sudo bash scripts/build-firecracker-rootfs.sh` |

## Repository Layout

```
iris-core/
├── install.sh            # curl-able one-command installer (clone + bootstrap)
├── bootstrap.sh          # interactive install / full rebuild
├── iris-runtime/         # @iris-core/runtime — the TypeScript engine
├── skills/               # platform skills (hot-reloaded)
├── agents/               # sub-agent scaffolds
├── scripts/              # Firecracker VM lifecycle
├── data/                 # CONSTITUTION.md, MEMORY.md, models.json.template — LLM provider config
├── docs/                 # rendered docs site — setup, configuration, channel modes, web UI, ...
└── terraform/            # optional profile — dynamic Azure resources
```

## Releases

Semver tags (`vX.Y.Z`); installs pin their `core` submodule to a tag. Changelog in
[`iris-runtime/CHANGELOG.md`](iris-runtime/CHANGELOG.md), process in
[`docs/RELEASING.md`](docs/RELEASING.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
