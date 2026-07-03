/**
 * Internal agent bridge — enables @agentname routing between Iris and sub-agents.
 *
 * Architecture:
 *   Iris receives "@cricket what's the score?"
 *   → looks up cricket in agents.json
 *   → POSTs to cricket's bridge server (callAgentBridge)
 *   → cricket writes a BRIDGE-{requestId} event to its events dir
 *   → cricket's agent processes it, responds to BRIDGE-{requestId} channel
 *   → slack.ts intercepts BRIDGE-* postMessage, calls resolveBridgeRequest
 *   → HTTP response returns to Iris
 *   → Iris forwards to original caller (Slack/Telegram)
 *
 * Each sub-agent exposes a bridge server on IRIS_BRIDGE_PORT.
 * Iris has no bridge server (she routes, she doesn't receive bridges).
 *
 * agents.json format (at {workingDir}/agents.json):
 * {
 *   "cricket": { "bridge_url": "http://127.0.0.1:4100", "description": "Cricket scores" },
 *   "newsletter": { "bridge_url": "http://127.0.0.1:4101", "description": "Newsletter" }
 * }
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import * as log from "./log.js";

// ============================================================================
// Pending request registry (module-level, shared with slack.ts via this module)
// ============================================================================

interface PendingRequest {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

/**
 * Called by slack.ts when a message is posted to a BRIDGE-{requestId} channel.
 * Resolves the waiting HTTP request.
 */
export function resolveBridgeRequest(requestId: string, text: string): boolean {
	const pending = pendingRequests.get(requestId);
	if (!pending) return false;
	clearTimeout(pending.timer);
	pendingRequests.delete(requestId);
	pending.resolve(text);
	return true;
}

// ============================================================================
// Bridge server (runs inside each sub-agent)
// ============================================================================

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
	res.end(payload);
}

/**
 * Start the bridge HTTP server on the given port.
 * Called by sub-agents (not by Iris herself).
 */
export function startBridgeServer(port: number, workingDir: string): void {
	const BRIDGE_TIMEOUT_MS = 60_000; // 60 seconds max for sub-agent to respond

	const server = createServer(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/bridge") {
			jsonResponse(res, 404, { error: "not found" });
			return;
		}

		let body: { text?: string; user?: string; requestId?: string };
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			jsonResponse(res, 400, { error: "invalid JSON" });
			return;
		}

		const { text, user = "iris", requestId = randomBytes(8).toString("hex") } = body;
		if (!text) {
			jsonResponse(res, 400, { error: "text is required" });
			return;
		}

		const channelId = `BRIDGE-${requestId}`;
		log.logInfo(`[bridge] Received request ${requestId}: ${text.substring(0, 60)}`);

		// Register pending request BEFORE writing event file to avoid race
		const responsePromise = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingRequests.delete(requestId);
				reject(new Error(`Bridge request ${requestId} timed out after ${BRIDGE_TIMEOUT_MS / 1000}s`));
			}, BRIDGE_TIMEOUT_MS);
			pendingRequests.set(requestId, { resolve, reject, timer });
		});

		// Write event file to trigger agent processing
		const eventsDir = join(workingDir, "events");
		const eventFile = join(eventsDir, `bridge-${Date.now()}-${requestId}.json`);
		try {
			writeFileSync(eventFile, JSON.stringify({
				type: "immediate",
				channelId,
				user,
				text,
			}));
		} catch (err) {
			pendingRequests.delete(requestId);
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[bridge] Failed to write event file: ${msg}`);
			jsonResponse(res, 500, { error: `Failed to write event: ${msg}` });
			return;
		}

		// Wait for agent to respond
		try {
			const responseText = await responsePromise;
			log.logInfo(`[bridge] Response for ${requestId}: ${responseText.substring(0, 60)}`);
			jsonResponse(res, 200, { text: responseText, requestId });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[bridge] Request failed: ${msg}`);
			jsonResponse(res, 504, { error: msg });
		}
	});

	// Default bind is loopback; set IRIS_BRIDGE_HOST when the bridge must be
	// reachable from outside the container/host (e.g. cross-host sub-agents).
	const bridgeHost = process.env.IRIS_BRIDGE_HOST ?? "127.0.0.1";
	server.listen(port, bridgeHost, () => {
		log.logInfo(`[bridge] Bridge server listening on http://${bridgeHost}:${port}`);
	});

	server.on("error", (err) => {
		log.logWarning("[bridge] Server error", err.message);
	});
}

// ============================================================================
// Agent registry + bridge client (used by Iris to route @agentname messages)
// ============================================================================

export interface AgentEntry {
	bridge_url: string;
	description?: string;
}

export type AgentRegistry = Record<string, AgentEntry>;

/**
 * Load agents.json from the workspace directory.
 * Returns empty registry if file doesn't exist.
 */
export function loadAgentRegistry(workingDir: string): AgentRegistry {
	const registryPath = join(workingDir, "agents.json");
	if (!existsSync(registryPath)) return {};
	try {
		return JSON.parse(readFileSync(registryPath, "utf-8")) as AgentRegistry;
	} catch (err) {
		log.logWarning("[bridge] Failed to load agents.json", err instanceof Error ? err.message : String(err));
		return {};
	}
}

/**
 * Forward a message to a sub-agent via its bridge server.
 * Returns the agent's response text, or throws on timeout/error.
 */
export async function callAgentBridge(
	bridgeUrl: string,
	text: string,
	user: string,
	timeoutMs = 120_000,
): Promise<string> {
	const requestId = randomBytes(8).toString("hex");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(`${bridgeUrl}/bridge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, user, requestId }),
			signal: controller.signal,
		});

		if (!response.ok) {
			const err = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
			throw new Error(`Bridge returned ${response.status}: ${err.error ?? response.statusText}`);
		}

		const result = await response.json() as { text?: string };
		return result.text ?? "(no response)";
	} catch (err) {
		if ((err as Error).name === "AbortError") {
			throw new Error(`Agent bridge timed out after ${timeoutMs / 1000}s`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}
