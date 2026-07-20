import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import * as log from "../../engine/log.js";
import { admitsBotMessage, parseAdminCommand, resolveDispatch, type InboundMessage } from "../../engine/dispatch.js";
import {
	DEFAULT_CHANNEL_CONFIG,
	resolveChannelEntry,
	resolveWildcard,
	type DispatchConfig,
	type LegacyChannelMode,
	type RawChannelEntry,
	type RelayConfig,
	type ResolvedChannelConfig,
} from "../../engine/dispatch-config.js";
import { loadSessions, registerSessionRequest } from "../../engine/sessions.js";
import { resolveChannelDir, type Attachment, type ChannelStore } from "../../engine/store.js";
import type { ChannelState } from "../../engine/index.js";
import {
	registerPromptProfile,
	type ChannelInfo,
	type ChannelTransport,
	type MessageContext,
	type TransportEvent,
	type TransportPromptProfile,
	type UserInfo,
} from "../../transport/types.js";

// Slack message text limit (safely under the actual 40K limit); IRIS_SLACK_MAX_CHARS overrides
const SLACK_MAX_LENGTH = Number(process.env.IRIS_SLACK_MAX_CHARS) || 30000;

/**
 * Passthrough/relay configuration (data/channels.json, mode "passthrough"):
 *   url          — external endpoint messages are forwarded to (required)
 *   secretName   — API key resolved via the get-secret skill; falls back to
 *                  the PASSTHROUGH_API_KEY env var when unset
 *   payload      — JSON body template; string values support placeholders:
 *                  {{text}} {{user_id}} {{user_name}} {{user_handle}} {{sender_id}} {{channel}} {{ts}}
 *                  Default: { "text": "{{text}}", "user": "{{user_name}}", "sender_id": "{{sender_id}}" }
 *   replyPrefix  — optional prefix prepended to the endpoint's reply when posted back
 */
type PassthroughConfig = RelayConfig;

// The six legacy mode names, kept as the channels.json vocabulary (dispatch-config.ts
// expands them into the container+trigger+flags shape the dispatch pipeline runs on).
type ChannelMode = LegacyChannelMode;

/** Recursively substitute {{placeholders}} in string values of a JSON template. */
function renderPayloadTemplate(node: unknown, vars: Record<string, string>): unknown {
	if (typeof node === "string") return node.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
	if (Array.isArray(node)) return node.map((item) => renderPayloadTemplate(item, vars));
	if (node && typeof node === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) out[key] = renderPayloadTemplate(value, vars);
		return out;
	}
	return node;
}

/**
 * Length of text as Slack counts it. Slack HTML-escapes &, < and > (to &amp;,
 * &lt;, &gt;) before enforcing its message-length limits, so a reply heavy on
 * code blocks or comparison operators can be rejected as msg_too_long even
 * when the raw string is under the limit (#61). All length budgeting must use
 * this, not String.length.
 */
export function slackEscapedLength(text: string): number {
	let length = text.length;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code === 38) length += 4; // & -> &amp;
		else if (code === 60 || code === 62) length += 3; // < / > -> &lt; / &gt;
	}
	return length;
}

/** Longest prefix of text whose escaped length stays within maxLength. */
function escapedPrefixLength(text: string, maxLength: number): number {
	let length = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		length += code === 38 ? 5 : code === 60 || code === 62 ? 4 : 1;
		if (length > maxLength) return i;
	}
	return text.length;
}

/**
 * Truncate text to fit within Slack's message limit.
 * If truncated, adds "\n\n[message truncated]" at the end.
 */
function truncateForSlack(text: string): string {
	if (slackEscapedLength(text) <= SLACK_MAX_LENGTH) return text;
	const suffix = "\n\n[message truncated]";
	return text.slice(0, escapedPrefixLength(text, SLACK_MAX_LENGTH - suffix.length)) + suffix;
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

// Shared transport types — moved to transport/types.ts; re-exported for compat
export type { ChannelInfo, UserInfo } from "../../transport/types.js";
export type { MessageContext as SlackContext } from "../../transport/types.js";

// ============================================================================
// Prompt profile
// ============================================================================

// Fragment wording is load-bearing: buildSystemPrompt output for Slack must stay
// byte-identical to the pre-profile hardcoded prompt (verified via last_prompt.jsonl).
export const slackPromptProfile: TransportPromptProfile = {
	transportId: "slack",
	identityLine: "You are Iris, a Slack-connected orchestrator for specialized sub-agents.",
	formattingSection: `## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).`,
	directorySection: (channels: ChannelInfo[], users: UserInfo[]) => {
		const channelMappings =
			channels.length > 0 ? channels.map((c) => `${c.id}\t#${c.name}`).join("\n") : "(no channels loaded)";
		const userMappings =
			users.length > 0 ? users.map((u) => `${u.id}\t@${u.userName}\t${u.displayName}`).join("\n") : "(no users loaded)";
		return `## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).`;
	},
	silentNote: "This deletes the status message and posts nothing to Slack.",
	attachNote: "Share files to Slack",
	attachmentsTagName: "slack_attachments",
	maxMessageChars: SLACK_MAX_LENGTH,
};

registerPromptProfile(slackPromptProfile);

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

export class SlackBot implements ChannelTransport {
	readonly transportId = "slack";
	readonly promptProfile = slackPromptProfile;
	readonly stopCommandHint = "say `stop` first";
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

	// Channel behaviour loaded from workingDir/data/channels.json.
	// Keyed by channel ID or prefix wildcard (e.g. "D*"); resolved via resolveChannelConfig().
	private channelConfigs = new Map<string, ResolvedChannelConfig>();
	private passthroughSecretCache = new Map<string, string>(); // secretName -> resolved value

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
			const raw = JSON.parse(readFileSync(channelsPath, "utf-8")) as Record<string, RawChannelEntry>;
			for (const [id, entry] of Object.entries(raw)) {
				const resolved = resolveChannelEntry(entry);
				if (!resolved) {
					log.logWarning(`[channels] ${id}: unknown mode "${entry.mode}" — entry ignored`);
					continue;
				}
				if (entry.mode === "passthrough" && !resolved.dispatch.relay) {
					log.logWarning(`[channels] ${id}: passthrough mode without url — messages will not be forwarded`);
				}
				this.channelConfigs.set(id, resolved);
			}
			log.logInfo(`[channels] Loaded ${this.channelConfigs.size} channel mode entries`);
		} catch (err) {
			log.logWarning("[channels] Failed to load channels.json", err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Resolve the API key for a passthrough endpoint.
	 * Order: PASSTHROUGH_API_KEY env var, then the channel's secretName via the
	 * get-secret skill (cached per secret name for the process lifetime).
	 */
	private resolvePassthroughKey(secretName?: string): string {
		if (process.env.PASSTHROUGH_API_KEY) return process.env.PASSTHROUGH_API_KEY;
		if (!secretName) return "";
		if (!/^[A-Za-z0-9_-]+$/.test(secretName)) {
			log.logWarning(`[passthrough] invalid secretName: ${secretName}`);
			return "";
		}
		const cached = this.passthroughSecretCache.get(secretName);
		if (cached !== undefined) return cached;
		try {
			const script = join(this.workingDir, "skills", "get-secret", "get-secret");
			const value = execFileSync("bash", [script, secretName], { encoding: "utf8" }).trim();
			this.passthroughSecretCache.set(secretName, value);
			return value;
		} catch (err) {
			log.logWarning(`[passthrough] failed to resolve secret ${secretName}`, err instanceof Error ? err.message : String(err));
			return "";
		}
	}

	/**
	 * Forward a message to a passthrough endpoint and post the reply in-thread.
	 * Fire-and-forget — callers ack() before invoking.
	 */
	private forwardToPassthrough(
		config: PassthroughConfig,
		channel: string,
		threadTs: string,
		userId: string,
		text: string,
		eventTs: string,
		errorNotice: boolean,
	): void {
		const user = this.users.get(userId);
		const userName = user?.displayName || user?.userName || userId;
		const senderId = `slack_${threadTs.replace(".", "")}`;
		void (async () => {
			try {
				const apiKey = this.resolvePassthroughKey(config.secretName);
				const vars: Record<string, string> = {
					text,
					user_id: userId,
					user_name: userName,
					user_handle: userName.toLowerCase().replace(/\s+/g, "."),
					sender_id: senderId,
					channel,
					ts: eventTs,
				};
				const template = config.payload ?? { text: "{{text}}", user: "{{user_name}}", sender_id: "{{sender_id}}" };
				const body = JSON.stringify(renderPayloadTemplate(template, vars));
				const resp = await fetch(config.url, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...(apiKey ? { "X-API-Key": apiKey } : {}) },
					body,
				});
				const json = await resp.json() as { response?: string; text?: string; error?: string };
				const reply = json.response || json.text || json.error || "(no response)";
				await this.postInThread(channel, threadTs, `${config.replyPrefix ?? ""}${reply}`);
			} catch (err) {
				log.logWarning(`[${channel}] passthrough error`, err instanceof Error ? err.message : String(err));
				if (errorNotice) {
					await this.postInThread(channel, eventTs, "_Bot unavailable, please try again._");
				}
			}
		})();
	}

	/**
	 * Resolve the channels.json entry for a channel.
	 * An exact ID match wins; otherwise the longest matching prefix wildcard
	 * (e.g. "D*") wins, so more specific patterns take precedence regardless
	 * of their order in channels.json.
	 */
	private resolveChannelConfig(channelId: string): ResolvedChannelConfig {
		return resolveWildcard(this.channelConfigs, channelId) ?? DEFAULT_CHANNEL_CONFIG;
	}

	/**
	 * Get the configured mode for a channel.
	 * Defaults to "dm" (non-admin unless explicitly configured).
	 */
	private getChannelMode(channelId: string): ChannelMode {
		return this.resolveChannelConfig(channelId).legacyMode;
	}

	/** Passthrough endpoint config for a channel (wildcard-aware, like getChannelMode). */
	private getPassthroughConfig(channelId: string): PassthroughConfig | undefined {
		return this.resolveChannelConfig(channelId).dispatch.relay;
	}

	/** Whether top-level messages in this channel require an @mention (wildcard-aware). */
	private requiresMentionForTopLevel(channelId: string): boolean {
		return this.resolveChannelConfig(channelId).requireMentionForTopLevel;
	}

	/** The 3-primitive dispatch config (container/trigger/flags) driving pipeline decisions for a channel. */
	private getDispatchConfig(channelId: string): DispatchConfig {
		return this.resolveChannelConfig(channelId).dispatch;
	}

	/** Execute an admin control command. Callers must have verified the channel is in "admin" mode. */
	private runAdminCommand(channelId: string, cmd: "stop" | "compact" | "reset"): void {
		if (cmd === "stop") {
			if (this.handler.isRunning(channelId)) {
				this.handler.handleStop(channelId, this); // Don't await, don't queue
			} else {
				this.postMessage(channelId, "_Nothing running_");
			}
		} else if (cmd === "compact") {
			this.handler.handleCompact(channelId, this);
		} else {
			this.handler.handleReset(channelId, this);
		}
	}

	/**
	 * Route a message into a session: rekey the event to SESSION-<id>, register the
	 * Slack route so replies post back into the originating thread, mirror the user
	 * message into the session directory, and enqueue the run (bounded queue).
	 * Shared by the app_mention and message paths for thread/interactive-thread modes.
	 */
	private dispatchToSession(slackEvent: SlackEvent, realChannel: string, threadTs: string, sessionId: string): void {
		const sessionChannel = `SESSION-${sessionId}`;
		this.sessionRoutes.set(sessionChannel, { channel: realChannel, threadTs });
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
		const queue = this.getQueue(sessionChannel);
		if (queue.size() >= 5) {
			this.postInThread(realChannel, threadTs, "_Too many messages queued. Please wait._");
		} else {
			queue.enqueue(() => this.handler.handleEvent(slackEvent, this));
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

		this.loadChannelModes();
		await Promise.all([this.fetchUsers(), this.fetchChannels()]);
		log.logInfo(`Loaded ${this.channels.size} channels, ${this.users.size} users`);

		await this.backfillAllChannels();

		// Rebuild sessionRoutes from disk for interactive-thread channels.
		// Sessions store originChannel + originThreadTs so replies route correctly after restart.
		const sessions = loadSessions(this.workingDir);
		for (const [sessionId, session] of sessions) {
			const slack = session.integrations?.slack;
			if (slack?.originChannel && slack?.originThreadTs) {
				if (this.getChannelMode(slack.originChannel) === "interactive-thread") {
					this.sessionRoutes.set(`SESSION-${sessionId}`, {
						channel: slack.originChannel,
						threadTs: slack.originThreadTs,
					});
				}
			}
		}
		if (this.sessionRoutes.size > 0) {
			log.logInfo(`Rebuilt ${this.sessionRoutes.size} session routes from sessions.json`);
		}

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

	// ==========================================================================
	// ChannelTransport surface
	// ==========================================================================

	async stop(): Promise<void> {
		await this.socketClient.disconnect();
	}

	/** Slack is the fallback owner for everything that isn't a Telegram channel. */
	ownsChannel(channelId: string): boolean {
		return !channelId.startsWith("tg-");
	}

	getChannels(): ChannelInfo[] {
		return this.getAllChannels();
	}

	getUsers(): UserInfo[] {
		return this.getAllUsers();
	}

	createContext(event: TransportEvent, state: ChannelState, isEvent?: boolean): MessageContext {
		return createSlackContext(event as SlackEvent, this, state, isEvent);
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
			const { resolveBridgeRequest } = await import("../../engine/bridge.js");
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
	 * Upload raw text content as a file. Fallback delivery path for replies
	 * Slack refuses to accept as messages (e.g. msg_too_long, #61).
	 */
	async uploadTextFile(channel: string, content: string, fileName: string, threadTs?: string): Promise<void> {
		if (this.isVirtualChannel(channel)) return;
		let channelId = channel;
		let thread = threadTs;
		if (channel.startsWith("SESSION-")) {
			const route = this.sessionRoutes.get(channel);
			if (!route) return;
			channelId = route.channel;
			thread = route.threadTs;
		}
		const args = { channel_id: channelId, content, filename: fileName, title: fileName };
		await (thread
			? this.webClient.files.uploadV2({ ...args, thread_ts: thread })
			: this.webClient.files.uploadV2(args));
	}

	/**
	 * Log a message to log.jsonl (SYNC)
	 * This is the ONLY place messages are written to log.jsonl
	 */
	logToFile(channel: string, entry: object): void {
		const dir = resolveChannelDir(this.workingDir, channel);
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
		// Passthrough channels never run the LLM — a scheduled event targeting one
		// is a misconfiguration, and its output would pollute the relay channel.
		if (this.getChannelMode(event.channel) === "passthrough") {
			log.logWarning(`Refusing event for passthrough channel ${event.channel}: ${event.text.substring(0, 50)}`);
			return false;
		}
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
			// Every exit path must ack or Slack redelivers the envelope; the finally
			// below guarantees exactly one ack even if the handler throws.
			let acked = false;
			const ackOnce = () => {
				if (!acked) {
					acked = true;
					void ack();
				}
			};
			try {
				const e = event as {
					text: string;
					channel: string;
					user: string;
					ts: string;
					thread_ts?: string;
					files?: Array<{ name: string; url_private_download?: string; url_private?: string }>;
				};

				// Skip DMs (handled by message event)
				if (e.channel.startsWith("D")) return;

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
					return;
				}

				// Only respond to allowed channels (if filter is configured)
				if (this.allowedChannels.size > 0 && !this.allowedChannels.has(e.channel)) return;

				const dispatchConfig = this.getDispatchConfig(e.channel);
				const input: InboundMessage = {
					channel: e.channel,
					ts: e.ts,
					threadTs: e.thread_ts,
					isDM: false,
					isMention: true,
					isBotMessage: false, // app_mention only fires for real user @mentions
				};
				const decision = resolveDispatch(input, dispatchConfig, this.workingDir, parseAdminCommand(slackEvent.text));

				switch (decision.kind) {
					case "ignore":
						return;
					case "admin":
						this.runAdminCommand(e.channel, decision.cmd);
						return;
					case "relay-refused":
						log.logWarning(`[${e.channel}] passthrough mode but no url configured`);
						return;
					case "relay":
						// Forwarded verbatim — including "stop"/"reset", perfectly ordinary things to say to an external bot.
						this.forwardToPassthrough(decision.relay, e.channel, decision.threadTs, slackEvent.user, slackEvent.text, e.ts, decision.errorNotice);
						return;
					case "session":
						this.dispatchToSession(slackEvent, e.channel, decision.threadTs, decision.sessionId);
						return;
					case "chat": {
						const queue = this.getQueue(e.channel);
						if (queue.size() >= 5) {
							this.postMessage(e.channel, "_Too many messages queued. Say `stop` to cancel._");
						} else {
							queue.enqueue(() => this.handler.handleEvent(slackEvent, this));
						}
						return;
					}
				}
			} catch (err) {
				log.logWarning("[app_mention] handler error", err instanceof Error ? err.message : String(err));
			} finally {
				ackOnce();
			}
		});

		// All messages (for logging) + DMs (for triggering)
		this.socketClient.on("message", ({ event, ack }) => {
			// Every exit path must ack or Slack redelivers the envelope; the finally
			// below guarantees exactly one ack even if the handler throws.
			let acked = false;
			const ackOnce = () => {
				if (!acked) {
					acked = true;
					void ack();
				}
			};
			try {
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

				const dispatchConfig = this.getDispatchConfig(e.channel);
				// A "chat" container configured to accept bot messages (the leads recipe) allows all
				// integrations (n8n, insta, email bots, ...); every other container/flag combo only
				// admits bot messages in the narrow shapes admitsBotMessage() allows (see dispatch.ts).
				const acceptsAllBotMessages = dispatchConfig.container === "chat" && dispatchConfig.acceptBotMessages;
				const isBotMessage = !!e.bot_id || !e.user || e.user === this.botUserId;

				// Subtype filter — allow bot_message where all bot traffic is accepted (workflow/n8n/insta/email bots)
				if (e.subtype !== undefined && e.subtype !== "file_share") {
					if (!(acceptsAllBotMessages && e.subtype === "bot_message")) return;
				}

				// Bot/user filter — where all bot traffic is accepted, only skip our own messages;
				// otherwise admit bot messages only in the shapes admitsBotMessage() allows (e.g. a
				// sessions container's top-level thread-opener, logged so a human reply can anchor to it).
				if (acceptsAllBotMessages) {
					if (e.user === this.botUserId || e.bot_id === this.botId) return;
				} else {
					if (isBotMessage && !admitsBotMessage(dispatchConfig, !!e.thread_ts)) return;
				}

				if (!e.text && (!e.files || e.files.length === 0)) return;

				const isDM = e.channel_type === "im";
				const isBotMention = e.text?.includes(`<@${this.botUserId}>`) ?? false;

				// Skip channel @mentions - already handled by app_mention event
				if (!isDM && isBotMention) return;

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
						if (acceptsAllBotMessages && e.blocks && e.blocks.length > 0) {
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

				// Only trigger processing for messages AFTER startup (not replayed old messages),
				// unless this channel's config replays missed messages (the leads recipe).
				if (this.startupTs && e.ts < this.startupTs && !dispatchConfig.replayMissed) {
					log.logInfo(`[${e.channel}] Skipping old message (pre-startup): ${slackEvent.text.substring(0, 30)}`);
					return;
				}

				// Only respond to allowed channels (if filter is configured)
				if (this.allowedChannels.size > 0 && !this.allowedChannels.has(e.channel)) return;

				const input: InboundMessage = {
					channel: e.channel,
					ts: e.ts,
					threadTs: e.thread_ts,
					isDM,
					isMention: false, // @mentions arrive via app_mention, which owns them
					isBotMessage,
				};
				const decision = resolveDispatch(input, dispatchConfig, this.workingDir, parseAdminCommand(slackEvent.text));

				switch (decision.kind) {
					case "ignore":
						return;
					case "admin":
						this.runAdminCommand(e.channel, decision.cmd);
						return;
					case "relay-refused":
						log.logWarning(`[${e.channel}] passthrough mode but no url configured`);
						return;
					case "relay":
						this.forwardToPassthrough(decision.relay, e.channel, decision.threadTs, slackEvent.user, slackEvent.text, e.ts, decision.errorNotice);
						return;
					case "session":
						this.dispatchToSession(slackEvent, e.channel, decision.threadTs, decision.sessionId);
						return;
					case "chat": {
						if (!isDM) {
							// Ambient top-level dispatch (the leads recipe): don't post a notice into what's
							// often an external-facing feed — the message is already in log.jsonl.
							const queue = this.getQueue(e.channel);
							if (queue.size() >= 5) {
								log.logWarning(`[${e.channel}] leads queue full, not dispatching: ${slackEvent.text.substring(0, 50)}`);
							} else {
								queue.enqueue(() => this.handler.handleEvent(slackEvent, this));
							}
							return;
						}
						const dmQueue = this.getQueue(e.channel);
						if (dmQueue.size() >= 5) {
							this.postMessage(e.channel, "_Too many messages queued. Say `stop` to cancel._");
						} else {
							dmQueue.enqueue(() => this.handler.handleEvent(slackEvent, this));
						}
						return;
					}
				}
			} catch (err) {
				log.logWarning("[message] handler error", err instanceof Error ? err.message : String(err));
			} finally {
				ackOnce();
			}
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
		const logPath = join(resolveChannelDir(this.workingDir, channelId), "log.jsonl");
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
			// Only dm/admin/leads channels run the LLM in channel context and log its
			// replies to the channel's log.jsonl. Session-mode channels log replies under
			// SESSION-<id>/ and passthrough channels never log bot replies at all, so the
			// placeholder heuristic below would see every conversation there as an
			// interrupted run and start a spurious in-channel LLM run on each restart.
			const mode = this.getChannelMode(channelId);
			if (mode === "thread" || mode === "interactive-thread" || mode === "passthrough") continue;

			const logPath = join(resolveChannelDir(this.workingDir, channelId), "log.jsonl");
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
			const logPath = join(resolveChannelDir(this.workingDir, channelId), "log.jsonl");
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

// ============================================================================
// Create SlackContext adapter
// ============================================================================

// Slack recommends 4000 chars max for chat.update. We use 4000 as the split point.
const SLACK_SPLIT_CHARS = 4000;

// Floor for the msg_too_long re-split retry: below this, give up on message
// delivery and fall back to attaching the reply as a file.
const MIN_SPLIT_CHARS = 1000;

/**
 * Split text into chunks at natural newline boundaries near maxChars.
 * Budgets on the escaped length (see slackEscapedLength) — what Slack
 * actually enforces its limits against.
 */
export function splitIntoChunks(text: string, maxChars: number): string[] {
	if (slackEscapedLength(text) <= maxChars) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (slackEscapedLength(remaining) <= maxChars) {
			chunks.push(remaining);
			break;
		}
		const hardCut = Math.max(1, escapedPrefixLength(remaining, maxChars));
		const searchFrom = Math.floor(hardCut * 0.8);
		const newlineIdx = remaining.lastIndexOf("\n", hardCut);
		const cut = newlineIdx >= searchFrom ? newlineIdx + 1 : hardCut;
		const chunk = remaining.slice(0, cut).trimEnd();
		if (chunk) chunks.push(chunk);
		remaining = remaining.slice(cut).trimStart();
	}
	return chunks;
}

/** Whether a Slack WebClient error is the platform msg_too_long rejection. */
function isMsgTooLong(err: unknown): boolean {
	return (
		(err as { data?: { error?: string } } | undefined)?.data?.error === "msg_too_long" ||
		(err instanceof Error && err.message.includes("msg_too_long"))
	);
}

export function createSlackContext(event: SlackEvent, slack: SlackBot, state: ChannelState, isEvent?: boolean) {
	let messageTs: string | null = null;
	const threadMessageTs: string[] = [];
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);

	// Extract event filename for status message
	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	// Post the final reply: chunk 1 replaces the thinking message, chunks 2+ go
	// to its thread. If Slack rejects a chunk with msg_too_long anyway (its
	// limit accounting has surprised us before — see slackEscapedLength), the
	// already-posted thread chunks are removed and everything is re-posted at
	// half the chunk size, down to MIN_SPLIT_CHARS.
	const postFinalReply = async (text: string, splitChars: number): Promise<void> => {
		try {
			const chunks = splitIntoChunks(text, splitChars);
			if (messageTs) {
				await slack.finalizeMessage(event.channel, messageTs, chunks[0]);
			} else {
				messageTs = await slack.postMessage(event.channel, chunks[0]);
			}
			for (let i = 1; i < chunks.length; i++) {
				const ts = await slack.postInThread(event.channel, messageTs!, chunks[i]);
				threadMessageTs.push(ts);
			}
		} catch (err) {
			if (!isMsgTooLong(err) || splitChars <= MIN_SPLIT_CHARS) throw err;
			const nextSplit = Math.floor(splitChars / 2);
			log.logWarning(`[${event.channel}] Slack rejected reply chunk (msg_too_long) — re-splitting at ${nextSplit} chars`);
			for (const ts of threadMessageTs.splice(0)) {
				try {
					await slack.deleteMessage(event.channel, ts);
				} catch {}
			}
			await postFinalReply(text, nextSplit);
		}
	};

	// Last-resort delivery: never strand the user on the thinking placeholder.
	// Attach the full reply as a file and replace the placeholder with a short
	// notice saying what happened (#61 — failures used to be log-only).
	const deliverAsFileFallback = async (text: string, cause: unknown): Promise<void> => {
		const reason = cause instanceof Error ? cause.message : String(cause);
		let notice: string;
		try {
			await slack.uploadTextFile(event.channel, text, "iris-reply.md", messageTs ?? undefined);
			notice = `_Slack rejected this reply as a message (${reason}) — attached it as a file instead._`;
		} catch (uploadErr) {
			log.logWarning("Slack fallback upload error", uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
			notice = `_Failed to post the reply (${reason}). See the runtime log for details._`;
		}
		try {
			if (messageTs) {
				await slack.finalizeMessage(event.channel, messageTs, notice);
			} else {
				messageTs = await slack.postMessage(event.channel, notice);
			}
		} catch (noticeErr) {
			log.logWarning("Slack fallback notice error", noticeErr instanceof Error ? noticeErr.message : String(noticeErr));
		}
	};

	return {
		// stubBot in bridge-only mode carries transportId "bridge"
		transportId: (slack as { transportId?: string }).transportId ?? "slack",
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
		// On failure the reply is delivered as a file with a visible notice — never
		// a silent log entry with the thinking placeholder left behind.
		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				try {
					await postFinalReply(text, SLACK_SPLIT_CHARS);
				} catch (err) {
					log.logWarning("Slack replaceMessage error", err instanceof Error ? err.message : String(err));
					await deliverAsFileFallback(text, err);
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
