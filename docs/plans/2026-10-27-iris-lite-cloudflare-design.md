---
title: "Design: Iris Lite — serverless Iris on Cloudflare Workers"
description: Design proposal for a lighter, single-tenant Iris that runs on Cloudflare Workers and Durable Objects, deployable in minutes and later hostable by iris-cloud.
---

# Design: Iris Lite — serverless Iris on Cloudflare Workers

Status: draft for review. Not yet implemented. Tracking issue:
[#304](https://github.com/irisworks/iris-core/issues/304). Two decisions are
still open and block the build; see [Open questions](#open-questions).

## Context

Iris today is a long-lived process on a Linux VM. It runs as `iris.service`
under systemd, reads `/iris/.env`, keeps every channel's history and memory as
files under the workspace directory, and gives the agent a host shell. That is
the right shape for an operator who owns a VM. It is the wrong shape for
handing Iris to someone else:

- Someone has to provision, patch and pay for a VM before Iris says anything.
- `iris-cloud` gets per-user isolation by running a Firecracker microVM per
  user, with an orchestrator, pool manager and image pipeline around it. That
  is a lot of machinery to manage.

**Iris Lite** is a second way to run Iris. It is a Cloudflare Worker with one
Durable Object per conversation. It is deployed into the user's own Cloudflare
account and costs nothing while idle. The rollout has two steps:

1. **Self-serve.** A "Deploy to Cloudflare" path from this repo. One deploy is
   one Iris.
2. **iris-cloud.** iris-cloud hosts many Lite deploys, one per customer,
   instead of one VM per customer.

Lite does not replace `iris-runtime`. The VM install remains the full-power
option: host shell, `az`, `terraform`, sub-agent VMs.

## Goals and non-goals

Goals:

- A new user can go from a Cloudflare account to chatting with their own Iris
  over the web and Telegram in a few minutes, with no server to run.
- Conversations, memory and schedules survive evictions, crashes and
  redeploys.
- The agent can do useful work without a shell: run code in a sandbox, use
  the web through a real browser, and call MCP tools.
- The control-plane can manage a Lite deploy through the same HTTP contract
  it uses for a VM Iris.
- The same build later runs, unchanged, as one tenant inside iris-cloud.

Non-goals for the first version:

- Multi-tenancy inside one deploy. Tenancy and RBAC stay in the control-plane,
  as they do for core.
- Feature parity with core's host shell, and skills that need host binaries
  (`az`, `terraform`, `systemctl`, `docker`). See [Skills](#skills).
- Sub-agent VMs and the bridge (`/bridge`) protocol.
- Slack. It is planned as an add-on after the first version.
- A free-plan deploy. See [Plan requirements](#plan-requirements-and-cost).

## Decisions taken so far

From the brainstorm with the maintainer on 2026-10-27:

| Topic | Decision |
|---|---|
| Where it lives | Its own package in this repo, next to `iris-runtime/`. Not a fork. |
| Tenancy | One deploy = one Iris, single-tenant. The control-plane owns tenancy and RBAC. |
| Engine | `@earendil-works/pi-durable` with the Cloudflare Agents SDK `PiHarness`. Not `pi-coding-agent`. |
| Built in | A code-execution sandbox and a browser tool, for using the web for tasks. |
| Optional | A Linux sandbox for CLIs, repo work and test suites. Gated on a command-approval flow. |
| Skills | Each skill declares what it needs; a deploy only offers skills it can run. |
| Channels | Web UI and Telegram by default. Slack later as an add-on. |

## What the spike showed

A throwaway spike (local `wrangler dev` only; nothing was deployed and no real
model was called) tried both engines inside workerd, Cloudflare's runtime.

**Current engine (`pi-coding-agent` 1.0).** `iris-runtime/src/engine/agent.ts`
builds on `AgentSession`, `SessionManager`, `ModelRuntime` and the skills
loader from this package.

- The Worker crashes at startup: `pi-coding-agent/dist/config.js` calls
  `fileURLToPath(import.meta.url)` at module load.
- With a one-line shim it loads. But workerd's `node:fs` `/tmp` is
  per-request, so a file written in one request is gone in the next.
  `SessionManager` keeps history in `context.jsonl`, so history would vanish
  between messages.
- `child_process` is unavailable, so every built-in tool (read, write, edit,
  bash all go through a shell executor) is dead.
- Bundle: 1.37 MB gzip.

**`pi-durable` + `PiHarness`.**

- Bundle: 226 KB gzip.
- A prompt, a tool call and the answer all work end to end.
- Submitting the same operation id twice (a redelivered webhook) runs the
  tool once.
- Each channel's Durable Object is isolated from the others.
- The transcript and SQLite-backed memory survive a workerd restart, and the
  memory reaches the model's prompt afterwards.

**Conclusion.** Porting the current engine means fighting the platform. Lite
is built on `pi-durable`, and the Iris-specific behaviour in `agent.ts` is
re-expressed as a Pi extension rather than imported.

## Architecture

```
                 ┌──────────────── one Cloudflare Worker (one deploy = one Iris) ────────────────┐
 Telegram ──────▶│ /telegram/webhook ─┐                                                          │
 Browser ───────▶│ /  (Web UI, WS)  ──┼──▶ IrisChannel DO  (one per conversation)                │
 Control-plane ─▶│ /sessions/* API  ──┘      PiHarness + "iris" extension                        │
                 │                           transcript, inbox, tasks  → DO SQLite               │
                 │                           workspace files           → DO SQLite (+R2 mount)    │
                 │                              │ RPC                                             │
                 │                              ▼                                                 │
                 │                    IrisWorkspace DO  (singleton)                               │
                 │                      global MEMORY.md, settings, constitution                  │
                 │                      session registry, Telegram claim                          │
                 │                      secrets (encrypted), schedules (alarm)                    │
                 └──────┬───────────────┬──────────────────┬──────────────────┬─────────────────┘
                        ▼               ▼                  ▼                  ▼
                  AI Gateway     Dynamic Workers     Browser Run       Sandbox container
                  (models)       (code execution)    (headless Chrome)  (optional shell)
```

Two Durable Object classes:

- **`IrisChannel`**, one per conversation: a Web UI thread, a Telegram chat,
  or an API session. It runs the Pi harness, keeps the transcript, inbox and
  tasks in its own SQLite (`pi_*` tables), and owns that conversation's
  workspace files. This replaces `ChannelQueue` and the per-channel directory.
  Pi already serialises work per session and queues input that arrives while
  a run is in flight.
- **`IrisWorkspace`**, a singleton (`getByName("workspace")`): the state that
  is global to one Iris today. That covers the global `MEMORY.md`, settings,
  constitution override, session registry, Telegram claim, secrets and
  schedules. Channel objects read it over RPC.

Pi's own documentation recommends one Durable Object per conversation, using
the root session, because session ids can't be chosen. Using a whole object
per conversation also covers a Pi gap: Pi cannot delete a conversation, but
deleting a conversation in Lite can be `ctx.storage.deleteAll()` on its
object.

### Mapping from iris-runtime

| iris-runtime today | Iris Lite |
|---|---|
| `iris.service` process, `main.ts` | Worker `fetch` handler + two DO classes |
| `ChannelQueue` per channel (`engine/channel-queue.ts`) | One `IrisChannel` DO; Pi's inbox queues or steers |
| `context.jsonl` / `SessionManager` | Pi transcript in DO SQLite |
| `log.jsonl` (human history) | Derived from Pi transcript entries (`messages()`) |
| Channel dir files, `attachments/`, `scratch/` | Workspace filesystem in the channel DO's SQLite |
| `<ws>/MEMORY.md` and `<channel>/MEMORY.md` | Workspace DO file / channel workspace file, rendered as prompt sections |
| `meta/sessions.json` (`engine/sessions.ts`) | Session registry table in the workspace DO |
| `events/*.json` + `fs.watch` + croner (`engine/events.ts`) | Schedules in the workspace DO, driven by its alarm |
| `secret-store.ts` encrypted file / env / broker | Encrypted rows in the workspace DO, key from a Worker secret |
| `transports/telegram` long polling | Telegram webhook |
| `transports/web` WebSocket server | DO WebSocket on the channel object |
| `transports/slack` Socket Mode | Later: Slack Events API over HTTP |
| `engine/api.ts` internal API | Same routes, implemented in the Worker (see below) |
| `Executor` (host, docker, bwrap, firecracker) | Code sandbox by default; container sandbox optional |
| `models.json` + `ModelRuntime` | `createAI` from `agents/models/pi-ai`, through AI Gateway |
| `mcp.json`, stdio and HTTP | HTTP (Streamable HTTP) only |
| `langfuse.ts` (plain `fetch`, OTLP) | Same exporter; it has no Node dependencies |

## The agent

### The `iris` extension

Pi takes tools and system-prompt sections from extensions installed on a
registry. Iris Lite installs one extension, `iris`, which carries what
`agent.ts` assembles by hand today:

- **Sections.**
  - `constitution`: the base Iris prompt, with a workspace override like
    `CONSTITUTION.md`.
  - `memory`: global plus channel `MEMORY.md`.
  - `skills`: index of available skills.
  - `channel`: transport, channel id and formatting rules, taken from today's
    `TransportPromptProfile`.

  Pi renders sections before every request. It appends a new system entry to
  the transcript only when a section's text changes, so an unchanged memory
  costs nothing on later turns. Today Iris injects memory as a
  `<dynamic_context>` block in the user message and strips it afterwards
  (`engine/context.ts`). Sections replace that.
- **Tools.** Covered in [Capabilities](#capabilities).

### Limits Iris has to add

Pi Durable has no maximum number of tool rounds and no spend budget; its
settings have neither. In the spike, a model that kept calling the same tool
ran about 150 rounds before compaction stopped it. Lite adds a
`GenerationTask` `afterTools` hook. It counts rounds per run and aborts the
run with a clear message past a limit (proposed default 50, configurable).
The same hook can enforce a token or cost ceiling per run, using Pi's usage
records.

Pi handles the rest:

- compaction (on by default; it also compacts and retries once when a
  provider rejects a request as too long)
- retries with backoff
- crash recovery (an alarm restarts the object; tools marked
  `replay: "safe"` run again, others report "interrupted" to the model)

### Long runs

Pi's wake-up job runs inside Durable Object alarms. An alarm invocation lasts
at most 15 minutes, and the harness hands off to a new alarm every 10. A
single model response that streams for more than 15 minutes can be cut off.
In practice this matters only for very long reasoning responses; it should be
documented, not designed around.

## Capabilities

### Workspace files and code execution

Cloudflare's Agents SDK provides a workspace (`@cloudflare/computer`):

- a filesystem stored in the Durable Object's SQLite, with an optional
  read-only R2 mount
- `exec`, which runs JavaScript modules in a fresh, throwaway Dynamic Worker
  (60-second default timeout, 180 maximum)

Network access from executed code is off by default. A deploy can pass an
outbound handler to allow, filter or rewrite it. Cloudflare's reference Pi
app uses this workspace.

Lite uses it for both of the following:

- **File tools**: `read`, `write`, `edit`, `ls`, `grep`. They work on the
  channel's workspace, which replaces the channel directory, `scratch/` and
  `attachments/`.
- **`run_code`**: executes JavaScript against the workspace.

Pi also ships its own code mode (`pi-durable/codemode`), which runs scripts in
QuickJS and makes each tool call durable. On Cloudflare it needs the sandbox
in a separately deployed Worker; running it inline blocks the conversation's
object. One Worker per deploy matters for the Deploy button (see
[Deployment](#deployment-and-distribution)), so the Agents SDK workspace is
the default. Pi's code mode stays an option for "code that calls many tools",
for example when MCP servers expose many tools.

### Browser

The Agents SDK has a ready-made Pi browser tool (`agents/browser/pi`). It
drives headless Chrome through Cloudflare's Browser Run service and gives each
conversation its own tab. Quick actions (page to markdown, extract) need only
the browser binding. Scripted browsing (click, fill, screenshot) also needs
the Dynamic Worker loader. Idle tabs stay open for 10 minutes by default and
idle time is billed.

This covers "use the web for a task": checking a dashboard, filling a form,
scraping a page, taking a screenshot. Running a repo's Playwright test suite
is not covered; that needs the optional sandbox.

### Optional Linux sandbox

A deploy can enable a container sandbox (Cloudflare Sandbox SDK / Containers).
The conversation's object starts a container and runs commands in it, with
streamed output. This brings back `bash` for CLIs, `git` and test suites.

- **Lifetime.** The container stops shortly after its object goes idle; an
  inactivity timeout can keep it up to 6 hours.
- **Disk.** Lost on stop unless it is snapshotted or mounted from R2.
- **Cost.** Billed per vCPU-second and memory-second, on top of an included
  monthly allowance.

**Approval comes first.** Iris on a VM blocks destructive commands until the
user confirms in chat (`engine/tools/bash-policy.ts`). Pi Durable has no
approval step. Its `beforeTool` hook can block a call but cannot pause and
wait. The pattern that works with Pi today:

1. A `beforeTool` hook runs the existing bash policy (ported as a pure
   function). On "needs confirmation" it blocks the call with the reason, and
   the model tells the user it needs approval.
2. The user's "yes" in chat, or an approval button in the Web UI, is
   submitted with `entry: { kind: "app.approval", data }` and records the
   approved command.
3. The hook lets that exact command through once.

The sandbox is not offered until this flow and its tests exist.

### MCP

Only remote MCP servers over Streamable HTTP are supported, because stdio
needs a process. The Agents SDK has an MCP client (with OAuth token storage).
Pi Durable has no MCP client, so Lite adds a small bridge that exposes each
server tool as an `mcp__<server>__<tool>` Pi tool. That matches today's naming
(`engine/mcp/tools.ts`). Large tool sets are registered as deferred tools
behind Pi's tool search. The config keeps today's `mcp.json` shape for HTTP
entries and is stored in the workspace object.

## Skills

Most of today's skills assume a shell and a filesystem. The model reads
`SKILL.md` and runs the skill's scripts with bash (`agent.ts`
`formatSkillsForPrompt`).

The Agents SDK provides a skills extension for Pi. It adds `activate_skill` and
`read_skill_resource` tools and a skills prompt section. Skills are loaded from
the bundle, from R2, or from a manifest. **Skill scripts do not run under
Pi.** The model can read a skill's instructions and resources but not execute
them.

Lite therefore adds one optional frontmatter field:

```yaml
requires: [shell]        # or: browser, code, mcp:<server>; absent = instructions only
```

A deploy offers a skill only when every requirement is available. A skill
with no field is treated as instructions-only.

Today's skills fall into four groups:

| Group | Skills | In Lite |
|---|---|---|
| Host CLIs | azure, terraform, firecracker-agent, spawn-agent, upgrade-iris, serve-public, status, github | Not offered (need host binaries or `systemctl`). `github` could return with the optional sandbox. |
| Shell scripts that call HTTP APIs | get-secret, set-secret, send-email, search-web, transcribe-audio, self-heal | Rewritten as instructions plus `run_code`, or replaced by built-in tools (secrets, schedule) |
| Shell scripts that write files | schedule, store-file, mcp | Replaced by built-in tools on the workspace object |
| Instructions only | self-extend | Works as is |

Skills bundled with Lite ship in the Worker. Skills the user adds go to R2 (or
the workspace object) and are listed together; on a name conflict the user's
skill wins, like channel skills over global skills today.

## Scheduling

Today's events are JSON files in `events/`, watched with `fs.watch` and timed
with in-memory `setTimeout` and croner (`engine/events.ts`). Lite keeps the
same three types and fields:

- `immediate`
- `one-shot` with `at`
- `periodic` with `schedule` and `timezone`

They are stored as rows in the workspace object. That object's alarm fires the
next due event. Firing submits `[EVENT:…] text` to the target channel object,
exactly as today's delivery does, with the event id plus fire time as the
operation id, so a retried alarm doesn't deliver twice. A built-in `schedule`
tool replaces the `schedule` skill's file writes.

Schedules live in the workspace object, not in channel objects, on purpose.
`PiHarness` already uses each channel object's alarm, and the docs don't say
how a second scheduler would share it.

## Channels

### Web UI

- **Connection.** The browser connects over WebSocket to the conversation's
  channel object. Cloudflare's hibernating WebSockets mean an idle open tab
  costs nothing.
- **Streaming.** The object streams the conversation's Pi events and maps
  them to today's frame kinds (`thinking`, `status`, `tool`, `final`,
  `file`), so the existing page needs minimal change.
- **Reconnects.** Pi streams always start with a snapshot of the conversation
  (including a partial answer), so a reconnecting tab catches up without
  replay logic.
- **Auth.** Same as today: one password (`IRIS_WEBUI_PASSWORD`, a Worker
  secret) and a session cookie.

### Telegram

- **Webhook instead of long polling.** Telegram sends updates to
  `/telegram/webhook`.
- **Forged-request check.** The Worker sets the webhook itself, with a random
  `secret_token`, and rejects requests without a matching
  `X-Telegram-Bot-Api-Secret-Token` header.
- **Fast acknowledgement.** Each update is submitted to the chat's channel
  object with `operationId = update_id`, then acknowledged immediately. Pi's
  `submit()` returns once the input is stored, before the model runs. A
  Telegram retry becomes a no-op.

The owner claim has to change shape. Today (`transports/telegram/telegram-claim.ts`):

1. The runtime prints a one-time token and QR code to the terminal at
   startup.
2. The first chat to send `/start <token>` within 10 minutes becomes the
   owner.
3. Everyone else is silently ignored.

A Worker has no terminal. In Lite, the claim token and QR code are shown on a
setup page in the Web UI, behind the Web UI password. Everything else stays
the same: single use, short-lived, owner stored in the workspace object, other
chats ignored, and a reset button replaces `IRIS_TELEGRAM_FORCE_RECLAIM`.
**Until a claim exists, the bot answers nobody.** This is required from day
one; a self-serve bot is otherwise open to anyone who finds it.

### Slack (later)

Slack moves from Socket Mode, which needs a long-lived connection, to the
Events API over HTTP, with request signature verification. Setup uses a Slack
app manifest so it takes a few clicks. This is out of scope for the first
version.

## The control-plane contract

The control-plane gateway calls the runtime's internal API with a bearer token
(`control-plane/gateway/src/lib/workspace-fetch.ts`). Lite serves the same
routes from the Worker. Auth is `Authorization: Bearer <IRIS_API_TOKEN>`,
where the token is a Worker secret. Unlike core, Lite refuses to start the API
without it, because the Worker is always on the public internet.

Routes the gateway calls that iris-core implements today:

| Route | Lite |
|---|---|
| `GET /health` | Yes |
| `POST /sessions`, `GET /sessions`, `PATCH /sessions/:id` | Yes; registry in the workspace object |
| `GET /sessions/:id/history` | Yes; mapped from Pi transcript entries to today's `log.jsonl` shape |
| `GET /sessions/:id/stream` (SSE) | Yes; Pi events mapped to today's event kinds, `:ping` keep-alive |
| `POST /sessions/:id/message` | Yes; `submit` with `X-Iris-Request-Id` as operation id, then `wait` |
| `POST /sessions/:id/stop` | Yes; `abort()` |
| `POST /sessions/:id/attachments` | Yes; into the channel workspace |
| `POST /sessions/:id/reset` | Yes; Pi `reset()` |
| `POST /sessions/open` | Not until Slack (it posts into a Slack channel first) |

**Gap found while researching.** The current gateway also calls five routes
that iris-core does not implement:

| Gateway call | Location in control-plane | Closest core equivalent |
|---|---|---|
| `POST /sessions/:id/warm` | `threads.controller.ts:235` | none |
| `GET /sessions/watch` (SSE) | `threads.controller.ts:330` | none |
| `DELETE /sessions/:id` | `threads.controller.ts:297` | none |
| `POST /sessions/upload` | `proxy.controller.ts:51` | `POST /sessions/:id/attachments` |
| `POST /sessions/:id/abort` | `proxy.controller.ts:217` | `POST /sessions/:id/stop` |

These would return 404 against iris-core. Iris-cloud's vendored fork has some
of them. Lite should implement all five:

- `warm` is a cheap no-op that wakes the object.
- `watch` streams activity from the workspace object.
- `DELETE` deletes the conversation's object storage.
- `upload` and `abort` are aliases of the existing routes.

Core should close the same gap in a separate change, so the contract has one
definition. Both implementations need a shared contract test that runs
against core and Lite.

Not carried over: the secrets HTTP routes for sub-agents (`agents.json`
tokens), `/escalate`, the bridge server and the `X-Iris-Agent-Target` header
(it is read by nginx in front of a VM, not by the runtime).

## Secrets

Platform credentials are Worker secrets set at deploy time:

- `IRIS_API_TOKEN`
- `IRIS_WEBUI_PASSWORD`
- the Telegram bot token
- an encryption key

User secrets, such as an API key a skill needs, use today's model: a
single-use drop link opens a form in the Web UI. The difference is where
values live. They are stored encrypted in the workspace object, and the drop
tokens are stored there too, so a drop link survives an eviction (today's
drop links are in memory).

Today's `proxyOnly` secrets are values that tools may use but the agent must
never see. Lite enforces this at the network edge rather than in a broker
process. Code execution and the sandbox get an outbound handler that injects
the credential for listed hosts, so the model never sees the value. Values the
agent reads are registered for redaction in tool output, as today
(`engine/redact.ts`).

## Models

`createAI` from `agents/models/pi-ai` sends model calls either to Workers AI
or through **AI Gateway** to Anthropic or OpenAI. Through the gateway, no
provider key lives in the Worker. The gateway uses either a key the user
stores in AI Gateway ("bring your own key") or Cloudflare's Unified Billing
(prepaid credits, 5% fee).

The options for the default:

| Option | First five minutes | Quality | Notes |
|---|---|---|---|
| Bring your own key via AI Gateway | User stores an Anthropic/OpenAI key in AI Gateway | Best | One extra setup step |
| Workers AI | Works on deploy, no key | Weaker; few models document tool calling | Good for trying it out |
| Unified Billing via AI Gateway | Buy credits in the Cloudflare dashboard | Best | No provider account needed; also the natural metering point for iris-cloud |

Proposal, pending the maintainer's decision:

- Route every model call through AI Gateway.
- Default to Workers AI so a fresh deploy answers immediately.
- Have the setup page prompt the user to switch to their own key or Unified
  Billing.

The gateway also gives every deploy request logs, caching and spend limits.
Later, iris-cloud can meter per tenant there.

## Observability

- **Langfuse.** `iris-runtime/src/engine/langfuse.ts` exports traces over
  OTLP/HTTP with plain `fetch` and has no Node dependencies. Lite reuses the
  same trace shape (one `iris-run` trace per run, generation and tool
  observations, `sessionId` = conversation id) so Pupil and existing
  dashboards keep working. The data comes from Pi's telemetry events.
- **Logs.** Console logs go to Workers Logs.
- **Gateway.** AI Gateway records every model request.

## Deployment and distribution

### Package layout

```
iris-lite/
  wrangler.jsonc        # Worker, IrisChannel + IrisWorkspace (SQLite DOs), AI, Browser, LOADER bindings
  package.json          # cloudflare.bindings.* descriptions drive the Deploy button prompts
  .dev.vars.example     # IRIS_API_TOKEN, IRIS_WEBUI_PASSWORD, TELEGRAM_BOT_TOKEN, IRIS_ENCRYPTION_KEY
  src/
    index.ts            # fetch router: web, telegram, control-plane API
    channel.ts          # IrisChannel DO: PiHarness, iris extension, WebSocket
    workspace.ts        # IrisWorkspace DO: registry, memory, claim, secrets, schedules
    extension/          # sections, tools, hooks (round limit, approval)
    transports/         # web, telegram
    api/                # control-plane routes
  skills/               # bundled Lite skills
```

### Deploy to Cloudflare

Cloudflare's Deploy button clones a public repository into the user's GitHub
account and deploys it to their Cloudflare account. It creates the bindings,
including Durable Objects and Workers AI, and prompts for the secrets listed
in `.dev.vars.example`. Two constraints shape the package:

- **It must be self-contained.** The button deploys a subdirectory of a
  monorepo only if that directory builds on its own. So `iris-lite/` cannot
  import `../iris-runtime/src` at build time. Code shared with core
  (for example bash policy, redaction, Langfuse trace shapes) is copied in
  the first version. It moves into a small published package once both sides
  stabilise.
- **One button deploys one Worker.** This is why the code sandbox uses the
  Agents SDK workspace (same Worker) rather than Pi's code mode (second
  Worker).

Whether the button applies Durable Object migrations from `wrangler.jsonc` on
first deploy is not documented. It must be tested before launch. The fallback
is a `deploy` script that runs `wrangler deploy`, which the button respects.

### Upgrades

The user's deploy is a clone, so upgrading means pulling from this repo. The
setup page shows the deployed version and the latest release. A documented
"sync from upstream" step is the first answer. Automating it can wait for
iris-cloud, where we control deploys.

### Plan requirements and cost

Lite needs the **Workers Paid** plan ($5/month):

- The Free plan allows 10 ms of CPU per request, which an agent turn exceeds.
- Dynamic Workers (code execution) and containers are Paid-only.
- Browser Run on Free is limited to 10 browser-minutes per day.

On Paid, an idle Lite deploy costs only the plan fee. The plan includes:

- **Code execution:** 10M requests per month.
- **Browser:** 10 browser-hours per month, then $0.09/hour.
- **Containers:** 375 vCPU-minutes per month.

Model usage is billed by the provider or through Unified Billing.

## Path to iris-cloud

iris-cloud would host each customer's Lite as a separate Worker in a Workers
for Platforms dispatch namespace. Each customer gets their own Durable
Objects and secrets, and the control-plane routes to them. Pricing is $25/month
for the platform plus usage.

**Unverified, and the first thing to check** before committing iris-cloud to
this path: whether Workers for Platforms user Workers can define their own
Durable Object classes, use the Dynamic Worker loader, and run containers.
The docs found so far don't say. If they can't, the fallback is one Cloudflare
account or one plain Worker per tenant, provisioned by the orchestrator.

This needs its own design doc once the self-serve version works.

## Risks

| Risk | Mitigation |
|---|---|
| Pi Durable is experimental; `PiHarness` is beta; each `agents` release supports one Pi minor | Pin `agents` and the Pi packages exactly; upgrade deliberately with the contract tests |
| No tool-round limit or approval pause in Pi | Lite's own `afterTools` limit and approval flow (above) |
| Skills can't run scripts under Pi | `requires:` field; rewrite the few HTTP-script skills |
| The 15-minute alarm cap cuts very long single model streams | Document; rare in practice |
| Deploy button and Durable Object migrations untested | Test before launch; `deploy` script fallback |
| Workers for Platforms support for DOs, loader and containers unverified | Verify before the iris-cloud design |
| Control-plane already depends on routes core lacks | Implement them in Lite; fix core separately; shared contract tests |

## Open questions

Blocking:

1. **Default model path.** Workers AI by default with a prompt to switch, or
   bring-your-own key or Unified Billing from the first deploy? (Proposal
   above.)
2. **The five missing gateway routes.** Confirm Lite implements them, and
   whether core gets the same change first.

Non-blocking:

3. Tool-round default (proposed 50) and whether to add a per-run cost
   ceiling.
4. Whether Lite should share code with core through a published package now,
   or copy first (proposed: copy first).
5. Whether to bump `iris-runtime` to Pi 1.4. It is not needed for Lite,
   because the engines differ anyway, but it would align the model and
   provider layer (`pi-ai`).

## Sequencing

Each phase ends with something deployable.

1. **Skeleton.**
   - `iris-lite/` package with both Durable Objects and `PiHarness`
   - models through AI Gateway
   - the `iris` extension (constitution, memory, round limit)
   - Web UI chat with streaming
   - a Deploy button that works on a fresh account
2. **Telegram.** Webhook, secret-token check, update-id deduplication, and
   the claim flow on the setup page.
3. **Control-plane API.** The routes above, including the five missing ones,
   plus a contract test that runs against Lite and core.
4. **Capabilities.** Workspace file tools, `run_code`, the browser tool, and
   the built-in `schedule` tool on the workspace alarm.
5. **Skills, secrets, MCP.** The `requires:` field, R2 skills, drop-link
   secrets with outbound credential injection, and remote MCP servers.
6. **Optional sandbox.** The approval flow first, then the container sandbox
   behind a setting.
7. **iris-cloud.** A separate design after verifying Workers for Platforms.

## Explicitly out of scope for this doc

- Slack (designed in outline above, built after phase 6).
- Sub-agents and the bridge protocol.
- Migrating an existing VM Iris's data into Lite.
- iris-cloud's tenancy, billing and routing design.
