/**
 * MCP server configuration: <workspace>/meta/mcp.json
 *
 * Loading is fail-safe by design: an absent file means zero servers, a
 * malformed file or invalid entry is recorded as an error and skipped —
 * loadMcpConfig never throws. Secrets are referenced as ${VAR} and expanded
 * from process.env (i.e. /iris/.env), never stored in mcp.json itself.
 */

import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

export const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface McpServerConfig {
	name: string;
	transport: "stdio" | "http";
	/** stdio */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** http (Streamable HTTP) */
	url?: string;
	headers?: Record<string, string>;
	/** common */
	enabled: boolean;
	allowedTools?: string[];
	timeoutMs: number;
	connectTimeoutMs: number;
}

export interface McpConfig {
	/** Valid, env-expanded server entries (including disabled ones) */
	servers: McpServerConfig[];
	/** Entries that failed validation or env expansion, keyed by server name */
	invalid: { name: string; error: string }[];
	/** File-level problems (unreadable, malformed JSON, wrong shape) */
	errors: string[];
	/** sha256 of the raw file contents; "" when the file is absent */
	hash: string;
}

export function mcpConfigPath(workingDir: string): string {
	return join(workingDir, "meta", "mcp.json");
}

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Expand ${VAR} references from process.env. Throws on unset vars. */
function expandEnvVars(value: string): string {
	return value.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
		const resolved = process.env[varName];
		if (resolved === undefined) {
			throw new Error(`env var ${varName} not set`);
		}
		return resolved;
	});
}

function expandRecord(record: Record<string, unknown>, what: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		if (typeof value !== "string") {
			throw new Error(`${what}.${key} must be a string`);
		}
		out[key] = expandEnvVars(value);
	}
	return out;
}

function parseServer(name: string, raw: unknown): McpServerConfig {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("server entry must be an object");
	}
	const entry = raw as Record<string, unknown>;

	const transport = entry.transport;
	if (transport !== "stdio" && transport !== "http") {
		throw new Error(`transport must be "stdio" or "http"`);
	}

	const enabled = entry.enabled === undefined ? true : entry.enabled === true;
	const timeoutMs = typeof entry.timeoutMs === "number" && entry.timeoutMs > 0 ? entry.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
	const connectTimeoutMs =
		typeof entry.connectTimeoutMs === "number" && entry.connectTimeoutMs > 0
			? entry.connectTimeoutMs
			: DEFAULT_CONNECT_TIMEOUT_MS;

	let allowedTools: string[] | undefined;
	if (entry.allowedTools !== undefined) {
		if (!Array.isArray(entry.allowedTools) || entry.allowedTools.some((t) => typeof t !== "string")) {
			throw new Error("allowedTools must be an array of strings");
		}
		allowedTools = entry.allowedTools as string[];
	}

	const config: McpServerConfig = { name, transport, enabled, allowedTools, timeoutMs, connectTimeoutMs };

	if (transport === "stdio") {
		if (typeof entry.command !== "string" || entry.command.length === 0) {
			throw new Error("stdio server requires a command");
		}
		config.command = expandEnvVars(entry.command);
		if (entry.args !== undefined) {
			if (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== "string")) {
				throw new Error("args must be an array of strings");
			}
			config.args = (entry.args as string[]).map(expandEnvVars);
		} else {
			config.args = [];
		}
		if (entry.env !== undefined) {
			if (typeof entry.env !== "object" || entry.env === null || Array.isArray(entry.env)) {
				throw new Error("env must be an object of string values");
			}
			config.env = expandRecord(entry.env as Record<string, unknown>, "env");
		}
	} else {
		if (typeof entry.url !== "string" || entry.url.length === 0) {
			throw new Error("http server requires a url");
		}
		config.url = expandEnvVars(entry.url);
		try {
			new URL(config.url);
		} catch {
			throw new Error(`invalid url: ${entry.url}`);
		}
		if (entry.headers !== undefined) {
			if (typeof entry.headers !== "object" || entry.headers === null || Array.isArray(entry.headers)) {
				throw new Error("headers must be an object of string values");
			}
			config.headers = expandRecord(entry.headers as Record<string, unknown>, "headers");
		}
	}

	return config;
}

export function loadMcpConfig(workingDir: string): McpConfig {
	const path = mcpConfigPath(workingDir);

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === "ENOENT") {
			return { servers: [], invalid: [], errors: [], hash: "" };
		}
		return { servers: [], invalid: [], errors: [`cannot read ${path}: ${err.message}`], hash: "" };
	}

	const hash = createHash("sha256").update(raw).digest("hex");

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { servers: [], invalid: [], errors: [`malformed JSON in ${path}: ${(e as Error).message}`], hash };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { servers: [], invalid: [], errors: [`${path} must be a JSON object with a "servers" key`], hash };
	}

	const serversRaw = (parsed as Record<string, unknown>).servers;
	if (serversRaw === undefined) {
		return { servers: [], invalid: [], errors: [], hash };
	}
	if (typeof serversRaw !== "object" || serversRaw === null || Array.isArray(serversRaw)) {
		return { servers: [], invalid: [], errors: [`"servers" must be an object keyed by server name`], hash };
	}

	const servers: McpServerConfig[] = [];
	const invalid: { name: string; error: string }[] = [];
	for (const [name, entry] of Object.entries(serversRaw)) {
		try {
			servers.push(parseServer(name, entry));
		} catch (e) {
			invalid.push({ name, error: (e as Error).message });
		}
	}

	return { servers, invalid, errors: [], hash };
}
