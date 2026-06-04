import { exec } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";
import { getDb } from "./db.js";
import { listAllAgents, updateAgentStatus } from "./agent-registry.js";
import type { AgentRecord } from "./agent-registry.js";

const execAsync = promisify(exec);
const POLL_INTERVAL_MS = 30_000;

// ============================================================================
// Types
// ============================================================================

export interface WatchdogCallbacks {
	/** Send a message to the bot owner's Telegram channel. */
	notifyOwner: (botId: string, channelId: string, text: string) => void;
	/** Called when a running agent's container is detected as crashed/exited. */
	onAgentCrashed: (agentId: string) => void;
	/** Called when a crashed/stopped agent's container is detected as running again. */
	onAgentRecovered: (agentId: string, agentName: string, botId: string) => void;
}

// ============================================================================
// Docker status check
// ============================================================================

/**
 * Returns the Docker container state for a given container name.
 * Returns "not_found" if the container doesn't exist or inspect fails.
 */
async function getDockerStatus(containerName: string): Promise<string> {
	try {
		const { stdout } = await execAsync(
			`docker inspect --format='{{.State.Status}}' ${containerName} 2>/dev/null`,
		);
		return stdout.trim().replace(/'/g, "") || "not_found";
	} catch {
		return "not_found";
	}
}

function isDockerRunning(dockerStatus: string): boolean {
	return dockerStatus === "running" || dockerStatus === "restarting";
}

// ============================================================================
// Per-agent check
// ============================================================================

async function checkAgent(agent: AgentRecord, callbacks: WatchdogCallbacks): Promise<void> {
	const containerName = `iris-tg-${agent.agentId}`;
	const dockerStatus = await getDockerStatus(containerName);
	const nowRunning = isDockerRunning(dockerStatus);
	const wasRunning = agent.status === "running";
	const wasCrashed = agent.status === "crashed" || agent.status === "stopped";

	const ownerChannelId = `tg-${agent.chatId}`;

	if (wasRunning && !nowRunning) {
		// Transition: running → crashed
		log.logWarning(
			`[watchdog] Agent ${agent.name} (${agent.agentId}) went offline`,
			`docker status: ${dockerStatus}`,
		);
		await updateAgentStatus(agent.agentId, "crashed");
		callbacks.notifyOwner(
			agent.botId,
			ownerChannelId,
			`💥 <b>${agent.name}</b> has gone offline. I'll notify you when it's back.`,
		);
		callbacks.onAgentCrashed(agent.agentId);

	} else if (wasCrashed && nowRunning) {
		// Transition: crashed/stopped → running
		log.logInfo(`[watchdog] Agent ${agent.name} (${agent.agentId}) recovered`);
		await updateAgentStatus(agent.agentId, "running");
		callbacks.notifyOwner(
			agent.botId,
			ownerChannelId,
			`✅ <b>${agent.name}</b> is now live again.`,
		);
		callbacks.onAgentRecovered(agent.agentId, agent.name, agent.botId);
	}
	// No transition — nothing to do
}

// ============================================================================
// Poll loop
// ============================================================================

async function pollAll(callbacks: WatchdogCallbacks): Promise<void> {
	try {
		const agents = await listAllAgents();
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

	// Initial poll (do not await — let startup continue)
	void pollAll(callbacks).catch((err) =>
		log.logWarning("[watchdog] Initial poll error", String(err)),
	);

	setInterval(() => void pollAll(callbacks), POLL_INTERVAL_MS);
}
