#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { startApiServer } from "./api.js";
import { startBridgeServer } from "./bridge.js";
import { downloadChannel } from "./download.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { type IrisHandler, type SlackBot, SlackBot as SlackBotClass, type SlackEvent } from "./slack.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Config
// ============================================================================

const IRIS_SLACK_APP_TOKEN = process.env.IRIS_SLACK_APP_TOKEN ?? process.env.IRIS_SLACK_APP_TOKEN;
const IRIS_SLACK_BOT_TOKEN = process.env.IRIS_SLACK_BOT_TOKEN ?? process.env.IRIS_SLACK_BOT_TOKEN;

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
	console.error("Env vars: IRIS_PROVIDER, IRIS_MODEL, IRIS_ENV, IRIS_API_PORT");
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

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir, provider, model),
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

// Split point for long messages — stay safely under Slack's 40k char hard limit.
// We split at a newline near this boundary so cuts look natural.
const SLACK_SPLIT_CHARS = 39000;

/**
 * Find the best split point at or before maxChars — prefer the last newline
 * in the final 20% of the window so cuts land between paragraphs/lines.
 */
function findSplitPoint(text: string, maxChars: number): number {
	if (text.length <= maxChars) return text.length;
	const searchFrom = Math.floor(maxChars * 0.8);
	const newlineIdx = text.lastIndexOf("\n", maxChars);
	return newlineIdx >= searchFrom ? newlineIdx + 1 : maxChars;
}

function createSlackContext(event: SlackEvent, slack: SlackBot, state: ChannelState, isEvent?: boolean) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	// Text in the current active Slack message being streamed into
	let currentChunkText = "";
	let currentChunkTs: string | null = null;
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

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				try {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
					currentChunkText = currentChunkText ? `${currentChunkText}\n${text}` : text;

					// If current chunk exceeds the split threshold, spill into a new thread reply
					while (currentChunkText.length > SLACK_SPLIT_CHARS) {
						const splitAt = findSplitPoint(currentChunkText, SLACK_SPLIT_CHARS);
						const thisChunk = currentChunkText.slice(0, splitAt).trimEnd();
						const remainder = currentChunkText.slice(splitAt).trimStart();

						// Finalise the current message at the split point
						if (currentChunkTs) {
							await slack.updateMessage(event.channel, currentChunkTs, thisChunk);
						} else {
							const ts = await slack.postMessage(event.channel, thisChunk);
							messageTs = messageTs ?? ts;
							currentChunkTs = ts;
						}

						// Start a new thread reply for the overflow
						const newTs = await slack.postInThread(event.channel, messageTs!, remainder + (isWorking ? workingIndicator : ""));
						threadMessageTs.push(newTs);
						currentChunkTs = newTs;
						currentChunkText = remainder;
					}

					const displayText = isWorking ? currentChunkText + workingIndicator : currentChunkText;

					if (currentChunkTs) {
						await slack.updateMessage(event.channel, currentChunkTs, displayText);
					} else {
						const ts = await slack.postMessage(event.channel, displayText);
						messageTs = ts;
						currentChunkTs = ts;
					}

					if (shouldLog && messageTs) {
						slack.logBotResponse(event.channel, text, messageTs);
					}
				} catch (err) {
					log.logWarning("Slack respond error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					// Clamp to 39k chars, split remainder into a thread reply
					accumulatedText = text;
					currentChunkText = text;

					if (currentChunkText.length > SLACK_SPLIT_CHARS) {
						const splitAt = findSplitPoint(currentChunkText, SLACK_SPLIT_CHARS);
						const firstChunk = currentChunkText.slice(0, splitAt).trimEnd();
						const overflow = currentChunkText.slice(splitAt).trimStart();

						if (messageTs) {
							await slack.finalizeMessage(event.channel, messageTs, firstChunk);
						} else {
							messageTs = await slack.postMessage(event.channel, firstChunk);
							currentChunkTs = messageTs;
						}

						const newTs = await slack.postInThread(event.channel, messageTs!, overflow);
						threadMessageTs.push(newTs);
						currentChunkTs = newTs;
					} else {
						const displayText = isWorking ? currentChunkText + workingIndicator : currentChunkText;
						if (messageTs) {
							await slack.finalizeMessage(event.channel, messageTs, displayText);
						} else {
							messageTs = await slack.postMessage(event.channel, displayText);
							currentChunkTs = messageTs;
						}
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
							accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "_Thinking_";
							messageTs = await slack.postMessage(event.channel, accumulatedText + workingIndicator);
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
			updatePromise = updatePromise.then(async () => {
				try {
					isWorking = working;
					if (currentChunkTs) {
						const displayText = isWorking ? currentChunkText + workingIndicator : currentChunkText;
						await slack.updateMessage(event.channel, currentChunkTs, displayText);
					}
				} catch (err) {
					log.logWarning("Slack setWorking error", err instanceof Error ? err.message : String(err));
				}
			});
			await updatePromise;
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

// Start internal API server (default port 3000, always-on for sub-agent escalation)
const effectiveApiPort = apiPort > 0 ? apiPort : 3000;
// botRef is set after bot construction below; the closure captures it by reference
let botRef: SlackBotClass | null = null;
startApiServer(effectiveApiPort, workingDir, channelStates, () => botRef);

// Start bridge server if requested (sub-agents only — set IRIS_BRIDGE_PORT)
const bridgePort = parseInt(process.env.IRIS_BRIDGE_PORT ?? "0", 10);
if (bridgePort > 0) {
	startBridgeServer(bridgePort, workingDir);
}

if (SLACK_ENABLED) {
	// Shared store for attachment downloads (also used per-channel in getState)
	const sharedStore = new ChannelStore({ workingDir, botToken: IRIS_SLACK_BOT_TOKEN! });

	const bot = new SlackBotClass(handler, {
		appToken: IRIS_SLACK_APP_TOKEN,
		botToken: IRIS_SLACK_BOT_TOKEN,
		workingDir,
		store: sharedStore,
	});
	botRef = bot;

	// Start events watcher
	const eventsWatcher = createEventsWatcher(workingDir, bot);
	eventsWatcher.start();

	// Handle shutdown
	process.on("SIGINT", () => {
		log.logInfo("Shutting down...");
		eventsWatcher.stop();
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		log.logInfo("Shutting down...");
		eventsWatcher.stop();
		process.exit(0);
	});

	bot.start();
} else {
	// Bridge-only mode — no Slack connection, events watcher only
	log.logInfo("Slack tokens not set — running in bridge-only mode (events watcher + bridge server)");

	// Create a minimal stub bot for the events watcher and session injection
	const stubBot = {
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllChannels: () => [],
		getAllUsers: () => [],
		postMessage: async () => Date.now().toString(),
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
			// Re-use the same logic as SlackBot.injectSessionMessage
			const { registerSessionRequest } = await import("./sessions.js");
			const channelId = `SESSION-${sessionId}`;
			const ts = (Date.now() / 1000).toFixed(6);
			const responsePromise = registerSessionRequest(sessionId, 90_000);
			const slackEvent = { type: "mention" as const, channel: channelId, user, text, ts, attachments: [] };
			handler.handleEvent(slackEvent, stubBot as any);
			return responsePromise;
		},
	} as any;

	// Wire botRef so the API server's injectSessionMessage works
	botRef = stubBot;

	const eventsWatcher = createEventsWatcher(workingDir, stubBot);
	eventsWatcher.start();

	process.on("SIGINT", () => { eventsWatcher.stop(); process.exit(0); });
	process.on("SIGTERM", () => { eventsWatcher.stop(); process.exit(0); });

	log.logInfo("⚡️ Bridge-only mode active");
}
