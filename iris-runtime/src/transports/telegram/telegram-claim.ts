import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import * as log from "../../engine/log.js";

// ============================================================================
// Types
// ============================================================================

interface ClaimState {
	claimed: boolean;
	chatId: number | null;
	pendingToken: string | null;
	tokenExpiresAt: string | null; // ISO timestamp
	botId: number | null; // Telegram bot id this claim belongs to (from getMe())
}

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function emptyState(botId: number | null = null): ClaimState {
	return { claimed: false, chatId: null, pendingToken: null, tokenExpiresAt: null, botId };
}

// ============================================================================
// TelegramClaimManager
// ============================================================================

export class TelegramClaimManager {
	private filePath: string;
	private state: ClaimState;

	constructor(workingDir: string) {
		const dataDir = join(workingDir, "data");
		if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
		this.filePath = join(dataDir, "telegram-owner.json");
		this.state = this.load();
	}

	private load(): ClaimState {
		if (!existsSync(this.filePath)) {
			return emptyState();
		}
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as Partial<ClaimState>;
			// botId is a newer field — older state files won't have it. Treat missing as
			// "unknown identity" rather than "different identity" so we don't nuke an
			// existing claim purely because of the upgrade.
			return { ...emptyState(), ...parsed, botId: parsed.botId ?? null };
		} catch (err) {
			log.logWarning(
				"[telegram] Failed to parse claim state file — starting unclaimed",
				`${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return emptyState();
		}
	}

	private save(): void {
		try {
			writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
		} catch (err) {
			// In-memory state is still correct for this process; only persistence failed.
			// Surface it loudly since a stuck claim state after a crash/restart is exactly
			// the kind of silent failure that's confusing to debug later.
			log.logWarning(
				"[telegram] Failed to persist claim state — will retry on next change",
				`${this.filePath}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	isClaimed(): boolean {
		return this.state.claimed;
	}

	// Call once at startup with the bot id from getMe(). If the previously-persisted
	// claim belongs to a *different* bot id (i.e. TELEGRAM_BOT_TOKEN was swapped for a
	// different bot), the old claim is meaningless — clear it automatically instead of
	// forcing the operator to figure out IRIS_TELEGRAM_FORCE_RECLAIM. Returns true if a
	// stale claim was cleared.
	syncBotIdentity(botId: number): boolean {
		if (this.state.botId == null) {
			// First time we've recorded an identity for this state file (fresh install,
			// or upgrade from a state file predating this field) — just record it.
			this.state.botId = botId;
			this.save();
			return false;
		}
		if (this.state.botId !== botId) {
			this.state = emptyState(botId);
			this.save();
			return true;
		}
		return false;
	}

	isOwner(chatId: number): boolean {
		return this.state.claimed && this.state.chatId === chatId;
	}

	// Generate a new claim token, replacing any existing pending one.
	generateToken(): string {
		const token = randomBytes(32).toString("hex"); // 64-char hex
		this.state.pendingToken = token;
		this.state.tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
		this.save();
		return token;
	}

	// Attempt to claim the bot with the given token. Returns true on success.
	tryClaimWith(chatId: number, token: string): "claimed" | "invalid" | "expired" {
		if (!this.state.pendingToken) return "invalid";
		if (new Date(this.state.tokenExpiresAt!).getTime() < Date.now()) {
			// Token expired — clear it from disk so it's gone
			this.state.pendingToken = null;
			this.state.tokenExpiresAt = null;
			this.save();
			return "expired";
		}
		if (this.state.pendingToken !== token) return "invalid";

		this.state.claimed = true;
		this.state.chatId = chatId;
		this.state.pendingToken = null;
		this.state.tokenExpiresAt = null;
		this.save();
		return "claimed";
	}

	// Returns the pending token only if it's still valid, clears it if expired.
	getActivePendingToken(): string | null {
		if (!this.state.pendingToken) return null;
		if (new Date(this.state.tokenExpiresAt!).getTime() < Date.now()) {
			this.state.pendingToken = null;
			this.state.tokenExpiresAt = null;
			this.save();
			return null;
		}
		return this.state.pendingToken;
	}

	// Reset claim state so a new owner can claim (same bot, e.g. IRIS_TELEGRAM_FORCE_RECLAIM).
	reset(): void {
		this.state = emptyState(this.state.botId);
		this.save();
	}

	getOwnerId(): number | null {
		return this.state.chatId;
	}
}
