import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

export interface Attachment {
	original: string; // original filename from uploader
	local: string; // path relative to working dir (e.g., "C12345/attachments/1732531234567_file.png")
}

export interface LoggedMessage {
	date: string; // ISO 8601 date (e.g., "2025-11-26T10:44:00.000Z") for easy grepping
	ts: string; // slack timestamp or epoch ms
	user: string; // user ID (or "bot" for bot responses)
	userName?: string; // handle (e.g., "mario")
	displayName?: string; // display name (e.g., "Mario Zechner")
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
	botToken: string; // needed for authenticated file downloads
}

interface PendingDownload {
	channelId: string;
	localPath: string; // relative path
	url: string;
}

// Maximum concurrent attachment downloads — enough to saturate a typical link
// without overwhelming the Slack CDN rate limit.
const MAX_CONCURRENT_DOWNLOADS = 3;

export class ChannelStore {
	private workingDir: string;
	private botToken: string;
	private pendingDownloads: PendingDownload[] = [];
	private activeDownloads = 0;
	// Track recently logged message timestamps to prevent duplicates
	// Key: "channelId:ts", automatically cleaned up after 60 seconds
	private recentlyLogged = new Map<string, number>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;

		// Ensure working directory exists
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * Get or create the directory for a channel/DM
	 */
	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	/**
	 * Generate a unique local filename for an attachment
	 */
	generateLocalFilename(originalName: string, timestamp: string): string {
		// Convert slack timestamp (1234567890.123456) to milliseconds
		const ts = Math.floor(parseFloat(timestamp) * 1000);
		// Sanitize original name (remove problematic characters)
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	/**
	 * Process attachments from a Slack message event
	 * Returns attachment metadata and queues downloads
	 */
	processAttachments(
		channelId: string,
		files: Array<{ name?: string; url_private_download?: string; url_private?: string }>,
		timestamp: string,
	): Attachment[] {
		const attachments: Attachment[] = [];

		for (const file of files) {
			const url = file.url_private_download || file.url_private;
			if (!url) continue;
			if (!file.name) {
				log.logWarning("Attachment missing name, skipping", url);
				continue;
			}

			const filename = this.generateLocalFilename(file.name, timestamp);
			const localPath = `${channelId}/attachments/${filename}`;

			attachments.push({
				original: file.name,
				local: localPath,
			});

			// Queue for background download
			this.pendingDownloads.push({ channelId, localPath, url });
		}

		// Trigger background download
		this.processDownloadQueue();

		return attachments;
	}

	/**
	 * Log a message to the channel's log.jsonl
	 * Returns false if message was already logged (duplicate)
	 */
	async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
		// Check for duplicate (same channel + timestamp)
		const dedupeKey = `${channelId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false; // Already logged
		}

		// Mark as logged and schedule cleanup after 60 seconds
		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		// Ensure message has a date field
		if (!message.date) {
			// Parse timestamp to get date
			let date: Date;
			if (message.ts.includes(".")) {
				// Slack timestamp format (1234567890.123456)
				date = new Date(parseFloat(message.ts) * 1000);
			} else {
				// Epoch milliseconds
				date = new Date(parseInt(message.ts, 10));
			}
			message.date = date.toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	/**
	 * Log a bot response
	 */
	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/**
	 * Get the timestamp of the last logged message for a channel.
	 * Reads only the final 4 KB of the file instead of the full content —
	 * O(1) regardless of log size.
	 */
	getLastTimestamp(channelId: string): string | null {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		if (!existsSync(logPath)) return null;
		try {
			const fd = openSync(logPath, "r");
			const { size } = fstatSync(fd);
			if (size === 0) { closeSync(fd); return null; }
			const readSize = Math.min(size, 4096);
			const buf = Buffer.allocUnsafe(readSize);
			readSync(fd, buf, 0, readSize, size - readSize);
			closeSync(fd);
			// Find the last complete JSON line in the tail
			const tail = buf.toString("utf-8");
			const lastLine = tail.split("\n").filter((l) => l.trim()).pop();
			if (!lastLine) return null;
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}

	/**
	 * Drain the download queue with up to MAX_CONCURRENT_DOWNLOADS parallel fetches.
	 * Each completed download immediately picks up the next queued item, so throughput
	 * stays at MAX_CONCURRENT_DOWNLOADS as long as the queue is non-empty.
	 */
	private processDownloadQueue(): void {
		while (this.activeDownloads < MAX_CONCURRENT_DOWNLOADS && this.pendingDownloads.length > 0) {
			const item = this.pendingDownloads.shift()!;
			this.activeDownloads++;
			this.downloadAttachment(item.localPath, item.url)
				.catch((err) => {
					const msg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to download attachment", `${item.localPath}: ${msg}`);
				})
				.finally(() => {
					this.activeDownloads--;
					// Re-enter the drainer — picks up any items added while this was in-flight.
					this.processDownloadQueue();
				});
		}
	}

	/**
	 * Download a single attachment
	 */
	private async downloadAttachment(localPath: string, url: string): Promise<void> {
		const filePath = join(this.workingDir, localPath);

		// Ensure directory exists
		const dir = join(this.workingDir, localPath.substring(0, localPath.lastIndexOf("/")));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${this.botToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		// Guard: Slack returns HTML login page if bot lacks files:read scope
		const contentType = response.headers.get("content-type") || "";
		if (contentType.includes("text/html")) {
			throw new Error(`Slack returned HTML instead of file — bot token likely missing files:read scope`);
		}

		const buffer = await response.arrayBuffer();
		await writeFile(filePath, Buffer.from(buffer));
	}
}
