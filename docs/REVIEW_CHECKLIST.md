---
title: PR Review Checklist
description: Internal checklist for reviewing iris-core PRs — architecture fit first, then invariant-specific correctness checks.
---

# PR Review Checklist

Internal doc, not part of the public docs site navigation — a working reference for
reviewing PRs against this repo's actual invariants, not generic style advice.

## Fast pass — architecture and approach

Check these before reading line-by-line. Failing any of these means redirect the PR
(comment with the concern) rather than proceeding to a detailed review — a
correctly-implemented wrong approach still needs to be rejected.

- [ ] **Engine stays transport-agnostic.** Does this PR add any Slack- or
      Telegram-specific code, types, or string literals to `src/agent.ts` or
      `src/engine.ts`? Both should only reference `transport/types.ts` shapes
      (`MessageContext`, `TransportEvent`, `ChannelTransport`,
      `TransportPromptProfile`). A new "if transport === slack" branch in either
      file is the wrong layer — it belongs in `slack.ts`/`telegram.ts` or on the
      transport's `TransportPromptProfile`.
- [ ] **Does this duplicate `ChannelTransport`?** A new transport (or a
      transport-shaped helper) should implement the interface in
      `transport/types.ts` and plug into `createEngine`'s dispatch — not grow a
      parallel bespoke integration path bolted onto `main.ts`.
- [ ] **Does this duplicate per-channel state?** `engine.ts`'s
      `channelStates: Map<string, ChannelState>` (via `getState`/`getOrCreateRunner`)
      is the one place run/store/stop state lives. A PR that adds its own
      channel-keyed `Map` for similar bookkeeping should instead extend
      `ChannelState` or route through the engine.
- [ ] **Skill boundary respected.** Core skills (`skills/`) must be
      platform-operation skills usable by any install; anything
      client/domain-specific (a particular API integration, a client's business
      logic) belongs in an overlay (`docs/overlay.md`), not committed to core.
- [ ] **No new fork-shaped divergence.** If the PR reimplements something that
      already has a near-identical counterpart elsewhere in the file (a second
      near-copy of a handler, a second copy of a chunking/splitting function), a
      shared helper is very likely already there or should be — this is
      literally the bug class Phase 2 exists to kill (see `engine.ts`'s
      history: it replaced two duplicated Slack/Telegram handlers).
- [ ] **Stacked-PR check.** If the PR branches off another open PR, confirm it's
      a real functional dependency (the diff needs types/functions the base PR
      introduces) and not just "I happened to branch here." A convenience stack
      needlessly blocks unrelated work — flag it and suggest rebasing onto `main`.

## Detail pass — invariant-specific correctness

Each item below is checkable against a specific file, not aspirational.

- [ ] **Slack envelopes ack exactly once.** Every `socketClient.on("app_mention"
      | "message", ...)` handler in `src/slack.ts` must call `ack()` exactly
      once per invocation, including on the error path. The existing pattern is
      `let acked = false` + `ackOnce()` wrapper + `try/catch/finally { ackOnce()
      }` (see `setupEventHandlers()` around line 787). A new handler or an edit
      that adds an early `return` before `ackOnce()` breaks this — a missed ack
      causes Slack to redeliver and repeat the failure.
- [ ] **Channel directory resolution goes through `resolveChannelDir`/
      `resolveChannelPath`.** Nothing should hand-build a channel's on-disk path
      (`workingDir + channelId`, `slack/${id}`, etc.) — always call
      `resolveChannelDir(workingDir, channelId)` (`src/store.ts`). It encodes the
      Slack/Telegram/virtual-channel (`SESSION-`, `BRIDGE-`, `ESCALATE-`,
      `SELFHEAL-`, `WEBUI`) split; a hand-built path silently drifts from it the
      next time that split changes.
- [ ] **`TransportEvent`/`MessageContext` fields aren't skipped.** If a PR adds
      or touches a context factory (`createSlackContext`/`createTelegramContext`
      in `slack.ts`/`telegram.ts`), the returned object must satisfy
      `MessageContext` in `transport/types.ts` in full — in particular
      `transportId` must be stamped correctly (`"slack" | "telegram" |
      "bridge"`), since `agent.ts` uses it to look up the prompt profile via
      `getPromptProfile(ctx.transportId)` and throws if none is registered.
- [ ] **New transport-specific prompt text lives on `TransportPromptProfile`,
      not in `agent.ts`.** `buildSystemPrompt` in `agent.ts` must stay free of
      hardcoded Slack/Telegram strings — formatting rules, identity lines,
      attachment tag names, etc. all come from the `profile` parameter. `grep
      -ri slack src/agent.ts` should return nothing (this was IRIS-49's
      acceptance bar and should stay true).
- [ ] **Wildcard channel config resolves through one path.** Any new
      per-channel setting in `channels.json` must be read via
      `resolveChannelConfig`/its wrapper getters in `slack.ts` (exact match,
      else longest matching wildcard prefix) — not a second ad hoc
      `channelConfigs.get(id)` lookup that skips wildcard resolution. This
      exact bug (`requireMentionForTopLevel` working for exact IDs but not
      wildcards) was fixed in PR #37 and is covered by
      `iris-runtime/test/dispatch.test.mjs`.
- [ ] **Unknown/malformed `channels.json` entries fail closed, not
      half-open.** `loadChannelModes()` must reject an entry with an unrecognized
      `mode` outright (skip it, log a warning) rather than applying some fields
      (e.g. `requireMentionForTopLevel`) while ignoring others. Covered by the
      `"config: unknown mode entry is skipped entirely"` test — if a PR touches
      `loadChannelModes()`, that test must still pass.
- [ ] **API endpoints requiring auth check `IRIS_API_TOKEN` via
      `bearerTokenMatches`.** Any new endpoint in `startApiServer`
      (`src/api.ts`) other than `GET /health` is gated by the existing
      `apiToken && !bearerTokenMatches(...)` check near the top of the request
      handler — don't add a second, parallel auth check, and don't add an
      endpoint before that gate.
- [ ] **Secrets never land in a channel/session log or a passthrough error
      path.** `resolvePassthroughKey` (`slack.ts`) resolves via
      `PASSTHROUGH_API_KEY` or the `get-secret` skill and must never write the
      resolved value into `log.jsonl`, `last_prompt.jsonl`, or a posted Slack/
      Telegram message. If a PR adds a new secret-bearing config field, check it
      isn't logged anywhere the way `text`/`payload` fields are.
- [ ] **Every behavior-changing PR updates `iris-runtime/CHANGELOG.md` under
      `[Unreleased]` and the relevant `docs/` page**, or carries the
      `changelog-not-needed`/`docs-not-needed` label. This is enforced by
      `.github/workflows/docs-guard.yml` against paths matching
      `iris-runtime/src/`, `skills/`, `scripts/`, `agents/`, `bootstrap.sh`,
      `install.sh` — but the CI gate only checks a file was touched, not that
      the content is adequate. Review the changelog entry for accuracy, not just
      presence.

## Leave to tooling

Don't manually check what CI already checks — spend review time on the invariants
above instead:

- **Formatting, lint, unused imports** — not currently enforced by a dedicated
  lint step; if one gets added, defer to it entirely rather than commenting on
  style.
- **Type correctness** — `npm run build` (`tsc -p tsconfig.build.json`) is
  strict-mode TypeScript; if it compiles, don't re-derive type errors by eye.
- **Dispatch regression coverage** — `npm test` (`iris-runtime/test/`) exercises
  the channel-mode × message-path matrix end-to-end against the compiled
  output. If a PR touches dispatch logic and this suite passes, trust it over
  re-tracing every mode by hand; if a PR *should* have added a test case here
  and didn't, that's a detail-pass finding, not a re-derivation of the existing
  ones.
- **Smoke boot** — `scripts/smoke.sh` verifies the bridge-only boot path stays
  alive; don't manually re-verify basic startup if it's green.
- **Secret scanning** — `gitleaks` runs on every PR against full git history;
  don't manually grep for committed secrets, but do still apply the "secrets
  never land in a log" invariant above, which gitleaks can't see (it's about
  runtime behavior, not committed content).
