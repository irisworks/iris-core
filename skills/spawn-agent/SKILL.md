---
name: spawn-agent
description: Create a new sub-agent — no Terraform, no Docker by default. Starts as a systemd service, patched into the bridge immediately so @agent works right away.
---

# Skill: spawn-agent

Spawn a new sub-agent. The default path is: ask what it's for, scaffold it,
start it as a plain systemd service, register it on the bridge. No Terraform,
no Docker, no container — the agent is reachable via `@<name>` in a message
as soon as this finishes. Self-heal, starter skills, a full numbered-rules
constitution, and Docker isolation are all opt-in flags layered on top —
never part of the default pass.

## Usage

```
spawn-agent <agent-name> <one-line-purpose>
  [--mode=docker]        # opt in to Terraform + container isolation (advanced)
  [--with-self-heal]     # wire in the self-heal escalation skill
  [--with-skill=<name>]  # scaffold one starter skill from a template
  [--full-constitution]  # write the old-style numbered-rules MEMORY.md
```

If invoked conversationally ("create an agent that does X"), ask only for the
agent name and a one-line purpose — nothing else — then run straight through
without per-step confirmation.

## Default flow — service mode (no Terraform, no Docker)

### Step 1 — Scaffold

Create `agents/<name>/`:
```
agents/<name>/
├── MEMORY.md   ← name + the one-line purpose (a paragraph, not a constitution)
├── README.md   ← agent keeps this updated
└── skills/     ← empty unless --with-skill / --with-self-heal was given
```
`--full-constitution` writes the old numbered-rules/what-it-can't-do-without-confirmation
form of `MEMORY.md` instead of the one-paragraph default.

### Step 2 — Commit (only if a GitHub PAT is configured)

```bash
if agents/lib/register-bridge.sh has-pat; then
  github-commit "agents/<name>/" "feat: scaffold <name> agent"
else
  echo "No GitHub PAT configured — skipping commit, agent stays local-only for now."
fi
```
No PAT means no point calling `gh`/git tooling — skip cleanly, don't attempt
and fall back. The agent still runs and is bridge-reachable either way;
persisting the scaffold into git (so it survives a VM rebuild) is a separate
concern from making it exist right now.

### Step 3 — Start it as a systemd service

```bash
PORT=$(agents/lib/register-bridge.sh next-port)
cp agents/service-bootstrap.template.sh agents/<name>/bootstrap.sh
# fill in AGENT_NAME=<name> and BRIDGE_PORT=$PORT in the copy
bash agents/<name>/bootstrap.sh
```
This reuses the same already-built `iris-runtime` binary Iris herself runs
(see `bootstrap.sh`'s "Build iris-runtime" step) — no per-agent build, no
container. The unit (`iris-agent-<name>.service`) is active in about a
second.

### Step 4 — Patch it into the bridge (always, unconditional)

```bash
agents/lib/register-bridge.sh register "<name>" "http://127.0.0.1:${PORT}" "<one-line-purpose>"
```
This writes/merges the entry into `/iris/data/agents.json` under an `flock`,
without disturbing any other agent's entry — see `iris-runtime/src/engine/bridge.ts`
for how Iris resolves `@<name>` to this `bridge_url`. There is no flag to skip
this step; it's what makes `@<name>` work immediately.

### Step 5 — Verify

```bash
systemctl status iris-agent-<name> --no-pager
journalctl -u iris-agent-<name> -n 20
curl -s http://127.0.0.1:<port>/health
```

Done. `@<name>` works in the next message.

## Advanced: `--mode=docker` (Terraform + container isolation)

Only use this when the agent specifically needs container isolation
(untrusted, public-facing, or higher-blast-radius work) — never the default.

Steps 1–2 are identical. Then, instead of steps 3–4:

### Step 3 (docker) — Provision via Terraform

Set `enable_docker_agents = true` once (`terraform.tfvars` or `-var`) if this
is the first docker-mode agent — it gates the shared image build off by
default so service-mode-only installs never pay that cost. Then add to
`terraform/agents.tf`:
```hcl
module "<name>_agent" {
  source = "./modules/agent"

  agent_name       = "<name>"
  key_vault_name   = var.key_vault_name
  iris_api_url     = "http://172.18.0.1:3000"
  bridge_port      = <port>   # agents/lib/register-bridge.sh next-port
  image_dependency = null_resource.iris_runtime_image[0].id
}
```
```bash
github-commit "terraform/agents.tf" "infra: provision <name> agent container"  # same PAT gate as step 2
terraform-apply
```
The image build (`npm run build && docker build`) now runs at most once
across all docker-mode agents — see `terraform/main.tf`'s
`null_resource.iris_runtime_image` — instead of once per agent.

### Step 4 (docker) — Patch it into the bridge

Same `agents/lib/register-bridge.sh register` call as the default flow
(mode-agnostic). Pass the module's `api_token` output as the 4th arg if
`unique_api_token = true` was set.

### Step 5 (docker) — Verify

```bash
docker ps | grep iris-<name>
docker logs iris-<name> --tail 20
curl -s http://localhost:<port>/health
```

## Optional flags, added at creation time

- `--with-self-heal`: copies `skills/self-heal/SKILL.md` into
  `agents/<name>/skills/self-heal/` and adds the env vars it needs to
  escalate (`IRIS_API_URL`, `IRIS_EVENTS_DIR`) — as `Environment=` lines in
  the systemd unit, or container `-e` flags in docker mode.
- `--with-skill=<name>`: scaffolds one starter skill from a template into
  `agents/<name>/skills/<name>/SKILL.md`.
- `--full-constitution`: see Step 1.

None of these are asked about or invoked unless explicitly requested.

## Notes

- Default mode is `service` — a systemd unit, not a container. It shares
  Iris's host user/process/filesystem (no isolation boundary); use
  `--mode=docker` when that blast radius isn't acceptable for this agent.
- Bridge registration (`agents/lib/register-bridge.sh register`) always runs,
  regardless of mode — "Iris exposes it through the bridge" is not optional.
- `agents/lib/register-bridge.sh next-port` auto-assigns the bridge port by
  scanning existing `bridge_url` entries in `/iris/data/agents.json`,
  starting at 4200 — no need to pick one by hand.
- Container name (docker mode): `iris-<agent-name>`. Service name (default
  mode): `iris-agent-<agent-name>`.
