import { getDb } from "./db.js";
import { VM_ID, runtimeTypeForAgent } from "./auth.js";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export type AgentStatus  = "running" | "stopped" | "crashed";
export type AgentRuntime = "docker" | "firecracker";

export interface SubAgentRecord {
	agentId: string;
	name: string;
	runtime: AgentRuntime;
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
		runtime:           ((row.runtime as AgentRuntime) ?? "docker"),
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
// Compatibility shim — agent_tasks in the live DB still has an old FK to the
// legacy telegram_agents table instead of sub_agents. Until the schema migration
// is run in the Supabase SQL editor, we maintain a mirror row in telegram_agents
// (and a synthetic telegram_claim entry) so that task inserts don't fail.
// Remove this entire block once the schema migration has been executed.
// ============================================================================

async function upsertCompatRow(
	db: ReturnType<typeof getDb>,
	agentId: string,
	name: string,
	skills: string[],
	slotIndex: number,
	status: AgentStatus,
): Promise<void> {
	if (!db) return;
	const compatBotId = `compat-${agentId}`;
	try {
		await db.from("telegram_claim").upsert(
			{ bot_id: compatBotId, claimed: false },
			{ onConflict: "bot_id", ignoreDuplicates: true },
		);
		await db.from("telegram_agents").upsert(
			{
				agent_id:   agentId,
				bot_id:     compatBotId,
				name,
				skills,
				slot_index: slotIndex,
				status,
				platform:   "docker",
			},
			{ onConflict: "agent_id" },
		);
	} catch (err) {
		// Non-fatal — sub-agent exists; tasks won't persist until schema migration runs
		log.logWarning("[sub-agent-registry] compat shim upsert failed (schema migration pending)", String(err));
	}
}

async function deleteCompatRow(db: ReturnType<typeof getDb>, agentId: string): Promise<void> {
	if (!db) return;
	const compatBotId = `compat-${agentId}`;
	try {
		await db.from("telegram_agents").delete().eq("agent_id", agentId);
		await db.from("telegram_claim").delete().eq("bot_id", compatBotId);
	} catch (err) {
		log.logWarning("[sub-agent-registry] compat shim delete failed", String(err));
	}
}

// ============================================================================
// Routing table — Gateway/VM Orchestrator's agentId -> runtimeId -> runtimeType
// map (Supabase `runtime_mapping`). Written by iris-runtime when agents are
// provisioned, per the table's own schema comment.
//
// vm_id is a UUID FK into `vm_routing`, which is owned exclusively by the VM
// Orchestrator — a standalone deployment has no such row (IRIS_VM_ID defaults
// to "default", not a UUID). We only attempt the write once the Gateway has
// assigned this runtime a real VM UUID; `runtime_mapping` is removed via
// ON DELETE CASCADE from sub_agents, so no explicit cleanup is needed.
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function agentBridgeUrl(slotIndex: number, runtime: AgentRuntime): string {
	if (runtime === "firecracker") return `http://172.20.${slotIndex}.2:4200`;
	return `http://127.0.0.1:${4200 + slotIndex}`;
}

async function upsertRuntimeMapping(
	db: ReturnType<typeof getDb>,
	agentId: string,
	runtime: AgentRuntime,
	slotIndex: number,
): Promise<void> {
	if (!db) return;
	if (!UUID_RE.test(VM_ID)) return;
	try {
		const { error } = await db.from("runtime_mapping").upsert(
			{
				agent_id:     agentId,
				vm_id:        VM_ID,
				runtime_type: runtimeTypeForAgent(runtime),
				bridge_url:   agentBridgeUrl(slotIndex, runtime),
				updated_at:   new Date().toISOString(),
			},
			{ onConflict: "agent_id" },
		);
		if (error) throw error;
	} catch (err) {
		// Non-fatal — likely means the VM Orchestrator hasn't created the matching vm_routing row yet
		log.logWarning("[sub-agent-registry] runtime_mapping upsert failed", String(err));
	}
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
	runtime?: AgentRuntime;
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
			.insert({
				name:      params.name,
				skills:    params.skills,
				runtime:   params.runtime ?? "docker",
				slot_index: slot,
				status:    "stopped",
			})
			.select("*")
			.single();
		if (error) throw error;
		const record = rowToRecord(data as Record<string, unknown>);
		log.logInfo(`[sub-agent-registry] Created sub-agent "${params.name}" (slot ${slot})`);
		await upsertCompatRow(db, record.agentId, record.name, record.skills, record.slotIndex, record.status);
		await upsertRuntimeMapping(db, record.agentId, record.runtime, record.slotIndex);
		return record;
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
		// Keep compat mirror in sync
		try {
			await db.from("telegram_agents").update({ status, updated_at: new Date().toISOString() }).eq("agent_id", agentId);
		} catch { /* ignore compat failures */ }
	} catch (err) {
		log.logWarning("[sub-agent-registry] updateSubAgentStatus failed", String(err));
	}
}

export async function deleteSubAgent(agentId: string): Promise<boolean> {
	const db = getDb();
	if (!db) { noDb("deleteSubAgent"); return false; }
	try {
		// Remove compat mirror first so agent_tasks cascade-deletes cleanly
		await deleteCompatRow(db, agentId);
		const { error } = await db.from("sub_agents").delete().eq("agent_id", agentId);
		if (error) throw error;
		log.logInfo(`[sub-agent-registry] Deleted sub-agent ${agentId}`);
		return true;
	} catch (err) {
		log.logWarning("[sub-agent-registry] deleteSubAgent failed", String(err));
		return false;
	}
}
