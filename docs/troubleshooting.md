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
| Every reply is `Error: Connection error` | LLM endpoint hostname doesn't resolve (e.g. malformed Foundry `baseUrl` in `models.json`) | Check `getent hosts <host>` for the `baseUrl` host; re-run `bootstrap.sh --setup` with the bare Foundry account name |
| API returns 401 | `IRIS_API_TOKEN` set | Send `Authorization: Bearer <token>` |
| `@agentname` reply is `Bridge request failed.` (504) or `Failed to write event.` (500) | Sub-agent didn't answer within 60s, or its events dir isn't writable | Bridge responses are deliberately generic — the detailed error is in the **sub-agent's** logs (`journalctl` / container logs, `[bridge]` lines) |
| `/dev/kvm` not found | VM series without KVM | On Azure, resize to Ddsv5 (e.g. `Standard_D4ds_v5`) |
| `firecracker: permission denied` | Not in kvm group | `sudo usermod -aG kvm $USER`, re-login |
| VM boots but `/health` times out | exec-server not started | `journalctl -u iris-fc-<name>` |
| Jailer fails to chroot | `irisjailer` user missing | `sudo groupadd -g 10000 irisjailer; sudo useradd -u 10000 -g 10000 -r -s /usr/sbin/nologin irisjailer` |
| rootfs missing | Build script not run | `sudo bash scripts/build-firecracker-rootfs.sh` |

## Firecracker VM reset

```bash
sudo systemctl stop iris-fc-public-sandbox
sudo cp --sparse=always \
  /var/lib/iris/firecracker/rootfs.ext4 \
  /var/lib/iris/firecracker/agents/public-sandbox/rootfs.ext4
sudo systemctl start iris-fc-public-sandbox
```

Dynamic-pool VMs reset automatically on session reset or idle timeout.
