/**
 * Context management for Iris.
 *
 * Iris uses two files per channel:
 * - context.jsonl: Structured API messages for LLM context (same format as coding-agent sessions)
 * - log.jsonl: Human-readable channel history for grep (no tool results)
 *
 * This module provides:
 * - syncLogToSessionManager: Syncs messages from log.jsonl to SessionManager
 * - createIrisSettingsManager: Creates a SettingsManager backed by workspace settings.json
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import { type SessionManager, type SessionMessageEntry, SettingsManager } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { Attachment } from "./store.js";

// ============================================================================
// Sync log.jsonl to SessionManager
// ============================================================================

interface LogMessage {
	date?: string;
	ts?: string;
	user?: string;
	userName?: string;
	text?: string;
	isBot?: boolean;
	attachments?: Attachment[];
}

// Per-turn user messages are prefixed with a `<dynamic_context>` block (live memory
// + MCP status, see buildDynamicContext in agent.ts) before the timestamp/username.
// log.jsonl entries never have this block, so it must be stripped before comparing
// against synced log lines or resending old turns to the LLM.
// Greedy, not lazy: the block embeds raw MEMORY.md content, which Iris herself
// writes and could plausibly contain the literal text "</dynamic_context>\n\n"
// (e.g. a memory note about this very mechanism). A lazy match would latch onto
// that embedded occurrence instead of the real closing tag. Greedy matches the
// last occurrence in the string, which is always the true closing tag since the
// block is anchored to the very start.
const DYNAMIC_CONTEXT_PREFIX_RE = /^<dynamic_context>[\s\S]*<\/dynamic_context>\n\n/;

/** Strip a leading `<dynamic_context>...</dynamic_context>` block, if present. */
export function stripDynamicContext(text: string): string {
	return text.replace(DYNAMIC_CONTEXT_PREFIX_RE, "");
}

/**
 * Strip stale `<dynamic_context>` blocks from already-persisted user messages.
 *
 * The block only reflects live memory/MCP state at the moment it was sent, so once
 * a turn is history it's just a stale, potentially-conflicting snapshot taking up
 * context space — the current turn gets a fresh one instead. Mutates in place.
 */
export function stripDynamicContextFromMessages(messages: Array<{ role: string; content?: unknown }>): void {
	for (const m of messages) {
		if (m.role !== "user" || m.content === undefined) continue;
		if (typeof m.content === "string") {
			m.content = stripDynamicContext(m.content);
		} else if (Array.isArray(m.content)) {
			for (const part of m.content) {
				if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
					(part as { text: string }).text = stripDynamicContext((part as { text: string }).text);
				}
			}
		}
	}
}

/**
 * Sync user messages from log.jsonl to SessionManager.
 *
 * This ensures that messages logged while Iris wasn't running (channel chatter,
 * backfilled messages, messages while busy) are added to the LLM context —
 * including any attachments on those messages, which log.jsonl already carries
 * (ChannelStore.logMessage() writes the full LoggedMessage) but earlier versions
 * of this function silently dropped by never reading the field back out.
 *
 * @param sessionManager - The SessionManager to sync to
 * @param channelDir - Path to channel directory containing log.jsonl
 * @param workspacePath - Executor-visible workspace root attachment paths are resolved against,
 *   matching how the live prompt path in agent.ts builds `${workspacePath}/${attachment.local}`
 * @param attachmentsTagName - Transport's attachment tag (e.g. "slack_attachments"), so a
 *   replayed message's attachments are wrapped the same way a live one's are
 * @param excludeSlackTs - Slack timestamp of current message (will be added via prompt(), not sync)
 * @param sinceDate - ISO timestamp watermark (see readResetWatermark); log.jsonl entries at or
 *   before it are skipped so a `/reset`/`/clear` isn't immediately undone by replaying the
 *   channel's pre-reset history back into the freshly-cleared session (#109).
 * @returns Number of messages synced
 */
export function syncLogToSessionManager(
	sessionManager: SessionManager,
	channelDir: string,
	workspacePath: string,
	attachmentsTagName: string,
	excludeSlackTs?: string,
	sinceDate?: string,
): number {
	const logFile = join(channelDir, "log.jsonl");

	if (!existsSync(logFile)) return 0;

	// Build set of existing message content from session
	const existingMessages = new Set<string>();
	for (const entry of sessionManager.getEntries()) {
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			const msg = msgEntry.message as { role: string; content?: unknown };
			if (msg.role === "user" && msg.content !== undefined) {
				const content = msg.content;
				if (typeof content === "string") {
					// Strip dynamic_context block, then timestamp prefix for comparison
					// (live messages have both, synced don't).
					// Format: [YYYY-MM-DD HH:MM:SS+HH:MM] [username]: text
					let normalized = stripDynamicContext(content).replace(
						/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /,
						"",
					);
					// Strip attachments section — tag name is transport-specific
					// ("slack_attachments" / "telegram_attachments" / "web_attachments")
					const attachmentsIdx = normalized.indexOf(`\n\n<${attachmentsTagName}>\n`);
					if (attachmentsIdx !== -1) {
						normalized = normalized.substring(0, attachmentsIdx);
					}
					existingMessages.add(normalized);
				} else if (Array.isArray(content)) {
					for (const part of content) {
						if (
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part
						) {
							let normalized = stripDynamicContext((part as { type: "text"; text: string }).text);
							normalized = normalized.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] /, "");
							const attachmentsIdx = normalized.indexOf(`\n\n<${attachmentsTagName}>\n`);
							if (attachmentsIdx !== -1) {
								normalized = normalized.substring(0, attachmentsIdx);
							}
							existingMessages.add(normalized);
						}
					}
				}
			}
		}
	}

	// Read log.jsonl and find user messages not in context
	const logContent = readFileSync(logFile, "utf-8");
	const logLines = logContent.trim().split("\n").filter(Boolean);

	const newMessages: Array<{ timestamp: number; message: UserMessage }> = [];

	for (const line of logLines) {
		try {
			const logMsg: LogMessage = JSON.parse(line);

			const slackTs = logMsg.ts;
			const date = logMsg.date;
			if (!slackTs || !date) continue;

			// Skip anything logged at/before the last reset — it's pre-reset history,
			// not a message that arrived while Iris was offline/busy (#109).
			if (sinceDate && date <= sinceDate) continue;

			// Skip the current message being processed (will be added via prompt())
			if (excludeSlackTs && slackTs === excludeSlackTs) continue;

			// Skip bot messages - added through agent flow
			if (logMsg.isBot) continue;

			// Build the message text as it would appear in context
			let messageText = `[${logMsg.userName || logMsg.user || "unknown"}]: ${logMsg.text || ""}`;
			if (logMsg.attachments && logMsg.attachments.length > 0) {
				const paths = logMsg.attachments.map((a) => {
					const fullPath = `${workspacePath}/${a.local}`;
					return existsSync(fullPath) ? fullPath : `${fullPath} (not available)`;
				});
				messageText += `\n\n<${attachmentsTagName}>\n${paths.join("\n")}\n</${attachmentsTagName}>`;
			}

			// Skip if this exact message text is already in context
			if (existingMessages.has(messageText)) continue;

			const msgTime = new Date(date).getTime() || Date.now();
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: messageText }],
				timestamp: msgTime,
			};

			newMessages.push({ timestamp: msgTime, message: userMessage });
			existingMessages.add(messageText); // Track to avoid duplicates within this sync
		} catch {
			// Skip malformed lines
		}
	}

	if (newMessages.length === 0) return 0;

	// Sort by timestamp and add to session
	newMessages.sort((a, b) => a.timestamp - b.timestamp);

	for (const { message } of newMessages) {
		sessionManager.appendMessage(message);
	}

	return newMessages.length;
}

// ============================================================================
// Reset watermark
//
// `/reset`/`/clear` truncate context.jsonl but deliberately leave log.jsonl
// alone (it's the channel's permanent record). Without a watermark, the next
// run's syncLogToSessionManager call sees an empty session, treats every line
// in log.jsonl as unsynced, and replays the whole pre-reset conversation
// straight back into the freshly-cleared context (#109). The watermark records
// when the last reset happened so that replay is scoped to messages logged
// after it.
// ============================================================================

const RESET_WATERMARK_FILE = ".reset-watermark";

/** Record that a reset just happened, so future log.jsonl syncs skip everything before it. */
export function writeResetWatermark(channelDir: string): void {
	writeFileSync(join(channelDir, RESET_WATERMARK_FILE), new Date().toISOString());
}

/** ISO timestamp of the channel's last reset, if any. */
export function readResetWatermark(channelDir: string): string | undefined {
	const path = join(channelDir, RESET_WATERMARK_FILE);
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, "utf-8").trim() || undefined;
	} catch {
		return undefined;
	}
}

// ============================================================================
// Settings manager for Iris
// ============================================================================

type IrisSettingsStorage = Parameters<typeof SettingsManager.fromStorage>[0];

class WorkspaceSettingsStorage implements IrisSettingsStorage {
	private settingsPath: string;

	constructor(workspaceDir: string) {
		this.settingsPath = join(workspaceDir, "settings.json");
	}

	withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void {
		if (scope === "project") {
			// Iris stores all settings in a single workspace file.
			fn(undefined);
			return;
		}

		const current = existsSync(this.settingsPath) ? readFileSync(this.settingsPath, "utf-8") : undefined;
		const next = fn(current);
		if (next === undefined) {
			return;
		}

		const dir = dirname(this.settingsPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.settingsPath, next, "utf-8");
	}
}

export function createIrisSettingsManager(workspaceDir: string): SettingsManager {
	return SettingsManager.fromStorage(new WorkspaceSettingsStorage(workspaceDir));
}
