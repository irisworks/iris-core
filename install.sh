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
#   IRIS_DIR                   install root            (default /iris)
#   IRIS_CORE_URL              repo to clone           (default https://github.com/irisworks/iris-core.git)
#   IRIS_CORE_REF              branch or tag to check out (default: latest release tag, falls back to main)
#   IRIS_CORE_SIGNING_GH_USER  GitHub user whose public key signs release tags (default: katrohit)
#   IRIS_CORE_SIGNING_FINGERPRINT  pin the expected signing key fingerprint (optional; see docs/SETUP.md)
#   IRIS_SKIP_TAG_VERIFY       set to 1 to skip signature verification entirely
# ============================================================
set -euo pipefail

IRIS_DIR="${IRIS_DIR:-/iris}"
IRIS_CORE_URL="${IRIS_CORE_URL:-https://github.com/irisworks/iris-core.git}"
IRIS_CORE_SIGNING_GH_USER="${IRIS_CORE_SIGNING_GH_USER:-katrohit}"
IRIS_CORE_SIGNING_FINGERPRINT="${IRIS_CORE_SIGNING_FINGERPRINT:-}"
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

# Signature verification: only annotated/signed tags carry a signature to
# check. Branch refs (e.g. IRIS_CORE_REF=main) always skip, since there's
# nothing to verify. This doesn't move the trust root — the key itself is
# fetched over the same TLS+GitHub channel as the clone — but it does catch
# a tampered or force-moved tag inside the repo we just cloned, and gives
# mirrors/forks of iris-core something to check against.
verify_tag_signature() {
	local ref="$1"
	if ! git -C "$REPO_DIR" show-ref --tags --verify --quiet "refs/tags/$ref"; then
		echo "[iris-install] $ref is not a tag — skipping signature verification"
		return 0
	fi

	if [ "${IRIS_SKIP_TAG_VERIFY:-}" = "1" ]; then
		echo "[iris-install] IRIS_SKIP_TAG_VERIFY=1 — skipping signature verification for tag $ref"
		return 0
	fi

	if ! command -v gpg >/dev/null 2>&1; then
		echo "[iris-install] gpg not found — installing..."
		if ! (sudo apt-get update -y -qq && sudo apt-get install -y -qq gnupg); then
			echo "[iris-install] Could not install gpg — skipping signature verification for tag $ref"
			return 0
		fi
	fi

	local gnupg_home
	gnupg_home="$(mktemp -d)"
	trap 'rm -rf "$gnupg_home"' RETURN
	chmod 700 "$gnupg_home"

	local key_url="https://github.com/${IRIS_CORE_SIGNING_GH_USER}.gpg"
	local key
	key="$(curl -fsSL "$key_url" 2>/dev/null || true)"
	if [ -z "$key" ]; then
		echo "[iris-install] No signing key published at $key_url — skipping signature verification for tag $ref"
		return 0
	fi

	if ! GNUPGHOME="$gnupg_home" gpg --batch --import <<<"$key" >/dev/null 2>&1; then
		echo "[iris-install] Could not import signing key from $key_url — skipping signature verification for tag $ref"
		return 0
	fi

	local fingerprint
	fingerprint="$(GNUPGHOME="$gnupg_home" gpg --batch --with-colons --fingerprint 2>/dev/null \
		| awk -F: '/^fpr:/ {print $10; exit}')"

	local expected_fingerprint="${IRIS_CORE_SIGNING_FINGERPRINT//[[:space:]]/}"
	if [ -n "$expected_fingerprint" ] && [ "$fingerprint" != "$expected_fingerprint" ]; then
		echo "[iris-install] Signing key fingerprint mismatch for tag $ref:"
		echo "  expected: $expected_fingerprint"
		echo "  fetched:  $fingerprint"
		echo "[iris-install] Aborting — the key served by $key_url does not match IRIS_CORE_SIGNING_FINGERPRINT."
		exit 1
	fi

	if ! GNUPGHOME="$gnupg_home" git -C "$REPO_DIR" -c gpg.format=openpgp verify-tag "$ref"; then
		echo "[iris-install] Signature verification FAILED for tag $ref."
		echo "  This tag is either unsigned or its signature does not match the"
		echo "  published key for $IRIS_CORE_SIGNING_GH_USER ($key_url)."
		echo "  Aborting install. Set IRIS_SKIP_TAG_VERIFY=1 to bypass (not recommended)."
		exit 1
	fi

	echo "[iris-install] Verified tag $ref — signing key fingerprint: $fingerprint"
	trap - RETURN
	rm -rf "$gnupg_home"
}

verify_tag_signature "$IRIS_CORE_REF"

echo "[iris-install] Resolved ref: $IRIS_CORE_REF"

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
