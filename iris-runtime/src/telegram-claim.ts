import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
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
const EMPTY_STATE: ClaimState = { claimed: false, chatId: null, pendingToken: null, tokenExpiresAt: null };

// ============================================================================
// TelegramClaimManager
// ============================================================================
//
// One claim file per bot, keyed by botId:
//   /iris/data/data/telegram-owner-{botId}.json
//
// Migration: if the legacy shared file (telegram-owner.json) exists and the
// per-bot file does not, the legacy file is renamed so the bot stays claimed.
//
// When botId is "pending" (pre-start placeholder) the file is not written.
// ============================================================================

export class TelegramClaimManager {
	private filePath: string;
	private state: ClaimState;
	private readonly isPending: boolean;

	constructor(workingDir: string, botId: string) {
		const dataDir = join(workingDir, "data");
		if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

		this.isPending = botId === "pending";

		if (this.isPending) {
			// Pre-start placeholder — reads nothing, writes nothing
			this.filePath = "";
			this.state = { ...EMPTY_STATE };
			return;
		}

		this.filePath = join(dataDir, `telegram-owner-${botId}.json`);

		// Migrate legacy shared file on first use of this botId
		const legacyPath = join(dataDir, "telegram-owner.json");
		if (!existsSync(this.filePath) && existsSync(legacyPath)) {
			try {
				renameSync(legacyPath, this.filePath);
			} catch { /* leave legacy in place if rename fails */ }
		}

		this.state = this.load();
	}

	private load(): ClaimState {
		if (!this.filePath || !existsSync(this.filePath)) return { ...EMPTY_STATE };
		try {
			return JSON.parse(readFileSync(this.filePath, "utf-8")) as ClaimState;
		} catch {
			return { ...EMPTY_STATE };
		}
	}

	private save(): void {
		if (this.isPending || !this.filePath) return;
		writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
	}

	isClaimed(): boolean {
		return this.state.claimed;
	}

	isOwner(chatId: number): boolean {
		return this.state.claimed && this.state.chatId === chatId;
	}

	generateToken(): string {
		const token = randomBytes(32).toString("hex");
		this.state.pendingToken = token;
		this.state.tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
		this.save();
		return token;
	}

	tryClaimWith(chatId: number, token: string): "claimed" | "invalid" | "expired" {
		if (!this.state.pendingToken) return "invalid";
		if (new Date(this.state.tokenExpiresAt!).getTime() < Date.now()) {
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

	reset(): void {
		this.state = { ...EMPTY_STATE };
		this.save();
	}

	getOwnerId(): number | null {
		return this.state.chatId;
	}
}
