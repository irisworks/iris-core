---
name: github
description: Commit and push repo changes to GitHub using plain git.
secrets: [GITHUB-TOKEN]
---

# Skill: github

Commit and push changes to GitHub. All skills must be committed before use.
GitHub is Iris's long-term memory. The VM is ephemeral.

## Repo location

The git repo is `/iris/repo` — **not** `/iris`. `/iris` is the install root
(env file, data dirs, skills symlink) and is never itself a git repository.
If a git command fails with "not a git repository", the fix is to target
`/iris/repo`, not to `git init` in `/iris`.

Commit identity (`user.name`/`user.email`) is already configured locally in
`/iris/repo` by bootstrap — plain `git commit` just works, no `-c` flags or
wrapper needed.

## Rules

1. Always commit before deploying or applying
2. Commit message should describe what changed and why
3. Never commit `.env` files, secrets, or `*.tfstate`
4. Push immediately after committing — don't let commits sit local-only
5. If GitHub is unreachable, halt and escalate to the operator
6. Always push to `main` — never invent a feature/test branch
7. Before pushing, confirm `${IRIS_GITHUB_ORG}/${IRIS_GITHUB_REPO}` (lowercased)
   is not `irisworks/iris-core` — that's the public upstream this install was
   forked from, and Iris's own memory/skill commits must never land there. If
   it is, halt and escalate to the operator instead of pushing.

## Usage

```bash
cd /iris/repo
git add <path>
git commit -m "<message describing what changed and why>"
git push "https://${GITHUB_TOKEN}@github.com/${IRIS_GITHUB_ORG}/${IRIS_GITHUB_REPO}.git" main
```

`GITHUB_TOKEN`, `IRIS_GITHUB_ORG`, and `IRIS_GITHUB_REPO` are already set in
`/iris/.env` on any bootstrapped install — read them from there rather than
asking the operator to re-supply a PAT or set up SSH. If they're unset, say
so and point at `/iris/.env`.

Pushing the full remote URL with the token inline (rather than rewriting
`origin`) avoids permanently mutating the repo's remote — `origin` on a fresh
clone points at the public upstream it was cloned from, not this install's
private overlay, so leave it alone.

## Common operations

```bash
# Commit a new skill
cd /iris/repo && git add skills/my-new-skill/SKILL.md && \
  git commit -m "feat: add my-new-skill"

# Commit terraform changes
cd /iris/repo && git add terraform/ && git commit -m "infra: add digest agent containers"

# Check status
cd /iris/repo && git status && git log --oneline -5
```

## Notes

- Org: configured via `IRIS_GITHUB_ORG`, Repo: configured via `IRIS_GITHUB_REPO`
- If a push fails due to conflicts: `git pull --rebase origin main` then retry
- If GitHub rejects the push over permissions, that's GitHub's own access
  control doing its job — halt and escalate rather than working around it
