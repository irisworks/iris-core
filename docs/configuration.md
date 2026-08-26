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
| `IRIS_SESSION_TIMEOUT_MS` | `90000` | How long `POST /sessions/:id/message` waits for a reply before returning a 504 |
| `IRIS_BRIDGE_PORT` / `IRIS_BRIDGE_HOST` | — / `127.0.0.1` | Sub-agent bridge server (sub-agents only) |
| `IRIS_BRIDGE_IDLE_TIMEOUT_MS` / `IRIS_BRIDGE_MAX_MS` | `180000` / `600000` | Bridge request lifetime: no-progress deadline, and hard ceiling ([Sub-agents](sub-agents.md)) |
| `IRIS_BRIDGE_HEARTBEAT_MS` / `IRIS_BRIDGE_LEGACY_TIMEOUT_MS` | `15000` / `240000` | Streaming keepalive cadence; ceiling for non-streaming bridge requests |
| `IRIS_BRIDGE_STATUS_THROTTLE_MS` | `3000` | Minimum gap between chat edits when forwarding sub-agent progress |
| `IRIS_LLM_TIMEOUT_SECS` | `90` | Per-attempt LLM timeout |
| `IRIS_LLM_MAX_RETRIES` / `IRIS_LLM_RETRY_BASE_MS` | `3` / `2000` | Retry with exponential backoff on 429/timeout/transient errors |
| `IRIS_COMPACT_THRESHOLD` / `IRIS_COMPACT_TARGET` | `0.7` / `0.1` | Pre-run auto-compaction trigger/target (fraction of context window) |
| `IRIS_SLACK_MAX_CHARS` | `30000` | Safe Slack message length before splitting |
| `IRIS_ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | `10000` | How long a live Slack message bound-waits for its own file attachments to finish downloading before dispatching for processing anyway — see [Troubleshooting](troubleshooting.md) |
| `IRIS_INTERRUPTED_RUN_MAX_AGE_HOURS` | `4` | On startup, don't re-dispatch an interrupted run whose user message is older than this. Stale placeholders are still cleaned up; only the LLM run is skipped. Raise it if you want long outages resumed, set it very high to always resume |
| `IRIS_TELEGRAM_FORCE_RECLAIM` | — | Set `true` + restart to transfer bot ownership |
| `IRIS_VERBOSE_TOOLS` | — (quiet) | Default verbose tool-call/thinking output on Slack/Telegram. Quiet by default — a run shows a single status line that updates in place instead of a full per-tool-call/thinking dump. Overridable per channel at runtime with `verbose on` / `verbose off` / `verbose status` (Slack) or `/verbose on|off|status` (Telegram) — see [Channel Modes](channel-modes.md#verbose-tool-output) |
| `IRIS_BASH_POLICY` | on | Set `off` to disable the bash policy layer's refusals and confirmation gates (the command audit log stays on) — see [Bash Policy Layer](bash-policy.md) |
| `IRIS_BASH_AUDIT_FILE` | `<workspace>/meta/bash-audit.log` | Location of the append-only bash command audit log — see [Bash Policy Layer](bash-policy.md) |
| `IRIS_GITHUB_ORG` / `IRIS_GITHUB_REPO` | — | The repo Iris commits her own skills, sub-agents, and self-edits to (the `github` skill's push target — see [Extending Iris](overlay.md)). Use your own private overlay repo, or a private mirror of `iris-core` — never the upstream you cloned from, and never a public fork, since Iris's memory lands here. Prompted by bootstrap alongside the GitHub token; also injected into the constitution as Iris's identity source |
| `IRIS_KEY_VAULT` | — | Azure Key Vault name (Key Vault profile only) |
| `IRIS_SECRETS_MODE` | `store` | `store` (default) \| `proxy` \| `env` (legacy opt-out) — credential backend, see [Secrets](secrets.md) |
| `IRIS_SECRET_KEY_FILE` / `IRIS_SECRET_STORE_FILE` | `/iris/secret.key` / `/iris/secrets.json.enc` | Encrypted store paths (`store` mode) |
| `IRIS_BROKER_PORT` / `IRIS_BROKER_HOST` | `9099` / `127.0.0.1` | iris-broker daemon bind (`proxy` mode) |
| `IRIS_BROKER_SERVICES_FILE` | `/iris/broker/services.json` | Operator overrides for the injection gateway's service map |
| `IRIS_SECRET_BROKER_URL` / `IRIS_SECRET_BROKER_TOKEN` | — | When set, `GET /secrets/:name` proxies here instead of env/Key Vault/store — points at the bundled iris-broker (`proxy` mode), Vault, Infisical, or any HTTP service speaking the same tiny contract |
| `IRIS_BASE_DOMAIN` / `IRIS_EMAIL_FROM` | — | Public serving domain / outbound email sender |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | — | Presence enables Langfuse tracing (one session-correlated trace per turn). `LANGFUSE_HOST`, `LANGFUSE_ENVIRONMENT`, `LANGFUSE_RELEASE`, `LANGFUSE_TIMEOUT_MS`, `LANGFUSE_ENABLED=false`, `LANGFUSE_CAPTURE_IO=false` (drop prompt/reply/tool payloads) tune it — see [Observability](observability.md) |
| `PASSTHROUGH_API_KEY` | — | Fallback API key for passthrough channels (see [Channel Modes](channel-modes.md)) |

## Models and providers

The runtime loads provider endpoints and model definitions from
`<workspace>/models.json` (generated from `data/models.json.template` at bootstrap).
Anthropic and OpenAI work out of the box; custom endpoints (Azure AI Foundry,
DeepSeek, Mistral, AWS Bedrock) are defined in the template. Switch with:

```bash
IRIS_PROVIDER=anthropic
IRIS_MODEL=claude-sonnet-4-5
```

For Azure AI Foundry (`azure-foundry`), bootstrap asks for the **bare account
name** (e.g. `my-account-eastus2`), not the full endpoint URL. Pasted URLs or
hostnames are trimmed automatically, and the generated `baseUrl` is validated —
bootstrap aborts on a malformed hostname and warns if it doesn't resolve in DNS.
Its `Kimi-K2.5` / `Kimi-K2.6` entries declare `"input": ["text", "image"]` —
both are natively multimodal.

Each model entry's `"input"` array is a capability declaration, not a hint:
`pi-ai` strips image content out of the request for any model that doesn't
list `"image"`, silently on the wire. Iris now catches this at her end too —
an image attachment sent to a text-only model is diverted into a
`<dropped_image_attachments>` note in the prompt (and a logged warning)
instead of being sent and vanishing, and the `read` tool reports the same
file as unreadable rather than claiming success. If a model here does accept
images but a Slack/Telegram photo isn't getting through, check `"input"` for
that model id first.

Separately, "is this attachment an image" is decided from the file's actual
content (magic-byte sniffing), not its filename or extension — a Telegram
document with no filename, or any attachment with a missing/wrong extension,
is still recognized correctly. If `"input"` includes `"image"` and an
attachment still isn't picked up, it likely isn't a supported format (jpeg,
png, gif, webp).

An image over 2000px on its longest edge or 4.5MB once base64-encoded is
downscaled before it's sent — an unresized phone photo can otherwise exceed
a provider's per-image payload limit and fail the whole turn. This is
automatic and has no env var to tune; a decode failure just falls back to
sending the original size as-is. An animated GIF or WebP over those limits
is sent as-is rather than resized, to avoid silently collapsing it to a
single still frame.

A PDF attachment is listed in the prompt like any other non-image file; the
`read` tool then extracts its text layer via the core-shipped `pdf-text`
[read handler](read-handlers.md) (`pdftotext` from `poppler-utils`, installed
by `bootstrap.sh`) rather than handing the model raw binary. A scanned or
image-only PDF has no text layer and reads back empty — there's no OCR
fallback in core, so a photo of a document should be sent as an image
instead, or an overlay can add its own OCR-capable handler.

The `openai` provider defaults to `gpt-5.6-luna` (`gpt-5.4-mini` and
`gpt-5.6-terra` are also available) and uses `pi-ai`'s `openai-responses`
module, not `openai-completions` — these models 400 on `/v1/chat/completions`
when tool calls are present unless `reasoning_effort` is explicitly `"none"`,
which `openai-completions` has no way to force. Do not switch it back to
`openai-completions`.

DeepSeek (`deepseek`) and Mistral (`mistral`, including Devstral) need only an
API key — both go through `pi-ai`'s `openai-completions` provider module,
since Mistral's `/v1/chat/completions` endpoint is OpenAI-compatible and
`pi-ai`'s native `mistral` provider module hangs indefinitely on every call
(see the Fixed entry in `iris-runtime/CHANGELOG.md` — do not switch Mistral's
`api` back to `"mistral"`). Both ship ready-to-use model entries in the
template (`deepseek-chat` / `deepseek-reasoner`, `devstral-medium-latest` /
`mistral-large-latest` / `mistral-medium-latest`). `mistral-medium-latest` (Mistral Medium 3.5 — 256k context window, text+image input)
is the largest-context model in the Mistral lineup; `devstral-medium-latest` and
`mistral-large-latest` remain selectable.

For any other OpenAI-compatible endpoint (Kimi/Moonshot direct, a self-hosted
vLLM/Ollama gateway, etc.), pick `custom` — bootstrap asks for a short provider
name (used as the `models.json` key), the base URL, the API key, and the exact
model id the endpoint expects, and writes a fresh `openai-completions` provider
block. To add one without bootstrap, add a block by hand — see
[data/README.md](../data/README.md) for the shape.

> `azure-foundry` was named `foundry-e2` before this repo supported more than
> one custom provider; the name was a leftover from its original `eastus2`
> deployment. Bootstrap migrates `IRIS_PROVIDER=foundry-e2` and the
> `FOUNDRY_E2_KEY`/`FOUNDRY-E2-KEY` secret automatically on re-run, but a
> hand-edited `models.json` needs its `foundry-e2` key renamed manually.

## MCP servers

External toolsets connect via `<workspace>/meta/mcp.json` (optional,
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
  `IRIS_COMPACT_THRESHOLD` (default 70%) of the model window, Iris summarises
  older history down toward `IRIS_COMPACT_TARGET` (up to 3 passes). This is a
  char-count estimate over the system prompt and message history computed
  *before* the new turn's message (and any image attachments) is appended, so
  it can't see an oversized attachment in the turn that introduces it — the
  post-run check at ≥70% real usage (hardcoded, not env-configurable) is the
  backstop that catches that case, using actual token counts from the
  provider's response.

## Prompt caching

Anthropic and Bedrock cache the prompt on a strict byte-for-byte prefix match:
any change anywhere in the system prompt invalidates the entire cached prefix
(tools + system + full message history) for that turn. The system prompt is
kept fully static across turns for a given channel and skill set — `MEMORY.md`
contents and live MCP server connection status, both of which change turn to
turn, are prepended to the current turn's user message instead (visible as a
`<dynamic_context>` block in `last_prompt.jsonl`), after the cached history,
where their churn doesn't invalidate anything. The Slack/Telegram channel/user
directory embedded in the system prompt is also sorted by id before
rendering, rather than left in `Map` insertion order — insertion order
reorders every time a new user or channel is discovered, which would
invalidate the cache even though nothing about the directory's actual content
changed.

Iris's per-channel `Agent` is constructed with `sessionId` set to the channel
id. Anthropic and Bedrock ignore it — they cache off explicit `cache_control`
breakpoints — but `pi-ai`'s `openai-responses` provider forwards it as
`prompt_cache_key`, and Mistral's native provider uses it for the
`x-affinity` header (KV-cache prefix affinity). Channel id is a stable,
natural session boundary since each channel already gets its own long-lived
runner and message history.
