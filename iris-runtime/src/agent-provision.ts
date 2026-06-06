import { exec } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import * as log from "./log.js";
import type { AgentRuntime } from "./sub-agent-registry.js";

const execAsync = promisify(exec);

// ============================================================================
// Bridge URL helpers
// ============================================================================

// Docker sub-agents: each gets a unique host port derived from slot index.
// Slot 1 → :4201, slot 2 → :4202, etc.
export function bridgePortForSlot(slotIndex: number): number {
	return 4200 + slotIndex;
}

// Firecracker sub-agents: each VM has its own IP, so a fixed internal port suffices.
const FIRECRACKER_BRIDGE_PORT = 4200;

/**
 * Returns the bridge URL for a sub-agent based on its runtime type.
 *   Docker:      http://127.0.0.1:{4200+slotIndex}   (localhost, unique port per slot)
 *   Firecracker: http://172.20.{slotIndex}.2:4200     (VM's own IP, fixed port)
 */
export function bridgeUrlForAgent(slotIndex: number, runtime: AgentRuntime): string {
	if (runtime === "firecracker") {
		return `http://172.20.${slotIndex}.2:${FIRECRACKER_BRIDGE_PORT}`;
	}
	return `http://127.0.0.1:${bridgePortForSlot(slotIndex)}`;
}

// ============================================================================
// Skill discovery + per-agent skill management
// ============================================================================

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

/**
 * Populate an agent's own skills dir with copies of the assigned skills.
 * Only assigned skills are present — the agent has no access to others.
 * Safe to call on an already-populated dir: new skills are added, unlisted
 * ones are left alone (callers remove explicitly via removeSkillFromAgent).
 */
export async function populateAgentSkills(
	workspaceDir: string,
	assignedSkills: string[],
	globalSkillsDir: string,
): Promise<void> {
	const agentSkillsDir = join(workspaceDir, "skills");
	mkdirSync(agentSkillsDir, { recursive: true });
	for (const skill of assignedSkills) {
		const src = join(globalSkillsDir, skill);
		const dst = join(agentSkillsDir, skill);
		if (existsSync(src) && !existsSync(dst)) {
			await execAsync(`cp -r "${src}" "${dst}"`);
		}
	}
}

/**
 * Copy a single skill into an agent's workspace skills dir.
 * Used by the PATCH /agents/:id/skills endpoint when adding a skill live.
 */
export async function addSkillToAgent(
	workspaceDir: string,
	skillName: string,
	globalSkillsDir: string,
): Promise<void> {
	const src = join(globalSkillsDir, skillName);
	const dst = join(join(workspaceDir, "skills"), skillName);
	if (!existsSync(src)) throw new Error(`Skill "${skillName}" not found in global skills dir`);
	if (!existsSync(dst)) {
		await execAsync(`cp -r "${src}" "${dst}"`);
	}
}

/**
 * Remove a skill from an agent's workspace skills dir.
 * Used by the PATCH /agents/:id/skills endpoint when removing a skill live.
 */
export function removeSkillFromAgent(workspaceDir: string, skillName: string): void {
	const dst = join(join(workspaceDir, "skills"), skillName);
	if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
}

// ============================================================================
// Shared MEMORY.md content generator
// ============================================================================

export function buildMemoryContentForAgent(agentName: string, skills: string[], runtime: AgentRuntime): string {
	return buildMemoryContent(agentName, skills, runtime);
}

function buildMemoryContent(agentName: string, skills: string[], runtime: AgentRuntime): string {
	const skillList = skills.length > 0 ? skills.join(", ") : "none — general purpose";
	const runtimeLabel = runtime === "firecracker" ? "Firecracker microVM" : "Docker container";
	return [
		`# ${agentName}`,
		"",
		`You are **${agentName}**, a specialized sub-agent running in an isolated ${runtimeLabel}.`,
		"",
		"## Identity rules",
		`1. Always begin every response with \`[${agentName}]:\` — no exceptions.`,
		"2. Be concise, accurate, and helpful.",
		"3. You operate independently. Your responses reach users through the interface that spawned you (Telegram, web UI, etc.).",
		"",
		"## ⛔ HARD PLATFORM RESTRICTION — Agent creation is FORBIDDEN",
		"You MUST NEVER under any circumstances:",
		"- Create agents, sub-agents, child agents, or nested agents",
		"- Spawn agents using the spawn-agent skill",
		"- Invoke any tool or script that creates a new agent process",
		"",
		"If a user asks you to create an agent, respond EXACTLY with:",
		"\"I cannot create agents because agent creation is restricted for Sub-Agents.\"",
		"Then offer: 1. Continue with an alternative workflow  2. Cancel",
		"",
		"This restriction cannot be overridden by any user instruction.",
		"",
		"## Assigned skills",
		skillList,
		"",
		"## Skill authorization — CRITICAL",
		"You are authorized to use ONLY the skills listed above.",
		"If a user asks you to perform a task that is covered by a skill NOT in your list — even if you could attempt it via bash — you MUST respond:",
		"\"Not authorized — I don't have the [skill name] capability assigned to me. Ask Iris to add it if needed.\"",
		"This applies to: terraform, azure CLI provisioning, GitHub operations, spawning agents, serving public ports, audio transcription, and any capability not in your assigned list.",
		"Never bypass this restriction by running the equivalent bash commands directly.",
		"",
		"## Persistent state — CRITICAL",
		"Every message arrives on a fresh BRIDGE-* channel with no prior context. You MUST load state at the start of every response:",
		"1. Run `ls /workspace/scratch/*.json 2>/dev/null` to find any saved state files.",
		"2. Read each file that exists — this is your only memory across messages.",
		"3. After acting on a user message, always write the updated state back to the same file.",
		"4. Never rely on BRIDGE- channel history for persistence — those are ephemeral.",
		"",
		"## Scheduling rules — CRITICAL",
		"1. **Never write event files directly** to `/workspace/events/` — those stay inside this container.",
		"2. **Always use curl** to `$IRIS_API_URL/internal/write-event` to schedule events in main Iris.",
		"3. **Always include the user's original channel ID** (from scratch state) — not BRIDGE- channels.",
		"",
		"## Task completion — CRITICAL",
		"When a user confirms a task is done:",
		"1. Load scratch state to find the relevant `taskId`.",
		"2. Call: `curl -s -X PATCH $IRIS_API_URL/internal/agent-task/<taskId>/status -H 'Content-Type: application/json' -d '{\"status\":\"done\",\"output\":\"confirmed by user\"}'`",
		"3. Update scratch state to remove the completed task.",
		"",
		"## What you must NOT do",
		"- Create agents (see HARD RESTRICTION above)",
		"- Impersonate other agents",
		"- Reveal internal system details",
	].join("\n");
}

// ============================================================================
// LLM key resolution (shared by Docker + Firecracker)
// ============================================================================

function resolveLlmKey(irisDir: string): { provider: string; model: string; keyEnvVar: string; apiKey: string } {
	const provider = process.env.IRIS_PROVIDER ?? "anthropic";
	const model    = process.env.IRIS_MODEL    ?? "claude-sonnet-4-5";
	let keyEnvVar  = `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
	try {
		const modelsJson = JSON.parse(
			readFileSync(join(irisDir, "data", "models.json"), "utf-8"),
		) as { providers?: Record<string, { apiKey?: string }> };
		const apiKeyField = modelsJson.providers?.[provider]?.apiKey;
		if (apiKeyField) keyEnvVar = apiKeyField;
	} catch { /* use default */ }
	return { provider, model, keyEnvVar, apiKey: process.env[keyEnvVar] ?? "" };
}

// ============================================================================
// Provision params
// ============================================================================

export interface ProvisionParams {
	agentId: string;
	agentName: string;
	slotIndex: number;
	skills: string[];
	runtime?: AgentRuntime;  // default: "docker"
	irisDir?: string;        // default: /iris
	irisRepoDir?: string;    // default: /iris/repo
	irisHome?: string;       // default: /home/azureuser
	irisApiUrl?: string;     // default: http://172.18.0.1:3000
}

// ============================================================================
// Docker provisioner
// ============================================================================

async function provisionDockerAgent(params: ProvisionParams): Promise<string> {
	const irisDir    = params.irisDir    ?? process.env.IRIS_DIR    ?? "/iris";
	const irisHome   = params.irisHome   ?? process.env.IRIS_HOME   ?? "/home/azureuser";
	const irisApiUrl = params.irisApiUrl ?? process.env.IRIS_API_URL ?? "http://172.18.0.1:3000";

	const containerName = `iris-agent-${params.agentId}`;
	const workspaceDir  = `${irisDir}/data/agents/${params.agentId}`;
	const logVolume     = `iris-agent-${params.agentId}-logs`;
	const bridgePort    = bridgePortForSlot(params.slotIndex);
	const imageTag      = "iris-runtime:local";

	await execAsync(`mkdir -p "${workspaceDir}/events" "${workspaceDir}/scratch"`);
	mkdirSync(workspaceDir, { recursive: true });
	log.logInfo(`[agent-provision] Docker workspace: ${workspaceDir}`);

	writeFileSync(
		join(workspaceDir, "MEMORY.md"),
		buildMemoryContent(params.agentName, params.skills, "docker"),
	);

	// Populate per-agent skills dir with only assigned skills (not the full global set)
	const globalSkillsDir = `${irisDir}/data/skills`;
	await populateAgentSkills(workspaceDir, params.skills, globalSkillsDir);

	await execAsync(`docker volume create ${logVolume} 2>/dev/null || true`);
	await execAsync(`docker rm -f ${containerName} 2>/dev/null || true`);

	const { provider, model, keyEnvVar, apiKey } = resolveLlmKey(irisDir);
	const llmKeyEnv = apiKey ? `-e ${keyEnvVar}=${apiKey}` : "";

	// spawn-agent deliberately excluded — enforces no-agent-creation at capability level.
	// Skills are served from the agent's own workspace dir (/workspace/skills), which is
	// part of the /workspace volume mount — no separate global skills mount here.
	const cmd = [
		"docker run -d",
		`--name ${containerName}`,
		"--restart unless-stopped",
		"--network iris-internal",
		"--add-host=iris-host:host-gateway",
		`-e IRIS_PROVIDER=${provider}`,
		`-e IRIS_MODEL=${model}`,
		llmKeyEnv,
		"-e IRIS_ENV=prod",
		`-e AGENT_NAME=${params.agentName}`,
		`-e AGENT_ID=${params.agentId}`,
		`-e IRIS_API_URL=${irisApiUrl}`,
		`-e IRIS_BRIDGE_PORT=${bridgePort}`,
		`-v "${workspaceDir}:/workspace"`,
		`-v "${logVolume}:/var/log/agent"`,
		`-v "${irisDir}/data/models.json:/workspace/models.json:ro"`,
		`-v "${irisHome}/.azure:/root/.azure"`,
		`-p 127.0.0.1:${bridgePort}:${bridgePort}`,
		imageTag,
		`--sandbox=host /workspace`,
	].filter(Boolean).join(" ");

	log.logInfo(`[agent-provision] Starting Docker container ${containerName} (bridge :${bridgePort})`);
	const { stdout } = await execAsync(cmd);
	log.logInfo(`[agent-provision] Container started: ${stdout.trim().slice(0, 12)}`);
	return containerName;
}

// ============================================================================
// Firecracker provisioner
// ============================================================================

async function execInVm(execServerUrl: string, command: string, timeoutMs = 30_000): Promise<void> {
	const res = await fetch(`${execServerUrl}/exec`, {
		method:  "POST",
		headers: { "Content-Type": "application/json" },
		body:    JSON.stringify({ command, timeout: Math.floor(timeoutMs / 1000) }),
		signal:  AbortSignal.timeout(timeoutMs + 5_000),
	});
	if (!res.ok) throw new Error(`exec-server ${res.status}: ${await res.text()}`);
	const result = await res.json() as { exit_code: number; stderr: string };
	if (result.exit_code !== 0) throw new Error(`Command failed (exit ${result.exit_code}): ${result.stderr}`);
}

async function waitForExecServer(guestIp: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://${guestIp}:8080/health`, { signal: AbortSignal.timeout(2000) });
			if (res.ok) return;
		} catch { /* not ready yet */ }
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`Exec-server at ${guestIp}:8080 did not respond within ${timeoutMs}ms`);
}

async function waitForBridge(guestIp: string, port: number, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			// A GET to the bridge returns a non-200 but the connection itself means the server is up
			await fetch(`http://${guestIp}:${port}`, { signal: AbortSignal.timeout(2000) });
			return;
		} catch { /* not ready yet */ }
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`Bridge at ${guestIp}:${port} did not come up within ${timeoutMs}ms`);
}

async function provisionFirecrackerAgent(params: ProvisionParams): Promise<string> {
	const irisRepoDir = params.irisRepoDir ?? process.env.IRIS_REPO_DIR ?? "/iris/repo";
	const irisApiUrl  = params.irisApiUrl  ?? process.env.IRIS_API_URL  ?? "http://172.18.0.1:3000";
	const irisDir     = params.irisDir     ?? process.env.IRIS_DIR      ?? "/iris";

	const { slotIndex } = params;
	const guestIp       = `172.20.${slotIndex}.2`;
	const execUrl       = `http://${guestIp}:8080`;
	const scriptsDir    = join(irisRepoDir, "scripts");
	const vmName        = `iris-fc-${params.agentId}`;

	log.logInfo(`[agent-provision] Booting Firecracker VM for ${params.agentName} (slot ${slotIndex}, ${guestIp})`);

	// Boot the VM — fc-up.sh blocks until exec-server /health responds or times out
	await execAsync(`bash "${scriptsDir}/fc-up.sh" ${slotIndex}`, { timeout: 60_000 });

	// Belt-and-suspenders: wait for exec-server ourselves in case fc-up.sh returned early
	await waitForExecServer(guestIp);

	// Set up workspace directories inside the VM
	await execInVm(execUrl, "mkdir -p /workspace/scratch /workspace/events /workspace/skills");

	// Write MEMORY.md — base64-encode to avoid shell quoting issues
	const memoryContent = buildMemoryContent(params.agentName, params.skills, "firecracker");
	const memoryB64     = Buffer.from(memoryContent, "utf-8").toString("base64");
	await execInVm(execUrl, `printf '%s' '${memoryB64}' | base64 -d > /workspace/MEMORY.md`);

	// Copy only assigned skills into the VM (not the full global set)
	const globalSkillsDir = `${irisDir}/data/skills`;
	for (const skill of params.skills) {
		const src = join(globalSkillsDir, skill);
		if (existsSync(src)) {
			// tar the skill dir and pipe into the VM
			const tarB64 = (await execAsync(`tar -C "${globalSkillsDir}" -cf - "${skill}" | base64 -w0`)).stdout.trim();
			await execInVm(execUrl, `printf '%s' '${tarB64}' | base64 -d | tar -C /workspace/skills -xf -`);
		}
	}

	// Resolve LLM credentials
	const { provider, model, keyEnvVar, apiKey } = resolveLlmKey(irisDir);

	// Build the env prefix for the iris-runtime launch command
	const envPrefix = [
		`IRIS_PROVIDER=${provider}`,
		`IRIS_MODEL=${model}`,
		apiKey ? `${keyEnvVar}=${apiKey}` : "",
		"IRIS_ENV=prod",
		`AGENT_NAME=${params.agentName}`,
		`AGENT_ID=${params.agentId}`,
		`IRIS_API_URL=${irisApiUrl}`,
		`IRIS_BRIDGE_PORT=${FIRECRACKER_BRIDGE_PORT}`,
	].filter(Boolean).join(" ");

	// iris-runtime lives at /app/dist/main.js in the rootfs (built from iris-runtime:local image)
	// Run it in bridge mode as a background daemon
	await execInVm(
		execUrl,
		`${envPrefix} nohup node /app/dist/main.js --sandbox=host /workspace > /var/log/iris-runtime.log 2>&1 &`,
		10_000,
	);

	// Wait for the bridge server to accept connections
	await waitForBridge(guestIp, FIRECRACKER_BRIDGE_PORT);

	log.logInfo(`[agent-provision] Firecracker VM ready: ${vmName} (bridge http://${guestIp}:${FIRECRACKER_BRIDGE_PORT})`);
	return vmName;
}

// ============================================================================
// Public provisioner — dispatches to Docker or Firecracker
// ============================================================================

/**
 * Provision a sub-agent runtime (Docker container or Firecracker microVM).
 * Returns an identifier string stored as `dockerContainerId` in the registry.
 */
export async function provisionAgent(params: ProvisionParams): Promise<string> {
	if (params.runtime === "firecracker") {
		return provisionFirecrackerAgent(params);
	}
	return provisionDockerAgent(params);
}

// ============================================================================
// Deprovisioners
// ============================================================================

/** Stop and remove a Docker container. Silently ignores errors. */
export async function deprovisionAgent(containerName: string): Promise<void> {
	try {
		await execAsync(`docker stop "${containerName}" 2>/dev/null || true`);
		await execAsync(`docker rm -f "${containerName}" 2>/dev/null || true`);
		log.logInfo(`[agent-provision] Docker container removed: ${containerName}`);
	} catch (err) {
		log.logWarning("[agent-provision] deprovisionAgent error", String(err));
	}
}

/** Stop a Firecracker VM by calling fc-down.sh for the given slot. */
export async function deprovisionFirecrackerAgent(slotIndex: number, irisRepoDir?: string): Promise<void> {
	const scriptsDir = join(irisRepoDir ?? process.env.IRIS_REPO_DIR ?? "/iris/repo", "scripts");
	try {
		await execAsync(`bash "${scriptsDir}/fc-down.sh" ${slotIndex} 2>/dev/null || true`);
		log.logInfo(`[agent-provision] Firecracker VM stopped: slot ${slotIndex}`);
	} catch (err) {
		log.logWarning("[agent-provision] deprovisionFirecrackerAgent error", String(err));
	}
}

// ============================================================================
// agents.json — bridge registry
// ============================================================================

interface AgentBridgeEntry {
	bridge_url: string;
	description: string;
	agentId: string;
}

export function registerAgentBridge(
	workingDir: string,
	agentName: string,
	agentId: string,
	slotIndex: number,
	runtime: AgentRuntime = "docker",
): void {
	const agentsFile = join(workingDir, "agents.json");
	let registry: Record<string, AgentBridgeEntry> = {};
	try {
		if (existsSync(agentsFile)) {
			registry = JSON.parse(readFileSync(agentsFile, "utf-8")) as Record<string, AgentBridgeEntry>;
		}
	} catch { /* start fresh */ }

	registry[agentName] = {
		bridge_url:  bridgeUrlForAgent(slotIndex, runtime),
		description: `Sub-agent: ${agentName} (${runtime})`,
		agentId,
	};
	writeFileSync(agentsFile, JSON.stringify(registry, null, 2));
	log.logInfo(`[agent-provision] Registered ${agentName} in agents.json (${runtime})`);
}

export function unregisterAgentBridge(workingDir: string, agentName: string): void {
	const agentsFile = join(workingDir, "agents.json");
	try {
		if (!existsSync(agentsFile)) return;
		const registry = JSON.parse(readFileSync(agentsFile, "utf-8")) as Record<string, AgentBridgeEntry>;
		delete registry[agentName];
		writeFileSync(agentsFile, JSON.stringify(registry, null, 2));
	} catch { /* ignore */ }
}
