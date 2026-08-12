---
name: github
description: Commit and push repo changes to GitHub using the standard Iris workflow.
secrets: [GITHUB-TOKEN]
---

# Skill: github

Commit and push changes to GitHub. All skills must be committed before use.
GitHub is Iris's long-term memory. The VM is ephemeral.

## Rules

1. Always commit before deploying or applying
2. Commit message should describe what changed and why
3. Never commit `.env` files, secrets, or `*.tfstate`
4. Push immediately after committing — don't let commits sit local-only
5. If GitHub is unreachable, halt and escalate to the operator

## Usage

```
github-commit <path> <message>
```

## Implementation

```bash
#!/usr/bin/env bash
# github — commit and push to ${IRIS_GITHUB_ORG}/${IRIS_GITHUB_REPO}
set -euo pipefail

REPO_DIR="${IRIS_REPO_DIR:-/iris/repo}"
COMMIT_PATH="${1:?Usage: github-commit <path-relative-to-repo> <message>}"
COMMIT_MSG="${2:?Usage: github-commit <path-relative-to-repo> <message>}"

cd "$REPO_DIR"

# Refuse to push anywhere but a configured, non-upstream, private repo — don't
# fall through to whatever 'origin' happens to be (the iris-core clone itself).
if [[ -z "${GITHUB_TOKEN:-}" || -z "${IRIS_GITHUB_ORG:-}" || -z "${IRIS_GITHUB_REPO:-}" ]]; then
  echo "[github] GITHUB_TOKEN / IRIS_GITHUB_ORG / IRIS_GITHUB_REPO not fully configured — halting. Set them in /iris/.env." >&2
  exit 1
fi

if [[ "${IRIS_GITHUB_ORG,,}/${IRIS_GITHUB_REPO,,}" == "irisworks/iris-core" ]]; then
  echo "[github] IRIS_GITHUB_ORG/IRIS_GITHUB_REPO points at irisworks/iris-core — refusing to push Iris's own commits (memory, skills) to the public upstream. Point it at your own private overlay or mirror; see docs/overlay.md." >&2
  exit 1
fi

# Commit as Iris without touching global or repo git config
git remote set-url origin "https://${GITHUB_TOKEN}@github.com/${IRIS_GITHUB_ORG}/${IRIS_GITHUB_REPO}.git"

if command -v gh &>/dev/null; then
  VISIBILITY=$(GH_TOKEN="$GITHUB_TOKEN" gh repo view "${IRIS_GITHUB_ORG}/${IRIS_GITHUB_REPO}" --json visibility -q .visibility 2>/dev/null || echo "")
  if [[ "$VISIBILITY" == "PUBLIC" ]]; then
    echo "[github] ${IRIS_GITHUB_ORG}/${IRIS_GITHUB_REPO} is a public repo — refusing to push. This repo carries Iris's memory and skills, and must be private." >&2
    exit 1
  fi
fi

git add "$COMMIT_PATH"
iris-git commit -m "$COMMIT_MSG"
git push origin main

echo "[github] Committed and pushed: $COMMIT_MSG"
```

## Common operations

```bash
# Commit a new skill
github-commit "skills/my-new-skill/SKILL.md" "feat: add my-new-skill"

# Commit a sub-agent skill
github-commit "agents/digest/skills/send-digest/SKILL.md" "feat(digest): add send-digest skill"

# Commit terraform changes
github-commit "terraform/" "infra: add digest agent containers"

# Check status
cd /iris/repo && git status && git log --oneline -5
```

## Notes

- Always use `iris-git commit` (not `git commit`) — `iris-git` is a wrapper that sets `user.name=Iris user.email=${GIT_USER_EMAIL}` without touching global or repo config
- GitHub token is fetched via: `GITHUB_TOKEN=$(get-secret GITHUB-TOKEN)`
- Org: configured via `IRIS_GITHUB_ORG`, Repo: configured via `IRIS_GITHUB_REPO`
- Branch: `main` (always push to main — Iris does not use feature branches)
- If a push fails due to conflicts: `git pull --rebase origin main` then retry
