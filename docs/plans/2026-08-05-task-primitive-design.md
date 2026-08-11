---
title: "Design: task — an optional in-process, fresh-context primitive"
description: Design proposal for a fresh-context in-process sub-agent primitive, distinct from the long-lived bridge sub-agent.
---

# Design: `task` — an optional in-process, fresh-context primitive

Status: design validated, not yet implemented.

## Context

Iris's only sub-agent primitive today is the bridge: a registered, long-lived
process reachable via `@mention` or intent-based routing (`docs/sub-agents.md`).
That's the right shape for a named collaborator with its own identity, memory,
and skills. It's the wrong shape for a one-off noisy investigation — running
`journalctl`, a `terraform plan`, or a multi-step diagnostic directly in Iris's
own channel session means every line of that output becomes a permanent part of
the channel's context, re-sent on every subsequent turn until the channel hits a
context reset (`readResetWatermark`/`writeResetWatermark`,
`POST /sessions/:id/reset`) and Iris loses conversational memory.

Claude Code's Agent/Task tool solves the equivalent problem by running a child
agent in-process, seeded with a fresh context, and folding its entire transcript
down to one final-message result before it ever reaches the parent's context.
This document designs the equivalent primitive for Iris: `task`.

Goal ranking, as prioritized during design: **(1) context headroom** — keep
noisy work out of long-lived channel sessions so context resets happen less
often — **(2) cheap-model cost**, secondary — **(3) parallel fan-out**,
explicitly deferred to a later, separate design.

Naming: deliberately **not** "sub-agent". That word is already load-bearing in
this repo — an `agents.json` entry, a `bridge_url`, `@mention` routing, a
systemd unit, its own `MEMORY.md`. A task has none of that: no registry entry,
no name, no memory, no life beyond one call. Reusing the word would blur a
vocabulary this repo already relies on.

## What a task is

A sixth tool in `createIrisTools` (`iris-runtime/src/engine/tools/index.ts`),
alongside `read`/`bash`/`edit`/`write`/`attach`. Calling it:

1. Builds a second `Agent` via the existing `createRunner` path
   (`iris-runtime/src/engine/agent.ts:488`), keyed by a synthetic id
   (`task-<uuid>`) instead of a channel id, so it never enters the
   `channelRunners` map and is garbage after the call — no persistence, no
   registry, no identity.
2. Seeds it with: the inherited constitution (`data/CONSTITUTION.md`), **no**
   `MEMORY.md`, **no** channel/user lists, and the skills index. One user
   message: the task prompt. (Measured: the fixed system-prompt boilerplate is
   ~3-4k tokens and already prompt-cached — slimming it further is not a
   meaningful lever, so nothing here strips the constitution or skills index.)
3. Gets Iris's own tool array **minus `task` itself** — recursion is
   structurally impossible, not just discouraged, matching how Claude Code
   prevents fork bombs by omitting the Agent tool from child tool lists.
4. Runs to completion; the inner agent's final assistant text becomes the
   tool's result. Everything in between — every inner tool call, every
   intermediate reasoning turn — is discarded and never reaches Iris's context.
5. Shares Iris's existing executor (`--sandbox=host` or whatever the channel's
   `SandboxConfig` already is) rather than creating a new one. No new
   isolation claim, no new attack surface, no per-task sandbox cost. (A future
   `--isolation` option, mirroring Claude Code's `worktree` isolation for
   parallel writers, is out of scope until fan-out exists.)

Schema mirrors `bash`/`read`: a required `label` (shown to the user, drives the
Slack status line) and a `prompt`.

## Trigger: how work ends up running as a task

There is no runtime interception point for skill invocation — skills are
markdown instructions Iris reads and follows, sometimes via a bash-invoked
script (`skills/status/status`), and the runtime never sees "skill X was
invoked" as an event it could redirect. So the trigger is **advisory, doubly
cued** — the same pattern `secrets:` frontmatter already uses (consumed by
`spawn-agent`, not enforced at runtime):

1. A skill's `SKILL.md` frontmatter declares `run-as-task: true`.
2. The skills index rendered into the system prompt annotates it:
   `status — runs as a task`.
3. The skill's own body opens by instructing invocation through the `task`
   tool.

Two reinforcing cues at the two points Iris actually looks. Not enforced at
the bash layer — if this proves insufficient in practice, intercepting
bash calls whose path matches a task-marked skill's `baseDir` is available as
later hardening, not built now on speculation.

`task` is also available ad hoc, for one-off investigation Iris judges worth
isolating, independent of any skill marking.

Known-noisy candidates to mark first: `status`, `self-heal`, `terraform`,
`azure` (per `docs/sub-agents.md`'s existing skill list) — anything whose
normal output is `journalctl`/`terraform plan`/cloud-CLI-scale.

## Model selection

`createRunner` already takes `provider`/`modelId` per instance
(`agent.ts:468`), so a task running on a cheaper/faster model is a config
question, not an architecture question. New env vars `IRIS_TASK_PROVIDER` /
`IRIS_TASK_MODEL`, **defaulting to Iris's own provider/model** — enabling
tasks changes isolation only; routing to a cheaper model is a separate,
deliberate step an install opts into afterward. The task runner reuses the
existing key-resolution path in full, including the `resolveConfigValue` echo
workaround already handled in `agent.ts` for store/proxy secrets mode — no
second resolution path.

Deliberately omitted: per-skill model override in frontmatter. YAGNI until a
specific skill demonstrably needs a different model than the install's task
default.

Feature flag: `IRIS_TASKS_ENABLED`, default **off**, matching the
`enable_docker_agents` precedent in `terraform/main.tf`. Verify on the live VM
before flipping on.

## What surfaces to Slack

No new Slack code path. `task` is a tool like any other, so the existing
`tool_execution_start`/`tool_execution_end` handling in `session.subscribe`
(`agent.ts:681-755`) already produces its Slack presence: `_→ <label>_`, a
status line, `✓`/`✗` outcome, verbose-mode args+result thread post, and
`_Error: …_` on failure — all for free, because `task` is indistinguishable
from `bash`/`read` at that layer.

The part that must be built deliberately is what the **inner** run does not
do. The task's private `Agent` gets its own event subscription, separate from
`session.subscribe`, which must never call `ctx.respond`, `ctx.onToolEvent`,
`queue.enqueueMessage`, or `runState.trace.recordTool`. If it did, every grep
and bash call *inside* the task would post its own Slack message and re-enter
Iris's context — the exact accumulation problem `task` exists to solve, just
moved one level down. Instead, the inner run's events go to:

- `log.logToolStart`/`logToolSuccess`/`logToolError` — full detail, local logs
  only, never Slack, never context. Free debugging depth at zero downstream
  cost.
- Optionally, a throttled `ctx.setStatus` update reusing the label
  (`_→ task: investigating flaky test…_`) — nice-to-have, not required for
  correctness.

Net Slack artifact per task call: one `_→ <label>_`, one
`✓ task: <label> (Ns)` plus the task's final text as the result body — same
shape as any other tool, deliberately unremarkable.

## Observability

Task usage rolls up into Iris's own Langfuse trace as a single `recordTool`
entry — input is the task prompt, output is the final summary, cost is the
task's aggregate token/cost. No new Langfuse code, no second trace lifecycle
to manage; `recordTool` (`iris-runtime/src/engine/langfuse.ts`) already exists
and is unconditionally safe to call (opt-in, swallows its own errors).

Explicitly deferred: a nested Langfuse trace per task (tagged with the parent
`sessionId` + a `taskId`) for drilling into a misbehaving task's own tool
calls from Pupil, without VM log access. Local logs already give that detail
today; add the nested trace only if VM-log debugging of bad tasks becomes a
recurring chore in practice.

## Limits and error handling

Nothing today caps how long an agentic loop runs — it ends naturally when the
model stops calling tools, bounded only by `IRIS_LLM_TIMEOUT_SECS` (default
90s) per individual LLM call. That's fine for Iris's main loop, where a user
is present to notice and intervene. A task has no one to intervene, so it
needs a hard outer ceiling: new `IRIS_TASK_MAX_MS` (default 300000 — 5
minutes) aborts the inner run if exceeded. Per-call retry/timeout
(`IRIS_LLM_TIMEOUT_SECS`/`IRIS_LLM_MAX_RETRIES`) is already shared via
`createRunner`, no new mechanism needed there.

A thrown error or a max-duration abort is caught in `task.ts`'s `execute()`
and returned as a normal tool error result (`isError: true`, e.g.
`(task failed: exceeded 300s limit)`) — flowing through the existing
`isError` → `_Error: …_` Slack path (`agent.ts:753`), not a new failure
surface. Same salvage philosophy as the bridge (`docs/sub-agents.md`): never
leave Iris hanging on nothing.

## Testing

- Unit: assert the inner run's tool-call events never reach `ctx.respond`,
  `ctx.onToolEvent`, or `runState.trace.recordTool` — the isolation property
  the whole design depends on.
- Flag-off regression: with `IRIS_TASKS_ENABLED` unset/false, `task` is absent
  from the tool array and `bash`/`read`/`edit`/`write` behavior is unchanged.
- Manual, on the live VM: enable the flag, run a `run-as-task`-marked skill
  (`status` first), confirm Slack shows one collapsed line + summary, and
  confirm the channel's session file grew by one turn rather than a full log
  dump.
- Timeout: force the inner run to hang, confirm `IRIS_TASK_MAX_MS` aborts it
  cleanly and Iris receives an error result rather than hanging.

## One number to confirm before implementation

Whether `formatSkillsForPrompt` (from `@mariozechner/pi-coding-agent`, used at
`agent.ts:254`) renders a name+description index or full `SKILL.md` bodies
into the system prompt. Index-only was assumed throughout this design
(consistent with the measured ~3-4k token fixed prompt size); if it turns out
to inject full bodies (54KB / ~13.5k tokens across today's 17 skills), that is
the single largest item on this list and worth fixing independently of
`task`.

## Explicitly out of scope

Parallel fan-out/fan-in (dispatching several tasks concurrently and joining
results), per-skill model override, nested Langfuse traces, and any bash-level
enforcement of `run-as-task`. All are candidates for a follow-up design once
`task` exists and its context-headroom effect is observed in practice.

## Sequencing

1. `task` tool + `IRIS_TASKS_ENABLED` flag (default off) + `IRIS_TASK_MAX_MS`
   + isolation guarantee (unit-tested).
2. `run-as-task: true` frontmatter on `status` first; verify the Slack/context
   shape on the live VM.
3. `IRIS_TASK_PROVIDER`/`IRIS_TASK_MODEL` cheap-model routing, opted into
   per-install once (1) is verified.
4. Mark remaining noisy skills (`self-heal`, `terraform`, `azure`).
5. Fan-out/fan-in as a separate design, only if (1)-(4) prove the primitive
   out.
