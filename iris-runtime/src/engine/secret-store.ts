// ============================================================================
// SecretStore — encrypted-at-rest secret storage for the store/proxy secrets
// modes (IRIS_SECRETS_MODE). Used in-process by the runtime in `store` mode
// and by the iris-broker daemon in `proxy` mode; `env` mode never opens it.
//
// AES-256-GCM per entry (fresh random IV per write) so list/metadata never
// require decryption and a single corrupted entry cannot take down the file.
// Node built-in crypto only — no new dependencies.
// ============================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import * as log from "./log.js";

/** Same safe charset the web transport uses for ids (SAFE_ID in web.ts). */
export const SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Env vars bootstrap historically wrote into /iris/.env that are actual
 * credentials. Shared by `iris-secret import-env` (which moves them into the
 * store) and scrubProcessEnv (which drops them from the runtime's process.env
 * so agent shells never inherit them).
 */
export const SENSITIVE_ENV_VARS = [
	"AZURE_FOUNDRY_KEY",
	"FOUNDRY_E2_KEY",
	"DEEPSEEK_API_KEY",
	"MISTRAL_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"IRIS_SLACK_APP_TOKEN",
	"IRIS_SLACK_BOT_TOKEN",
	"TELEGRAM_BOT_TOKEN",
	"GITHUB_TOKEN",
	"RESEND_API_KEY",
] as const;

export type SecretsMode = "env" | "store" | "proxy";

export function secretsMode(): SecretsMode {
	const mode = process.env.IRIS_SECRETS_MODE;
	if (mode === "store" || mode === "proxy") return mode;
	return "env";
}

export type SecretSource = "drop" | "api" | "cli" | "import";

export interface SecretMeta {
	createdAt: string;
	updatedAt: string;
	source: SecretSource;
	/** Only usable through the broker's injection gateway — plaintext reads always 403. */
	proxyOnly: boolean;
	/** false = resolvable by the runtime internally but never served to API callers. */
	agentReadable: boolean;
}

interface StoredEntry extends SecretMeta {
	iv: string;
	tag: string;
	ciphertext: string;
}

interface StoreFile {
	version: 1;
	secrets: Record<string, StoredEntry>;
}

export interface SecretStoreOptions {
	keyFile?: string;
	storeFile?: string;
}

const DEFAULT_KEY_FILE = "/iris/secret.key";
const DEFAULT_STORE_FILE = "/iris/secrets.json.enc";

function envVarName(secretName: string): string {
	return secretName.replace(/-/g, "_");
}

function secretNameVariant(name: string): string {
	// Key-Vault-style names use hyphens, env-style names use underscores; the
	// existing get-secret path accepts either, so the store does too.
	return name.includes("-") ? envVarName(name) : name.replace(/_/g, "-");
}

export class SecretStore {
	private constructor(
		private readonly key: Buffer,
		private readonly storeFile: string,
	) {}

	/**
	 * Opens the store, or returns null when the key file is absent — the whole
	 * feature is inert on installs that never opted into a secrets mode.
	 */
	static open(options: SecretStoreOptions = {}): SecretStore | null {
		const keyFile = options.keyFile ?? process.env.IRIS_SECRET_KEY_FILE ?? DEFAULT_KEY_FILE;
		const storeFile = options.storeFile ?? process.env.IRIS_SECRET_STORE_FILE ?? DEFAULT_STORE_FILE;
		if (!existsSync(keyFile)) return null;
		let key: Buffer;
		try {
			key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
		} catch (err) {
			log.logWarning("[secret-store] cannot read key file", err instanceof Error ? err.message : String(err));
			return null;
		}
		if (key.length !== 32) {
			log.logWarning(`[secret-store] key file ${keyFile} is not 32 bytes of hex — store disabled`);
			return null;
		}
		return new SecretStore(key, storeFile);
	}

	/** Generates a fresh 32-byte hex key file (0600). Refuses to overwrite. */
	static initKeyFile(keyFile: string): boolean {
		if (existsSync(keyFile)) return false;
		writeFileSync(keyFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
		return true;
	}

	// The file is re-read on every operation: the CLI, the broker daemon, and
	// (in store mode) the runtime may all touch it without coordination.
	// Last-write-wins on concurrent set() is acceptable at this scale.
	private read(): StoreFile {
		if (!existsSync(this.storeFile)) return { version: 1, secrets: {} };
		try {
			return JSON.parse(readFileSync(this.storeFile, "utf8")) as StoreFile;
		} catch (err) {
			log.logWarning("[secret-store] store file unreadable, treating as empty", err instanceof Error ? err.message : String(err));
			return { version: 1, secrets: {} };
		}
	}

	private write(data: StoreFile): void {
		const tmp = join(dirname(this.storeFile), `.secrets.json.enc.tmp-${process.pid}`);
		writeFileSync(tmp, JSON.stringify(data, null, "\t"), { mode: 0o600 });
		renameSync(tmp, this.storeFile);
		try {
			chmodSync(this.storeFile, 0o600);
		} catch {
			// best-effort; the rename already carried the tmp file's 0600 mode
		}
	}

	private resolveEntry(data: StoreFile, name: string): { name: string; entry: StoredEntry } | undefined {
		if (data.secrets[name]) return { name, entry: data.secrets[name] };
		const variant = secretNameVariant(name);
		if (data.secrets[variant]) return { name: variant, entry: data.secrets[variant] };
		return undefined;
	}

	has(name: string): boolean {
		return this.resolveEntry(this.read(), name) !== undefined;
	}

	meta(name: string): SecretMeta | undefined {
		const found = this.resolveEntry(this.read(), name);
		if (!found) return undefined;
		const { iv: _iv, tag: _tag, ciphertext: _ct, ...meta } = found.entry;
		return meta;
	}

	get(name: string): string | undefined {
		const found = this.resolveEntry(this.read(), name);
		if (!found) return undefined;
		try {
			const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(found.entry.iv, "base64"));
			decipher.setAuthTag(Buffer.from(found.entry.tag, "base64"));
			return Buffer.concat([decipher.update(Buffer.from(found.entry.ciphertext, "base64")), decipher.final()]).toString("utf8");
		} catch {
			log.logWarning(`[secret-store] failed to decrypt '${found.name}' (wrong key or tampered entry)`);
			return undefined;
		}
	}

	set(
		name: string,
		value: string,
		options: { source?: SecretSource; proxyOnly?: boolean; agentReadable?: boolean } = {},
	): void {
		if (!SECRET_NAME_RE.test(name)) throw new Error(`invalid secret name '${name}'`);
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key, iv);
		const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		const data = this.read();
		const existing = this.resolveEntry(data, name);
		const now = new Date().toISOString();
		const target = existing?.name ?? name;
		data.secrets[target] = {
			iv: iv.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			ciphertext: ciphertext.toString("base64"),
			createdAt: existing?.entry.createdAt ?? now,
			updatedAt: now,
			source: options.source ?? "api",
			proxyOnly: options.proxyOnly ?? existing?.entry.proxyOnly ?? false,
			agentReadable: options.agentReadable ?? existing?.entry.agentReadable ?? true,
		};
		this.write(data);
	}

	delete(name: string): boolean {
		const data = this.read();
		const found = this.resolveEntry(data, name);
		if (!found) return false;
		delete data.secrets[found.name];
		this.write(data);
		return true;
	}

	list(): Array<{ name: string } & SecretMeta> {
		const data = this.read();
		return Object.entries(data.secrets).map(([name, entry]) => {
			const { iv: _iv, tag: _tag, ciphertext: _ct, ...meta } = entry;
			return { name, ...meta };
		});
	}
}

/**
 * Removes credential vars from process.env after startup consumers (transports,
 * web UI) have taken their copies, so shells spawned by HostExecutor inherit
 * nothing sensitive. A var is only scrubbed when the active secrets backend can
 * still resolve it without process.env (store/broker holds it) or the caller
 * marks it already consumed — half-migrated installs keep working.
 */
export async function scrubProcessEnv(options: {
	resolvable: (name: string) => Promise<boolean>;
	consumed?: string[];
}): Promise<void> {
	if (secretsMode() === "env") return;
	const consumed = new Set(options.consumed ?? []);
	const scrubbed: string[] = [];
	const retained: string[] = [];
	for (const envVar of SENSITIVE_ENV_VARS) {
		if (process.env[envVar] === undefined) continue;
		if (consumed.has(envVar) || (await options.resolvable(envVar.replace(/_/g, "-")))) {
			delete process.env[envVar];
			scrubbed.push(envVar);
		} else {
			retained.push(envVar);
		}
	}
	// The web transport copies its password in its constructor; nothing else
	// reads it after startup.
	if (process.env.IRIS_WEBUI_PASSWORD !== undefined) {
		delete process.env.IRIS_WEBUI_PASSWORD;
		scrubbed.push("IRIS_WEBUI_PASSWORD");
	}
	if (scrubbed.length > 0) log.logInfo(`[secrets] scrubbed from process.env: ${scrubbed.join(", ")}`);
	if (retained.length > 0) {
		log.logInfo(`[secrets] retained in process.env (not yet in the secret store): ${retained.join(", ")}`);
	}
}
