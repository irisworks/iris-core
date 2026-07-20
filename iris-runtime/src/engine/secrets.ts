/**
 * Secret resolution behind GET /secrets/:name (see api.ts).
 *
 * Three backends, selected by env vars — no vendor-specific code in core:
 *   - env (default): process.env lookup, falling back to Azure Key Vault when
 *     IRIS_KEY_VAULT is set. Kept for parity with the pre-broker get-secret
 *     script; this is the only place that still shells out to `az`.
 *   - file (IRIS_SECRETS_MODE=store): the encrypted local SecretStore, with
 *     env as fallback so half-migrated installs keep resolving.
 *   - broker: proxies to IRIS_SECRET_BROKER_URL. In proxy mode that URL is
 *     the bundled iris-broker daemon; it can equally be an external broker
 *     (Vault, Infisical, a custom shim) — iris-core doesn't know or care.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";
import { SecretStore, secretsMode, type SecretMeta } from "./secret-store.js";
import { registerSecretValue } from "./redact.js";

const execFileAsync = promisify(execFile);

export interface SecretProvider {
	get(name: string): Promise<string | undefined>;
}

function envVarName(secretName: string): string {
	return secretName.replace(/-/g, "_");
}

export const envSecretProvider: SecretProvider = {
	async get(name: string): Promise<string | undefined> {
		const fromEnv = process.env[envVarName(name)];
		if (fromEnv) return fromEnv;

		const vault = process.env.IRIS_KEY_VAULT;
		if (!vault) return undefined;

		try {
			const { stdout } = await execFileAsync("az", [
				"keyvault",
				"secret",
				"show",
				"--vault-name",
				vault,
				"--name",
				name,
				"--query",
				"value",
				"-o",
				"tsv",
			]);
			const value = stdout.trim();
			return value || undefined;
		} catch (err) {
			log.logWarning("[secrets] Key Vault lookup failed", err instanceof Error ? err.message : String(err));
			return undefined;
		}
	},
};

export function createBrokerSecretProvider(baseUrl: string, token?: string): SecretProvider {
	return {
		async get(name: string): Promise<string | undefined> {
			try {
				const res = await fetch(`${baseUrl.replace(/\/$/, "")}/secret/${encodeURIComponent(name)}`, {
					headers: token ? { Authorization: `Bearer ${token}` } : {},
				});
				if (!res.ok) return undefined;
				const body = (await res.json()) as { value?: string };
				return body.value;
			} catch (err) {
				log.logWarning("[secrets] Broker lookup failed", err instanceof Error ? err.message : String(err));
				return undefined;
			}
		},
	};
}

/** Encrypted local store (store mode), falling back to env for anything not yet migrated. */
export const fileSecretProvider: SecretProvider = {
	async get(name: string): Promise<string | undefined> {
		const store = SecretStore.open();
		const fromStore = store?.get(name);
		if (fromStore !== undefined) return fromStore;
		return envSecretProvider.get(name);
	},
};

/**
 * In store/proxy mode, every resolved plaintext is registered with the
 * redaction backstop so sandbox output can mask it (redact.ts). Env mode is
 * left untouched — its behavior must stay bit-identical to pre-mode releases.
 */
function withRedactionRegistry(provider: SecretProvider): SecretProvider {
	return {
		async get(name: string): Promise<string | undefined> {
			const value = await provider.get(name);
			if (value !== undefined) registerSecretValue(value);
			return value;
		},
	};
}

/** Resolved once per call so tests / IRIS_SECRET_BROKER_URL changes don't need a restart. */
export function getSecretProvider(): SecretProvider {
	const brokerUrl = process.env.IRIS_SECRET_BROKER_URL;
	if (brokerUrl) {
		return withRedactionRegistry(createBrokerSecretProvider(brokerUrl, process.env.IRIS_SECRET_BROKER_TOKEN));
	}
	if (secretsMode() === "store") {
		return withRedactionRegistry(fileSecretProvider);
	}
	return envSecretProvider;
}

/**
 * Policy metadata for a secret (proxyOnly / agentReadable), so api.ts can
 * refuse plaintext reads without touching the value. Store mode reads the
 * local store; proxy mode asks the broker's /meta route; env mode has no
 * metadata (undefined = no restrictions).
 */
export async function getSecretMeta(name: string): Promise<SecretMeta | undefined> {
	const brokerUrl = process.env.IRIS_SECRET_BROKER_URL;
	if (brokerUrl) {
		try {
			const token = process.env.IRIS_SECRET_BROKER_TOKEN;
			const res = await fetch(`${brokerUrl.replace(/\/$/, "")}/meta/${encodeURIComponent(name)}`, {
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			});
			if (!res.ok) return undefined;
			return (await res.json()) as SecretMeta;
		} catch {
			return undefined;
		}
	}
	if (secretsMode() === "store") {
		return SecretStore.open()?.meta(name);
	}
	return undefined;
}
