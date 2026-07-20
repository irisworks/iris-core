---
name: self-extend
description: Define the protocol Iris follows when creating new reusable skills.
---

# Skill: self-extend

Protocol for writing new skills. Follow this every time you add a capability.

## The protocol

1. **Identify the need** — what action are you trying to take that you can't do yet?
2. **Write the SKILL.md** — in `skills/<skill-name>/SKILL.md`
3. **Commit to GitHub** — before using the skill
4. **Test it** — invoke the skill once with a safe test case
5. **Update README** — add the skill to the capabilities table

## SKILL.md template

```markdown
# Skill: <name>

One sentence: what does this skill do and why does it exist.

## Usage

<how to invoke it>

## Implementation

```bash
#!/usr/bin/env bash
# <name> — <description>
set -euo pipefail

# implementation here
```

## Notes

- Any gotchas, edge cases, or important context
- Links to external docs if relevant
```

## Rules for skills

1. **One skill = one responsibility.** Don't build a swiss army knife.
2. **Skills are bash scripts or instructions.** Keep them simple.
3. **Skills must work inside Docker sandbox.** Assume clean environment.
4. **Secrets are always fetched via `get-secret`.** Never hardcoded.
5. **Files are always stored via `store-file`.** Never raw paths.
6. **Cloud calls use abstraction skills.** Never call Azure/AWS/GCP directly.
7. **Test with a safe case before relying on it.** Invoke the skill once with harmless inputs; confirm no hardcoded secrets, a descriptive kebab-case name, and that it is committed before use.

## Example: writing a new skill for sending a Slack message

```bash
# 1. Write the skill
mkdir -p /iris/repo/skills/slack-notify
cat > /iris/repo/skills/slack-notify/SKILL.md << 'EOF'
# Skill: slack-notify
...
EOF

# 2. Commit
github-commit "skills/slack-notify/SKILL.md" "feat: add slack-notify skill"

# 3. Test (iris-runtime reloads skills automatically)
slack-notify "#iris-dev" "test message from iris"
```
