import { exec } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";
import { getDb } from "./db.js";
import { listSubAgents, updateSubAgentStatus } from "./sub-agent-registry.js";
import type { SubAgentRecord } from "./sub-agent-registry.js";

const execAsync = promisify(exec);
const POLL_INTERVAL_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

export interface WatchdogCallbacks {
	/** Called when a running agent's container is detected as crashed/exited. */
	onAgentCrashed: (agentId: string) => void;
	/** Called when a crashed/stopped agent's container is detected as running again. */
	onAgentRecovered: (agentId: string, agentName: string) => void;
}

// ============================================================================
// Runtime-specific health checks
// ============================================================================

async function isDockerRunning(containerName: string): Promise<boolean> {
	try {
		const { stdout } = await execAsync(
			`docker inspect --format='{{.State.Status}}' ${containerName} 2>/dev/null`,
		);
		const status = stdout.trim().replace(/'/g, "");
		return status === "running" || status === "restarting";
	} catch {
		return false;
	}
}

async function isFirecrackerRunning(slotIndex: number): Promise<boolean> {
	try {
		const res = await fetch(
			`http://172.20.${slotIndex}.2:8080/health`,
			{ signal: AbortSignal.timeout(4000) },
		);
		return res.ok;
	} catch {
		return false;
	}
}

// ============================================================================
// Per-agent check
// ============================================================================

async function checkAgent(agent: SubAgentRecord, callbacks: WatchdogCallbacks): Promise<void> {
	const nowRunning = agent.runtime === "firecracker"
		? await isFirecrackerRunning(agent.slotIndex)
		: await isDockerRunning(agent.dockerContainerId ?? `iris-agent-${agent.agentId}`);

	const wasRunning = agent.status === "running";
	const wasCrashed = agent.status === "crashed" || agent.status === "stopped";

	if (wasRunning && !nowRunning) {
		log.logWarning(
			`[watchdog] Agent ${agent.name} (${agent.agentId}) went offline`,
			`runtime: ${agent.runtime}`,
		);
		await updateSubAgentStatus(agent.agentId, "crashed");
		callbacks.onAgentCrashed(agent.agentId);

	} else if (wasCrashed && nowRunning) {
		log.logInfo(`[watchdog] Agent ${agent.name} (${agent.agentId}) recovered`);
		await updateSubAgentStatus(agent.agentId, "running");
		callbacks.onAgentRecovered(agent.agentId, agent.name);
	}
}

// ============================================================================
// Poll loop
// ============================================================================

async function pollAll(callbacks: WatchdogCallbacks): Promise<void> {
	try {
		const agents = await listSubAgents();
		if (agents.length === 0) return;
		await Promise.all(agents.map((a) => checkAgent(a, callbacks)));
	} catch (err) {
		log.logWarning("[watchdog] Poll error", err instanceof Error ? err.message : String(err));
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Start the agent watchdog. Polls every 30 seconds.
 * Does nothing if Supabase is not configured.
 * Runs an initial poll immediately on startup.
 */
export async function startWatchdog(callbacks: WatchdogCallbacks): Promise<void> {
	const db = getDb();
	if (!db) {
		log.logInfo("[watchdog] Supabase not configured — watchdog disabled");
		return;
	}

	log.logInfo(`[watchdog] Starting — polling every ${POLL_INTERVAL_MS / 1000}s`);

	void pollAll(callbacks).catch((err) =>
		log.logWarning("[watchdog] Initial poll error", String(err)),
	);

	setInterval(() => void pollAll(callbacks), POLL_INTERVAL_MS);
}
