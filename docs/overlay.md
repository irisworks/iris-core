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

## Upgrading core

```bash
cd core && git fetch --tags && git checkout vX.Y.Z
cd iris-runtime && npm ci && npm run build && cd ../..
git add core && git commit -m "core: vX.Y.Z"
sudo systemctl restart iris
```
