---
name: terraform
description: Opt-in Azure/Terraform profile only — plan and apply Terraform changes using the safe Iris workflow.
---

# Skill: terraform

> **Opt-in profile:** this skill only applies to installs using the Azure/Terraform profile. Local/Docker-only installs have no Terraform-managed infrastructure — do not use this skill there.

Apply Terraform changes safely. Always plan before applying. Always commit before applying.

## Rules

1. Never `terraform apply` without `terraform plan` first
2. Never apply if `plan` shows unexpected destroys — pause and report
3. Always commit the `.tf` files to GitHub before applying
4. Always run from `/iris/repo/terraform`
5. State lives in Azure Storage — never commit `.tfstate` files

## Usage

```
terraform-apply [target]
```

Where `[target]` is an optional `-target=<resource>` argument for partial applies.

## Implementation

```bash
#!/usr/bin/env bash
# terraform — safe plan + apply
set -euo pipefail

REPO_DIR="${IRIS_REPO_DIR:-/iris/repo}"
TF_DIR="${REPO_DIR}/terraform"
TARGET="${1:-}"

cd "$TF_DIR"

echo "[terraform] Running plan..."
if [[ -n "$TARGET" ]]; then
  terraform plan -target="$TARGET" -out=iris.tfplan
else
  terraform plan -out=iris.tfplan
fi

# Abort if plan shows destroys (safety check)
DESTROYS=$(terraform show -json iris.tfplan 2>/dev/null \
  | jq '[.resource_changes[] | select(.change.actions[] == "delete")] | length' 2>/dev/null || echo 0)

if [[ "$DESTROYS" -gt 0 ]]; then
  echo "[terraform] WARNING: Plan includes $DESTROYS resource deletions."
  echo "[terraform] Review the plan output above. Apply manually if intentional:"
  echo "  cd $TF_DIR && terraform apply iris.tfplan"
  exit 1
fi

echo "[terraform] Applying..."
terraform apply iris.tfplan
rm -f iris.tfplan

echo "[terraform] Done."
```

## Notes

- Terraform state: Azure Storage Account per install (see `terraform/backend.tf` for backend-config), container `tfstate`
- If state is locked: `terraform force-unlock <lock-id>` (use with care)
- New resources: write the `.tf` file → commit → run this skill
- Destroying resources: must be intentional and confirmed before proceeding

## Child agent terraform

Child agents are provisioned using the `modules/agent` module.
See `spawn-agent` skill for the full workflow.
