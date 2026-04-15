# Iris — Build Plan
> A self-improving orchestrator that spawns, manages, and heals specialized sub-agents

**GitHub org:** `30signals`
**Repo:** `github.com/30signals/iris-core`

---

## 1. What is Iris

Iris is an always-on infrastructure agent living on an Azure VM. She is not a chatbot. She is not a CRUD app builder. She is an **orchestrator** — she builds and coordinates sub-agents, each of which is itself agentic, self-healing, and self-improving.

You talk to Iris via Slack or TUI (SSH into VM). Iris talks to Azure, GitHub, and its sub-agents via an internal HTTP API it builds itself.

### The fractal structure

```
You
└── Iris (orchestrator, Azure VM, github.com/30signals/iris)
    └── spawns sub-agents (pi-mom instances, 2 containers each)
        ├── Newsletter Agent (preview + prod)    ← first to build
        ├── Operations Agent (preview + prod)    ← next
        └── [more as needed]
            └── sub-agents can spawn more specialized sub-agents if needed
```

### One Iris per tenant

Each client or product deployment gets its own isolated Iris instance. No multi-tenancy within a single Iris. Spinning up a new Iris = running `bootstrap.sh` with different secrets.

---

## 2. Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Agent runtime | `@30signals/iris-runtime` | Provider-agnostic fork of pi-mom with Slack, Docker sandbox, SKILL.md, session memory |
| LLM abstraction | `@mariozechner/pi-ai` | Provider-agnostic — swap Claude, Gemini, GPT, Ollama without changing code |
| TUI | `@mariozechner/pi-coding-agent` CLI | Terminal interface via SSH |
| Web UI | `@mariozechner/pi-web-ui` | Browser-based chat for ops teams, Iris builds these for sub-agents |
| Infrastructure | Terraform + Azure CLI | All infra as code, always |
| Secrets | Azure Key Vault (abstracted) | Always accessed via `get-secret` skill, never directly — enables future cloud portability |
| Source of truth | GitHub (`30signals/iris`) | Every skill, constitution, Terraform file committed here |
| Compute | Azure VM (Linux, Ubuntu 24 LTS) | Always-on, Iris's body |
| Sub-agent compute | Docker containers (preview + prod per agent) | Iris provisions via Terraform module |
| Agent-to-agent comms | Internal HTTP API | Iris builds this herself — Slack is human-only interface |

---

## 3. Core Design Principles (Iris Constitution)

These become Iris's `MEMORY.md` — she reads this on every boot.

```
1.  All infrastructure = Terraform. No manual Azure clicks. Ever.
2.  Every skill you write = committed to GitHub before use.
3.  Every capability you add = documented in README so future copies
    of you can replicate it from scratch.
4.  GitHub is your long-term memory. The VM is ephemeral.
5.  Secrets live in Azure Key Vault. Never hardcode. Never log.
    Always access secrets via the get-secret skill, never az keyvault directly.
6.  Before spawning a sub-agent, write its MEMORY.md constitution first.
7.  Every sub-agent gets TWO containers: preview and prod.
    New skills are tested in preview before promotion to prod.
8.  Sub-agents self-heal first. If they cannot fix themselves,
    they escalate via the internal Iris API — not via Slack.
9.  You escalate to Rohit only if you cannot fix it yourself.
10. Slack = human interface only. Agent-to-agent = internal HTTP API.
11. After every significant action, update your own README.
12. Cloud portability: never call Azure services directly in skills.
    Always use abstraction skills (get-secret, store-file, etc.)
13. You are Iris. You orchestrate specialized sub-agents.
```

---

## 4. Development Environment

**Develop directly on the Azure VM.** No local dev machine needed.

Reasons:
- Iris's skills run in Docker sandbox — dev work is isolated
- No "works on my machine" problem — what you build is where she runs
- SSH in, edit files, test immediately
- Git is the safety net — commit before every risky change

**One exception:** Terraform changes. Always run `terraform plan` and review carefully before `terraform apply`. You do not want to accidentally destroy the VM you are working on.

**Workflow:**
```
SSH into VM
→ edit skills or code in /home/azureuser/dev/iris-core (or /iris/repo symlink)
→ test in Iris's preview environment
→ git commit + push
→ promote to prod
```

---

## 5. Hot-Reload Architecture

Hot-reload has three layers depending on what changed.

### Layer 1: SKILL.md changes (instant, no restart)
```
Iris or dev writes/edits a skill file
→ iris-runtime's ResourceLoader watches skills/ directory
→ new skill available immediately on next prompt
→ no restart needed
```

### Layer 2: TypeScript extension changes (fast restart)
```
Iris or dev writes a new TypeScript extension
→ git commit
→ systemd restarts iris-runtime (seconds)
→ Iris back online with new capability
→ session files preserved — no memory loss
```

### Layer 3: Sub-agent skill changes (preview → prod flow)
```
Sub-agent identifies capability gap
→ writes new skill in preview environment
→ tests skill in preview (preview Slack channel or preview web UI)
→ if tests pass: promotes to prod via internal Iris API
→ Iris applies Terraform to update prod container
→ git commit of new skill under agents/{name}/skills/
```

**Preview/prod is built into every sub-agent from day one.**
The spawn-agent Terraform module always provisions two containers.

---

## 6. Agent-to-Agent Communication

**Slack = human interface only.**

Sub-agents do not escalate to Iris via Slack. They use an internal HTTP API that Iris builds itself.

### Bootstrap sequence (Phase 1)

On bootstrap, before the API exists, sub-agents write escalation events to a shared file queue on the VM filesystem. Iris polls this queue. Simple, no dependencies.

### Iris builds the API herself (Phase 4)

Tell Iris:
> "Build yourself an internal REST API so sub-agents can escalate to you programmatically."

Iris will:
1. Design the API spec
2. Build and deploy it as a Docker container on the internal VM network
3. Update the `spawn-agent` skill so all future sub-agents get the API endpoint injected automatically
4. Document it in her README
5. Commit everything to GitHub

### Escalation API (when Iris builds it)

```
POST /iris/escalate
{
  "agent": "newsletter",
  "environment": "prod",
  "issue": "SendGrid API returning 503",
  "context": "...",
  "severity": "high|medium|low"
}

POST /iris/promote
{
  "agent": "newsletter",
  "skill": "send-newsletter",
  "from": "preview",
  "to": "prod"
}

POST /iris/spawn
{
  "name": "inventory",
  "constitution": "...",
  "starter_skills": ["..."]
}
```

### Future interfaces (Iris builds when needed)
- **Webhooks** — external systems trigger Iris without going through Slack
- **MCP server** — Claude.ai, Cursor, or any MCP-compatible app connects directly to Iris as a tool provider

---

## 7. Secrets Management & Cloud Portability

### The abstraction rule

Iris never calls Azure Key Vault directly. She always uses the `get-secret` skill:

```bash
# In any skill script
SECRET=$(iris-get-secret ANTHROPIC_API_KEY)
```

`get-secret` today reads from Azure Key Vault. Tomorrow it reads from GCP Secret Manager, AWS Secrets Manager, or HashiCorp Vault — without changing any other skill.

### Secret chain on boot

```
bootstrap.sh
  → prompts for Azure login (one-time manual step)
  → Azure login fetches all secrets from Key Vault
  → secrets written to `/iris/.env`
  → systemd starts iris-runtime with `/iris/data`
  → Iris boots, reads MEMORY.md, connects Slack
```

### Secrets in Azure Key Vault

| Secret name | What it is |
|------------|-----------|
| `ANTHROPIC_API_KEY` | Primary LLM |
| `OPENAI_API_KEY` | Fallback LLM |
| `GITHUB_TOKEN` | 30signals org access |
| `SLACK_APP_TOKEN` | Slack socket mode token |
| `SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `AZURE_CLIENT_ID` | Iris service principal |
| `AZURE_CLIENT_SECRET` | Service principal secret |
| `AZURE_TENANT_ID` | Azure tenant |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription |

Child agents get scoped secrets — Iris provisions these when spawning them.

### Cloud portability path

```
Today:    Azure Key Vault (azurerm Terraform provider)
Tomorrow: Swap get-secret skill + Terraform provider
          pi-mom and all skills remain unchanged
          Only the infrastructure layer changes
```

---

## 8. Repository Structure

```
iris/                                   ← github.com/30signals/iris
│
├── bootstrap.sh                        ← one-liner resurrection script
├── MEMORY.md                           ← Iris constitution (read on every boot)
├── README.md                           ← resurrection guide (Iris keeps updated)
│
├── terraform/
│   ├── main.tf                         ← VM, Key Vault, networking
│   ├── variables.tf
│   ├── outputs.tf
│   ├── backend.tf                      ← Azure Storage remote state + blob locking
│   └── modules/
│       └── agent/                      ← reusable module: preview + prod containers
│           ├── main.tf
│           └── variables.tf
│
├── skills/                             ← Iris's own skills (grows over time)
│   ├── get-secret/
│   │   └── SKILL.md                   ← secret abstraction layer
│   ├── store-file/
│   │   └── SKILL.md                   ← file storage abstraction layer
│   ├── spawn-agent/
│   │   └── SKILL.md                   ← create sub-agent (preview + prod)
│   ├── promote-skill/
│   │   └── SKILL.md                   ← promote skill from preview to prod
│   ├── terraform/
│   │   └── SKILL.md                   ← write and apply Terraform safely
│   ├── azure/
│   │   └── SKILL.md                   ← Azure CLI patterns
│   ├── github/
│   │   └── SKILL.md                   ← commit, push to 30signals org
│   └── self-extend/
│       └── SKILL.md                   ← protocol for writing new skills
│
├── agents/                             ← every sub-agent Iris has spawned
│   ├── newsletter/
│   │   ├── MEMORY.md                  ← Newsletter Agent constitution
│   │   ├── bootstrap.sh               ← restore this agent independently
│   │   ├── README.md                  ← agent keeps this updated
│   │   └── skills/
│   │       ├── send-newsletter/SKILL.md
│   │       ├── manage-subscribers/SKILL.md
│   │       ├── draft-content/SKILL.md
│   │       ├── check-deliverability/SKILL.md
│   │       ├── self-heal/SKILL.md
│   │       └── promote-skill/SKILL.md
│   └── [future agents]
│
└── data/                               ← pi-mom runtime (gitignored)
    ├── MEMORY.md                       ← symlink → ../MEMORY.md
    ├── skills/                         ← symlink → ../skills
    └── [slack channel dirs]
```

---

## 9. How Iris Runs

```bash
# Iris runs as a systemd service on the VM
/usr/bin/node /home/azureuser/dev/iris-core/iris-runtime/dist/main.js \
  --sandbox=docker:iris-sandbox \
  /iris/data
```

iris-runtime gives Iris out of the box:
- Slack (responds to @iris in any channel)
- TUI (SSH into VM, run `pi` directly)
- Session persistence (log.jsonl per Slack channel)
- Context compaction (infinite effective memory via log.jsonl grep)
- SKILL.md auto-loading
- MEMORY.md reading before every response
- Event system (cron, one-shot, immediate via data/events/)
- Docker sandbox (safe bash execution)
- Self-installing tools (`az`, `gh`, `terraform` installed by Iris on first boot)

---

## 10. Sub-Agent Design: Newsletter Agent (First Build)

### What it does
- Manages a product newsletter: subscribers, drafts, scheduling, sending
- Ops team talks to it via Slack channel or pi-web-ui
- Runs in two containers: `iris-newsletter-preview` and `iris-newsletter-prod`
- Self-healing: diagnoses and fixes failed sends before escalating
- Self-improving: extends its own skills, tests in preview, promotes to prod

### Newsletter Agent constitution (agents/newsletter/MEMORY.md)
```
You are the Newsletter Sub-Agent.
You manage an email newsletter end to end.

Rules:
1.  Always confirm before sending to more than 10 subscribers.
2.  Log every send to data/sends/log.jsonl.
3.  New skills are tested in preview before promotion to prod.
4.  If a send fails, diagnose and retry up to 3 times before escalating.
5.  Escalate to Iris via the internal API — not via Slack.
6.  Draft content lives in data/drafts/ until explicitly approved.
7.  Subscriber list managed in data/subscribers.csv.
8.  All skill changes committed to GitHub under agents/newsletter/.
9.  After every skill promotion, update your README.
```

### Newsletter Agent starter skills

| Skill | What it does |
|-------|-------------|
| `send-newsletter` | Compose and send via Resend or SendGrid |
| `manage-subscribers` | Add, remove, export subscriber list |
| `draft-content` | Create draft, request approval, hold until approved |
| `check-deliverability` | Test send, check bounce rates |
| `self-heal` | Diagnose failures, fix root cause, retry |
| `promote-skill` | Test in preview, promote to prod when confident |

---

## 11. Build Sequence

Status note: checked items exist in the repo or have been verified on the current VM. Unchecked items still need deployment, verification, or end-to-end testing.

### Phase 1 — Iris Bootstrap (Week 1)
- [x] Create `github.com/30signals/iris-core` repo
- [x] Write `terraform/main.tf` — VM, Key Vault, networking
- [x] Write `terraform/backend.tf` — remote state with blob locking
- [x] Write `bootstrap.sh` — full resurrection script
- [x] Write `MEMORY.md` — 13-rule Iris constitution
- [x] Write `skills/get-secret/SKILL.md`
- [x] Write `skills/store-file/SKILL.md`
- [x] Write `skills/terraform/SKILL.md`
- [x] Write `skills/azure/SKILL.md`
- [x] Write `skills/github/SKILL.md`
- [x] Write `skills/self-extend/SKILL.md`
- [ ] Deploy VM via Terraform (bootstrap VM is outside Terraform scope by design)
- [x] Run `bootstrap.sh`, confirm Iris alive in Slack + TUI
- [x] Verify Slack end to end on the current VM: reset state, write/read files, build dashboard artifact, restart runtime, confirm channel persistence
- [x] Verify end to end: secrets via skill, GitHub commit to 30signals, Terraform plan + apply

Phase 1 status: **complete and verified as of April 11, 2026.**

Verified on the live VM:
- `iris.service` running on host (`--sandbox=host`), not in Docker
- Model: `foundry-e2/Kimi-K2.5`
- `get-secret` skill: resolves secrets from env vars (hyphen→underscore) without requiring `az` in a container
- `github` skill: committed and pushed to `30signals/iris-core` from Iris
- `terraform` skill: plan ran cleanly — `1 to add, 0 to change, 0 to destroy` against fresh `iris-dynamic.terraform.tfstate`
- `terraform apply` executed: `iris-dynamic-rg` resource group created in Azure
- Slack end-to-end: clean state reset, file write/read, HTML dashboard artifact, restart persistence

Key decisions made:
- Iris runs on host (not in Docker sandbox) — `az`, `git`, `terraform` available natively
- Terraform scoped to dynamic resources only; bootstrap VM is outside this state
- All "mom" identifiers renamed to "Iris" throughout the codebase
- Env vars: `IRIS_SLACK_APP_TOKEN` / `IRIS_SLACK_BOT_TOKEN` (old `MOM_*` names kept as fallback)
- State backend: `iristfstate30` / `tfstate` / `iris-dynamic.terraform.tfstate`

### Phase 2 — Spawn Skill + Preview/Prod (Week 2)
- [x] Write `skills/spawn-agent/SKILL.md`
- [x] Write `skills/promote-skill/SKILL.md`
- [x] Write `terraform/modules/agent/` — preview + prod containers
- [ ] Test: ask Iris to spawn a test agent
- [ ] Verify: two containers, own Slack channel, own skills dir
- [ ] Test: promote a dummy skill from preview to prod

Phase 2 status: repo-side implementation exists. Live spawn/promotion flow is next — use the newsletter agent as the first real spawn target (not a throwaway test agent).

### Phase 3 — Newsletter Agent (Week 3)
- [x] Create newsletter sub-agent scaffold in repo as a reference implementation
- [x] Write newsletter constitution, starter skills, and bootstrap files manually in the repo
- [ ] Have Iris create or regenerate the newsletter sub-agent via the real `spawn-agent` flow
- [ ] Provision newsletter preview/prod containers
- [ ] Test: ops team sends newsletter via Slack
- [ ] Test: simulate failed send, verify self-healing
- [ ] Test: Newsletter Agent writes new skill, tests in preview, promotes to prod

Phase 3 status: newsletter files are present in the repo as a manual scaffold, but Iris has not yet been demonstrated creating and provisioning that sub-agent itself. Deployment and end-to-end operational testing remain open.

### Phase 4 — Internal API (Week 4)
- [x] Add internal API stub to `iris-runtime`
- [ ] Build and deploy the escalation API
- [ ] Iris updates `spawn-agent` skill to inject API endpoint into all future agents
- [ ] Newsletter Agent migrated from file queue to API escalation
- [ ] Test: real escalation via API

Phase 4 status: the API stub exists in code and is deployed with the current runtime, but the actual escalation workflow is not implemented.

### Phase 5 — Hardening (Week 5)
- [ ] Full resurrection test: destroy VM, `bootstrap.sh` on fresh VM
- [ ] All secrets restored from Key Vault
- [ ] Sub-agents restart correctly
- [ ] Terraform state survives VM destruction (Azure Storage)
- [ ] Security review: prompt injection guards, secret exposure audit
- [ ] All skills committed, README current, Iris can describe herself fully

Phase 5 status: not started.

---

## 12. Decisions Log

| # | Decision | Choice |
|---|---------|--------|
| 1 | Dev environment | Directly on Azure VM via SSH |
| 2a | Hot-reload: SKILL.md | Instant — ResourceLoader watches skills dir |
| 2b | Hot-reload: TypeScript | systemd restarts iris-runtime (seconds, no memory loss) |
| 2c | Preview/prod | Every sub-agent gets two containers from spawn |
| 3a | Agent-to-agent comms | File queue on bootstrap → Iris builds HTTP API in Phase 4 |
| 3b | Future interfaces | Webhooks + MCP server — Iris builds when needed |
| 4 | Multi-tenancy | Not a feature. One Iris per tenant. `bootstrap.sh` = new deployment. |
| 5 | Web UI | pi-web-ui. Iris builds UIs for sub-agents. |
| 6 | Cloud lock-in | Azure now. Abstracted behind skills. Swap provider later without touching skills. |
| 7 | GitHub org | `30signals` |
| 8 | Terraform state | Azure Storage Account with blob locking |

---

## 13. What Iris is NOT

- Not a chatbot — she takes actions
- Not a CRUD app builder — she builds agentic systems
- Not Slack-dependent — Slack is one interface, not the backbone
- Not dependent on any single LLM — pi-ai handles provider switching
- Not tied to Azure forever — abstraction layer enables cloud portability
- Not fragile — GitHub + Terraform + Key Vault = she can always be reborn
