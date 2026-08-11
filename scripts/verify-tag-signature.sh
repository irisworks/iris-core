#!/usr/bin/env bash
# ============================================================
# Verify that a git tag in a local checkout is GPG-signed by the
# published iris-core maintainer key.
#
#   verify-tag-signature.sh <repo_dir> <ref>
#
# Shared by install.sh (automatic installs) and the manual submodule
# upgrade procedure in docs/RELEASING.md — both paths that check out a
# release tag must go through the same verification, or one of them
# becomes a way to bypass it.
#
# Env overrides:
#   IRIS_CORE_SIGNING_GH_USER      GitHub user whose public key signs release tags (default: katrohit)
#   IRIS_CORE_SIGNING_FINGERPRINT  pin the expected signing key fingerprint (optional; see docs/SETUP.md)
#   IRIS_SKIP_TAG_VERIFY           set to 1 to skip signature verification entirely
# ============================================================
set -euo pipefail

REPO_DIR="${1:?usage: verify-tag-signature.sh <repo_dir> <ref>}"
ref="${2:?usage: verify-tag-signature.sh <repo_dir> <ref>}"
IRIS_CORE_SIGNING_GH_USER="${IRIS_CORE_SIGNING_GH_USER:-katrohit}"
IRIS_CORE_SIGNING_FINGERPRINT="${IRIS_CORE_SIGNING_FINGERPRINT:-}"

# Signature verification: only annotated/signed tags carry a signature to
# check. Branch refs (e.g. IRIS_CORE_REF=main) always skip, since there's
# nothing to verify. This doesn't move the trust root — the key itself is
# fetched over the same TLS+GitHub channel as the clone — but it does catch
# a tampered or force-moved tag inside the repo we just cloned, and gives
# mirrors/forks of iris-core something to check against.
verify_tag_signature() {
	local ref="$1"
	if ! git -C "$REPO_DIR" show-ref --tags --verify --quiet "refs/tags/$ref"; then
		echo "[verify-tag] $ref is not a tag — skipping signature verification"
		return 0
	fi

	if [ "${IRIS_SKIP_TAG_VERIFY:-}" = "1" ]; then
		echo "[verify-tag] IRIS_SKIP_TAG_VERIFY=1 — skipping signature verification for tag $ref"
		return 0
	fi

	if ! command -v gpg >/dev/null 2>&1; then
		echo "[verify-tag] gpg not found — installing..."
		if ! (sudo apt-get update -y -qq && sudo apt-get install -y -qq gnupg); then
			echo "[verify-tag] Could not install gpg — skipping signature verification for tag $ref"
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
		echo "[verify-tag] No signing key published at $key_url — skipping signature verification for tag $ref"
		return 0
	fi

	if ! GNUPGHOME="$gnupg_home" gpg --batch --import <<<"$key" >/dev/null 2>&1; then
		echo "[verify-tag] Could not import signing key from $key_url — skipping signature verification for tag $ref"
		return 0
	fi

	# The key_url may serve more than one key; collect every fingerprint so a
	# pin check can't pass against the first-listed key while verify-tag below
	# ends up trusting a different one that was imported alongside it.
	local fingerprints
	fingerprints="$(GNUPGHOME="$gnupg_home" gpg --batch --with-colons --fingerprint 2>/dev/null \
		| awk -F: '/^fpr:/ {print $10}')"

	local expected_fingerprint="${IRIS_CORE_SIGNING_FINGERPRINT//[[:space:]]/}"
	expected_fingerprint="${expected_fingerprint^^}"

	local fingerprint
	if [ -n "$expected_fingerprint" ]; then
		if ! grep -qxF "$expected_fingerprint" <<<"$fingerprints"; then
			echo "[verify-tag] Signing key fingerprint mismatch for tag $ref:"
			echo "  expected: $expected_fingerprint"
			echo "  fetched:  $(tr '\n' ' ' <<<"$fingerprints")"
			echo "[verify-tag] Aborting — no key served by $key_url matches IRIS_CORE_SIGNING_FINGERPRINT."
			return 1
		fi
		# Drop every other key from the keyring so verify-tag can only be
		# satisfied by the pinned key, not any other key served alongside it.
		local fpr
		while IFS= read -r fpr; do
			[ "$fpr" = "$expected_fingerprint" ] && continue
			GNUPGHOME="$gnupg_home" gpg --batch --yes --delete-keys "$fpr" >/dev/null 2>&1 || true
		done <<<"$fingerprints"
		fingerprint="$expected_fingerprint"
	else
		fingerprint="$(head -n1 <<<"$fingerprints")"
	fi

	if ! GNUPGHOME="$gnupg_home" git -C "$REPO_DIR" -c gpg.format=openpgp verify-tag "$ref"; then
		echo "[verify-tag] Signature verification FAILED for tag $ref."
		echo "  This tag is either unsigned or its signature does not match the"
		echo "  published key for $IRIS_CORE_SIGNING_GH_USER ($key_url)."
		echo "  Aborting. Set IRIS_SKIP_TAG_VERIFY=1 to bypass (not recommended)."
		return 1
	fi

	echo "[verify-tag] Verified tag $ref — signing key fingerprint: $fingerprint"
}

# Only run when executed directly (not when sourced by install.sh).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
	verify_tag_signature "$ref"
fi
