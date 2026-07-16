---
name: get-secret
description: Retrieve a secret through the platform abstraction instead of calling Key Vault directly.
---

# Skill: get-secret

Retrieve a secret by name. Always use this skill instead of calling Azure Key Vault directly.

## Usage

```
get-secret <SECRET_NAME>
```

Returns the secret value on stdout. Never logs it.

## How it works

This is a thin client for Iris's internal `GET /secrets/:name` route — it doesn't
resolve secrets itself. It authenticates with `IRIS_API_TOKEN` and hits
`IRIS_API_URL` (set automatically in sub-agent containers) or
`127.0.0.1:$IRIS_API_PORT` on Iris's own host.

Sub-agents must be allow-listed for a secret name in `agents.json`, with a
per-agent `token` so the API can tell them apart:

```json
{
  "newsletter": {
    "bridge_url": "http://172.18.0.2:4000",
    "secrets": ["SENDGRID_API_KEY"],
    "token": "<value from terraform/modules/agent's api_token output>"
  }
}
```

Omitted or empty `secrets` = no access — least privilege by default.

**Caller identity comes from which token authenticated the request, not from
a self-reported header.** With `unique_api_token = true` on its module block,
`terraform/modules/agent` provisions a unique `IRIS_API_TOKEN` for that agent
container (overriding the shared one from `.env`, exposed as the module's
`api_token` output); register that value as the agent's `token` in
`agents.json` and the API identifies the caller by matching the presented
bearer token, not by trusting anything the caller claims about itself. A
caller holding only its own per-agent token cannot impersonate another agent
or the unrestricted `iris` caller — including a compromised sub-agent. With
the flag off (the default) — or for an agent entry with no `token` set — the
agent authenticates with the shared `IRIS_API_TOKEN`, which is always treated
as unrestricted `iris`; give every agent that needs the allow-list enforced
its own token, copying it into `agents.json` in the same change (the agent's
API calls are 401 until it's registered).

Server-side resolution order (in `iris-runtime/src/secrets.ts`):

1. Env var (name with hyphens → underscores, e.g. `APIFY-API-KEY` → `APIFY_API_KEY`)
2. Azure Key Vault, if `IRIS_KEY_VAULT` is set and the secret wasn't in env
3. If `IRIS_SECRET_BROKER_URL` is configured, that's used instead of 1–2 — whatever
   sits behind it (Vault, Infisical, a custom shim) is the operator's choice; this
   skill and the API route have no vendor-specific code.

## `sync-secrets` (optional, legacy)

`get-secret` no longer needs `/iris/.secrets.env` pre-populated — it resolves live
against the API on every call, so a stale local snapshot is no longer a source of
truth. `sync-secrets` still exists for anything else that reads `--env-file
/iris/.secrets.env` directly rather than going through this skill:

```bash
IRIS_KEY_VAULT=<your-vault-name> bash /iris/data/skills/get-secret/sync-secrets
```

## Notes

- Secret names in Key Vault use hyphens (`APIFY-API-KEY`), env vars use underscores (`APIFY_API_KEY`)
- Never print secret values in logs
- The script exits 1 if the API call fails (secret not found, caller not allow-listed, or the API is unreachable)
