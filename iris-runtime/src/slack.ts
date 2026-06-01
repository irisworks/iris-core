import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import { createSession, findByThread, loadSessions, registerSessionRequest } from "./sessions.js";
import type { Attachment, ChannelStore } from "./store.js";

// Slack has a 40,000 character limit for message text
const SLACK_MAX_LENGTH = 40000;

/**
 * Truncate text to fit within Slack's message limit.
 * If truncated, adds "\n\n[message truncated]" at the end.
 */
function truncateForSlack(text: string): string {
	if (text.length <= SLACK_MAX_LENGTH) return text;
	const suffix = "\n\n[message truncated]";
	return text.slice(0, SLACK_MAX_LENGTH - suffix.length) + suffix;
}

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
	setWorking: (working: boolean) => Promise<void>;
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
	private socketClient: SocketModeClient;
	private webClient: WebClient;
	private handler: IrisHandler;
	private workingDir: string;
	private store: ChannelStore;
	private botUserId: string | null = null;
	private botId: string | null = null; // bot_id (different from user_id) — used to filter own messages in leads channels
	private startupTs: string | null = null; // Messages older than this are just logged, not processed
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	private users = new Map<string, SlackUser>();
	private channels = new Map<string, SlackChannel>();
	private queues = new Map<string, ChannelQueue>();
	private allowedChannels = new Set<string>(); // If non-empty, only respond to these channel IDs

	// Channel modes loaded from workingDir/data/channels.json
	private channelModes = new Map<string, "thread" | "interactive-thread" | "passthrough" | "leads" | "dm" | "admin">();
	private channelPassthroughUrls = new Map<string, string>(); // channel -> endpoint URL for passthrough mode
	private channelRequireMention = new Set<string>(); // channels where top-level messages require @mention

	// SESSION-<id> → real Slack { channel, threadTs } for routing postMessage/updateMessage
	private sessionRoutes = new Map<string, { channel: string; threadTs: string }>();

	constructor(
		handler: IrisHandler,
		config: { appToken: string; botToken: string; workingDir: string; store: ChannelStore },
	) {
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.store = config.store;
		this.socketClient = new SocketModeClient({ appToken: config.appToken });
		this.webClient = new WebClient(config.botToken);

		// IRIS_SLACK_CHANNEL: comma-separated channel IDs this instance should respond to.
		// If unset, responds to all channels (Iris herself). If set, ignores other channels.
		const channelFilter = process.env.IRIS_SLACK_CHANNEL;
		if (channelFilter) {
			channelFilter.split(",").map((id) => id.trim()).filter(Boolean).forEach((id) => this.allowedChannels.add(id));
			log.logInfo(`Channel filter active: ${[...this.allowedChannels].join(", ")}`);
		}
	}

	// ==========================================================================
	// Channel mode helpers
	// ==========================================================================

	private loadChannelModes(): void {
		const channelsPath = join(this.workingDir, "data", "channels.json");
		if (!existsSync(channelsPath)) return;
		try {
			const raw = JSON.parse(readFileSync(channelsPath, "utf-8")) as Record<string, { mode: string; url?: string; requireMentionForTopLevel?: boolean }>;
			for (const [id, config] of Object.entries(raw)) {
				if (config.mode === "thread" || config.mode === "interactive-thread" || config.mode === "passthrough" || config.mode === "leads" || config.mode === "dm" || config.mode === "admin") {
					this.channelModes.set(id, config.mode);
				}
				if (config.mode === "passthrough" && config.url) {
					this.channelPassthroughUrls.set(id, config.url);
				}
				if (config.requireMentionForTopLevel) {
					this.channelRequireMention.add(id);
				}
			}
			log.logInfo(`[channels] Loaded ${this.channelModes.size} channel mode entries`);
		} catch (err) {
			log.logWarning("[channels] Failed to load channels.json", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Get the configured mode for a channel.
	 * Checks exact match first, then prefix wildcards (e.g. "D*").
	 * Defaults to "dm" (non-admin unless explicitly configured).
	 */
	private getChannelMode(channelId: string): "thread" | "interactive-thread" | "passthrough" | "leads" | "dm" | "admin" {
		const exact = this.channelModes.get(channelId);
		if (exact) return exact;
		for (const [pattern, mode] of this.channelModes) {
			if (pattern.endsWith("*") && channelId.startsWith(pattern.slice(0, -1))) {
				return mode;
			}
		}
		return "dm"; // default — non-admin unless explicitly configured
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

		this.loadChannelModes();
		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		this.setupEventHandlers();
		this.setupSocketWatchdog();
		await this.socketClient.start();

		// Record startup time - messages older than this are just logged, not processed
		this.startupTs = (Date.now() / 1000).toFixed(6);

		log.logConnected();

		// Re-dispatch any runs that were interrupted mid-flight (e.g. service restart)
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
		return this.users.get(userId);
	}

	getChannel(channelId: string): SlackChannel | undefined {
		return this.channels.get(channelId);
	}

	getAllUsers(): SlackUser[] {
		return Array.from(this.users.values());
	}

	getAllChannels(): SlackChannel[] {
		return Array.from(this.channels.values());
	}

	/** Virtual channels never touch the Slack API — they're internal routing channels. */
	private isVirtualChannel(channel: string): boolean {
		return channel.startsWith("WEBUI") || channel.startsWith("BRIDGE-") || channel.startsWith("ESCALATE-") || channel.startsWith("SELFHEAL-");
	}

	async postMessage(channel: string, text: string): Promise<string> {
		if (this.isVirtualChannel(channel)) {
			return Date.now().toString();
		}
		if (channel.startsWith("SESSION-")) {
			const route = this.sessionRoutes.get(channel);
			if (!route) return Date.now().toString(); // API injection — no Slack thread to post to
			const truncatedText = truncateForSlack(text);
			const result = await this.webClient.chat.postMessage({
				channel: route.channel,
				thread_ts: route.threadTs,
				text: truncatedText,
			});
			return result.ts as string;
		}
		const truncatedText = truncateForSlack(text);
		const result = await this.webClient.chat.postMessage({ channel, text: truncatedText });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		if (this.isVirtualChannel(channel)) return;
		if (channel.startsWith("SESSION-")) {
			const route = this.sessionRoutes.get(channel);
			if (!route) return; // API injection — no Slack message to update
			const truncatedText = truncateForSlack(text);
			await this.webClient.chat.update({ channel: route.channel, ts, text: truncatedText });
			return;
		}
		const truncatedText = truncateForSlack(text);
		await this.webClient.chat.update({ channel, ts, text: truncatedText });
	}

	/**
	 * Finalize a message — called only for the final response, not intermediate updates.
	 * For BRIDGE channels this resolves the waiting bridge request.
	 * For TELEGRAM channel this sends the response via the bot bridge.
	 * For Slack channels this is equivalent to updateMessage.
	 */
	async finalizeMessage(channel: string, ts: string, text: string): Promise<void> {
		if (channel.startsWith("WEBUI") || channel.startsWith("ESCALATE-") || channel.startsWith("SELFHEAL-")) return;
		if (channel.startsWith("BRIDGE-")) {
			const { resolveBridgeRequest } = await import("./bridge.js");
			const requestId = channel.slice("BRIDGE-".length);
			resolveBridgeRequest(requestId, text);
			return;
		}
		if (channel.startsWith("SESSION-")) {
			// Update the Slack thread message if there's a route; session request
			// resolution happens in main.ts handleEvent after the run completes.
			const route = this.sessionRoutes.get(channel);
			if (route) {
				const truncatedText = truncateForSlack(text);
				await this.webClient.chat.update({ channel: route.channel, ts, text: truncatedText });
			}
			return;
		}
		const truncatedText = truncateForSlack(text);
		await this.webClient.chat.update({ channel, ts, text: truncatedText });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		if (this.isVirtualChannel(channel)) return;
		if (channel.startsWith("SESSION-")) {
			const route = this.sessionRoutes.get(channel);
			if (!route) return;
			await this.webClient.chat.delete({ channel: route.channel, ts });
			return;
		}
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		if (this.isVirtualChannel(channel)) return Date.now().toString();
		if (channel.startsWith("SESSION-")) {
			const route = this.sessionRoutes.get(channel);
			if (!route) return Date.now().toString();
			const truncatedText = truncateForSlack(text);
			const result = await this.webClient.chat.postMessage({
				channel: route.channel,
				thread_ts: threadTs,
				text: truncatedText,
			});
			return result.ts as string;
		}
		const truncatedText = truncateForSlack(text);
		const result = await this.webClient.chat.postMessage({ channel, thread_ts: threadTs, text: truncatedText });
		return result.ts as string;
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		if (this.isVirtualChannel(channel)) return;
		const effectiveChannelId = channel.startsWith("SESSION-")
			? this.sessionRoutes.get(channel)?.channel
			: channel;
		if (!effectiveChannelId) return; // SESSION- with no route
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.webClient.files.uploadV2({
			channel_id: effectiveChannelId,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channel: string, entry: object): void {
		const dir = join(this.workingDir, channel);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
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

			const channelMode = this.getChannelMode(e.channel);

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
				const passthroughUrl = this.channelPassthroughUrls.get(e.channel);
				if (!passthroughUrl) {
					log.logWarning(`[${e.channel}] passthrough mode but no url configured`);
					ack();
					return;
				}
				const threadTs = e.thread_ts ?? e.ts;
				const user = this.users.get(slackEvent.user);
				const userName = user?.displayName || user?.userName || slackEvent.user;
				const senderId = `slack_${threadTs.replace(".", "")}`;
				ack();
				// Fire async — don't block the ack
				(async () => {
					try {
						const apiKey = process.env.PASSTHROUGH_API_KEY ?? "";
						const body = JSON.stringify({ text: slackEvent.text, user: userName, sender_id: senderId });
						const resp = await fetch(passthroughUrl, {
							method: "POST",
							headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
							body,
						});
						const json = await resp.json() as { response?: string; text?: string; error?: string };
						const reply = json.response || json.text || json.error || "(no response)";
						await this.postInThread(e.channel, threadTs, reply);
					} catch (err) {
						log.logWarning(`[${e.channel}] passthrough error`, err instanceof Error ? err.message : String(err));
						await this.postInThread(e.channel, e.ts, "_Bot unavailable, please try again._");
					}
				})();
				return;
			}

			// Thread-mode channels: only respond inside registered session threads
			if (channelMode === "thread") {
				if (!e.thread_ts) {
					// Top-level message in a thread channel — log only, no LLM run
					ack();
					return;
				}
				const sessions = loadSessions(this.workingDir);
				const session = findByThread(sessions, e.channel, e.thread_ts);
				if (!session) {
					// Unrecognised thread — log only, no response
					ack();
					return;
				}
				// Rekey to SESSION-<id> and store the Slack route for postMessage routing
				const sessionChannel = `SESSION-${session.sessionId}`;
				this.sessionRoutes.set(sessionChannel, { channel: e.channel, threadTs: e.thread_ts });
				// Also log user message to the session directory
				const user = this.users.get(slackEvent.user);
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
				const sessions = loadSessions(this.workingDir);
				const threadTs = e.thread_ts ?? e.ts; // top-level: ts becomes the thread anchor

				let session = findByThread(sessions, e.channel, threadTs);

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
				this.sessionRoutes.set(sessionChannel, { channel: e.channel, threadTs });
				const user = this.users.get(slackEvent.user);
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
				if (slackEvent.channel.startsWith("SESSION-")) {
					const route = this.sessionRoutes.get(slackEvent.channel);
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

			const channelModeForFilter = this.getChannelMode(e.channel);
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
			// TEMP DEBUG: log channel_type so we can see what Slack sends for DMs
			if (e.channel.startsWith("D")) {
				log.logInfo(`[debug] DM channel=${e.channel} channel_type=${JSON.stringify(e.channel_type)} isDM=${isDM} text=${(e.text||"").substring(0,20)}`);
			}

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
			const channelMode = this.channelModes.get(e.channel);
			if (this.startupTs && e.ts < this.startupTs && channelMode !== "leads") {
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
				const channelMode = this.getChannelMode(e.channel);
				if (channelMode === "leads") {
					const queue = this.getQueue(e.channel);
					queue.enqueue(() => this.handler.handleEvent(slackEvent, this));
					ack();
					return;
				}
			}

			// Session thread routing for thread-mode channels (non-DM, non-@mention)
			if (!isDM && !isBotMention && e.thread_ts) {
				const channelMode = this.getChannelMode(e.channel);
				if (channelMode === "thread") {
					const sessions = loadSessions(this.workingDir);
					const session = findByThread(sessions, e.channel, e.thread_ts);
					if (session) {
						const sessionChannel = `SESSION-${session.sessionId}`;
						this.sessionRoutes.set(sessionChannel, { channel: e.channel, threadTs: e.thread_ts });
						const user = this.users.get(slackEvent.user);
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
					const sessions = loadSessions(this.workingDir);
					let session = findByThread(sessions, e.channel, e.thread_ts);

					if (!session) {
						if (!e.thread_ts) {
							// Top-level non-mention message — only create session if mention not required
							if (this.channelRequireMention.has(e.channel)) {
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
					this.sessionRoutes.set(sessionChannel, { channel: e.channel, threadTs: e.thread_ts });
					const user = this.users.get(slackEvent.user);
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
				if (channelMode === "passthrough") {
					const passthroughUrl = this.channelPassthroughUrls.get(e.channel);
					if (passthroughUrl) {
						const user = this.users.get(slackEvent.user);
						const userName = user?.displayName || user?.userName || slackEvent.user;
						const senderId = `slack_${e.thread_ts.replace(".", "")}`;
						ack();
						(async () => {
							try {
								const apiKey = process.env.PASSTHROUGH_API_KEY ?? "";
								const body = JSON.stringify({ text: slackEvent.text, user: userName, sender_id: senderId });
								const resp = await fetch(passthroughUrl, {
									method: "POST",
									headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
									body,
								});
								const json = await resp.json() as { response?: string; text?: string; error?: string };
								const reply = json.response || json.text || json.error || "(no response)";
								await this.postInThread(e.channel, e.thread_ts!, reply);
							} catch (err) {
								log.logWarning(`[${e.channel}] passthrough error`, err instanceof Error ? err.message : String(err));
							}
						})();
						return;
					}
				}
			}

			// Only trigger handler for DMs
			if (isDM) {
				const channelMode = this.getChannelMode(e.channel);
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
		const user = this.users.get(event.user);
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
			const user = this.users.get(msg.user!);
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
		for (const [channelId] of this.channels) {
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
		for (const [channelId, channel] of this.channels) {
			const logPath = join(this.workingDir, channelId, "log.jsonl");
			if (existsSync(logPath)) {
				channelsToBackfill.push([channelId, channel]);
			}
		}

		log.logBackfillStart(channelsToBackfill.length);

		let totalMessages = 0;
		for (const [channelId, channel] of channelsToBackfill) {
			try {
				const count = await this.backfillChannel(channelId);
				if (count > 0) log.logBackfillChannel(channel.name, count);
				totalMessages += count;
			} catch (error) {
				log.logWarning(`Failed to backfill #${channel.name}`, String(error));
			}
		}

		const durationMs = Date.now() - startTime;
		log.logBackfillComplete(totalMessages, durationMs);
	}

	// ==========================================================================
	// Private - Fetch Users/Channels
	// ==========================================================================

	private async fetchUsers(): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.webClient.users.list({ limit: 200, cursor });
			const members = result.members as
				| Array<{ id?: string; name?: string; real_name?: string; deleted?: boolean }>
				| undefined;
			if (members) {
				for (const u of members) {
					if (u.id && u.name && !u.deleted) {
						this.users.set(u.id, { id: u.id, userName: u.name, displayName: u.real_name || u.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}

	private async fetchChannels(): Promise<void> {
		// Fetch public/private channels
		let cursor: string | undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "public_channel,private_channel",
				exclude_archived: true,
				limit: 200,
				cursor,
			});
			const channels = result.channels as Array<{ id?: string; name?: string; is_member?: boolean }> | undefined;
			if (channels) {
				for (const c of channels) {
					if (c.id && c.name && c.is_member) {
						this.channels.set(c.id, { id: c.id, name: c.name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);

		// Also fetch DM channels (IMs)
		cursor = undefined;
		do {
			const result = await this.webClient.conversations.list({
				types: "im",
				limit: 200,
				cursor,
			});
			const ims = result.channels as Array<{ id?: string; user?: string }> | undefined;
			if (ims) {
				for (const im of ims) {
					if (im.id) {
						// Use user's name as channel name for DMs
						const user = im.user ? this.users.get(im.user) : undefined;
						const name = user ? `DM:${user.userName}` : `DM:${im.id}`;
						this.channels.set(im.id, { id: im.id, name });
					}
				}
			}
			cursor = result.response_metadata?.next_cursor;
		} while (cursor);
	}
}
