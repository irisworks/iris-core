/**
 * Internal HTTP API for iris-runtime.
 *
 * Always-on: started on IRIS_API_PORT (default 3000).
 * Binds to 127.0.0.1 by default. To let sub-agent Docker containers reach it
 * via the iris-internal network gateway (172.18.0.1 by default), set
 * IRIS_API_HOST=0.0.0.0 AND set IRIS_API_TOKEN — all endpoints except
 * GET /health then require an `Authorization: Bearer <token>` header.
 *
 * Endpoints:
 *   GET  /health                         — liveness check
 *   GET  /channels                       — list active channel states
 *   POST /event                          — inject immediate event into Iris's queue
 *                                          body: { channelId, text, user? }
 *   POST /escalate                       — sub-agent escalates a problem to Iris
 *                                          body: { agent, issue, context?, severity?, environment? }
 *   GET  /secrets/:name                  — resolve a secret (env, store, or broker backend per
 *                                          IRIS_SECRETS_MODE / IRIS_SECRET_BROKER_URL)
 *                                          caller is derived from which token authenticated the
 *                                          request (the shared IRIS_API_TOKEN = "iris", unrestricted;
 *                                          an agents.json[name].token match = that agent's identity)
 *                                          sub-agents must be allow-listed in agents.json[caller].secrets;
 *                                          proxy-only / runtime-only secrets 403 for every caller
 *   GET  /secret/:name                   — alias of the above; the URL shape a child runtime's
 *                                          IRIS_SECRET_BROKER_URL provider fetches
 *   PUT  /secrets/:name                  — store/update a secret (iris only)
 *                                          body: { value, proxyOnly?, agentReadable? }
 *   DELETE /secrets/:name                — delete a secret (iris only)
 *   GET  /secrets                        — list names + metadata, never values (iris only)
 *   POST /secret-drops                   — mint a one-time out-of-band submission link (iris only)
 *                                          body: { name, channelId?, ttlSeconds?, proxyOnly? }
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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes, timingSafeEqual } from "crypto";
import * as log from "./log.js";
import {
	createSession,
	findByEmail,
	loadSessions,
	updateSession,
	type Session,
} from "./sessions.js";
import { loadAgentRegistry, type AgentRegistry } from "./bridge.js";
import { getSecretMeta, getSecretProvider } from "./secrets.js";
import { SECRET_NAME_RE, SecretStore, secretsMode, type SecretSource } from "./secret-store.js";
import { createDrop } from "./secret-drops.js";
import { loadServices } from "../broker/services.js";

// Minimal interfaces so api.ts doesn't import transport classes directly (avoids circular deps)
export interface SessionInjector {
	injectSessionMessage(sessionId: string, user: string, text: string): Promise<string>;
	postMessage(channel: string, text: string): Promise<string>;
	resetSessionContext(sessionId: string): void;
}

interface ApiTransport extends SessionInjector {
	ownsChannel(channelId: string): boolean;
}

interface ChannelState {
	running: boolean;
}

export function readBody(req: IncomingMessage): Promise<string> {
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

/**
 * Identifies the caller from *which token authenticated*, not from the
 * self-reported X-Iris-Caller header (IRIS-120) — a caller holding only its
 * own per-agent token can no longer claim to be another agent (or "iris").
 *
 * - Presented token matches the shared IRIS_API_TOKEN → "iris" (unrestricted).
 * - Presented token matches an agent's own `token` in agents.json → that agent.
 * - No match → null (unauthenticated).
 * - No IRIS_API_TOKEN configured at all (local loopback-only dev) → "iris",
 *   same permissive default as before per-agent tokens existed.
 */
export function resolveCaller(
	authHeader: string | undefined,
	apiToken: string,
	registry: AgentRegistry,
): string | null {
	if (!apiToken) return "iris";
	const header = authHeader ?? "";
	const prefix = /^Bearer\s+/i.exec(header);
	if (!prefix) return null;
	const presented = header.slice(prefix[0].length);
	if (!presented) return null;
	if (secretMatches(presented, apiToken)) return "iris";
	for (const [name, entry] of Object.entries(registry)) {
		if (entry.token && secretMatches(presented, entry.token)) return name;
	}
	return null;
}

/**
 * Constant-time string comparison for secrets (tokens/passwords) already held
 * in memory — not a storage hash. Pads both sides to a fixed-size buffer so
 * timingSafeEqual gets equal-length inputs without hashing the secret (a bare
 * SHA-256 of password-shaped data trips password-hashing-strength scanners,
 * and hashing buys nothing here since we never persist or index the digest).
 */
export function secretMatches(presented: string, expected: string): boolean {
	const presentedBuf = Buffer.from(presented, "utf8");
	const expectedBuf = Buffer.from(expected, "utf8");
	const size = Math.max(presentedBuf.length, expectedBuf.length, 32);
	const a = Buffer.alloc(size);
	const b = Buffer.alloc(size);
	presentedBuf.copy(a);
	expectedBuf.copy(b);
	return timingSafeEqual(a, b) && presentedBuf.length === expectedBuf.length;
}

/**
 * Writable secrets backend for the iris-only management routes: the bundled
 * broker daemon / external broker when IRIS_SECRET_BROKER_URL is set, the
 * local encrypted store in store mode, nothing in env mode. Reads stay on
 * getSecretProvider(); this is the write/list side only.
 */
interface SecretsBackendResult {
	status: number;
	body: unknown;
}

export async function secretsBackendRequest(
	method: "PUT" | "DELETE" | "LIST",
	name?: string,
	payload?: { value: string; proxyOnly?: boolean; agentReadable?: boolean; source?: SecretSource },
): Promise<SecretsBackendResult> {
	const brokerUrl = process.env.IRIS_SECRET_BROKER_URL;
	if (brokerUrl) {
		const base = brokerUrl.replace(/\/$/, "");
		const token = process.env.IRIS_SECRET_BROKER_TOKEN;
		const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
		try {
			if (method === "LIST") {
				const res = await fetch(`${base}/secrets`, { headers: auth });
				return { status: res.status, body: await res.json() };
			}
			const res = await fetch(`${base}/secret/${encodeURIComponent(name ?? "")}`, {
				method,
				headers: { ...auth, "Content-Type": "application/json" },
				body: method === "PUT" ? JSON.stringify(payload) : undefined,
			});
			return { status: res.status, body: await res.json() };
		} catch (err) {
			log.logWarning("[api] secrets broker unreachable", err instanceof Error ? err.message : String(err));
			return { status: 502, body: { error: "secrets broker unreachable" } };
		}
	}
	if (secretsMode() === "store") {
		const store = SecretStore.open();
		if (!store) return { status: 503, body: { error: "secret store not configured (key file missing)" } };
		if (method === "LIST") return { status: 200, body: { secrets: store.list() } };
		if (method === "PUT") {
			store.set(name ?? "", payload?.value ?? "", {
				source: payload?.source ?? "api",
				proxyOnly: payload?.proxyOnly,
				agentReadable: payload?.agentReadable,
			});
			return { status: 200, body: { ok: true, name } };
		}
		if (!store.delete(name ?? "")) return { status: 404, body: { error: "secret not found" } };
		return { status: 200, body: { ok: true } };
	}
	return {
		status: 503,
		body: { error: "no writable secrets backend — set IRIS_SECRETS_MODE=store or IRIS_SECRET_BROKER_URL" },
	};
}

/** True when a gateway service is configured to inject this secret — the drop form defaults to proxy-only for those. */
function isGatewaySecret(name: string): boolean {
	const underscored = name.replace(/-/g, "_");
	return Object.values(loadServices()).some(
		(service) => service.secret === name || service.secret.replace(/-/g, "_") === underscored,
	);
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
	getTransports: () => ApiTransport[] = () => [],
): Server {
	// Channel-addressed operations route to the transport that owns the channel.
	// Session operations use the first transport — registry order is the
	// preference order (Slack, then Telegram, then Bridge), matching the old
	// single-bot behavior.
	const findTransport = (channelId: string): ApiTransport | null =>
		getTransports().find((t) => t.ownsChannel(channelId)) ?? null;
	const sessionTransport = (): ApiTransport | null => getTransports()[0] ?? null;

	const eventsDir = join(workingDir, "events");
	const apiHost = process.env.IRIS_API_HOST ?? "127.0.0.1";
	const apiToken = process.env.IRIS_API_TOKEN ?? "";

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

			// ── Auth (all endpoints except /health when IRIS_API_TOKEN is set) ─────
			// Caller identity is derived from *which token authenticated*, not from
			// the self-reported X-Iris-Caller header (IRIS-120) — see resolveCaller.
			const agentRegistry = loadAgentRegistry(workingDir);
			const caller = resolveCaller(req.headers.authorization, apiToken, agentRegistry);
			if (caller === null) {
				json(res, 401, { error: "unauthorized" });
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

			// ── GET /secrets — list names + metadata, never values (iris only) ───
			if (method === "GET" && url.split("?")[0] === "/secrets") {
				if (caller !== "iris") {
					json(res, 403, { error: "listing secrets requires the iris token" });
					return;
				}
				const result = await secretsBackendRequest("LIST");
				json(res, result.status, result.body);
				return;
			}

			// ── /secrets/:name (alias /secret/:name) ─────────────────────────────
			// caller comes from the authenticated token (see resolveCaller above);
			// "iris" is unrestricted for reads, any other caller must be
			// allow-listed in agents.json. The singular /secret/:name alias is the
			// URL shape createBrokerSecretProvider fetches — it lets a sub-agent
			// runtime point IRIS_SECRET_BROKER_URL at this API and resolve
			// through its per-agent allow-list.
			if ((urlParts[0] === "secrets" || urlParts[0] === "secret") && urlParts.length === 2 && urlParts[1]) {
				const secretName = urlParts[1];

				if (method === "GET") {
					if (caller !== "iris") {
						const allowed = agentRegistry[caller]?.secrets ?? [];
						if (!allowed.includes(secretName)) {
							log.logWarning(`[api] GET /secrets/${secretName} denied for caller '${caller}'`);
							json(res, 403, { error: `caller '${caller}' is not allow-listed for secret '${secretName}'` });
							return;
						}
					}
					// Policy gate: proxy-only secrets are only usable through the
					// broker's injection gateway; runtime-only secrets
					// (agentReadable=false) are resolvable internally but never
					// served over this API — for any caller, including "iris".
					const meta = await getSecretMeta(secretName);
					if (meta && (meta.proxyOnly || meta.agentReadable === false)) {
						log.logWarning(`[api] GET /secrets/${secretName} refused: ${meta.proxyOnly ? "proxy-only" : "runtime-only"} secret`);
						json(res, 403, {
							error: meta.proxyOnly
								? `secret '${secretName}' is proxy-only — call it through the broker gateway`
								: `secret '${secretName}' is runtime-only`,
						});
						return;
					}
					const value = await getSecretProvider().get(secretName);
					if (value === undefined) {
						json(res, 404, { error: "secret not found" });
						return;
					}
					json(res, 200, { value });
					return;
				}

				if (method === "PUT" || method === "DELETE") {
					if (caller !== "iris") {
						log.logWarning(`[api] ${method} /secrets/${secretName} denied for caller '${caller}'`);
						json(res, 403, { error: "writing secrets requires the iris token" });
						return;
					}
					if (!SECRET_NAME_RE.test(secretName)) {
						json(res, 400, { error: "invalid secret name" });
						return;
					}
					if (method === "DELETE") {
						const result = await secretsBackendRequest("DELETE", secretName);
						json(res, result.status, result.body);
						return;
					}
					let body: { value?: string; proxyOnly?: boolean; agentReadable?: boolean };
					try {
						body = JSON.parse(await readBody(req)) as typeof body;
					} catch {
						json(res, 400, { error: "invalid JSON body" });
						return;
					}
					if (typeof body.value !== "string" || body.value.length === 0) {
						json(res, 400, { error: "missing value" });
						return;
					}
					const result = await secretsBackendRequest("PUT", secretName, {
						value: body.value,
						proxyOnly: body.proxyOnly,
						agentReadable: body.agentReadable,
						source: "api",
					});
					json(res, result.status, result.body);
					return;
				}
			}

			// ── POST /secret-drops — mint a one-time submission link (iris only) ──
			// body: { name, channelId?, ttlSeconds?, proxyOnly? }
			if (method === "POST" && url === "/secret-drops") {
				if (caller !== "iris") {
					json(res, 403, { error: "creating secret drops requires the iris token" });
					return;
				}
				let body: { name?: string; channelId?: string; ttlSeconds?: number; proxyOnly?: boolean };
				try {
					body = JSON.parse(await readBody(req)) as typeof body;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (!body.name || !SECRET_NAME_RE.test(body.name)) {
					json(res, 400, { error: "missing or invalid secret name" });
					return;
				}
				if (!process.env.IRIS_SECRET_BROKER_URL && secretsMode() !== "store") {
					json(res, 503, {
						error: "secret drops need a writable secrets backend — enable IRIS_SECRETS_MODE=store or proxy",
					});
					return;
				}
				const webuiPort = parseInt(process.env.IRIS_WEBUI_PORT ?? "0", 10);
				if (!(webuiPort > 0)) {
					json(res, 503, {
						error: "secret drops are served by the web transport — set IRIS_WEBUI_PORT (and expose it via serve-public for remote users)",
					});
					return;
				}
				const drop = createDrop({
					name: body.name,
					channelId: body.channelId,
					ttlMs: body.ttlSeconds !== undefined ? body.ttlSeconds * 1000 : undefined,
					proxyOnlyDefault: body.proxyOnly ?? isGatewaySecret(body.name),
				});
				const path = `/secret-drop/${drop.token}`;
				const baseDomain = process.env.IRIS_BASE_DOMAIN;
				json(res, 200, {
					token: drop.token,
					path,
					url: baseDomain ? `https://${baseDomain}${path}` : undefined,
					expiresAt: new Date(drop.expiresAt).toISOString(),
				});
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
				const bot = findTransport(body.channel);
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
				const bot = sessionTransport();
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
					const msg = err instanceof Error ? err.message : String(err);
					log.logWarning(`[api] PATCH /sessions/${sessionId} failed: ${msg}`);
					json(res, 404, { error: "session not found" });
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
				const bot = sessionTransport();
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
					json(res, 504, { error: "session message failed" });
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
				const bot = sessionTransport();
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
			json(res, 500, { error: "internal server error" });
		}
	});

	// Default bind is loopback. Installs whose sub-agent containers call this API
	// via the Docker gateway must set IRIS_API_HOST=0.0.0.0 and IRIS_API_TOKEN.
	if (apiHost !== "127.0.0.1" && apiHost !== "localhost" && !apiToken) {
		log.logWarning(
			`[api] IRIS_API_HOST=${apiHost} exposes the API beyond loopback without IRIS_API_TOKEN — anyone who can reach port ${port} can inject messages. Set IRIS_API_TOKEN.`,
		);
	}
	server.listen(port, apiHost, () => {
		log.logInfo(`[api] Internal API listening on http://${apiHost}:${port}`);
	});

	server.on("error", (err) => {
		log.logWarning("[api] server error", err.message);
	});

	return server;
}
