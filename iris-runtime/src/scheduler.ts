import { Cron } from "croner";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import * as log from "./log.js";
import { listAgents } from "./agent-registry.js";
import {
	getAllPendingScheduled,
	getMissedTasks,
	updateTaskStatus,
	type TaskRecord,
} from "./task-queue.js";

// ============================================================================
// Types
// ============================================================================

export interface SchedulerCallbacks {
	/** Called when an agent has missed tasks. Send a message to the bot owner. */
	notifyOwner: (botId: string, channelId: string, text: string) => void;
	/** Working directory for writing event files. */
	workingDir: string;
}

// ============================================================================
// Event file dispatch
// ============================================================================

/**
 * Dispatch a task by writing a one-shot event file to the shared events dir.
 * The EventsWatcher picks it up and routes it to the agent via handleEvent,
 * bypassing the Phase 3 gate (events come through enqueueEvent, not handleUpdate).
 */
function dispatchTaskEvent(task: TaskRecord, agentName: string, workingDir: string): void {
	const eventsDir = join(workingDir, "events");
	try {
		mkdirSync(eventsDir, { recursive: true });
	} catch { /* already exists */ }

	const eventId = `task-${task.taskId}-${randomBytes(4).toString("hex")}`;
	const filename = `${eventId}.json`;
	const payload = {
		type: "immediate",
		channelId: task.channelId,
		text: `[${agentName} — scheduled task]: ${task.payload}`,
	};

	try {
		writeFileSync(join(eventsDir, filename), JSON.stringify(payload, null, 2));
		log.logInfo(`[scheduler] Dispatched task ${task.taskId} → ${filename}`);
	} catch (err) {
		log.logWarning("[scheduler] Failed to write event file", String(err));
	}
}

// ============================================================================
// Per-task croner job
// ============================================================================

const scheduledJobs = new Map<string, Cron>();

function scheduleTask(
	task: TaskRecord,
	agentName: string,
	callbacks: SchedulerCallbacks,
): void {
	if (!task.scheduledFor) return;
	const fireAt = new Date(task.scheduledFor);
	if (fireAt <= new Date()) return; // already past — handled as missed

	if (scheduledJobs.has(task.taskId)) return; // already scheduled

	try {
		const job = new Cron(fireAt, { timezone: "UTC" }, async () => {
			log.logInfo(`[scheduler] Task ${task.taskId} (${agentName}) firing now`);
			scheduledJobs.delete(task.taskId);
			await updateTaskStatus(task.taskId, "running");
			dispatchTaskEvent(task, agentName, callbacks.workingDir);
		});
		scheduledJobs.set(task.taskId, job);
		log.logInfo(`[scheduler] Scheduled task ${task.taskId} for ${task.scheduledFor} (agent: ${agentName})`);
	} catch (err) {
		log.logWarning(`[scheduler] Failed to schedule task ${task.taskId}`, String(err));
	}
}

/**
 * Cancel a scheduled job. Called when a task is deleted or cancelled.
 */
export function cancelScheduledTask(taskId: string): void {
	const job = scheduledJobs.get(taskId);
	if (job) {
		job.stop();
		scheduledJobs.delete(taskId);
		log.logInfo(`[scheduler] Cancelled job for task ${taskId}`);
	}
}

// ============================================================================
// Startup
// ============================================================================

/**
 * Start the scheduler:
 * 1. For every agent registered in the bot's registry, check for missed tasks
 *    (status=pending, scheduled_for < now()). Mark them skipped and notify owner.
 * 2. Load all future pending scheduled tasks and register croner jobs for them.
 *
 * Call this once after all Telegram bots have started.
 */
export async function startScheduler(
	botIds: string[],
	callbacks: SchedulerCallbacks,
): Promise<void> {
	if (!botIds.length) return;
	log.logInfo(`[scheduler] Starting for bots: ${botIds.join(", ")}`);

	// ── Step 1: Handle missed tasks ──────────────────────────────────────────
	for (const botId of botIds) {
		const agents = await listAgents(botId);
		for (const agent of agents) {
			const missed = await getMissedTasks(agent.agentId);
			if (missed.length === 0) continue;

			// Mark all missed tasks as skipped
			await Promise.all(missed.map((t) => updateTaskStatus(t.taskId, "skipped")));

			// Notify the owner via their Telegram channel
			const ownerChannelId = `tg-${agent.chatId}`;
			const noun = missed.length === 1 ? "task" : "tasks";
			callbacks.notifyOwner(
				botId,
				ownerChannelId,
				`⚠️ <b>${agent.name}</b> missed ${missed.length} scheduled ${noun} while offline. They have been skipped.\n\n` +
				missed.map((t) => `• ${t.localTimeStr ?? t.scheduledFor ?? "?"}: <i>${t.payload.slice(0, 80)}</i>`).join("\n"),
			);
			log.logInfo(`[scheduler] Marked ${missed.length} missed tasks skipped for agent ${agent.name}`);
		}
	}

	// ── Step 2: Load future scheduled tasks ───────────────────────────────────
	const futureTasks = await getAllPendingScheduled();
	log.logInfo(`[scheduler] Loading ${futureTasks.length} pending scheduled task(s)`);

	// Build agent name lookup (agentId → name) from all agents
	const agentNameMap = new Map<string, string>();
	for (const botId of botIds) {
		const agents = await listAgents(botId);
		for (const a of agents) agentNameMap.set(a.agentId, a.name);
	}

	for (const task of futureTasks) {
		const agentName = agentNameMap.get(task.agentId) ?? "Agent";
		scheduleTask(task, agentName, callbacks);
	}

	log.logInfo("[scheduler] Startup complete");
}

/**
 * Schedule a newly created task immediately (called by the /internal/agent-task endpoint).
 * No-op for immediate tasks (those are dispatched right away by the API handler).
 */
export async function scheduleNewTask(
	task: TaskRecord,
	agentName: string,
	callbacks: SchedulerCallbacks,
): Promise<void> {
	if (task.type !== "scheduled" || !task.scheduledFor) return;
	scheduleTask(task, agentName, callbacks);
}
