---
name: self-heal
description: Escalate failures to Iris via shared events directory.
---

# Skill: self-heal

Escalate to Iris when the crossword solver encounters a failure it cannot fix.

## Usage

```bash
self-heal --reason "Description of failure" [--severity warning|error|critical]
```

## Implementation

Writes an immediate event to the shared `/iris/data/events` directory.
Iris monitors this queue and will respond.

## Script

- `{baseDir}/self-heal` — Escalation script
