import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { getModel, type ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { AgentRegistry } from "./bridge.js";
import { parseChannelKind } from "./channel-kind.js";
import { createIrisSettingsManager, syncLogToSessionManager } from "./context.js";
import {
	buildSystemPrompt,
	formatConstitution,
	getMemory,
	loadIrisSkills,
} from "./infra/agent/system-prompt.js";
import * as log from "./log.js";
import { createExecutor, releaseExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelInfo, SlackContext, UserInfo } from "./slack.js";
import { SLACK_MAX_CHARS, splitIntoChunks } from "./slack-text.js";
import type { ChannelStore } from "./store.js";
import { createIrisTools, setUploadFunction } from "./tools/index.js";

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: SlackContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	/** Summarise old messages into a single compaction entry and replace in-context */
	compact(): Promise<{ tokensBefore: number } | null>;
	/** Wipe all message history so the next prompt starts with a blank slate */
	reset(): void;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

// buildSystemPrompt, formatConstitution, getMemory, loadIrisSkills
// live in infra/agent/system-prompt.ts — imported above.

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a channel.
 * Runners are cached - one per channel, persistent across messages.
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	provider: string,
	modelId: string,
): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir, provider, modelId);
	channelRunners.set(channelId, runner);
	return runner;
}

interface MtimeCache<T> { value: T; mtime: number }

type RunQueue = {
	enqueue(fn: () => Promise<void>, errorContext: string): void;
	enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
};

class Runner implements AgentRunner {
	// ── stable (set in constructor, never reassigned) ──────────────────────────
	private readonly channelId: string;
	private readonly channelDir: string;
	private readonly workspaceDir: string;
	private readonly workspacePath: string;
	private readonly sandboxConfig: SandboxConfig;
	private readonly contextFile: string;
	private readonly executor: ReturnType<typeof createExecutor>;
	private readonly model: ReturnType<typeof getModel>;
	private readonly getApiKey: () => Promise<string>;
	private readonly sessionManager: SessionManager;
	private readonly settingsManager: ReturnType<typeof createIrisSettingsManager>;
	private readonly agent: Agent;
	private readonly session: AgentSession;

	// ── mtime caches ──────────────────────────────────────────────────────────
	private constitutionCache: MtimeCache<string> | null = null;
	private agentRegistryCache: MtimeCache<AgentRegistry> | null = null;
	// Skills rarely change; cache and invalidate only when the skills dirs are modified.
	private skillsCache: MtimeCache<Skill[]> | null = null;
	// Memory changes when the agent writes MEMORY.md; cache and invalidate on mtime.
	private memoryCache: MtimeCache<string> | null = null;

	// ── per-run state (null/reset between runs) ───────────────────────────────
	private runCtx: SlackContext | null = null;
	private runLogCtx: { channelId: string; userName?: string; channelName?: string } | null = null;
	private runQueue: RunQueue | null = null;
	private readonly pendingTools = new Map<string, { toolName: string; args: unknown; startTime: number }>();
	private totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	private stopReason = "stop";
	private errorMessage: string | undefined;

	constructor(
		sandboxConfig: SandboxConfig,
		channelId: string,
		channelDir: string,
		provider: string,
		modelId: string,
	) {
		this.channelId = channelId;
		this.channelDir = channelDir;
		this.executor = createExecutor(sandboxConfig, channelId);
		this.workspaceDir = dirname(channelDir);
		this.workspacePath = this.executor.getWorkspacePath(this.workspaceDir);
		this.sandboxConfig = sandboxConfig;

		const tools = createIrisTools(this.executor);

		const authStorage = AuthStorage.create(join(homedir(), ".pi", "iris", "auth.json"));
		const workspaceModelsJson = join(this.workspaceDir, "models.json");
		const modelRegistry = ModelRegistry.create(
			authStorage,
			existsSync(workspaceModelsJson) ? workspaceModelsJson : undefined,
		);

		this.model = (() => {
			const found = modelRegistry.find(provider, modelId);
			if (found) {
				log.logInfo(`[${channelId}] Using model from registry: ${provider}/${modelId}`);
				return found;
			}
			log.logWarning(`[${channelId}] Model ${provider}/${modelId} not in registry, trying built-in getModel()`);
			try {
				return getModel(provider as Parameters<typeof getModel>[0], modelId as Parameters<typeof getModel>[1]);
			} catch {
				throw new Error(
					`Model '${provider}/${modelId}' not found in registry or built-ins. ` +
					`Check models.json at ${workspaceModelsJson} or use a known provider.`,
				);
			}
		})();

		this.getApiKey = async (): Promise<string> => {
			const auth = await modelRegistry.getApiKeyAndHeaders(this.model);
			if (auth.ok && auth.apiKey) return auth.apiKey;
			const envFallback = process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`];
			if (envFallback) return envFallback;
			throw new Error(
				`No API key found for provider '${provider}'. ` +
				`Set ${provider.toUpperCase().replace(/-/g, "_")}_API_KEY env var or configure auth.`,
			);
		};

		const memory = getMemory(channelDir);
		const constitution = this.getCachedConstitution();
		const skills = loadIrisSkills(channelDir, this.workspacePath);
		const agents = this.getCachedAgentRegistry();
		const systemPrompt = buildSystemPrompt({
			workspacePath: this.workspacePath,
			channelId,
			memory,
			constitution,
			sandboxConfig,
			channels: [],
			users: [],
			skills,
			agents,
		});

		this.contextFile = join(channelDir, "context.jsonl");
		this.sessionManager = SessionManager.open(this.contextFile, channelDir);
		this.settingsManager = createIrisSettingsManager(join(channelDir, ".."));

		this.agent = new Agent({
			initialState: { systemPrompt, model: this.model, thinkingLevel: "off", tools },
			convertToLlm,
			getApiKey: this.getApiKey,
		});

		const loadedSession = this.sessionManager.buildSessionContext();
		if (loadedSession.messages.length > 0) {
			this.agent.state.messages = loadedSession.messages;
			log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
		}

		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => systemPrompt,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		this.session = new AgentSession({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			cwd: process.cwd(),
			modelRegistry,
			resourceLoader,
			baseToolsOverride: Object.fromEntries(tools.map((t) => [t.name, t])),
		});

		this.setupEventSubscription();
	}

	// ── private helpers ────────────────────────────────────────────────────────

	private getCachedConstitution(): string {
		const path = join(this.workspaceDir, "CONSTITUTION.md");
		try {
			const mtime = statSync(path).mtimeMs;
			if (this.constitutionCache && this.constitutionCache.mtime === mtime) {
				return formatConstitution(this.constitutionCache.value);
			}
			const content = readFileSync(path, "utf-8").trim();
			if (!content) return "";
			this.constitutionCache = { value: content, mtime };
			return formatConstitution(content);
		} catch {
			return "";
		}
	}

	private getCachedAgentRegistry(): AgentRegistry {
		const path = join(this.workspaceDir, "agents.json");
		try {
			const mtime = statSync(path).mtimeMs;
			if (this.agentRegistryCache && this.agentRegistryCache.mtime === mtime) return this.agentRegistryCache.value;
			const value = JSON.parse(readFileSync(path, "utf-8")) as AgentRegistry;
			this.agentRegistryCache = { value, mtime };
			return value;
		} catch {
			return {};
		}
	}

	private getCachedSkills(): Skill[] {
		// Invalidate when either skills directory is touched (new skill added/removed).
		const workspaceDir = join(this.workspaceDir, "skills");
		const channelDir = join(this.channelDir, "skills");
		let mtime = 0;
		try { mtime = Math.max(mtime, statSync(workspaceDir).mtimeMs); } catch { /* dir absent */ }
		try { mtime = Math.max(mtime, statSync(channelDir).mtimeMs); } catch { /* dir absent */ }
		if (this.skillsCache && this.skillsCache.mtime === mtime) return this.skillsCache.value;
		const value = loadIrisSkills(this.channelDir, this.workspacePath);
		this.skillsCache = { value, mtime };
		return value;
	}

	private getCachedMemory(): string {
		// Invalidate when either MEMORY.md file is modified by the agent.
		const workspaceMem = join(this.workspaceDir, "MEMORY.md");
		const channelMem = join(this.channelDir, "MEMORY.md");
		let mtime = 0;
		try { mtime = Math.max(mtime, statSync(workspaceMem).mtimeMs); } catch { /* absent */ }
		try { mtime = Math.max(mtime, statSync(channelMem).mtimeMs); } catch { /* absent */ }
		if (this.memoryCache && this.memoryCache.mtime === mtime) return this.memoryCache.value;
		const value = getMemory(this.channelDir);
		this.memoryCache = { value, mtime };
		return value;
	}

	private async doCompact(): Promise<{ tokensBefore: number } | null> {
		try {
			const result = await this.session.compact();
			const reloaded = this.sessionManager.buildSessionContext();
			if (reloaded.messages.length > 0) this.agent.state.messages = reloaded.messages;
			return result ? { tokensBefore: result.tokensBefore } : null;
		} catch (err) {
			log.logWarning(`[${this.channelId}] compact() failed`, err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	private setupEventSubscription(): void {
		this.session.subscribe(async (event) => {
			if (!this.runCtx || !this.runLogCtx || !this.runQueue) return;

			const ctx = this.runCtx;
			const logCtx = this.runLogCtx;
			const queue = this.runQueue;
			const pendingTools = this.pendingTools;
			const isSessionChannel = parseChannelKind(this.channelId).kind === "session";

			if (event.type === "tool_execution_start") {
				const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
				const label = (agentEvent.args as { label?: string }).label || agentEvent.toolName;
				pendingTools.set(agentEvent.toolCallId, { toolName: agentEvent.toolName, args: agentEvent.args, startTime: Date.now() });
				log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
				if (!isSessionChannel) queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");

			} else if (event.type === "tool_execution_end") {
				const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
				const resultStr = extractToolResultText(agentEvent.result);
				const pending = pendingTools.get(agentEvent.toolCallId);
				pendingTools.delete(agentEvent.toolCallId);
				const durationMs = pending ? Date.now() - pending.startTime : 0;

				if (agentEvent.isError) log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
				else log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);

				const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
				const argsFormatted = pending ? formatToolArgsForSlack(agentEvent.toolName, pending.args as Record<string, unknown>) : "(args not found)";
				const duration = (durationMs / 1000).toFixed(1);
				let threadMessage = `*${agentEvent.isError ? "✗" : "✓"} ${agentEvent.toolName}*`;
				if (label) threadMessage += `: ${label}`;
				threadMessage += ` (${duration}s)\n`;
				if (argsFormatted) threadMessage += `\`\`\`\n${argsFormatted}\n\`\`\`\n`;
				threadMessage += `*Result:*\n\`\`\`\n${resultStr}\n\`\`\``;
				queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
				if (agentEvent.isError && !isSessionChannel) queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");

			} else if (event.type === "message_start") {
				const agentEvent = event as AgentEvent & { type: "message_start" };
				if (agentEvent.message.role === "assistant") log.logResponseStart(logCtx);

			} else if (event.type === "message_end") {
				const agentEvent = event as AgentEvent & { type: "message_end" };
				if (agentEvent.message.role === "assistant") {
					const assistantMsg = agentEvent.message as any;
					if (assistantMsg.stopReason) this.stopReason = assistantMsg.stopReason;
					if (assistantMsg.errorMessage) this.errorMessage = assistantMsg.errorMessage;
					if (assistantMsg.usage) {
						this.totalUsage.input += assistantMsg.usage.input;
						this.totalUsage.output += assistantMsg.usage.output;
						this.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
						this.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
						this.totalUsage.cost.input += assistantMsg.usage.cost.input;
						this.totalUsage.cost.output += assistantMsg.usage.cost.output;
						this.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
						this.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
						this.totalUsage.cost.total += assistantMsg.usage.cost.total;
					}
					const thinkingParts: string[] = [];
					const textParts: string[] = [];
					for (const part of agentEvent.message.content) {
						if (part.type === "thinking") thinkingParts.push((part as any).thinking);
						else if (part.type === "text") textParts.push((part as any).text);
					}
					for (const thinking of thinkingParts) {
						log.logThinking(logCtx, thinking);
						if (!isSessionChannel) {
							queue.enqueueMessage(`_${thinking}_`, "main", "thinking main");
							queue.enqueueMessage(`_${thinking}_`, "thread", "thinking thread", false);
						}
					}
					const text = textParts.join("\n");
					if (text.trim()) {
						log.logResponse(logCtx, text);
						queue.enqueueMessage(text, "main", "response main");
					}
				}

			} else if (event.type === "compaction_start") {
				log.logInfo(`Compaction started (reason: ${event.reason})`);
				if (!isSessionChannel) queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");

			} else if (event.type === "compaction_end") {
				if (event.result) log.logInfo(`Compaction complete: ${event.result.tokensBefore} tokens compacted`);
				else if (event.aborted) log.logInfo("Compaction aborted");

			} else if (event.type === "auto_retry_start") {
				const retryEvent = event as any;
				log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
				if (!isSessionChannel) queue.enqueue(() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false), "retry");
			}
		});
	}

	// ── AgentRunner ────────────────────────────────────────────────────────────

	async run(
		ctx: SlackContext,
		_store: ChannelStore,
		_pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }> {
		await mkdir(this.channelDir, { recursive: true });

		const syncedCount = syncLogToSessionManager(this.sessionManager, this.channelDir, ctx.message.ts);
		if (syncedCount > 0) log.logInfo(`[${this.channelId}] Synced ${syncedCount} messages from log.jsonl`);

		const reloadedSession = this.sessionManager.buildSessionContext();
		if (reloadedSession.messages.length > 0) {
			this.agent.state.messages = reloadedSession.messages;
			log.logInfo(`[${this.channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
		}

		// All four inputs are mtime-cached — only re-read when files actually change.
		const memory = this.getCachedMemory();
		const constitution = this.getCachedConstitution();
		let skills = this.getCachedSkills();
		if (parseChannelKind(this.channelId).kind === "session") {
			skills = skills.filter((s) => s.name !== "spawn-agent");
		}
		const agents = this.getCachedAgentRegistry();
		const systemPrompt = buildSystemPrompt({
			workspacePath: this.workspacePath,
			channelId: this.channelId,
			memory,
			constitution,
			sandboxConfig: this.sandboxConfig,
			channels: ctx.channels,
			users: ctx.users,
			skills,
			agents,
		});
		this.session.agent.state.systemPrompt = systemPrompt;

		setUploadFunction(async (filePath: string, title?: string) => {
			const hostPath = translateToHostPath(filePath, this.channelDir, this.workspacePath, this.channelId);
			await ctx.uploadFile(hostPath, title);
		});

		// Reset per-run state
		this.runCtx = ctx;
		this.runLogCtx = { channelId: ctx.message.channel, userName: ctx.message.userName, channelName: ctx.channelName };
		this.pendingTools.clear();
		this.totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		this.stopReason = "stop";
		this.errorMessage = undefined;

		// Per-run queue — captures ctx and queueChain for this run
		let queueChain = Promise.resolve();
		const queue: RunQueue = {
			enqueue: (fn, errorContext) => {
				queueChain = queueChain.then(async () => {
					try {
						await fn();
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning(`Slack API error (${errorContext})`, errMsg);
						try { await ctx.respondInThread(`_Error: ${errMsg}_`); } catch { /* ignore */ }
					}
				});
			},
			enqueueMessage: (text, target, errorContext, doLog = true) => {
				for (const part of splitIntoChunks(text, SLACK_MAX_CHARS)) {
					queue.enqueue(() => (target === "main" ? ctx.respond(part, doLog) : ctx.respondInThread(part)), errorContext);
				}
			},
		};
		this.runQueue = queue;

		log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);
		log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

		const now = new Date();
		const pad = (n: number) => n.toString().padStart(2, "0");
		const offset = -now.getTimezoneOffset();
		const offsetSign = offset >= 0 ? "+" : "-";
		const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
		const offsetMins = pad(Math.abs(offset) % 60);
		const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
		let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

		const imageAttachments: ImageContent[] = [];
		const nonImagePaths: string[] = [];
		for (const a of ctx.message.attachments || []) {
			const fullPath = `${this.workspacePath}/${a.local}`;
			const mimeType = getImageMimeType(a.local);
			if (mimeType && existsSync(fullPath)) {
				try {
					imageAttachments.push({ type: "image", mimeType, data: readFileSync(fullPath).toString("base64") });
				} catch {
					nonImagePaths.push(fullPath);
				}
			} else {
				nonImagePaths.push(fullPath);
			}
		}
		if (nonImagePaths.length > 0) userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;

		// Fire-and-forget debug dump — never block the LLM hot path.
		// Compact JSON (no null,2) is ~40% smaller and serialises 3× faster on large contexts.
		writeFile(
			join(this.channelDir, "last_prompt.jsonl"),
			JSON.stringify({ systemPrompt, messages: this.session.messages, newUserMessage: userMessage, imageAttachmentCount: imageAttachments.length }),
		).catch(() => { /* debug dump — ignore write errors */ });

		const LLM_TIMEOUT_MS = (Number(process.env.IRIS_LLM_TIMEOUT_SECS) || 300) * 1000;
		let llmTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const llmTimeout = new Promise<never>((_, reject) => {
			llmTimeoutHandle = setTimeout(() => {
				log.logWarning(`[${this.channelId}] LLM timeout after ${LLM_TIMEOUT_MS / 1000}s — aborting run`);
				this.session.agent.abort();
				reject(new Error(`LLM response timeout after ${LLM_TIMEOUT_MS / 1000}s`));
			}, LLM_TIMEOUT_MS);
		});
		try {
			await Promise.race([
				this.session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined),
				llmTimeout,
			]);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			if (errMsg.includes("timeout")) {
				queue.enqueue(() => ctx.replaceMessage("_Timed out waiting for LLM response. Please try again._"), "timeout");
			} else {
				throw err;
			}
		} finally {
			clearTimeout(llmTimeoutHandle);
		}

		await queueChain;

		if (this.stopReason === "error" && this.errorMessage) {
			try {
				await ctx.replaceMessage("_Sorry, something went wrong_");
				await ctx.respondInThread(`_Error: ${this.errorMessage}_`);
			} catch (err) {
				log.logWarning("Failed to post error message", err instanceof Error ? err.message : String(err));
			}
		} else {
			const lastAssistant = this.session.messages.filter((m) => m.role === "assistant").pop();
			const finalText = lastAssistant?.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n") || "";

			if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
				try {
					await ctx.deleteMessage();
					log.logInfo("Silent response - deleted message and thread");
				} catch (err) {
					log.logWarning("Failed to delete message for silent response", err instanceof Error ? err.message : String(err));
				}
			} else if (finalText.trim()) {
				try {
					await ctx.replaceMessage(finalText);
				} catch (err) {
					log.logWarning("Failed to replace message with final text", err instanceof Error ? err.message : String(err));
				}
			}
		}

		const contextWindow = this.model.contextWindow || 200000;
		const lastAssistantMsg = this.session.messages.slice().reverse().find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;
		const contextTokens = lastAssistantMsg
			? (lastAssistantMsg.usage.input ?? 0) + (lastAssistantMsg.usage.output ?? 0) + (lastAssistantMsg.usage.cacheRead ?? 0) + (lastAssistantMsg.usage.cacheWrite ?? 0)
			: 0;

		if (this.totalUsage.cost.total > 0) {
			const summary = log.logUsageSummary(this.runLogCtx!, this.totalUsage, contextTokens, contextWindow);
			queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
			await queueChain;
		}

		if (contextTokens > 0 && contextTokens / contextWindow >= 0.7 && this.stopReason !== "aborted" && this.stopReason !== "error") {
			const pct = Math.round((contextTokens / contextWindow) * 100);
			log.logInfo(`[${this.channelId}] Auto-compacting: ${contextTokens}/${contextWindow} tokens (${pct}%)`);
			const compactResult = await this.doCompact();
			if (compactResult) {
				await ctx.respondInThread(`_Context auto-compacted (${pct}% full — ${compactResult.tokensBefore.toLocaleString()} tokens summarised)_`);
			}
		}

		this.runCtx = null;
		this.runLogCtx = null;
		this.runQueue = null;

		return { stopReason: this.stopReason, errorMessage: this.errorMessage };
	}

	abort(): void {
		this.session.abort();
	}

	async compact(): Promise<{ tokensBefore: number } | null> {
		return this.doCompact();
	}

	reset(): void {
		this.agent.reset();
		void releaseExecutor(this.executor);
		try {
			writeFileSync(this.contextFile, "");
			log.logInfo(`[${this.channelId}] Context reset — cleared ${this.contextFile}`);
		} catch (err) {
			log.logWarning(`[${this.channelId}] Failed to clear context file`, err instanceof Error ? err.message : String(err));
		}
	}
}

function createRunner(
	sandboxConfig: SandboxConfig,
	channelId: string,
	channelDir: string,
	provider: string,
	modelId: string,
): AgentRunner {
	return new Runner(sandboxConfig, channelId, channelDir, provider, modelId);
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
