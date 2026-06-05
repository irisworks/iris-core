import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { getDb } from "./db.js";

// ============================================================================
// Types
// ============================================================================

interface ClaimState {
	claimed: boolean;
	chatId: number | null;
	pendingToken: string | null;
	tokenExpiresAt: string | null;
	pendingTransferChatId: number | null;
}

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const EMPTY_STATE: ClaimState = {
	claimed: false,
	chatId: null,
	pendingToken: null,
	tokenExpiresAt: null,
	pendingTransferChatId: null,
};

// ============================================================================
// TelegramClaimManager
// ============================================================================
//
// Dual-write storage: local JSON file (fast, survives process restarts) +
// Supabase (durable, survives Firecracker ephemeral rootfs resets).
//
// Construction loads from local file synchronously.
// Call await initialize() after construction to pull authoritative state from
// Supabase — Supabase wins because it is more durable than the local file.
//
// All public methods are synchronous (operate on in-memory state).
// save() writes to file immediately, fires a background Supabase upsert.
//
// One claim file per bot: <workingDir>/data/telegram-owner-{botId}.json
// ============================================================================

export class TelegramClaimManager {
	private filePath: string;
	private state: ClaimState;
	private readonly isPending: boolean;
	private readonly botId: string;

	constructor(workingDir: string, botId: string) {
		this.botId = botId;
		this.isPending = botId === "pending";

		if (this.isPending) {
			this.filePath = "";
			this.state = { ...EMPTY_STATE };
			return;
		}

		const dataDir = join(workingDir, "data");
		if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
		this.filePath = join(dataDir, `telegram-owner-${botId}.json`);

		// Migrate legacy shared file on first use of this botId
		const legacyPath = join(dataDir, "telegram-owner.json");
		if (!existsSync(this.filePath) && existsSync(legacyPath)) {
			try { renameSync(legacyPath, this.filePath); } catch { /* leave legacy in place */ }
		}

		this.state = this.loadFromFile();
	}

	/**
	 * Pull authoritative state from Supabase. Call once after construction in
	 * an async context (e.g., TelegramBot.start()). Supabase wins over the local
	 * file because it survives Firecracker VM restarts with ephemeral rootfs.
	 */
	async initialize(): Promise<void> {
		if (this.isPending) return;
		const db = getDb();
		if (!db) return;
		try {
			const { data, error } = await db
				.from("telegram_claim")
				.select("claimed, chat_id, pending_token, token_expires_at, pending_transfer_chat_id")
				.eq("bot_id", this.botId)
				.maybeSingle();
			if (error || !data) return;
			this.state = {
				claimed: (data.claimed as boolean) ?? false,
				chatId: (data.chat_id as number | null) ?? null,
				pendingToken: (data.pending_token as string | null) ?? null,
				tokenExpiresAt: (data.token_expires_at as string | null) ?? null,
				pendingTransferChatId: (data.pending_transfer_chat_id as number | null) ?? null,
			};
			// Keep local file in sync with Supabase state
			if (this.filePath) writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
		} catch { /* Supabase unavailable — continue with file state */ }
	}

	private loadFromFile(): ClaimState {
		if (!this.filePath || !existsSync(this.filePath)) return { ...EMPTY_STATE };
		try {
			const raw = JSON.parse(readFileSync(this.filePath, "utf-8")) as Record<string, unknown>;
			return {
				claimed: (raw.claimed as boolean) ?? false,
				chatId: (raw.chatId as number | null) ?? null,
				pendingToken: (raw.pendingToken as string | null) ?? null,
				tokenExpiresAt: (raw.tokenExpiresAt as string | null) ?? null,
				pendingTransferChatId: (raw.pendingTransferChatId as number | null) ?? null,
			};
		} catch {
			return { ...EMPTY_STATE };
		}
	}

	private save(): void {
		if (this.isPending || !this.filePath) return;
		writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
		// Fire-and-forget Supabase sync — never blocks the caller
		const db = getDb();
		if (!db) return;
		void Promise.resolve(
			db.from("telegram_claim").upsert({
				bot_id: this.botId,
				claimed: this.state.claimed,
				chat_id: this.state.chatId,
				pending_token: this.state.pendingToken,
				token_expires_at: this.state.tokenExpiresAt,
				pending_transfer_chat_id: this.state.pendingTransferChatId,
				updated_at: new Date().toISOString(),
			})
		).catch(() => {});
	}

	// ---------------------------------------------------------------------------
	// Read accessors (synchronous)
	// ---------------------------------------------------------------------------

	isClaimed(): boolean { return this.state.claimed; }

	isOwner(chatId: number): boolean {
		return this.state.claimed && this.state.chatId === chatId;
	}

	getOwnerId(): number | null { return this.state.chatId; }

	getPendingTransferChatId(): number | null { return this.state.pendingTransferChatId; }

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

	// ---------------------------------------------------------------------------
	// Mutators
	// ---------------------------------------------------------------------------

	generateToken(): string {
		const token = randomBytes(32).toString("hex");
		this.state.pendingToken = token;
		this.state.tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
		this.save();
		return token;
	}

	/**
	 * Attempt to claim the bot with the given token.
	 *
	 *   "claimed"          — success, chatId is now owner
	 *   "transfer_pending" — bot already owned by a different chatId; pending
	 *                        transfer stored, current owner must reply 1 to allow
	 *   "expired"          — token expired
	 *   "invalid"          — token mismatch or no pending token
	 */
	tryClaimWith(chatId: number, token: string): "claimed" | "transfer_pending" | "expired" | "invalid" {
		if (!this.state.pendingToken) return "invalid";

		if (new Date(this.state.tokenExpiresAt!).getTime() < Date.now()) {
			this.state.pendingToken = null;
			this.state.tokenExpiresAt = null;
			this.save();
			return "expired";
		}

		if (this.state.pendingToken !== token) return "invalid";

		// Bot already owned by a different user — request ownership transfer
		if (this.state.claimed && this.state.chatId !== chatId) {
			this.state.pendingTransferChatId = chatId;
			this.save();
			return "transfer_pending";
		}

		this.state.claimed = true;
		this.state.chatId = chatId;
		this.state.pendingToken = null;
		this.state.tokenExpiresAt = null;
		this.state.pendingTransferChatId = null;
		this.save();
		return "claimed";
	}

	/** Current owner confirmed the transfer — hand ownership to the pending chat. */
	confirmTransfer(): void {
		if (!this.state.pendingTransferChatId) return;
		this.state.chatId = this.state.pendingTransferChatId;
		this.state.pendingTransferChatId = null;
		this.state.pendingToken = null;
		this.state.tokenExpiresAt = null;
		this.save();
	}

	/** Current owner rejected the transfer — discard the pending request. */
	rejectTransfer(): void {
		this.state.pendingTransferChatId = null;
		this.save();
	}

	reset(): void {
		this.state = { ...EMPTY_STATE };
		this.save();
	}
}
