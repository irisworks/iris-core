/**
 * Internal HTTP API for iris-runtime.
 *
 * Always-on: started on IRIS_API_PORT (default 3000).
 * Binds to 0.0.0.0 so sub-agent Docker containers can reach it via the
 * iris-internal network gateway (172.18.0.1 by default).
 *
 * Endpoints:
 *   GET  /health                         — liveness check
 *   GET  /channels                       — list active channel states
 *   POST /event                          — inject immediate event into Iris's queue
 *                                          body: { channelId, text, user? }
 *   POST /escalate                       — sub-agent escalates a problem to Iris
 *                                          body: { agent, issue, context?, severity?, environment? }
 *
 *   POST   /sessions                     — create session
 *   GET    /sessions                     — list all sessions
 *   GET    /sessions/:id                 — get session
 *   PATCH  /sessions/:id                 — update session (partial patch)
 *   POST   /sessions/:id/message         — inject message, wait for response
 *   GET    /sessions/:id/history         — full log.jsonl as JSON array
 *   POST   /sessions/email-inbound       — route inbound email to matching session
 *   POST   /sessions/open                — post to channel, create session, return sessionId + threadTs
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import * as log from "./log.js";
import {
	createSession,
	findByEmail,
	loadSessions,
	updateSession,
	type Session,
} from "./sessions.js";

// Minimal interface so api.ts doesn't import SlackBot directly (avoids circular deps)
interface SessionInjector {
	injectSessionMessage(sessionId: string, user: string, text: string): Promise<string>;
	postMessage(channel: string, text: string): Promise<string>;
	resetSessionContext(sessionId: string): void;
}

interface ChannelState {
	running: boolean;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function json(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
	res.end(payload);
}

function writeEvent(eventsDir: string, channelId: string, user: string, text: string): string {
	const eventId = `api-${Date.now()}-${randomBytes(4).toString("hex")}`;
	const eventFile = join(eventsDir, `${eventId}.json`);
	writeFileSync(eventFile, JSON.stringify({
		type: "immediate",
		channelId,
		user,
		text,
	}));
	return eventId;
}

export function startApiServer(
	port: number,
	workingDir: string,
	channelStates: Map<string, ChannelState>,
	getBot: () => SessionInjector | null = () => null,
): void {
	const eventsDir = join(workingDir, "events");

	const server = createServer(async (req, res) => {
		const url = req.url ?? "/";
		const method = req.method ?? "GET";
		// URL parts without leading slash, e.g. ["sessions", "uuid", "message"]
		const urlParts = url.replace(/^\//, "").split("/").map((p) => decodeURIComponent(p));

		try {
			// ── GET /health ────────────────────────────────────────────────────────────
			if (method === "GET" && url === "/health") {
				json(res, 200, { ok: true, channels: channelStates.size });
				return;
			}

			// ── GET /channels ──────────────────────────────────────────────────────
			if (method === "GET" && url === "/channels") {
				const channels = Array.from(channelStates.entries()).map(([id, state]) => ({
					id,
					running: state.running,
				}));
				json(res, 200, { channels });
				return;
			}

			// ── POST /event ────────────────────────────────────────────────────────────
			// Inject a synthetic immediate event into Iris's queue.
			// body: { channelId: string, text: string, user?: string }
			if (method === "POST" && url === "/event") {
				let body: { channelId?: string; text?: string; user?: string };
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (!body.channelId || !body.text) {
					json(res, 400, { error: "channelId and text are required" });
					return;
				}
				const eventId = writeEvent(eventsDir, body.channelId, body.user ?? "api", body.text);
				log.logInfo(`[api] POST /event → ${body.channelId}: ${body.text.substring(0, 60)}`);
				json(res, 200, { ok: true, eventId });
				return;
			}

			// ── POST /escalate ─────────────────────────────────────────────────────
			// Sub-agent escalates a problem to Iris for diagnosis and recovery.
			// body: {
			//   agent:       string   — name of escalating agent (e.g. "cricket-scores")
			//   issue:       string   — human-readable problem description
			//   context?:    string   — additional diagnostic info (logs, errors, etc.)
			//   severity?:   "warning" | "error" | "critical"   (default: "error")
			//   environment?: "preview" | "prod"   (default: "prod")
			// }
			if (method === "POST" && url === "/escalate") {
				let body: {
					agent?: string;
					issue?: string;
					context?: string;
					severity?: string;
					environment?: string;
				};
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (!body.agent || !body.issue) {
					json(res, 400, { error: "agent and issue are required" });
					return;
				}

				const severity = body.severity ?? "error";
				const environment = body.environment ?? "prod";
				const agent = body.agent;

				const severityEmoji = severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "🟠";
				let text = `${severityEmoji} **Escalation from @${agent}** [${severity}/${environment}]: ${body.issue}`;
				if (body.context) {
					text += `\n\nContext:\n${body.context}`;
				}
				text += `\n\n_Received via internal API at ${new Date().toISOString()}_`;

				const channelId = `ESCALATE-${agent}`;
				const eventId = writeEvent(eventsDir, channelId, agent, text);
				log.logInfo(`[api] POST /escalate agent=${agent} severity=${severity}: ${body.issue.substring(0, 60)}`);
				json(res, 200, { ok: true, eventId, channelId });
				return;
			}

			// ── POST /sessions/open ──────────────────────────────────────────────────────
			// Post a message to a channel, get the ts, create a session — all in one call.
			// body: { channel, text, workingChannel?, clientEmail?, metadata? }
			// returns: { sessionId, threadTs, message }
			if (method === "POST" && urlParts[0] === "sessions" && urlParts[1] === "open") {
				let body: {
					channel?: string;
					text?: string;
					workingChannel?: string;
					clientEmail?: string;
					metadata?: Record<string, unknown>;
				};
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (!body.channel || !body.text) {
					json(res, 400, { error: "channel and text are required" });
					return;
				}
				const bot = getBot();
				if (!bot) {
					json(res, 503, { error: "bot not started" });
					return;
				}
				// Post to the channel to get a thread_ts
				const threadTs = await bot.postMessage(body.channel, body.text);
				// Create the session pointing at this new thread
				const session = createSession(workingDir, {
					originChannel: body.channel,
					originThreadTs: threadTs,
					workingChannel: body.workingChannel,
					clientEmail: body.clientEmail,
					metadata: body.metadata,
				});
				log.logInfo(`[api] POST /sessions/open → ${body.channel} ts=${threadTs} session=${session.sessionId}`);
				json(res, 201, { sessionId: session.sessionId, threadTs, message: body.text });
				return;
			}

			// ── POST /sessions/email-inbound ────────────────────────────────────────────────
			// Must be checked BEFORE /sessions/:id to avoid treating "email-inbound" as an ID
			if (method === "POST" && urlParts[0] === "sessions" && urlParts[1] === "email-inbound") {
				let body: { from?: string; subject?: string; text?: string };
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (!body.from || !body.text) {
					json(res, 400, { error: "from and text are required" });
					return;
				}
				const sessions = loadSessions(workingDir);
				const session = findByEmail(sessions, body.from);
				if (!session) {
					json(res, 404, { error: "no session found for this email" });
					return;
				}
				const bot = getBot();
				if (!bot) {
					json(res, 503, { error: "session injection not available (bot not started)" });
					return;
				}
				const subject = body.subject ? `[Subject: ${body.subject}] ` : "";
				const messageText = `${subject}${body.text}`;
				const responseText = await bot.injectSessionMessage(session.sessionId, body.from, messageText);
				log.logInfo(`[api] POST /sessions/email-inbound → session ${session.sessionId}`);
				json(res, 200, { sessionId: session.sessionId, response: responseText });
				return;
			}

			// ── POST /sessions ───────────────────────────────────────────────────────────────
			if (method === "POST" && urlParts[0] === "sessions" && urlParts.length === 1) {
				let body: {
					originChannel?: string;
					originThreadTs?: string;
					workingChannel?: string;
					workingThreadTs?: string;
					clientEmail?: string;
					metadata?: Record<string, unknown>;
				};
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (!body.originChannel || !body.originThreadTs) {
					json(res, 400, { error: "originChannel and originThreadTs are required" });
					return;
				}
				const session = createSession(workingDir, {
					originChannel: body.originChannel,
					originThreadTs: body.originThreadTs,
					workingChannel: body.workingChannel,
					workingThreadTs: body.workingThreadTs,
					clientEmail: body.clientEmail,
					metadata: body.metadata,
				});
				log.logInfo(`[api] POST /sessions → created ${session.sessionId}`);
				json(res, 201, session);
				return;
			}

			// ── GET /sessions ────────────────────────────────────────────────────────────────
			if (method === "GET" && urlParts[0] === "sessions" && urlParts.length === 1) {
				const sessions = loadSessions(workingDir);
				json(res, 200, { sessions: Array.from(sessions.values()) });
				return;
			}

			// ── GET /sessions/:id ──────────────────────────────────────────────────────────
			if (method === "GET" && urlParts[0] === "sessions" && urlParts.length === 2 && urlParts[1]) {
				const sessionId = urlParts[1];
				const sessions = loadSessions(workingDir);
				const session = sessions.get(sessionId);
				if (!session) {
					json(res, 404, { error: "session not found" });
					return;
				}
				json(res, 200, session);
				return;
			}

			// ── PATCH /sessions/:id ──────────────────────────────────────────────────────────
			if (method === "PATCH" && urlParts[0] === "sessions" && urlParts.length === 2 && urlParts[1]) {
				const sessionId = urlParts[1];
				let body: Partial<Session>;
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				let updated: Session;
				try {
					updated = updateSession(workingDir, sessionId, body);
				} catch (err) {
					json(res, 404, { error: err instanceof Error ? err.message : String(err) });
					return;
				}
				log.logInfo(`[api] PATCH /sessions/${sessionId}`);
				json(res, 200, updated);
				return;
			}

			// ── POST /sessions/:id/message ─────────────────────────────────────────────────────
			if (method === "POST" && urlParts[0] === "sessions" && urlParts[2] === "message") {
				const sessionId = urlParts[1];
				const sessions = loadSessions(workingDir);
				if (!sessions.has(sessionId)) {
					json(res, 404, { error: "session not found" });
					return;
				}
				let body: { text?: string; user?: string };
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (!body.text) {
					json(res, 400, { error: "text is required" });
					return;
				}
				const bot = getBot();
				if (!bot) {
					json(res, 503, { error: "session injection not available (bot not started)" });
					return;
				}
				log.logInfo(`[api] POST /sessions/${sessionId}/message: ${body.text.substring(0, 60)}`);
				try {
					const responseText = await bot.injectSessionMessage(sessionId, body.user ?? "api", body.text);
					json(res, 200, { text: responseText });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					log.logWarning(`[api] Session message failed: ${msg}`);
					json(res, 504, { error: msg });
				}
				return;
			}

			// ── GET /sessions/:id/history ────────────────────────────────────────────────────────
			if (method === "GET" && urlParts[0] === "sessions" && urlParts[2] === "history") {
				const sessionId = urlParts[1];
				const sessions = loadSessions(workingDir);
				if (!sessions.has(sessionId)) {
					json(res, 404, { error: "session not found" });
					return;
				}
				const logPath = join(workingDir, `SESSION-${sessionId}`, "log.jsonl");
				if (!existsSync(logPath)) {
					json(res, 200, { history: [] });
					return;
				}
				const content = readFileSync(logPath, "utf-8");
				const history = content
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => { try { return JSON.parse(line); } catch { return null; } })
					.filter(Boolean);
				json(res, 200, { history });
				return;
			}

			// ── POST /sessions/:id/reset ────────────────────────────────────────────────────
			// Wipes context.jsonl and log.jsonl for a session so the next message
			// starts completely fresh. Used by bridge /clear command.
			if (method === "POST" && urlParts[0] === "sessions" && urlParts[2] === "reset") {
				const sessionId = urlParts[1];
				const sessions = loadSessions(workingDir);
				if (!sessions.has(sessionId)) {
					json(res, 404, { error: "session not found" });
					return;
				}
				const sessionDir = join(workingDir, `SESSION-${sessionId}`);
				const { writeFileSync: wf, existsSync: ef } = await import("fs");
				if (ef(join(sessionDir, "context.jsonl"))) wf(join(sessionDir, "context.jsonl"), "");
				if (ef(join(sessionDir, "log.jsonl")))     wf(join(sessionDir, "log.jsonl"), "");
				if (ef(join(sessionDir, "last_prompt.jsonl"))) wf(join(sessionDir, "last_prompt.jsonl"), "");
				// Also reset the in-memory agent context
				const bot = getBot();
				if (bot) {
					try { bot.resetSessionContext(sessionId); } catch { /* best effort */ }
				}
				log.logInfo(`[api] POST /sessions/${sessionId}/reset: context wiped`);
				json(res, 200, { status: "ok", message: "Context cleared" });
				return;
			}

			// ── POST /sessions/:id/inject-turn ────────────────────────────────────────────────
			// Appends a human-agent echo message to session log WITHOUT triggering LLM.
			// Written as a plain user message with "[team]:" prefix so it's
			// visible in both LLM context sync AND bash grep searches.
			if (method === "POST" && urlParts[0] === "sessions" && urlParts[2] === "inject-turn") {
				const sessionId = urlParts[1];
				const sessions = loadSessions(workingDir);
				if (!sessions.has(sessionId)) {
					json(res, 404, { error: "session not found" });
					return;
				}
				let body: { text?: string; user?: string };
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (!body.text) {
					json(res, 400, { error: "text is required" });
					return;
				}
				// Always write as a user-role log entry with [team] prefix
				// — syncs naturally into LLM context, and bash grep finds it too
				const entry = {
					date: new Date().toISOString(),
					ts: (Date.now() / 1000).toFixed(6),
					user: "human-agent",
					userName: "team",
					text: `[team]: ${body.text}`,
					attachments: [],
					isBot: false,
				};
				const logPath = join(workingDir, `SESSION-${sessionId}`, "log.jsonl");
				const { mkdirSync, appendFileSync } = await import("fs");
				mkdirSync(join(workingDir, `SESSION-${sessionId}`), { recursive: true });
				appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
				log.logInfo(`[api] POST /sessions/${sessionId}/inject-turn: ${body.text.substring(0, 60)}`);
				json(res, 200, { status: "ok" });
				return;
			}

			json(res, 404, { error: "not found" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.logWarning("[api] request error", msg);
			json(res, 500, { error: msg });
		}
	});

	// Bind to 0.0.0.0 so Docker containers on iris-internal network can reach Iris
	server.listen(port, "0.0.0.0", () => {
		log.logInfo(`[api] Internal API listening on http://0.0.0.0:${port}`);
	});

	server.on("error", (err) => {
		log.logWarning("[api] server error", err.message);
	});
}
