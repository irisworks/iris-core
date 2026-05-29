import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { existsSync, mkdirSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";
import { createSession, findByThread, loadSessions, registerSessionRequest } from "./sessions.js";
import { parseChannelKind } from "./channel-kind.js";
import type { Attachment, ChannelStore } from "./store.js";
import { ChannelModeConfig } from "./adapters/channel-mode.js";
import { SlackMessageApi } from "./infra/slack/message-api.js";
import { SlackRegistry } from "./infra/slack/registry.js";

// sendToTelegram moved to infra/slack/message-api.ts

// ============================================================================
// Types
// ============================================================================

export interface SlackEvent {
	type: "mention" | "dm";
	channel: string;
	ts: string;
	user: string;
	text: string;
	files?: Array<{ name?: string; url_private_download?: string; url_private?: string }>;
	/** Processed attachments with local paths (populated after logUserMessage) */
	attachments?: Attachment[];
}

export interface SlackUser {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackChannel {
	id: string;
	name: string;
	mode?: string;
}

// Types used by agent.ts
export interface ChannelInfo {
	id: string;
	name: string;
}

export interface UserInfo {
	id: string;
	userName: string;
	displayName: string;
}

export interface SlackContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: ChannelInfo[];
	users: UserInfo[];
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	deleteMessage: () => Promise<void>;
	getAccumulatedText: () => string;
}

export interface IrisHandler {
	/**
	 * Check if channel is currently running (SYNC)
	 */
	isRunning(channelId: string): boolean;

	/**
	 * Handle an event that triggers Iris (ASYNC)
	 * Called only when isRunning() returned false for user messages.
	 * Events always queue and pass isEvent=true.
	 */
	handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void>;

	/**
	 * Handle stop command (ASYNC)
	 * Called when user says "stop" while Iris is running
	 */
	handleStop(channelId: string, slack: SlackBot): Promise<void>;

	/**
	 * Compact context — summarise history into a single entry (ASYNC)
	 */
	handleCompact(channelId: string, slack: SlackBot): Promise<void>;

	/**
	 * Reset context — wipe all message history (ASYNC)
	 */
	handleReset(channelId: string, slack: SlackBot): Promise<void>;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// SlackBot
// ============================================================================

export class SlackBot {
	// ── infrastructure ─────────────────────────────────────────────────────────
	private readonly socketClient: SocketModeClient;
	private readonly webClient: WebClient;
	/** Outbound message API — owns session route table and all chat.* calls. */
	private readonly messageApi: SlackMessageApi;
	/** User + channel identity cache. */
	private readonly registry: SlackRegistry;
	/** Channel mode configuration (loaded from channels.json). */
	private readonly channelMode: ChannelModeConfig;

	// ── state ──────────────────────────────────────────────────────────────────
	private readonly handler: IrisHandler;
	private readonly workingDir: string;
	private readonly store: ChannelStore;
	private readonly allowedChannels = new Set<string>();
	private readonly queues = new Map<string, ChannelQueue>();

	private botUserId: string | null = null;
	private botId: string | null = null;
	private startupTs: string | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	// Coalescing async write buffer — eliminates blocking appendFileSync calls.
	private static readonly LOG_FLUSH_MS = 100;
	private readonly logBuffers = new Map<string, string[]>();
	private readonly logFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly passthroughApiKey: string;

	// ── Telegram delegation (via messageApi) ──────────────────────────────────

	setTelegramContext(channel: string, chatId: string, messageId?: string): void {
		this.messageApi.setTelegramContext(channel, chatId, messageId);
	}

	/**
	 * Clear Telegram context for a channel.
	 */
	clearTelegramContext(channel: string): void {
		this.messageApi.clearTelegramContext(channel);
	}

	constructor(
		handler: IrisHandler,
		config: {
			appToken: string;
			botToken: string;
			workingDir: string;
			store: ChannelStore;
			channelFilter?: string[];
			telegramBridgeUrl?: string;
			passthroughApiKey?: string;
		},
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);

		// Extracted infrastructure components
		this.messageApi = new SlackMessageApi(
			this.webClient,
			config.telegramBridgeUrl ?? "http://localhost:3001",
		);
		this.registry = new SlackRegistry(this.webClient);
		this.channelMode = new ChannelModeConfig();

		this.passthroughApiKey = config.passthroughApiKey ?? "";

		// Channel filter: if set, only respond to listed channel IDs
		for (const id of config.channelFilter ?? []) {
			this.allowedChannels.add(id);
		}
		if (this.allowedChannels.size > 0) {
			log.logInfo(`Channel filter active: ${[...this.allowedChannels].join(", ")}`);
		}
	}

	private async handlePassthroughRequest(
		channel: string,
		threadTs: string,
		text: string,
		userName: string,
		passthroughUrl: string,
	): Promise<void> {
		try {
			const apiKey = this.passthroughApiKey;
			const senderId = `slack_${threadTs.replace(".", "")}`;
			const body = JSON.stringify({ text, user: userName, sender_id: senderId });
			const resp = await fetch(passthroughUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
				body,
			});
			const json = await resp.json() as { response?: string; text?: string; error?: string };
			const reply = json.response || json.text || json.error || "(no response)";
			await this.postInThread(channel, threadTs, reply);
		} catch (err) {
			log.logWarning(`[${channel}] passthrough error`, err instanceof Error ? err.message : String(err));
			await this.postInThread(channel, threadTs, "_Bot unavailable, please try again._");
		}
	}

	// ==========================================================================
	// Session message injection (used by API POST /sessions/:id/message)
	// ==========================================================================

	/**
	 * Inject a message into a session's agent queue and wait for the response.
	 * Logs the user message to the session directory before enqueueing.
	 */
	async injectSessionMessage(sessionId: string, user: string, text: string): Promise<string> {
		const channelId = `SESSION-${sessionId}`;
		const queue = this.getQueue(channelId);

		if (queue.size() >= 5) {
			throw new Error("Session message queue is full");
		}

		const ts = (Date.now() / 1000).toFixed(6);

		// Log user message to session directory
		this.logToFile(channelId, {
			date: new Date().toISOString(),
			ts,
			user,
			text,
			attachments: [],
			isBot: false,
		});

		const responsePromise = registerSessionRequest(sessionId, 600_000);

		const slackEvent: SlackEvent = {
			type: "mention",
			channel: channelId,
			user,
			text,
			ts,
			attachments: [],
		};

		queue.enqueue(() => this.handler.handleEvent(slackEvent, this));
		return responsePromise;
	}

	resetSessionContext(_sessionId: string): void {
		// File-based reset is handled directly in api.ts (context.jsonl wiped).
		// In-memory agent state will reload clean from the empty file on next message.
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		const auth = await this.webClient.auth.test();
		this.botUserId = auth.user_id as string;
		this.botId = auth.bot_id as string | null;

		// Delegate to extracted components
		this.channelMode.load(this.workingDir);
		await this.registry.fetchAll();

		await this.backfillAllChannels();

		this.setupEventHandlers();
		this.setupSocketWatchdog();
		await this.socketClient.start();

		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();

		await this.resumeInterruptedRuns();
	}

	private setupSocketWatchdog(): void {
		// On socket close, exit so systemd restarts the process.
		// All session state is on disk — no data is lost on restart.
		this.socketClient.on("close" as any, () => {
			if (this.reconnectTimer) return; // debounce
			log.logWarning("[socket] Connection closed — exiting for systemd restart");
			this.reconnectTimer = setTimeout(() => process.exit(1), 3000);
		});

		this.socketClient.on("error" as any, (err: Error) => {
			log.logWarning("[socket] Socket error", err.message);
		});

		// Heartbeat: ping Slack API every 60s. If it fails, the token is invalid or
		// the network is down — exit so systemd restarts with a fresh connection.
		const HEARTBEAT_INTERVAL = 60_000;
		const heartbeat = setInterval(async () => {
			try {
				await this.webClient.auth.test();
			} catch (err) {
				log.logWarning("[socket] Heartbeat failed — exiting for systemd restart", err instanceof Error ? err.message : String(err));
				clearInterval(heartbeat);
				process.exit(1);
			}
		}, HEARTBEAT_INTERVAL);
		heartbeat.unref(); // don't keep process alive just for the heartbeat
	}

	getUser(userId: string): SlackUser | undefined {
		return this.registry.getUser(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.registry.getChannel(channelId);
	}

	getAllUsers(): SlackUser[] {
		return this.registry.getAllUsers();
	}

	getAllChannels(): SlackChannel[] {
		return this.registry.getAllChannels();
	}

	// ── Outbound messaging — delegate entirely to SlackMessageApi ─────────────

	async postMessage(channel: string, text: string): Promise<string> {
		return this.messageApi.postMessage(channel, text);
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		return this.messageApi.updateMessage(channel, ts, text);
	}

	async finalizeMessage(channel: string, ts: string, text: string): Promise<void> {
		return this.messageApi.finalizeMessage(channel, ts, text);
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		return this.messageApi.deleteMessage(channel, ts);
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		return this.messageApi.postInThread(channel, threadTs, text);
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		return this.messageApi.uploadFile(channel, filePath, title);
	}

	/**
	 * Log a message to log.jsonl.
	 * Lines are buffered for up to LOG_FLUSH_MS and flushed with a single async write,
	 * keeping appendFileSync off the event loop entirely.
	 */
	logToFile(channel: string, entry: object): void {
		let buf = this.logBuffers.get(channel);
		if (!buf) {
			buf = [];
			this.logBuffers.set(channel, buf);
		}
		buf.push(`${JSON.stringify(entry)}\n`);

		if (!this.logFlushTimers.has(channel)) {
			const timer = setTimeout(() => this._flushLogBuffer(channel), SlackBot.LOG_FLUSH_MS);
			timer.unref?.();
			this.logFlushTimers.set(channel, timer);
		}
	}

	private _flushLogBuffer(channel: string): void {
		this.logFlushTimers.delete(channel);
		const buf = this.logBuffers.get(channel);
		if (!buf || buf.length === 0) return;
		const lines = buf.splice(0); // drain atomically, reset in-place
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFile(join(dir, "log.jsonl"), lines.join("")).catch((err) =>
			log.logWarning("logToFile flush error", err instanceof Error ? err.message : String(err)),
		);
	}

	/**
	 * Log a bot response to log.jsonl
	 */
	logBotResponse(channel: string, text: string, ts: string): void {
		this.logToFile(channel, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Events Integration
	// ==========================================================================

	/**
	 * Enqueue an event for processing. Always queues (no "already working" rejection).
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: SlackEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channel}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Private - Event Handlers
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private setupEventHandlers(): void {
		// Channel @mentions
		this.socketClient.on("app_mention", ({ event, ack }) => {
			const e = event as {
				text: string;
				channel: string;
				user: string;
				ts: string;
				thread_ts?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
			};

			// Skip DMs (handled by message event)
			if (e.channel.startsWith("D")) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user,
				text: e.text.replace(/<@[A-Z0-9]+>/gi, "").trim(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALWAYS, even for old messages)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			if (this.startupTs && e.ts < this.startupTs) {
				log.logInfo(
					`[${e.channel}] Logged old message (pre-startup), not triggering: ${slackEvent.text.substring(0, 30)}`,
				);
				ack();
				return;
			}

			// Only respond to allowed channels (if filter is configured)
			if (this.allowedChannels.size > 0 && !this.allowedChannels.has(e.channel)) {
				ack();
				return;
			}

			const channelMode = this.channelMode.getMode(e.channel);

			// Check for admin commands — only allowed in "admin" mode channels
			const cmdText = slackEvent.text.toLowerCase().trim();
			if (cmdText === "stop" || cmdText === "compact" || cmdText === "reset") {
				if (channelMode !== "admin") {
					// Silently ignore admin commands in thread/dm channels
					ack();
					return;
				}
				if (cmdText === "stop") {
					if (this.handler.isRunning(e.channel)) {
						this.handler.handleStop(e.channel, this); // Don't await, don't queue
					} else {
						this.postMessage(e.channel, "_Nothing running_");
					}
					ack();
					return;
				}
				if (cmdText === "compact") {
					this.handler.handleCompact(e.channel, this);
					ack();
					return;
				}
				if (cmdText === "reset") {
					this.handler.handleReset(e.channel, this);
					ack();
					return;
				}
			}

			// Passthrough mode: forward directly to external endpoint, post raw reply — Iris LLM never runs
			if (channelMode === "passthrough") {
				const passthroughUrl = this.channelMode.getPassthroughUrl(e.channel);
				if (!passthroughUrl) {
					log.logWarning(`[${e.channel}] passthrough mode but no url configured`);
					ack();
					return;
				}
				const threadTs = e.thread_ts ?? e.ts;
				const user = this.registry.getUser(slackEvent.user);
				const userName = user?.displayName || user?.userName || slackEvent.user;
				ack();
				void this.handlePassthroughRequest(e.channel, threadTs, slackEvent.text, userName, passthroughUrl);
				return;
			}

			// Thread-mode channels: only respond inside registered session threads
			if (channelMode === "thread") {
				if (!e.thread_ts) {
					// Top-level message in a thread channel — log only, no LLM run
					ack();
					return;
				}
				const session = findByThread(this.workingDir, e.channel, e.thread_ts);
				if (!session) {
					// Unrecognised thread — log only, no response
					ack();
					return;
				}
				// Rekey to SESSION-<id> and store the Slack route for postMessage routing
				const sessionChannel = `SESSION-${session.sessionId}`;
				this.messageApi.setSessionRoute(sessionChannel,{ channel: e.channel, threadTs: e.thread_ts });
				// Also log user message to the session directory
				const user = this.registry.getUser(slackEvent.user);
				this.logToFile(sessionChannel, {
					date: new Date(parseFloat(slackEvent.ts) * 1000).toISOString(),
					ts: slackEvent.ts,
					user: slackEvent.user,
					userName: user?.userName,
					displayName: user?.displayName,
					text: slackEvent.text,
					attachments: slackEvent.attachments || [],
					isBot: false,
				});
				slackEvent.channel = sessionChannel;
			}

			// Interactive-thread mode: top-level @mention creates a session;
			// subsequent replies in the same thread continue it without needing @mention.
			if (channelMode === "interactive-thread") {
				const threadTs = e.thread_ts ?? e.ts; // top-level: ts becomes the thread anchor

				let session = findByThread(this.workingDir, e.channel, threadTs);

				if (!session) {
					if (e.thread_ts) {
						// Reply in an unrecognised thread — create a session anchored to the thread
						session = createSession(this.workingDir, {
							originChannel: e.channel,
							originThreadTs: e.thread_ts,
						});
					} else {
						// Top-level @mention — create a new session anchored to this message's ts
						session = createSession(this.workingDir, {
							originChannel: e.channel,
							originThreadTs: e.ts,
						});
					}
				}

				const sessionChannel = `SESSION-${session.sessionId}`;
				this.messageApi.setSessionRoute(sessionChannel,{ channel: e.channel, threadTs });
				const user = this.registry.getUser(slackEvent.user);
				this.logToFile(sessionChannel, {
					date: new Date(parseFloat(slackEvent.ts) * 1000).toISOString(),
					ts: slackEvent.ts,
					user: slackEvent.user,
					userName: user?.userName,
					displayName: user?.displayName,
					text: slackEvent.text,
					attachments: slackEvent.attachments || [],
					isBot: false,
				});
				slackEvent.channel = sessionChannel;
			}

			// dm/admin mode: queue normally. Also handles rekeyed SESSION- events.
			const queue = this.getQueue(slackEvent.channel);
			if (queue.size() >= 5) {
				if (parseChannelKind(slackEvent.channel).kind === "session") {
					const route = this.messageApi.getSessionRoute(slackEvent.channel);
					if (route) this.postInThread(route.channel, route.threadTs, "_Too many messages queued. Please wait._");
				} else {
					this.postMessage(slackEvent.channel, "_Too many messages queued. Say `stop` to cancel._");
				}
			} else {
				queue.enqueue(() => this.handler.handleEvent(slackEvent, this));
			}

			ack();
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }) => {
			const e = event as {
				text?: string;
				channel: string;
				user?: string;
				ts: string;
				thread_ts?: string;
				channel_type?: string;
				subtype?: string;
				bot_id?: string;
				files?: Array<{ name: string; url_private_download?: string; url_private?: string; filetype?: string; plain_text?: string; preview_plain_text?: string; subject?: string }>;
				blocks?: Array<{ type: string; text?: { type: string; text: string }; elements?: any[] }>;
			};

			// Skip bot messages, edits, etc.
			// Exception: in leads mode, allow all bot/integration messages (n8n, insta, email, etc.)
			// Only skip own bot messages to avoid loops.
			const isEmailLead = !!e.bot_id && !e.user &&
				Array.isArray((e as any).files) &&
				(e as any).files.some((f: any) => f.filetype === "email");

			const channelModeForFilter = this.channelMode.getMode(e.channel);
			const isLeadsChannel = channelModeForFilter === "leads";

			// Subtype filter — allow bot_message in leads channels (workflow/n8n/insta/email bots)
			if (e.subtype !== undefined && e.subtype !== "file_share") {
				if (!(isLeadsChannel && e.subtype === "bot_message")) {
					ack();
					return;
				}
			}

			// Bot/user filter — in leads channels allow all integrations, only skip our own messages
			if (isLeadsChannel) {
				if (e.user === this.botUserId || e.bot_id === this.botId) {
					ack();
					return;
				}
			} else {
				// In interactive-thread mode, allow bot messages ONLY if they're top-level (thread anchors)
				// This lets skills post thread openers that trigger session creation
				const isInteractiveThread = channelModeForFilter === "interactive-thread";
				const isTopLevel = !e.thread_ts;
				const isBotMessage = e.bot_id || !e.user || e.user === this.botUserId;

				if (isBotMessage && !(isInteractiveThread && isTopLevel)) {
					// Skip bot messages except for top-level in interactive-thread channels
					ack();
					return;
				}
			}

			if (!e.text && (!e.files || e.files.length === 0)) {
				ack();
				return;
			}

			const isDM = e.channel_type === "im";
			const isBotMention = e.text?.includes(`<@${this.botUserId}>`);

			// Skip channel @mentions - already handled by app_mention event
			if (!isDM && isBotMention) {
				ack();
				return;
			}

			const slackEvent: SlackEvent = {
				type: isDM ? "dm" : "mention",
				channel: e.channel,
				ts: e.ts,
				user: e.user || e.bot_id || "integration",
				text: (() => {
					// For email leads, extract plain_text from the email file
					if (isEmailLead) {
						const emailFile = (e as any).files?.find((f: any) => f.filetype === "email");
						const subject = emailFile?.subject ? `Subject: ${emailFile.subject}\n` : "";
						const body = emailFile?.plain_text || emailFile?.preview_plain_text || "";
						return `${subject}${body}`.trim();
					}
					// For block-based messages (insta-bot, n8n) — blocks have the full content, e.text is a short fallback
					if (isLeadsChannel && e.blocks && e.blocks.length > 0) {
						const blockText = e.blocks
							.map((b: any) => b.text?.text || b.elements?.map((el: any) => el.text || "").join("") || "")
							.join("\n")
							.trim();
						if (blockText && blockText.length > (e.text || "").length) {
							return blockText.replace(/<@[A-Z0-9]+>/gi, "").trim();
						}
					}
					// For all other messages — use text as-is
					return (e.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
				})(),
				files: e.files,
			};

			// SYNC: Log to log.jsonl (ALL messages - channel chatter and DMs)
			// Also downloads attachments in background and stores local paths
			slackEvent.attachments = this.logUserMessage(slackEvent);

			// Only trigger processing for messages AFTER startup (not replayed old messages)
			// Exception: "leads" mode channels process missed messages on restart
			if (this.startupTs && e.ts < this.startupTs && this.channelMode.getMode(e.channel) !== "leads") {
				log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
				ack();
				return;
			}

			// Only respond to allowed channels (if filter is configured)
			if (this.allowedChannels.size > 0 && !this.allowedChannels.has(e.channel)) {
				ack();
				return;
			}

			// Leads mode: top-level message (no thread) fires LLM without @mention needed
			if (!isDM && !isBotMention && !e.thread_ts) {
				const channelMode = this.channelMode.getMode(e.channel);
				if (channelMode === "leads") {
					const queue = this.getQueue(e.channel);
					queue.enqueue(() => this.handler.handleEvent(slackEvent, this));
					ack();
					return;
				}
			}

			// Session thread routing for thread-mode channels (non-DM, non-@mention)
			if (!isDM && !isBotMention && e.thread_ts) {
				const channelMode = this.channelMode.getMode(e.channel);
				if (channelMode === "thread") {
					const session = findByThread(this.workingDir, e.channel, e.thread_ts);
					if (session) {
						const sessionChannel = `SESSION-${session.sessionId}`;
						this.messageApi.setSessionRoute(sessionChannel,{ channel: e.channel, threadTs: e.thread_ts });
						const user = this.registry.getUser(slackEvent.user);
						this.logToFile(sessionChannel, {
							date: new Date(parseFloat(slackEvent.ts) * 1000).toISOString(),
							ts: slackEvent.ts,
							user: slackEvent.user,
							userName: user?.userName,
							displayName: user?.displayName,
							text: slackEvent.text,
							attachments: slackEvent.attachments || [],
							isBot: false,
						});
						slackEvent.channel = sessionChannel;
						const sessionQueue = this.getQueue(sessionChannel);
						if (sessionQueue.size() >= 5) {
							this.postInThread(e.channel, e.thread_ts, "_Too many messages queued. Please wait._");
						} else {
							sessionQueue.enqueue(() => this.handler.handleEvent(slackEvent, this));
						}
						ack();
						return;
					}
				}
				if (channelMode === "interactive-thread") {
					let session = findByThread(this.workingDir, e.channel, e.thread_ts);

					if (!session) {
						if (!e.thread_ts) {
							// Top-level non-mention message — only create session if mention not required
							if (this.channelMode.requiresMentionForTopLevel(e.channel)) {
								// requireMentionForTopLevel: ignore, @mention via app_mention will create the session
								ack();
								return;
							}
						}
						// Unknown thread — create a session anchored to it
						session = createSession(this.workingDir, {
							originChannel: e.channel,
							originThreadTs: e.thread_ts ?? e.ts,
						});
					}

					const sessionChannel = `SESSION-${session.sessionId}`;
					// Use e.thread_ts ?? e.ts: for top-level messages e.thread_ts is undefined,
					// and the message's own ts becomes the thread anchor for replies.
					const sessionThreadTs = e.thread_ts ?? e.ts;
					this.messageApi.setSessionRoute(sessionChannel,{ channel: e.channel, threadTs: sessionThreadTs });
					const user = this.registry.getUser(slackEvent.user);
					this.logToFile(sessionChannel, {
						date: new Date(parseFloat(slackEvent.ts) * 1000).toISOString(),
						ts: slackEvent.ts,
						user: slackEvent.user,
						userName: user?.userName,
						displayName: user?.displayName,
						text: slackEvent.text,
						attachments: slackEvent.attachments || [],
						isBot: false,
					});
					slackEvent.channel = sessionChannel;
					const sessionQueue = this.getQueue(sessionChannel);
					if (sessionQueue.size() >= 5) {
						this.postInThread(e.channel, sessionThreadTs, "_Too many messages queued. Please wait._");
					} else {
						sessionQueue.enqueue(() => this.handler.handleEvent(slackEvent, this));
					}
					ack();
					return;
				}
				if (channelMode === "passthrough") {
					const passthroughUrl = this.channelMode.getPassthroughUrl(e.channel);
					if (passthroughUrl) {
						const user = this.registry.getUser(slackEvent.user);
						const userName = user?.displayName || user?.userName || slackEvent.user;
						ack();
						void this.handlePassthroughRequest(e.channel, e.thread_ts!, slackEvent.text, userName, passthroughUrl);
						return;
					}
				}
			}

			// Only trigger handler for DMs
			if (isDM) {
				const channelMode = this.channelMode.getMode(e.channel);
				// Check for stop/compact/reset commands — only allowed in "admin" mode
				const dmCmdText = slackEvent.text.toLowerCase().trim();
				if (dmCmdText === "stop" || dmCmdText === "compact" || dmCmdText === "reset") {
					if (channelMode === "admin") {
						if (dmCmdText === "stop") {
							if (this.handler.isRunning(e.channel)) {
								this.handler.handleStop(e.channel, this); // Don't await, don't queue
							} else {
								this.postMessage(e.channel, "_Nothing running_");
							}
							ack();
							return;
						}
						if (dmCmdText === "compact") {
							this.handler.handleCompact(e.channel, this);
							ack();
							return;
						}
						if (dmCmdText === "reset") {
							this.handler.handleReset(e.channel, this);
							ack();
							return;
						}
					}
					// Silently ignore admin commands in dm/thread mode
					ack();
					return;
				}

				const dmQueue = this.getQueue(e.channel);
				if (dmQueue.size() >= 5) {
					this.postMessage(e.channel, "_Too many messages queued. Say `stop` to cancel._");
				} else {
					dmQueue.enqueue(() => this.handler.handleEvent(slackEvent, this));
				}
			}

			ack();
		});
	}

	/**
	 * Log a user message to log.jsonl (SYNC)
	 * Downloads attachments in background via store
	 */
	private logUserMessage(event: SlackEvent): Attachment[] {
		const user = this.registry.getUser(event.user);
		// Process attachments - queues downloads in background
		const attachments = event.files ? this.store.processAttachments(event.channel, event.files, event.ts) : [];
		this.logToFile(event.channel, {
			date: new Date(parseFloat(event.ts) * 1000).toISOString(),
			ts: event.ts,
			user: event.user,
			userName: user?.userName,
			displayName: user?.displayName,
			text: event.text,
			attachments,
			isBot: false,
		});
		return attachments;
	}

	// ==========================================================================
	// Private - Backfill
	// ==========================================================================

	private getExistingTimestamps(channelId: string): Set<string> {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		const timestamps = new Set<string>();
		if (!existsSync(logPath)) return timestamps;

		const content = readFileSync(logPath, "utf-8");
		const lines = content.trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.ts) timestamps.add(entry.ts);
			} catch {}
		}
		return timestamps;
	}

	private async backfillChannel(channelId: string): Promise<number> {
		const existingTs = this.getExistingTimestamps(channelId);

		// Find the biggest ts in log.jsonl
		let latestTs: string | undefined;
		for (const ts of existingTs) {
			if (!latestTs || parseFloat(ts) > parseFloat(latestTs)) latestTs = ts;
		}

		type Message = {
			user?: string;
			bot_id?: string;
			text?: string;
			ts?: string;
			subtype?: string;
			files?: Array<{ name: string }>;
		};
		const allMessages: Message[] = [];

		let cursor: string | undefined;
		let pageCount = 0;
		const maxPages = 3;

		do {
			const result = await this.webClient.conversations.history({
				channel: channelId,
				oldest: latestTs, // Only fetch messages newer than what we have
				inclusive: false,
				limit: 1000,
				cursor,
			});
			if (result.messages) {
				allMessages.push(...(result.messages as Message[]));
			}
			cursor = result.response_metadata?.next_cursor;
			pageCount++;
		} while (cursor && pageCount < maxPages);

		// Filter: include Iris's messages, exclude other bots, skip already logged
		const relevantMessages = allMessages.filter((msg) => {
			if (!msg.ts || existingTs.has(msg.ts)) return false; // Skip duplicates
			if (msg.user === this.botUserId) return true;
			if (msg.bot_id) return false;
			if (msg.subtype !== undefined && msg.subtype !== "file_share") return false;
			if (!msg.user) return false;
			if (!msg.text && (!msg.files || msg.files.length === 0)) return false;
			return true;
		});

		// Reverse to chronological order
		relevantMessages.reverse();

		// Log each message to log.jsonl
		for (const msg of relevantMessages) {
			const isIrisMessage = msg.user === this.botUserId;
			const user = this.registry.getUser(msg.user!);
			// Strip @mentions from text (same as live messages)
			const text = (msg.text || "").replace(/<@[A-Z0-9]+>/gi, "").trim();
			// Process attachments - queues downloads in background
			const attachments = msg.files ? this.store.processAttachments(channelId, msg.files, msg.ts!) : [];

			this.logToFile(channelId, {
				date: new Date(parseFloat(msg.ts!) * 1000).toISOString(),
				ts: msg.ts!,
				user: isIrisMessage ? "bot" : msg.user!,
				userName: isIrisMessage ? undefined : user?.userName,
				displayName: isIrisMessage ? undefined : user?.displayName,
				text,
				attachments,
				isBot: isIrisMessage,
			});
		}

		return relevantMessages.length;
	}

	/**
	 * After startup, detect channels with interrupted runs (bot posted only a placeholder
	 * but the agent never completed) and re-dispatch the last user message.
	 * A placeholder is any bot message matching the pattern: starts with "_" and ends with " ...".
	 */
	private async resumeInterruptedRuns(): Promise<void> {
		for (const channel of this.registry.getAllChannels()) {
			const channelId = channel.id;
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (!existsSync(logPath)) continue;

			let entries: Array<{ ts: string; user: string; text: string; isBot: boolean }>;
			try {
				const content = readFileSync(logPath, "utf-8");
				entries = content
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((l) => {
						try {
							return JSON.parse(l);
						} catch {
							return null;
						}
					})
					.filter(Boolean);
			} catch {
				continue;
			}

			if (entries.length === 0) continue;

			// Find the last user message
			let lastUserIdx = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (!entries[i].isBot) {
					lastUserIdx = i;
					break;
				}
			}

			if (lastUserIdx === -1) continue;

			const userEntry = entries[lastUserIdx];
			const afterUser = entries.slice(lastUserIdx + 1);

			// Check if all bot messages after the user message are placeholders (no real response)
			const isPlaceholder = (e: { isBot: boolean; text: string }) =>
				e.isBot && e.text?.startsWith("_") && e.text?.endsWith(" ...");

			const hasRealResponse = afterUser.some((e) => e.isBot && !isPlaceholder(e));

			if (hasRealResponse) continue; // Run completed normally

			// Interrupted run detected
			const placeholders = afterUser.filter((e) => e.isBot);
			log.logInfo(
				`[${channelId}] Interrupted run detected, re-dispatching: "${userEntry.text?.substring(0, 60)}"`,
			);

			// Delete stale placeholder messages from Slack
			for (const p of placeholders) {
				try {
					await this.webClient.chat.delete({ channel: channelId, ts: p.ts });
					log.logInfo(`[${channelId}] Deleted stale placeholder: ${p.ts}`);
				} catch (err) {
					log.logWarning(
						`[${channelId}] Could not delete stale placeholder ${p.ts} (may need chat:write scope)`,
						err instanceof Error ? err.message : String(err),
					);
				}
			}

			// Re-dispatch as a DM (all Iris-monitored DMs are DMs or mentions — use same type)
			const slackEvent: SlackEvent = {
				type: "dm",
				channel: channelId,
				ts: userEntry.ts,
				user: userEntry.user,
				text: userEntry.text || "",
				attachments: [],
			};
			this.getQueue(channelId).enqueue(() => this.handler.handleEvent(slackEvent, this));
		}
	}

	private async backfillAllChannels(): Promise<void> {
		const startTime = Date.now();

		// Only backfill channels that already have a log.jsonl (Iris has interacted with them before)
		const channelsToBackfill: Array<[string, SlackChannel]> = [];
		for (const channel of this.registry.getAllChannels()) {
			const logPath = join(this.workingDir, channel.id, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channel.id, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		const CONCURRENCY = 5;
		let totalMessages = 0;

		for (let i = 0; i < channelsToBackfill.length; i += CONCURRENCY) {
			const batch = channelsToBackfill.slice(i, i + CONCURRENCY);
			const results = await Promise.allSettled(
				batch.map(([channelId]) => this.backfillChannel(channelId)),
			);
			for (let j = 0; j < results.length; j++) {
				const [, channel] = batch[j];
				const result = results[j];
				if (result.status === "fulfilled") {
					if (result.value > 0) log.logBackfillChannel(channel.name, result.value);
					totalMessages += result.value;
				} else {
					log.logWarning(`Failed to backfill #${channel.name}`, String(result.reason));
				}
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	// fetchUsers() and fetchChannels() moved to infra/slack/registry.ts (SlackRegistry).
	// Called via this.registry.fetchAll() in start().
}
