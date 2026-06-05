import { getDb } from "./db.js";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export type AgentStatus = "running" | "stopped" | "crashed";

export interface SubAgentRecord {
	agentId: string;
	name: string;
	dockerContainerId: string | null;
	status: AgentStatus;
	skills: string[];
	slotIndex: number;
	createdAt: string;
	updatedAt: string;
}

export const MAX_SUB_AGENTS = 10;

// ============================================================================
// Helpers
// ============================================================================

function rowToRecord(row: Record<string, unknown>): SubAgentRecord {
	return {
		agentId:           row.agent_id as string,
		name:              row.name as string,
		dockerContainerId: (row.docker_container_id as string | null) ?? null,
		status:            (row.status as AgentStatus) ?? "stopped",
		skills:            (row.skills as string[]) ?? [],
		slotIndex:         row.slot_index as number,
		createdAt:         row.created_at as string,
		updatedAt:         row.updated_at as string,
	};
}

function noDb(op: string): null {
	log.logWarning(`[sub-agent-registry] ${op}: Supabase not configured — skipping`);
	return null;
}

// ============================================================================
// Slot management
// ============================================================================

async function nextFreeSlot(): Promise<number | null> {
	const db = getDb();
	if (!db) return 1;
	try {
		const { data, error } = await db
			.from("sub_agents")
			.select("slot_index")
			.order("slot_index", { ascending: true });
		if (error) throw error;
		const used = new Set((data ?? []).map((r) => r.slot_index as number));
		for (let i = 1; i <= MAX_SUB_AGENTS; i++) {
			if (!used.has(i)) return i;
		}
		return null;
	} catch (err) {
		log.logWarning("[sub-agent-registry] nextFreeSlot failed", String(err));
		return 1;
	}
}

// ============================================================================
// CRUD
// ============================================================================

export async function listSubAgents(): Promise<SubAgentRecord[]> {
	const db = getDb();
	if (!db) { noDb("listSubAgents"); return []; }
	try {
		const { data, error } = await db
			.from("sub_agents")
			.select("*")
			.order("slot_index", { ascending: true });
		if (error) throw error;
		return (data ?? []).map((r) => rowToRecord(r as Record<string, unknown>));
	} catch (err) {
		log.logWarning("[sub-agent-registry] listSubAgents failed", String(err));
		return [];
	}
}

export async function getSubAgent(agentId: string): Promise<SubAgentRecord | null> {
	const db = getDb();
	if (!db) return noDb("getSubAgent");
	try {
		const { data, error } = await db
			.from("sub_agents")
			.select("*")
			.eq("agent_id", agentId)
			.maybeSingle();
		if (error) throw error;
		return data ? rowToRecord(data as Record<string, unknown>) : null;
	} catch (err) {
		log.logWarning("[sub-agent-registry] getSubAgent failed", String(err));
		return null;
	}
}

export async function getSubAgentByName(name: string): Promise<SubAgentRecord | null> {
	const db = getDb();
	if (!db) return noDb("getSubAgentByName");
	try {
		const { data, error } = await db
			.from("sub_agents")
			.select("*")
			.eq("name", name)
			.maybeSingle();
		if (error) throw error;
		return data ? rowToRecord(data as Record<string, unknown>) : null;
	} catch (err) {
		log.logWarning("[sub-agent-registry] getSubAgentByName failed", String(err));
		return null;
	}
}

export async function createSubAgent(params: {
	name: string;
	skills: string[];
}): Promise<SubAgentRecord | null> {
	const db = getDb();
	if (!db) return noDb("createSubAgent");

	const existing = await getSubAgentByName(params.name);
	if (existing) {
		log.logWarning(`[sub-agent-registry] createSubAgent: name "${params.name}" already taken`);
		return null;
	}

	const slot = await nextFreeSlot();
	if (slot === null) {
		log.logWarning("[sub-agent-registry] createSubAgent: all slots occupied");
		return null;
	}

	try {
		const { data, error } = await db
			.from("sub_agents")
			.insert({ name: params.name, skills: params.skills, slot_index: slot, status: "stopped" })
			.select("*")
			.single();
		if (error) throw error;
		log.logInfo(`[sub-agent-registry] Created sub-agent "${params.name}" (slot ${slot})`);
		return rowToRecord(data as Record<string, unknown>);
	} catch (err) {
		log.logWarning("[sub-agent-registry] createSubAgent failed", String(err));
		return null;
	}
}

export async function updateSubAgentStatus(
	agentId: string,
	status: AgentStatus,
	dockerContainerId?: string,
): Promise<void> {
	const db = getDb();
	if (!db) { noDb("updateSubAgentStatus"); return; }
	try {
		const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
		if (dockerContainerId !== undefined) patch.docker_container_id = dockerContainerId;
		const { error } = await db
			.from("sub_agents")
			.update(patch)
			.eq("agent_id", agentId);
		if (error) throw error;
	} catch (err) {
		log.logWarning("[sub-agent-registry] updateSubAgentStatus failed", String(err));
	}
}

export async function deleteSubAgent(agentId: string): Promise<boolean> {
	const db = getDb();
	if (!db) { noDb("deleteSubAgent"); return false; }
	try {
		const { error } = await db.from("sub_agents").delete().eq("agent_id", agentId);
		if (error) throw error;
		log.logInfo(`[sub-agent-registry] Deleted sub-agent ${agentId}`);
		return true;
	} catch (err) {
		log.logWarning("[sub-agent-registry] deleteSubAgent failed", String(err));
		return false;
	}
}
