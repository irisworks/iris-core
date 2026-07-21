import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as log from "../../engine/log.js";
import { registerSessionRequest, resolveSessionRequest } from "../../engine/sessions.js";
import { resolveChannelDir, resolveChannelPath, type Attachment } from "../../engine/store.js";
import { TelegramClaimManager } from "./telegram-claim.js";
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

// ============================================================================
// Constants
// ============================================================================

const TG_MAX_CHARS = 4096;
const POLL_TIMEOUT = 30;

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

// Shared transport types — moved to transport/types.ts; re-exported for compat
export type { MessageContext as TelegramContext } from "../../transport/types.js";

// ============================================================================
// Prompt profile
// ============================================================================

// Formatting guidance mirrors toTelegramHtml() below: **bold**, _italic_, and
// backtick code are converted to HTML (parse_mode: "HTML"); single *asterisks*
// and [markdown](links) are NOT converted and would render literally.
export const telegramPromptProfile: TransportPromptProfile = {
	transportId: "telegram",
	identityLine: "You are Iris, a Telegram-connected orchestrator for specialized sub-agents.",
	formattingSection: `## Telegram Formatting (Markdown subset, converted to HTML)
Bold: **text**, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`
Do NOT use single *asterisks* for bold or [markdown](links) — write URLs plainly, they render as-is.`,
	directorySection: (channels: ChannelInfo[], _users: UserInfo[]) => {
		const chatMappings =
			channels.length > 0 ? channels.map((c) => `${c.id}\t${c.name}`).join("\n") : "(no chats loaded)";
		return `## Telegram Chats
${chatMappings}

When mentioning users, use @username format.`;
	},
	silentNote: "This deletes the status message and posts nothing to Telegram.",
	attachNote: "Share files to Telegram",
	attachmentsTagName: "telegram_attachments",
	maxMessageChars: 30000,
};

registerPromptProfile(telegramPromptProfile);

export interface IrisTelegramHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: TelegramEvent, bot: TelegramBot, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, bot: TelegramBot): Promise<void>;
	handleCompact(channelId: string, bot: TelegramBot): Promise<void>;
	handleReset(channelId: string, bot: TelegramBot): Promise<void>;
}

// ============================================================================
// Per-channel queue (mirrors slack.ts)
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
// Markdown → Telegram HTML
// ============================================================================

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toTelegramHtml(text: string): string {
	// Fenced code blocks: ```lang\ncode\n``` → <pre><code>code</code></pre>
	text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code: string) =>
		`<pre><code>${escapeHtml(code.trim())}</code></pre>`,
	);
	// Inline code: `code` → <code>code</code>
	text = text.replace(/`([^`\n]+)`/g, (_, code: string) => `<code>${escapeHtml(code)}</code>`);
	// Bold: **text**
	text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
	// Italic: _text_ (word boundaries to avoid matching underscores in identifiers)
	text = text.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "<i>$1</i>");
	return text;
}

// ============================================================================
// Chunk splitting (mirrors main.ts splitIntoChunks)
// ============================================================================

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

// ============================================================================
// TelegramBot
// ============================================================================

export class TelegramBot implements ChannelTransport {
	readonly transportId = "telegram";
	readonly promptProfile = telegramPromptProfile;
	readonly stopCommandHint = "send /stop first";
	private token: string;
	private handler: IrisTelegramHandler;
	private workingDir: string;
	private queues = new Map<string, ChannelQueue>();
	private running = false;
	private offset = 0;
	private chatNames = new Map<string, string>();
	readonly claim: TelegramClaimManager;

	constructor(
		handler: IrisTelegramHandler,
		config: { token: string; workingDir: string },
	) {
		this.token = config.token;
		this.claim = new TelegramClaimManager(config.workingDir);
		this.handler = handler;
		this.workingDir = config.workingDir;
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
	// tg-{chatId} for positive IDs (DMs)
	// tg-n{abs(chatId)} for negative IDs (groups/channels)
	// tg-{chatId}-{threadId} for topic threads
	// ==========================================================================

	private encodeChannel(chatId: number, threadId?: number): string {
		const chatStr = chatId < 0 ? `n${Math.abs(chatId)}` : String(chatId);
		return threadId ? `tg-${chatStr}-${threadId}` : `tg-${chatStr}`;
	}

	private decodeChannel(channelId: string): { chatId: number; threadId?: number } {
		const rest = channelId.slice(3); // strip "tg-"
		const dashIdx = rest.lastIndexOf("-");
		// Check if there's a thread suffix (last segment is all digits)
		const hasTwoSegments = dashIdx > 0 && /^\d+$/.test(rest.slice(dashIdx + 1));
		const chatStr = hasTwoSegments ? rest.slice(0, dashIdx) : rest;
		const threadId = hasTwoSegments ? parseInt(rest.slice(dashIdx + 1), 10) : undefined;
		const chatId = chatStr.startsWith("n") ? -parseInt(chatStr.slice(1), 10) : parseInt(chatStr, 10);
		return { chatId, threadId };
	}

	// ==========================================================================
	// Public messaging API (mirrors SlackBot interface)
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

	// Called when generation is complete — edit thinking indicator with chunk 1,
	// send overflow as new messages below.
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
			await this.call("deleteMessage", {
				chat_id: chatId,
				message_id: parseInt(messageId, 10),
			});
		} catch (err) {
			log.logWarning("[telegram] deleteMessage failed", err instanceof Error ? err.message : String(err));
		}
	}

	// For Telegram, "posting in thread" is just posting to the same channel/topic.
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

			// Use message_id as prefix so attachments are directly linked to their message
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
	// Logging (mirrors SlackBot)
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
	// Context helpers (mirrors SlackBot getUser/getChannel)
	// ==========================================================================

	getChatName(channelId: string): string | undefined {
		return this.chatNames.get(channelId);
	}

	getAllChats(): Array<{ id: string; name: string }> {
		return Array.from(this.chatNames.entries()).map(([id, name]) => ({ id, name }));
	}

	// ==========================================================================
	// ChannelTransport surface
	// ==========================================================================

	ownsChannel(channelId: string): boolean {
		return channelId.startsWith("tg-");
	}

	getChannels(): ChannelInfo[] {
		return this.getAllChats();
	}

	getUsers(): UserInfo[] {
		return [];
	}

	createContext(event: TransportEvent, state: ChannelState): MessageContext {
		return createTelegramContext(event as TelegramEvent, this, state);
	}

	// ==========================================================================
	// Session injection (required by api.ts SessionInjector interface)
	// ==========================================================================

	async injectSessionMessage(sessionId: string, user: string, text: string): Promise<string> {
		const channelId = `SESSION-${sessionId}`;
		const queue = this.getQueue(channelId);

		if (queue.size() >= 5) throw new Error("Session message queue is full");

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
		queue.enqueue(() => this.handler.handleEvent(event, this));
		return responsePromise;
	}

	resetSessionContext(_sessionId: string): void {
		// File-based reset handled in api.ts; in-memory state reloads clean on next message.
	}

	// ==========================================================================
	// Events watcher integration
	// ==========================================================================

	enqueueEvent(event: TelegramEvent): boolean {
		const queue = this.getQueue(event.channel);
		if (queue.size() >= 5) {
			log.logWarning(`[telegram] Event queue full for ${event.channel}`);
			return false;
		}
		log.logInfo(`[telegram] Enqueueing event for ${event.channel}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	async start(): Promise<void> {
		this.running = true;

		let me: { id: number; username?: string; first_name?: string };
		try {
			me = (await this.call("getMe")) as typeof me;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Most common cause: TELEGRAM_BOT_TOKEN in /iris/.env is invalid/revoked, or
			// there's no network path to api.telegram.org. Fail loudly with a pointer to
			// the fix rather than letting a bare fetch error bubble up.
			throw new Error(
				`[telegram] Could not connect to Telegram (check TELEGRAM_BOT_TOKEN in /iris/.env): ${msg}`,
			);
		}

		// If the token now points at a different bot than last time, the persisted claim
		// (if any) belongs to that old bot and is meaningless here — clear it automatically.
		if (this.claim.syncBotIdentity(me.id)) {
			log.logInfo(
				`[telegram] Bot token changed since last run (now bot id ${me.id}) — previous claim cleared, this bot is unclaimed.`,
			);
		}

		log.logInfo(`[telegram] Connected as @${me.username ?? me.first_name ?? "unknown"}`);
		log.logConnected();
		void this.poll();
	}

	stop(): void {
		this.running = false;
	}

	// ==========================================================================
	// Private — queue
	// ==========================================================================

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
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
						log.logWarning("[telegram] handleUpdate error", err instanceof Error ? err.message : String(err));
					}
				}
			} catch (err) {
				if (this.running) {
					log.logWarning("[telegram] Poll error — retrying in 5s", err instanceof Error ? err.message : String(err));
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
		// Ignore messages from other bots
		if (msg.from?.is_bot) return;

		const chatId = msg.chat.id;
		const threadId = msg.message_thread_id;
		const channelId = this.encodeChannel(chatId, threadId);

		// Store human-readable chat name for context
		const chatName =
			msg.chat.title ??
			(msg.chat.username ? `@${msg.chat.username}` : null) ??
			msg.chat.first_name ??
			String(chatId);
		this.chatNames.set(channelId, chatName);

		const text = (msg.text ?? msg.caption ?? "").trim();

		// ==========================================================================
		// Claim gate — bot must be claimed before it processes any messages
		// ==========================================================================

		if (!this.claim.isClaimed()) {
			// Only accept a claim token — ignore everything else
			const result = this.claim.tryClaimWith(chatId, text);
			if (result === "claimed") {
				log.logInfo(`[telegram] Bot claimed by chat_id ${chatId}`);
				await this.postMessage(channelId, "✅ Bot claimed. You're all set — start chatting!");
			} else if (result === "expired") {
				await this.postMessage(channelId, "❌ Token expired. Restart Iris to get a new one.");
			}
			// Invalid token or no pending token — silently ignore
			return;
		}

		// Bot is claimed — only the owner gets through
		if (!this.claim.isOwner(chatId)) return;

		// Handle bot commands
		if (text.startsWith("/")) {
			const cmd = text.split(/\s/)[0].toLowerCase().replace(/@[^@]*$/, "");
			if (cmd === "/reset") {
				await this.handler.handleReset(channelId, this);
				return;
			}
			if (cmd === "/compact") {
				await this.handler.handleCompact(channelId, this);
				return;
			}
			if (cmd === "/stop") {
				await this.handler.handleStop(channelId, this);
				return;
			}
			// Unknown commands fall through as regular messages
		}

		// Build file list
		const files: TelegramEvent["files"] = [];
		if (msg.document) {
			files.push({ fileId: msg.document.file_id, name: msg.document.file_name ?? "file", mimeType: msg.document.mime_type });
		}
		if (msg.photo) {
			const largest = msg.photo[msg.photo.length - 1];
			files.push({ fileId: largest.file_id, name: "photo.jpg", mimeType: "image/jpeg" });
		}
		if (msg.audio) {
			files.push({ fileId: msg.audio.file_id, name: msg.audio.file_name ?? "audio.mp3", mimeType: msg.audio.mime_type });
		}
		if (msg.voice) {
			files.push({ fileId: msg.voice.file_id, name: "voice.ogg", mimeType: msg.voice.mime_type ?? "audio/ogg" });
		}
		if (msg.video) {
			files.push({ fileId: msg.video.file_id, name: msg.video.file_name ?? "video.mp4", mimeType: msg.video.mime_type });
		}

		// Skip messages with no text and no files
		if (!text && files.length === 0) return;

		// Download attachments (synchronous in poll loop — acceptable for file size Telegram allows)
		const attachments: Attachment[] = [];
		for (const file of files) {
			const att = await this.downloadFile(file.fileId, channelId, file.name, String(msg.message_id));
			if (att) attachments.push(att);
		}

		const userName = msg.from?.username;
		const displayName =
			[msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || undefined;
		const userId = String(msg.from?.id ?? "unknown");

		// Log user message
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

		const queue = this.getQueue(channelId);
		if (queue.size() >= 5) {
			await this.postMessage(channelId, "_Too many messages queued. Please wait._");
		} else {
			queue.enqueue(() => this.handler.handleEvent(event, this));
		}
	}
}

// ============================================================================
// Telegram context adapter
// ============================================================================

export function createTelegramContext(event: TelegramEvent, bot: TelegramBot, state: ChannelState) {
	let messageId: string | null = null;
	const extraMessageIds: string[] = [];
	let accumulatedText = "";
	let updatePromise = Promise.resolve();

	return {
		transportId: bot.transportId,
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: bot.getChatName(event.channel),
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
					// If tool-call updates were posted in between, editing the original
					// "Thinking..." message would put the final answer above them —
					// post it fresh at the bottom instead so message order matches
					// chronological order. With no intervening messages, editing in
					// place (as before) keeps a simple exchange to a single message.
					if (messageId && extraMessageIds.length > 0) {
						await bot.deleteMessage(event.channel, messageId);
						messageId = await bot.postMessage(event.channel, text);
					} else if (messageId) {
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
