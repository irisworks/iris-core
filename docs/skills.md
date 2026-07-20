---
title: Skills
description: Hot-reloaded capability directories — anatomy, override rules, and what belongs in core vs your overlay.
---

# Skills

A skill is a directory containing a `SKILL.md` plus any scripts it needs. Skills
are injected into Iris's system prompt and **hot-reload without a restart** — edit
a `SKILL.md` and the next message uses it.

## Anatomy

```
skills/
└── send-email/
    ├── SKILL.md        # YAML frontmatter (name, description) + usage instructions
    └── send-email      # executable the skill instructs Iris to run
```

```markdown
---
name: send-email
description: Send an email via the configured provider.
---

# Skill: send-email

Usage: send-email --to <addr> --subject <s> --body <b>
...
```

## Load order and overrides

- **Workspace skills** — `<workspace>/skills/` (symlinked to the repo's `skills/`
  directory for hot reload). Available in every channel.
- **Channel skills** — `<channel>/skills/`. Override workspace skills on name
  collision, so a channel can specialize behavior without touching the global set.

## What belongs in core

Core ships **platform skills** only — things Iris needs to operate, extend, and
heal herself: `spawn-agent`, `self-heal`, `self-extend`, `get-secret`, `github`,
`send-email`, `search-web`, `serve-public`, `store-file`, `transcribe-audio`,
`schedule`, `status`, plus the opt-in `azure`, `terraform`, and
`firecracker-agent` profile skills.

Domain and business skills — cost dashboards, finance trackers, CRM integrations —
belong in your install's [overlay](overlay.md). The test: *does this skill help
Iris run the platform, or is it a task capability an operator happens to want?*

## Writing a skill

Ask Iris. The `self-extend` skill lets her scaffold, test, and commit new skills
herself — every skill she writes is committed to GitHub before use (constitution
rule 2). To write one by hand: create the directory, write `SKILL.md` with
frontmatter, drop in your script, done — no registration step.
