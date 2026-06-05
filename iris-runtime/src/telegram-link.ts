/**
 * TelegramLinkManager — manages the sub-agent ↔ Telegram bot pairing.
 *
 * Claim tokens (pending links):
 *   - Generated per sub-agent on explicit user request ("Connect Telegram")
 *   - Stored locally in <workingDir>/data/telegram-link-tokens.json (durable, fast)
 *   - Single-use, expire after TOKEN_TTL_MS (10 minutes)
 *   - Cryptographically random (64 hex chars)
 *
 * Active links:
 *   - Stored in Supabase (sub_agent_telegram_links table)
 *   - One-to-one enforced: one bot ↔ one agent
 *   - Persists across process restarts
 *
 * Linked-agent lookup is cached per-bot in memory to avoid a Supabase round-trip
 * on every incoming Telegram message. Cache is invalidated on link/unlink.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { getDb } from "./db.js";
import { getSubAgent, type SubAgentRecord } from "./sub-agent-registry.js";
import { bridgeUrlForAgent } from "./agent-provision.js";
import * as log from "./log.js";

// ============================================================================
// Constants
// ============================================================================

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================================
// Types
// ============================================================================

interface PendingToken {
	agentId: string;
	expiresAt: string;
}

interface TokenStore {
	tokens: Record<string, PendingToken>; // token → { agentId, expiresAt }
}

export interface LinkedAgentInfo {
	agentId: string;
	agentName: string;
	bridgeUrl: string;
	slotIndex: number;
	skills: string[];
}

// ============================================================================
// TelegramLinkManager
// ============================================================================

export class TelegramLinkManager {
	private filePath: string;
	private tokens: Record<string, PendingToken> = {};
	// Memory cache: botId → LinkedAgentInfo (null means "looked up, not linked")
	private cache = new Map<string, LinkedAgentInfo | null>();

	constructor(workingDir: string) {
		const dataDir = join(workingDir, "data");
		if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
		this.filePath = join(dataDir, "telegram-link-tokens.json");
		this.loadTokens();
	}

	// ── Token file I/O ──────────────────────────────────────────────────────

	private loadTokens(): void {
		if (!existsSync(this.filePath)) return;
		try {
			const data = JSON.parse(readFileSync(this.filePath, "utf-8")) as TokenStore;
			this.tokens = data.tokens ?? {};
		} catch { /* start fresh */ }
	}

	private saveTokens(): void {
		try {
			writeFileSync(this.filePath, JSON.stringify({ tokens: this.tokens }, null, 2));
		} catch (err) {
			log.logWarning("[telegram-link] saveTokens failed", String(err));
		}
	}

	// ── Token generation & resolution ───────────────────────────────────────

	/**
	 * Generate a single-use claim token for a sub-agent.
	 * Any previously generated (unused) token for this agent is invalidated.
	 * Throws if the agent is already actively linked to a Telegram bot.
	 */
	async generateToken(agentId: string): Promise<string> {
		const db = getDb();
		if (db) {
			// Reject if the agent is already linked
			let existingRow: Record<string, unknown> | null = null;
			try {
				const { data } = await db
					.from("sub_agent_telegram_links")
					.select("bot_id, linked_at")
					.eq("agent_id", agentId)
					.maybeSingle();
				existingRow = data as Record<string, unknown> | null;
			} catch { /* ignore */ }
			if (existingRow?.linked_at) {
				throw new Error(`Sub-agent ${agentId} is already linked to a Telegram bot. Unlink it first.`);
			}
		}

		// Invalidate any existing token for this agent
		for (const [t, entry] of Object.entries(this.tokens)) {
			if (entry.agentId === agentId) delete this.tokens[t];
		}

		const token = randomBytes(32).toString("hex");
		this.tokens[token] = {
			agentId,
			expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
		};
		this.saveTokens();
		log.logInfo(`[telegram-link] Claim token generated for agent ${agentId}`);
		return token;
	}

	/**
	 * Resolve a raw token string to its agent ID. Returns null if invalid or expired.
	 */
	private resolveToken(token: string): string | null {
		const entry = this.tokens[token];
		if (!entry) return null;
		if (new Date(entry.expiresAt).getTime() < Date.now()) {
			delete this.tokens[token];
			this.saveTokens();
			return null;
		}
		return entry.agentId;
	}

	private invalidateToken(token: string): void {
		delete this.tokens[token];
		this.saveTokens();
	}

	// ── Link management ──────────────────────────────────────────────────────

	/**
	 * Get the sub-agent linked to a Telegram bot (with bridge URL).
	 * Returns null if the bot is not linked. Caches the result in memory.
	 */
	async getLinkedAgent(botId: string): Promise<LinkedAgentInfo | null> {
		if (this.cache.has(botId)) return this.cache.get(botId)!;

		const db = getDb();
		if (!db) return null;

		try {
			const { data, error } = await db
				.from("sub_agent_telegram_links")
				.select("agent_id, linked_at")
				.eq("bot_id", botId)
				.maybeSingle();
			if (error || !data) { this.cache.set(botId, null); return null; }
			const row = data as Record<string, unknown>;
			if (!row.linked_at || !row.agent_id) { this.cache.set(botId, null); return null; }

			const agent = await getSubAgent(row.agent_id as string);
			if (!agent) { this.cache.set(botId, null); return null; }

			const info: LinkedAgentInfo = {
				agentId:   agent.agentId,
				agentName: agent.name,
				bridgeUrl: bridgeUrlForAgent(agent.slotIndex, agent.runtime),
				slotIndex: agent.slotIndex,
				skills:    agent.skills,
			};
			this.cache.set(botId, info);
			return info;
		} catch (err) {
			log.logWarning("[telegram-link] getLinkedAgent failed", String(err));
			return null;
		}
	}

	/**
	 * Validate a claim token sent to a Telegram bot and establish the link.
	 *
	 * Returns the linked agent's name on success.
	 * Returns null on invalid token.
	 * Returns "expired" if token was found but expired.
	 * Returns "already_linked" if bot or agent is already paired with something else.
	 */
	async validateAndLink(
		botId: string,
		token: string,
	): Promise<{ agentName: string } | "expired" | "already_linked" | null> {
		// Check if the token was ever generated (present even if expired for expired signal)
		const tokenEntry = this.tokens[token];
		const agentId = this.resolveToken(token);

		if (!agentId) {
			if (tokenEntry) return "expired"; // was in store but expired
			return null;                       // never issued
		}

		// Enforce one-to-one: bot not already linked to a different agent
		const existing = await this.getLinkedAgent(botId);
		if (existing && existing.agentId !== agentId) return "already_linked";

		const db = getDb();
		if (!db) {
			log.logWarning("[telegram-link] validateAndLink: Supabase not configured");
			return null;
		}

		// Enforce one-to-one: agent not already linked to a different bot
		try {
			const { data } = await db
				.from("sub_agent_telegram_links")
				.select("bot_id, linked_at")
				.eq("agent_id", agentId)
				.maybeSingle();
			if (data) {
				const row = data as Record<string, unknown>;
				if (row.linked_at && row.bot_id !== botId) return "already_linked";
			}
		} catch { /* proceed */ }

		const agent = await getSubAgent(agentId);
		if (!agent) return null;

		try {
			await db.from("sub_agent_telegram_links").upsert({
				bot_id:     botId,
				agent_id:   agentId,
				linked_at:  new Date().toISOString(),
				updated_at: new Date().toISOString(),
			}, { onConflict: "bot_id" });
		} catch (err) {
			log.logWarning("[telegram-link] validateAndLink upsert failed", String(err));
			return null;
		}

		this.invalidateToken(token);
		this.cache.delete(botId); // invalidate cache so next getLinkedAgent re-reads

		log.logInfo(`[telegram-link] Bot ${botId} linked to agent "${agent.name}" (${agentId})`);
		return { agentName: agent.name };
	}

	/**
	 * Unlink a Telegram bot from its sub-agent.
	 * After this, the bot accepts new claim tokens again.
	 */
	async unlink(botId: string): Promise<boolean> {
		const db = getDb();
		if (!db) return false;
		try {
			await db.from("sub_agent_telegram_links").delete().eq("bot_id", botId);
			this.cache.delete(botId);
			log.logInfo(`[telegram-link] Bot ${botId} unlinked`);
			return true;
		} catch (err) {
			log.logWarning("[telegram-link] unlink failed", String(err));
			return false;
		}
	}

	/**
	 * Unlink a sub-agent from its Telegram bot (from the agent side).
	 * Used when deleting a sub-agent or from the agent management UI.
	 */
	async unlinkAgent(agentId: string): Promise<boolean> {
		const db = getDb();
		if (!db) return false;
		try {
			let botId: string | undefined;
			try {
				const { data } = await db
					.from("sub_agent_telegram_links")
					.select("bot_id")
					.eq("agent_id", agentId)
					.maybeSingle();
				botId = data ? (data as Record<string, unknown>).bot_id as string | undefined : undefined;
			} catch { /* ignore */ }

			await db.from("sub_agent_telegram_links").delete().eq("agent_id", agentId);
			if (botId) this.cache.delete(botId);
			log.logInfo(`[telegram-link] Agent ${agentId} unlinked from Telegram`);
			return true;
		} catch (err) {
			log.logWarning("[telegram-link] unlinkAgent failed", String(err));
			return false;
		}
	}

	/**
	 * Register a bot in the links table (creates a row with no agent, if missing).
	 * Called on bot startup so the bot exists in the table even before linking.
	 */
	async registerBot(botId: string): Promise<void> {
		const db = getDb();
		if (!db) return;
		try {
			await db.from("sub_agent_telegram_links").upsert(
				{ bot_id: botId, updated_at: new Date().toISOString() },
				{ onConflict: "bot_id", ignoreDuplicates: true },
			);
		} catch (err) {
			log.logWarning("[telegram-link] registerBot failed", String(err));
		}
	}

	/**
	 * Invalidate the cache for a specific bot (e.g., after the sub-agent's status changes).
	 */
	invalidateCache(botId: string): void {
		this.cache.delete(botId);
	}

	/**
	 * Return the full sub-agent record for an agent linked to the given bot.
	 * Convenience wrapper used by the watchdog and scheduler.
	 */
	async getLinkedAgentRecord(botId: string): Promise<SubAgentRecord | null> {
		const info = await this.getLinkedAgent(botId);
		if (!info) return null;
		return getSubAgent(info.agentId);
	}

	/**
	 * Return the bot_id linked to a given sub-agent, or null if unlinked.
	 * Used by the API when creating tasks that need a delivery bot.
	 */
	async getBotForAgent(agentId: string): Promise<string | null> {
		const db = getDb();
		if (!db) return null;
		try {
			const { data, error } = await db
				.from("sub_agent_telegram_links")
				.select("bot_id, linked_at")
				.eq("agent_id", agentId)
				.maybeSingle();
			if (error || !data) return null;
			const row = data as Record<string, unknown>;
			return row.linked_at ? (row.bot_id as string) : null;
		} catch (err) {
			log.logWarning("[telegram-link] getBotForAgent failed", String(err));
			return null;
		}
	}
}
