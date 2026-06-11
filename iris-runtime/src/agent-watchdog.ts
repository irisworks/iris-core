import { exec } from "child_process";
import { promisify } from "util";
import * as log from "./log.js";
import { getDb } from "./db.js";
import { listSubAgents, updateSubAgentStatus } from "./sub-agent-registry.js";
import { provisionDockerAgent, reconcileAgentRegistry } from "./agent-provision.js";
import { getSecret } from "./keyvault.js";
import type { SubAgentRecord } from "./sub-agent-registry.js";

const execAsync = promisify(exec);
const POLL_INTERVAL_MS = 30_000;

// Set by startWatchdog before resurrection runs
let watchdogWorkingDir = "";

// ============================================================================
// Types
// ============================================================================

export interface WatchdogCallbacks {
	/** Called when a running agent's container is detected as crashed/exited. */
	onAgentCrashed: (agentId: string) => void;
	/** Called when a crashed/stopped agent's container is detected as running again. */
	onAgentRecovered: (agentId: string, agentName: string) => void;
	/** Iris's working directory — used for agents.json reconciliation on startup. */
	workingDir: string;
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

async function dockerContainerExists(containerName: string): Promise<boolean> {
	try {
		await execAsync(`docker inspect ${containerName} 2>/dev/null`);
		return true;
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
// Resurrection — runs once at startup
//
// For each agent in Supabase:
//   1. Container running → mark running (no-op if already marked)
//   2. Container stopped (exists but not running) → docker start (non-destructive)
//   3. Container missing entirely → full re-provision (restores tokens from KV/raw-ref)
// ============================================================================

async function resurrectAgents(): Promise<void> {
	let agents: SubAgentRecord[];
	try {
		agents = await listSubAgents();
	} catch (err) {
		log.logWarning("[watchdog] resurrectAgents: failed to list agents", String(err));
		return;
	}

	// Remove stale agents.json entries for agents that no longer exist in Supabase.
	if (watchdogWorkingDir) {
		const liveIds = new Set(agents.map((a) => a.agentId));
		reconcileAgentRegistry(watchdogWorkingDir, liveIds);
	}

	if (agents.length === 0) return;

	log.logInfo(`[watchdog] Resurrecting ${agents.length} agent(s)`);

	for (const agent of agents) {
		if (agent.runtime === "firecracker") {
			// Firecracker resurrection is complex (full VM boot) — skip for now,
			// watchdog poll will detect and handle after startup.
			continue;
		}

		const containerName = agent.dockerContainerId ?? `iris-agent-${agent.agentId}`;

		try {
			const running = await isDockerRunning(containerName);
			if (running) {
				if (agent.status !== "running") {
					await updateSubAgentStatus(agent.agentId, "running");
					log.logInfo(`[watchdog] Agent ${agent.name} already running — status corrected`);
				}
				continue;
			}

			const exists = await dockerContainerExists(containerName);
			if (exists) {
				// Container exists but is stopped — docker start is non-destructive.
				log.logInfo(`[watchdog] Restarting stopped container for ${agent.name}`);
				await execAsync(`docker start ${containerName}`);
				await updateSubAgentStatus(agent.agentId, "running");
				log.logInfo(`[watchdog] Agent ${agent.name} restarted`);
				continue;
			}

			// Container is completely gone — full re-provision.
			log.logInfo(`[watchdog] Container missing for ${agent.name} — re-provisioning`);
			const telegramBotToken = await getSecret(agent.telegramBotTokenRef);
			const slackAppToken    = await getSecret(agent.slackAppTokenRef);
			const slackBotToken    = await getSecret(agent.slackBotTokenRef);

			await provisionDockerAgent({
				agentId:           agent.agentId,
				agentName:         agent.name,
				slotIndex:         agent.slotIndex,
				skills:            agent.skills,
				runtime:           "docker",
				...(telegramBotToken && { telegramBotToken }),
				...(slackAppToken    && { slackAppToken }),
				...(slackBotToken    && { slackBotToken }),
			});
			await updateSubAgentStatus(agent.agentId, "running");
			log.logInfo(`[watchdog] Agent ${agent.name} re-provisioned`);

		} catch (err) {
			log.logWarning(
				`[watchdog] Failed to resurrect ${agent.name} (${agent.agentId})`,
				String(err),
			);
			// Don't crash the watchdog — move on to next agent
		}
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
 * Runs resurrection on startup, then an initial poll, then periodic polls.
 */
export async function startWatchdog(callbacks: WatchdogCallbacks): Promise<void> {
	const db = getDb();
	if (!db) {
		log.logInfo("[watchdog] Supabase not configured — watchdog disabled");
		return;
	}

	log.logInfo(`[watchdog] Starting — polling every ${POLL_INTERVAL_MS / 1000}s`);

	watchdogWorkingDir = callbacks.workingDir;

	// Resurrect stopped/missing containers before the first status poll.
	void resurrectAgents().catch((err) =>
		log.logWarning("[watchdog] Resurrection error", String(err)),
	);

	void pollAll(callbacks).catch((err) =>
		log.logWarning("[watchdog] Initial poll error", String(err)),
	);

	setInterval(() => void pollAll(callbacks), POLL_INTERVAL_MS);
}
