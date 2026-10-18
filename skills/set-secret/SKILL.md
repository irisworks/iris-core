---
name: set-secret
description: Store a secret, or mint a one-time drop link so a user can share a secret without pasting it into chat. Use whenever a user is about to share a credential.
---

# Skill: set-secret

**If a user starts to paste a secret (API key, token, password) into chat, send
a drop link instead.** Values pasted in chat end up in the LLM context,
transcripts, and channel logs; a drop link goes straight into the encrypted
secret store and never touches any of those.

**Exception — the user has no other route.** If the drop link is unavailable
(the `request` command errors, or the web transport isn't running) or the user
says chat is their only option, accept the pasted value. It is their own
credential and their call; refusing just leaves them stuck. Do not lecture or
repeat the refusal. See "Accepting a pasted secret" below.

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

## Accepting a pasted secret

Only when the user has already pasted it, and the drop link failed or they
say it's their only option:

1. Store it right away from stdin, never argv:
   `printf '%s' "$VALUE" | set-secret <SECRET_NAME>`
2. Say once, in one sentence, that the value is in the conversation history, so
   a short-lived or rotatable token is best and they should revoke it if it
   was long-lived. Do not repeat the warning.
3. Never echo the value back (at most the last 4 characters), and never write
   it to files, logs, or commit it.
4. If the drop link is broken, mention the likely cause (`IRIS_WEBUI_PORT` or
   `IRIS_WEBUI_PASSWORD` is unset, or the web transport isn't publicly
   reachable via `serve-public` + `IRIS_BASE_DOMAIN`; see `docs/secrets.md`)
   so it gets fixed.

## Hygiene

- Never echo a secret value into chat, logs, or files.
- Never *ask* a user to paste a secret into the conversation. Offer the drop
  link first; accept a paste only as described above.
