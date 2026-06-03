import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

interface BotEntry {
	username: string;
	registeredAt: string;
	lastSeenAt: string;
}

interface RegistryData {
	bots: Record<string, BotEntry>;
}

const MAX_BOTS = 5;

// ============================================================================
// TelegramBotRegistry
// ============================================================================

export class TelegramBotRegistry {
	private filePath: string;
	private data: RegistryData;

	constructor(workingDir: string) {
		const dir = join(workingDir, "telegram");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		this.filePath = join(dir, "bots.json");
		this.data = this.load();
	}

	private load(): RegistryData {
		if (!existsSync(this.filePath)) {
			return { bots: {} };
		}
		try {
			return JSON.parse(readFileSync(this.filePath, "utf-8")) as RegistryData;
		} catch {
			return { bots: {} };
		}
	}

	private save(): void {
		writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
	}

	/**
	 * Attempt to register a bot.
	 * Returns true if allowed to start, false if the 5-bot cap is reached.
	 */
	register(botId: string, username: string): boolean {
		const now = new Date().toISOString();

		if (this.data.bots[botId]) {
			// Already registered — update last-seen timestamp only
			this.data.bots[botId].lastSeenAt = now;
			if (username) this.data.bots[botId].username = username;
			this.save();
			return true;
		}

		const count = Object.keys(this.data.bots).length;
		if (count >= MAX_BOTS) {
			log.logWarning(
				`[telegram-registry] Cannot register bot @${username} (id=${botId}): ` +
				`max ${MAX_BOTS} bots already registered. ` +
				`Delete entries from ${this.filePath} to free slots.`,
			);
			return false;
		}

		this.data.bots[botId] = { username, registeredAt: now, lastSeenAt: now };
		this.save();
		log.logInfo(`[telegram-registry] Registered bot @${username} (id=${botId}). ${count + 1}/${MAX_BOTS} slots used.`);
		return true;
	}

	count(): number {
		return Object.keys(this.data.bots).length;
	}

	list(): Array<{ botId: string } & BotEntry> {
		return Object.entries(this.data.bots).map(([botId, entry]) => ({ botId, ...entry }));
	}
}
