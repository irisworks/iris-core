import { getDb } from "./db.js";
import { VM_ID, runtimeTypeForAgent } from "./auth.js";
import { setSecret, deleteSecretIfPresent } from "./keyvault.js";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export type AgentStatus      = "running" | "stopped" | "crashed";
export type AgentRuntime     = "docker" | "firecracker";
export type IntegrationKind  = "telegram" | "slack";
export type IntegrationStatus = "unattached" | "pending_verification" | "linked";

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

	// Dedicated bot/app — Key Vault refs, never raw tokens (see keyvault.ts).
	telegramBotTokenRef:  string | null;
	slackAppTokenRef:     string | null;
	slackBotTokenRef:     string | null;
	telegramStatus:       IntegrationStatus;
	telegramBotUsername:  string | null;   // set after attach via getMe; used to build QR deep-link
	slackStatus:          IntegrationStatus;
}

// slot_index doubles as the network-addressing key (Docker bridge port =
// 4200+slot, Firecracker guest IP = 172.20.{slot}.2 — capped at a valid IPv4
// octet). "No limit on sub-agents" means no artificial product-level ceiling
// like the old value of 10; 250 is the real engineering ceiling, recyclable
// via slot reuse on delete (see nextFreeSlot). Matches the schema CHECK constraint.
export const MAX_SUB_AGENTS = 250;

// ============================================================================
// Helpers
// ============================================================================

function rowToRecord(row: Record<string, unknown>): SubAgentRecord {
	return {
		agentId:             row.agent_id as string,
		name:                row.name as string,
		runtime:             ((row.runtime as AgentRuntime) ?? "docker"),
		dockerContainerId:   (row.docker_container_id as string | null) ?? null,
		status:              (row.status as AgentStatus) ?? "stopped",
		skills:              (row.skills as string[]) ?? [],
		slotIndex:           row.slot_index as number,
		createdAt:           row.created_at as string,
		updatedAt:           row.updated_at as string,
		telegramBotTokenRef:  (row.telegram_bot_token_ref  as string | null) ?? null,
		slackAppTokenRef:     (row.slack_app_token_ref     as string | null) ?? null,
		slackBotTokenRef:     (row.slack_bot_token_ref     as string | null) ?? null,
		telegramStatus:       (row.telegram_status         as IntegrationStatus | null) ?? "unattached",
		telegramBotUsername:  (row.telegram_bot_username   as string | null) ?? null,
		slackStatus:          (row.slack_status            as IntegrationStatus | null) ?? "unattached",
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
		// Clean up dedicated-bot secrets first — once the row is gone we lose the refs
		const record = await getSubAgent(agentId);
		if (record) {
			await deleteSecretIfPresent(record.telegramBotTokenRef);
			await deleteSecretIfPresent(record.slackAppTokenRef);
			await deleteSecretIfPresent(record.slackBotTokenRef);
		}
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

// ============================================================================
// Dedicated bot/app integration — attach/detach (Phase 3)
//
// Each sub-agent owns its own Telegram Bot / Slack App (no shared pool, no
// claim-from-pool). "Attach" stores the credential in Key Vault, persists the
// ref, and flips status to pending_verification — the caller (API layer) then
// re-provisions the agent's container so the token becomes a live env var, and
// issues a claim token the owner sends to their own bot to prove control of it
// (see managers/integration.ts for the verification side of this handshake).
// ============================================================================

/**
 * Store dedicated-bot credentials for an agent and mark the integration as
 * pending verification. For Slack this writes BOTH the app and bot tokens
 * (two refs) but a single status field, since the pair is claimed/verified together.
 */
export async function attachIntegration(
	agentId: string,
	platform: IntegrationKind,
	credentials: { telegramBotToken?: string; slackAppToken?: string; slackBotToken?: string; botUsername?: string },
): Promise<SubAgentRecord | null> {
	const db = getDb();
	if (!db) return noDb("attachIntegration");

	const record = await getSubAgent(agentId);
	if (!record) {
		log.logWarning(`[sub-agent-registry] attachIntegration: agent ${agentId} not found`);
		return null;
	}

	const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
	try {
		if (platform === "telegram") {
			if (!credentials.telegramBotToken) throw new Error("telegramBotToken is required");
			const ref = await setSecret(`sub-agent-${agentId}-telegram-bot-token`, credentials.telegramBotToken);
			if (!ref) throw new Error("failed to store secret in Key Vault");
			patch.telegram_bot_token_ref = ref;
			patch.telegram_status        = "pending_verification";
			patch.telegram_bot_username  = credentials.botUsername ?? null;
		} else {
			if (!credentials.slackAppToken || !credentials.slackBotToken) {
				throw new Error("slackAppToken and slackBotToken are both required");
			}
			const appRef = await setSecret(`sub-agent-${agentId}-slack-app-token`, credentials.slackAppToken);
			const botRef = await setSecret(`sub-agent-${agentId}-slack-bot-token`, credentials.slackBotToken);
			if (!appRef || !botRef) throw new Error("failed to store secret(s) in Key Vault");
			patch.slack_app_token_ref = appRef;
			patch.slack_bot_token_ref = botRef;
			patch.slack_status = "pending_verification";
		}

		const { data, error } = await db.from("sub_agents").update(patch).eq("agent_id", agentId).select("*").single();
		if (error) throw error;
		log.logInfo(`[sub-agent-registry] Attached ${platform} credentials to "${record.name}" (pending verification)`);
		return rowToRecord(data as Record<string, unknown>);
	} catch (err) {
		log.logWarning(`[sub-agent-registry] attachIntegration(${platform}) failed`, String(err));
		return null;
	}
}

/** Mark an integration as linked once claim-token ownership verification succeeds. */
export async function markIntegrationLinked(agentId: string, platform: IntegrationKind): Promise<void> {
	const db = getDb();
	if (!db) { noDb("markIntegrationLinked"); return; }
	const statusColumn = platform === "telegram" ? "telegram_status" : "slack_status";
	try {
		const { error } = await db.from("sub_agents")
			.update({ [statusColumn]: "linked", updated_at: new Date().toISOString() })
			.eq("agent_id", agentId);
		if (error) throw error;
		log.logInfo(`[sub-agent-registry] ${platform} verified and linked for agent ${agentId}`);
	} catch (err) {
		log.logWarning(`[sub-agent-registry] markIntegrationLinked(${platform}) failed`, String(err));
	}
}

/** Detach an integration: delete its Key Vault secret(s), clear refs, reset status to unattached. */
export async function detachIntegration(agentId: string, platform: IntegrationKind): Promise<boolean> {
	const db = getDb();
	if (!db) { noDb("detachIntegration"); return false; }

	const record = await getSubAgent(agentId);
	if (!record) return false;

	const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
	try {
		if (platform === "telegram") {
			await deleteSecretIfPresent(record.telegramBotTokenRef);
			patch.telegram_bot_token_ref = null;
			patch.telegram_bot_username  = null;
			patch.telegram_status        = "unattached";
		} else {
			await deleteSecretIfPresent(record.slackAppTokenRef);
			await deleteSecretIfPresent(record.slackBotTokenRef);
			patch.slack_app_token_ref = null;
			patch.slack_bot_token_ref = null;
			patch.slack_status = "unattached";
		}
		const { error } = await db.from("sub_agents").update(patch).eq("agent_id", agentId);
		if (error) throw error;
		log.logInfo(`[sub-agent-registry] Detached ${platform} from "${record.name}"`);
		return true;
	} catch (err) {
		log.logWarning(`[sub-agent-registry] detachIntegration(${platform}) failed`, String(err));
		return false;
	}
}
