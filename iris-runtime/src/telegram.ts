import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import { TelegramBotRegistry } from "./telegram-bot-registry.js";
import { registerSessionRequest, resolveSessionRequest } from "./sessions.js";
import { resolveChannelDir, resolveChannelPath, type Attachment } from "./store.js";
import { TelegramClaimManager } from "./telegram-claim.js";

// ============================================================================
// Constants
// ============================================================================

const TG_MAX_CHARS = 4096;
const POLL_TIMEOUT = 30;
const USER_QUEUE_MAX = 5;
const SPAM_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
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

export interface IrisTelegramHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: TelegramEvent, bot: TelegramBot, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, bot: TelegramBot): Promise<void>;
	handleCompact(channelId: string, bot: TelegramBot): Promise<void>;
	handleReset(channelId: string, bot: TelegramBot): Promise<void>;
}

// ============================================================================
// Scheduling intent — cosine similarity engine
// ============================================================================

const SCHEDULE_THRESHOLD = 0.35;

const SCHEDULE_REFERENCE_PHRASES = [
	"schedule a task for me",
	"set up a reminder",
	"remind me every day",
	"run this every morning",
	"create a periodic task",
	"set up recurring job",
	"schedule this weekly",
	"remind me at 9am daily",
	"run this on a schedule",
	"create an interval event",
	"set a cron job",
	"daily reminder",
	"weekly task",
	"schedule every hour",
	"send me update every day",
	"check this every morning",
	"repeat this task",
	"recurring reminder",
	"automate this task",
	"run automatically",
];

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

function hasSchedulingIntent(text: string): boolean {
	const inputTokens = tokenize(text);
	if (inputTokens.length === 0) return false;

	// Build vocabulary from all reference phrases + input
	const vocabSet = new Set<string>();
	const refTokensList = SCHEDULE_REFERENCE_PHRASES.map((p) => {
		const t = tokenize(p);
		t.forEach((w) => vocabSet.add(w));
		return t;
	});
	inputTokens.forEach((w) => vocabSet.add(w));
	const vocab = Array.from(vocabSet);

	const toVec = (tokens: string[]): number[] =>
		vocab.map((w) => (tokens.includes(w) ? 1 : 0));

	const inputVec = toVec(inputTokens);

	for (const refTokens of refTokensList) {
		const sim = cosineSimilarity(inputVec, toVec(refTokens));
		if (sim >= SCHEDULE_THRESHOLD) return true;
	}
	return false;
}

// ============================================================================
// Per-channel queue
// ============================================================================
// userQueue and eventQueue are fully independent — events never block user
// messages and vice versa. Spam cooldown is tracked per channel.
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

	constructor() {
		this.eventQueueMax = getEventQueueMax();
	}

	// -- Spam cooldown --------------------------------------------------------

	isSpamCooldownActive(): boolean {
		return Date.now() < this.spamCooldownUntil;
	}

	// -- User queue -----------------------------------------------------------

	userSize(): number { return this.userQueue.length; }

	enqueueUser(work: QueuedWork): EnqueueUserResult {
		if (this.isSpamCooldownActive()) return "spam";
		if (this.userQueue.length >= USER_QUEUE_MAX) {
			this.spamCooldownUntil = Date.now() + SPAM_COOLDOWN_MS;
			log.logWarning("[telegram] Spam cooldown activated — ignoring messages for 5 minutes");
			return "spam";
		}
		this.userQueue.push(work);
		void this.processNextUser();
		return "queued";
	}

	// -- Event queue ----------------------------------------------------------

	eventSize(): number { return this.eventQueue.length; }

	enqueueEvent(work: QueuedWork): boolean {
		if (this.eventQueue.length >= this.eventQueueMax) return false;
		this.eventQueue.push(work);
		void this.processNextEvent();
		return true;
	}

	// -- Drain (used by /reset) -----------------------------------------------

	drain(): void {
		this.userQueue = [];
		this.eventQueue = [];
		this.spamCooldownUntil = 0;
	}

	// -- Private processing loops --------------------------------------------

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

// ============================================================================
// Chunk splitting
// ============================================================================

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
// Pending schedule choice — per channel state
// ============================================================================

interface ScheduleChoice {
	originalText: string;
	existingFiles: string[];  // absolute paths to existing event files for this channel
}

// ============================================================================
// TelegramBot
// ============================================================================

export class TelegramBot {
	private token: string;
	private handler: IrisTelegramHandler;
	private workingDir: string;
	private queues = new Map<string, ChannelQueues>();
	private running = false;
	private offset = 0;
	private chatNames = new Map<string, string>();
	private botName: string | undefined;
	private botId: string | undefined;
	private pendingScheduleChoices = new Map<string, ScheduleChoice>();
	// claim is a placeholder until start() resolves the real botId
	claim: TelegramClaimManager;
	private registry: TelegramBotRegistry;

	constructor(
		handler: IrisTelegramHandler,
		config: { token: string; workingDir: string },
	) {
		this.token = config.token;
		this.handler = handler;
		this.workingDir = config.workingDir;
		this.registry = new TelegramBotRegistry(config.workingDir);
		this.claim = new TelegramClaimManager(config.workingDir, "pending");
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

	getChatName(channelId: string): string | undefined {
		return this.chatNames.get(channelId);
	}

	getBotName(): string {
		return this.botName ?? "Iris";
	}

	getBotId(): string {
		return this.botId ?? "unknown";
	}

	getAllChats(): Array<{ id: string; name: string }> {
		return Array.from(this.chatNames.entries()).map(([id, name]) => ({ id, name }));
	}

	// ==========================================================================
	// Session injection
	// ==========================================================================

	async injectSessionMessage(sessionId: string, user: string, text: string): Promise<string> {
		const channelId = `SESSION-${sessionId}`;
		const queue = this.getQueue(channelId);

		if (queue.userSize() >= 5) throw new Error("Session message queue is full");

		const ts = String(Date.now());
		this.logToFile(channelId, {
			date: new Date().toISOString(),
			ts,
			user,
			text,
			attachments: [],
			isBot: false,
		});

		const responsePromise = registerSessionRequest(sessionId, 600_000);
		const event: TelegramEvent = {
			type: "message",
			channel: channelId,
			ts,
			user,
			text,
			chatId: 0,
			attachments: [],
		};
		queue.enqueueUser(() => this.handler.handleEvent(event, this));
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
		return queue.enqueueEvent(() => this.handler.handleEvent(event, this, true));
	}

	// Discard all pending items for a channel (used by /reset)
	drainQueue(channelId: string): void {
		this.queues.get(channelId)?.drain();
	}

	// ==========================================================================
	// Scheduled event conflict detection
	// ==========================================================================

	private findExistingEventFiles(channelId: string): string[] {
		const dirsToCheck = [
			join(this.workingDir, "telegram", "events"),
			join(this.workingDir, "events"),
		];
		const found: string[] = [];
		for (const dir of dirsToCheck) {
			if (!existsSync(dir)) continue;
			try {
				const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
				for (const f of files) {
					const fullPath = join(dir, f);
					try {
						const data = JSON.parse(readFileSync(fullPath, "utf-8")) as { channelId?: string; type?: string };
						// Only flag persistent events (periodic/interval) — not one-shot/immediate
						if (
							data.channelId === channelId &&
							(data.type === "periodic" || data.type === "interval")
						) {
							found.push(fullPath);
						}
					} catch { /* skip malformed */ }
				}
			} catch { /* skip unreadable dir */ }
		}
		return found;
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	async start(): Promise<void> {
		this.running = true;
		const me = (await this.call("getMe")) as { id: number; username?: string; first_name?: string };
		this.botId = String(me.id);
		this.botName = me.first_name ?? me.username ?? "Iris";

		// Re-initialise claim manager with the real botId so each bot has its own file
		this.claim = new TelegramClaimManager(this.workingDir, this.botId);

		// Check bot registry — enforces max 5 bots
		const allowed = this.registry.register(this.botId, me.username ?? this.botName);
		if (!allowed) {
			this.running = false;
			throw new Error(`[telegram] Bot @${me.username} (id=${this.botId}) rejected: max 5 bots reached`);
		}

		log.logInfo(`[telegram:${this.botId}] Connected as @${me.username ?? me.first_name ?? "unknown"}`);
		log.logConnected();
		await this.registerCommands();
		void this.poll();
	}

	stop(): void {
		this.running = false;
	}

	// ==========================================================================
	// Command registration — runs on every start() so any bot token gets it
	// ==========================================================================

	private async registerCommands(): Promise<void> {
		try {
			await this.call("setMyCommands", {
				commands: [
					{ command: "reset", description: "Stop all tasks, clear queue and context" },
					{ command: "stop", description: "Stop the current running task" },
					{ command: "compact", description: "Summarise context to free up space" },
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

		const chatId = msg.chat.id;
		const threadId = msg.message_thread_id;
		const channelId = this.encodeChannel(chatId, threadId);

		const chatName =
			msg.chat.title ??
			(msg.chat.username ? `@${msg.chat.username}` : null) ??
			msg.chat.first_name ??
			String(chatId);
		this.chatNames.set(channelId, chatName);

		const text = (msg.text ?? msg.caption ?? "").trim();

		// Claim gate
		if (!this.claim.isClaimed()) {
			const result = this.claim.tryClaimWith(chatId, text);
			if (result === "claimed") {
				log.logInfo(`[telegram:${this.botId}] Bot claimed by chat_id ${chatId}`);
				await this.postMessage(channelId, "✅ Bot claimed. You're all set — start chatting!");
			} else if (result === "expired") {
				await this.postMessage(channelId, "❌ Token expired. Restart Iris to get a new one.");
			}
			return;
		}

		if (!this.claim.isOwner(chatId)) return;

		// Spam cooldown — silently drop everything during cooldown
		const queue = this.getQueue(channelId);
		if (queue.isSpamCooldownActive()) {
			log.logInfo(`[telegram:${this.botId}] Spam cooldown active for ${channelId} — dropping message`);
			return;
		}

		// Bot commands — handled directly, bypass all queues
		if (text.startsWith("/")) {
			const cmd = text.split(/\s/)[0].toLowerCase().replace(/@[^@]*$/, "");
			if (cmd === "/reset") { await this.handler.handleReset(channelId, this); return; }
			if (cmd === "/compact") { await this.handler.handleCompact(channelId, this); return; }
			if (cmd === "/stop") { await this.handler.handleStop(channelId, this); return; }
			// Unknown commands fall through as regular messages
		}

		// Pending schedule choice — handle "1" / "2" response
		const pendingChoice = this.pendingScheduleChoices.get(channelId);
		if (pendingChoice) {
			await this.handleScheduleChoice(channelId, text, pendingChoice);
			return;
		}

		// Build file list
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

		// Scheduling intent + conflict check (only for text messages with no files)
		if (text && files.length === 0 && hasSchedulingIntent(text)) {
			const existingFiles = this.findExistingEventFiles(channelId);
			if (existingFiles.length > 0) {
				this.pendingScheduleChoices.set(channelId, { originalText: text, existingFiles });
				await this.postMessage(
					channelId,
					`⚠️ A scheduled task already exists for this chat.\n\n` +
					`Reply with:\n` +
					`<b>1</b> — Delete existing and schedule new task\n` +
					`<b>2</b> — Keep existing task (cancel new request)`,
				);
				return;
			}
		}

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

		const result = queue.enqueueUser(() => this.handler.handleEvent(event, this));
		if (result === "spam") {
			// Cooldown just activated — message dropped silently
		} else if (result === "full") {
			await this.postMessage(channelId, "_Too many messages queued. Please wait._");
		}
	}

	// ==========================================================================
	// Private — schedule conflict choice handler
	// ==========================================================================

	private async handleScheduleChoice(channelId: string, reply: string, choice: ScheduleChoice): Promise<void> {
		const trimmed = reply.trim();

		if (trimmed === "1") {
			// Delete existing event files
			let deleted = 0;
			for (const filePath of choice.existingFiles) {
				try {
					const { unlinkSync } = await import("fs");
					unlinkSync(filePath);
					deleted++;
				} catch { /* already gone */ }
			}
			this.pendingScheduleChoices.delete(channelId);
			await this.postMessage(channelId, `✅ Deleted ${deleted} existing scheduled task${deleted !== 1 ? "s" : ""}. Scheduling new task...`);

			// Re-enqueue the original request to the agent
			const event: TelegramEvent = {
				type: "message",
				channel: channelId,
				ts: String(Date.now()),
				user: "user",
				text: choice.originalText,
				chatId: this.claim.getOwnerId() ?? 0,
				attachments: [],
			};
			this.getQueue(channelId).enqueueUser(() => this.handler.handleEvent(event, this));

		} else if (trimmed === "2") {
			this.pendingScheduleChoices.delete(channelId);
			await this.postMessage(channelId, "✅ Keeping existing scheduled task. New request cancelled.");

		} else {
			// Re-prompt
			await this.postMessage(
				channelId,
				`Please reply with <b>1</b> or <b>2</b>:\n\n` +
				`<b>1</b> — Delete existing and schedule new task\n` +
				`<b>2</b> — Keep existing task (cancel new request)`,
			);
		}
	}
}
