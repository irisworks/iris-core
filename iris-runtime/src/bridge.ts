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
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import * as log from "./log.js";
import { extractBearerToken, runtimeAuthHeader, validateRuntimeJWT, RUNTIME_AUTH_ENABLED } from "./auth.js";

// ============================================================================
// Pending request registry (module-level, shared with slack.ts via this module)
// ============================================================================

interface PendingRequest {
	resolve: (text: string) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

// Maps a stable channelId (e.g. "D0B8NQV8M9U", "tg-8814933356") → requestId.
// Used when the bridge routes through a persistent channel instead of BRIDGE-*.
const channelToPendingRequest = new Map<string, string>();

/**
 * Called when a message is posted to a BRIDGE-{requestId} channel.
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

/**
 * Resolve a bridge request by stable channelId.
 * Called by the sub-agent stub when postMessage/finalizeMessage fires on a
 * persistent Slack or Telegram channel that has a waiting bridge request.
 */
export function resolveBridgeByChannel(channelId: string, text: string): boolean {
	const requestId = channelToPendingRequest.get(channelId);
	if (!requestId) return false;
	channelToPendingRequest.delete(channelId);
	return resolveBridgeRequest(requestId, text);
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

// ── Notify callback (registered by main.ts after bot construction) ──────────

type NotifyCallback = (channelId: string, text: string) => Promise<void>;
let notifyCallback: NotifyCallback | null = null;

/**
 * Register the callback that handles /notify requests from Main Iris.
 * Called by sub-agents after their bot(s) are started.
 */
export function registerNotifyCallback(cb: NotifyCallback): void {
	notifyCallback = cb;
}

/**
 * POST /notify to a sub-agent's bridge server — delivers a notification
 * (e.g. missed-task alert) via the agent's own dedicated bot.
 * Called by Main Iris's notifyAgent scheduler callback.
 */
export async function notifyAgentBridge(
	bridgeUrl: string,
	agentId: string,
	runtime: "docker" | "firecracker",
	channelId: string,
	text: string,
): Promise<void> {
	const resp = await fetch(`${bridgeUrl}/notify`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...runtimeAuthHeader(agentId, runtime) },
		body: JSON.stringify({ channelId, text }),
		signal: AbortSignal.timeout(10_000),
	});
	if (!resp.ok) throw new Error(`/notify responded ${resp.status}`);
}

/**
 * Start the bridge HTTP server on the given port.
 * Called by sub-agents (not by Iris herself).
 */
export function startBridgeServer(port: number, workingDir: string): void {
	const BRIDGE_TIMEOUT_MS = 300_000; // 5 minutes — reasoning models (e.g. Kimi-K2.6) need 60-90s just for chain-of-thought

	const server = createServer(async (req, res) => {
		if (req.method !== "POST") {
			jsonResponse(res, 404, { error: "not found" });
			return;
		}

		// ── POST /notify — deliver a notification via this agent's own bot ──────
		if (req.url === "/notify") {
			let body: { channelId?: string; text?: string };
			try { body = JSON.parse(await readBody(req)); } catch {
				jsonResponse(res, 400, { error: "invalid JSON" });
				return;
			}
			if (!body.channelId || !body.text) {
				jsonResponse(res, 400, { error: "channelId and text are required" });
				return;
			}
			if (notifyCallback) {
				try {
					await notifyCallback(body.channelId, body.text);
					jsonResponse(res, 200, { ok: true });
				} catch (err) {
					log.logWarning("[bridge/notify] Failed to deliver notification", err instanceof Error ? err.message : String(err));
					jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
				}
			} else {
				log.logWarning("[bridge/notify] No notify callback registered — dropping notification");
				jsonResponse(res, 503, { error: "No notify handler registered" });
			}
			return;
		}

		if (req.url !== "/bridge") {
			jsonResponse(res, 404, { error: "not found" });
			return;
		}

		// Runtime JWT check — only enforced once RUNTIME_JWT_SECRET is configured,
		// so deployments that haven't opted in keep today's unauthenticated behaviour.
		if (RUNTIME_AUTH_ENABLED) {
			const token = extractBearerToken(req.headers.authorization);
			const payload = token ? validateRuntimeJWT(token) : null;
			const expectedAgentId = process.env.AGENT_ID;
			if (!payload || (expectedAgentId && payload.agentId !== expectedAgentId)) {
				log.logWarning("[bridge] Rejected request with invalid or missing Runtime JWT");
				jsonResponse(res, 401, { error: "Invalid or missing Runtime JWT" });
				return;
			}
		}

		let body: {
			text?: string;
			user?: string;
			requestId?: string;
			channelId?: string;
			history?: Array<{ date: string; ts: string; user: string; text: string; attachments: never[]; isBot: boolean }>;
		};
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			jsonResponse(res, 400, { error: "invalid JSON" });
			return;
		}

		const {
			text,
			user = "iris",
			requestId = randomBytes(8).toString("hex"),
			channelId: persistentChannelId,
			history = [],
		} = body;
		if (!text) {
			jsonResponse(res, 400, { error: "text is required" });
			return;
		}

		// Use persistent channel if provided, else fall back to ephemeral BRIDGE-* channel
		const channelId = persistentChannelId ?? `BRIDGE-${requestId}`;
		log.logInfo(`[bridge] Received request ${requestId} on channel ${channelId}: ${text.substring(0, 60)}`);

		// Seed the channel's log.jsonl with history entries BEFORE processing so
		// the AgentRunner has full conversation context when it loads the channel.
		if (persistentChannelId && history.length > 0) {
			try {
				// Resolve the channel dir the same way resolveChannelDir() in store.ts does
				const channelSubdir = persistentChannelId.startsWith("tg-") ? "telegram" : "slack";
				const channelDir = join(workingDir, channelSubdir, persistentChannelId);
				if (!existsSync(channelDir)) mkdirSync(channelDir, { recursive: true });
				const logPath = join(channelDir, "log.jsonl");
				// Write the full history (overwrite so we always have a clean, consistent log)
				writeFileSync(logPath, history.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
			} catch (err) {
				log.logWarning("[bridge] Failed to seed history log", err instanceof Error ? err.message : String(err));
			}
		}

		// Register pending request BEFORE writing event file to avoid race.
		// For persistent channels also store channelId → requestId mapping.
		const responsePromise = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingRequests.delete(requestId);
				if (persistentChannelId) channelToPendingRequest.delete(persistentChannelId);
				reject(new Error(`Bridge request ${requestId} timed out after ${BRIDGE_TIMEOUT_MS / 1000}s`));
			}, BRIDGE_TIMEOUT_MS);
			pendingRequests.set(requestId, { resolve, reject, timer });
		});
		if (persistentChannelId) channelToPendingRequest.set(persistentChannelId, requestId);

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
			if (persistentChannelId) channelToPendingRequest.delete(persistentChannelId);
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

	server.listen(port, "0.0.0.0", () => {
		log.logInfo(`[bridge] Bridge server listening on http://0.0.0.0:${port}`);
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
 * channelId: stable platform channel (e.g. "D0B8NQV8M9U", "tg-8814933356").
 *            When provided the sub-agent processes in that persistent channel
 *            so it accumulates conversation history across requests.
 * history:   prior log entries read from Azure Blob; injected into the
 *            channel's log.jsonl before the sub-agent runs.
 * agentId/runtime: identify the target sub-agent so the call can be signed
 *            with a Runtime JWT (only when RUNTIME_JWT_SECRET is configured).
 * Returns the agent's response text, or throws on timeout/error.
 */
export async function callAgentBridge(
	bridgeUrl: string,
	text: string,
	user: string,
	timeoutMs = 310_000, // slightly above server-side 300s so server error reaches caller before abort
	channelId?: string,
	history?: object[],
	agentId?: string,
	runtime?: "docker" | "firecracker",
): Promise<string> {
	const requestId = randomBytes(8).toString("hex");

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(`${bridgeUrl}/bridge`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(agentId ? runtimeAuthHeader(agentId, runtime ?? "docker") : {}),
			},
			body: JSON.stringify({ text, user, requestId, channelId, history }),
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
