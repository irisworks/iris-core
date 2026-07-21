---
title: Secrets
description: The opt-in credential broker — encrypted store, injection proxy, and out-of-band secret submission.
---

# Secrets

By default (`IRIS_SECRETS_MODE=env`), Iris reads credentials from `/iris/.env`
exactly as every release before this one — nothing on this page applies until
you opt in. The two opt-in modes exist because the default has a sharp edge:
everything in `.env` is loaded into the runtime's environment, agent shell
commands inherit that environment, and a single `env` or `cat /iris/.env` in a
tool call can leak every credential into the conversation.

Pick a mode at bootstrap (`bootstrap.sh --secrets-mode=store` or
`--secrets-mode=proxy`) or set `IRIS_SECRETS_MODE` in `/iris/.env` and follow
the migration section below.

## What each mode protects against

| Mode | Protects against |
|---|---|
| `env` (default) | Nothing new — status quo. |
| `store` | Accidental leakage: `env` dumps, `cat /iris/.env`, sub-agent `--env-file` inheritance, plaintext store backups. The agent shares a uid with the runtime, so it can still read the key file; `get-secret` still returns plaintext. |
| `proxy` | All of the above, **plus**: key/store files are owned by a dedicated `iris-broker` user the agent cannot read as, and secrets marked *proxy-only* can never be read in plaintext by anyone — only exercised through the injection gateway. |

Honest limits: in `store` mode encryption-at-rest mainly stops *accidental*
leaks, not a deliberately malicious agent on the same uid. `proxy` mode adds a
real uid boundary for key material and a hard no-read guarantee for proxy-only
secrets; secrets that CLI tools need in plaintext (`aws`, `az`, `gh`) remain
extractable by design, backstopped by output redaction (below).

## The three tiers (proxy mode)

**Tier 1 — injection gateway (proxy-only secrets).** The broker daemon maps
service names to upstreams and auth headers. A caller hits
`http://127.0.0.1:9099/proxy/<service>/<path>` with
`Authorization: Bearer $IRIS_SECRET_BROKER_TOKEN` and *no credential*; the
broker injects the stored secret into the configured header and forwards over
TLS (streaming, so SSE works). Plaintext reads of proxy-only secrets return
403 for **every** token — the value can be used, never seen. Bundled services:
`resend`, `github`, `anthropic`, `openai`, `slack`; operators add more in
`/iris/broker/services.json`:

```json
{
  "myapi": {
    "upstream": "https://api.example.com",
    "secret": "MYAPI-KEY",
    "headers": { "Authorization": "Bearer {value}" }
  }
}
```

**Tier 2 — brokered plaintext.** Secrets consumed by CLI tools resolve via the
`get-secret` skill → internal API → broker, subject to per-agent allow-lists
(`agents.json`). Encrypted at rest, never in `.env` or the process
environment.

**Tier 3 — output redaction.** The runtime remembers every plaintext value its
provider resolved and masks those exact strings in command output before it
reaches the model or transcripts. Best-effort: transformed values (base64,
split lines) pass through.

## Storage

Secrets live in a single JSON file encrypted per-entry with AES-256-GCM
(Node's built-in crypto — no extra dependencies). Metadata (name, timestamps,
source, flags) stays readable without decryption; values never are.

| Mode | Key file | Store file | Owner |
|---|---|---|---|
| `store` | `/iris/secret.key` | `/iris/secrets.json.enc` | runtime user |
| `proxy` | `/iris/broker/secret.key` | `/iris/broker/secrets.json.enc` | `iris-broker` |

Both files are 0600; paths are overridable via `IRIS_SECRET_KEY_FILE` /
`IRIS_SECRET_STORE_FILE`.

## Getting secrets in — never through chat

Pasting a credential into chat puts it in the LLM context, transcripts, and
channel logs. Both routes below bypass all three.

**Drop links (any user, no shell access).** Iris mints a one-time link
(`set-secret request NAME --channel <id>`, or `POST /secret-drops` on the
internal API) and relays it. The user opens `/secret-drop/<token>` on the web
transport, pastes the value into a form, and submits; the link burns
(single-use, default 15-minute expiry) and a *name-only* notification lands
back in the requesting conversation. Requires `IRIS_WEBUI_PORT`; share links
only over HTTPS (`serve-public`) or an SSH tunnel. Links don't survive a
runtime restart — ask Iris for a fresh one.

**`iris-secret` CLI (operators over SSH).**

```bash
iris-secret set MYAPI-KEY            # value from stdin or hidden prompt — never argv
iris-secret set MYAPI-KEY --proxy-only
iris-secret list                     # names + metadata, never values
iris-secret rm MYAPI-KEY
iris-secret import-env /iris/.env --prune   # migrate known secret vars out of .env
```

The CLI talks to the broker daemon in proxy mode and to the store file
directly in store mode.

## Migration from `.env`

Re-running `bootstrap.sh --secrets-mode=<mode>` does everything: generates the
key (and, for proxy, the `iris-broker` user + `iris-broker.service` systemd
unit), then runs `iris-secret import-env /iris/.env --prune`, which moves the
known credential vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `IRIS_SLACK_APP_TOKEN`, `IRIS_SLACK_BOT_TOKEN`,
`TELEGRAM_BOT_TOKEN`, `GITHUB_TOKEN`, `RESEND_API_KEY`, `AZURE_FOUNDRY_KEY`,
`DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`) into
the store and rewrites `.env` without them. Idempotent; unknown vars are left
alone, and anything not yet migrated keeps resolving via the env fallback.

What stays in `.env`: non-secret config plus the two capability tokens
(`IRIS_API_TOKEN`, `IRIS_SECRET_BROKER_TOKEN`). Those are what the agent is
*supposed* to hold — they grant allow-listed reads and gateway use, not the
key material, and not proxy-only plaintext. After startup the runtime also
deletes migrated credential vars (and `IRIS_WEBUI_PASSWORD`) from its own
process environment, so `env` in an agent shell comes back clean. Anything
`aws`/`az`-shaped that used to read env vars directly should switch to
`KEY=$(get-secret NAME)`.

## Sub-agents

With `secrets_mode = "store"` or `"proxy"` on `terraform/modules/agent`, the
container no longer receives `--env-file /iris/.env`. It gets only its
identity, `IRIS_API_URL`, a **required** per-agent token
(`unique_api_token = true`), and `IRIS_SECRET_BROKER_URL` pointing at the
parent's API — the child runtime resolves secrets through the parent's
`/secret/:name` route under its own allow-list. Each agent's `agents.json`
entry must therefore list everything it needs, **including its LLM key**:

```json
{
  "newsletter": {
    "secrets": ["ANTHROPIC-API-KEY", "RESEND-API-KEY"],
    "token": "<terraform module output api_token>"
  }
}
```

See [Sub-agents](sub-agents.md) for the full workflow.

## Internal API surface

All routes require the usual bearer auth (see [Configuration](configuration.md));
writes and listing are iris-only.

| Route | Purpose |
|---|---|
| `GET /secrets/:name` (alias `GET /secret/:name`) | Resolve plaintext (allow-listed; 403 for proxy-only/runtime-only secrets) |
| `PUT /secrets/:name` | Store `{value, proxyOnly?, agentReadable?}` |
| `DELETE /secrets/:name` | Delete |
| `GET /secrets` | Names + metadata, never values |
| `POST /secret-drops` | Mint a one-time submission link `{name, channelId?, ttlSeconds?, proxyOnly?}` |

`agentReadable: false` marks a secret the runtime may use internally but the
API will never serve — enforced at the API layer, unlike `proxyOnly`, which
the broker enforces for every caller.

## External brokers and Key Vault

Unchanged: point `IRIS_SECRET_BROKER_URL` at Vault, Infisical, or any HTTP
service answering `GET /secret/:name` and iris-core uses it instead of the
bundled backends; the Azure Key Vault fallback (`IRIS_KEY_VAULT`) still works
in env/store modes. The bundled broker is deliberately the same contract — a
child Iris can even use its parent as its broker.
