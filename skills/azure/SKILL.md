---
name: azure
description: Common Azure CLI patterns for auth, infrastructure, and operational checks.
---

# Skill: azure

> **Opt-in profile:** this skill only applies to installs running on Azure (Key Vault / Terraform profile). Local/Docker-only installs have no Azure resources.

Common Azure CLI patterns. Use these patterns consistently.
Never use Azure CLI to manage secrets directly — use the `get-secret` skill.

## Authentication

```bash
# Check current login
az account show

# Login (interactive — only needed on first boot or after token expiry)
az login

# Set subscription
az account set -s ${IRIS_AZURE_SUBSCRIPTION}
```

## Key Vault (seeding only — reading uses get-secret skill)

```bash
# Store a new secret (run this when setting up Iris for the first time)
az keyvault secret set \
  --vault-name "$IRIS_KEY_VAULT" \
  --name "SECRET-NAME" \
  --value "secret-value"

# List secrets
az keyvault secret list \
  --vault-name "$IRIS_KEY_VAULT" \
  --query "[].name" -o tsv
```

## Resource discovery

```bash
# List VMs
az vm list -g iris-rg --query "[].{name:name, ip:publicIps}" -o table

# List containers (if using ACI)
az container list -g iris-rg -o table

# Get VM public IP
az network public-ip show -g iris-rg -n iris-pip --query ipAddress -o tsv
```

## Docker on VM (via SSH)

```bash
# Check Iris container status
ssh iris@$(az network public-ip show -g iris-rg -n iris-pip --query ipAddress -o tsv) \
  "docker ps"

# View Iris logs
ssh iris@<IP> "docker logs --tail 50 iris"
```

## Notes

- Subscription ID: `${IRIS_AZURE_SUBSCRIPTION}`
- Resource group: `iris-rg`
- Never call `az keyvault secret show` to read secrets — use `get-secret` skill
- Always use managed identity for VM-to-Azure auth where possible
