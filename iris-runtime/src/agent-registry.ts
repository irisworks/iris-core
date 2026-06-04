import { getDb } from "./db.js";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export type AgentStatus = "running" | "stopped" | "crashed";

export interface AgentRecord {
	agentId: string;
	botId: string;
	chatId: number;
	name: string;
	dockerContainerId: string | null;
	status: AgentStatus;
	skills: string[];
	slotIndex: number;
	createdAt: string;
	updatedAt: string;
}

export const MAX_AGENTS_PER_BOT = 5;

// ============================================================================
// Helpers
// ============================================================================

function rowToRecord(row: Record<string, unknown>): AgentRecord {
	return {
		agentId: row.agent_id as string,
		botId: row.bot_id as string,
		chatId: row.chat_id as number,
		name: row.name as string,
		dockerContainerId: (row.docker_container_id as string | null) ?? null,
		status: (row.status as AgentStatus) ?? "stopped",
		skills: (row.skills as string[]) ?? [],
		slotIndex: row.slot_index as number,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function noDb(op: string): null {
	log.logWarning(`[agent-registry] ${op}: Supabase not configured — skipping`);
	return null;
}

// ============================================================================
// Registry operations
// ============================================================================

/**
 * Count active (non-crashed/non-deleted) agents for a bot.
 * Returns 0 when Supabase is unavailable (fail open — don't block the user).
 */
export async function countAgents(botId: string): Promise<number> {
	const db = getDb();
	if (!db) return 0;
	try {
		const { count, error } = await db
			.from("telegram_agents")
			.select("agent_id", { count: "exact", head: true })
			.eq("bot_id", botId);
		if (error) throw error;
		return count ?? 0;
	} catch (err) {
		log.logWarning("[agent-registry] countAgents failed", String(err));
		return 0;
	}
}

/**
 * Find the lowest free slot index (1–5) for a bot.
 * Returns null if all 5 slots are occupied.
 */
export async function nextFreeSlot(botId: string): Promise<number | null> {
	const db = getDb();
	if (!db) return 1; // allow creation if Supabase unavailable
	try {
		const { data, error } = await db
			.from("telegram_agents")
			.select("slot_index")
			.eq("bot_id", botId)
			.order("slot_index", { ascending: true });
		if (error) throw error;
		const used = new Set((data ?? []).map((r) => r.slot_index as number));
		for (let i = 1; i <= MAX_AGENTS_PER_BOT; i++) {
			if (!used.has(i)) return i;
		}
		return null; // all slots occupied
	} catch (err) {
		log.logWarning("[agent-registry] nextFreeSlot failed", String(err));
		return 1;
	}
}

/** Retrieve a single agent by its UUID. */
export async function getAgent(agentId: string): Promise<AgentRecord | null> {
	const db = getDb();
	if (!db) return noDb("getAgent");
	try {
		const { data, error } = await db
			.from("telegram_agents")
			.select("*")
			.eq("agent_id", agentId)
			.maybeSingle();
		if (error) throw error;
		return data ? rowToRecord(data as Record<string, unknown>) : null;
	} catch (err) {
		log.logWarning("[agent-registry] getAgent failed", String(err));
		return null;
	}
}

/** Retrieve an agent by bot + name (for uniqueness checks). */
export async function getAgentByName(botId: string, name: string): Promise<AgentRecord | null> {
	const db = getDb();
	if (!db) return noDb("getAgentByName");
	try {
		const { data, error } = await db
			.from("telegram_agents")
			.select("*")
			.eq("bot_id", botId)
			.eq("name", name)
			.maybeSingle();
		if (error) throw error;
		return data ? rowToRecord(data as Record<string, unknown>) : null;
	} catch (err) {
		log.logWarning("[agent-registry] getAgentByName failed", String(err));
		return null;
	}
}

/** List all agents across all bots, ordered by bot_id then slot_index. */
export async function listAllAgents(): Promise<AgentRecord[]> {
	const db = getDb();
	if (!db) { noDb("listAllAgents"); return []; }
	try {
		const { data, error } = await db
			.from("telegram_agents")
			.select("*")
			.order("bot_id", { ascending: true })
			.order("slot_index", { ascending: true });
		if (error) throw error;
		return (data ?? []).map((r) => rowToRecord(r as Record<string, unknown>));
	} catch (err) {
		log.logWarning("[agent-registry] listAllAgents failed", String(err));
		return [];
	}
}

/** List all agents for a bot, ordered by slot_index. */
export async function listAgents(botId: string): Promise<AgentRecord[]> {
	const db = getDb();
	if (!db) { noDb("listAgents"); return []; }
	try {
		const { data, error } = await db
			.from("telegram_agents")
			.select("*")
			.eq("bot_id", botId)
			.order("slot_index", { ascending: true });
		if (error) throw error;
		return (data ?? []).map((r) => rowToRecord(r as Record<string, unknown>));
	} catch (err) {
		log.logWarning("[agent-registry] listAgents failed", String(err));
		return [];
	}
}

/**
 * Create a new agent record. Automatically assigns the next free slot.
 * Returns null if all 5 slots are occupied or Supabase is unavailable.
 */
export async function createAgent(params: {
	botId: string;
	chatId: number;
	name: string;
	skills: string[];
}): Promise<AgentRecord | null> {
	const db = getDb();
	if (!db) return noDb("createAgent");

	const slot = await nextFreeSlot(params.botId);
	if (slot === null) {
		log.logWarning("[agent-registry] createAgent: all 5 slots occupied");
		return null;
	}

	try {
		const { data, error } = await db
			.from("telegram_agents")
			.insert({
				bot_id: params.botId,
				chat_id: params.chatId,
				name: params.name,
				skills: params.skills,
				slot_index: slot,
				status: "stopped",
			})
			.select("*")
			.single();
		if (error) throw error;
		log.logInfo(`[agent-registry] Created agent "${params.name}" (slot ${slot})`);
		return rowToRecord(data as Record<string, unknown>);
	} catch (err) {
		log.logWarning("[agent-registry] createAgent failed", String(err));
		return null;
	}
}

/** Update agent status and optional container ID after provisioning or a status change. */
export async function updateAgentStatus(
	agentId: string,
	status: AgentStatus,
	dockerContainerId?: string,
): Promise<void> {
	const db = getDb();
	if (!db) { noDb("updateAgentStatus"); return; }
	try {
		const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
		if (dockerContainerId !== undefined) patch.docker_container_id = dockerContainerId;
		const { error } = await db
			.from("telegram_agents")
			.update(patch)
			.eq("agent_id", agentId);
		if (error) throw error;
	} catch (err) {
		log.logWarning("[agent-registry] updateAgentStatus failed", String(err));
	}
}

/**
 * Delete an agent record and free its slot.
 * The caller is responsible for stopping the Docker container first.
 */
export async function deleteAgent(agentId: string): Promise<boolean> {
	const db = getDb();
	if (!db) { noDb("deleteAgent"); return false; }
	try {
		const { error } = await db
			.from("telegram_agents")
			.delete()
			.eq("agent_id", agentId);
		if (error) throw error;
		log.logInfo(`[agent-registry] Deleted agent ${agentId}`);
		return true;
	} catch (err) {
		log.logWarning("[agent-registry] deleteAgent failed", String(err));
		return false;
	}
}

/**
 * Look up which agent (if any) owns the given channelId.
 * channelId format: tg-{chatId} or tg-{chatId}-{threadId}
 * Returns the agent whose chatId matches the channelId's chatId.
 */
export async function getAgentByChannel(botId: string, channelId: string): Promise<AgentRecord | null> {
	if (!channelId.startsWith("tg-")) return null;
	const chatIdStr = channelId.slice(3).split("-")[0];
	const chatId = parseInt(chatIdStr, 10);
	if (isNaN(chatId)) return null;

	const db = getDb();
	if (!db) return null;
	try {
		const { data, error } = await db
			.from("telegram_agents")
			.select("*")
			.eq("bot_id", botId)
			.eq("chat_id", chatId)
			.maybeSingle();
		if (error) throw error;
		return data ? rowToRecord(data as Record<string, unknown>) : null;
	} catch (err) {
		log.logWarning("[agent-registry] getAgentByChannel failed", String(err));
		return null;
	}
}

// ============================================================================
// Skill validation (Phase 3.4)
// ============================================================================

/**
 * Check if an agent has a skill that matches the given task text.
 *
 * Rules:
 *   - Empty skills list → agent is general-purpose, allow any task.
 *   - Otherwise → at least one skill name (hyphens converted to spaces) must
 *     appear as a substring of the task text (case-insensitive).
 *
 * This is intentionally fuzzy: "search the web" matches "search-web",
 * "send an email" matches "send-email", etc.
 */
export function validateAgentSkills(agent: AgentRecord, taskText: string): boolean {
	if (agent.skills.length === 0) return true;
	const normalised = taskText.toLowerCase();
	return agent.skills.some((skill) => {
		const readable = skill.toLowerCase().replace(/-/g, " ");
		return normalised.includes(readable) || normalised.includes(skill.toLowerCase());
	});
}

/**
 * Return a human-readable message listing an agent's skills.
 * Used when validation fails to tell the user what the agent can do.
 */
export function agentSkillsMessage(agent: AgentRecord): string {
	if (agent.skills.length === 0) return `${agent.name} is a general-purpose agent with no specific skills.`;
	return `${agent.name} has these skills: ${agent.skills.join(", ")}.`;
}
