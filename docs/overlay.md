---
title: Extending Iris (Overlays)
description: Link core as a submodule and keep your agents, skills, and config in a private overlay — fork only to change core's own code.
---

# Extending Iris (Overlays)

Link core, don't fork it — unless you need to change core's own code. An
**overlay repo** holds everything specific to your company or install, with core
pinned as a submodule to a release tag.

Linking works because the extension surface is read from the workspace at
runtime: skills, sub-agents, read handlers, and config hot-reload through symlinks, so your
behavior lives outside `core/` and a core upgrade stays a one-line submodule
bump. The one thing linking can't give you is editing core code — see
[When you need core code changes](#when-you-need-core-code-changes).

## Which shape do you want?

| Shape | Use when | Upgrade path |
|---|---|---|
| **Pinned clone** (`install.sh`) | Trying Iris out, or running her unmodified | `bash core/scripts/upgrade.sh` (or re-run `install.sh`, which re-prompts for secrets) |
| **Overlay + submodule** | You're adding skills, sub-agents, or config — the default for a company install | `bash core/scripts/upgrade.sh` from the overlay repo root |
| **Fork** | You're changing core's code to contribute it upstream (public — iris-core is a public repo, and forks of it can't be private) | `git fetch upstream --tags && git rebase vX.Y.Z` |
| **Private mirror** | You're changing core's code and can't publish it | same, from a private duplicate rather than a fork |

## Structure

```
iris-yourcompany/
├── core/                    # submodule → irisworks/iris-core, pinned to a tag
├── overlay/
│   ├── agents/<name>/       # your sub-agents — symlinked into the workspace
│   ├── skills/<name>/       # your skills — symlinked; override core skills on name collision
│   ├── read-handlers/<name>/ # your file-format handlers — same override rule as skills
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

Both bootstrap and the `github` skill refuse to push to `irisworks/iris-core`
itself or to any repo that resolves as public — Iris's commits carry
`MEMORY.md` and skill content, which must stay private.

The wrapper bootstrap sets `REPO_DIR`, calls `core/bootstrap.sh`, then symlinks
`overlay/agents/*`, `overlay/skills/*`, and `overlay/read-handlers/*` into the
workspace. Hot reload works
through symlinks, so overlay skills behave exactly like core skills.

## Rules that keep this clean

1. **Don't patch a pinned `core/` in place** — contribute upstream instead. If you
   need a core change, that's a PR to iris-core. If upstream can't take it, point
   the submodule at your own fork or private mirror rather than editing the
   pinned upstream checkout.
2. **Overlay wins on name collision** — override a core skill by shipping one with
   the same name.
3. **Pin to tags, bump deliberately** — a core upgrade is a one-line submodule
   commit naming the new tag. Read the release's UPGRADING notes first
   (see [Releasing](RELEASING.md)).
4. **Your constitution is yours** — ship a full `CONSTITUTION.md` in
   `overlay/data/`; core's version is a generic default.

## What belongs in the overlay vs. core

Skills, sub-agents, [read handlers](read-handlers.md), and config
(`channels.json`, `models.json`, `mcp.json`, `CONSTITUTION.md`) are overlay
content by design — they're read from the workspace at runtime and
hot-reload without a core change, so your business logic, per-client
behavior, and file-format support never touches `core/`.

**Chat transports are the exception.** A `ChannelTransport`
(`src/transport/types.ts` — see [Writing a Transport](writing-a-transport.md)
for the full contract) is constructed and registered in `main.ts`, not
discovered from the workspace at runtime — there's no plugin-loading
mechanism that lets an overlay drop in a new platform the way it drops in a
skill. Adding Discord, WhatsApp, or any other platform is a core change:
implement `ChannelTransport`, follow the checklist in
[Writing a Transport](writing-a-transport.md), and send it upstream as a PR
to `iris-core`. Landing it upstream fixes it once for every install instead of
diverging per copy — but if the transport is proprietary or upstream declines
it, take the private-mirror path below rather than patching the submodule.

## When you need core code changes

Two different situations, two different repos.

**Contributing upstream — fork.** A GitHub fork of `irisworks/iris-core` is the
normal PR path. It's public, which is fine: you're publishing the change anyway.

**Keeping the change private — mirror, don't fork.** iris-core is a public repo,
and GitHub does not allow a fork of a public repo to be private. Anything you
push to that fork is world-readable, and it stays reachable through the upstream
fork network even if you later delete the fork — deleting it does not unpublish
the commits. Never put a proprietary transport, unpublished branding, or company
data in a fork. Use a private mirror instead:

```bash
gh repo create yourorg/iris-private --private   # empty — --mirror overwrites all refs
git clone --bare https://github.com/irisworks/iris-core.git
git -C iris-core.git push --mirror https://github.com/yourorg/iris-private.git
gh repo view yourorg/iris-private --json visibility   # confirm PRIVATE
```

Then clone the private repo and wire core as the upstream remote. When
`bootstrap.sh` does the cloning itself (the default `install.sh` path, no
`REPO_DIR` set) it wires this for you: if `origin` isn't `irisworks/iris-core` it
adds an `upstream` remote pointing at core and fetches its tags. If you cloned
the mirror yourself and point `REPO_DIR` at it — the same shape an overlay
install uses — add the remote by hand:

```bash
git remote add upstream https://github.com/irisworks/iris-core.git
```

Upgrades then rebase your changes onto a release tag:

```bash
git fetch upstream --tags
git rebase v0.90.0             # rebase onto a release tag, not upstream/main
git push --force-with-lease    # rebase rewrote history; a plain push is rejected
```

Rebase onto tags for the same reason overlays pin to them: `upstream/main` is
whatever last merged, and upgrades should be deliberate reads of the release's
UPGRADING notes (see [Releasing](RELEASING.md)). Send anything generalizable
back as a PR from a real fork — the smaller your private diff, the cheaper every
rebase.

A private mirror is a heavier thing to maintain than an overlay: you own every
rebase, forever, and because each one rewrites your `main`, treat the mirror as
single-maintainer — a force-push invalidates everyone else's clone. Reach for it
only for the code you genuinely can't publish, and keep everything else in
`overlay/`.

## Upgrading core

```bash
bash core/scripts/upgrade.sh          # latest release tag
bash core/scripts/upgrade.sh vX.Y.Z   # specific tag
```

Run from the overlay repo root. It verifies the tag's signature, bumps the
`core/` submodule, rebuilds `iris-runtime`, commits the submodule bump, and
restarts `iris.service` — equivalent to running these by hand:

```bash
cd core && git fetch --tags && git checkout vX.Y.Z
cd iris-runtime && npm ci && npm run build && cd ../..
git add core && git commit -m "core: vX.Y.Z"
sudo systemctl restart iris
```

### Asking Iris to upgrade herself

The `upgrade-iris` skill runs the same script from inside Iris:

```bash
upgrade-iris --check     # would an upgrade be safe right now?
upgrade-iris             # latest release tag
upgrade-iris vX.Y.Z      # specific tag
```

It adds the two things self-upgrade needs. It refuses to start when the
checkout has uncommitted changes or commits on no remote, since checking out a
tag moves HEAD off work this box may be the only copy of (`--force` overrides).
And it runs the upgrade in a detached `iris-upgrade` systemd unit, because the
restart would otherwise kill the process running the upgrade — output lands in
`/iris/upgrade.log`, which survives the restart.
