---
name: promote-skill
description: Promote a tested sub-agent skill from preview to production.
---

# Skill: promote-skill

Promote a skill from a sub-agent's preview environment to prod.
Always test in preview before promoting.

## Usage

```
promote-skill <agent-name> <skill-name>
```

## Promotion checklist

Before promoting, confirm:
- [ ] Skill works correctly in preview (manual test or automated)
- [ ] Skill file is committed to GitHub under `agents/<name>/skills/<skill>/SKILL.md`
- [ ] No hardcoded secrets in the skill
- [ ] No direct cloud provider calls (uses abstraction skills)
- [ ] Skill name is descriptive and follows kebab-case

## Implementation

```bash
#!/usr/bin/env bash
# promote-skill — restart prod container to pick up new skill from GitHub
set -euo pipefail

AGENT="${1:?Usage: promote-skill <agent-name> <skill-name>}"
SKILL="${2:?Usage: promote-skill <agent-name> <skill-name>}"
REPO_DIR="${IRIS_REPO_DIR:-/iris/repo}"

SKILL_PATH="agents/${AGENT}/skills/${SKILL}/SKILL.md"

# Verify the skill exists in GitHub (not just locally)
if ! git -C "$REPO_DIR" ls-files --error-unmatch "$SKILL_PATH" 2>/dev/null; then
  echo "[promote-skill] ERROR: $SKILL_PATH is not committed to GitHub."
  echo "  Commit it first: github-commit '$SKILL_PATH' 'feat($AGENT): add $SKILL skill'"
  exit 1
fi

echo "[promote-skill] Promoting $SKILL to $AGENT prod..."

# Pull latest from GitHub in prod's symlinked skills dir
git -C "$REPO_DIR" pull --ff-only origin main

# pi-mom's ResourceLoader auto-reloads SKILL.md files — no container restart needed
# for SKILL.md-only changes. But if this skill has TypeScript extensions, restart:
PROD_CONTAINER="iris-${AGENT}-prod"
if docker inspect "$PROD_CONTAINER" &>/dev/null; then
  echo "[promote-skill] Skill available in $PROD_CONTAINER (ResourceLoader auto-reloaded)"
else
  echo "[promote-skill] WARNING: $PROD_CONTAINER not running. Check with: docker ps"
fi

echo "[promote-skill] Done. Skill '$SKILL' is live in $AGENT prod."
```

## Notes

- SKILL.md changes hot-reload automatically (pi-mom's ResourceLoader)
- TypeScript extension changes require a container restart (systemd or `docker restart`)
- If a promoted skill breaks prod, roll back: revert the commit + `git pull` on VM
- Promotion history is in git log: `git log agents/<name>/skills/<skill>/`
