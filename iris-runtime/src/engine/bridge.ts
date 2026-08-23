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
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import * as log from "./log.js";

// ============================================================================
// Pending request registry (module-level, shared with slack.ts via this module)
// ============================================================================

/** A line of the NDJSON stream a bridge request may emit before its reply. */
export type BridgeStreamLine =
	| { type: "accepted"; requestId: string; protocol: number }
	| { type: "status"; text: string; seq?: number }
	| { type: "heartbeat" }
	| { type: "final"; text: string; requestId: string; seq?: number }
	| { type: "error"; error: string; code: string; requestId: string; seq?: number };

type FinalLine = Extract<BridgeStreamLine, { type: "final" }>;

interface PendingRequest {
	resolve: (line: FinalLine) => void;
	reject: (err: Error) => void;
	/** Present only for streaming (NDJSON) requests — legacy callers get no progress. */
	onStatus?: (line: BridgeStreamLine) => void;
	/** Reset the idle deadline. Called on every sign of agent progress. */
	touch: () => void;
	/** Release the idle/hard timers and any heartbeat interval. */
	dispose: () => void;
}

const pendingRequests = new Map<string, PendingRequest>();

// ============================================================================
// Durable job log (issue #137)
//
// The open HTTP connection is a fragile job handle: if it drops mid-run, or the
// sub-agent process restarts mid-request, the pending registry (above) loses
// the request and the reply — though produced — goes nowhere. So every status,
// final, and error event is *also* appended to `{workingDir}/bridge-jobs/
// {requestId}.jsonl`, one JSON line per event with a monotonic `seq`, and
// `GET /bridge/jobs/{requestId}?since={seq}` serves events after `seq` plus a
// `done` flag. A caller that lost its stream resumes from its last seen seq;
// files, not a DB — core's default path is a plain Linux box.
//
// Only meaningful inside a sub-agent process (the bridge server owns the
// workingDir); on Iris's side `jobLogDir` stays unset and every append no-ops.
// One bridge server per process is the operating assumption.
// ============================================================================

const JOB_LOG_DIR_NAME = "bridge-jobs";

let jobLogDir: string | undefined;

/** Per-request seq counters, lazily resumed from an existing log on first use. */
const jobSeq = new Map<string, number>();

function jobRetentionMs(): number {
	return envMs("IRIS_BRIDGE_JOB_RETENTION_MS", 24 * 60 * 60 * 1000);
}

function bridgeJobPath(requestId: string): string | undefined {
	if (!jobLogDir) return undefined;
	// The requestId is caller-supplied and becomes a filename; same collapsing as
	// the channelId gets (see sanitizeBridgeKey).
	return join(jobLogDir, `${sanitizeBridgeKey(requestId)}.jsonl`);
}

/** Highest `seq` in an existing job log, or its line count if none carries one. */
function lastSeqInFile(path: string): number {
	try {
		const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
		for (let i = lines.length - 1; i >= 0; i--) {
			try {
				const seq = (JSON.parse(lines[i]) as { seq?: number }).seq;
				if (Number.isFinite(seq)) return seq as number;
			} catch {
				// Skip torn/unreadable lines.
			}
		}
		return lines.length;
	} catch {
		return 0;
	}
}

/**
 * Append one event to the request's durable log with the next monotonic seq,
 * returning the line to write to the wire so both carry the same seq. Never
 * throws — the durable log is a safety net, and a filesystem hiccup must not
 * take down the live reply path.
 */
function appendJobEvent(requestId: string, event: BridgeStreamLine): BridgeStreamLine {
	const path = bridgeJobPath(requestId);
	if (!path) return event;
	let seq = jobSeq.get(requestId);
	if (seq === undefined) {
		seq = lastSeqInFile(path);
		jobSeq.set(requestId, seq);
	}
	seq += 1;
	jobSeq.set(requestId, seq);
	const line = { ...event, seq } as BridgeStreamLine;
	try {
		appendFileSync(path, `${JSON.stringify(line)}\n`);
	} catch (err) {
		log.logWarning(`[bridge] Failed to append to job log for ${requestId}: ${err instanceof Error ? err.message : String(err)}`);
	}
	return line;
}

/**
 * Start a fresh job log for a new POST reusing an existing conversation key:
 * truncate rather than unlink, so a poller racing the reset sees an empty live
 * job instead of a 404.
 */
function resetJobLog(requestId: string): void {
	jobSeq.delete(requestId);
	const path = bridgeJobPath(requestId);
	if (!path) return;
	try {
		writeFileSync(path, "");
	} catch (err) {
		log.logWarning(`[bridge] Failed to reset job log for ${requestId}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Delete job logs older than `retentionMs`. Exported for tests; wired from
 * startBridgeServer at startup and then hourly.
 */
export function sweepBridgeJobLogs(retentionMs: number = jobRetentionMs()): number {
	if (!jobLogDir || retentionMs === 0) return 0;
	let removed = 0;
	let entries: string[];
	try {
		entries = readdirSync(jobLogDir);
	} catch {
		return 0;
	}
	const cutoff = Date.now() - retentionMs;
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const path = join(jobLogDir, entry);
		try {
			if (statSync(path).mtimeMs < cutoff) {
				rmSync(path);
				removed++;
			}
		} catch {
			// Raced a delete or a permission hiccup — leave it for the next sweep.
		}
	}
	return removed;
}

/** Settle a pending request: unregister it, stop its timers, hand it to `finish`. */
function settleBridgeRequest(requestId: string, finish: (pending: PendingRequest) => void): boolean {
	const pending = pendingRequests.get(requestId);
	if (!pending) return false;
	pending.dispose();
	pendingRequests.delete(requestId);
	finish(pending);
	return true;
}

/**
 * Called by slack.ts when a message is posted to a BRIDGE-{requestId} channel.
 * Resolves the waiting HTTP request. Also appended to the durable job log, so
 * a caller whose connection dropped — or one that comes back after the
 * sub-agent restarted — still receives the reply via
 * `GET /bridge/jobs/{requestId}` (issue #137).
 */
export function resolveBridgeRequest(requestId: string, text: string): boolean {
	const line = appendJobEvent(requestId, { type: "final", text, requestId });
	return settleBridgeRequest(requestId, (pending) => pending.resolve(line as FinalLine));
}

/**
 * Forward a mid-run progress line to a waiting bridge caller, and — for legacy
 * callers, which get no progress — at least prove the agent is alive so the
 * idle deadline doesn't fire under a long but healthy run. Wired from the engine
 * (engine/index.ts) onto `ctx.setStatus` for BRIDGE- channels, which agent.ts
 * already fires once per tool call.
 *
 * The status is persisted to the durable job log even when nobody is listening:
 * that is exactly the disconnected-caller case the log exists for.
 */
export function publishBridgeStatus(requestId: string, text: string): boolean {
	const line = appendJobEvent(requestId, { type: "status", text: text.substring(0, STATUS_MAX_CHARS) });
	const pending = pendingRequests.get(requestId);
	if (!pending) return false;
	pending.touch();
	pending.onStatus?.(line);
	return true;
}

/**
 * Is a bridge request still waiting for a reply? Used by the engine's post-run
 * fallback (engine/index.ts) to tell "the run already delivered its answer"
 * from "the run finished without delivering anything".
 */
export function hasPendingBridgeRequest(requestId: string): boolean {
	return pendingRequests.has(requestId);
}

/**
 * Fail a pending bridge request instead of letting the caller wait out its
 * deadline. Used by the bridge server when a request can no longer be answered:
 * its idle or hard deadline fired, a newer request took over the same
 * conversation key, or the caller hung up.
 */
export function failBridgeRequest(requestId: string, reason: string, code = "failed"): boolean {
	// A caller hanging up is not the job failing — the run keeps going and its
	// reply must stay recoverable via GET /bridge/jobs/:id, so "disconnected"
	// deliberately leaves no terminal event in the durable log.
	const line = code === "disconnected"
		? undefined
		: appendJobEvent(requestId, { type: "error", error: reason, code, requestId });
	return settleBridgeRequest(requestId, (pending) => pending.reject(new BridgeRequestError(reason, code, line)));
}

/** An error carrying the `code` that goes out on a streamed `error` line. */
class BridgeRequestError extends Error {
	/**
	 * The durable-log line for this failure, so the server can echo the exact
	 * seq'd event on the wire rather than reconstructing it.
	 */
	constructor(message: string, readonly code: string, readonly line?: BridgeStreamLine) {
		super(message);
	}
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
 * Serve `GET /bridge/jobs/{requestId}?since={seq}` — the recovery half of the
 * durable-job design (issue #137). Returns every log event after `since` plus
 * whether the job has reached a terminal event. An unknown requestId is a 404,
 * which tells a recovering caller there is nothing to resume.
 */
function handleJobPoll(res: ServerResponse, url: URL): void {
	const requestId = decodeURIComponent(url.pathname.slice("/bridge/jobs/".length));
	const parsedSince = Number.parseInt(url.searchParams.get("since") ?? "0", 10);
	const since = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0;
	const path = bridgeJobPath(requestId);
	if (!path || !existsSync(path)) {
		jsonResponse(res, 404, { error: "unknown job" });
		return;
	}
	const events: BridgeStreamLine[] = [];
	let done = false;
	try {
		for (const raw of readFileSync(path, "utf-8").split("\n")) {
			if (!raw.trim()) continue;
			let line: BridgeStreamLine;
			try {
				line = JSON.parse(raw) as BridgeStreamLine;
			} catch {
				continue; // Skip torn lines rather than failing the whole poll.
			}
			if ((line as { seq?: number }).seq === undefined || (line as { seq?: number }).seq as number > since) {
				events.push(line);
			}
			if (line.type === "final" || line.type === "error") done = true;
		}
	} catch (err) {
		jsonResponse(res, 500, { error: err instanceof Error ? err.message : String(err) });
		return;
	}
	jsonResponse(res, 200, { requestId, done, events });
}

function envMs(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Longest a status line may be before it's truncated on the way out. */
const STATUS_MAX_CHARS = 200;

/** Protocol version advertised on the `accepted` line. */
export const BRIDGE_STREAM_PROTOCOL = 1;

export const BRIDGE_STREAM_CONTENT_TYPE = "application/x-ndjson";

/**
 * Start the bridge HTTP server on the given port.
 * Called by sub-agents (not by Iris herself). Returns the underlying server
 * so callers that need to shut it down (tests) can — main.ts's own call
 * ignores the return value, matching the process-lifetime behavior before
 * this existed.
 *
 * `POST /bridge` answers in one of two shapes, negotiated on the request's
 * `Accept` header:
 *
 * - `Accept: application/x-ndjson` — a chunked NDJSON stream. Status 200 and an
 *   `accepted` line go out immediately, `status` lines follow as the agent works,
 *   and exactly one terminal `final` or `error` line closes it. Because headers
 *   are written up front this survives arbitrarily long runs; the blocking shape
 *   below cannot, since Node's own fetch caps time-to-headers at ~300s.
 * - anything else — the original single JSON body, byte-for-byte, so Iris's
 *   `curl … | jq -r '.text'` recipe and older sub-agents keep working.
 *
 * Neither shape has a fixed overall deadline any more. A request lives as long
 * as the agent keeps making progress (`publishBridgeStatus`), bounded by an idle
 * deadline and a hard cap — see the env vars below.
 *
 * Every status/final/error event is also appended to a durable per-request log
 * under `{workingDir}/bridge-jobs/` (issue #137), served back by
 * `GET /bridge/jobs/{requestId}?since={seq}` so a caller whose connection
 * dropped mid-run — or one returning after this process restarted — can resume
 * from its last seen `seq` instead of losing the reply. Finished logs are swept
 * after `IRIS_BRIDGE_JOB_RETENTION_MS` (default 24h; 0 keeps them forever).
 */
export function startBridgeServer(port: number, workingDir: string): import("http").Server {
	// No progress for this long ⇒ the agent is presumed wedged.
	const IDLE_MS = envMs("IRIS_BRIDGE_IDLE_TIMEOUT_MS", 180_000);
	// Backstop on total run time. Without it, an agent looping on tool calls
	// forever would hold a request (and burn tokens) indefinitely.
	const MAX_MS = envMs("IRIS_BRIDGE_MAX_MS", 600_000);
	// Keepalive cadence for streaming responses.
	const HEARTBEAT_MS = envMs("IRIS_BRIDGE_HEARTBEAT_MS", 15_000);
	// Non-streaming ceiling. Must stay under undici's ~300s headersTimeout, or
	// the caller's own fetch tears down the connection before we answer.
	const LEGACY_MAX_MS = envMs("IRIS_BRIDGE_LEGACY_TIMEOUT_MS", 240_000);

	jobLogDir = join(workingDir, JOB_LOG_DIR_NAME);
	try {
		mkdirSync(jobLogDir, { recursive: true });
	} catch (err) {
		log.logWarning(`[bridge] Failed to create ${JOB_LOG_DIR_NAME}: ${err instanceof Error ? err.message : String(err)}`);
	}
	sweepBridgeJobLogs();
	if (jobRetentionMs() > 0) {
		setInterval(() => sweepBridgeJobLogs(), 60 * 60 * 1000).unref?.();
	}

	const server = createServer(async (req, res) => {
		let url: URL;
		try {
			url = new URL(req.url ?? "/", "http://localhost");
		} catch {
			jsonResponse(res, 400, { error: "invalid URL" });
			return;
		}

		if (req.method === "GET" && url.pathname.startsWith("/bridge/jobs/")) {
			handleJobPoll(res, url);
			return;
		}
		if (req.method !== "POST" || url.pathname !== "/bridge") {
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

		const streaming = (req.headers.accept ?? "").includes(BRIDGE_STREAM_CONTENT_TYPE);
		const channelId = `BRIDGE-${requestId}`;
		log.logInfo(`[bridge] Received request ${requestId}${streaming ? " (streaming)" : ""}: ${text.substring(0, 60)}`);

		// Reusing a conversationKey as the requestId is the normal case, so a
		// second request for one already in flight isn't an error — the newer one
		// wins and the older is told why, rather than being orphaned in the map.
		if (pendingRequests.has(requestId)) {
			log.logWarning(`[bridge] Request ${requestId} superseded by a newer request`);
			failBridgeRequest(requestId, "superseded by a newer request", "superseded");
		}
		// A new POST starts a fresh job: truncate any prior log for this key (a
		// reused conversation key) so recovery polling never mixes runs.
		resetJobLog(requestId);

		const writeLine = (line: BridgeStreamLine): void => {
			if (res.writableEnded) return;
			res.write(`${JSON.stringify(line)}\n`);
		};

		if (streaming) {
			res.writeHead(200, {
				"Content-Type": BRIDGE_STREAM_CONTENT_TYPE,
				"Cache-Control": "no-store",
				// Stop nginx and friends buffering the stream into one lump.
				"X-Accel-Buffering": "no",
				Connection: "close",
			});
			// Flush headers + this line before the agent has done anything, so the
			// caller's time-to-first-byte doesn't scale with the run.
			writeLine({ type: "accepted", requestId, protocol: BRIDGE_STREAM_PROTOCOL });
		}

		// Register pending request BEFORE writing event file to avoid race
		let idleTimer: ReturnType<typeof setTimeout>;
		let hardTimer: ReturnType<typeof setTimeout>;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		// 0 disables a limit, so "the tighter of the two" has to read 0 as infinite
		// rather than as an instant deadline.
		const tighter = (a: number, b: number) => (a === 0 ? b : b === 0 ? a : Math.min(a, b));
		const idleMs = streaming ? IDLE_MS : tighter(IDLE_MS, LEGACY_MAX_MS);
		const hardMs = streaming ? MAX_MS : tighter(MAX_MS, LEGACY_MAX_MS);

		let registration: PendingRequest | undefined;
		const responsePromise = new Promise<FinalLine>((resolve, reject) => {
			const armIdle = () => {
				clearTimeout(idleTimer);
				if (idleMs > 0) {
					idleTimer = setTimeout(() => {
						failBridgeRequest(requestId, `no progress for ${idleMs / 1000}s`, "idle_timeout");
					}, idleMs);
				}
			};
			if (hardMs > 0) {
				hardTimer = setTimeout(() => {
					failBridgeRequest(requestId, `exceeded the ${hardMs / 1000}s limit`, "max_duration");
				}, hardMs);
			}
			if (streaming && HEARTBEAT_MS > 0) {
				// Deliberately does NOT touch the idle deadline — a heartbeat proves
				// the connection is alive, never that the agent is.
				heartbeat = setInterval(() => writeLine({ type: "heartbeat" }), HEARTBEAT_MS);
			}
			armIdle();
			registration = {
				resolve,
				reject,
				touch: armIdle,
				dispose: () => {
					clearTimeout(idleTimer);
					clearTimeout(hardTimer);
					if (heartbeat) clearInterval(heartbeat);
				},
				onStatus: streaming
					? (line) => writeLine(line)
					: undefined,
			};
			pendingRequests.set(requestId, registration);
		});

		// A caller that hangs up can no longer be answered. Drop the request so it
		// isn't held by its timers; the run itself is left alone — a transient blip
		// shouldn't kill work that's already half done.
		//
		// Identity-checked, not just keyed: closing this response also fires after a
		// newer request has taken over the same requestId (a reused conversation
		// key), and failing *that* one here would kill the live request instead.
		res.on("close", () => {
			if (registration && pendingRequests.get(requestId) === registration) {
				log.logWarning(`[bridge] Caller disconnected before ${requestId} was answered`);
				failBridgeRequest(requestId, "caller disconnected", "disconnected");
			}
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
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[bridge] Failed to write event file: ${msg}`);
			// Unregister and stop the timers, but leave the promise unsettled — we
			// answer the HTTP request directly below and never await it, so
			// rejecting here would surface as an unhandled rejection. Identity-checked
			// for the same reason as the close handler above.
			if (registration && pendingRequests.get(requestId) === registration) {
				registration.dispose();
				pendingRequests.delete(requestId);
			}
			if (streaming) {
				writeLine({ type: "error", error: "Failed to write event.", code: "event_write_failed", requestId });
				res.end();
			} else {
				jsonResponse(res, 500, { error: "Failed to write event." });
			}
			return;
		}

		// Wait for agent to respond
		try {
			const finalLine = await responsePromise;
			log.logInfo(`[bridge] Response for ${requestId}: ${finalLine.text.substring(0, 60)}`);
			if (streaming) {
				writeLine(finalLine);
				res.end();
			} else {
				jsonResponse(res, 200, { text: finalLine.text, requestId });
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			const code = err instanceof BridgeRequestError ? err.code : "failed";
			log.logWarning(`[bridge] Request failed: ${msg}`);
			if (code === "disconnected") {
				res.destroy();
			} else if (streaming) {
				writeLine(err instanceof BridgeRequestError && err.line
					? err.line
					: { type: "error", error: msg, code, requestId });
				res.end();
			} else {
				jsonResponse(res, 504, { error: "Bridge request failed." });
			}
		}
	});

	// Pin the socket-level ceilings rather than inheriting Node's defaults: a
	// streaming reply can legitimately outlive any of them.
	server.headersTimeout = 60_000;
	server.requestTimeout = 60_000;
	server.timeout = 0;
	server.keepAliveTimeout = 5_000;

	// Default bind is loopback; set IRIS_BRIDGE_HOST when the bridge must be
	// reachable from outside the container/host (e.g. cross-host sub-agents).
	const bridgeHost = process.env.IRIS_BRIDGE_HOST ?? "127.0.0.1";
	server.listen(port, bridgeHost, () => {
		log.logInfo(`[bridge] Bridge server listening on http://${bridgeHost}:${port}`);
	});

	server.on("error", (err) => {
		log.logWarning("[bridge] Server error", err.message);
	});

	return server;
}

// ============================================================================
// Agent registry + bridge client (used by Iris to route @agentname messages)
// ============================================================================

export interface AgentEntry {
	bridge_url: string;
	description?: string;
	/** Secret names this agent may request via GET /secrets/:name. Omitted/empty = no access. */
	secrets?: string[];
	/**
	 * Per-agent IRIS_API_TOKEN (see terraform/modules/agent's `api_token` output).
	 * When set, a request authenticating with this token is identified as this
	 * agent for the secrets allow-list, regardless of X-Iris-Caller. Omitted =
	 * this agent can only authenticate with the shared IRIS_API_TOKEN, which is
	 * always treated as the unrestricted "iris" caller.
	 */
	token?: string;
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
 * Detect a deterministic `@agentname` prefix on an inbound chat message and
 * resolve it against the agent registry — used by the Slack/Telegram
 * transports to bypass Iris's own LLM turn entirely for an explicit mention,
 * mirroring how the Web UI transport already skips straight to
 * `callAgentBridge()` for its `?agent=` param (web.ts). Only matches a
 * *leading* mention (start of message, after trimming whitespace) — a
 * `@name` appearing mid-sentence is left alone and falls through to Iris's
 * normal handling (including the intent-based bridge routing described in
 * her own system prompt, agent.ts), since scanning the whole message would
 * misfire on ordinary text that happens to mention someone by `@handle`.
 * Agent name matching is case-insensitive; an unmatched or unknown name
 * returns null so the caller falls through unchanged.
 */
export function parseAgentMention(
	text: string,
	registry: AgentRegistry,
): { name: string; entry: AgentEntry; query: string } | null {
	const m = text.trim().match(/^@([\w-]+)[:,]?\s*([\s\S]*)$/);
	if (!m) return null;
	const [, mentioned, query] = m;
	const name = Object.keys(registry).find((n) => n.toLowerCase() === mentioned.toLowerCase());
	if (!name) return null;
	return { name, entry: registry[name], query };
}

/**
 * Sanitize a caller-supplied conversation key into a safe requestId — it
 * becomes part of a `BRIDGE-{id}` channelId, which store.ts joins directly
 * onto a filesystem path, so anything outside [\w-] gets collapsed.
 */
function sanitizeBridgeKey(key: string): string {
	return key.replace(/[^\w-]/g, "-").slice(0, 128) || randomBytes(8).toString("hex");
}

export function bridgeStatusThrottleMs(): number {
	return envMs("IRIS_BRIDGE_STATUS_THROTTLE_MS", 3_000);
}

/**
 * A throttled status pusher. `cancel()` must be called once the run has settled:
 * a queued trailing update would otherwise fire *after* the reply replaced the
 * placeholder and put the stale status line back in its place.
 */
export type StatusThrottle = ((text: string) => void) & { cancel: () => void };

/**
 * Trailing-edge throttle for status forwarding. A tool-heavy run emits dozens of
 * status lines, and Slack's chat.update (like Telegram's editMessageText) is
 * rate-limited to roughly one call per second per channel — forwarding each line
 * as it arrives gets the bot throttled. Keeps only the newest text, emits at most
 * once per `ms`, and drops repeats.
 */
export function throttleStatus(emit: (text: string) => void, ms: number = bridgeStatusThrottleMs()): StatusThrottle {
	let last = 0;
	let lastText: string | undefined;
	let pending: ReturnType<typeof setTimeout> | undefined;
	let cancelled = false;
	const flush = (text: string) => {
		last = Date.now();
		lastText = text;
		emit(text);
	};
	const push = (text: string) => {
		if (cancelled || text === lastText) return;
		const wait = last + ms - Date.now();
		if (wait <= 0) {
			if (pending) { clearTimeout(pending); pending = undefined; }
			flush(text);
			return;
		}
		if (pending) clearTimeout(pending);
		pending = setTimeout(() => {
			pending = undefined;
			if (!cancelled && text !== lastText) flush(text);
		}, wait);
		// Timer must not hold the process open on shutdown.
		pending.unref?.();
	};
	push.cancel = () => {
		cancelled = true;
		if (pending) { clearTimeout(pending); pending = undefined; }
	};
	return push;
}

/** How often a recovering caller re-polls `GET /bridge/jobs/{id}`. */
function bridgeJobPollMs(): number {
	return envMs("IRIS_BRIDGE_JOB_POLL_MS", 2_000);
}

/**
 * Poll the sub-agent's durable job log after a stream broke mid-run (issue
 * #137), replaying events after `progress.seq` until a terminal one arrives.
 *
 * Gives up — returning undefined so the caller can rethrow its original error —
 * when the overall bridge deadline passes, or when no new event shows up for
 * `idleTimeoutMs`, preserving the fail-fast semantics of the idle timeout (the
 * job log carries statuses but not heartbeats, so silence still means wedged).
 * A terminal error event is thrown like the stream would have thrown it.
 */
async function recoverFromJobLog(
	bridgeUrl: string,
	requestId: string,
	progress: { seq: number },
	deadline: number,
	idleTimeoutMs: number,
): Promise<string | undefined> {
	const path = `/bridge/jobs/${encodeURIComponent(requestId)}`;
	let lastEventAt = Date.now();
	while (Date.now() < deadline && Date.now() - lastEventAt < idleTimeoutMs) {
		await new Promise((r) => setTimeout(r, Math.min(bridgeJobPollMs(), Math.max(deadline - Date.now(), 0)) || bridgeJobPollMs()));
		let body: { done?: boolean; events?: BridgeStreamLine[] };
		try {
			const res = await fetch(`${bridgeUrl}${path}?since=${progress.seq}`, {
				headers: { Accept: "application/json" },
			});
			if (res.status === 404) return undefined; // Unknown job — nothing to resume.
			if (!res.ok) continue; // Transient server hiccup — keep polling.
			body = await res.json() as { done?: boolean; events?: BridgeStreamLine[] };
		} catch {
			continue; // The sub-agent may itself be restarting — keep polling.
		}
		for (const line of body.events ?? []) {
			if (typeof (line as { seq?: number }).seq === "number" && (line as { seq?: number }).seq as number > progress.seq) {
				progress.seq = (line as { seq?: number }).seq as number;
			}
			lastEventAt = Date.now();
			if (line.type === "final") return line.text;
			if (line.type === "error") throw new Error(`Bridge failed (${line.code}): ${line.error}`);
		}
		// done with nothing after `since`: the job reached a terminal event at or
		// before our resume point (e.g. we already parsed that very error line
		// off the wire). Nothing further will arrive — stop instead of idling to
		// the give-up deadline.
		if (body.done && (body.events ?? []).length === 0) return undefined;
	}
	return undefined;
}

/**
 * Forward a message to a sub-agent via its bridge server.
 * Returns the agent's response text, or throws on timeout/error.
 *
 * If the streaming connection breaks mid-run, the reply is not lost: this
 * recovers by polling the sub-agent's durable job log (`GET /bridge/jobs/…`,
 * issue #137) from the last seen `seq` until the terminal event shows up.
 *
 * `conversationKey`, when given, is reused as the bridge requestId (and thus
 * the sub-agent's `BRIDGE-{id}` session directory) instead of a fresh random
 * one — so repeated `@mentions` from the same origin conversation (a Slack
 * channel/thread, a Telegram chat, a web session) land in the same sub-agent
 * session and keep its `context.jsonl` history, rather than starting a blank
 * session on every single message. Omit it only for one-off calls that
 * should never share history (there are currently none — every transport
 * call site passes one).
 */
export interface BridgeCallOptions {
	/** Overall wall-clock ceiling. Defaults to 10 minutes, matching the server's. */
	timeoutMs?: number;
	/**
	 * Abort if not a single byte arrives for this long *once a stream has started*
	 * — streaming replies heartbeat, so silence means the transport died. A
	 * non-streaming reply is one lump at the end and has nothing to be idle
	 * between, so it's bounded by `timeoutMs` (and the server's own legacy cap).
	 */
	idleTimeoutMs?: number;
	/** See the note above — reuse the origin conversation's key to keep its session. */
	conversationKey?: string;
	/** Called for each mid-run progress line the sub-agent emits. */
	onStatus?: (text: string) => void;
	/** Force the non-streaming single-JSON request. Default: stream. */
	stream?: boolean;
}

export async function callAgentBridge(
	bridgeUrl: string,
	text: string,
	user: string,
	options?: BridgeCallOptions | number,
	conversationKeyArg?: string,
): Promise<string> {
	// Historic signature was (url, text, user, timeoutMs, conversationKey); keep it
	// working rather than silently changing what a numeric 4th argument means.
	const opts: BridgeCallOptions = typeof options === "number"
		? { timeoutMs: options, conversationKey: conversationKeyArg }
		: { conversationKey: conversationKeyArg, ...options };

	const { timeoutMs = 600_000, idleTimeoutMs = 60_000, conversationKey, onStatus, stream = true } = opts;
	const requestId = conversationKey ? sanitizeBridgeKey(conversationKey) : randomBytes(8).toString("hex");

	const controller = new AbortController();
	let abortReason = `Agent bridge timed out after ${timeoutMs / 1000}s`;
	const startedAt = Date.now();
	const hardTimer = setTimeout(() => controller.abort(), timeoutMs);
	// Highest seq seen on the wire, so a broken stream can resume from the
	// durable job log without replaying statuses the caller already showed.
	const progress = { seq: 0 };
	let streamStarted = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	// Armed only once a stream is actually flowing (below). Arming it up front
	// would cap a non-streaming reply — which sends nothing until the run ends —
	// at idleTimeoutMs, reintroducing the very ceiling this change removes.
	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			abortReason = `Agent bridge went silent for ${idleTimeoutMs / 1000}s`;
			controller.abort();
		}, idleTimeoutMs);
	};

	try {
		const response = await fetch(`${bridgeUrl}/bridge`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(stream ? { Accept: BRIDGE_STREAM_CONTENT_TYPE } : {}),
			},
			body: JSON.stringify({ text, user, requestId }),
			signal: controller.signal,
		});

		if (!response.ok) {
			const err = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
			throw new Error(`Bridge returned ${response.status}: ${err.error ?? response.statusText}`);
		}

		// Branch on what came back, not on what we asked for: a sub-agent running
		// an older runtime ignores the Accept header and answers with plain JSON.
		const isStream = (response.headers.get("content-type") ?? "").includes(BRIDGE_STREAM_CONTENT_TYPE);
		if (!isStream) {
			const result = await response.json() as { text?: string };
			return result.text ?? "(no response)";
		}
		streamStarted = true;
		armIdle();
		return await readBridgeStream(response, armIdle, progress, onStatus);
	} catch (err) {
		// The stream broke mid-run — connection dropped, sub-agent restarted.
		// The durable job log is the recovery path; only if it yields nothing
		// does the original error surface. (A pre-stream failure has no job to
		// poll, and a legacy single-JSON call never started one.)
		if (streamStarted) {
			const recovered = await recoverFromJobLog(bridgeUrl, requestId, progress, startedAt + timeoutMs, idleTimeoutMs);
			if (recovered !== undefined) return recovered;
		}
		if ((err as Error).name === "AbortError") {
			throw new Error(abortReason);
		}
		throw err;
	} finally {
		clearTimeout(hardTimer);
		clearTimeout(idleTimer);
	}
}

/**
 * Consume an NDJSON bridge reply, forwarding `status` lines and returning the
 * text of the terminal `final` line. A stream that ends without a terminal line
 * throws rather than returning a placeholder — silently reporting "(no
 * response)" for a run that actually produced one is the bug this whole change
 * exists to fix.
 */
async function readBridgeStream(
	response: Response,
	onLine: () => void,
	progress: { seq: number },
	onStatus?: (text: string) => void,
): Promise<string> {
	if (!response.body) throw new Error("Bridge stream had no body");
	const decoder = new TextDecoder();
	let buffer = "";
	let loggedParseFailure = false;

	const handle = (raw: string): string | undefined => {
		let line: BridgeStreamLine;
		try {
			line = JSON.parse(raw) as BridgeStreamLine;
		} catch {
			// One unreadable line shouldn't sink an otherwise healthy reply.
			if (!loggedParseFailure) {
				loggedParseFailure = true;
				log.logWarning(`[bridge] Ignoring unparseable stream line: ${raw.substring(0, 80)}`);
			}
			return undefined;
		}
		// Unknown types are ignored on purpose, so the protocol can grow.
		const seq = (line as { seq?: number }).seq;
		if (typeof seq === "number" && seq > progress!.seq) progress!.seq = seq;
		if (line.type === "status") onStatus?.(line.text);
		else if (line.type === "error") throw new Error(`Bridge failed (${line.code}): ${line.error}`);
		else if (line.type === "final") return line.text;
		return undefined;
	};

	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		onLine();
		buffer += decoder.decode(chunk, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const raw of lines) {
			if (!raw.trim()) continue;
			const final = handle(raw);
			if (final !== undefined) return final;
		}
	}
	if (buffer.trim()) {
		const final = handle(buffer);
		if (final !== undefined) return final;
	}
	throw new Error("Bridge stream ended without a final reply");
}
