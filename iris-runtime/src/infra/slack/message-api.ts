/**
 * Outbound Slack message API.
 *
 * Owns: postMessage, updateMessage, postInThread, deleteMessage,
 *       finalizeMessage, uploadFile, session route table, Telegram bridge.
 *
 * Previously scattered across SlackBot — extracted so the connection layer
 * does not conflate routing concerns with API call mechanics.
 */

import type { WebClient } from "@slack/web-api";
import { readFileSync } from "fs";
import { basename } from "path";
import { parseChannelKind } from "../../channel-kind.js";
import { truncateForSlack } from "../../slack-text.js";
import * as log from "../../log.js";

// ============================================================================
// Telegram bridge (fire-and-forget when channel is TELEGRAM)
// ============================================================================

async function sendToTelegram(
	bridgeUrl: string,
	chatId: string,
	text: string,
	replyTo?: string,
): Promise<boolean> {
	try {
		const response = await fetch(`${bridgeUrl}/send`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chatId, text, replyTo }),
		});
		return response.ok;
	} catch (err) {
		log.logWarning("[telegram] Failed to send response", String(err));
		return false;
	}
}

// ============================================================================
// SlackMessageApi
// ============================================================================

export type SessionRoute = { channel: string; threadTs: string };
export type TelegramContext = { chatId: string; messageId?: string };

export class SlackMessageApi {
	/** SESSION-<uuid> → { channel, threadTs } for routing replies to the origin thread. */
	private sessionRoutes = new Map<string, SessionRoute>();
	/** TELEGRAM → { chatId, messageId? } for routing replies to the Telegram bridge. */
	private telegramContexts = new Map<string, TelegramContext>();

	constructor(
		private readonly webClient: WebClient,
		private readonly telegramBridgeUrl: string,
	) {}

	// ── Session route management ───────────────────────────────────────────────

	setSessionRoute(channelId: string, route: SessionRoute): void {
		this.sessionRoutes.set(channelId, route);
	}

	getSessionRoute(channelId: string): SessionRoute | undefined {
		return this.sessionRoutes.get(channelId);
	}

	// ── Telegram context management ────────────────────────────────────────────

	setTelegramContext(channel: string, chatId: string, messageId?: string): void {
		this.telegramContexts.set(channel, { chatId, messageId });
	}

	clearTelegramContext(channel: string): void {
		this.telegramContexts.delete(channel);
	}

	// ── Outbound API ──────────────────────────────────────────────────────────

	async postMessage(channel: string, text: string): Promise<string> {
		const kind = parseChannelKind(channel);
		if (kind.kind === "virtual" || kind.kind === "bridge" || kind.kind === "telegram") {
			return Date.now().toString();
		}
		if (kind.kind === "session") {
			const route = this.sessionRoutes.get(channel);
			if (!route) return Date.now().toString();
			const result = await this.webClient.chat.postMessage({
				channel: route.channel,
				thread_ts: route.threadTs,
				text: truncateForSlack(text),
			});
			return result.ts as string;
		}
		const result = await this.webClient.chat.postMessage({ channel, text: truncateForSlack(text) });
		return result.ts as string;
	}

	async updateMessage(channel: string, ts: string, text: string): Promise<void> {
		const kind = parseChannelKind(channel);
		if (kind.kind === "virtual" || kind.kind === "bridge" || kind.kind === "telegram") return;
		if (kind.kind === "session") {
			const route = this.sessionRoutes.get(channel);
			if (!route) return;
			await this.webClient.chat.update({ channel: route.channel, ts, text: truncateForSlack(text) });
			return;
		}
		await this.webClient.chat.update({ channel, ts, text: truncateForSlack(text) });
	}

	/**
	 * Finalise a message after the agent completes.
	 * Routes BRIDGE → pending request resolution; TELEGRAM → bot bridge;
	 * SESSION → Slack thread update; everything else → normal chat.update.
	 */
	async finalizeMessage(channel: string, ts: string, text: string): Promise<void> {
		const kind = parseChannelKind(channel);
		if (kind.kind === "virtual") return;
		if (kind.kind === "bridge") {
			const { resolveBridgeRequest } = await import("../../bridge.js");
			resolveBridgeRequest(kind.requestId, text);
			return;
		}
		if (kind.kind === "telegram") {
			const ctx = this.telegramContexts.get(channel);
			if (ctx) {
				await sendToTelegram(this.telegramBridgeUrl, ctx.chatId, text, ctx.messageId);
				this.clearTelegramContext(channel);
			}
			return;
		}
		if (kind.kind === "session") {
			const route = this.sessionRoutes.get(channel);
			if (route) {
				await this.webClient.chat.update({ channel: route.channel, ts, text: truncateForSlack(text) });
			}
			return;
		}
		await this.webClient.chat.update({ channel, ts, text: truncateForSlack(text) });
	}

	async deleteMessage(channel: string, ts: string): Promise<void> {
		const kind = parseChannelKind(channel);
		if (kind.kind === "virtual" || kind.kind === "bridge" || kind.kind === "telegram") return;
		if (kind.kind === "session") {
			const route = this.sessionRoutes.get(channel);
			if (!route) return;
			await this.webClient.chat.delete({ channel: route.channel, ts });
			return;
		}
		await this.webClient.chat.delete({ channel, ts });
	}

	async postInThread(channel: string, threadTs: string, text: string): Promise<string> {
		const kind = parseChannelKind(channel);
		if (kind.kind === "virtual" || kind.kind === "bridge" || kind.kind === "telegram") {
			return Date.now().toString();
		}
		if (kind.kind === "session") {
			const route = this.sessionRoutes.get(channel);
			if (!route) return Date.now().toString();
			// Always use the session root ts — not the caller's reply ts.
			const result = await this.webClient.chat.postMessage({
				channel: route.channel,
				thread_ts: route.threadTs,
				text: truncateForSlack(text),
			});
			return result.ts as string;
		}
		const result = await this.webClient.chat.postMessage({
			channel,
			thread_ts: threadTs,
			text: truncateForSlack(text),
		});
		return result.ts as string;
	}

	async uploadFile(channel: string, filePath: string, title?: string): Promise<void> {
		const kind = parseChannelKind(channel);
		if (kind.kind === "virtual" || kind.kind === "bridge" || kind.kind === "telegram") return;
		const effectiveChannel = kind.kind === "session"
			? this.sessionRoutes.get(channel)?.channel
			: channel;
		if (!effectiveChannel) return;
		const fileName = title || basename(filePath);
		const fileContent = readFileSync(filePath);
		await this.webClient.files.uploadV2({
			channel_id: effectiveChannel,
			file: fileContent,
			filename: fileName,
			title: fileName,
		});
	}
}
