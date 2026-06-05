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
 *   GET    /agents                        — list all sub-agents
 *   POST   /agents                        — create a sub-agent
 *   GET    /agents/:id                    — get a sub-agent
 *   DELETE /agents/:id                    — delete a sub-agent
 *   PATCH  /agents/:id/skills             — add/remove skills
 *   POST   /agents/:id/telegram/token     — generate Telegram link token
 *   DELETE /agents/:id/telegram           — unlink Telegram from sub-agent
 *   POST /internal/write-event           — write an event file (immediate/one-shot/periodic/interval)
 *                                          body: { name, type, channelId, text, ...type-specific fields }
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
import { getSubAgent, listSubAgents, createSubAgent, deleteSubAgent, updateSubAgentStatus } from "./sub-agent-registry.js";
import { createTask, getTask, updateTaskStatus, type TaskStatus } from "./task-queue.js";
import { scheduleNewTask, type SchedulerCallbacks } from "./scheduler.js";
import { bridgePortForSlot, deprovisionAgent, getAvailableSkills, provisionAgent, registerAgentBridge, unregisterAgentBridge } from "./agent-provision.js";
import type { TelegramLinkManager } from "./telegram-link.js";

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
	writeFileSync(eventFile, JSON.stringify({ type: "immediate", channelId, user, text }));
	return eventId;
}

export function startApiServer(
	port: number,
	workingDir: string,
	channelStates: Map<string, ChannelState>,
	getBot: () => SessionInjector | null = () => null,
	telegramLinkManager: TelegramLinkManager | null = null,
	schedulerCallbacks: SchedulerCallbacks | null = null,
): void {
	const eventsDir = join(workingDir, "events");

	const server = createServer(async (req, res) => {
		const url = req.url ?? "/";
		const method = req.method ?? "GET";
		// URL parts without leading slash, e.g. ["sessions", "uuid", "message"]
		const urlParts = url.replace(/^\//, "").split("/").map((p) => decodeURIComponent(p));

		try {
			// ── Guard dog — agent isolation enforcement ─────────────────────────────
			// Requests from known agents must carry X-Agent-ID. We validate the agent
			// exists in the registry (blocks spoofed or deleted agent IDs).
			// Channel-level isolation is enforced by Docker volume scoping — each agent
			// container has its own workspace and cannot reach another agent's files.
			const agentId = req.headers["x-agent-id"] as string | undefined;
			if (agentId) {
				const agentRecord = await getSubAgent(agentId);
				if (!agentRecord) {
					log.logWarning(`[guard-dog] Rejected request from unknown agent ID: ${agentId}`, url);
					json(res, 403, { error: `Guard dog: unknown agent ID ${agentId}` });
					return;
				}
				log.logInfo(`[guard-dog] Agent ${agentRecord.name} (${agentId}) → ${method} ${url}`);
			}

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

			// ── POST /internal/write-event ─────────────────────────────────────────
			// Write an event file to the appropriate transport events directory.
			// Supports all four event types: immediate, one-shot, periodic, interval.
			if (method === "POST" && urlParts[0] === "internal" && urlParts[1] === "write-event") {
				let body: Record<string, unknown>;
				try {
					body = JSON.parse(await readBody(req)) as Record<string, unknown>;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}

				const { name, type, channelId, text } = body;
				if (!name || !type || !channelId || !text) {
					json(res, 400, { error: "name, type, channelId, text are required" });
					return;
				}

				// Route to the right events subdirectory based on channel prefix
				const subDir = String(channelId).startsWith("tg-") ? "telegram" : "slack";
				const dir = join(workingDir, subDir, "events");
				const filename = `${String(name)}-${Date.now()}.json`;
				const filePath = join(dir, filename);

				// Build the event payload — only include known fields per type
				let payload: Record<string, unknown>;
				switch (String(type)) {
					case "immediate":
						payload = { type: "immediate", channelId, text };
						break;
					case "one-shot":
						if (!body.at) { json(res, 400, { error: "'at' is required for one-shot events" }); return; }
						payload = { type: "one-shot", channelId, text, at: body.at };
						break;
					case "periodic":
						if (!body.schedule || !body.timezone) { json(res, 400, { error: "'schedule' and 'timezone' are required for periodic events" }); return; }
						payload = { type: "periodic", channelId, text, schedule: body.schedule, timezone: body.timezone };
						break;
					case "interval":
						if (typeof body.intervalSeconds !== "number" || body.intervalSeconds <= 0) { json(res, 400, { error: "'intervalSeconds' must be a positive number for interval events" }); return; }
						payload = { type: "interval", channelId, text, intervalSeconds: body.intervalSeconds };
						if (body.endsAt) payload.endsAt = body.endsAt;
						if (body.count !== undefined) payload.count = Number(body.count);
						break;
					default:
						json(res, 400, { error: `unknown event type '${type}'` });
						return;
				}

				try {
					const { mkdirSync: mkdir2 } = await import("fs");
					mkdir2(dir, { recursive: true });
					writeFileSync(filePath, JSON.stringify(payload, null, 2));
					log.logInfo(`[api] POST /internal/write-event → ${filename} (${type})`);
					json(res, 200, { ok: true, filename });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					json(res, 500, { error: `Failed to write event file: ${msg}` });
				}
				return;
			}

			// ── GET /agents ──────────────────────────────────────────────────────────
			// List all sub-agents.
			if (method === "GET" && url === "/agents") {
				const agents = await listSubAgents();
				json(res, 200, { agents });
				return;
			}

			// ── POST /agents ──────────────────────────────────────────────────────────
			// Create a new sub-agent and provision its Docker container.
			// body: { name: string, skills?: string[] }
			if (method === "POST" && url === "/agents") {
				let body: { name?: string; skills?: string[] };
				try { body = JSON.parse(await readBody(req)); } catch {
					json(res, 400, { error: "invalid JSON body" }); return;
				}
				if (!body.name) { json(res, 400, { error: "name is required" }); return; }
				if (!/^[a-zA-Z0-9-]{1,32}$/.test(body.name)) {
					json(res, 400, { error: "name must contain only letters, numbers, and hyphens (max 32 chars)" }); return;
				}
				const record = await createSubAgent({ name: body.name, skills: body.skills ?? [] });
				if (!record) { json(res, 409, { error: `Agent "${body.name}" already exists or no slots available` }); return; }

				try {
					const containerName = await provisionAgent({
						agentId:   record.agentId,
						agentName: record.name,
						slotIndex: record.slotIndex,
						skills:    record.skills,
					});
					await updateSubAgentStatus(record.agentId, "running", containerName);
					registerAgentBridge(workingDir, record.name, record.agentId, record.slotIndex);
					log.logInfo(`[api] POST /agents → created "${record.name}" (slot ${record.slotIndex})`);
					json(res, 201, { ...record, status: "running", dockerContainerId: containerName });
				} catch (err) {
					await deleteSubAgent(record.agentId);
					json(res, 500, { error: `Container failed to start: ${String(err)}` });
				}
				return;
			}

			// ── GET /agents/:id ───────────────────────────────────────────────────────
			if (method === "GET" && urlParts[0] === "agents" && urlParts[1] && !urlParts[2]) {
				const agent = await getSubAgent(urlParts[1]);
				if (!agent) { json(res, 404, { error: "Agent not found" }); return; }
				json(res, 200, agent);
				return;
			}

			// ── DELETE /agents/:id ────────────────────────────────────────────────────
			// Stop container, remove from bridge registry, unlink from Telegram, delete record.
			if (method === "DELETE" && urlParts[0] === "agents" && urlParts[1] && !urlParts[2]) {
				const agent = await getSubAgent(urlParts[1]);
				if (!agent) { json(res, 404, { error: "Agent not found" }); return; }

				// Unlink Telegram if linked
				if (telegramLinkManager) await telegramLinkManager.unlinkAgent(agent.agentId);

				await deprovisionAgent(`iris-tg-${agent.agentId}`);
				unregisterAgentBridge(workingDir, agent.name);
				const ok = await deleteSubAgent(agent.agentId);
				log.logInfo(`[api] DELETE /agents/${agent.agentId} → ${ok ? "deleted" : "partial failure"}`);
				json(res, 200, { ok, agentId: agent.agentId });
				return;
			}

			// ── PATCH /agents/:id/skills ──────────────────────────────────────────────
			// Add or remove skills from a sub-agent's runtime.
			// body: { add?: string[], remove?: string[] }
			if (method === "PATCH" && urlParts[0] === "agents" && urlParts[1] && urlParts[2] === "skills") {
				const agent = await getSubAgent(urlParts[1]);
				if (!agent) { json(res, 404, { error: "Agent not found" }); return; }

				let body: { add?: string[]; remove?: string[] };
				try { body = JSON.parse(await readBody(req)); } catch {
					json(res, 400, { error: "invalid JSON body" }); return;
				}

				const available = getAvailableSkills(process.env.IRIS_SKILLS_DIR
					?? `${process.env.IRIS_DIR ?? "/iris"}/data/skills`);

				const invalidSkills = [...(body.add ?? []), ...(body.remove ?? [])].filter(s => !available.includes(s));
				if (invalidSkills.length > 0) {
					json(res, 400, { error: `Unknown skills: ${invalidSkills.join(", ")}. Available: ${available.join(", ")}` }); return;
				}

				// Skills are mounted via volume — just update the registry record
				let updatedSkills = [...agent.skills];
				if (body.add) updatedSkills = [...new Set([...updatedSkills, ...body.add])];
				if (body.remove) updatedSkills = updatedSkills.filter(s => !(body.remove ?? []).includes(s));

				const { getDb } = await import("./db.js");
				const db = getDb();
				if (db) {
					await db.from("sub_agents").update({ skills: updatedSkills, updated_at: new Date().toISOString() }).eq("agent_id", agent.agentId);
				}

				// Invalidate Telegram link cache so next message sees updated skill list
				if (telegramLinkManager) telegramLinkManager.invalidateCache(
					(await telegramLinkManager.getBotForAgent(agent.agentId)) ?? ""
				);

				log.logInfo(`[api] PATCH /agents/${agent.agentId}/skills → ${updatedSkills.join(", ")}`);
				json(res, 200, { agentId: agent.agentId, skills: updatedSkills });
				return;
			}

			// ── POST /agents/:id/telegram/token ──────────────────────────────────────
			// Generate a claim token for connecting a Telegram bot to this sub-agent.
			// Returns the token the user must send to the Telegram bot.
			if (method === "POST" && urlParts[0] === "agents" && urlParts[2] === "telegram" && urlParts[3] === "token") {
				if (!telegramLinkManager) { json(res, 503, { error: "Telegram link manager not initialised" }); return; }
				const agent = await getSubAgent(urlParts[1]);
				if (!agent) { json(res, 404, { error: "Agent not found" }); return; }

				try {
					const token = await telegramLinkManager.generateToken(agent.agentId);
					const tokenFile = join(workingDir, "data", "telegram-link-token.txt");
					try {
						mkdirSync(join(workingDir, "data"), { recursive: true });
						writeFileSync(tokenFile, token, { mode: 0o600 });
					} catch { /* non-fatal */ }
					log.logInfo(`[api] POST /agents/${agent.agentId}/telegram/token — claim token issued`);
					json(res, 200, {
						token,
						agentName: agent.name,
						expiresInSeconds: 600,
						instructions: `Send this token to your Telegram bot to link it to "${agent.name}". Token expires in 10 minutes.`,
					});
				} catch (err) {
					json(res, 409, { error: String(err) });
				}
				return;
			}

			// ── DELETE /agents/:id/telegram ───────────────────────────────────────────
			// Disconnect the Telegram bot from this sub-agent.
			if (method === "DELETE" && urlParts[0] === "agents" && urlParts[2] === "telegram" && !urlParts[3]) {
				if (!telegramLinkManager) { json(res, 503, { error: "Telegram link manager not initialised" }); return; }
				const agent = await getSubAgent(urlParts[1]);
				if (!agent) { json(res, 404, { error: "Agent not found" }); return; }

				const ok = await telegramLinkManager.unlinkAgent(agent.agentId);
				log.logInfo(`[api] DELETE /agents/${agent.agentId}/telegram → ${ok ? "unlinked" : "failed"}`);
				json(res, 200, { ok, agentId: agent.agentId });
				return;
			}

			// ── POST /internal/agent-task ─────────────────────────────────────────────
			// Agents submit tasks here. Immediate tasks get a dispatch event file
			// written right away. Scheduled tasks are handed to the croner scheduler.
			if (method === "POST" && url === "/internal/agent-task") {
				const body = await readBody(req);
				let params: {
					agentId?: string;
					channelId?: string;
					payload?: string;
					scheduledFor?: string;
					timezone?: string;
					localTimeStr?: string;
				};
				try { params = JSON.parse(body); } catch {
					json(res, 400, { error: "Invalid JSON body" });
					return;
				}

				if (!params.agentId || !params.channelId || !params.payload) {
					json(res, 400, { error: "Required: agentId, channelId, payload" });
					return;
				}

				const agent = await getSubAgent(params.agentId);
				if (!agent) {
					json(res, 404, { error: `Agent ${params.agentId} not found` });
					return;
				}

				// Derive botId from the Telegram link (may be empty if not linked)
				const botId = telegramLinkManager
					? (await telegramLinkManager.getBotForAgent(params.agentId)) ?? "unlinked"
					: "unlinked";

				const task = await createTask({
					agentId:      params.agentId,
					botId,
					channelId:    params.channelId,
					payload:      params.payload,
					scheduledFor: params.scheduledFor,
					timezone:     params.timezone,
					localTimeStr: params.localTimeStr,
				});

				if (!task) {
					json(res, 500, { error: "Failed to create task record" });
					return;
				}

				if (task.type === "immediate") {
					// Dispatch right away via event file
					const { randomBytes: rb } = await import("crypto");
					const { mkdirSync: mkdir4, writeFileSync: wfs2 } = await import("fs");
					const evDir = join(workingDir, "events");
					mkdir4(evDir, { recursive: true });
					const fn = `task-${task.taskId}-${(rb(4) as Buffer).toString("hex")}.json`;
					wfs2(join(evDir, fn), JSON.stringify({
						type: "immediate",
						channelId: task.channelId,
						text: `[${agent.name}]: ${task.payload}`,
					}, null, 2));
					log.logInfo(`[api] POST /internal/agent-task → immediate dispatch: ${fn}`);
				} else if (schedulerCallbacks) {
					// Hand off to scheduler for croner scheduling
					await scheduleNewTask(task, agent.name, schedulerCallbacks);
					log.logInfo(`[api] POST /internal/agent-task → scheduled: ${task.scheduledFor}`);
				}

				json(res, 200, { taskId: task.taskId, type: task.type, status: task.status });
				return;
			}

			// ── PATCH /internal/agent-task/:taskId/status ────────────────────────────
			// Agents mark a task done/failed/skipped after completing it.
			// body: { status: "done" | "failed" | "skipped", output?: string }
			if (method === "PATCH" && urlParts[0] === "internal" && urlParts[1] === "agent-task" && urlParts[3] === "status") {
				const taskId = urlParts[2];
				if (!taskId) {
					json(res, 400, { error: "taskId is required" });
					return;
				}

				let body: { status?: string; output?: string };
				try { body = JSON.parse(await readBody(req)); } catch {
					json(res, 400, { error: "Invalid JSON body" });
					return;
				}

				const validStatuses: TaskStatus[] = ["done", "failed", "skipped"];
				if (!body.status || !validStatuses.includes(body.status as TaskStatus)) {
					json(res, 400, { error: `status must be one of: ${validStatuses.join(", ")}` });
					return;
				}

				const task = await getTask(taskId);
				if (!task) {
					json(res, 404, { error: `Task ${taskId} not found` });
					return;
				}

				await updateTaskStatus(taskId, body.status as TaskStatus, body.output);
				log.logInfo(`[api] PATCH /internal/agent-task/${taskId}/status → ${body.status}`);
				json(res, 200, { taskId, status: body.status });
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
