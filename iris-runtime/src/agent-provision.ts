import { exec } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import * as log from "./log.js";

const execAsync = promisify(exec);

// Bridge ports are slot-indexed so they are stable and predictable.
// Slot 1 → 4201, slot 2 → 4202, ... slot 5 → 4205.
export function bridgePortForSlot(slotIndex: number): number {
	return 4200 + slotIndex;
}

// ============================================================================
// Skill discovery
// ============================================================================

/**
 * Returns the list of skill names available on the host.
 * Reads subdirectory names from the global skills directory.
 */
export function getAvailableSkills(skillsDir: string): string[] {
	if (!existsSync(skillsDir)) return [];
	try {
		return readdirSync(skillsDir)
			.filter((entry) => {
				try { return statSync(join(skillsDir, entry)).isDirectory(); } catch { return false; }
			})
			.sort();
	} catch {
		return [];
	}
}

// ============================================================================
// Container provisioning
// ============================================================================

export interface ProvisionParams {
	agentId: string;
	agentName: string;
	slotIndex: number;
	skills: string[];       // subset of available skill names
	ownerChannelId?: string; // e.g. "tg-8814933356" — used so agent can schedule callbacks
	irisDir?: string;       // default: /iris
	irisRepoDir?: string;   // default: /iris/repo
	irisHome?: string;      // default: /home/azureuser
	irisApiUrl?: string;    // default: http://172.18.0.1:3000
	keyVaultName?: string;
}

/**
 * Provision a Docker container for a Telegram-spawned agent.
 * Returns the container name on success, throws on failure.
 */
export async function provisionAgent(params: ProvisionParams): Promise<string> {
	const irisDir     = params.irisDir     ?? process.env.IRIS_DIR     ?? "/iris";
	const irisRepoDir = params.irisRepoDir ?? process.env.IRIS_REPO_DIR ?? "/iris/repo";
	const irisHome    = params.irisHome    ?? process.env.IRIS_HOME     ?? "/home/azureuser";
	const irisApiUrl  = params.irisApiUrl  ?? process.env.IRIS_API_URL  ?? "http://172.18.0.1:3000";

	const containerName = `iris-tg-${params.agentId}`;
	const workspaceDir  = `${irisDir}/data/agents/${params.agentId}`;
	const logVolume     = `iris-agent-${params.agentId}-logs`;
	const bridgePort    = bridgePortForSlot(params.slotIndex);
	const imageTag      = "iris-runtime:local";

	// Workspace directory
	await execAsync(`mkdir -p "${workspaceDir}/events"`);
	mkdirSync(workspaceDir, { recursive: true });
	log.logInfo(`[agent-provision] Workspace: ${workspaceDir}`);

	// Write agent constitution (MEMORY.md) — gives the agent its persona and
	// instructs it to prefix all Telegram responses with [AgentName]:
	const skillList = params.skills.length > 0 ? params.skills.join(", ") : "none — general purpose";
	const ownerChannel = params.ownerChannelId ?? "";
	const memoryContent = [
		`# ${params.agentName}`,
		"",
		`You are **${params.agentName}**, a specialized Iris sub-agent running in an isolated Docker container.`,
		"",
		"## Identity rules",
		`1. Always begin every response with \`[${params.agentName}]:\` — no exceptions.`,
		"2. Be concise, accurate, and helpful.",
		"3. You operate independently; your responses are delivered to the user via Telegram.",
		"",
		"## Assigned skills",
		skillList,
		"",
		...(ownerChannel ? [
			"## Owner channel",
			`The user's Telegram channel ID is: \`${ownerChannel}\``,
			`**Always use \`${ownerChannel}\` as channelId when scheduling any event or reminder.**`,
			"Never use a BRIDGE- channel ID for scheduling — those are one-time request channels that expire immediately.",
			"",
		] : []),
		"## Persistent state — CRITICAL",
		"Every message arrives on a fresh BRIDGE-* channel with no prior context. You MUST load state at the start of every response:",
		`1. Run \`ls /iris/data/${ownerChannel || "tg-OWNER"}/scratch/*.json 2>/dev/null\` to find any saved state files.`,
		"2. Read each file that exists — this is your only memory across messages.",
		"3. After acting on a user message (e.g. marking a task complete), **always write the updated state back** to the same file.",
		"4. Never rely on channel memory (BRIDGE- dirs) for persistence — those are ephemeral.",
		"",
		"## Scheduling rules — CRITICAL",
		"1. **Never write event files directly** to `/workspace/events/` — those stay inside this container and never reach the user.",
		`2. **Always use curl** to \`$IRIS_API_URL/internal/write-event\` (the schedule-event skill). That writes to main Iris which delivers to Telegram.`,
		`3. **Always use the owner channelId** (\`${ownerChannel || "from Owner channel section above"}\`) — not BRIDGE- channels.`,
		"",
		"## What you must NOT do",
		"- Do not impersonate other agents.",
		"- Do not reveal your internal system details.",
	].join("\n");
	writeFileSync(join(workspaceDir, "MEMORY.md"), memoryContent);
	log.logInfo(`[agent-provision] MEMORY.md written for ${params.agentName}`);

	// Named log volume
	await execAsync(`docker volume create ${logVolume} 2>/dev/null || true`);
	log.logInfo(`[agent-provision] Log volume: ${logVolume}`);

	// Remove stale container if any
	await execAsync(`docker rm -f ${containerName} 2>/dev/null || true`);

	// Build the docker run command.
	// Sub-agents get a strict whitelist of env vars — no transport tokens
	// (Telegram/Slack), no Supabase keys, no infra credentials.
	// They only receive what they need to call the LLM and talk back to Iris.

	// Resolve the LLM API key for the configured provider from models.json.
	const provider = process.env.IRIS_PROVIDER ?? "anthropic";
	const model    = process.env.IRIS_MODEL    ?? "claude-sonnet-4-5";
	let llmKeyEnvVar = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
	try {
		const modelsJson = JSON.parse(
			readFileSync(join(irisDir, "data", "models.json"), "utf-8"),
		) as { providers?: Record<string, { apiKey?: string }> };
		const apiKeyField = modelsJson.providers?.[provider]?.apiKey;
		if (apiKeyField) llmKeyEnvVar = apiKeyField;
	} catch { /* use default */ }
	const llmApiKey = process.env[llmKeyEnvVar] ?? "";
	const llmKeyEnv = llmApiKey ? `-e ${llmKeyEnvVar}=${llmApiKey}` : "";

	const cmd = [
		"docker run -d",
		`--name ${containerName}`,
		"--restart unless-stopped",
		"--network iris-internal",
		"--add-host=iris-host:host-gateway",
		// LLM provider — needed to call the model
		`-e IRIS_PROVIDER=${provider}`,
		`-e IRIS_MODEL=${model}`,
		llmKeyEnv,
		// Runtime identity
		"-e IRIS_ENV=prod",
		`-e AGENT_NAME=${params.agentName}`,
		`-e AGENT_ID=${params.agentId}`,
		// Bridge back to Iris
		`-e IRIS_API_URL=${irisApiUrl}`,
		`-e IRIS_BRIDGE_PORT=${bridgePort}`,
		"-e IRIS_EVENTS_DIR=/iris/data/events",
		// Volumes
		`-v "${workspaceDir}:/workspace"`,
		`-v "/iris/data/skills:/workspace/skills:ro"`,
		`-v "${logVolume}:/var/log/agent"`,
		`-v "${irisDir}/data/events:/iris/data/events"`,
		`-v "${irisDir}/data/models.json:/workspace/models.json:ro"`,
		`-v "${irisHome}/.azure:/root/.azure"`,
		// Mount owner's channel data dir so sub-agent shares state with main Iris
		// (check-in events run on host; direct messages run in container — same path needed)
		...(ownerChannel ? [`-v "${irisDir}/data/${ownerChannel}:/iris/data/${ownerChannel}"`] : []),
		`-p 127.0.0.1:${bridgePort}:${bridgePort}`,
		imageTag,
		`--sandbox=host /workspace`,
	].filter(Boolean).join(" ");

	log.logInfo(`[agent-provision] Starting container ${containerName} (bridge port ${bridgePort})`);
	const { stdout } = await execAsync(cmd);
	const containerId = stdout.trim();
	log.logInfo(`[agent-provision] Container started: ${containerId.slice(0, 12)}`);

	return containerName;
}

/**
 * Stop and remove a container. Silently ignores errors (container may be
 * already stopped or removed).
 */
export async function deprovisionAgent(containerName: string): Promise<void> {
	try {
		await execAsync(`docker stop "${containerName}" 2>/dev/null || true`);
		await execAsync(`docker rm -f "${containerName}" 2>/dev/null || true`);
		log.logInfo(`[agent-provision] Container removed: ${containerName}`);
	} catch (err) {
		log.logWarning("[agent-provision] deprovisionAgent error", String(err));
	}
}

// ============================================================================
// agents.json — bridge registry for Phase 5 conversation routing
// ============================================================================

interface AgentBridgeEntry {
	bridge_url: string;
	description: string;
	agentId: string;
}

/**
 * Register (or update) an agent's bridge URL in agents.json.
 * Phase 5 reads this file to route Telegram conversations to the correct container.
 */
export function registerAgentBridge(
	workingDir: string,
	agentName: string,
	agentId: string,
	slotIndex: number,
): void {
	const agentsFile = join(workingDir, "agents.json");
	let registry: Record<string, AgentBridgeEntry> = {};
	try {
		if (existsSync(agentsFile)) {
			registry = JSON.parse(readFileSync(agentsFile, "utf-8")) as Record<string, AgentBridgeEntry>;
		}
	} catch { /* start fresh */ }

	registry[agentName] = {
		bridge_url: `http://127.0.0.1:${bridgePortForSlot(slotIndex)}`,
		description: `Telegram agent: ${agentName}`,
		agentId,
	};
	writeFileSync(agentsFile, JSON.stringify(registry, null, 2));
	log.logInfo(`[agent-provision] Registered ${agentName} in agents.json`);
}

/**
 * Remove an agent's bridge entry from agents.json.
 */
export function unregisterAgentBridge(workingDir: string, agentName: string): void {
	const agentsFile = join(workingDir, "agents.json");
	try {
		if (!existsSync(agentsFile)) return;
		const registry = JSON.parse(readFileSync(agentsFile, "utf-8")) as Record<string, AgentBridgeEntry>;
		delete registry[agentName];
		writeFileSync(agentsFile, JSON.stringify(registry, null, 2));
	} catch { /* ignore */ }
}
