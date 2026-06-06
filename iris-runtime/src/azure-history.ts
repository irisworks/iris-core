/**
 * Platform conversation history backed by Azure Blob Storage.
 *
 * Each platform (slack | telegram | ui) keeps a separate JSONL history blob
 * per agent per channel:
 *
 *   {agentId}/slack/{channelId}.jsonl
 *   {agentId}/telegram/{channelId}.jsonl
 *   {agentId}/ui/{channelId}.jsonl
 *
 * Each line is a LogEntry:
 *   { date, ts, user, text, isBot }
 *
 * The host reads history before every bridge call and writes new entries
 * after each exchange so the sub-agent always has full context.
 */

import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export type Platform = "slack" | "telegram" | "ui";

export interface LogEntry {
	date: string;
	ts: string;
	user: string;
	text: string;
	attachments: never[];
	isBot: boolean;
}

// ============================================================================
// Client singleton
// ============================================================================

function getClient(): BlobServiceClient | null {
	const account = process.env.AZURE_STORAGE_ACCOUNT;
	const key = process.env.AZURE_STORAGE_KEY;
	if (!account || !key) return null;
	const cred = new StorageSharedKeyCredential(account, key);
	return new BlobServiceClient(`https://${account}.blob.core.windows.net`, cred);
}

function getContainerName(): string {
	return process.env.AZURE_HISTORY_CONTAINER ?? "iris-history";
}

function blobPath(agentId: string, platform: Platform, channelId: string): string {
	return `${agentId}/${platform}/${channelId}.jsonl`;
}

// ============================================================================
// Public API
// ============================================================================

const MAX_HISTORY_ENTRIES = 80;

/**
 * Read the last N log entries for this agent+platform+channel from Azure Blob.
 * Returns [] if the blob doesn't exist or credentials are missing.
 */
export async function readHistory(
	agentId: string,
	platform: Platform,
	channelId: string,
): Promise<LogEntry[]> {
	const client = getClient();
	if (!client) return [];

	try {
		const cc = client.getContainerClient(getContainerName());
		const bc = cc.getBlobClient(blobPath(agentId, platform, channelId));
		const exists = await bc.exists();
		if (!exists) return [];

		const downloaded = await bc.downloadToBuffer();
		const lines = downloaded.toString("utf-8").split("\n").filter(Boolean);
		const entries: LogEntry[] = [];
		for (const line of lines) {
			try { entries.push(JSON.parse(line) as LogEntry); } catch { /* skip malformed */ }
		}
		// Return only the tail so we don't flood the bridge with a giant payload
		return entries.slice(-MAX_HISTORY_ENTRIES);
	} catch (err) {
		log.logWarning("[azure-history] readHistory failed", err instanceof Error ? err.message : String(err));
		return [];
	}
}

/**
 * Append one or more log entries to the history blob.
 * Creates the blob if it doesn't exist.  Non-blocking — errors are logged only.
 */
export async function appendHistory(
	agentId: string,
	platform: Platform,
	channelId: string,
	entries: LogEntry[],
): Promise<void> {
	const client = getClient();
	if (!client || entries.length === 0) return;

	try {
		const cc = client.getContainerClient(getContainerName());
		await cc.createIfNotExists();

		const path = blobPath(agentId, platform, channelId);
		const bc = cc.getBlobClient(path);

		// Download existing content (if any) and append
		let existing = "";
		if (await bc.exists()) {
			const buf = await bc.downloadToBuffer();
			existing = buf.toString("utf-8");
			if (existing && !existing.endsWith("\n")) existing += "\n";
		}

		const newLines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
		const combined = existing + newLines;

		const blockBlob = cc.getBlockBlobClient(path);
		await blockBlob.upload(combined, Buffer.byteLength(combined), {
			blobHTTPHeaders: { blobContentType: "application/x-ndjson" },
		});
	} catch (err) {
		log.logWarning("[azure-history] appendHistory failed", err instanceof Error ? err.message : String(err));
	}
}

/**
 * Build a user LogEntry from a message received from Slack or Telegram.
 */
export function makeUserEntry(userId: string, text: string): LogEntry {
	const now = new Date();
	return {
		date: now.toISOString(),
		ts: String(now.getTime()),
		user: userId,
		text,
		attachments: [],
		isBot: false,
	};
}

/**
 * Build a bot LogEntry from a bridge response.
 */
export function makeBotEntry(text: string): LogEntry {
	const now = new Date();
	return {
		date: now.toISOString(),
		ts: String(now.getTime()),
		user: "bot",
		text,
		attachments: [],
		isBot: true,
	};
}
