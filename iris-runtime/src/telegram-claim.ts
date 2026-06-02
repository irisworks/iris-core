import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";

// ============================================================================
// Types
// ============================================================================

interface ClaimState {
	claimed: boolean;
	chatId: number | null;
	pendingToken: string | null;
	tokenExpiresAt: string | null; // ISO timestamp
}

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

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
			return { claimed: false, chatId: null, pendingToken: null, tokenExpiresAt: null };
		}
		try {
			return JSON.parse(readFileSync(this.filePath, "utf-8")) as ClaimState;
		} catch {
			return { claimed: false, chatId: null, pendingToken: null, tokenExpiresAt: null };
		}
	}

	private save(): void {
		writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
	}

	isClaimed(): boolean {
		return this.state.claimed;
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

	// Reset claim state so a new owner can claim.
	reset(): void {
		this.state = { claimed: false, chatId: null, pendingToken: null, tokenExpiresAt: null };
		this.save();
	}

	getOwnerId(): number | null {
		return this.state.chatId;
	}
}
