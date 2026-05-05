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

## Resolution order

1. Env var (name with hyphens → underscores, e.g. `APIFY-API-KEY` → `APIFY_API_KEY`)
2. Azure Key Vault (`IRIS_KEY_VAULT` env var must be set)

## Keeping containers fast on reload

Run `sync-secrets` on the host whenever a secret is added or rotated:

```bash
IRIS_KEY_VAULT=<your-vault-name> bash /iris/data/skills/get-secret/sync-secrets
```

This writes all KV secrets to `/iris/.secrets.env` (chmod 600).
All containers should mount it with `--env-file /iris/.secrets.env` so every secret
is available as an env var — no KV calls needed at runtime, no auth delay on restart.

## Notes

- Secret names in Key Vault use hyphens (`APIFY-API-KEY`), env vars use underscores (`APIFY_API_KEY`)
- Never print secret values in logs
- If `IRIS_KEY_VAULT` is not set and secret not in env, the script exits 1
