import { Cron } from "croner";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import * as log from "./log.js";
import { listSubAgents } from "./sub-agent-registry.js";
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
	/** Called when an agent has missed tasks — delivers the notification. */
	notifyOwner: (botId: string, channelId: string, text: string) => void;
	/** Look up the Telegram bot linked to a sub-agent. Returns null if unlinked. */
	getBotForAgent?: (agentId: string) => Promise<string | null>;
	/**
	 * Preferred over getBotForAgent+notifyOwner in the dedicated-bot model.
	 * Routes the notification via the agent's own bridge /notify endpoint.
	 */
	notifyAgent?: (agentId: string, channelId: string, text: string) => Promise<void>;
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
 * 1. For every registered sub-agent, check for missed tasks (status=pending,
 *    scheduled_for < now()). Mark them skipped and notify the linked bot if any.
 * 2. Load all future pending scheduled tasks and register croner jobs for them.
 *
 * Call this once after all Telegram bots have started.
 */
export async function startScheduler(callbacks: SchedulerCallbacks): Promise<void> {
	log.logInfo("[scheduler] Starting");

	const agents = await listSubAgents();

	// ── Step 1: Handle missed tasks ──────────────────────────────────────────
	for (const agent of agents) {
		const missed = await getMissedTasks(agent.agentId);
		if (missed.length === 0) continue;

		await Promise.all(missed.map((t) => updateTaskStatus(t.taskId, "skipped")));
		log.logInfo(`[scheduler] Marked ${missed.length} missed tasks skipped for agent ${agent.name}`);

		// Notify the agent's owner about missed tasks
		{
			const channelId = missed[0].channelId;
			const noun = missed.length === 1 ? "task" : "tasks";
			const notifyText =
				`⚠️ <b>${agent.name}</b> missed ${missed.length} scheduled ${noun} while offline. They have been skipped.\n\n` +
				missed.map((t) => `• ${t.localTimeStr ?? t.scheduledFor ?? "?"}: <i>${t.payload.slice(0, 80)}</i>`).join("\n");

			if (callbacks.notifyAgent) {
				await callbacks.notifyAgent(agent.agentId, channelId, notifyText).catch((e: unknown) =>
					log.logWarning(`[scheduler] notifyAgent failed for ${agent.agentId}`, String(e)),
				);
			} else if (callbacks.getBotForAgent) {
				const botId = await callbacks.getBotForAgent(agent.agentId);
				if (botId) callbacks.notifyOwner(botId, channelId, notifyText);
			}
		}
	}

	// ── Step 2: Load future scheduled tasks ───────────────────────────────────
	const futureTasks = await getAllPendingScheduled();
	log.logInfo(`[scheduler] Loading ${futureTasks.length} pending scheduled task(s)`);

	const agentNameMap = new Map(agents.map((a) => [a.agentId, a.name]));

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
