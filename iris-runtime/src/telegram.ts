import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import { TelegramBotRegistry } from "./telegram-bot-registry.js";
import { registerSessionRequest, resolveSessionRequest } from "./sessions.js";
import { resolveChannelDir, resolveChannelPath, type Attachment } from "./store.js";
import { callAgentBridge } from "./bridge.js";
import { readHistory, appendHistory, makeUserEntry, makeBotEntry } from "./azure-history.js";
import { type TelegramLinkManager } from "./telegram-link.js";
import { getSubAgent } from "./sub-agent-registry.js";
import { bridgePortForSlot, getAvailableSkills, provisionAgent, registerAgentBridge } from "./agent-provision.js";
import { createSubAgent, updateSubAgentStatus } from "./sub-agent-registry.js";

// ============================================================================
// Constants
// ============================================================================

const TG_MAX_CHARS = 4096;
const POLL_TIMEOUT = 30;
const USER_QUEUE_MAX = 5;
const SPAM_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const EVENT_QUEUE_HARD_CAP = 360;
const EVENT_QUEUE_DEFAULT = 50;

// ============================================================================
// Telegram API types
// ============================================================================

interface TgChat {
	id: number;
	type: string;
	title?: string;
	username?: string;
	first_name?: string;
}

interface TgUser {
	id: number;
	is_bot?: boolean;
	username?: string;
	first_name?: string;
	last_name?: string;
}

interface TgDocument {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

interface TgPhotoSize {
	file_id: string;
	width: number;
	height: number;
}

interface TgAudio {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

interface TgVoice {
	file_id: string;
	mime_type?: string;
}

interface TgVideo {
	file_id: string;
	file_name?: string;
	mime_type?: string;
}

interface TgMessage {
	message_id: number;
	date: number;
	chat: TgChat;
	from?: TgUser;
	message_thread_id?: number;
	text?: string;
	caption?: string;
	document?: TgDocument;
	photo?: TgPhotoSize[];
	audio?: TgAudio;
	voice?: TgVoice;
	video?: TgVideo;
}

interface TgUpdate {
	update_id: number;
	message?: TgMessage;
}

// ============================================================================
// Public types
// ============================================================================

export interface TelegramEvent {
	type: "message";
	channel: string;
	ts: string;
	user: string;
	text: string;
	chatId: number;
	threadId?: number;
	files?: Array<{ fileId: string; name: string; mimeType?: string }>;
	attachments?: Attachment[];
}

export interface TelegramContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		channel: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	channelName?: string;
	channels: Array<{ id: string; name: string }>;
	users: Array<{ id: string; userName: string; displayName: string }>;
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	getAccumulatedText: () => string;
}

// ============================================================================
// Cosine-similarity helpers (used for spam detection only)
// ============================================================================

const STOPWORDS = new Set([
	"a", "an", "the", "is", "it", "in", "on", "at", "to", "for", "of",
	"and", "or", "i", "me", "my", "this", "that", "with", "be", "do",
	"up", "by", "from", "can", "you", "we", "us", "am", "are", "was",
	"will", "would", "could", "should", "please", "just",
]);

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0, magA = 0, magB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		magA += a[i] * a[i];
		magB += b[i] * b[i];
	}
	if (magA === 0 || magB === 0) return 0;
	return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ============================================================================
// Agent creation detection — used to enforce the hard restriction
// ============================================================================

const CREATE_AGENT_REFERENCE_PHRASES = [
	"create an agent", "spawn an agent", "make an agent", "build an agent",
	"create agent for", "launch an agent", "i need an agent", "create a bot",
	"new agent", "spawn a new agent", "create new agent", "make me an agent",
];

function hasCreateAgentIntent(text: string): boolean {
	if (/\b(create|spawn|make|build|launch)\s+(a\s+|an\s+|me\s+a\s+|me\s+an\s+|new\s+)?(agent|bot)\b/i.test(text)) return true;
	if (/\bi\s+need\s+(a\s+|an\s+)?(agent|bot)\b/i.test(text)) return true;

	const inputTokens = tokenize(text);
	if (inputTokens.length === 0) return false;

	const vocabSet = new Set<string>();
	const refTokensList = CREATE_AGENT_REFERENCE_PHRASES.map((p) => {
		const t = tokenize(p);
		t.forEach((w) => vocabSet.add(w));
		return t;
	});
	inputTokens.forEach((w) => vocabSet.add(w));
	const vocab = Array.from(vocabSet);
	const toVec = (tokens: string[]): number[] => vocab.map((w) => (tokens.includes(w) ? 1 : 0));
	const inputVec = toVec(inputTokens);
	for (const refTokens of refTokensList) {
		if (cosineSimilarity(inputVec, toVec(refTokens)) >= 0.35) return true;
	}
	return false;
}

// ============================================================================
// Per-channel queue
// ============================================================================

type QueuedWork = () => Promise<void>;
type EnqueueUserResult = "queued" | "spam" | "full";

function getEventQueueMax(): number {
	const raw = parseInt(process.env.TG_EVENT_QUEUE_MAX ?? "", 10);
	if (isNaN(raw) || raw <= 0) return EVENT_QUEUE_DEFAULT;
	return Math.min(raw, EVENT_QUEUE_HARD_CAP);
}

class ChannelQueues {
	private userQueue: QueuedWork[] = [];
	private eventQueue: QueuedWork[] = [];
	private userProcessing = false;
	private eventProcessing = false;
	private spamCooldownUntil = 0;
	private readonly eventQueueMax: number;
	private lastUserMessages: string[] = [];

	constructor() {
		this.eventQueueMax = getEventQueueMax();
	}

	isSpamCooldownActive(): boolean { return Date.now() < this.spamCooldownUntil; }
	getRemainingCooldownMs(): number { return Math.max(0, this.spamCooldownUntil - Date.now()); }

	private activateCooldown(): void {
		this.spamCooldownUntil = Date.now() + SPAM_COOLDOWN_MS;
		log.logWarning("[telegram] Spam cooldown activated — 2 minutes");
	}

	private isSimilarToRecent(text: string): boolean {
		if (this.lastUserMessages.length < 2) return false;
		const inputTokens = tokenize(text);
		if (inputTokens.length === 0) return false;
		const allTokens = [...inputTokens];
		const recentTokensList = this.lastUserMessages.map((m) => {
			const t = tokenize(m);
			t.forEach((w) => allTokens.push(w));
			return t;
		});
		const vocab = [...new Set(allTokens)];
		const toVec = (tokens: string[]): number[] => vocab.map((w) => (tokens.includes(w) ? 1 : 0));
		const inputVec = toVec(inputTokens);
		return recentTokensList.every((rt) => cosineSimilarity(inputVec, toVec(rt)) >= 0.35);
	}

	userSize(): number { return this.userQueue.length; }
	eventSize(): number { return this.eventQueue.length; }

	enqueueUser(work: QueuedWork, text = ""): EnqueueUserResult {
		if (this.isSpamCooldownActive()) return "spam";
		if (text && this.isSimilarToRecent(text)) {
			this.activateCooldown();
			return "spam";
		}
		if (text) {
			this.lastUserMessages.unshift(text);
			if (this.lastUserMessages.length > 2) this.lastUserMessages.pop();
		}
		if (this.userQueue.length >= USER_QUEUE_MAX) {
			this.activateCooldown();
			return "spam";
		}
		this.userQueue.push(work);
		void this.processNextUser();
		return "queued";
	}

	enqueueEvent(work: QueuedWork): boolean {
		if (this.eventQueue.length >= this.eventQueueMax) return false;
		this.eventQueue.push(work);
		void this.processNextEvent();
		return true;
	}

	drain(): void {
		this.userQueue = [];
		this.eventQueue = [];
		this.spamCooldownUntil = 0;
	}

	private async processNextUser(): Promise<void> {
		if (this.userProcessing || this.userQueue.length === 0) return;
		this.userProcessing = true;
		const work = this.userQueue.shift()!;
		try { await work(); } catch (err) {
			log.logWarning("User queue error", err instanceof Error ? err.message : String(err));
		}
		this.userProcessing = false;
		void this.processNextUser();
	}

	private async processNextEvent(): Promise<void> {
		if (this.eventProcessing || this.eventQueue.length === 0) return;
		this.eventProcessing = true;
		const work = this.eventQueue.shift()!;
		try { await work(); } catch (err) {
			log.logWarning("Event queue error", err instanceof Error ? err.message : String(err));
		}
		this.eventProcessing = false;
		void this.processNextEvent();
	}
}

// ============================================================================
// Markdown → Telegram HTML
// ============================================================================

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toTelegramHtml(text: string): string {
	text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code: string) =>
		`<pre><code>${escapeHtml(code.trim())}</code></pre>`,
	);
	text = text.replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${escapeHtml(code)}</code>`);
	text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
	text = text.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");
	return text;
}

function splitIntoChunks(text: string, maxChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= maxChars) { chunks.push(remaining); break; }
		const searchFrom = Math.floor(maxChars * 0.8);
		const newlineIdx = remaining.lastIndexOf("\n", maxChars);
		const cut = newlineIdx >= searchFrom ? newlineIdx + 1 : maxChars;
		chunks.push(remaining.slice(0, cut).trimEnd());
		remaining = remaining.slice(cut).trimStart();
	}
	return chunks;
}

// ============================================================================
// Pending skill install state — confirmation dialog
// ============================================================================

interface PendingSkillInstall {
	originalText: string;
	skillName: string;
}

// ============================================================================
// Pending agent-creation rejection — two options dialog
// ============================================================================

interface PendingCreationRejection {
	originalText: string;
}

// ============================================================================
// TelegramBot
// ============================================================================

export class TelegramBot {
	private token: string;
	private workingDir: string;
	private linkManager: TelegramLinkManager;
	private irisApiUrl: string;
	private queues = new Map<string, ChannelQueues>();
	private running = false;
	private offset = 0;
	private chatNames = new Map<string, string>();
	private botName: string | undefined;
	private botId: string | undefined;
	private registry: TelegramBotRegistry;
	private skillsDir: string;
	// Per-channel pending dialog states
	private pendingSkillInstalls = new Map<string, PendingSkillInstall>();
	private pendingCreationRejections = new Map<string, PendingCreationRejection>();
	private cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(config: {
		token: string;
		workingDir: string;
		linkManager: TelegramLinkManager;
		irisApiUrl?: string;
	}) {
		this.token = config.token;
		this.workingDir = config.workingDir;
		this.linkManager = config.linkManager;
		this.irisApiUrl = config.irisApiUrl ?? process.env.IRIS_API_URL ?? "http://172.18.0.1:3000";
		this.registry = new TelegramBotRegistry(config.workingDir);
		this.skillsDir = process.env.IRIS_SKILLS_DIR
			?? `${process.env.IRIS_DIR ?? "/iris"}/data/skills`;
	}

	// ==========================================================================
	// Bot API helpers
	// ==========================================================================

	private apiUrl(method: string): string {
		return `https://api.telegram.org/bot${this.token}/${method}`;
	}

	private async call(method: string, body?: Record<string, unknown>): Promise<unknown> {
		const response = await fetch(this.apiUrl(method), {
			method: body ? "POST" : "GET",
			headers: body ? { "Content-Type": "application/json" } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		const json = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
		if (!json.ok) throw new Error(`Telegram API ${method} failed: ${json.description ?? "unknown"}`);
		return json.result;
	}

	// ==========================================================================
	// Channel ID encoding
	// ==========================================================================

	private encodeChannel(chatId: number, threadId?: number): string {
		const chatStr = chatId < 0 ? `n${Math.abs(chatId)}` : String(chatId);
		return threadId ? `tg-${chatStr}-${threadId}` : `tg-${chatStr}`;
	}

	private decodeChannel(channelId: string): { chatId: number; threadId?: number } {
		const rest = channelId.slice(3);
		const dashIdx = rest.lastIndexOf("-");
		const hasTwoSegments = dashIdx > 0 && /^\d+$/.test(rest.slice(dashIdx + 1));
		const chatStr = hasTwoSegments ? rest.slice(0, dashIdx) : rest;
		const threadId = hasTwoSegments ? parseInt(rest.slice(dashIdx + 1), 10) : undefined;
		const chatId = chatStr.startsWith("n") ? -parseInt(chatStr.slice(1), 10) : parseInt(chatStr, 10);
		return { chatId, threadId };
	}

	// ==========================================================================
	// Public messaging API
	// ==========================================================================

	async postMessage(channelId: string, text: string): Promise<string> {
		const { chatId, threadId } = this.decodeChannel(channelId);
		const html = toTelegramHtml(text);
		const chunks = splitIntoChunks(html, TG_MAX_CHARS);
		const result = (await this.call("sendMessage", {
			chat_id: chatId,
			text: chunks[0],
			parse_mode: "HTML",
			...(threadId !== undefined ? { message_thread_id: threadId } : {}),
		})) as { message_id: number };
		for (let i = 1; i < chunks.length; i++) {
			await this.call("sendMessage", {
				chat_id: chatId,
				text: chunks[i],
				parse_mode: "HTML",
				...(threadId !== undefined ? { message_thread_id: threadId } : {}),
			});
		}
		return String(result.message_id);
	}

	async updateMessage(channelId: string, messageId: string, text: string): Promise<void> {
		const { chatId } = this.decodeChannel(channelId);
		const html = toTelegramHtml(text);
		try {
			await this.call("editMessageText", {
				chat_id: chatId,
				message_id: parseInt(messageId, 10),
				text: html.slice(0, TG_MAX_CHARS),
				parse_mode: "HTML",
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("message is not modified")) {
				log.logWarning("[telegram] updateMessage failed", msg);
			}
		}
	}

	async finalizeMessage(channelId: string, messageId: string, text: string): Promise<void> {
		const { chatId, threadId } = this.decodeChannel(channelId);
		const html = toTelegramHtml(text);
		const chunks = splitIntoChunks(html, TG_MAX_CHARS);
		try {
			await this.call("editMessageText", {
				chat_id: chatId,
				message_id: parseInt(messageId, 10),
				text: chunks[0],
				parse_mode: "HTML",
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("message is not modified")) {
				log.logWarning("[telegram] finalizeMessage edit failed", msg);
			}
		}
		for (let i = 1; i < chunks.length; i++) {
			await this.call("sendMessage", {
				chat_id: chatId,
				text: chunks[i],
				parse_mode: "HTML",
				...(threadId !== undefined ? { message_thread_id: threadId } : {}),
			});
		}
	}

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		const { chatId } = this.decodeChannel(channelId);
		try {
			await this.call("deleteMessage", { chat_id: chatId, message_id: parseInt(messageId, 10) });
		} catch (err) {
			log.logWarning("[telegram] deleteMessage failed", err instanceof Error ? err.message : String(err));
		}
	}

	async postInThread(channelId: string, _replyToId: string, text: string): Promise<string> {
		return this.postMessage(channelId, text);
	}

	async uploadFile(channelId: string, filePath: string, title?: string): Promise<void> {
		const { chatId, threadId } = this.decodeChannel(channelId);
		const fileName = title ?? basename(filePath);
		const fileBuffer = readFileSync(filePath);
		const blob = new Blob([fileBuffer]);
		const formData = new FormData();
		formData.append("chat_id", String(chatId));
		if (threadId !== undefined) formData.append("message_thread_id", String(threadId));
		formData.append("document", blob, fileName);
		const response = await fetch(this.apiUrl("sendDocument"), { method: "POST", body: formData });
		const json = (await response.json()) as { ok: boolean; description?: string };
		if (!json.ok) log.logWarning("[telegram] uploadFile failed", json.description ?? "unknown");
	}

	// ==========================================================================
	// File download
	// ==========================================================================

	async downloadFile(fileId: string, channelId: string, fileName: string, messageId: string): Promise<Attachment | null> {
		try {
			const fileInfo = (await this.call("getFile", { file_id: fileId })) as { file_path?: string };
			if (!fileInfo.file_path) return null;

			const url = `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;
			const response = await fetch(url);
			if (!response.ok) return null;

			const dir = join(resolveChannelDir(this.workingDir, channelId), "attachments");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

			const localFileName = `msg${messageId}_${fileName}`;
			const localRelPath = `${resolveChannelPath(channelId)}/attachments/${localFileName}`;
			const absPath = join(this.workingDir, localRelPath);

			const buffer = await response.arrayBuffer();
			writeFileSync(absPath, Buffer.from(buffer));
			return { original: fileName, local: localRelPath };
		} catch (err) {
			log.logWarning("[telegram] downloadFile failed", err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	// ==========================================================================
	// Logging
	// ==========================================================================

	logToFile(channelId: string, entry: object): void {
		const dir = resolveChannelDir(this.workingDir, channelId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify(entry)}\n`);
	}

	logBotResponse(channelId: string, text: string, messageId: string): void {
		this.logToFile(channelId, {
			date: new Date().toISOString(),
			ts: messageId,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	// ==========================================================================
	// Context helpers
	// ==========================================================================

	getChatName(channelId: string): string | undefined { return this.chatNames.get(channelId); }
	getBotName(): string { return this.botName ?? "Bot"; }
	getBotId(): string { return this.botId ?? "unknown"; }
	getAllChats(): Array<{ id: string; name: string }> {
		return Array.from(this.chatNames.entries()).map(([id, name]) => ({ id, name }));
	}

	/** Returns true if this bot has seen activity on the given Telegram channel. */
	hasSeen(channelId: string): boolean { return this.chatNames.has(channelId); }

	// ==========================================================================
	// Session injection
	// ==========================================================================

	async injectSessionMessage(sessionId: string, user: string, text: string): Promise<string> {
		const channelId = `SESSION-${sessionId}`;
		const queue = this.getQueue(channelId);
		if (queue.userSize() >= 5) throw new Error("Session message queue is full");

		const ts = String(Date.now());
		this.logToFile(channelId, { date: new Date().toISOString(), ts, user, text, attachments: [], isBot: false });

		const responsePromise = registerSessionRequest(sessionId, 600_000);
		const event: TelegramEvent = { type: "message", channel: channelId, ts, user, text, chatId: 0, attachments: [] };
		queue.enqueueUser(() => this.routeEventToLinkedAgent(event));
		return responsePromise;
	}

	resetSessionContext(_sessionId: string): void {}

	// ==========================================================================
	// Events watcher integration
	// ==========================================================================

	hasPendingEvent(channelId: string): boolean {
		return (this.queues.get(channelId)?.eventSize() ?? 0) > 0;
	}

	enqueueEvent(event: TelegramEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.eventSize() >= EVENT_QUEUE_HARD_CAP) {
			log.logWarning(`[telegram:${this.botId}] Event queue full for ${event.channel}`);
			return false;
		}
		log.logInfo(`[telegram:${this.botId}] Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		return queue.enqueueEvent(() => this.routeEventToLinkedAgent(event));
	}

	drainQueue(channelId: string): void { this.queues.get(channelId)?.drain(); }

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	async start(): Promise<void> {
		this.running = true;
		const me = (await this.call("getMe")) as { id: number; username?: string; first_name?: string };
		this.botId = String(me.id);
		this.botName = me.first_name ?? me.username ?? "Bot";

		const allowed = this.registry.register(this.botId, me.username ?? this.botName);
		if (!allowed) {
			this.running = false;
			throw new Error(`[telegram] Bot @${me.username} (id=${this.botId}) rejected: max 5 bots reached`);
		}

		// Register this bot in Supabase link table
		await this.linkManager.registerBot(this.botId);

		log.logInfo(`[telegram:${this.botId}] Connected as @${me.username ?? me.first_name ?? "unknown"}`);
		log.logConnected();
		await this.registerCommands();
		void this.poll();
	}

	stop(): void { this.running = false; }

	// ==========================================================================
	// Watchdog integration
	// ==========================================================================

	/**
	 * Called by the watchdog when the linked agent's container crashes.
	 * Notifies all active chats that were recently using this bot.
	 */
	notifyLinkedAgentCrashed(agentId: string): void {
		// Invalidate cache so the next message re-checks the link status
		if (this.botId) this.linkManager.invalidateCache(this.botId);

		// Notify all recently active chats on this bot
		for (const [channelId] of this.chatNames) {
			if (channelId.startsWith("tg-")) {
				void this.postMessage(
					channelId,
					`⚠️ The linked agent (${agentId.slice(0, 8)}…) has gone offline.\n\n` +
					`Tasks are paused. It will recover automatically on restart.`,
				).catch(() => {});
			}
		}
	}

	// ==========================================================================
	// Command registration
	// ==========================================================================

	private async registerCommands(): Promise<void> {
		try {
			await this.call("setMyCommands", {
				commands: [
					{ command: "stop",    description: "Stop the current running task" },
					{ command: "reset",   description: "Stop all tasks and clear queue" },
					{ command: "compact", description: "Summarise context to free up space" },
					{ command: "status",  description: "Show linked agent information" },
					{ command: "skills",  description: "List available skills for this agent" },
					{ command: "unlink",  description: "Disconnect Telegram from the linked agent" },
				],
			});
			log.logInfo(`[telegram:${this.botId}] Commands registered`);
		} catch (err) {
			log.logWarning(`[telegram:${this.botId}] Failed to register commands`, err instanceof Error ? err.message : String(err));
		}
	}

	// ==========================================================================
	// Private — queue
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueues {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueues();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	// ==========================================================================
	// Private — long poll loop
	// ==========================================================================

	private async poll(): Promise<void> {
		while (this.running) {
			try {
				const updates = (await this.call("getUpdates", {
					offset: this.offset,
					timeout: POLL_TIMEOUT,
					allowed_updates: ["message"],
				})) as TgUpdate[];

				for (const update of updates) {
					this.offset = update.update_id + 1;
					try {
						await this.handleUpdate(update);
					} catch (err) {
						log.logWarning(`[telegram:${this.botId}] handleUpdate error`, err instanceof Error ? err.message : String(err));
					}
				}
			} catch (err) {
				if (this.running) {
					log.logWarning(`[telegram:${this.botId}] Poll error — retrying in 5s`, err instanceof Error ? err.message : String(err));
					await new Promise((r) => setTimeout(r, 5000));
				}
			}
		}
	}

	// ==========================================================================
	// Private — incoming message handling
	// ==========================================================================

	private async handleUpdate(update: TgUpdate): Promise<void> {
		const msg = update.message;
		if (!msg) return;
		if (msg.from?.is_bot) return;

		const chatId  = msg.chat.id;
		const threadId = msg.message_thread_id;
		const channelId = this.encodeChannel(chatId, threadId);

		const chatName =
			msg.chat.title ??
			(msg.chat.username ? `@${msg.chat.username}` : null) ??
			msg.chat.first_name ??
			String(chatId);
		this.chatNames.set(channelId, chatName);

		const text = (msg.text ?? msg.caption ?? "").trim();

		// Check link status
		const linkedAgent = await this.linkManager.getLinkedAgent(this.botId!);

		// ── Unlinked state — only accept claim tokens ──────────────────────────
		if (!linkedAgent) {
			if (!text) return;

			// A valid claim token is 64 lowercase hex chars
			if (/^[0-9a-f]{64}$/.test(text)) {
				const result = await this.linkManager.validateAndLink(this.botId!, text);
				if (result && typeof result === "object") {
					await this.postMessage(
						channelId,
						`✅ <b>Linked to ${result.agentName}.</b>\n\n` +
						`This bot now represents that sub-agent. Start messaging to interact with it.`,
					);
					log.logInfo(`[telegram:${this.botId}] Linked to agent "${result.agentName}" via claim token`);
				} else if (result === "expired") {
					await this.postMessage(channelId, "❌ Token expired. Generate a new one via <b>Connect Telegram</b> on the sub-agent.");
				} else if (result === "already_linked") {
					await this.postMessage(channelId, "⚠️ This bot or that agent is already linked to another bot/agent. Unlink first.");
				} else {
					await this.postMessage(
						channelId,
						`⚠️ Invalid token.\n\n` +
						`This bot is not linked to any sub-agent yet.\n\n` +
						`To link it:\n` +
						`1. Create a sub-agent in Iris\n` +
						`2. Click <b>Connect Telegram</b> on the sub-agent\n` +
						`3. Send the generated token here`,
					);
				}
			} else {
				await this.postMessage(
					channelId,
					`This bot is not linked to any sub-agent yet.\n\n` +
					`To link it:\n` +
					`1. Create a sub-agent in Iris\n` +
					`2. Click <b>Connect Telegram</b> on the sub-agent\n` +
					`3. Send the generated token here`,
				);
			}
			return;
		}

		// ── Commands ───────────────────────────────────────────────────────────
		if (text.startsWith("/")) {
			const cmd = text.split(/\s/)[0].toLowerCase().replace(/@[^@]*$/, "");
			const rest = text.slice(cmd.length).trim();

			if (cmd === "/stop") {
				this.drainQueue(channelId);
				await this.postMessage(channelId, "_Current tasks stopped and queue cleared._");
				return;
			}
			if (cmd === "/reset") {
				this.drainQueue(channelId);
				this.pendingSkillInstalls.delete(channelId);
				this.pendingCreationRejections.delete(channelId);
				await this.postMessage(channelId, "_Queue cleared. Send a new message to start fresh._");
				return;
			}
			if (cmd === "/compact") {
				await this.postMessage(channelId, "_Context compaction is managed automatically by the linked agent._");
				return;
			}
			if (cmd === "/status") {
				await this.handleStatus(channelId, linkedAgent.agentName, linkedAgent.skills);
				return;
			}
			if (cmd === "/skills") {
				await this.handleSkillsList(channelId, linkedAgent.agentId, linkedAgent.skills);
				return;
			}
			if (cmd === "/install" && rest) {
				await this.startSkillInstall(channelId, rest, linkedAgent.agentId, linkedAgent.skills);
				return;
			}
			if (cmd === "/unlink") {
				await this.handleUnlink(channelId);
				return;
			}
			// Unknown commands fall through as regular messages
		}

		// ── Pending skill install confirmation ─────────────────────────────────
		const pendingInstall = this.pendingSkillInstalls.get(channelId);
		if (pendingInstall && !text.startsWith("/")) {
			await this.handleSkillInstallReply(channelId, text, pendingInstall, linkedAgent.agentId);
			return;
		}

		// ── Pending agent-creation rejection dialog ────────────────────────────
		const pendingRejection = this.pendingCreationRejections.get(channelId);
		if (pendingRejection && !text.startsWith("/")) {
			await this.handleCreationRejectionReply(channelId, text, pendingRejection);
			return;
		}

		// ── Spam cooldown ──────────────────────────────────────────────────────
		const queue = this.getQueue(channelId);
		if (queue.isSpamCooldownActive()) {
			const remainingSec = Math.ceil(queue.getRemainingCooldownMs() / 1000);
			log.logInfo(`[telegram:${this.botId}] Spam cooldown active for ${channelId} — ${remainingSec}s remaining`);
			await this.postMessage(channelId, `⏳ Slow down — cooldown active. Try again in <b>${remainingSec}s</b>.`);
			if (!this.cooldownTimers.has(channelId)) {
				const tid = setTimeout(async () => {
					this.cooldownTimers.delete(channelId);
					await this.postMessage(channelId, "✅ Cooldown lifted. You can start prompting again.");
				}, queue.getRemainingCooldownMs() + 500);
				this.cooldownTimers.set(channelId, tid);
			}
			return;
		}

		// ── Agent creation restriction ─────────────────────────────────────────
		if (text && hasCreateAgentIntent(text) && /\b(agent|bot)\b/i.test(text)) {
			await this.postMessage(
				channelId,
				`<b>Agent creation is not available here.</b>\n\n` +
				`Sub-agents cannot create other agents — this is a platform restriction.\n\n` +
				`Reply <b>1</b> to continue with an alternative workflow, or <b>2</b> to cancel.`,
			);
			this.pendingCreationRejections.set(channelId, { originalText: text });
			return;
		}

		// ── Build file list ────────────────────────────────────────────────────
		const files: TelegramEvent["files"] = [];
		if (msg.document) files.push({ fileId: msg.document.file_id, name: msg.document.file_name ?? "file", mimeType: msg.document.mime_type });
		if (msg.photo) {
			const largest = msg.photo[msg.photo.length - 1];
			files.push({ fileId: largest.file_id, name: "photo.jpg", mimeType: "image/jpeg" });
		}
		if (msg.audio) files.push({ fileId: msg.audio.file_id, name: msg.audio.file_name ?? "audio.mp3", mimeType: msg.audio.mime_type });
		if (msg.voice) files.push({ fileId: msg.voice.file_id, name: "voice.ogg", mimeType: msg.voice.mime_type ?? "audio/ogg" });
		if (msg.video) files.push({ fileId: msg.video.file_id, name: msg.video.file_name ?? "video.mp4", mimeType: msg.video.mime_type });

		if (!text && files.length === 0) return;

		// Download attachments
		const attachments: Attachment[] = [];
		for (const file of files) {
			const att = await this.downloadFile(file.fileId, channelId, file.name, String(msg.message_id));
			if (att) attachments.push(att);
		}

		const userName = msg.from?.username;
		const displayName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || undefined;
		const userId = String(msg.from?.id ?? "unknown");

		this.logToFile(channelId, {
			date: new Date(msg.date * 1000).toISOString(),
			ts: String(msg.message_id),
			user: userId,
			userName,
			displayName,
			text,
			attachments,
			isBot: false,
		});

		// ── Detect explicit skill install request ──────────────────────────────
		const skillRequestMatch = text.match(
			/\b(?:add|install|enable|give me(?: the)?|i need(?: the)?)\s+([\w-]+)\s*(?:skill|capability|plugin)?\b/i,
		);
		if (skillRequestMatch) {
			const requestedSkill = skillRequestMatch[1].toLowerCase();
			const available = getAvailableSkills(this.skillsDir);
			if (available.includes(requestedSkill) && !linkedAgent.skills.includes(requestedSkill)) {
				await this.startSkillInstall(channelId, requestedSkill, linkedAgent.agentId, linkedAgent.skills);
				return;
			}
		}

		// ── Route to linked sub-agent ──────────────────────────────────────────
		const event: TelegramEvent = {
			type: "message",
			channel: channelId,
			ts: String(msg.message_id),
			user: userId,
			text,
			chatId,
			threadId,
			files,
			attachments,
		};

		const result = queue.enqueueUser(
			() => this.routeUserMessageToAgent(event, linkedAgent.agentName, linkedAgent.bridgeUrl, linkedAgent.agentId),
			text,
		);

		if (result === "spam") {
			const remainingSec = Math.ceil(queue.getRemainingCooldownMs() / 1000);
			await this.postMessage(channelId, `⏳ Slow down — cooldown active. Try again in <b>${remainingSec}s</b>.`);
		}
	}

	// ==========================================================================
	// Private — route a user message to the linked sub-agent
	// ==========================================================================

	private async routeUserMessageToAgent(
		event: TelegramEvent,
		agentName: string,
		bridgeUrl: string,
		agentId?: string,
	): Promise<void> {
		log.logInfo(`[telegram:${this.botId}] Routing to agent "${agentName}" (${event.channel}): ${event.text.substring(0, 60)}`);

		// Read conversation history from Azure Blob Storage so the sub-agent
		// has full context for this Telegram channel across all previous exchanges.
		const history = agentId
			? await readHistory(agentId, "telegram", event.channel)
			: [];

		const typingId = await this.postMessage(event.channel, `_Thinking..._`).catch(() => null);

		try {
			const response = await callAgentBridge(
				bridgeUrl, event.text, event.user ?? "user",
				310_000, event.channel, history,
			);

			// Strip "[AgentName]:" prefix agents may prepend
			const stripped = response.startsWith(`[${agentName}]`)
				? response.slice(`[${agentName}]`.length).replace(/^:\s*/, "")
				: response;

			if (typingId) {
				await this.finalizeMessage(event.channel, typingId, stripped);
			} else {
				await this.postMessage(event.channel, stripped);
			}

			this.logBotResponse(event.channel, stripped, typingId ?? String(Date.now()));

			// Persist this exchange to Azure Blob Storage (non-blocking)
			if (agentId) {
				void appendHistory(agentId, "telegram", event.channel, [
					makeUserEntry(event.user ?? "user", event.text),
					makeBotEntry(stripped),
				]);
			}

			// Resolve SESSION- requests
			if (event.channel.startsWith("SESSION-")) {
				const sessionId = event.channel.slice("SESSION-".length);
				resolveSessionRequest(sessionId, stripped);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[telegram:${this.botId}] Bridge routing failed`, msg);
			const errMsg = `⚠️ <b>${agentName}</b> is not responding.\n\n<code>${msg}</code>`;
			if (typingId) {
				await this.finalizeMessage(event.channel, typingId, errMsg).catch(() => {});
			} else {
				await this.postMessage(event.channel, errMsg).catch(() => {});
			}
		}
	}

	// ==========================================================================
	// Private — route a scheduled event to the linked sub-agent
	// ==========================================================================

	private async routeEventToLinkedAgent(event: TelegramEvent): Promise<void> {
		if (!this.botId) return;
		const linked = await this.linkManager.getLinkedAgent(this.botId);
		if (!linked) {
			log.logWarning(`[telegram:${this.botId}] Scheduled event received but bot not linked to any agent`);
			return;
		}
		log.logInfo(`[telegram:${this.botId}] Routing scheduled event to agent "${linked.agentName}": ${event.text.substring(0, 60)}`);
		try {
			const response = await callAgentBridge(linked.bridgeUrl, event.text, "EVENT");
			const stripped = response.startsWith(`[${linked.agentName}]`)
				? response.slice(`[${linked.agentName}]`.length).replace(/^:\s*/, "")
				: response;
			await this.postMessage(event.channel, stripped);

			if (event.channel.startsWith("SESSION-")) {
				const sessionId = event.channel.slice("SESSION-".length);
				resolveSessionRequest(sessionId, stripped);
			}
		} catch (err) {
			log.logWarning(`[telegram:${this.botId}] Event routing failed`, String(err));
		}
	}

	// ==========================================================================
	// Private — /status command
	// ==========================================================================

	private async handleStatus(channelId: string, agentName: string, skills: string[]): Promise<void> {
		const skillList = skills.length > 0 ? skills.join(", ") : "general-purpose (no specific skills)";
		await this.postMessage(
			channelId,
			`🤖 <b>Linked agent:</b> ${agentName}\n\n` +
			`<b>Skills:</b> <i>${skillList}</i>\n\n` +
			`Use /skills to see available skills, or /install &lt;skill&gt; to add one.`,
		);
	}

	// ==========================================================================
	// Private — /skills command
	// ==========================================================================

	private async handleSkillsList(channelId: string, agentId: string, currentSkills: string[]): Promise<void> {
		const available = getAvailableSkills(this.skillsDir);
		const notInstalled = available.filter((s) => !currentSkills.includes(s));

		const currentList = currentSkills.length > 0
			? currentSkills.map((s) => `  ✅ ${s}`).join("\n")
			: "  (none — general-purpose)";

		const availableList = notInstalled.length > 0
			? notInstalled.map((s) => `  ➕ ${s}`).join("\n")
			: "  (none — all available skills are already installed)";

		await this.postMessage(
			channelId,
			`<b>Current skills:</b>\n${currentList}\n\n` +
			`<b>Available to install:</b>\n${availableList}\n\n` +
			`Use <code>/install &lt;skill-name&gt;</code> to add a skill.`,
		);
	}

	// ==========================================================================
	// Private — skill acquisition flow
	// ==========================================================================

	private async startSkillInstall(
		channelId: string,
		skillName: string,
		agentId: string,
		currentSkills: string[],
	): Promise<void> {
		const available = getAvailableSkills(this.skillsDir);

		if (!available.includes(skillName)) {
			await this.postMessage(
				channelId,
				`⚠️ Skill <b>${skillName}</b> is not available on this server.\n\n` +
				`Available skills: ${available.join(", ")}`,
			);
			return;
		}

		if (currentSkills.includes(skillName)) {
			await this.postMessage(channelId, `✅ The <b>${skillName}</b> skill is already installed for this agent.`);
			return;
		}

		await this.postMessage(
			channelId,
			`I do not currently have the required skill to perform this task.\n\n` +
			`<b>Skill to install:</b> ${skillName}\n\n` +
			`<b>1.</b> Add required skill and continue\n` +
			`<b>2.</b> Cancel`,
		);
		this.pendingSkillInstalls.set(channelId, { originalText: "", skillName });
	}

	private async handleSkillInstallReply(
		channelId: string,
		reply: string,
		state: PendingSkillInstall,
		agentId: string,
	): Promise<void> {
		const trimmed = reply.trim();

		if (trimmed === "2") {
			this.pendingSkillInstalls.delete(channelId);
			await this.postMessage(channelId, "Cancelled. No skills were installed.");
			return;
		}

		if (trimmed !== "1") {
			await this.postMessage(channelId, "Please reply with <b>1</b> to install the skill or <b>2</b> to cancel.");
			return;
		}

		this.pendingSkillInstalls.delete(channelId);

		// Call Iris API to install the skill on the sub-agent
		try {
			const installResp = await fetch(`${this.irisApiUrl}/agents/${agentId}/skills`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ add: [state.skillName] }),
			});
			if (!installResp.ok) throw new Error(`API returned ${installResp.status}`);

			// Invalidate cache so next message gets updated skill list
			if (this.botId) this.linkManager.invalidateCache(this.botId);

			await this.postMessage(channelId, `✅ <b>${state.skillName}</b> has been added to this agent's runtime.\n\nBoth this Telegram interface and the Sub-Agent UI now have access to it.`);

			// Re-execute original task if present
			if (state.originalText) {
				const linked = await this.linkManager.getLinkedAgent(this.botId!);
				if (linked) {
					const event: TelegramEvent = { type: "message", channel: channelId, ts: String(Date.now()), user: "user", text: state.originalText, chatId: 0, attachments: [] };
					const queue = this.getQueue(channelId);
					queue.enqueueUser(() => this.routeUserMessageToAgent(event, linked.agentName, linked.bridgeUrl, linked.agentId), state.originalText);
				}
			}
		} catch (err) {
			await this.postMessage(channelId, `⚠️ Failed to install skill: ${String(err)}`);
		}
	}

	// ==========================================================================
	// Private — agent creation rejection dialog
	// ==========================================================================

	private async handleCreationRejectionReply(
		channelId: string,
		reply: string,
		state: PendingCreationRejection,
	): Promise<void> {
		const trimmed = reply.trim();
		this.pendingCreationRejections.delete(channelId);

		if (trimmed === "1") {
			// Re-route the original message to the sub-agent as a regular request
			const linked = await this.linkManager.getLinkedAgent(this.botId!);
			if (!linked) { await this.postMessage(channelId, "⚠️ No linked agent found."); return; }
			await this.postMessage(channelId, "_Continuing with alternative workflow..._");
			const event: TelegramEvent = { type: "message", channel: channelId, ts: String(Date.now()), user: "user", text: state.originalText, chatId: 0, attachments: [] };
			await this.routeUserMessageToAgent(event, linked.agentName, linked.bridgeUrl, linked.agentId);
		} else {
			await this.postMessage(channelId, "Cancelled.");
		}
	}

	// ==========================================================================
	// Private — /unlink command
	// ==========================================================================

	private async handleUnlink(channelId: string): Promise<void> {
		if (!this.botId) return;
		const linked = await this.linkManager.getLinkedAgent(this.botId);
		if (!linked) {
			await this.postMessage(channelId, "This bot is not linked to any agent.");
			return;
		}
		const success = await this.linkManager.unlink(this.botId);
		if (success) {
			await this.postMessage(
				channelId,
				`🔓 Disconnected from <b>${linked.agentName}</b>.\n\n` +
				`This bot is now unlinked. Send a new claim token to link it to a sub-agent again.`,
			);
			log.logInfo(`[telegram:${this.botId}] Unlinked from agent "${linked.agentName}" by user command`);
		} else {
			await this.postMessage(channelId, "⚠️ Failed to unlink. Check Supabase connection.");
		}
	}
}
