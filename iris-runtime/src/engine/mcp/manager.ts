/**
 * Process-global MCP connection manager.
 *
 * Connections are lazy: nothing happens at process startup — the first
 * refresh() (triggered by the first agent run or a /mcp/status request)
 * connects configured servers. refresh() is hash-gated so the per-message
 * call is a no-op while mcp.json is unchanged, and it never throws: a bad
 * or unreachable server is marked failed and surfaced in status, while the
 * runtime and all other servers keep working. Failed servers are retried
 * lazily with a backoff so a crashed stdio server self-heals on a later
 * message without a restart storm.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as log from "../log.js";
import { loadMcpConfig, type McpServerConfig } from "./config.js";
import { type McpToolTarget, wrapMcpTools } from "./tools.js";

const RETRY_BACKOFF_MS = 60_000;

export type McpServerStatusValue = "connected" | "connecting" | "failed" | "disabled";

interface ServerState extends McpToolTarget {
	name: string;
	config: McpServerConfig;
	/** Serialized resolved config, used to detect per-server changes */
	configKey: string;
	status: McpServerStatusValue;
	tools: AgentTool<any>[];
	error?: string;
	lastAttempt: number;
}

export interface McpServerStatus {
	name: string;
	status: McpServerStatusValue;
	toolCount: number;
	toolNames: string[];
	error?: string;
}

export interface McpStatusSummary {
	servers: McpServerStatus[];
	configErrors: string[];
	configHash: string;
}

export class McpManager {
	private servers = new Map<string, ServerState>();
	private configErrors: string[] = [];
	private lastHash: string | null = null;
	private inFlight: Promise<void> | null = null;

	constructor(private workingDir: string) {}

	/** Reload mcp.json and reconcile connections. Serialized; never throws. */
	refresh(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.doRefresh().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	private async doRefresh(): Promise<void> {
		const config = loadMcpConfig(this.workingDir);

		if (config.hash === this.lastHash) {
			await this.retryFailed();
			return;
		}

		// Invalid per-server entries surface as failed servers below, so only
		// file-level problems go into configErrors.
		this.configErrors = config.errors;

		const desired = new Map<string, McpServerConfig>(config.servers.map((s) => [s.name, s]));

		// Close servers that were removed or whose config changed
		for (const [name, state] of this.servers) {
			const next = desired.get(name);
			if (!next || JSON.stringify(next) !== state.configKey) {
				await this.closeServer(state);
				this.servers.delete(name);
			}
		}

		// Invalid entries surface as failed servers so they show up in status
		for (const { name, error } of config.invalid) {
			if (!this.servers.has(name)) {
				this.servers.set(name, {
					name,
					config: { name, transport: "stdio", enabled: false, timeoutMs: 0, connectTimeoutMs: 0 },
					configKey: "",
					status: "failed",
					tools: [],
					error,
					lastAttempt: Date.now(),
				});
			}
		}

		// Connect new/changed servers
		for (const serverConfig of config.servers) {
			if (this.servers.has(serverConfig.name)) continue;
			const state: ServerState = {
				name: serverConfig.name,
				config: serverConfig,
				configKey: JSON.stringify(serverConfig),
				status: serverConfig.enabled ? "connecting" : "disabled",
				tools: [],
				lastAttempt: 0,
			};
			this.servers.set(serverConfig.name, state);
			if (serverConfig.enabled) {
				await this.connectServer(state);
			}
		}

		this.lastHash = config.hash;
	}

	private async retryFailed(): Promise<void> {
		const now = Date.now();
		for (const state of this.servers.values()) {
			// Invalid config entries (configKey === "") can only be fixed by editing mcp.json
			if (state.status === "failed" && state.configKey !== "" && now - state.lastAttempt > RETRY_BACKOFF_MS) {
				await this.connectServer(state);
			}
		}
	}

	private async connectServer(state: ServerState): Promise<void> {
		const { config } = state;
		state.status = "connecting";
		state.lastAttempt = Date.now();
		state.tools = [];
		state.error = undefined;

		const client = new Client({ name: "iris-runtime", version: "1.0.0" }, { capabilities: {} });
		try {
			const connect = async () => {
				if (config.transport === "stdio") {
					const transport = new StdioClientTransport({
						command: config.command as string,
						args: config.args ?? [],
						env: { ...getDefaultEnvironment(), ...config.env },
						stderr: "pipe",
					});
					await client.connect(transport);
					transport.stderr?.on("data", (chunk: Buffer) => {
						const text = chunk.toString().trim();
						if (text) log.logWarning(`[mcp:${config.name}] ${text}`);
					});
				} else {
					const transport = new StreamableHTTPClientTransport(new URL(config.url as string), {
						requestInit: config.headers ? { headers: config.headers } : undefined,
					});
					await client.connect(transport);
				}
				return client.listTools();
			};

			const timeout = new Promise<never>((_, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`connect timed out after ${config.connectTimeoutMs}ms`)),
					config.connectTimeoutMs,
				);
				timer.unref();
			});
			const { tools: mcpTools } = await Promise.race([connect(), timeout]);

			client.onclose = () => {
				if (state.client === client && state.status === "connected") {
					state.status = "failed";
					state.error = "connection closed";
					log.logWarning(`[mcp:${config.name}] connection closed`);
				}
			};
			client.onerror = (error: Error) => {
				log.logWarning(`[mcp:${config.name}] ${error.message}`);
			};

			const { tools, dropped } = wrapMcpTools(config, state, mcpTools);
			for (const { name, reason } of dropped) {
				log.logWarning(`[mcp:${config.name}] dropped tool '${name}': ${reason}`);
			}

			state.client = client;
			state.tools = tools;
			state.status = "connected";
			log.logInfo(`[mcp:${config.name}] connected (${config.transport}), ${tools.length} tools`);
		} catch (e) {
			state.status = "failed";
			state.error = (e as Error).message;
			log.logWarning(`[mcp:${config.name}] connect failed: ${state.error}`);
			await client.close().catch(() => {});
		}
	}

	private async closeServer(state: ServerState): Promise<void> {
		const client = state.client;
		state.client = undefined;
		state.status = "disabled";
		state.tools = [];
		if (client) {
			await client.close().catch((e: Error) => {
				log.logWarning(`[mcp:${state.name}] close failed: ${e.message}`);
			});
		}
	}

	/** Tools of all connected servers, ready to append to the agent toolset. */
	getTools(): AgentTool<any>[] {
		const tools: AgentTool<any>[] = [];
		for (const state of this.servers.values()) {
			if (state.status === "connected") {
				tools.push(...state.tools);
			}
		}
		return tools;
	}

	getStatus(): McpStatusSummary {
		return {
			servers: Array.from(this.servers.values()).map((state) => ({
				name: state.name,
				status: state.status,
				toolCount: state.tools.length,
				toolNames: state.tools.map((t) => t.name),
				error: state.error,
			})),
			configErrors: this.configErrors,
			configHash: this.lastHash ?? "",
		};
	}

	async shutdown(): Promise<void> {
		for (const state of this.servers.values()) {
			await this.closeServer(state);
		}
		this.servers.clear();
		this.lastHash = null;
	}
}

let instance: McpManager | null = null;

export function getMcpManager(workingDir: string): McpManager {
	if (!instance) {
		instance = new McpManager(workingDir);
	}
	return instance;
}

/** Close all MCP connections (kills stdio children). Safe to call when unused. */
export async function shutdownMcp(): Promise<void> {
	if (instance) {
		await instance.shutdown();
	}
}
