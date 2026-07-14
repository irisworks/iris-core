/**
 * Secret resolution behind GET /secrets/:name (see api.ts).
 *
 * Two backends, selected by env var — no vendor-specific code in core:
 *   - env (default): process.env lookup, falling back to Azure Key Vault when
 *     IRIS_KEY_VAULT is set. Kept for parity with the pre-broker get-secret
 *     script; this is the only place that still shells out to `az`.
 *   - broker: proxies to IRIS_SECRET_BROKER_URL. Whatever's behind that URL
 *     (Vault, Infisical, a custom shim) is the operator's choice; iris-core
 *     doesn't know or care which.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";

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

/** Resolved once per call so tests / IRIS_SECRET_BROKER_URL changes don't need a restart. */
export function getSecretProvider(): SecretProvider {
	const brokerUrl = process.env.IRIS_SECRET_BROKER_URL;
	if (brokerUrl) {
		return createBrokerSecretProvider(brokerUrl, process.env.IRIS_SECRET_BROKER_TOKEN);
	}
	return envSecretProvider;
}
