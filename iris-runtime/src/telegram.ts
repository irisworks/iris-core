import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as log from "./log.js";
import { TelegramBotRegistry } from "./telegram-bot-registry.js";
import { registerSessionRequest, resolveSessionRequest } from "./sessions.js";
import { resolveChannelDir, resolveChannelPath, type Attachment } from "./store.js";
import { TelegramClaimManager } from "./telegram-claim.js";
import {
	countAgents,
	createAgent,
	deleteAgent,
	listAgents,
	MAX_AGENTS_PER_BOT,
	updateAgentStatus,
	getAgentByName,
	type AgentRecord,
} from "./agent-registry.js";
import { getOwnerTaskSummary, type TaskRecord } from "./task-queue.js";
import {
	bridgePortForSlot,
	deprovisionAgent,
	getAvailableSkills,
	provisionAgent,
	registerAgentBridge,
	unregisterAgentBridge,
} from "./agent-provision.js";
import { callAgentBridge } from "./bridge.js";

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

const CREATE_AGENT_THRESHOLD = 0.35;

const CREATE_AGENT_REFERENCE_PHRASES = [
	"create an agent",
	"spawn an agent",
	"make an agent",
	"build an agent",
	"create agent for",
	"launch an agent",
	"i need an agent",
	"create a bot",
	"new agent",
	"spawn a new agent",
	"create new agent",
	"make me an agent",
];

function hasCreateAgentIntent(text: string): boolean {
	// Fast path: explicit verb + agent/bot pattern anywhere in the message.
	// Handles long messages that dilute cosine similarity below threshold.
	if (/\b(create|spawn|make|build|launch)\s+(a\s+|an\s+|me\s+a\s+|me\s+an\s+|new\s+)?(agent|bot)\b/i.test(text)) return true;
	if (/\bi\s+need\s+(a\s+|an\s+)?(agent|bot)\b/i.test(text)) return true;

	// Fallback: cosine similarity for short/unconventional phrasing
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

	const toVec = (tokens: string[]): number[] =>
		vocab.map((w) => (tokens.includes(w) ? 1 : 0));

	const inputVec = toVec(inputTokens);
	for (const refTokens of refTokensList) {
		const sim = cosineSimilarity(inputVec, toVec(refTokens));
		if (sim >= CREATE_AGENT_THRESHOLD) return true;
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
	// Track last 2 user messages for cosine-similarity spam detection
	private lastUserMessages: string[] = [];

	constructor() {
		this.eventQueueMax = getEventQueueMax();
	}

	// -- Spam cooldown --------------------------------------------------------

	isSpamCooldownActive(): boolean {
		return Date.now() < this.spamCooldownUntil;
	}

	getRemainingCooldownMs(): number {
		return Math.max(0, this.spamCooldownUntil - Date.now());
	}

	private activateCooldown(): void {
		this.spamCooldownUntil = Date.now() + SPAM_COOLDOWN_MS;
		log.logWarning("[telegram] Spam cooldown activated (cosine similarity) — 2 minutes");
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

	// -- User queue -----------------------------------------------------------

	userSize(): number { return this.userQueue.length; }

	enqueueUser(work: QueuedWork, text = ""): EnqueueUserResult {
		if (this.isSpamCooldownActive()) return "spam";

		// Cosine-similarity spam gate: if the new message is very similar to both
		// of the last 2 messages, the user is spamming — activate cooldown.
		if (text && this.isSimilarToRecent(text)) {
			this.activateCooldown();
			return "spam";
		}

		// Track message for future similarity checks (keep last 2)
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
// Pending delete-agent state — two-phase: listing → confirming
// ============================================================================

interface DeleteAgentState {
	phase: "listing" | "confirming";
	agents: AgentRecord[];        // the list shown to the user
	selectedAgent?: AgentRecord;  // set when user picks a number and we ask to confirm
}

// ============================================================================
// Pending agent creation state — single-phase: awaiting_name
// ============================================================================

interface PendingAgentCreation {
	phase: "awaiting_name";
	originalIntent: string;    // the original "create an agent to do X" text
	name?: string;             // set after naming phase
	availableSkills: string[]; // cached skill list
}

// Use the configured IRIS_PROVIDER/IRIS_MODEL to pick relevant skills based on the user's intent.
// Falls back to all skills if the API key is missing or the call fails.
async function autoSelectSkills(intent: string, availableSkills: string[], workingDir: string): Promise<string[]> {
	if (availableSkills.length === 0) return [];

	const provider = process.env.IRIS_PROVIDER ?? "anthropic";
	const model = process.env.IRIS_MODEL ?? "claude-sonnet-4-5";

	try {
		// Read provider config from models.json to get baseUrl and apiKey env var name
		let baseUrl: string | undefined;
		let apiKeyEnvVar: string | undefined;
		let isAnthropicStyle = provider === "anthropic";

		const modelsJsonPath = join(workingDir, "models.json");
		if (existsSync(modelsJsonPath)) {
			const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8")) as {
				providers?: Record<string, { baseUrl?: string; apiKey?: string; api?: string }>;
			};
			const pc = config.providers?.[provider];
			if (pc) {
				baseUrl = pc.baseUrl;
				apiKeyEnvVar = pc.apiKey; // env var name, e.g. "FOUNDRY_E2_KEY"
				isAnthropicStyle = (pc.api ?? "openai-completions") === "anthropic";
			}
		}

		// Resolve the API key
		const apiKey = apiKeyEnvVar
			? process.env[apiKeyEnvVar]
			: process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`]
			  ?? process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			log.logWarning("[autoSelectSkills] No API key found — assigning all skills");
			return [...availableSkills];
		}

		const prompt =
			`You are selecting skills for an AI agent. The user wants: "${intent}"\n\n` +
			`Available skills: ${availableSkills.join(", ")}\n\n` +
			`Return ONLY a JSON array of skill names relevant to the user's request. ` +
			`Be selective — only include skills the agent will actually need. ` +
			`Example: ["search-web","store-file"]\n` +
			`JSON array:`;

		let responseText: string;

		if (isAnthropicStyle) {
			const client = new Anthropic({ apiKey });
			const resp = await client.messages.create({
				model,
				max_tokens: 512,
				messages: [{ role: "user", content: prompt }],
			});
			responseText = resp.content[0].type === "text" ? resp.content[0].text.trim() : "";
		} else {
			// OpenAI-compatible endpoint (foundry-e2, openai, etc.)
			const url = `${baseUrl ?? "https://api.openai.com/v1"}/chat/completions`;
			const resp = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${apiKey}`,
					"api-key": apiKey, // Azure AI Foundry uses this header
				},
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: prompt }],
					max_completion_tokens: 4096, // reasoning models consume ~2000-2300 tokens thinking before outputting; 512 caused empty content
				}),
			});
			if (!resp.ok) {
				const errBody = await resp.text().catch(() => "(unreadable)");
				log.logWarning(`[autoSelectSkills] API error ${resp.status}: ${errBody} — assigning all skills`);
				return [...availableSkills];
			}
			const data = await resp.json() as {
				choices?: Array<{ message?: { content?: string | null; reasoning_content?: string } }>;
			};
			// Log first 400 chars of raw JSON for debugging
			log.logInfo(`[autoSelectSkills] raw JSON: ${JSON.stringify(data).slice(0, 400)}`);
			const msg = data.choices?.[0]?.message;
			// Some reasoning models (e.g. Kimi-K2.6) return content=null with reasoning_content
			responseText = (msg?.content ?? msg?.reasoning_content ?? "").trim();
		}

		log.logInfo(`[autoSelectSkills] raw response: ${responseText.slice(0, 200)}`);

		const match = responseText.match(/\[[\s\S]*?\]/);
		if (!match) {
			log.logWarning(`[autoSelectSkills] No JSON array in response — assigning all skills`);
			return [...availableSkills];
		}

		const parsed: unknown = JSON.parse(match[0]);
		if (!Array.isArray(parsed)) return [...availableSkills];

		const selected = (parsed as unknown[])
			.filter((s): s is string => typeof s === "string")
			.filter((s) => availableSkills.includes(s));

		if (selected.length === 0) {
			log.logWarning(`[autoSelectSkills] No valid skills matched — assigning all skills`);
			return [...availableSkills];
		}

		log.logInfo(`[autoSelectSkills] selected: ${selected.join(", ")}`);
		return selected;
	} catch (err) {
		log.logWarning(`[autoSelectSkills] Unexpected error: ${String(err)} — assigning all skills`);
		return [...availableSkills];
	}
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
	private pendingDeleteStates = new Map<string, DeleteAgentState>();
	private pendingAgentCreations = new Map<string, PendingAgentCreation>();
	private cooldownTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// active agent conversation: channelId → { agentId, agentName, bridgeUrl }
	private activeAgentConversations = new Map<string, { agentId: string; agentName: string; bridgeUrl: string }>();
	// pending agent selection: user sent /agents, waiting for a number
	private pendingAgentSelection = new Map<string, AgentRecord[]>();
	private skillsDir: string;
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
		// Skills are at /iris/data/skills (symlink to repo/skills) or workingDir/skills
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
		await this.claim.initialize();

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
					{ command: "agents", description: "List your agents and start a conversation" },
					{ command: "status", description: "Show which agent you are currently talking to" },
					{ command: "back", description: "Exit agent conversation, return to main bot" },
					{ command: "delete_agent", description: "Delete an agent and free its slot" },
					{ command: "task_status", description: "Show scheduled and recent tasks" },
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

		// Claim gate — handles first-time claim and ownership transfer
		if (!this.claim.isClaimed()) {
			const result = this.claim.tryClaimWith(chatId, text);
			if (result === "claimed") {
				log.logInfo(`[telegram:${this.botId}] Bot claimed by chat_id ${chatId}`);
				await this.postMessage(channelId, `Hi, I'm ${this.botName}. How can I help you today?`);
			} else if (result === "expired") {
				await this.postMessage(channelId, "❌ Token expired. Run <code>iris-claim-token</code> on the server to generate a new one.");
			}
			return;
		}

		// Ownership transfer confirmation — current owner replies 1 (allow) or 2 (deny)
		if (this.claim.isOwner(chatId) && this.claim.getPendingTransferChatId() !== null) {
			if (text === "1") {
				this.claim.confirmTransfer();
				await this.postMessage(channelId, "✅ Ownership transferred. The new user can now use this bot.");
				log.logInfo(`[telegram:${this.botId}] Ownership transfer confirmed by ${chatId}`);
				return;
			} else if (text === "2") {
				this.claim.rejectTransfer();
				await this.postMessage(channelId, "❌ Transfer rejected. You remain the owner.");
				return;
			}
		}

		// Transfer request from a different user with a valid token
		if (!this.claim.isOwner(chatId)) {
			const result = this.claim.tryClaimWith(chatId, text);
			if (result === "transfer_pending") {
				const ownerChannelId = this.encodeChannel(this.claim.getOwnerId()!, undefined);
				await this.postMessage(
					ownerChannelId,
					`⚠️ A new user wants to take over this bot.\n\nReply <b>1</b> to allow or <b>2</b> to deny.\n\n` +
					`All existing agents will remain visible to the new owner.`,
				);
				await this.postMessage(channelId, "⏳ Transfer request sent to the current owner. Waiting for their confirmation.");
				return;
			}
			return; // not owner, not a valid token — ignore
		}

		// Agent conversation routing — if user is talking to a specific agent,
		// route their message directly to that agent's bridge, bypassing the main gate.
		const activeAgent = this.activeAgentConversations.get(channelId);
		if (activeAgent && !text.startsWith("/")) {
			const queue = this.getQueue(channelId);
			if (queue.isSpamCooldownActive()) {
				const sec = Math.ceil(queue.getRemainingCooldownMs() / 1000);
				await this.postMessage(channelId, `⏳ Slow down — cooldown active. Try again in <b>${sec}s</b>.`);
				return;
			}
			await this.routeToAgent(channelId, text, activeAgent);
			return;
		}

		// Pending agent selection — user replied to /agents list with a number
		const pendingSelection = this.pendingAgentSelection.get(channelId);
		if (pendingSelection && !text.startsWith("/")) {
			await this.handleAgentSelectionReply(channelId, text, pendingSelection);
			return;
		}

		// Spam cooldown — inform user of remaining time, start "lifted" timer on first hit
		const queue = this.getQueue(channelId);
		if (queue.isSpamCooldownActive()) {
			const remainingMs  = queue.getRemainingCooldownMs();
			const remainingSec = Math.ceil(remainingMs / 1000);
			log.logInfo(`[telegram:${this.botId}] Spam cooldown active for ${channelId} — ${remainingSec}s remaining`);
			await this.postMessage(channelId, `⏳ Slow down — cooldown active. Try again in <b>${remainingSec}s</b>.`);
			// Schedule one-time "lifted" notification for the end of the cooldown
			if (!this.cooldownTimers.has(channelId)) {
				const tid = setTimeout(async () => {
					this.cooldownTimers.delete(channelId);
					await this.postMessage(channelId, "✅ Cooldown lifted. You can start prompting again.");
				}, remainingMs + 500);
				this.cooldownTimers.set(channelId, tid);
			}
			return;
		}

		// Bot commands — handled directly, bypass all queues and spam check
		if (text.startsWith("/")) {
			const cmd = text.split(/\s/)[0].toLowerCase().replace(/@[^@]*$/, "");
			if (cmd === "/reset") { await this.handler.handleReset(channelId, this); return; }
			if (cmd === "/compact") { await this.handler.handleCompact(channelId, this); return; }
			if (cmd === "/stop") { await this.handler.handleStop(channelId, this); return; }
			if (cmd === "/back") { await this.handleBack(channelId); return; }
			if (cmd === "/agents") { await this.handleListAgents(channelId); return; }
			if (cmd === "/status") { await this.handleStatus(channelId); return; }
			if (cmd === "/delete_agent") { await this.handleDeleteAgentStart(channelId); return; }
			if (cmd === "/task_status") { await this.handleTaskStatus(channelId); return; }
			// Unknown commands fall through as regular messages
		}

		// Pending delete-agent flow — handle numeric selection and confirm/cancel
		const pendingDelete = this.pendingDeleteStates.get(channelId);
		if (pendingDelete) {
			await this.handleDeleteAgentReply(channelId, text, pendingDelete);
			return;
		}

		// Pending schedule choice — handle "1" / "2" response
		const pendingChoice = this.pendingScheduleChoices.get(channelId);
		if (pendingChoice) {
			await this.handleScheduleChoice(channelId, text, pendingChoice);
			return;
		}

		// Greeting shortcut — reply inline without invoking the agent
		const greetingPattern = /^(hi|hello|hey|howdy|hiya|yo)\b[\s!?]*$/i;
		if (greetingPattern.test(text)) {
			await this.postMessage(channelId, `Hi, I'm ${this.botName}. How can I help you today?`);
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

		// Pending agent creation flow — naming → skill selection → provision
		const pendingCreation = this.pendingAgentCreations.get(channelId);
		if (pendingCreation) {
			await this.handleAgentCreationReply(channelId, text, pendingCreation);
			return;
		}

		// Gate: main bot only accepts agent creation. Everything else is rejected.
		if (hasCreateAgentIntent(text)) {
			// Require "agent" or "bot" in the text to avoid false positives like
			// "create a task scheduler for me" matching "create agent for".
			const hasAgentWord = /\b(agent|bot)\b/i.test(text);
			if (hasAgentWord) {
				await this.startAgentCreation(channelId, text);
				return;
			}
			// Looks like a creation request but missing the word "agent" — guide the user
			await this.postMessage(
				channelId,
				`It sounds like you want to create something! I create agents — try:\n\n` +
				`<b>create an agent to ${text.replace(/^(create|make|build|spawn)\s+(a\s+|an\s+)?/i, "").replace(/\s+for me\s*$/i, "")}</b>`,
			);
			return;
		}

		await this.postMessage(
			channelId,
			`I can only create agents from this interface.\n\n` +
			`Say something like: <b>create an agent to search the web</b>\n\n` +
			`To chat with an existing agent, use /agents.`,
		);
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
			this.getQueue(channelId).enqueueUser(() => this.handler.handleEvent(event, this), choice.originalText);

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

	// ==========================================================================
	// Private — /back command
	// ==========================================================================

	private async handleBack(channelId: string): Promise<void> {
		const active = this.activeAgentConversations.get(channelId);
		this.activeAgentConversations.delete(channelId);
		this.pendingAgentSelection.delete(channelId);
		if (active) {
			await this.postMessage(channelId, `↩️ Back to main bot. Use /agents to talk to a specific agent.`);
		} else {
			await this.postMessage(channelId, "You're already in the main bot.");
		}
	}

	private async handleStatus(channelId: string): Promise<void> {
		const active = this.activeAgentConversations.get(channelId);
		if (active) {
			await this.postMessage(
				channelId,
				`🤖 You're currently talking to <b>${active.agentName}</b>.\n\nType /back to return to the main bot, or /agents to switch.`,
			);
		} else {
			const botId = this.botId;
			const agents = botId ? await listAgents(botId) : [];
			if (agents.length === 0) {
				await this.postMessage(channelId, `🏠 You're on the <b>main bot</b>. No agents created yet.`);
			} else {
				const lines = agents.map((a) => `• <b>${a.name}</b> — ${a.status}`).join("\n");
				await this.postMessage(
					channelId,
					`🏠 You're on the <b>main bot</b>.\n\nYour agents:\n${lines}\n\nUse /agents to talk to one.`,
				);
			}
		}
	}

	// ==========================================================================
	// Private — agent conversation routing
	// ==========================================================================

	private async routeToAgent(
		channelId: string,
		text: string,
		agent: { agentId: string; agentName: string; bridgeUrl: string },
	): Promise<void> {
		log.logInfo(`[telegram:${this.botId}] Routing to agent ${agent.agentName} (${agent.agentId})`);
		try {
			const response = await callAgentBridge(agent.bridgeUrl, text, "user");
			const stripped = response.startsWith(`[${agent.agentName}]`)
				? response.slice(`[${agent.agentName}]`.length).replace(/^:\s*/, "")
				: response;
			await this.postMessage(channelId, `🤖 <b>${agent.agentName}</b>\n${stripped}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[telegram:${this.botId}] Bridge call to ${agent.agentName} failed`, msg);
			await this.postMessage(
				channelId,
				`⚠️ <b>${agent.agentName}</b> is not responding (${msg}).\n\nUse /back to return to the main bot.`,
			);
		}
	}

	// ==========================================================================
	// Private — agent selection (two-phase /agents)
	// ==========================================================================

	private async handleAgentSelectionReply(
		channelId: string,
		text: string,
		agents: AgentRecord[],
	): Promise<void> {
		const idx = parseInt(text.trim(), 10) - 1;
		if (isNaN(idx) || idx < 0 || idx >= agents.length) {
			await this.postMessage(channelId, `Please reply with a number between 1 and ${agents.length}, or /back to cancel.`);
			return;
		}

		const selected = agents[idx];
		this.pendingAgentSelection.delete(channelId);

		if (selected.status === "crashed" || selected.status === "stopped") {
			await this.postMessage(channelId, `⚠️ <b>${selected.name}</b> is currently ${selected.status}. Start it first or choose another agent.`);
			return;
		}

		const bridgeUrl = `http://127.0.0.1:${bridgePortForSlot(selected.slotIndex)}`;
		this.activeAgentConversations.set(channelId, {
			agentId:   selected.agentId,
			agentName: selected.name,
			bridgeUrl,
		});

		await this.postMessage(
			channelId,
			`🤖 Now talking to <b>${selected.name}</b>.\n\nType /back to return to the main bot.`,
		);
	}

	// ==========================================================================
	// Private — /task_status command
	// ==========================================================================

	private async handleTaskStatus(channelId: string): Promise<void> {
		const botId = this.botId;
		if (!botId) return;

		const tasks = await getOwnerTaskSummary(botId);
		if (tasks.length === 0) {
			await this.postMessage(channelId, "No tasks found. Assign tasks to your agents to see them here.");
			return;
		}

		// Group by agent_id, look up names from registry
		const agents = await listAgents(botId);
		const nameMap = new Map(agents.map((a) => [a.agentId, a.name]));

		const statusEmoji: Record<string, string> = {
			pending: "⏳", running: "⚙️", done: "✅", failed: "❌", skipped: "⏭️",
		};

		// Group tasks by agent
		const byAgent = new Map<string, TaskRecord[]>();
		for (const t of tasks) {
			if (!byAgent.has(t.agentId)) byAgent.set(t.agentId, []);
			byAgent.get(t.agentId)!.push(t);
		}

		const sections: string[] = [];
		for (const [agentId, agentTasks] of byAgent) {
			const agentName = nameMap.get(agentId) ?? agentId.slice(0, 8);
			const lines = agentTasks.slice(0, 5).map((t) => {
				const emoji = statusEmoji[t.status] ?? "❓";
				const when = t.scheduledFor
					? `scheduled ${new Date(t.scheduledFor).toLocaleString("en-GB", { timeZone: "UTC", hour12: false })}`
					: "immediate";
				const payload = t.payload.slice(0, 60) + (t.payload.length > 60 ? "…" : "");
				return `  ${emoji} <i>${payload}</i>\n     <code>${when}</code>`;
			});
			sections.push(`<b>${agentName}</b>\n${lines.join("\n")}`);
		}

		await this.postMessage(channelId, sections.join("\n\n"));
	}

	// ==========================================================================
	// Private — /agents command
	// ==========================================================================

	private async handleListAgents(channelId: string): Promise<void> {
		const botId = this.botId;
		if (!botId) return;

		// If user is in an active agent conversation, show that first
		const active = this.activeAgentConversations.get(channelId);
		if (active) {
			await this.postMessage(
				channelId,
				`You're currently talking to <b>${active.agentName}</b>. Type /back first to switch agents.`,
			);
			return;
		}

		const agents = await listAgents(botId);
		if (agents.length === 0) {
			await this.postMessage(channelId, "You have no agents yet. Say <b>create an agent</b> to get started.");
			return;
		}

		const statusEmoji: Record<string, string> = { running: "🟢", stopped: "🔴", crashed: "💥" };
		const lines = agents.map(
			(a, i) => `<b>${i + 1}.</b> ${a.name} ${statusEmoji[a.status] ?? "❓"} <i>${a.status}</i>`,
		);
		const used = agents.length;

		// Store the list so the user's next numeric reply selects an agent
		this.pendingAgentSelection.set(channelId, agents);

		await this.postMessage(
			channelId,
			`<b>Your agents (${used}/${MAX_AGENTS_PER_BOT}):</b>\n\n${lines.join("\n")}\n\n` +
			`Reply with a number to start talking to that agent, or /back to cancel.`,
		);
	}

	// ==========================================================================
	// Private — /delete_agent command
	// ==========================================================================

	private async handleDeleteAgentStart(channelId: string): Promise<void> {
		const botId = this.botId;
		if (!botId) return;

		const agents = await listAgents(botId);
		if (agents.length === 0) {
			await this.postMessage(channelId, "You have no agents to delete.");
			return;
		}

		const statusEmoji: Record<string, string> = { running: "🟢", stopped: "🔴", crashed: "💥" };
		const lines = agents.map(
			(a, i) => `<b>${i + 1}.</b> ${a.name} ${statusEmoji[a.status] ?? "❓"}`,
		);
		this.pendingDeleteStates.set(channelId, { phase: "listing", agents });
		await this.postMessage(
			channelId,
			`Which agent do you want to delete?\n\n${lines.join("\n")}\n\nReply with a number.`,
		);
	}

	private async handleDeleteAgentReply(
		channelId: string,
		text: string,
		state: DeleteAgentState,
	): Promise<void> {
		const trimmed = text.trim();

		if (state.phase === "listing") {
			const idx = parseInt(trimmed, 10) - 1;
			if (isNaN(idx) || idx < 0 || idx >= state.agents.length) {
				await this.postMessage(channelId, `Please reply with a number between 1 and ${state.agents.length}.`);
				return;
			}
			const selected = state.agents[idx];
			this.pendingDeleteStates.set(channelId, { phase: "confirming", agents: state.agents, selectedAgent: selected });
			await this.postMessage(
				channelId,
				`Delete <b>${selected.name}</b>? This cannot be undone.\n\n<b>1</b> — Yes, delete\n<b>2</b> — Cancel`,
			);
			return;
		}

		// confirming phase
		const agent = state.selectedAgent!;

		if (trimmed === "1") {
			this.pendingDeleteStates.delete(channelId);
			// Deprovision the Docker container and clean up agents.json
			await deprovisionAgent(`iris-tg-${agent.agentId}`);
			unregisterAgentBridge(this.workingDir, agent.name);
			await updateAgentStatus(agent.agentId, "stopped");
			const deleted = await deleteAgent(agent.agentId);
			if (deleted) {
				log.logInfo(`[telegram:${this.botId}] Agent ${agent.name} (${agent.agentId}) deleted by owner`);
				await this.postMessage(channelId, `✅ <b>${agent.name}</b> has been deleted. Slot ${agent.slotIndex} is now free.`);
			} else {
				await this.postMessage(channelId, `⚠️ Could not delete <b>${agent.name}</b> from the registry. Check Supabase connection.`);
			}
			return;
		}

		if (trimmed === "2") {
			this.pendingDeleteStates.delete(channelId);
			await this.postMessage(channelId, "Cancelled. No agents were deleted.");
			return;
		}

		await this.postMessage(channelId, "Please reply with <b>1</b> to confirm or <b>2</b> to cancel.");
	}

	// ==========================================================================
	// Public — watchdog integration
	// ==========================================================================

	/**
	 * Called by the watchdog when an agent's container crashes.
	 * Exits any active conversation with that agent and notifies the user.
	 */
	clearAgentConversation(agentId: string): void {
		for (const [channelId, agent] of this.activeAgentConversations) {
			if (agent.agentId === agentId) {
				this.activeAgentConversations.delete(channelId);
				void this.postMessage(
					channelId,
					`💥 <b>${agent.agentName}</b> went offline. Your conversation has ended.\n\n` +
					`Use /agents to reconnect when it comes back.`,
				);
			}
		}
		// Also clear any pending agent selections that include the crashed agent
		for (const [channelId, agents] of this.pendingAgentSelection) {
			if (agents.some((a) => a.agentId === agentId)) {
				this.pendingAgentSelection.delete(channelId);
			}
		}
	}

	// ==========================================================================
	// Public — agent limit check (called before spawning)
	// ==========================================================================

	async checkAgentLimit(channelId: string): Promise<boolean> {
		const botId = this.botId;
		if (!botId) return true;
		const count = await countAgents(botId);
		if (count >= MAX_AGENTS_PER_BOT) {
			await this.postMessage(
				channelId,
				`⛔ Agent limit reached (${count}/${MAX_AGENTS_PER_BOT}).\n\n` +
				`To create a new agent, delete an existing one with /delete_agent.`,
			);
			return false;
		}
		return true;
	}

	// ==========================================================================
	// Private — agent creation flow: name → auto-skill-select → provision
	// ==========================================================================

	private async startAgentCreation(channelId: string, originalText: string): Promise<void> {
		const allowed = await this.checkAgentLimit(channelId);
		if (!allowed) return;

		const availableSkills = getAvailableSkills(this.skillsDir);
		this.pendingAgentCreations.set(channelId, {
			phase: "awaiting_name",
			originalIntent: originalText,
			availableSkills,
		});
		await this.postMessage(channelId, "What would you like to name this agent? (letters, numbers, hyphens only — max 32 chars)");
	}

	private async handleAgentCreationReply(
		channelId: string,
		text: string,
		state: PendingAgentCreation,
	): Promise<void> {
		const botId = this.botId;
		if (!botId) return;

		// Phase: awaiting_name
		const name = text.trim();

		if (!/^[a-zA-Z0-9-]{1,32}$/.test(name)) {
			await this.postMessage(
				channelId,
				"Invalid name. Use only letters, numbers, and hyphens (max 32 chars). Try again:",
			);
			return;
		}

		const existing = await getAgentByName(botId, name);
		if (existing) {
			await this.postMessage(channelId, `An agent named <b>${name}</b> already exists. Choose a different name:`);
			return;
		}

		// Name accepted — remove pending state and auto-select skills
		this.pendingAgentCreations.delete(channelId);

		await this.postMessage(channelId, `Got it! Picking the right skills for <b>${name}</b>...`);

		const selectedSkills = await autoSelectSkills(state.originalIntent, state.availableSkills, this.workingDir);

		await this.postMessage(
			channelId,
			`Creating agent <b>${name}</b> with skills: ${selectedSkills.length > 0 ? selectedSkills.join(", ") : "none (general-purpose)"}...\n\nThis may take a moment.`,
		);

		const chatId = this.claim.getOwnerId()!;
		const record = await createAgent({ botId, chatId, name, skills: selectedSkills });
		if (!record) {
			await this.postMessage(channelId, "⚠️ Failed to create agent record. Check Supabase connection and try again.");
			return;
		}

		try {
			const containerName = await provisionAgent({
				agentId: record.agentId,
				agentName: name,
				slotIndex: record.slotIndex,
				skills: selectedSkills,
				ownerChannelId: channelId,
			});
			await updateAgentStatus(record.agentId, "running", containerName);
			registerAgentBridge(this.workingDir, name, record.agentId, record.slotIndex);

			log.logInfo(`[telegram:${botId}] Agent "${name}" provisioned — container: ${containerName}`);
			await this.postMessage(
				channelId,
				`✅ <b>${name}</b> is live! (slot ${record.slotIndex}/${MAX_AGENTS_PER_BOT})\n\n` +
				`Use /agents to start talking to it.`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[telegram:${botId}] Failed to provision agent "${name}"`, msg);
			await deleteAgent(record.agentId);
			await this.postMessage(
				channelId,
				`⚠️ Failed to start <b>${name}</b>: ${msg}\n\nThe agent slot has been freed.`,
			);
		}
	}
}
