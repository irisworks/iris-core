import { getDb } from "./db.js";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export type TaskType   = "immediate" | "scheduled";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TaskRecord {
	taskId: string;
	agentId: string;
	botId: string;
	channelId: string;
	type: TaskType;
	payload: string;
	scheduledFor: string | null;  // ISO UTC
	timezone: string | null;
	localTimeStr: string | null;
	status: TaskStatus;
	assignedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	output: string | null;
	createdAt: string;
}

export interface CreateTaskParams {
	agentId: string;
	botId: string;
	channelId: string;
	payload: string;
	scheduledFor?: string;   // ISO UTC — omit for immediate
	timezone?: string;
	localTimeStr?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function rowToTask(row: Record<string, unknown>): TaskRecord {
	return {
		taskId:       row.task_id as string,
		agentId:      row.agent_id as string,
		botId:        row.bot_id as string,
		channelId:    row.channel_id as string,
		type:         (row.type as TaskType) ?? "immediate",
		payload:      row.payload as string,
		scheduledFor: (row.scheduled_for as string | null) ?? null,
		timezone:     (row.timezone as string | null) ?? null,
		localTimeStr: (row.local_time_str as string | null) ?? null,
		status:       (row.status as TaskStatus) ?? "pending",
		assignedAt:   row.assigned_at as string,
		startedAt:    (row.started_at as string | null) ?? null,
		completedAt:  (row.completed_at as string | null) ?? null,
		output:       (row.output as string | null) ?? null,
		createdAt:    row.created_at as string,
	};
}

function noDb(op: string): null {
	log.logWarning(`[task-queue] ${op}: Supabase not configured — skipping`);
	return null;
}

// ============================================================================
// CRUD
// ============================================================================

export async function createTask(params: CreateTaskParams): Promise<TaskRecord | null> {
	const db = getDb();
	if (!db) return noDb("createTask");
	try {
		const type: TaskType = params.scheduledFor ? "scheduled" : "immediate";
		const { data, error } = await db
			.from("agent_tasks")
			.insert({
				agent_id:      params.agentId,
				bot_id:        params.botId,
				channel_id:    params.channelId,
				type,
				payload:       params.payload,
				scheduled_for: params.scheduledFor ?? null,
				timezone:      params.timezone ?? null,
				local_time_str: params.localTimeStr ?? null,
				status:        "pending",
			})
			.select("*")
			.single();
		if (error) throw error;
		log.logInfo(`[task-queue] Task created: ${(data as Record<string, unknown>).task_id} (${type})`);
		return rowToTask(data as Record<string, unknown>);
	} catch (err) {
		log.logWarning("[task-queue] createTask failed", String(err));
		return null;
	}
}

export async function getTask(taskId: string): Promise<TaskRecord | null> {
	const db = getDb();
	if (!db) return noDb("getTask");
	try {
		const { data, error } = await db
			.from("agent_tasks")
			.select("*")
			.eq("task_id", taskId)
			.maybeSingle();
		if (error) throw error;
		return data ? rowToTask(data as Record<string, unknown>) : null;
	} catch (err) {
		log.logWarning("[task-queue] getTask failed", String(err));
		return null;
	}
}

export async function listAgentTasks(
	agentId: string,
	status?: TaskStatus,
): Promise<TaskRecord[]> {
	const db = getDb();
	if (!db) { noDb("listAgentTasks"); return []; }
	try {
		let q = db.from("agent_tasks").select("*").eq("agent_id", agentId);
		if (status) q = q.eq("status", status);
		const { data, error } = await q.order("created_at", { ascending: false }).limit(50);
		if (error) throw error;
		return (data ?? []).map((r) => rowToTask(r as Record<string, unknown>));
	} catch (err) {
		log.logWarning("[task-queue] listAgentTasks failed", String(err));
		return [];
	}
}

export async function updateTaskStatus(
	taskId: string,
	status: TaskStatus,
	output?: string,
): Promise<void> {
	const db = getDb();
	if (!db) { noDb("updateTaskStatus"); return; }
	try {
		const now = new Date().toISOString();
		const patch: Record<string, unknown> = { status };
		if (status === "running")  patch.started_at   = now;
		if (status === "done" || status === "failed" || status === "skipped") {
			patch.completed_at = now;
		}
		if (output !== undefined) patch.output = output.slice(0, 2000); // cap stored output
		const { error } = await db.from("agent_tasks").update(patch).eq("task_id", taskId);
		if (error) throw error;
	} catch (err) {
		log.logWarning("[task-queue] updateTaskStatus failed", String(err));
	}
}

/**
 * Tasks that were scheduled but their deadline passed while the system was offline.
 * Returns pending tasks with scheduled_for < now() for a given agent.
 */
export async function getMissedTasks(agentId: string): Promise<TaskRecord[]> {
	const db = getDb();
	if (!db) { noDb("getMissedTasks"); return []; }
	try {
		const { data, error } = await db
			.from("agent_tasks")
			.select("*")
			.eq("agent_id", agentId)
			.eq("status", "pending")
			.eq("type", "scheduled")
			.lt("scheduled_for", new Date().toISOString());
		if (error) throw error;
		return (data ?? []).map((r) => rowToTask(r as Record<string, unknown>));
	} catch (err) {
		log.logWarning("[task-queue] getMissedTasks failed", String(err));
		return [];
	}
}

/**
 * All pending scheduled tasks across ALL agents that are due within the next 90 seconds.
 * Used by the scheduler to load tasks at startup that need immediate croner jobs.
 */
export async function getDueTasks(lookAheadMs = 90_000): Promise<TaskRecord[]> {
	const db = getDb();
	if (!db) { noDb("getDueTasks"); return []; }
	try {
		const cutoff = new Date(Date.now() + lookAheadMs).toISOString();
		const { data, error } = await db
			.from("agent_tasks")
			.select("*")
			.eq("status", "pending")
			.eq("type", "scheduled")
			.gt("scheduled_for", new Date().toISOString())
			.lte("scheduled_for", cutoff);
		if (error) throw error;
		return (data ?? []).map((r) => rowToTask(r as Record<string, unknown>));
	} catch (err) {
		log.logWarning("[task-queue] getDueTasks failed", String(err));
		return [];
	}
}

/**
 * All pending + running scheduled tasks for all agents owned by a bot.
 * Used by /task_status to display a summary per agent.
 */
export async function getOwnerTaskSummary(botId: string): Promise<TaskRecord[]> {
	const db = getDb();
	if (!db) { noDb("getOwnerTaskSummary"); return []; }
	try {
		const { data, error } = await db
			.from("agent_tasks")
			.select("*")
			.eq("bot_id", botId)
			.in("status", ["pending", "running", "done", "failed", "skipped"])
			.order("created_at", { ascending: false })
			.limit(30);
		if (error) throw error;
		return (data ?? []).map((r) => rowToTask(r as Record<string, unknown>));
	} catch (err) {
		log.logWarning("[task-queue] getOwnerTaskSummary failed", String(err));
		return [];
	}
}

/**
 * All future pending scheduled tasks — used by the scheduler to re-schedule on startup.
 */
export async function getAllPendingScheduled(): Promise<TaskRecord[]> {
	const db = getDb();
	if (!db) { noDb("getAllPendingScheduled"); return []; }
	try {
		const { data, error } = await db
			.from("agent_tasks")
			.select("*")
			.eq("status", "pending")
			.eq("type", "scheduled")
			.gt("scheduled_for", new Date().toISOString())
			.order("scheduled_for", { ascending: true });
		if (error) throw error;
		return (data ?? []).map((r) => rowToTask(r as Record<string, unknown>));
	} catch (err) {
		log.logWarning("[task-queue] getAllPendingScheduled failed", String(err));
		return [];
	}
}
