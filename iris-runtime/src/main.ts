#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { startApiServer } from "./api.js";
import { startBridgeServer } from "./bridge.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { type IrisHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { TelegramBot, type IrisTelegramHandler, type TelegramEvent } from "./telegram.js";
import { ChannelStore, resolveChannelDir } from "./store.js";
import { startScheduler, type SchedulerCallbacks } from "./scheduler.js";
import { resolveBridgeRequest } from "./bridge.js";
import { startWatchdog } from "./agent-watchdog.js";
import { getMissedTasks, updateTaskStatus } from "./task-queue.js";

// ============================================================================
// Config
// ============================================================================

const IRIS_SLACK_APP_TOKEN = process.env.IRIS_SLACK_APP_TOKEN;
const IRIS_SLACK_BOT_TOKEN = process.env.IRIS_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
	downloadChannel?: string;
	// Iris extensions
	provider: string;
	model: string;
	environment: "preview" | "prod";
	apiPort: number;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let downloadChannelId: string | undefined;

	// Iris: provider/model from env first, CLI flags override
	let provider = process.env.IRIS_PROVIDER ?? "anthropic";
	let model = process.env.IRIS_MODEL ?? "claude-sonnet-4-5";
	let environment: "preview" | "prod" = (process.env.IRIS_ENV as "preview" | "prod") ?? "prod";
	let apiPort = parseInt(process.env.IRIS_API_PORT ?? "0", 10);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--download=")) {
			downloadChannelId = arg.slice("--download=".length);
		} else if (arg === "--download") {
			downloadChannelId = args[++i];
		} else if (arg.startsWith("--provider=")) {
			provider = arg.slice("--provider=".length);
		} else if (arg === "--provider") {
			provider = args[++i] || provider;
		} else if (arg.startsWith("--model=")) {
			model = arg.slice("--model=".length);
		} else if (arg === "--model") {
			model = args[++i] || model;
		} else if (arg.startsWith("--environment=")) {
			const env = arg.slice("--environment=".length);
			environment = env === "preview" ? "preview" : "prod";
		} else if (arg === "--environment") {
			const env = args[++i] || "prod";
			environment = env === "preview" ? "preview" : "prod";
		} else if (arg.startsWith("--api-port=")) {
			apiPort = parseInt(arg.slice("--api-port=".length), 10);
		} else if (arg === "--api-port") {
			apiPort = parseInt(args[++i] || "0", 10);
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
		downloadChannel: downloadChannelId,
		provider,
		model,
		environment,
		apiPort,
	};
}

const parsedArgs = parseArgs();

// Handle --download mode
if (parsedArgs.downloadChannel) {
	if (!IRIS_SLACK_BOT_TOKEN) {
		console.error("Missing env: IRIS_SLACK_BOT_TOKEN");
		process.exit(1);
	}
	await downloadChannel(parsedArgs.downloadChannel, IRIS_SLACK_BOT_TOKEN);
	process.exit(0);
}

// Normal bot mode - require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: iris-runtime [--sandbox=host|docker:<name>] [--provider <p>] [--model <m>] [--environment preview|prod] [--api-port <port>] <working-directory>");
	console.error("       iris-runtime --download <channel-id>");
	console.error("Env vars: IRIS_PROVIDER, IRIS_MODEL, IRIS_ENV, IRIS_API_PORT, TELEGRAM_BOT_TOKEN, IRIS_SLACK_APP_TOKEN, IRIS_SLACK_BOT_TOKEN");
	process.exit(1);
}

const { workingDir, sandbox, provider, model, environment, apiPort } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	provider: parsedArgs.provider,
	model: parsedArgs.model,
	environment: parsedArgs.environment,
	apiPort: parsedArgs.apiPort,
};

// Slack is optional — sub-agents run bridge-only (no Slack connection needed)
const SLACK_ENABLED = !!(IRIS_SLACK_APP_TOKEN && IRIS_SLACK_BOT_TOKEN);

await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

const channelStates = new Map<string, ChannelState>();

// ============================================================================
// Migration — move flat channel dirs into slack/ and telegram/ subdirectories
// ============================================================================

function migrateChannelDirs(dir: string): void {
	if (!existsSync(dir)) return;
	const entries = readdirSync(dir, { withFileTypes: true });
	let migrated = 0;

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const name = entry.name;

		// Skip already-structured dirs and special dirs
		if (
			name === "slack" || name === "telegram" || name === "data" ||
			name === "events" || name === "sessions" ||
			name.startsWith("SESSION-") || name.startsWith("BRIDGE-") ||
			name.startsWith("ESCALATE-") || name.startsWith("SELFHEAL-") ||
			name.startsWith("WEBUI")
		) continue;

		let destSubdir: string | null = null;
		if (name.startsWith("tg-")) destSubdir = "telegram";
		else if (/^[CDGW]/.test(name)) destSubdir = "slack";

		if (!destSubdir) continue;

		const src = join(dir, name);
		const destDir = join(dir, destSubdir);
		const dest = join(destDir, name);

		if (!existsSync(dest)) {
			if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
			renameSync(src, dest);
			log.logInfo(`[migrate] ${name} → ${destSubdir}/${name}`);
			migrated++;
		}
	}

	if (migrated > 0) log.logInfo(`[migrate] Moved ${migrated} channel director${migrated === 1 ? "y" : "ies"} to transport subdirectories`);
}

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = resolveChannelDir(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, workingDir, provider, model),
			store: new ChannelStore({ workingDir, botToken: IRIS_SLACK_BOT_TOKEN! }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create SlackContext adapter
// ============================================================================

// Slack recommends 4000 chars max for chat.update. We use 4000 as the split point.
const SLACK_SPLIT_CHARS = 4000;

/**
 * Split text into chunks at natural newline boundaries near maxChars.
 */
function splitIntoChunks(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxChars) {
			chunks.push(remaining);
			break;
		}
		const searchFrom = Math.floor(maxChars * 0.8);
		const newlineIdx = remaining.lastIndexOf("\n", maxChars);
		const cut = newlineIdx >= searchFrom ? newlineIdx + 1 : maxChars;
		chunks.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	return chunks;
}

function createSlackContext(event: SlackEvent, slack: SlackBot, state: ChannelState, isEvent?: boolean) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: user?.userName,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		store: state.store,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		// Accumulate text silently during streaming — thinking indicator stays visible.
		// replaceMessage() posts the final clean result when generation is complete.
		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				try {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
					if (shouldLog && messageTs) {
						slack.logBotResponse(event.channel, text, messageTs);
					}
				} catch (err) {
					log.logWarning("Slack respond error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		// Called when generation is complete with the full final text.
		// Splits into chunks and posts in order: chunk 1 replaces the thinking message,
		// chunks 2+ are posted as thread replies below — correct reading order guaranteed.
		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					const chunks = splitIntoChunks(text, SLACK_SPLIT_CHARS);

					// Replace thinking indicator with first chunk
					if (messageTs) {
						await slack.finalizeMessage(event.channel, messageTs, chunks[0]);
					} else {
						messageTs = await slack.postMessage(event.channel, chunks[0]);
					}

					// Post remaining chunks as thread replies in order
					for (let i = 1; i < chunks.length; i++) {
						const ts = await slack.postInThread(event.channel, messageTs!, chunks[i]);
						threadMessageTs.push(ts);
					}
				} catch (err) {
					log.logWarning("Slack replaceMessage error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					if (messageTs) {
						const ts = await slack.postInThread(event.channel, messageTs, text);
						threadMessageTs.push(ts);
					}
				} catch (err) {
					log.logWarning("Slack respondInThread error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					try {
						if (!messageTs) {
							const label = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
							messageTs = await slack.postMessage(event.channel, label + workingIndicator);
						}
					} catch (err) {
						log.logWarning("Slack setTyping error", err instanceof Error ? err.message : String(err));
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await slack.uploadFile(event.channel, filePath, title);
		},

		setWorking: async (working: boolean) => {
			// No-op — thinking indicator is managed by setTyping/replaceMessage.
			isWorking = working;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				// Delete thread messages first (in reverse order)
				for (let i = threadMessageTs.length - 1; i >= 0; i--) {
					try {
						await slack.deleteMessage(event.channel, threadMessageTs[i]);
					} catch {
						// Ignore errors deleting thread messages
					}
				}
				threadMessageTs.length = 0;
				// Then delete main message
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},

		getAccumulatedText: () => accumulatedText,
	};
}

// ============================================================================
// Handler
// ============================================================================

const handler: IrisHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, slack: SlackBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts; // Save for updating later
		} else {
			await slack.postMessage(channelId, "_Nothing running_");
		}
	},

	async handleCompact(channelId: string, slack: SlackBot): Promise<void> {
		if (handler.isRunning(channelId)) {
			await slack.postMessage(channelId, "_Can't compact while running — say `stop` first_");
			return;
		}
		const state = getState(channelId);
		const ts = await slack.postMessage(channelId, "_Compacting context..._");
		try {
			const result = await state.runner.compact();
			if (result) {
				await slack.updateMessage(channelId, ts!, `_Compacted: ${result.tokensBefore.toLocaleString()} tokens summarised_`);
			} else {
				await slack.updateMessage(channelId, ts!, "_Compaction complete_");
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			await slack.updateMessage(channelId, ts!, `_Compaction failed: ${errMsg}_`);
		}
	},

	async handleReset(channelId: string, slack: SlackBot): Promise<void> {
		const state = getState(channelId);
		// Abort any in-progress run first, then reset — works even when stuck
		if (state.running) {
			state.stopRequested = true;
			state.runner.abort();
		}
		state.runner.reset();
		state.running = false;
		await slack.postMessage(channelId, "_Context cleared — starting fresh_");
	},

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const state = getState(event.channel);

		// Start run
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			// Create context adapter
			const ctx = createSlackContext(event, slack, state, isEvent);

			// Run the agent
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			// Resolve pending session API request (POST /sessions/:id/message bridge pattern)
			if (event.channel.startsWith("SESSION-")) {
				const sessionId = event.channel.slice("SESSION-".length);
				const { resolveSessionRequest } = await import("./sessions.js");
				resolveSessionRequest(sessionId, ctx.getAccumulatedText());
			}

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Telegram context adapter
// ============================================================================

function createTelegramContext(event: TelegramEvent, bot: TelegramBot, state: ChannelState) {
	let messageId: string | null = null;
	const extraMessageIds: string[] = [];
	let accumulatedText = "";
	let updatePromise = Promise.resolve();

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: bot.getChatName(event.channel),
		telegramBotName: bot.getBotName(),
		store: state.store,
		channels: bot.getAllChats(),
		users: [],

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
				if (shouldLog && messageId) {
					bot.logBotResponse(event.channel, text, messageId);
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					if (messageId) {
						await bot.finalizeMessage(event.channel, messageId, text);
					} else {
						messageId = await bot.postMessage(event.channel, text);
					}
				} catch (err) {
					log.logWarning("Telegram replaceMessage error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					const id = await bot.postInThread(event.channel, messageId ?? event.ts, text);
					extraMessageIds.push(id);
				} catch (err) {
					log.logWarning("Telegram respondInThread error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageId) {
				updatePromise = updatePromise.then(async () => {
					try {
						if (!messageId) {
							messageId = await bot.postMessage(event.channel, "_Thinking..._");
						}
					} catch (err) {
						log.logWarning("Telegram setTyping error", err instanceof Error ? err.message : String(err));
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await bot.uploadFile(event.channel, filePath, title);
		},

		setWorking: async (_working: boolean) => {},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				for (let i = extraMessageIds.length - 1; i >= 0; i--) {
					try { await bot.deleteMessage(event.channel, extraMessageIds[i]); } catch {}
				}
				extraMessageIds.length = 0;
				if (messageId) {
					await bot.deleteMessage(event.channel, messageId);
					messageId = null;
				}
			});
			await updatePromise;
		},

		getAccumulatedText: () => accumulatedText,
	};
}

// ============================================================================
// Telegram handler
// ============================================================================

const SPAWN_INTENT_RE =
	/\b(spawn|create|launch|deploy|make|build|start|set\s+up|setup)\s+(a\s+|an\s+|new\s+)?agent\b|\bspin\s+up\b.*\bagent\b|\bspawn-agent\b/i;

const telegramHandler: IrisTelegramHandler = {
	isRunning(channelId: string): boolean {
		return channelStates.get(channelId)?.running ?? false;
	},

	async handleStop(channelId: string, bot: TelegramBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			await bot.postMessage(channelId, "_Stopping current task..._");
		} else {
			await bot.postMessage(channelId, "_Nothing is currently running_");
		}
	},

	async handleCompact(channelId: string, bot: TelegramBot): Promise<void> {
		if (telegramHandler.isRunning(channelId)) {
			await bot.postMessage(channelId, "_Can't compact while running — send /stop first_");
			return;
		}
		const state = getState(channelId);
		const ts = await bot.postMessage(channelId, "_Compacting context..._");
		try {
			const result = await state.runner.compact();
			if (result) {
				await bot.updateMessage(channelId, ts, `_Compacted: ${result.tokensBefore.toLocaleString()} tokens summarised_`);
			} else {
				await bot.updateMessage(channelId, ts, "_Compaction complete_");
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			await bot.updateMessage(channelId, ts, `_Compaction failed: ${errMsg}_`);
		}
	},

	async handleReset(channelId: string, bot: TelegramBot): Promise<void> {
		const state = getState(channelId);
		// Abort whatever is currently running
		if (state.running) {
			state.stopRequested = true;
			state.runner.abort();
		}
		// Drain all queued-but-not-yet-started tasks so nothing executes after this
		bot.drainQueue(channelId);
		state.runner.reset();
		state.running = false;
		await bot.postMessage(channelId, "_All tasks stopped and queue cleared. Context reset — starting fresh._");
	},

	async handleEvent(event: TelegramEvent, bot: TelegramBot, isEvent?: boolean): Promise<void> {
		const state = getState(event.channel);
		state.running = true;
		state.stopRequested = false;

		// Detect spawn intent — notify user, then continue without spawning
		if (!isEvent && SPAWN_INTENT_RE.test(event.text)) {
			try {
				await bot.postMessage(
					event.channel,
					`Agent creation is not available via Telegram. I'll handle this task directly as ${bot.getBotName()}.`,
				);
			} catch (err) {
				log.logWarning("[telegram] Failed to send spawn notice", err instanceof Error ? err.message : String(err));
			}
		}

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			const ctx = createTelegramContext(event, bot, state);
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			if (event.channel.startsWith("SESSION-")) {
				const sessionId = event.channel.slice("SESSION-".length);
				const { resolveSessionRequest } = await import("./sessions.js");
				resolveSessionRequest(sessionId, ctx.getAccumulatedText());
			}

			if (result.stopReason === "aborted" && state.stopRequested) {
				await bot.postMessage(event.channel, "_Stopped_");
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

let sandboxLabel: string;
if (sandbox.type === "host") {
	sandboxLabel = "host";
} else if (sandbox.type === "docker") {
	sandboxLabel = `docker:${sandbox.container}`;
} else if (sandbox.type === "firecracker") {
	sandboxLabel = `firecracker:${sandbox.agentIp}`;
} else {
	sandboxLabel = "firecracker-pool";
}
log.logStartup(workingDir, sandboxLabel);
log.logInfo(`iris-runtime: provider=${provider} model=${model} environment=${environment}`);

// Migrate flat channel dirs to slack/ and telegram/ subdirectories
migrateChannelDirs(workingDir);

// Start internal API server (default port 3000, always-on for sub-agent escalation)
const effectiveApiPort = apiPort > 0 ? apiPort : 3000;
// botRef is set after bot construction below; the closure captures it by reference
let botRef: SlackBotClass | TelegramBot | null = null;
const tgBotsForApi: TelegramBot[] = []; // populated after bot construction

// Scheduler callbacks — notifyOwner posts a message via the owning bot
const schedulerCallbacks: SchedulerCallbacks = {
	workingDir,
	notifyOwner: (botId, channelId, text) => {
		const bot = tgBotsForApi.find((b) => b.getBotId() === botId) ?? tgBotsForApi[0];
		if (bot) void bot.postMessage(channelId, text).catch((err: unknown) =>
			log.logWarning(`[notifyOwner] postMessage to ${channelId} failed`, String(err)),
		);
	},
};

startApiServer(
	effectiveApiPort,
	workingDir,
	channelStates,
	() => botRef as any,
	(botId?: string) => {
		const bot = botId
			? tgBotsForApi.find((b) => b.getBotId() === botId)
			: tgBotsForApi[0];
		return bot?.claim ?? null;
	},
	schedulerCallbacks,
);

// Start bridge server if requested (sub-agents only — set IRIS_BRIDGE_PORT)
const bridgePort = parseInt(process.env.IRIS_BRIDGE_PORT ?? "0", 10);
if (bridgePort > 0) {
	startBridgeServer(bridgePort, workingDir);
}

const eventsWatcherBot = SLACK_ENABLED
	? (() => {
		const sharedStore = new ChannelStore({ workingDir, botToken: IRIS_SLACK_BOT_TOKEN! });
		const bot = new SlackBotClass(handler, {
			appToken: IRIS_SLACK_APP_TOKEN,
			botToken: IRIS_SLACK_BOT_TOKEN,
			workingDir,
			store: sharedStore,
		});
		botRef = bot;
		bot.start();
		return bot;
	})()
	: (() => {
		// Bridge-only stub — used when no Slack tokens but events watcher still needs a bot
		const stubBot = {
			getUser: () => undefined,
			getChannel: () => undefined,
			getAllChannels: () => [],
			getAllUsers: () => [],
			postMessage: async (channel: string, text: string) => {
				if (channel.startsWith("BRIDGE-")) {
					const requestId = channel.slice("BRIDGE-".length);
					if (bridgePort > 0) {
						// Sub-agent: LLM just finished — resolve the bridge server's
						// pending promise so the HTTP response goes back to main Iris.
						resolveBridgeRequest(requestId, text);
					} else {
						// Main Iris: a sub-agent is posting its response back.
						// Forward to the /event endpoint so callAgentBridge resolves.
						const apiUrl = process.env.IRIS_API_URL ?? "http://172.18.0.1:3000";
						try {
							await fetch(`${apiUrl}/event`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ channelId: channel, text, user: "agent" }),
							});
						} catch { /* non-fatal — main Iris bridge will timeout */ }
					}
				}
				return Date.now().toString();
			},
			updateMessage: async () => {},
			finalizeMessage: async () => {},
			deleteMessage: async () => {},
			postInThread: async () => Date.now().toString(),
			uploadFile: async () => {},
			logBotResponse: () => {},
			logToFile: () => {},
			resetSessionContext: () => {},
			enqueueEvent: (event: any) => handler.handleEvent(event, stubBot as any),
			injectSessionMessage: async (sessionId: string, user: string, text: string) => {
				const { registerSessionRequest } = await import("./sessions.js");
				const channelId = `SESSION-${sessionId}`;
				const ts = (Date.now() / 1000).toFixed(6);
				const responsePromise = registerSessionRequest(sessionId, 90_000);
				const slackEvent = { type: "mention" as const, channel: channelId, user, text, ts, attachments: [] };
				handler.handleEvent(slackEvent, stubBot as any);
				return responsePromise;
			},
		} as any;
		botRef = stubBot;
		log.logInfo("Slack tokens not set — running in bridge-only mode");
		return stubBot;
	})();

// ============================================================================
// Telegram — start up to 5 bot instances (one per token)
// ============================================================================

// Collect all configured tokens: TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN_2..5
const telegramTokens: string[] = [
	process.env.TELEGRAM_BOT_TOKEN,
	process.env.TELEGRAM_BOT_TOKEN_2,
	process.env.TELEGRAM_BOT_TOKEN_3,
	process.env.TELEGRAM_BOT_TOKEN_4,
	process.env.TELEGRAM_BOT_TOKEN_5,
].filter((t): t is string => typeof t === "string" && t.trim().length > 0);

const tgBots: TelegramBot[] = [];

for (const token of telegramTokens) {
	const tgBot = new TelegramBot(telegramHandler, { token, workingDir });
	try {
		await tgBot.start();
	} catch (err) {
		// Registry rejected this bot (max 5 reached) or API error — skip it
		log.logWarning("[telegram] Bot failed to start", err instanceof Error ? err.message : String(err));
		continue;
	}

	// Force reclaim if requested (applies to ALL bots on this startup)
	if (process.env.IRIS_TELEGRAM_FORCE_RECLAIM === "true") {
		tgBot.claim.reset();
		log.logInfo(`[telegram:${tgBot.getBotId()}] Force reclaim — previous owner cleared.`);
	}

	// Print claim token to terminal for any unclaimed bot
	if (!tgBot.claim.isClaimed()) {
		const claimToken = tgBot.claim.generateToken();
		log.logInfo(`[telegram:${tgBot.getBotId()}] Bot is unclaimed. Send this token to your bot on Telegram to claim it:`);
		log.logInfo("");
		log.logInfo(`    ${claimToken}`);
		log.logInfo("");
		log.logInfo("[telegram] Token expires in 10 minutes.");
		log.logInfo("[telegram] Missed it? Run: iris-claim-token");

		// Write to well-known file so bootstrap.sh can display it without shell history exposure
		const tokenDir = join(workingDir, "data");
		const tokenFile = join(tokenDir, "claim-token.txt");
		try {
			mkdirSync(tokenDir, { recursive: true });
			writeFileSync(tokenFile, claimToken, { mode: 0o600 });
		} catch { /* non-fatal */ }

		// Background watcher: notify terminal when bot is claimed, then clean up the token file
		const watchInterval = setInterval(() => {
			if (tgBot.claim.isClaimed()) {
				clearInterval(watchInterval);
				log.logInfo(`[telegram:${tgBot.getBotId()}] Claim token received. Bot is now active.`);
				try { unlinkSync(tokenFile); } catch { /* file may already be gone */ }
			}
		}, 2000);
	}

	tgBots.push(tgBot);
	tgBotsForApi.push(tgBot);
	// First bot becomes botRef if Slack is not active (API server prefers Slack)
	if (!SLACK_ENABLED && tgBots.length === 1) botRef = tgBot;
}

if (telegramTokens.length === 0) {
	log.logInfo("Telegram token not set — Telegram transport disabled");
}

if (!SLACK_ENABLED && telegramTokens.length === 0) {
	log.logInfo("⚡️ Bridge-only mode active");
}

// Start scheduler: check for missed tasks, reschedule pending ones.
// Run after all bots are started so tgBotsForApi is fully populated.
if (tgBotsForApi.length > 0) {
	const botIds = tgBotsForApi.map((b) => b.getBotId()).filter((id): id is string => Boolean(id));
	void startScheduler(botIds, schedulerCallbacks);
}

// Start watchdog: polls Docker every 30s, detects crashes and recoveries.
void startWatchdog({
	notifyOwner: schedulerCallbacks.notifyOwner,

	onAgentCrashed: (agentId) => {
		// Exit any active Telegram conversations with the crashed agent
		for (const bot of tgBotsForApi) {
			bot.clearAgentConversation(agentId);
		}
	},

	onAgentRecovered: async (agentId, agentName, botId) => {
		// Check for tasks that were missed while the agent was offline
		const missed = await getMissedTasks(agentId);
		if (missed.length === 0) return;

		await Promise.all(missed.map((t) => updateTaskStatus(t.taskId, "skipped")));

		const ownerChannelId = `tg-${missed[0].channelId.replace(/^tg-/, "").split("-")[0]}`;
		const noun = missed.length === 1 ? "task" : "tasks";
		schedulerCallbacks.notifyOwner(
			botId,
			ownerChannelId,
			`⚠️ <b>${agentName}</b> missed ${missed.length} scheduled ${noun} while offline. They have been skipped.\n\n` +
			missed.map((t) => `• ${t.localTimeStr ?? t.scheduledFor ?? "?"}: <i>${t.payload.slice(0, 80)}</i>`).join("\n"),
		);
	},
});


// ============================================================================
// Universal router — dispatches events to the right transport.
// For tg-* channels: find the bot whose claim owner matches the chatId.
// Each bot's queues are completely isolated — no cross-bot dispatch.
// ============================================================================

function findBotForChannel(channelId: string): TelegramBot | undefined {
	if (!channelId.startsWith("tg-")) return undefined;
	// Extract numeric chatId from channelId (tg-{chatId} or tg-n{abs} or tg-{chatId}-{threadId})
	const rest = channelId.slice(3);
	const chatStr = rest.includes("-") ? rest.slice(0, rest.lastIndexOf("-")) : rest;
	const chatId = chatStr.startsWith("n") ? -parseInt(chatStr.slice(1), 10) : parseInt(chatStr, 10);

	// Prefer the bot that owns this chatId (has it claimed or has seen it before)
	const ownerMatch = tgBots.find((b) => b.claim.getOwnerId() === chatId);
	if (ownerMatch) return ownerMatch;

	// Fall back to first available bot
	return tgBots[0];
}

const universalBot = {
	...eventsWatcherBot,
	enqueueEvent: (event: any) => {
		// BRIDGE-* events mean different things depending on context:
		// - Main Iris (bridgePort===0): a sub-agent posted its LLM response back.
		//   Resolve the callAgentBridge promise immediately.
		// - Sub-agent (bridgePort>0): an incoming request that the LLM must process.
		//   Do NOT intercept here — fall through to eventsWatcherBot so the LLM runs,
		//   then stubBot.postMessage resolves the bridge server's pending promise.
		if (event.channel?.startsWith("BRIDGE-") && bridgePort === 0) {
			const requestId = (event.channel as string).slice("BRIDGE-".length);
			resolveBridgeRequest(requestId, event.text ?? "");
			return true;
		}
		if (event.channel?.startsWith("tg-")) {
			const tgBot = findBotForChannel(event.channel);
			if (tgBot) return tgBot.enqueueEvent(event);
		}
		return eventsWatcherBot.enqueueEvent(event);
	},
} as any;

// Route hasPendingEvent checks to the right transport
const hasPendingEvent = (channelId: string): boolean => {
	const tgBot = findBotForChannel(channelId);
	if (tgBot) return tgBot.hasPendingEvent(channelId);
	return false;
};

// Watch slack/events/, telegram/events/, and root events/ for backward compat
const watchDirs = ["slack/events", "telegram/events", "events"];
const watchers = watchDirs.map(sub => {
	const w = createEventsWatcher(
		workingDir,
		(channelId, text) => universalBot.enqueueEvent({ channel: channelId, text, type: "mention", user: "EVENT", ts: Date.now().toString() }),
		hasPendingEvent,
		sub === "events" ? undefined : sub.split("/")[0],
	);
	w.start();
	return w;
});

const shutdown = () => {
	log.logInfo("Shutting down...");
	tgBots.forEach((b) => b.stop());
	watchers.forEach((w) => w.stop());
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
