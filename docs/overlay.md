---
title: Extending Iris (Overlays)
description: Link core as a submodule and keep your agents, skills, and config in a private overlay — don't fork.
---

# Extending Iris (Overlays)

Don't fork core — link it. An **overlay repo** holds everything specific to your
company or install, with core pinned as a submodule to a release tag.

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

1. **Never edit files under `core/`** — contribute upstream instead. If you need a
   core change, that's a PR to iris-core, not a local patch.
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
to `iris-core` rather than forking `core/` to add it locally. This keeps
"never edit files under `core/`" (rule 1 above) true even for installs that
need a platform core doesn't ship yet — the fix lands once, upstream, for
every install instead of diverging per fork.

## Upgrading core

```bash
cd core && git fetch --tags && git checkout vX.Y.Z
cd iris-runtime && npm ci && npm run build && cd ../..
git add core && git commit -m "core: vX.Y.Z"
sudo systemctl restart iris
```
