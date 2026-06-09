/**
 * Minimal Azure Key Vault helper for storing dedicated bot/app credentials.
 *
 * Per CLAUDE.md, secrets are never hardcoded — sub_agents stores secret *references*
 * (Key Vault URIs), never raw tokens. This module is the write/read/delete side of
 * that contract for runtime-issued secrets (the get-secret skill is the read side
 * for agent shell code; this is the TS-side counterpart used by the registry).
 *
 * Degrades gracefully (mirrors getDb()/noDb() in sub-agent-registry.ts): when
 * IRIS_KEY_VAULT isn't set, every operation is a logged no-op returning null.
 *
 * Uses execFile (argument array, no shell) — never interpolates secret values
 * into a shell string, which would be a command-injection vector.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";

const execFileAsync = promisify(execFile);

function vaultName(): string | null {
	const v = process.env.IRIS_KEY_VAULT?.trim();
	return v ? v : null;
}

// Key Vault secret names allow only alphanumeric characters and hyphens.
function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9-]/g, "-");
}

function secretUri(vault: string, secretName: string): string {
	return `https://${vault}.vault.azure.net/secrets/${secretName}`;
}

// Extract the secret name from a Key Vault URI written by setSecret.
function nameFromRef(ref: string): string | null {
	const m = ref.match(/\/secrets\/([^/]+)/);
	return m ? m[1] : null;
}

/**
 * Store a secret value, returning its Key Vault URI (the "ref" persisted in
 * sub_agents.*_token_ref). Returns null if Key Vault isn't configured — the
 * caller should treat that as "credentials unavailable," not silently proceed.
 */
export async function setSecret(name: string, value: string): Promise<string | null> {
	const vault = vaultName();
	if (!vault) {
		log.logWarning(`[keyvault] setSecret(${name}): IRIS_KEY_VAULT not set — skipping`);
		return null;
	}
	const secretName = sanitizeName(name);
	try {
		await execFileAsync("az", [
			"keyvault", "secret", "set",
			"--vault-name", vault,
			"--name", secretName,
			"--value", value,
			"-o", "none",
		]);
		return secretUri(vault, secretName);
	} catch (err) {
		log.logWarning(`[keyvault] setSecret(${secretName}) failed`, String(err));
		return null;
	}
}

/** Resolve a Key Vault URI ref back to its secret value. */
export async function getSecret(ref: string | null | undefined): Promise<string | null> {
	if (!ref) return null;
	const vault = vaultName();
	const secretName = nameFromRef(ref);
	if (!vault || !secretName) return null;
	try {
		const { stdout } = await execFileAsync("az", [
			"keyvault", "secret", "show",
			"--vault-name", vault,
			"--name", secretName,
			"--query", "value",
			"-o", "tsv",
		]);
		return stdout.trim();
	} catch (err) {
		log.logWarning(`[keyvault] getSecret(${secretName}) failed`, String(err));
		return null;
	}
}

/** Delete a secret by ref — used when detaching an integration or deleting an agent. */
export async function deleteSecretIfPresent(ref: string | null | undefined): Promise<void> {
	if (!ref) return;
	const vault = vaultName();
	const secretName = nameFromRef(ref);
	if (!vault || !secretName) return;
	try {
		await execFileAsync("az", [
			"keyvault", "secret", "delete",
			"--vault-name", vault,
			"--name", secretName,
			"-o", "none",
		]);
	} catch (err) {
		// Non-fatal — orphaned secret is a cleanup nuisance, not a correctness issue
		log.logWarning(`[keyvault] deleteSecret(${secretName}) failed`, String(err));
	}
}
