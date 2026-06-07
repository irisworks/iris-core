/**
 * SlackLinkManager — manages the sub-agent ↔ Slack workspace pairing.
 *
 * Mirrors TelegramLinkManager exactly, using workspace_id (Slack team ID)
 * in place of bot_id.
 *
 * Claim tokens (pending links):
 *   - Generated per sub-agent on explicit user request ("Connect Slack")
 *   - Stored locally in <workingDir>/data/slack-link-tokens.json (durable, fast)
 *   - Single-use, expire after TOKEN_TTL_MS (10 minutes)
 *   - Cryptographically random (64 hex chars)
 *
 * Active links:
 *   - Stored in Supabase (sub_agent_slack_links table)
 *   - One-to-one enforced: one workspace ↔ one agent
 *   - Persists across process restarts
 *
 * Linked-agent lookup is cached per-workspace in memory to avoid a
 * Supabase round-trip on every incoming Slack message.
 * Cache is invalidated on link/unlink.
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
	runtime: "docker" | "firecracker";
}

// ============================================================================
// SlackLinkManager
// ============================================================================

export class SlackLinkManager {
	private filePath: string;
	private tokens: Record<string, PendingToken> = {};
	// Memory cache: workspaceId → LinkedAgentInfo (null = looked up, not linked)
	private cache = new Map<string, LinkedAgentInfo | null>();

	constructor(workingDir: string) {
		const dataDir = join(workingDir, "data");
		if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
		this.filePath = join(dataDir, "slack-link-tokens.json");
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
			log.logWarning("[slack-link] saveTokens failed", String(err));
		}
	}

	// ── Token generation & resolution ───────────────────────────────────────

	/**
	 * Generate a single-use claim token for a sub-agent.
	 * Any previously generated (unused) token for this agent is invalidated.
	 * Throws if the agent is already actively linked to a Slack workspace.
	 */
	async generateToken(agentId: string): Promise<string> {
		const db = getDb();
		if (db) {
			let existingRow: Record<string, unknown> | null = null;
			try {
				const { data } = await db
					.from("sub_agent_slack_links")
					.select("workspace_id, linked_at")
					.eq("agent_id", agentId)
					.maybeSingle();
				existingRow = data as Record<string, unknown> | null;
			} catch { /* ignore */ }
			if (existingRow?.linked_at) {
				throw new Error(`Sub-agent ${agentId} is already linked to a Slack workspace. Unlink it first.`);
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
		log.logInfo(`[slack-link] Claim token generated for agent ${agentId}`);
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
	 * Get the sub-agent linked to a Slack workspace (with bridge URL).
	 * Returns null if not linked. Caches in memory.
	 */
	async getLinkedAgent(workspaceId: string): Promise<LinkedAgentInfo | null> {
		if (this.cache.has(workspaceId)) return this.cache.get(workspaceId)!;

		const db = getDb();
		if (!db) return null;

		try {
			const { data, error } = await db
				.from("sub_agent_slack_links")
				.select("agent_id, linked_at")
				.eq("workspace_id", workspaceId)
				.maybeSingle();
			if (error || !data) { this.cache.set(workspaceId, null); return null; }
			const row = data as Record<string, unknown>;
			if (!row.linked_at || !row.agent_id) { this.cache.set(workspaceId, null); return null; }

			const agent = await getSubAgent(row.agent_id as string);
			if (!agent) { this.cache.set(workspaceId, null); return null; }

			const info: LinkedAgentInfo = {
				agentId:   agent.agentId,
				agentName: agent.name,
				bridgeUrl: bridgeUrlForAgent(agent.slotIndex, agent.runtime),
				slotIndex: agent.slotIndex,
				skills:    agent.skills,
				runtime:   agent.runtime,
			};
			this.cache.set(workspaceId, info);
			return info;
		} catch (err) {
			log.logWarning("[slack-link] getLinkedAgent failed", String(err));
			return null;
		}
	}

	/**
	 * Validate a claim token sent to a Slack bot and establish the link.
	 *
	 * Returns the linked agent's name on success.
	 * Returns null on invalid token.
	 * Returns "expired" if token was found but expired.
	 * Returns "already_linked" if workspace or agent is already paired with something else.
	 */
	async validateAndLink(
		workspaceId: string,
		token: string,
	): Promise<{ agentName: string } | "expired" | "already_linked" | null> {
		const tokenEntry = this.tokens[token];
		const agentId = this.resolveToken(token);

		if (!agentId) {
			if (tokenEntry) return "expired"; // was in store but expired
			return null;                       // never issued
		}

		// Enforce one-to-one: workspace not already linked to a different agent
		const existing = await this.getLinkedAgent(workspaceId);
		if (existing && existing.agentId !== agentId) return "already_linked";

		const db = getDb();
		if (!db) {
			log.logWarning("[slack-link] validateAndLink: Supabase not configured");
			return null;
		}

		// Enforce one-to-one: agent not already linked to a different workspace
		try {
			const { data } = await db
				.from("sub_agent_slack_links")
				.select("workspace_id, linked_at")
				.eq("agent_id", agentId)
				.maybeSingle();
			if (data) {
				const row = data as Record<string, unknown>;
				if (row.linked_at && row.workspace_id !== workspaceId) return "already_linked";
			}
		} catch { /* proceed */ }

		const agent = await getSubAgent(agentId);
		if (!agent) return null;

		try {
			await db.from("sub_agent_slack_links").upsert({
				workspace_id: workspaceId,
				agent_id:     agentId,
				linked_at:    new Date().toISOString(),
				updated_at:   new Date().toISOString(),
			}, { onConflict: "workspace_id" });
		} catch (err) {
			log.logWarning("[slack-link] validateAndLink upsert failed", String(err));
			return null;
		}

		this.invalidateToken(token);
		this.cache.delete(workspaceId);

		log.logInfo(`[slack-link] Workspace ${workspaceId} linked to agent "${agent.name}" (${agentId})`);
		return { agentName: agent.name };
	}

	/**
	 * Unlink a Slack workspace from its sub-agent.
	 */
	async unlink(workspaceId: string): Promise<boolean> {
		const db = getDb();
		if (!db) return false;
		try {
			await db.from("sub_agent_slack_links").delete().eq("workspace_id", workspaceId);
			this.cache.delete(workspaceId);
			log.logInfo(`[slack-link] Workspace ${workspaceId} unlinked`);
			return true;
		} catch (err) {
			log.logWarning("[slack-link] unlink failed", String(err));
			return false;
		}
	}

	/**
	 * Unlink a sub-agent from its Slack workspace (from the agent side).
	 * Used when deleting a sub-agent or from the agent management UI.
	 */
	async unlinkAgent(agentId: string): Promise<boolean> {
		const db = getDb();
		if (!db) return false;
		try {
			let workspaceId: string | undefined;
			try {
				const { data } = await db
					.from("sub_agent_slack_links")
					.select("workspace_id")
					.eq("agent_id", agentId)
					.maybeSingle();
				workspaceId = data ? (data as Record<string, unknown>).workspace_id as string | undefined : undefined;
			} catch { /* ignore */ }

			await db.from("sub_agent_slack_links").delete().eq("agent_id", agentId);
			if (workspaceId) this.cache.delete(workspaceId);
			log.logInfo(`[slack-link] Agent ${agentId} unlinked from Slack`);
			return true;
		} catch (err) {
			log.logWarning("[slack-link] unlinkAgent failed", String(err));
			return false;
		}
	}

	/**
	 * Return the workspace_id linked to a given sub-agent, or null if unlinked.
	 */
	async getWorkspaceForAgent(agentId: string): Promise<string | null> {
		const db = getDb();
		if (!db) return null;
		try {
			const { data, error } = await db
				.from("sub_agent_slack_links")
				.select("workspace_id, linked_at")
				.eq("agent_id", agentId)
				.maybeSingle();
			if (error || !data) return null;
			const row = data as Record<string, unknown>;
			return row.linked_at ? (row.workspace_id as string) : null;
		} catch (err) {
			log.logWarning("[slack-link] getWorkspaceForAgent failed", String(err));
			return null;
		}
	}

	/**
	 * Invalidate the cache for a specific workspace.
	 */
	invalidateCache(workspaceId: string): void {
		this.cache.delete(workspaceId);
	}

	/**
	 * Return the full sub-agent record for the agent linked to the given workspace.
	 */
	async getLinkedAgentRecord(workspaceId: string): Promise<SubAgentRecord | null> {
		const info = await this.getLinkedAgent(workspaceId);
		if (!info) return null;
		return getSubAgent(info.agentId);
	}
}
