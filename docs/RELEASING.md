---
title: Releasing
description: Version scheme, changelog rules, and the install upgrade procedure.
---

# Releasing iris-core

## Versioning

- Semver tags `vX.Y.Z` on the repo root. `iris-runtime/package.json` version must match the tag.
- The pinned `@mariozechner/pi-*` library dependencies (0.66.1) version independently; do not couple our version to theirs.
- Planned milestones: `v0.66.1-baseline` (pre-consolidation anchor) → `v0.90.0` (fork features upstreamed) → `v1.0.0` (transport refactor) → `v1.1.0` (panel API / cloud generics).

## Changelog

- Every behavior-changing PR adds an entry to `iris-runtime/CHANGELOG.md` under
  `[Unreleased]` and updates the relevant `docs/` page — the **docs-guard** CI
  workflow enforces both. Maintainers can bypass with the `changelog-not-needed`
  / `docs-not-needed` labels when a change is genuinely invisible to operators.
- No empty releases: a version heading must have content before it is tagged.
- Features ported from install forks cite the source repo and commit SHA.
- Breaking changes (renamed env vars, config schema, data-dir layout) get an `UPGRADING` note in the release entry.

## Signing key

Release tags are GPG-signed. `install.sh` verifies them by fetching the
maintainer's public key from `https://github.com/<user>.gpg` — GitHub's
built-in endpoint for a user's published GPG keys — so there is no key file
to keep in sync in this repo. See [`docs/SETUP.md`](SETUP.md#release-tag-verification)
for how installs consume this.

- **Maintainer:** `katrohit`
- **Fingerprint:** _publish here once the signing key is generated and added
  to the maintainer's GitHub account (Settings → SSH and GPG keys)._

Update the fingerprint above whenever the signing key rotates, and call it
out in the release's CHANGELOG entry so installs pinning
`IRIS_CORE_SIGNING_FINGERPRINT` know to update.

## Cutting a release

1. Ensure CI is green on `main` (build + smoke).
2. Bump `iris-runtime/package.json` version; finalize CHANGELOG entry.
3. `git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z` — the `-s` signs
   the tag with the key listed under [Signing key](#signing-key). Don't drop
   the `-s`: `install.sh` treats any `v*` tag as a release and aborts if it
   isn't signed by the published key.

## Upgrading an install (submodule consumers)

```bash
cd <install>/core
git fetch --tags && git checkout vX.Y.Z
cd iris-runtime && npm ci && npm run build
cd ../../..
git add core && git commit -m "core: vX.Y.Z"
sudo systemctl restart iris   # or: docker restart <container> / rootfs rebuild for cloud
```

Read the release's UPGRADING notes first. Data-dir migrations in the runtime are
idempotent and safe across at least one minor version — do not skip more than one
minor version without reading intermediate release notes.

## Support policy

- Installs may lag behind; core keeps workspace/data migrations one-way-safe.
- Don't edit files under an install's `core/` submodule — contribute upstream, or
  keep a private mirror if the change can't be published (see
  [Extending Iris](overlay.md)).
