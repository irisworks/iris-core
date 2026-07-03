# Constitution Rules - For Code Writing

## Infrastructure as Code
- The Terraform/Azure profile is **optional** — core's default path is any Linux box with Docker and `/iris/.env`, zero cloud dependencies. On installs that do use cloud infrastructure, always define and manage it with Terraform; no manual cloud resource creation there.
- Terraform in this repo (`terraform/`) is scoped to **dynamic resources** Iris provisions on demand (storage, DNS, sub-agent VMs, blobs). The bootstrap VM itself is NOT managed here — it is intentionally outside this state to prevent self-destruction.
- Terraform state lives in an Azure Blob backend configured per install (storage account, container, and state key are install-specific settings — set them in the install's backend config, e.g. via `terraform init -backend-config` or the install overlay; do not hardcode them in core).

## Runtime
- Iris runs as `iris.service` (systemd) on the host VM, **not in Docker**.
- Sandbox mode is `--sandbox=host` — bash commands run directly on the host where `az`, `git`, `terraform` are natively available.
- Docker is available on the host for sub-agent containers (used by the spawn-agent skill), not for Iris herself.
- Env file: `/iris/.env`. Slack tokens are `IRIS_SLACK_APP_TOKEN` / `IRIS_SLACK_BOT_TOKEN`.
- Skills are loaded from `/iris/data/skills` which is a symlink to `<repo>/skills/`. The skills directory is on the host filesystem and hot-reloads without restart.

## Naming
- Everything in the codebase is named **Iris**, not "mom". No `Mom`, `MOM`, `mom` identifiers. The upstream pi-mom package is used as a library but all local symbols use Iris naming.

## Self-Replication via README
- Always leave README notes with enough detail that a future instance (or a complete rebuild from scratch) can replicate the full setup — even if this instance and all its infrastructure are deleted.
- README must include: purpose, dependencies, environment setup, deployment steps, and any non-obvious configuration.

## Docs With Code
- Every behavior-changing PR updates `iris-runtime/CHANGELOG.md` (under `[Unreleased]`) and the relevant `docs/` page in the same PR. The docs-guard CI workflow fails PRs that don't; `changelog-not-needed` / `docs-not-needed` labels are the maintainer escape hatches.
- `docs/` is the documentation source of truth — it is rendered on the public website, so pages must stand alone (frontmatter title/description, no repo-internal jargon).

## Repo Guidance
- Keep `CLAUDE.md` current as the latest repo-level guidance file. When workflows, conventions, or maintenance expectations change, update `CLAUDE.md` with them.
- Keep `README.md` and `plan.md` aligned with the actual live VM state. When bootstrap, runtime wiring, model defaults, or verification status change, update those docs in the same workstream.
- Prefer concrete operational facts over aspirational wording in repo docs. Record the exact runtime path, service name, model, and what was verified versus what is still open.
