---
title: Troubleshooting
description: Operating the service, logs, and fixes for common failures.
---

# Troubleshooting

## Operating the service

```bash
sudo systemctl status iris      # health
sudo journalctl -u iris -f      # logs
sudo systemctl restart iris     # restart (state is on disk; nothing is lost)
```

If `start` silently does nothing, the built JS is probably missing — rebuild first:

```bash
cd /iris/repo/iris-runtime && npm install && npm run build
sudo systemctl start iris
```

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| `iris.service` fails to start | Missing env vars | Check `/iris/.env` and `journalctl -u iris` |
| Slack messages ignored | Wrong channel mode | Check `data/channels.json` — default mode needs an `@iris` mention outside DMs |
| Telegram bot silent | Bot not claimed | Send the claim token printed at startup — see [Setup](SETUP.md#telegram-setup) |
| `Timed out waiting for LLM response` | Provider rate limits | Retries are automatic; tune `IRIS_LLM_MAX_RETRIES` / `IRIS_LLM_TIMEOUT_SECS` |
| Slack reply arrives as an `iris-reply.md` file with an error notice | Slack rejected the message (`msg_too_long`) even after automatic re-splitting — usually extremely formatting-dense content (Slack counts `&`, `<`, `>` as their escaped entities) | The full reply is in the attached file; lower `IRIS_SLACK_MAX_CHARS` if it recurs |
| Every reply is `Error: Connection error` | LLM endpoint hostname doesn't resolve (e.g. malformed Foundry `baseUrl` in `models.json`) | Check `getent hosts <host>` for the `baseUrl` host; re-run `bootstrap.sh --setup` with the bare Foundry account name |
| Runs hang forever with nothing in the logs, on a `models.json` provider (`azure-foundry`/`deepseek`/`mistral`/`custom`) under `store`/`proxy` mode | The provider's `"apiKey"` names an env var that `store`/`proxy` mode scrubbed after migrating the real key; the resolver echoed the var *name* as the key, so the request went out with a literal string (e.g. `MISTRAL_API_KEY`) as the bearer token and the provider silently 401'd | Fixed in current `iris-runtime` — `getApiKey()` detects the echoed config string and falls through to the broker/env lookup. Confirm the key is in the store (`iris-secret list`) and restart `iris` |
| API returns 401 | `IRIS_API_TOKEN` set | Send `Authorization: Bearer <token>` |
| `@agentname` reply is `Bridge request failed.` (504) or `Failed to write event.` (500) | Sub-agent didn't answer within 60s, or its events dir isn't writable | Bridge responses are deliberately generic — the detailed error is in the **sub-agent's** logs (`journalctl` / container logs, `[bridge]` lines) |
| Internal API error body is generic (`"session not found"`, `"session message failed"`, `"internal server error"`) | Expected — responses are sanitized on purpose | Check `journalctl -u iris` for the underlying error (`log.logWarning`) |
| `/dev/kvm` not found | VM series without KVM | On Azure, resize to Ddsv5 (e.g. `Standard_D4ds_v5`) |
| `firecracker: permission denied` | Not in kvm group | `sudo usermod -aG kvm $USER`, re-login |
| VM boots but `/health` times out | exec-server not started | `journalctl -u iris-fc-<name>` |
| Jailer fails to chroot | `irisjailer` user missing | `sudo groupadd -g 10000 irisjailer; sudo useradd -u 10000 -g 10000 -r -s /usr/sbin/nologin irisjailer` |
| rootfs missing | Build script not run | `sudo bash scripts/build-firecracker-rootfs.sh` |
| `build-firecracker-rootfs.sh` fails with `tar: ... Cannot write: No space left on device` | Old script version hardcoded the rootfs image at 2048MiB, smaller than the `iris-runtime:local` export | Pull the latest `scripts/build-firecracker-rootfs.sh` — it now sizes the image from the actual export plus headroom — and re-run |

## Inspecting the last prompt

Each channel directory in the workspace (`<workspace>/slack/<channel>`, `<workspace>/telegram/<channel>`, or `<workspace>/SESSION-...` for virtual channels) contains a `last_prompt.jsonl` with the exact context of the most recent run — system prompt, message history, the new user message, and the image attachment count. It is written asynchronously on a best-effort basis (a failed write logs a warning and never fails the run) and is stored as compact JSON, so pretty-print it when reading:

```bash
jq . <workspace>/slack/<channel>/last_prompt.jsonl | less
```

## Firecracker VM reset

```bash
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

Dynamic-pool VMs reset automatically on session reset or idle timeout.
