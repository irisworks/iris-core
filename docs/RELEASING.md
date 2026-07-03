# Releasing iris-core

## Versioning

- Semver tags `vX.Y.Z` on the repo root. `iris-runtime/package.json` version must match the tag.
- The pinned `@mariozechner/pi-*` library dependencies (0.66.1) version independently; do not couple our version to theirs.
- Planned milestones: `v0.66.1-baseline` (pre-consolidation anchor) → `v0.90.0` (fork features upstreamed) → `v1.0.0` (transport refactor) → `v1.1.0` (panel API / cloud generics).

## Changelog

- Every PR adds an entry to `iris-runtime/CHANGELOG.md`.
- Features ported from install forks cite the source repo and commit SHA.
- Breaking changes (renamed env vars, config schema, data-dir layout) get an `UPGRADING` note in the release entry.

## Cutting a release

1. Ensure CI is green on `main` (build + smoke).
2. Bump `iris-runtime/package.json` version; finalize CHANGELOG entry.
3. `git tag vX.Y.Z && git push origin vX.Y.Z`.

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
- Never edit files under an install's `core/` submodule — contribute upstream instead.
