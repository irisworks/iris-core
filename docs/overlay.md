---
title: Extending Iris (Overlays)
description: Link core as a submodule and keep your agents, skills, and config in a private overlay — fork only to change core's own code.
---

# Extending Iris (Overlays)

Link core, don't fork it — unless you need to change core's own code. An
**overlay repo** holds everything specific to your company or install, with core
pinned as a submodule to a release tag.

Linking works because the extension surface is read from the workspace at
runtime: skills, sub-agents, and config hot-reload through symlinks, so your
behavior lives outside `core/` and a core upgrade stays a one-line submodule
bump. A fork's one real advantage is editing core code — see
[When to fork instead](#when-to-fork-instead).

## Which shape do you want?

| Shape | Use when | Upgrade path |
|---|---|---|
| **Pinned clone** (`install.sh`) | Trying Iris out, or running her unmodified | Re-run `install.sh`; it pins the latest release tag |
| **Overlay + submodule** | You're adding skills, sub-agents, or config — the default for a company install | `git -C core checkout vX.Y.Z`, commit the submodule |
| **Fork** | You must change core's own code (see below) | `git fetch upstream --tags && git rebase vX.Y.Z` |

## Structure

```
iris-yourcompany/
├── core/                    # submodule → irisworks/iris-core, pinned to a tag
├── overlay/
│   ├── agents/<name>/       # your sub-agents — symlinked into the workspace
│   ├── skills/<name>/       # your skills — symlinked; override core skills on name collision
│   └── data/                # CONSTITUTION.md, MEMORY.md seeds, models.json, channels.json
├── terraform/               # install-specific infra (if any)
├── .env.example             # committed template; the real .env.yourcompany is not
└── bootstrap-yourcompany.sh # wrapper: env → submodule update → core/bootstrap.sh → link overlay
```

## Setting it up

```bash
gh repo create iris-yourcompany --private
cd iris-yourcompany
git submodule add https://github.com/irisworks/iris-core.git core
git -C core checkout v0.90.0        # pin to a release tag
mkdir -p overlay/{agents,skills,data}
```

When bootstrap prompts for a GitHub token, point `IRIS_GITHUB_ORG` /
`IRIS_GITHUB_REPO` at `iris-yourcompany` (this overlay repo, not `core/`). That's
where the `github` skill pushes Iris's own skill/sub-agent commits — see
[Configuration](configuration.md).

The wrapper bootstrap sets `REPO_DIR`, calls `core/bootstrap.sh`, then symlinks
`overlay/agents/*` and `overlay/skills/*` into the workspace. Hot reload works
through symlinks, so overlay skills behave exactly like core skills.

## Rules that keep this clean

1. **Don't edit files under `core/`** — contribute upstream instead. If you need a
   core change, that's a PR to iris-core, not a local patch. If upstream can't
   take it, fork rather than patch the submodule in place.
2. **Overlay wins on name collision** — override a core skill by shipping one with
   the same name.
3. **Pin to tags, bump deliberately** — a core upgrade is a one-line submodule
   commit naming the new tag. Read the release's UPGRADING notes first
   (see [Releasing](RELEASING.md)).
4. **Your constitution is yours** — ship a full `CONSTITUTION.md` in
   `overlay/data/`; core's version is a generic default.

## What belongs in the overlay vs. core

Skills, sub-agents, and config (`channels.json`, `models.json`, `mcp.json`,
`CONSTITUTION.md`) are overlay content by design — they're read from the
workspace at runtime and hot-reload without a core change, so your business
logic and per-client behavior never touches `core/`.

**Chat transports are the exception.** A `ChannelTransport`
(`src/transport/types.ts` — see [Writing a Transport](writing-a-transport.md)
for the full contract) is constructed and registered in `main.ts`, not
discovered from the workspace at runtime — there's no plugin-loading
mechanism that lets an overlay drop in a new platform the way it drops in a
skill. Adding Discord, WhatsApp, or any other platform is a core change:
implement `ChannelTransport`, follow the checklist in
[Writing a Transport](writing-a-transport.md), and send it upstream as a PR
to `iris-core`. Landing it upstream fixes it once for every install instead of
diverging per fork — but if the transport is proprietary or upstream declines
it, a fork is the supported path, not a local patch to the submodule.

## When to fork instead

Fork when you need to change core's own code and can't land the change
upstream — a proprietary transport, or branding you won't publish. Also
reasonable for a solo install where Iris commits her own skills and self-edits
back to a repo: a separate overlay repo is ceremony for one person.

`bootstrap.sh` supports this directly. When `origin` isn't `irisworks/iris-core`
it adds an `upstream` remote pointing at core and fetches it, so a fork gets the
upgrade path wired at install time.

```bash
git fetch upstream --tags
git rebase v0.90.0          # rebase onto a release tag, not upstream/main
```

Rebase onto tags for the same reason overlays pin to them: `upstream/main` is
whatever last merged, and upgrades should be deliberate reads of the release's
UPGRADING notes (see [Releasing](RELEASING.md)). Send anything generalizable
back as a PR — the smaller your fork's diff, the cheaper every rebase.

## Upgrading core

```bash
cd core && git fetch --tags && git checkout vX.Y.Z
cd iris-runtime && npm ci && npm run build && cd ../..
git add core && git commit -m "core: vX.Y.Z"
sudo systemctl restart iris
```
