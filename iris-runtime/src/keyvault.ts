/**
 * Azure Key Vault helper for storing dedicated bot/app credentials.
 *
 * sub_agents.*_token_ref stores a *reference* (never a raw token). Two ref formats:
 *
 *   Key Vault URI  https://<vault>.vault.azure.net/secrets/<name>
 *                  Used when IRIS_KEY_VAULT is set. Secrets live in Azure KV.
 *
 *   Raw fallback   raw:<base64-encoded-value>
 *                  Used when IRIS_KEY_VAULT is NOT set (dev / non-Azure setups).
 *                  The value is encoded in the ref itself — no external store.
 *                  NOT suitable for production; log warning makes this clear.
 *
 * Uses execFile (argument array, no shell) — never interpolates secret values
 * into a shell string, which would be a command-injection vector.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";

const execFileAsync = promisify(execFile);

const RAW_PREFIX = "raw:";

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
 * Store a secret value and return a ref string to persist in the database.
 *
 * When IRIS_KEY_VAULT is set: stores in Azure Key Vault, returns the KV URI.
 * When not set: encodes the value as "raw:<base64>" and returns that as the ref.
 * The raw fallback keeps the attach flow functional without Azure; it is not
 * secure for production (the value is recoverable from the database ref).
 */
export async function setSecret(name: string, value: string): Promise<string | null> {
	const vault = vaultName();
	if (!vault) {
		log.logWarning(
			`[keyvault] IRIS_KEY_VAULT not set — storing "${name}" as base64 ref. ` +
			"Configure Key Vault for production; this fallback is for development only.",
		);
		return `${RAW_PREFIX}${Buffer.from(value, "utf-8").toString("base64")}`;
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

/**
 * Resolve a ref back to its secret value.
 * Handles both Key Vault URIs and raw fallback refs transparently.
 */
export async function getSecret(ref: string | null | undefined): Promise<string | null> {
	if (!ref) return null;

	// Raw fallback — value encoded in the ref itself, no KV call needed.
	if (ref.startsWith(RAW_PREFIX)) {
		try {
			return Buffer.from(ref.slice(RAW_PREFIX.length), "base64").toString("utf-8");
		} catch {
			log.logWarning("[keyvault] getSecret: malformed raw ref");
			return null;
		}
	}

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

/**
 * Delete a secret by ref — used when detaching an integration or deleting an agent.
 * Raw fallback refs have no external storage to clean up; KV URIs are deleted via az CLI.
 */
export async function deleteSecretIfPresent(ref: string | null | undefined): Promise<void> {
	if (!ref || ref.startsWith(RAW_PREFIX)) return;
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
