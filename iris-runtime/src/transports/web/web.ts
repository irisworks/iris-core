// ============================================================================
// WebTransport — built-in browser chat transport (IRIS-112).
//
// Implements ChannelTransport exactly like Slack/Telegram/Bridge — the engine
// dispatches into it with zero special-casing. Channel ids are `WEBUI-<id>`,
// matching the existing virtual-channel convention already reserved for
// "WEBUI" in store.ts/slack.ts (see resolveChannelDir's isVirtualChannel).
//
// Realizes MessageContext over a WebSocket per browser connection: a thinking
// placeholder while the run is in flight, structured tool-call events via the
// onToolEvent hook (agent.ts), then a final-text swap — see docs/web-ui.md.
//
// This ships only a bare functional test page. The real reference UI (AI
// Elements, thread sidebar, agent picker, file attachments) is IRIS-113,
// built against the protocol this module exposes.
// ============================================================================

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { randomBytes } from "crypto";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import { WebSocketServer, type WebSocket } from "ws";
import * as log from "../../engine/log.js";
import { loadAgentRegistry, callAgentBridge } from "../../engine/bridge.js";
import { readBody, secretMatches, secretsBackendRequest } from "../../engine/api.js";
import { consumeDrop, peekDrop, type SecretDrop } from "../../engine/secret-drops.js";
import type { ChannelState, EngineTransport } from "../../engine/index.js";
import { resolveChannelDir, resolveChannelPath } from "../../engine/store.js";
import {
	registerPromptProfile,
	type ChannelInfo,
	type ChannelTransport,
	type MessageContext,
	type ToolEvent,
	type TransportEvent,
	type TransportPromptProfile,
	type UserInfo,
} from "../../transport/types.js";

export interface WebTransportOptions {
	port: number;
	workingDir: string;
	/** Dispatch an event into the engine (wired in main.ts to engine.handleEvent) */
	dispatch: (event: TransportEvent, transport: ChannelTransport, isEvent?: boolean) => void;
	/** Admin actions, wired in main.ts to engine.handleStop/handleCompact/handleReset */
	commands: {
		stop: (channelId: string, transport: EngineTransport) => Promise<void>;
		compact: (channelId: string, transport: EngineTransport) => Promise<void>;
		reset: (channelId: string, transport: EngineTransport) => Promise<void>;
	};
}

const webPromptProfile: TransportPromptProfile = {
	transportId: "web",
	identityLine: "You are Iris, speaking with a user over a direct web chat interface.",
	formattingSection: "## Formatting\nPlain Markdown — the client renders it directly, no platform-specific mrkdwn rules.",
	directorySection: () => "",
	silentNote: "This deletes the status message and posts nothing to the browser.",
	attachNote: "Share files to the browser",
	attachmentsTagName: "web_attachments",
	maxMessageChars: 100_000,
};

type OutboundFrame =
	| { type: "thinking"; id: string }
	| { type: "final"; id: string; text: string }
	| { type: "update"; id: string; text: string }
	| { type: "thread"; text: string }
	| { type: "delete"; id: string }
	| { type: "file"; url: string; title?: string }
	| ({ type: "tool" } & ToolEvent)
	| { type: "error"; message: string };

function randomToken(): string {
	return randomBytes(24).toString("hex");
}

/**
 * `thread`/`agent` query params end up in filesystem paths (`WEBUI-<thread>`
 * is joined onto workingDir in resolveChannelDir) and agents.json lookups, so
 * they're restricted to a safe id charset — no `/`, `..`, or other path
 * metacharacters can smuggle a directory escape through `path.join`.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The `channel` param on /upload and /files must both stay within the
 * SAFE_ID charset (no traversal metacharacters) AND be scoped to a
 * WEBUI-owned channel — otherwise a browser client could read/write
 * attachments under an arbitrary Slack/Telegram channel dir by charset-valid
 * id alone (e.g. `channel=slack-general`), not just escape workingDir.
 */
function isValidWebChannelId(channelId: string): boolean {
	return channelId.startsWith("WEBUI-") && SAFE_ID.test(channelId.slice("WEBUI-".length));
}

/**
 * Resolves `segments` onto `baseDir` and verifies the result stays inside
 * it, rather than trusting the caller's own blacklist of "/"/".." in each
 * segment — the authoritative guard for any path built from request data
 * (filenames, channel ids), since resolve() collapses traversal sequences
 * predictably regardless of what the untrusted segment looks like going in.
 * Returns undefined if the join would escape baseDir.
 */
function safeJoin(baseDir: string, ...segments: string[]): string | undefined {
	const base = resolve(baseDir);
	const target = resolve(base, ...segments);
	if (target !== base && !target.startsWith(base + sep)) return undefined;
	return target;
}

export class WebTransport implements ChannelTransport {
	readonly transportId = "web";
	readonly promptProfile = webPromptProfile;
	readonly stopCommandHint = "click Stop";

	private readonly workingDir: string;
	private readonly dispatch: WebTransportOptions["dispatch"];
	private readonly commands: WebTransportOptions["commands"];
	private readonly port: number;
	private readonly password: string | undefined;
	private readonly sessionTokens = new Set<string>();
	/** Connections currently subscribed to a given WEBUI-<id> channel. */
	private readonly connections = new Map<string, Set<WebSocket>>();
	private server: Server | undefined;
	private wss: WebSocketServer | undefined;

	constructor(options: WebTransportOptions) {
		this.workingDir = options.workingDir;
		this.dispatch = options.dispatch;
		this.commands = options.commands;
		this.port = options.port;
		this.password = process.env.IRIS_WEBUI_PASSWORD || undefined;
		registerPromptProfile(this.promptProfile);

		if (!this.password) {
			log.logWarning(
				"[web] IRIS_WEBUI_PASSWORD is not set — the web UI has no auth gate. Fine for loopback-only use; set it before exposing via serve-public.",
			);
		}
	}

	start(): void {
		const server = createServer((req, res) => this.handleHttp(req, res));
		const wss = new WebSocketServer({ noServer: true });

		server.on("upgrade", (req, socket, head) => {
			if (!this.isAuthed(req)) {
				socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
				socket.destroy();
				return;
			}
			if (!this.hasValidThreadAndAgent(req)) {
				socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws, req));
		});

		server.listen(this.port, "127.0.0.1", () => {
			log.logInfo(`[web] Web UI listening on http://127.0.0.1:${this.port}`);
		});
		server.on("error", (err) => log.logWarning("[web] server error", err.message));

		this.server = server;
		this.wss = wss;
	}

	stop(): void {
		this.wss?.close();
		this.server?.close();
	}

	ownsChannel(channelId: string): boolean {
		return channelId.startsWith("WEBUI");
	}

	getChannels(): ChannelInfo[] {
		return [];
	}

	getUsers(): UserInfo[] {
		return [];
	}

	async postMessage(channelId: string, text: string): Promise<string> {
		const id = randomToken();
		this.broadcast(channelId, { type: "final", id, text });
		return id;
	}

	async updateMessage(channelId: string, messageId: string, text: string): Promise<void> {
		this.broadcast(channelId, { type: "update", id: messageId, text });
	}

	enqueueEvent(event: TransportEvent): boolean {
		this.dispatch(event, this);
		return true;
	}

	createContext(event: TransportEvent, _state: ChannelState): MessageContext {
		let accumulatedText = "";
		let messageId: string | undefined;

		return {
			transportId: this.transportId,
			message: {
				text: event.text,
				rawText: event.text,
				user: event.user,
				channel: event.channel,
				ts: event.ts,
				attachments: (event.attachments || []).map((a) => ({ local: a.local })),
			},
			channels: [],
			users: [],
			respond: async (text: string) => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
			},
			replaceMessage: async (text: string) => {
				if (!messageId) messageId = randomToken();
				this.broadcast(event.channel, { type: "final", id: messageId, text });
			},
			respondInThread: async (text: string) => {
				this.broadcast(event.channel, { type: "thread", text });
			},
			setTyping: async (isTyping: boolean) => {
				if (isTyping && !messageId) {
					messageId = randomToken();
					this.broadcast(event.channel, { type: "thinking", id: messageId });
				}
			},
			uploadFile: async (filePath: string, title?: string) => {
				const filename = filePath.split("/").pop() ?? filePath;
				this.broadcast(event.channel, {
					type: "file",
					url: `/files/${encodeURIComponent(event.channel)}/${encodeURIComponent(filename)}`,
					title,
				});
			},
			setWorking: async () => {},
			deleteMessage: async () => {
				if (messageId) this.broadcast(event.channel, { type: "delete", id: messageId });
			},
			getAccumulatedText: () => accumulatedText,
			onToolEvent: (toolEvent: ToolEvent) => {
				this.broadcast(event.channel, { type: "tool", ...toolEvent });
			},
		};
	}

	// ==========================================================================
	// SessionInjector surface (required by api.ts) — same pattern as Bridge/Slack
	// ==========================================================================

	async injectSessionMessage(sessionId: string, user: string, text: string): Promise<string> {
		const { registerSessionRequest } = await import("../../engine/sessions.js");
		const channelId = `SESSION-${sessionId}`;
		const ts = (Date.now() / 1000).toFixed(6);
		const responsePromise = registerSessionRequest(sessionId, 90_000);
		this.dispatch({ channel: channelId, user, text, ts, attachments: [] }, this);
		return responsePromise;
	}

	resetSessionContext(_sessionId: string): void {}

	// ==========================================================================
	// Internals
	// ==========================================================================

	private broadcast(channelId: string, frame: OutboundFrame): void {
		const sockets = this.connections.get(channelId);
		if (!sockets) return;
		const payload = JSON.stringify(frame);
		for (const ws of sockets) {
			if (ws.readyState === ws.OPEN) ws.send(payload);
		}
	}

	private isAuthed(req: IncomingMessage): boolean {
		if (!this.password) return true;
		const cookie = req.headers.cookie ?? "";
		const match = /(?:^|;\s*)iris_webui_session=([^;]+)/.exec(cookie);
		return !!match && this.sessionTokens.has(match[1]);
	}

	/** Rejects requests before the WS handshake if `thread`/`agent` don't match SAFE_ID. */
	private hasValidThreadAndAgent(req: IncomingMessage): boolean {
		const url = new URL(req.url ?? "/ws", "http://localhost");
		const thread = url.searchParams.get("thread");
		const agent = url.searchParams.get("agent");
		if (thread !== null && !SAFE_ID.test(thread)) return false;
		if (agent !== null && !SAFE_ID.test(agent)) return false;
		return true;
	}

	private handleConnection(ws: WebSocket, req: IncomingMessage): void {
		const url = new URL(req.url ?? "/ws", "http://localhost");
		const threadId = url.searchParams.get("thread") || randomToken();
		const targetAgent = url.searchParams.get("agent") || undefined;
		const channelId = `WEBUI-${threadId}`;

		let sockets = this.connections.get(channelId);
		if (!sockets) {
			sockets = new Set();
			this.connections.set(channelId, sockets);
		}
		sockets.add(ws);

		ws.on("close", () => {
			sockets?.delete(ws);
			if (sockets && sockets.size === 0) this.connections.delete(channelId);
		});

		ws.on("message", (raw) => {
			void this.handleInboundMessage(channelId, targetAgent, raw.toString());
		});
	}

	private async handleInboundMessage(channelId: string, targetAgent: string | undefined, raw: string): Promise<void> {
		let body: { type?: string; text?: string; action?: string; attachments?: Array<{ local: string }> };
		try {
			body = JSON.parse(raw);
		} catch {
			return;
		}

		if (body.type === "command") {
			// Admin actions as explicit commands, not parsed chat text — the web UI
			// has real buttons, unlike Slack's admin channel mode.
			const handlers = { stop: this.commands.stop, compact: this.commands.compact, reset: this.commands.reset };
			const handler = body.action ? handlers[body.action as keyof typeof handlers] : undefined;
			if (!handler) {
				this.broadcast(channelId, { type: "error", message: `Unknown command '${body.action}'` });
				return;
			}
			await handler(channelId, this);
			return;
		}

		if (body.type !== "message" || !body.text) return;

		if (targetAgent) {
			// Sub-agent routing: single request/response over the existing
			// @mention bridge (agents.json[targetAgent].bridge_url) — no thinking
			// placeholder or tool-event stream, since the bridge protocol doesn't
			// expose intermediate events, only a final reply.
			const registry = loadAgentRegistry(this.workingDir);
			const entry = registry[targetAgent];
			if (!entry) {
				this.broadcast(channelId, { type: "error", message: `Unknown agent '${targetAgent}'` });
				return;
			}
			const id = randomToken();
			this.broadcast(channelId, { type: "thinking", id });
			try {
				const text = await callAgentBridge(entry.bridge_url, body.text, "web");
				this.broadcast(channelId, { type: "final", id, text });
			} catch (err) {
				this.broadcast(channelId, { type: "error", message: err instanceof Error ? err.message : String(err) });
			}
			return;
		}

		const ts = (Date.now() / 1000).toFixed(6);
		this.enqueueEvent({ channel: channelId, user: "web", text: body.text, ts, attachments: body.attachments ?? [] });
	}

	private handleHttp(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (req.method === "POST" && url.pathname === "/login") {
			this.handleLogin(req, res);
			return;
		}

		// Secret drops sit before the session-cookie gate on purpose: the
		// one-time capability token in the URL *is* the auth — the submitting
		// user may only have Slack/Telegram, not the web UI password. Invalid,
		// expired, and consumed tokens all render the same 404 (no oracle).
		const dropMatch = /^\/secret-drop\/([a-f0-9]{48})$/.exec(url.pathname);
		if (dropMatch) {
			if (req.method === "GET") {
				this.handleSecretDropForm(res, dropMatch[1]);
				return;
			}
			if (req.method === "POST") {
				void this.handleSecretDropSubmit(req, res, dropMatch[1]);
				return;
			}
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(renderPage());
			return;
		}

		if (!this.isAuthed(req)) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unauthorized" }));
			return;
		}

		if (req.method === "GET" && url.pathname === "/agents") {
			const registry = loadAgentRegistry(this.workingDir);
			const agents = Object.entries(registry).map(([name, entry]) => ({ name, description: entry.description }));
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ agents }));
			return;
		}

		if (req.method === "POST" && url.pathname === "/upload") {
			this.handleUpload(req, res, url);
			return;
		}

		const filesMatch = /^\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
		if (req.method === "GET" && filesMatch) {
			this.handleFileDownload(res, decodeURIComponent(filesMatch[1]), decodeURIComponent(filesMatch[2]));
			return;
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found");
	}

	/**
	 * `channelId` must be a WEBUI-owned id (isValidWebChannelId) and every
	 * candidate read path is built through safeJoin, which verifies the
	 * resolved path stays inside the channel dir — the authoritative guard,
	 * not just the "/"/".." blacklist on `filename` (kept as an early
	 * fast-fail for the common case).
	 */
	private handleFileDownload(res: ServerResponse, channelId: string, filename: string): void {
		if (!isValidWebChannelId(channelId) || filename.includes("/") || filename.includes("..")) {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("invalid channel or filename");
			return;
		}
		const channelDir = resolveChannelDir(this.workingDir, channelId);
		const candidates = [safeJoin(channelDir, "attachments", filename), safeJoin(channelDir, filename)].filter(
			(p): p is string => p !== undefined,
		);
		const path = candidates.find((p) => existsSync(p));
		if (!path) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("not found");
			return;
		}
		res.writeHead(200, { "Content-Type": "application/octet-stream" });
		createReadStream(path).pipe(res);
	}

	private handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): void {
		const channelId = url.searchParams.get("channel");
		const filenameHeader = req.headers["x-filename"];
		const filename = Array.isArray(filenameHeader) ? filenameHeader[0] : filenameHeader;
		if (!channelId || !isValidWebChannelId(channelId) || !filename || filename.includes("/") || filename.includes("..")) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "channel query param (WEBUI-<safe-id>) and X-Filename header (no path separators) are required" }));
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const attachmentsDir = join(resolveChannelDir(this.workingDir, channelId), "attachments");
			mkdirSync(attachmentsDir, { recursive: true });
			const safeName = `${Date.now()}_${filename}`;
			const target = safeJoin(attachmentsDir, safeName);
			if (!target) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "invalid filename" }));
				return;
			}
			writeFileSync(target, Buffer.concat(chunks));
			const local = join(resolveChannelPath(channelId), "attachments", safeName);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ local }));
		});
	}

	private handleSecretDropForm(res: ServerResponse, token: string): void {
		const drop = peekDrop(token);
		if (!drop) {
			log.logWarning("[web] secret-drop form requested with unknown/expired token");
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end(renderSecretDropGone());
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(renderSecretDropForm(drop));
	}

	private async handleSecretDropSubmit(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
		let body: { value?: string; proxyOnly?: boolean };
		try {
			body = JSON.parse(await readBody(req)) as typeof body;
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid JSON" }));
			return;
		}
		// Validate before consuming so a malformed submit doesn't burn the link;
		// consumeDrop itself is the atomic single-use claim.
		if (typeof body.value !== "string" || body.value.length === 0 || body.value.length > 64 * 1024) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "missing or oversized value" }));
			return;
		}
		const drop = consumeDrop(token);
		if (!drop) {
			log.logWarning("[web] secret-drop submit with unknown/expired/used token");
			res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
			res.end(renderSecretDropGone());
			return;
		}
		const result = await secretsBackendRequest("PUT", drop.name, {
			value: body.value,
			proxyOnly: body.proxyOnly ?? drop.proxyOnlyDefault,
			source: "drop",
		});
		if (result.status !== 200) {
			log.logWarning(`[web] secret-drop store failed for '${drop.name}' (status ${result.status})`);
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "storing the secret failed — ask Iris for a new link" }));
			return;
		}
		log.logInfo(`[web] secret '${drop.name}' submitted via drop link`);
		// Name-only notification back into the conversation that requested the
		// drop — the root events watcher (main.ts) routes it to the owning
		// transport. The value itself never appears in any event or log.
		if (drop.channelId) {
			const eventsDir = join(this.workingDir, "events");
			mkdirSync(eventsDir, { recursive: true });
			const eventId = `drop-${Date.now()}-${randomBytes(4).toString("hex")}`;
			writeFileSync(
				join(eventsDir, `${eventId}.json`),
				JSON.stringify({
					type: "immediate",
					channelId: drop.channelId,
					user: "secret-drop",
					text: `Secret '${drop.name}' was submitted via its drop link and stored.`,
				}),
			);
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	}

	private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
		let body: { password?: string };
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "invalid JSON" }));
			return;
		}
		if (this.password && !secretMatches(body.password ?? "", this.password)) {
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "wrong password" }));
			return;
		}
		const token = randomToken();
		this.sessionTokens.add(token);
		res.writeHead(200, {
			"Content-Type": "application/json",
			"Set-Cookie": `iris_webui_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
		});
		res.end(JSON.stringify({ ok: true }));
	}
}

// Minimal standalone pages for the secret-drop flow. `drop.name` is safe to
// interpolate: names are validated against SECRET_NAME_RE at drop creation.
const SECRET_DROP_STYLE = `
	body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; justify-content: center; padding-top: 12vh; }
	.card { background: #1c1c1e; border-radius: 12px; padding: 32px; max-width: 420px; width: 90%; }
	h1 { font-size: 18px; margin: 0 0 8px; }
	p { color: #aaa; font-size: 14px; line-height: 1.5; }
	code { color: #7dc4ff; }
	input[type=password] { width: 100%; box-sizing: border-box; padding: 10px; margin: 12px 0; border-radius: 8px; border: 1px solid #333; background: #111; color: #eee; font-size: 14px; }
	label { font-size: 13px; color: #aaa; display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
	button { width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #3b82f6; color: white; font-size: 14px; cursor: pointer; }
	button:disabled { opacity: 0.5; }
	.ok { color: #4ade80; }`;

function renderSecretDropForm(drop: SecretDrop): string {
	return `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Share a secret with Iris</title>
<style>${SECRET_DROP_STYLE}</style>
</head><body>
<div class="card">
	<h1>Share a secret with Iris</h1>
	<p>Paste the value for <code>${drop.name}</code>. It goes straight into Iris's encrypted secret store — it never appears in the chat, logs, or the model's context. This link works once and then expires.</p>
	<form id="f" autocomplete="off">
		<input type="password" id="value" placeholder="Secret value" autocomplete="new-password" autofocus>
		${drop.proxyOnlyDefault ? `<label><input type="checkbox" id="proxyOnly" checked> Proxy-only (Iris can use it via the gateway, but never read the raw value)</label>` : ""}
		<button type="submit" id="submit">Store secret</button>
	</form>
	<p id="done" class="ok" style="display:none">Stored. You can close this page — Iris has been notified.</p>
</div>
<script>
document.getElementById("f").addEventListener("submit", function (e) {
	e.preventDefault();
	var value = document.getElementById("value").value;
	if (!value) return;
	var proxyEl = document.getElementById("proxyOnly");
	document.getElementById("submit").disabled = true;
	fetch(location.pathname, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ value: value, proxyOnly: proxyEl ? proxyEl.checked : false }),
	}).then(function (res) {
		if (res.ok) {
			document.getElementById("f").style.display = "none";
			document.getElementById("done").style.display = "block";
		} else {
			document.getElementById("submit").disabled = false;
			res.json().then(function (b) { alert(b.error || "Failed — ask Iris for a new link"); }, function () { alert("Failed — ask Iris for a new link"); });
		}
	});
});
</script>
</body></html>`;
}

function renderSecretDropGone(): string {
	return `<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Link not available</title>
<style>${SECRET_DROP_STYLE}</style>
</head><body>
<div class="card">
	<h1>This link isn't available</h1>
	<p>The link is invalid, expired, or was already used. Ask Iris for a fresh one.</p>
</div>
</body></html>`;
}

// Reference v1 page (IRIS-113): login, thread sidebar (localStorage-backed,
// no server-side "list my threads" endpoint — see docs/web-ui.md for why),
// agent picker, tool-call cards fed by the onToolEvent-derived "tool" frame,
// file attachments, and admin buttons wired to the "command" frame. Plain
// HTML/CSS/JS on purpose — no bundler, no framework (see IRIS-113's v1 scope
// decision). History doesn't hydrate on reconnect/refresh: Iris's own memory
// (context.jsonl) is untouched, only the browser's visual replay is skipped.
function renderPage(): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Iris</title>
<style>
* { box-sizing: border-box; }
body { font-family: system-ui, sans-serif; margin: 0; height: 100vh; display: flex; flex-direction: column; }
#login { max-width: 320px; margin: 4rem auto; display: flex; gap: 0.5rem; }
#app { display: none; flex: 1; min-height: 0; }
#sidebar { width: 240px; border-right: 1px solid #ddd; display: flex; flex-direction: column; padding: 0.75rem; gap: 0.5rem; }
#threadList { flex: 1; overflow-y: auto; }
.thread { padding: 0.4rem 0.5rem; border-radius: 6px; cursor: pointer; font-size: 0.9em; }
.thread:hover { background: #f0f0f0; }
.thread.active { background: #e0e8ff; font-weight: 600; }
#main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
#toolbar { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem; border-bottom: 1px solid #ddd; }
#threadLabel { font-weight: 600; flex: 1; }
#adminButtons { display: flex; gap: 0.4rem; }
#log { flex: 1; overflow-y: auto; padding: 1rem; }
.msg { white-space: pre-wrap; margin-bottom: 0.75rem; }
.msg.thinking { color: #888; font-style: italic; }
.you { color: #333; font-weight: 600; margin-bottom: 0.75rem; }
.aux { color: #888; font-size: 0.85em; margin-bottom: 0.5rem; }
.err { color: #b00; margin-bottom: 0.75rem; }
details.tool { color: #555; font-size: 0.85em; margin-bottom: 0.5rem; }
details.tool pre { white-space: pre-wrap; background: #f7f7f7; padding: 0.5rem; border-radius: 6px; }
.file a { color: #06c; }
form#form { display: flex; gap: 0.5rem; padding: 0.75rem; border-top: 1px solid #ddd; }
input[type=text] { flex: 1; padding: 0.5rem; }
button { cursor: pointer; }
</style>
</head>
<body>
<div id="login">
  <input type="password" id="password" placeholder="Password">
  <button id="loginBtn">Log in</button>
</div>
<div id="app">
  <div id="sidebar">
    <select id="agentPicker"><option value="">Iris</option></select>
    <button id="newThreadBtn">+ New thread</button>
    <div id="threadList"></div>
  </div>
  <div id="main">
    <div id="toolbar">
      <div id="threadLabel"></div>
      <div id="adminButtons">
        <button id="stopBtn">Stop</button>
        <button id="compactBtn">Compact</button>
        <button id="resetBtn">Reset</button>
      </div>
    </div>
    <div id="log"></div>
    <form id="form">
      <input type="file" id="fileInput">
      <input type="text" id="text" placeholder="Message...">
      <button type="submit">Send</button>
    </form>
  </div>
</div>
<script>
var ws = null;
var threads = JSON.parse(localStorage.getItem("iris_threads") || "[]");
var currentId = localStorage.getItem("iris_current_thread") || null;
var pendingEls = {};
var toolEls = {};

function saveThreads() {
  localStorage.setItem("iris_threads", JSON.stringify(threads));
  if (currentId) localStorage.setItem("iris_current_thread", currentId);
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function scrollDown() {
  var l = document.getElementById("log");
  l.scrollTop = l.scrollHeight;
}

function renderSidebar() {
  var list = document.getElementById("threadList");
  list.innerHTML = "";
  threads.forEach(function (t) {
    var item = el("div", "thread" + (t.id === currentId ? " active" : ""), (t.agent ? "[" + t.agent + "] " : "") + t.label);
    item.onclick = function () { switchThread(t.id); };
    list.appendChild(item);
  });
}

function currentChannelId() {
  return "WEBUI-" + currentId;
}

function switchThread(id) {
  currentId = id;
  saveThreads();
  renderSidebar();
  document.getElementById("log").innerHTML = "";
  pendingEls = {};
  toolEls = {};
  var t = threads.find(function (x) { return x.id === id; });
  document.getElementById("threadLabel").textContent = t ? ((t.agent ? "[" + t.agent + "] " : "") + t.label) : "";
  document.getElementById("adminButtons").style.display = (t && t.agent) ? "none" : "flex";
  connect(id, t ? t.agent : undefined);
}

function newThread() {
  var agent = document.getElementById("agentPicker").value || undefined;
  var id = "t" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  threads.push({ id: id, label: agent || "Iris", agent: agent });
  switchThread(id);
}

function loadAgents() {
  fetch("/agents").then(function (r) { return r.json(); }).then(function (data) {
    var sel = document.getElementById("agentPicker");
    sel.innerHTML = "<option value=''>Iris</option>";
    (data.agents || []).forEach(function (a) {
      var opt = document.createElement("option");
      opt.value = a.name;
      opt.textContent = a.name + (a.description ? " — " + a.description : "");
      sel.appendChild(opt);
    });
  });
}

function messageEl(id) {
  var e = pendingEls[id];
  if (!e) {
    e = el("div", "msg");
    document.getElementById("log").appendChild(e);
    pendingEls[id] = e;
  }
  return e;
}

function toolEl(id) {
  var d = toolEls[id];
  if (!d) {
    d = document.createElement("details");
    d.className = "tool";
    d.appendChild(document.createElement("summary"));
    d.appendChild(document.createElement("pre"));
    document.getElementById("log").appendChild(d);
    toolEls[id] = d;
  }
  return d;
}

function handleFrame(f) {
  if (f.type === "thinking") {
    var e = messageEl(f.id);
    e.textContent = "Iris is thinking...";
    e.className = "msg thinking";
  } else if (f.type === "tool") {
    var d = toolEl(f.id);
    var summary = d.querySelector("summary");
    var pre = d.querySelector("pre");
    var label = (f.phase === "start" ? "→ " : (f.isError ? "✗ " : "✓ ")) + f.toolName + (f.label ? ": " + f.label : "") + (f.durationMs ? " (" + (f.durationMs / 1000).toFixed(1) + "s)" : "");
    summary.textContent = label;
    if (f.phase === "end") {
      pre.textContent = (f.args ? "Args: " + JSON.stringify(f.args, null, 2) + "\\n\\n" : "") + (f.result || "");
    }
  } else if (f.type === "final") {
    var fe = messageEl(f.id);
    fe.textContent = f.text;
    fe.className = "msg final";
  } else if (f.type === "update") {
    var ue = messageEl(f.id);
    ue.textContent = f.text;
    ue.className = "msg update";
  } else if (f.type === "thread") {
    document.getElementById("log").appendChild(el("div", "aux", f.text));
  } else if (f.type === "file") {
    var fd = el("div", "file");
    var a = document.createElement("a");
    a.href = f.url;
    a.textContent = f.title || f.url;
    a.target = "_blank";
    fd.appendChild(a);
    document.getElementById("log").appendChild(fd);
  } else if (f.type === "error") {
    document.getElementById("log").appendChild(el("div", "err", "Error: " + f.message));
  }
  scrollDown();
}

function connect(threadId, agent) {
  if (ws) { ws.close(); ws = null; }
  var url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?thread=" + encodeURIComponent(threadId);
  if (agent) url += "&agent=" + encodeURIComponent(agent);
  ws = new WebSocket(url);
  ws.onmessage = function (ev) { handleFrame(JSON.parse(ev.data)); };
}

function uploadFile(file, channelId) {
  return fetch("/upload?channel=" + encodeURIComponent(channelId), {
    method: "POST",
    headers: { "X-Filename": file.name },
    body: file,
  }).then(function (res) {
    if (!res.ok) throw new Error("upload failed");
    return res.json();
  }).then(function (body) { return body.local; });
}

document.getElementById("form").onsubmit = function (e) {
  e.preventDefault();
  var input = document.getElementById("text");
  var fileInput = document.getElementById("fileInput");
  var text = input.value;
  if (!text && !fileInput.files.length) return;
  var send = function (attachments) {
    document.getElementById("log").appendChild(el("div", "you", "You: " + text));
    scrollDown();
    ws.send(JSON.stringify({ type: "message", text: text, attachments: attachments }));
    input.value = "";
  };
  if (fileInput.files.length) {
    uploadFile(fileInput.files[0], currentChannelId()).then(function (local) {
      fileInput.value = "";
      send([{ local: local }]);
    });
  } else {
    send([]);
  }
};

document.getElementById("newThreadBtn").onclick = newThread;
document.getElementById("stopBtn").onclick = function () { ws.send(JSON.stringify({ type: "command", action: "stop" })); };
document.getElementById("compactBtn").onclick = function () { ws.send(JSON.stringify({ type: "command", action: "compact" })); };
document.getElementById("resetBtn").onclick = function () {
  ws.send(JSON.stringify({ type: "command", action: "reset" }));
  document.getElementById("log").innerHTML = "";
  pendingEls = {};
  toolEls = {};
};

function startApp() {
  document.getElementById("login").style.display = "none";
  document.getElementById("app").style.display = "flex";
  loadAgents();
  if (threads.length === 0) threads.push({ id: "default", label: "Iris" });
  if (!currentId || !threads.find(function (t) { return t.id === currentId; })) currentId = threads[0].id;
  renderSidebar();
  switchThread(currentId);
}

document.getElementById("loginBtn").onclick = function () {
  var password = document.getElementById("password").value;
  fetch("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: password }) })
    .then(function (res) { if (res.ok) startApp(); else alert("Wrong password"); });
};

// If no auth is configured, the server accepts an empty login regardless —
// try it straight away so the login screen never shows for unauthed installs.
fetch("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(function (res) {
  if (res.ok) startApp();
});
</script>
</body>
</html>`;
}
