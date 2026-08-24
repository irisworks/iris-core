---
title: Bash Policy Layer
description: Hard refusals, human confirmation for destructive commands, and the append-only command audit log that screen every bash tool call.
---

# Bash Policy Layer

Every command the `bash` tool runs passes a policy layer before execution
(`iris-runtime/src/engine/tools/bash-policy.ts`, wired in `bash.ts`). It has
three parts: hard refusals, confirmation-gated destructive commands, and an
append-only audit log. It is on by default; `IRIS_BASH_POLICY=off` disables the
refusals and confirmations as an explicit escape hatch (auditing stays on).

## What it is not

**Shell pattern-matching is not a security boundary.** A determined model or an
injected instruction can trivially bypass string matching (base64, variables,
`eval`, indirect tools like MCP or skills). The real boundary is the uid Iris
runs as, systemd confinement, network rules, and the [secrets](secrets.md)
modes. This layer exists to catch *accidents* and low-effort injection, and to
give operators forensics after the fact. Nothing here should be relied on
against an adversarial model.

## Hard refusals

These commands fail immediately with a tool error — no confirmation path:

- Reads of secret files: `.env`, `secret.key`, `secrets.json.enc`, `agents.json`
  (basename matching with boundary checks — `.env.example` is still readable)
- Requests to cloud instance metadata endpoints (`169.254.169.254`,
  `metadata.google.internal`, `100.100.100.100`)

## Confirmation required

Destructive commands are blocked with an instruction to the model: ask the user
in chat, end the turn, and only re-run the exact same command after an explicit
affirmative reply. The grant is single-use, keyed to the exact command string,
and consumed on the next run of that command in the same channel.

Matched patterns:

- `rm -rf /` and near-root variants (`/*`, top-level system dirs like `/etc`)
- `mkfs*` and `dd ... of=/dev/*`
- `terraform destroy`
- `git push --force` / `--force-with-lease` / `-f` to `main`, `master`, or `release/*`
- Writes to `/etc/passwd`, `sudoers*`, `authorized_keys`, `sshd_config`
  (reading them stays allowed)
- `systemctl disable|mask iris.service`

How the human approval is verified: when a command is held for confirmation,
the channel id plus a hash of the command are remembered in memory. On a retry
of the same command, the channel's `log.jsonl` is scanned for a non-bot message
posted after the request whose text starts with an affirmation (`yes`,
`approve`, `go ahead`, `ok`, ...). If found, the command runs once. Anything
else — bot messages, unrelated replies, a different command — keeps the block.
A restart clears pending requests; the model simply asks again.

This flow works identically on every transport because it is conversational:
the model asks in its normal channel reply and the next user message either
unlocks the retry or doesn't.

## Audit log

Every bash command appends one JSONL line to the audit log:

```json
{"date":"2026-08-23T12:00:00.000Z","channelId":"tg-123","command":"terraform destroy","decision":"confirmation-required","exitCode":null}
```

`decision` is one of `executed`, `denied`, `confirmation-required`,
`confirmed`. The default location is `<workspace>/meta/bash-audit.log`;
`IRIS_BASH_AUDIT_FILE` overrides it. The writer only ever opens the file in
append mode — it never truncates or rewrites — and auditing failures never
break command execution.

### Making it tamper-resistant

Out of the box, Iris's own uid can still truncate the file. To make entries
survive an attempt by the agent to erase them, put the log outside Iris's
write scope and set the append-only attribute:

```bash
sudo install -d -o root -g "$TARGET_USER" -m 0750 /var/log/iris
sudo touch /var/log/iris/bash-audit.log
sudo chown "$TARGET_USER:$TARGET_USER" /var/log/iris/bash-audit.log
sudo chattr +a /var/log/iris/bash-audit.log   # append-only, survives truncation attempts
echo 'IRIS_BASH_AUDIT_FILE=/var/log/iris/bash-audit.log' >> /iris/.env   # then restart iris.service
```

With `chattr +a`, even the file owner can append but not truncate, rename, or
remove it (only root can lift the attribute). Note that the *content* of
commands may include whatever the agent typed; ship the file to your log
pipeline if retention matters.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IRIS_BASH_POLICY` | on | Set `off` to disable refusals and confirmations (audit log stays on) |
| `IRIS_BASH_AUDIT_FILE` | `<workspace>/meta/bash-audit.log` | Audit log location |
