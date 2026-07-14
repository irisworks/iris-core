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
import { WebSocketServer, type WebSocket } from "ws";
import * as log from "../log.js";
import { loadAgentRegistry, callAgentBridge } from "../bridge.js";
import type { ChannelState } from "../engine.js";
import {
	registerPromptProfile,
	type ChannelInfo,
	type ChannelTransport,
	type MessageContext,
	type ToolEvent,
	type TransportEvent,
	type TransportPromptProfile,
	type UserInfo,
} from "./types.js";

export interface WebTransportOptions {
	port: number;
	workingDir: string;
	/** Dispatch an event into the engine (wired in main.ts to engine.handleEvent) */
	dispatch: (event: TransportEvent, transport: ChannelTransport, isEvent?: boolean) => void;
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

export class WebTransport implements ChannelTransport {
	readonly transportId = "web";
	readonly promptProfile = webPromptProfile;
	readonly stopCommandHint = "click Stop";

	private readonly workingDir: string;
	private readonly dispatch: WebTransportOptions["dispatch"];
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
				this.broadcast(event.channel, {
					type: "file",
					url: `/files/${encodeURIComponent(event.channel)}/${encodeURIComponent(filePath.split("/").pop() ?? filePath)}`,
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
		const { registerSessionRequest } = await import("../sessions.js");
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
		let body: { type?: string; text?: string };
		try {
			body = JSON.parse(raw);
		} catch {
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
		this.enqueueEvent({ channel: channelId, user: "web", text: body.text, ts, attachments: [] });
	}

	private handleHttp(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (req.method === "POST" && url.pathname === "/login") {
			this.handleLogin(req, res);
			return;
		}

		if (url.pathname === "/" || url.pathname === "/index.html") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(renderPage());
			return;
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("not found");
	}

	private handleLogin(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			let body: { password?: string };
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
			} catch {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "invalid JSON" }));
				return;
			}
			if (this.password && body.password !== this.password) {
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
		});
	}
}

// Bare functional test page — not the reference UI (IRIS-113 builds that
// against the WS protocol this module exposes). Just enough to prove the
// transport end to end: login, one thread, message list, thinking indicator,
// tool events as plain text lines, final text.
function renderPage(): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Iris</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
#log { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; min-height: 300px; white-space: pre-wrap; }
.tool { color: #666; font-size: 0.9em; }
.err { color: #b00; }
form { display: flex; gap: 0.5rem; margin-top: 1rem; }
input[type=text] { flex: 1; padding: 0.5rem; }
</style>
</head>
<body>
<h1>Iris</h1>
<div id="login">
  <input type="password" id="password" placeholder="Password">
  <button id="loginBtn">Log in</button>
</div>
<div id="chat" style="display:none">
  <div id="log"></div>
  <form id="form">
    <input type="text" id="text" placeholder="Message Iris...">
    <button type="submit">Send</button>
  </form>
</div>
<script>
const logEl = document.getElementById("log");
function line(cls, text) {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = text;
  logEl.appendChild(d);
  logEl.scrollTop = logEl.scrollHeight;
}

function connect() {
  document.getElementById("login").style.display = "none";
  document.getElementById("chat").style.display = "block";
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?thread=default");
  const pending = {};
  ws.onmessage = (ev) => {
    const f = JSON.parse(ev.data);
    if (f.type === "thinking") { pending[f.id] = line("", "Iris is thinking..."); }
    else if (f.type === "tool") {
      line("tool", (f.phase === "start" ? "→ " : (f.isError ? "✗ " : "✓ ")) + f.toolName + (f.label ? ": " + f.label : "") + (f.durationMs ? " (" + (f.durationMs/1000).toFixed(1) + "s)" : ""));
    }
    else if (f.type === "final") { line("", f.text); }
    else if (f.type === "update") { line("", f.text); }
    else if (f.type === "thread") { line("tool", f.text); }
    else if (f.type === "error") { line("err", "Error: " + f.message); }
  };
  document.getElementById("form").onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById("text");
    if (!input.value) return;
    line("", "You: " + input.value);
    ws.send(JSON.stringify({ type: "message", text: input.value }));
    input.value = "";
  };
}

document.getElementById("loginBtn").onclick = async () => {
  const password = document.getElementById("password").value;
  const res = await fetch("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  if (res.ok) connect(); else alert("Wrong password");
};

// If no auth is configured, the server accepts the WS upgrade regardless —
// try connecting straight away.
fetch("/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then((res) => {
  if (res.ok) connect();
});
</script>
</body>
</html>`;
}
