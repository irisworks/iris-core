#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { startApiServer } from "./api.js";
import { startBridgeServer } from "./bridge.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { type IrisHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { TelegramBot, type TelegramEvent } from "./telegram.js";
import { TelegramLinkManager } from "./telegram-link.js";
import { SlackLinkManager } from "./slack-link.js";
import { ChannelStore, resolveChannelDir } from "./store.js";
import { startScheduler, type SchedulerCallbacks } from "./scheduler.js";
import { resolveBridgeRequest, resolveBridgeByChannel } from "./bridge.js";
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

// Telegram context adapter and telegramHandler have been removed.
// All Telegram message routing is now handled internally by TelegramBot,
// which forwards every message to the linked sub-agent's bridge.

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
const effectiveApiUrl = process.env.IRIS_API_URL ?? `http://127.0.0.1:${effectiveApiPort}`;
// botRef is set after bot construction below; the closure captures it by reference
let botRef: SlackBotClass | TelegramBot | null = null;
const tgBotsForApi: TelegramBot[] = []; // populated after bot construction

// Single TelegramLinkManager shared across all bots and the API server
const telegramLinkManager = new TelegramLinkManager(workingDir);

// Single SlackLinkManager shared across the Slack bot and the API server
const slackLinkManager = new SlackLinkManager(workingDir);

// Scheduler callbacks — notifyOwner posts a message via the owning bot
const schedulerCallbacks: SchedulerCallbacks = {
	workingDir,
	notifyOwner: (botId, channelId, text) => {
		const bot = tgBotsForApi.find((b) => b.getBotId() === botId) ?? tgBotsForApi[0];
		if (bot) void bot.postMessage(channelId, text).catch((err: unknown) =>
			log.logWarning(`[notifyOwner] postMessage to ${channelId} failed`, String(err)),
		);
	},
	getBotForAgent: (agentId) => telegramLinkManager.getBotForAgent(agentId),
};

startApiServer(
	effectiveApiPort,
	workingDir,
	channelStates,
	() => botRef as any,
	telegramLinkManager,
	schedulerCallbacks,
	slackLinkManager,
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
			linkManager: slackLinkManager,
			irisApiUrl: effectiveApiUrl,
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
						// Sub-agent: skip typing indicators — bridge resolves on
						// finalizeMessage (or here when no typing placeholder was shown).
						const isTypingIndicator = text.includes("_Thinking_") || text.startsWith("_Starting event:");
						if (!isTypingIndicator) {
							resolveBridgeRequest(requestId, text);
						}
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
				} else if (bridgePort > 0) {
					// Persistent platform channel (e.g. "D0B8NQV8M9U", "tg-8814933356").
					// Skip typing indicators; resolve the waiting bridge request on real output.
					const isTypingIndicator = text.includes("_Thinking_") || text.startsWith("_Starting event:");
					if (!isTypingIndicator) {
						resolveBridgeByChannel(channel, text);
					}
				}
				return Date.now().toString();
			},
			updateMessage: async () => {},
			finalizeMessage: async (channel: string, _ts: string, text: string) => {
				// Called when the LLM replaces a typing placeholder with the real response.
				// This is the correct resolution point when setTyping fired first.
				if (channel.startsWith("BRIDGE-") && bridgePort > 0) {
					const requestId = channel.slice("BRIDGE-".length);
					resolveBridgeRequest(requestId, text);
				} else if (bridgePort > 0) {
					// Persistent platform channel — resolve by channelId.
					resolveBridgeByChannel(channel, text);
				}
			},
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
	const tgBot = new TelegramBot({ token, workingDir, linkManager: telegramLinkManager, irisApiUrl: effectiveApiUrl });
	try {
		await tgBot.start();
	} catch (err) {
		// Registry rejected this bot (max 5 reached) or API error — skip it
		log.logWarning("[telegram] Bot failed to start", err instanceof Error ? err.message : String(err));
		continue;
	}

	log.logInfo(`[telegram:${tgBot.getBotId()}] Started. Send a sub-agent claim token to this bot to link it.`);

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
void startScheduler(schedulerCallbacks);

// Start watchdog: polls Docker every 30s, detects crashes and recoveries.
void startWatchdog({
	onAgentCrashed: (agentId) => {
		for (const bot of tgBotsForApi) {
			bot.notifyLinkedAgentCrashed(agentId);
		}
	},

	onAgentRecovered: async (agentId, agentName) => {
		// Mark any tasks that were missed while the agent was offline
		const missed = await getMissedTasks(agentId);
		if (missed.length === 0) return;

		await Promise.all(missed.map((t) => updateTaskStatus(t.taskId, "skipped")));

		// Notify via Telegram if the agent is linked to a bot
		const botId = await telegramLinkManager.getBotForAgent(agentId);
		if (botId) {
			const channelId = missed[0].channelId;
			const noun = missed.length === 1 ? "task" : "tasks";
			schedulerCallbacks.notifyOwner(
				botId,
				channelId,
				`⚠️ <b>${agentName}</b> missed ${missed.length} scheduled ${noun} while offline. They have been skipped.\n\n` +
				missed.map((t) => `• ${t.localTimeStr ?? t.scheduledFor ?? "?"}: <i>${t.payload.slice(0, 80)}</i>`).join("\n"),
			);
		}
	},
});


// ============================================================================
// Universal router — dispatches events to the right transport.
// For tg-* channels: find the bot whose claim owner matches the chatId.
// Each bot's queues are completely isolated — no cross-bot dispatch.
// ============================================================================

function findBotForChannel(channelId: string): TelegramBot | undefined {
	if (!channelId.startsWith("tg-")) return undefined;
	// Prefer the bot that has seen this specific channel (chatId) before
	const seen = tgBots.find((b) => b.hasSeen(channelId));
	if (seen) return seen;
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
