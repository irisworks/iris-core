---
name: status
description: Read-only health snapshot of this Iris install — service state, disk, sub-agent containers, recent errors, and message-processing check. Use when asked "are you healthy", "what's your status", or when diagnosing problems.
---

# Skill: status

One read-only health snapshot of the install. Prints, in order:

1. `iris.service` state (systemd), skipped gracefully off-systemd hosts
2. Host basics — uptime, load, disk usage of the workspace and root filesystems
3. Sub-agent containers (`docker ps`, `iris-*` names), skipped if Docker absent
4. Recent runtime errors (`journalctl -u iris`, last 10 error/warning lines)
5. Message-processing check — whether the most recent human message in a channel
   log has a bot response after it

Nothing here alerts or restarts anything. To escalate a problem this surfaces,
use `self-heal` (event queue) or `send-email`; to restart, that's an operator
decision (`sudo systemctl restart iris`).

## Usage

```bash
status                  # full snapshot; message check uses $IRIS_STATUS_CHANNEL if set
status <channelId>      # snapshot + message check for a specific channel
```

The message check reads `<workspace>/<channelId>/log.jsonl`
(workspace root from `$IRIS_STORAGE_ROOT`, default `/iris/data`). Channel IDs are
always passed in — never hardcoded.

## Notes

- Safe to run anywhere, including inside sub-agent containers (sections that
  don't apply are skipped with a note).
- Requires `jq` for the message check; the rest is plain coreutils.
- Exit code is 0 unless the message check finds an unanswered human message
  (exit 1), so it can be used from a scheduled event as a cheap probe.
