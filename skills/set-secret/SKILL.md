---
name: set-secret
description: Store a secret, or ask a user for one out of band (Slack form or one-time drop link) so it never goes through chat. Use whenever a user is about to share a credential.
---

# Skill: set-secret

**If a user starts to paste a secret (API key, token, password) into chat —
offer an out-of-band route first.** Values pasted in chat end up in the LLM
context, transcripts, and channel logs; the routes below go straight into the
encrypted secret store and never touch any of those.

## Request a secret from a user (the common case)

```
set-secret request <SECRET_NAME> --channel <channelId> [--ttl <seconds>]
```

Always pass the current channel id. The runtime picks the first route that
works for this conversation:

1. **Slack** — posts an "Enter SECRET_NAME" button; the user clicks it and
   types the value into a private form. Nothing to relay — just tell the user
   to click the button.
2. **Drop link** — prints a one-time link. Relay it: the user opens it, pastes
   the value into a form, and submits. The URL is `https://IRIS_BASE_DOMAIN/…`
   when serve-public is set up, otherwise a temporary cloudflared tunnel URL
   when `cloudflared` is installed.
3. **Local path only** — no public URL is available; the link works only for
   someone who can reach this host's web UI directly.

Requests are single-use and expire (default 15 minutes). A name-only
notification lands back in the conversation once the secret arrives — you'll
hear about it.

Secrets whose name matches an injection-gateway service (see
`docs/secrets.md`) default to **proxy-only**: usable through the broker
gateway, never readable in plaintext — by anyone.

Requires a writable secrets backend (`IRIS_SECRETS_MODE=store` or `proxy`).
Drop links (routes 2–3) also need the web transport (`IRIS_WEBUI_PORT`).

## Last resort: the user pastes the value in chat

Never *ask* for a paste. Accept one only when:

- `set-secret request` failed, or only printed a local path the user can't
  reach, or
- the user reports the Slack button doesn't open a form, or
- the user says chat is their only option.

Then:

1. Store it from stdin — never argv:
   `printf '%s' "$VALUE" | set-secret <SECRET_NAME>`
2. Warn once, in one sentence: the value is now in the conversation history,
   so prefer a short-lived or rotatable token and rotate it if that matters.
3. Never echo it back (last 4 characters at most), and never write it to
   files or logs.
4. If the request failed, say why in one line (from the error), e.g. the web
   transport is off (`IRIS_WEBUI_PORT`), no `IRIS_WEBUI_PASSWORD` /
   serve-public + `IRIS_BASE_DOMAIN` for remote users, or Slack Interactivity
   not enabled — so the operator can fix it for next time.

## Store a secret Iris already holds

For secrets Iris provisions herself (e.g. a token she just created via `gh`):

```
printf '%s' "$VALUE" | set-secret <SECRET_NAME> [--proxy-only]
```

Value is read from stdin — never pass it as an argument (argv leaks into
process listings and shell history).

## Hygiene

- Never echo a secret value into chat, logs, or files.
- Never ask a user to paste a secret into the conversation — offer
  `set-secret request` first; a paste is only accepted as the last resort above.
