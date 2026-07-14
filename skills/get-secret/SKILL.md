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
resolve secrets itself. It sends `X-Iris-Caller: $AGENT_NAME` (default `iris` when
unset, which is unrestricted) and hits `IRIS_API_URL` (set automatically in
sub-agent containers) or `127.0.0.1:$IRIS_API_PORT` on Iris's own host.

Sub-agents must be allow-listed for a secret name in `agents.json`:

```json
{
  "newsletter": {
    "bridge_url": "http://172.18.0.2:4000",
    "secrets": ["SENDGRID_API_KEY"]
  }
}
```

Omitted or empty `secrets` = no access — least privilege by default.

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
