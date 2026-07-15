# @iris-core/runtime

The TypeScript engine behind [Iris](../README.md) — an always-on AI orchestrator
that listens on Slack, Telegram, and a built-in web UI, executes tools (bash,
file I/O, attachments) at configurable isolation levels, and manages sub-agent
fleets over an HTTP bridge.

This package is normally built and run by `bootstrap.sh` as the `iris.service`
systemd unit. You only work in here directly when developing the runtime itself.
Operator-facing documentation (install, configuration, channel modes, skills,
sub-agents) lives in the repo-level [`docs/`](../docs/) — start there if you're
running Iris rather than hacking on her.

## Build, test, run

```bash
npm ci
npm run build     # tsc → dist/, entry point dist/main.js
npm test          # dispatch regression suite (node --test test/*.test.mjs)
bash scripts/smoke.sh   # bridge-only boot smoke test (same as CI)
```

Requires Node >= 20. CI runs build + tests + smoke on every PR (`.github/workflows/ci.yml`).

Run locally against a working directory:

```bash
iris-runtime [options] <working-directory>

Options:
  --provider / --model        LLM provider and model (see ../data/models.json.template)
  --transport                 slack | telegram | bridge (default: from env tokens)
  --sandbox=host              Tools run directly on the host (Iris herself)
  --sandbox=docker:<name>     Tools run in a Docker container (sub-agents)
  --sandbox=firecracker:<ip>  Tools run in a static Firecracker microVM
  --sandbox=firecracker-pool  Fresh microVM per channel
  --api-port                  Internal HTTP API port (default 3000)
```

Flags override environment variables; the full variable reference is in the
[root README](../README.md#configuration) and [`docs/configuration.md`](../docs/configuration.md).

For iterative development, `dev.sh` starts the runtime in tsx watch mode against
a throwaway Docker sandbox container.

## Source layout

- `src/main.ts` — entry point; pure wiring: constructs transports from env, hooks up API/bridge/events
- `src/engine.ts` — per-channel run dispatch and stop/compact/reset handling, shared by all transports
- `src/agent.ts` — the agent loop: LLM calls, retry/backoff, tool execution, context compaction
- `src/transport/` — `ChannelTransport` interface (`types.ts`), bridge and web implementations
- `src/slack.ts` / `src/telegram.ts` — Slack (Socket Mode) and Telegram transports
- `src/api.ts` — internal HTTP API: sessions, events, escalations, agent-scoped secrets
- `src/bridge.ts` — sub-agent HTTP bridge (`@agentname` routing via `agents.json`)
- `src/events.ts` — event files (immediate / one-shot / periodic) → see [`docs/events.md`](docs/events.md)
- `src/context.ts` / `src/store.ts` / `src/sessions.ts` — LLM context, channel persistence, session registry
- `src/sandbox.ts` / `src/vm-manager.ts` — host/Docker/Firecracker execution backends
- `src/secrets.ts` — pluggable secret resolution (env, Key Vault, broker)
- `src/tools/` — tool implementations (bash, read, write, edit, attach)

## Runtime docs

- [Events System](docs/events.md) — scheduled and externally-triggered wake-ups
- [Bridge Pattern](docs/bridge-pattern.md) — non-Slack ingress for sub-agents

## Changelog

Every behavior-changing PR updates [`CHANGELOG.md`](CHANGELOG.md) under
`[Unreleased]` — enforced by the docs-guard CI workflow. Release process in
[`docs/RELEASING.md`](../docs/RELEASING.md).

## License

Apache License 2.0 — see [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
