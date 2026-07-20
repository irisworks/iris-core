---
name: set-secret
description: Store a secret, or mint a one-time drop link so a user can share a secret without pasting it into chat. Use whenever a user is about to share a credential.
---

# Skill: set-secret

**If a user starts to paste a secret (API key, token, password) into chat — stop
them and send a drop link instead.** Values pasted in chat end up in the LLM
context, transcripts, and channel logs; a drop link goes straight into the
encrypted secret store and never touches any of those.

## Request a secret from a user (the common case)

```
set-secret request <SECRET_NAME> [--channel <channelId>] [--ttl <seconds>]
```

Prints a one-time link (path, and full URL when `IRIS_BASE_DOMAIN` is set).
Relay it to the user: they open it, paste the value into a form, and submit.
The link is single-use and expires (default 15 minutes). When `--channel` is
passed, a name-only notification lands back in that conversation once the
secret arrives — so pass the current channel id and you'll hear about it.

Secrets whose name matches an injection-gateway service (see
`docs/secrets.md`) default to **proxy-only**: usable through the broker
gateway, never readable in plaintext — by anyone.

Requires a writable secrets backend (`IRIS_SECRETS_MODE=store` or `proxy`)
and the web transport (`IRIS_WEBUI_PORT`); the API replies 503 with guidance
otherwise. Only share drop links over HTTPS (serve-public) or an SSH tunnel.

## Store a secret Iris already holds

For secrets Iris provisions herself (e.g. a token she just created via `gh`):

```
printf '%s' "$VALUE" | set-secret <SECRET_NAME> [--proxy-only]
```

Value is read from stdin — never pass it as an argument (argv leaks into
process listings and shell history).

## Hygiene

- Never echo a secret value into chat, logs, or files.
- Never ask a user to paste a secret into the conversation — that is exactly
  what this skill exists to prevent.
