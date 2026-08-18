#!/usr/bin/env bash
# ============================================================
# resolve-latest-tag.sh — print the newest v* release tag on a remote repo.
#
#   bash scripts/resolve-latest-tag.sh <repo-url>
#
# Prints nothing (and exits 0) if the remote has no v* tags — callers decide
# how to handle that (fall back to a branch, error out, etc).
#
# Note: install.sh runs before iris-core is cloned (it's curl-piped), so it
# can't source this file yet — it keeps its own copy of this same pipeline.
# Keep the two in sync; see install.sh's tag-resolution comment.
# ============================================================
set -euo pipefail

REPO_URL="${1:?usage: resolve-latest-tag.sh <repo-url>}"

git ls-remote --tags --sort=-v:refname "$REPO_URL" 'v*' 2>/dev/null \
  | awk '{print $2}' | sed 's|refs/tags/||' | grep -v '\^{}$' | head -n1
