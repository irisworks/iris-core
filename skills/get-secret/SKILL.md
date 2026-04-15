---
name: get-secret
description: Retrieve a secret through the platform abstraction instead of calling Key Vault directly.
---

# Skill: get-secret

Retrieve a secret by name. Always use this skill instead of calling Azure Key Vault directly.
This abstraction keeps all skills cloud-portable — if we move from Azure to GCP or AWS,
only this skill changes.

## Usage

```
get-secret <SECRET_NAME>
```

Returns the secret value on stdout. Never logs it.

## Implementation

```bash
#!/usr/bin/env bash
# get-secret — cloud-portable secret retrieval
# Checks env vars first (fast, no az required), falls back to Azure Key Vault.
set -euo pipefail

SECRET_NAME="${1:?Usage: get-secret <SECRET_NAME>}"

# Env var lookup: convert hyphens to underscores (e.g. FOUNDRY-E2-KEY -> FOUNDRY_E2_KEY)
ENV_VAR=$(echo "$SECRET_NAME" | tr '-' '_')
VALUE="${!ENV_VAR:-}"

if [[ -n "$VALUE" ]]; then
  echo "$VALUE"
  exit 0
fi

# Fall back to Azure Key Vault for secrets not in env
KV="${IRIS_KEY_VAULT:?IRIS_KEY_VAULT env var not set — secret not in env either}"
az keyvault secret show \
  --vault-name "$KV" \
  --name "$SECRET_NAME" \
  --query value \
  -o tsv 2>/dev/null
```

## Notes

- Secret names in Key Vault use hyphens, not underscores (e.g., `ANTHROPIC-API-KEY`)
- Returns empty string if secret not found (caller should validate)
- Never print the value in logs or output beyond what is strictly necessary
- If `IRIS_KEY_VAULT` is not set, the container is misconfigured — escalate to Iris

## Example

```bash
ANTHROPIC_KEY=$(get-secret ANTHROPIC-API-KEY)
# use $ANTHROPIC_KEY in your API call, never echo it
```
