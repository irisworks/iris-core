#!/usr/bin/env bash
# ============================================================
# cut-release.sh — tag, sign, push, and publish a GitHub Release for the
# version currently sitting in iris-runtime/package.json.
#
# Run this on main after the release-bump PR (package.json version +
# CHANGELOG.md entry) has already been merged. See docs/RELEASING.md for
# the full procedure this automates (steps 3-4).
#
#   bash scripts/cut-release.sh
#
# Env overrides:
#   IRIS_RELEASE_SIGNING_KEY  fingerprint to sign the tag with
#                             (default: the fingerprint in docs/RELEASING.md)
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_DIR"

SIGNING_KEY="${IRIS_RELEASE_SIGNING_KEY:-8790A80B95F47AA98D5DECB1BACEE877F0866BEB}"

log() { echo "[cut-release] $*"; }

VERSION="$(node -p "require('./iris-runtime/package.json').version")"
TAG="v${VERSION}"

log "Cutting $TAG"

if [ -n "$(git status --porcelain)" ]; then
	echo "[cut-release] Working tree is dirty — commit or stash first." >&2
	exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
	echo "[cut-release] Refusing to cut a release from branch '$BRANCH' — check out main first." >&2
	exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
	echo "[cut-release] Tag $TAG already exists locally." >&2
	exit 1
fi

# Extract the changelog body for this version — everything between its
# heading and the next `## [` heading. An empty body means the release-bump
# PR forgot to finalize the entry (docs/RELEASING.md: "no empty releases").
NOTES="$(awk -v ver="[$VERSION]" \
	'$0 ~ "^## \\" ver {f=1; next} /^## \[/{f=0} f' \
	iris-runtime/CHANGELOG.md)"
if [ -z "$(echo "$NOTES" | tr -d '[:space:]')" ]; then
	echo "[cut-release] No content found under '## [$VERSION]' in iris-runtime/CHANGELOG.md — finalize the entry before tagging." >&2
	exit 1
fi

log "Signing tag with key $SIGNING_KEY"
git -c gpg.format=openpgp -c user.signingKey="$SIGNING_KEY" tag -s "$TAG" -m "$TAG"

log "Pushing $TAG"
git push origin "$TAG"

log "Publishing GitHub Release"
gh release create "$TAG" --title "$TAG" --notes-file <(echo "$NOTES")

log "Done: $TAG released"
