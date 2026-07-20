---
title: Configuration
description: Environment variables, CLI flags, and the security posture of the internal API.
---

# Configuration

Iris reads configuration from `/iris/.env` (written by bootstrap) and CLI flags
(`--provider`, `--model`, `--sandbox`, `--transport`, `--api-port`). Flags override
env vars.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IRIS_PROVIDER` / `IRIS_MODEL` | `anthropic` / provider default | LLM provider and model (see `data/models.json`) |
| `IRIS_SLACK_APP_TOKEN` / `IRIS_SLACK_BOT_TOKEN` | — | Slack tokens; presence enables the Slack transport |
| `TELEGRAM_BOT_TOKEN` | — | Telegram token; presence enables the Telegram transport |
| `IRIS_WEBUI_PORT` | — | Presence enables the built-in web chat transport, bound to `127.0.0.1` |
| `IRIS_WEBUI_PASSWORD` | — | Shared-secret login for the web UI. Unset = no auth gate (fine for loopback-only use; set before exposing via `serve-public`) |
| `IRIS_ENV` | `prod` | `preview` \| `prod` |
| `IRIS_API_PORT` / `IRIS_API_HOST` | `3000` / `127.0.0.1` | Internal HTTP API bind (always on) |
| `IRIS_API_TOKEN` | — | When set, API requires `Authorization: Bearer <token>` (except `/health`) |
| `IRIS_BRIDGE_PORT` / `IRIS_BRIDGE_HOST` | — / `127.0.0.1` | Sub-agent bridge server (sub-agents only) |
| `IRIS_LLM_TIMEOUT_SECS` | `90` | Per-attempt LLM timeout |
| `IRIS_LLM_MAX_RETRIES` / `IRIS_LLM_RETRY_BASE_MS` | `3` / `2000` | Retry with exponential backoff on 429/timeout/transient errors |
| `IRIS_COMPACT_THRESHOLD` / `IRIS_COMPACT_TARGET` | `0.6` / `0.1` | Pre-run auto-compaction trigger/target (fraction of context window) |
| `IRIS_SLACK_MAX_CHARS` | `30000` | Safe Slack message length before splitting |
| `IRIS_TELEGRAM_FORCE_RECLAIM` | — | Set `true` + restart to transfer bot ownership |
| `IRIS_GITHUB_ORG` / `IRIS_GITHUB_REPO` | — | Identity injected into the constitution |
| `IRIS_KEY_VAULT` | — | Azure Key Vault name (Key Vault profile only) |
| `IRIS_SECRETS_MODE` | `env` | `env` \| `store` \| `proxy` — opt-in credential broker, see [Secrets](secrets.md) |
| `IRIS_SECRET_KEY_FILE` / `IRIS_SECRET_STORE_FILE` | `/iris/secret.key` / `/iris/secrets.json.enc` | Encrypted store paths (`store` mode) |
| `IRIS_BROKER_PORT` / `IRIS_BROKER_HOST` | `9099` / `127.0.0.1` | iris-broker daemon bind (`proxy` mode) |
| `IRIS_BROKER_SERVICES_FILE` | `/iris/broker/services.json` | Operator overrides for the injection gateway's service map |
| `IRIS_SECRET_BROKER_URL` / `IRIS_SECRET_BROKER_TOKEN` | — | When set, `GET /secrets/:name` proxies here instead of env/Key Vault/store — points at the bundled iris-broker (`proxy` mode), Vault, Infisical, or any HTTP service speaking the same tiny contract |
| `IRIS_BASE_DOMAIN` / `IRIS_EMAIL_FROM` | — | Public serving domain / outbound email sender |
| `PASSTHROUGH_API_KEY` | — | Fallback API key for passthrough channels (see [Channel Modes](channel-modes.md)) |

## Models and providers

The runtime loads provider endpoints and model definitions from
`<workspace>/models.json` (generated from `data/models.json.template` at bootstrap).
Anthropic and OpenAI work out of the box; custom endpoints (Azure AI Foundry,
AWS Bedrock) are defined in the template. Switch with:

```bash
IRIS_PROVIDER=anthropic
IRIS_MODEL=claude-sonnet-4-5
```

For Azure AI Foundry, bootstrap asks for the **bare account name** (e.g.
`my-account-eastus2`), not the full endpoint URL. Pasted URLs or hostnames are
trimmed automatically, and the generated `baseUrl` is validated — bootstrap aborts
on a malformed hostname and warns if it doesn't resolve in DNS.

## MCP servers

External toolsets connect via `<workspace>/data/mcp.json` (optional,
hot-reloaded per message; secrets referenced as `${VAR}` from `.env`) — see
[MCP Servers](mcp.md).

## Internal API security

The internal API binds to loopback by default. If sub-agent containers reach Iris
via the Docker gateway (`172.18.0.1:3000`), set `IRIS_API_HOST=0.0.0.0` **and**
`IRIS_API_TOKEN` — never expose the API beyond loopback without a token. Iris logs
a warning at startup if you do.

## LLM resilience

Two mechanisms keep long-running channels healthy:

- **Retry with backoff** — failed LLM calls (429, timeout, connection reset) retry
  up to `IRIS_LLM_MAX_RETRIES` times with jittered exponential backoff, posting a
  visible `_Retrying (n/3)..._` notice.
- **Auto-compaction** — before each prompt, if the estimated context exceeds
  `IRIS_COMPACT_THRESHOLD` of the model window, Iris summarises older history down
  toward `IRIS_COMPACT_TARGET` (up to 3 passes). A post-run check at ≥70% real
  usage acts as a backstop.
