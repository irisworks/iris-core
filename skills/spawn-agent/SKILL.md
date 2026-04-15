---
name: spawn-agent
description: Create a new sub-agent scaffold and provision its container via Terraform.
---

# Skill: spawn-agent

Spawn a new sub-agent — creates its constitution, directory structure, and a single
Docker container via Terraform. Always write the agent's MEMORY.md constitution first.

## Usage

```
spawn-agent <agent-name> <one-line-description>
```

## Full workflow

### Step 1 — Write the agent's constitution

Create `agents/<name>/MEMORY.md` with:
- Who the agent is and what it does
- Its rules (numbered, specific)
- What it is NOT allowed to do without confirmation

### Step 2 — Create directory structure

```
agents/<name>/
├── MEMORY.md          ← constitution (you just wrote this)
├── README.md          ← agent keeps this updated
├── bootstrap.sh       ← restore this agent independently
└── skills/            ← starter skills go here
```

### Step 3 — Write starter skills

Write at minimum: one action skill + one `self-heal` invocation in the action skill.

Commit each to `agents/<name>/skills/<skill-name>/SKILL.md`.

### Step 4 — Commit everything

```bash
github-commit "agents/<name>/" "feat: add <name> agent constitution and starter skills"
```

### Step 5 — Provision container via Terraform

Add to `${IRIS_REPO_DIR}/terraform/agents.tf`:

```hcl
module "<name>_agent" {
  source = "./modules/agent"

  agent_name     = "<name>"
  key_vault_name = var.key_vault_name
  iris_api_url   = "http://172.18.0.1:3000"
  slack_app_token = "<xapp-...>"   # optional — omit for bridge-only mode
  slack_bot_token = "<xoxb-...>"   # optional — omit for bridge-only mode
  bridge_port     = <port>         # e.g. 4200; omit if no @agentname routing needed
}
```

Then apply:
```bash
github-commit "terraform/agents.tf" "infra: provision <name> agent container"
terraform-apply
```

### Step 6 — Verify

```bash
docker ps | grep iris-<name>
docker logs iris-<name> --tail 20
curl -s http://localhost:<bridge_port>/health  # if bridge enabled
```

### Step 7 — Update Iris MEMORY.md

Add the new agent to the sub-agents table in `/iris/repo/MEMORY.md`.

## Notes

- One container per agent (no preview/prod split for now — can be re-introduced later)
- Container name: `iris-<agent-name>`
- Without Slack tokens, agent runs in bridge-only mode (events + bridge server only)
- All agents receive `IRIS_API_URL` so `self-heal` can escalate to Iris via HTTP
- Shared events dir (`/iris/data/events`) is mounted so escalation events reach Iris
