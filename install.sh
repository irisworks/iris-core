#!/usr/bin/env bash
# ============================================================
# Iris one-command installer (issue #4)
#
#   curl -fsSL https://raw.githubusercontent.com/irisworks/iris-core/main/install.sh | bash
#
# Pass bootstrap flags after `-s --`:
#   curl -fsSL .../install.sh | bash -s -- --setup --keyvault --firecracker
#
# Defaults to the zero-cloud quickstart (--setup --no-keyvault).
# Handles git clone/update into $IRIS_DIR/repo, then hands off to bootstrap.sh.
#
# Env overrides:
#   IRIS_DIR        install root            (default /iris)
#   IRIS_CORE_URL   repo to clone           (default https://github.com/irisworks/iris-core.git)
#   IRIS_CORE_REF   branch or tag to check out (default: latest release tag, falls back to main)
# ============================================================
set -euo pipefail

IRIS_DIR="${IRIS_DIR:-/iris}"
IRIS_CORE_URL="${IRIS_CORE_URL:-https://github.com/irisworks/iris-core.git}"
REPO_DIR="$IRIS_DIR/repo"

if ! command -v git >/dev/null 2>&1; then
	echo "[iris-install] git not found — installing..."
	sudo apt-get update -y -qq && sudo apt-get install -y -qq git
fi

if [ -n "${IRIS_CORE_REF:-}" ]; then
	echo "[iris-install] Using IRIS_CORE_REF override: $IRIS_CORE_REF"
else
	echo "[iris-install] Resolving latest release tag from $IRIS_CORE_URL"
	IRIS_CORE_REF="$(git ls-remote --tags --sort=-v:refname "$IRIS_CORE_URL" 'v*' 2>/dev/null \
		| awk '{print $2}' | sed 's|refs/tags/||' | grep -v '\^{}$' | head -n1)"
	if [ -z "$IRIS_CORE_REF" ]; then
		echo "[iris-install] No release tags found — falling back to main"
		IRIS_CORE_REF="main"
	fi
fi

echo "[iris-install] Installing Iris into $REPO_DIR (ref: $IRIS_CORE_REF)"

sudo mkdir -p "$IRIS_DIR"
sudo chown "$(id -un):$(id -gn)" "$IRIS_DIR"

if [ -d "$REPO_DIR/.git" ]; then
	echo "[iris-install] Existing checkout found — updating"
	git -C "$REPO_DIR" fetch --tags origin
	git -C "$REPO_DIR" checkout "$IRIS_CORE_REF"
	# Fast-forward only; a tag checkout leaves a detached HEAD, which is fine
	git -C "$REPO_DIR" pull --ff-only origin "$IRIS_CORE_REF" 2>/dev/null || true
else
	git clone --branch "$IRIS_CORE_REF" "$IRIS_CORE_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"

ARGS=("$@")
if [ ${#ARGS[@]} -eq 0 ]; then
	ARGS=(--setup --no-keyvault)
fi

# Testing hook: stop after clone/update, before the interactive bootstrap.
if [ "${IRIS_SKIP_BOOTSTRAP:-}" = "1" ]; then
	echo "[iris-install] IRIS_SKIP_BOOTSTRAP=1 — repo ready at $REPO_DIR, skipping bootstrap"
	exit 0
fi

echo "[iris-install] Handing off to bootstrap.sh ${ARGS[*]}"
if [ -t 0 ]; then
	exec bash bootstrap.sh "${ARGS[@]}"
else
	# stdin is the curl pipe — reattach the terminal so bootstrap prompts work
	if [ -e /dev/tty ]; then
		exec bash bootstrap.sh "${ARGS[@]}" </dev/tty
	else
		echo "[iris-install] No TTY available. Re-run interactively:"
		echo "  cd $REPO_DIR && bash bootstrap.sh ${ARGS[*]}"
		exit 1
	fi
fi
