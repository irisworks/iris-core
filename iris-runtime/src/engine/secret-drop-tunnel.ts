// ============================================================================
// Ephemeral public tunnel for one secret drop — used when the web transport is
// on but not publicly reachable (no IRIS_BASE_DOMAIN). Starts a cloudflared
// quick tunnel (no account needed) on demand; the caller tears it down when
// the drop is consumed or expires.
//
// The tunnel never points at the web UI itself: it fronts a loopback proxy
// that forwards only `/secret-drop/<token>` for this one drop and 404s
// everything else, so the rest of the web UI (which may have no password on a
// loopback-only install) is never exposed.
// ============================================================================

import { spawn } from "child_process";
import { createServer, request, type Server } from "http";
import type { AddressInfo } from "net";
import * as log from "./log.js";

export interface DropTunnel {
	url: string;
	close: () => void;
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function startDropProxy(webuiHost: string, webuiPort: number, token: string): Promise<Server> {
	const allowedPath = `/secret-drop/${token}`;
	const server = createServer((req, res) => {
		if (req.url !== allowedPath || (req.method !== "GET" && req.method !== "POST")) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("not found");
			return;
		}
		const upstream = request(
			{ host: webuiHost, port: webuiPort, path: allowedPath, method: req.method, headers: req.headers },
			(upstreamRes) => {
				res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
				upstreamRes.pipe(res);
			},
		);
		upstream.on("error", () => {
			res.writeHead(502, { "Content-Type": "text/plain" });
			res.end("upstream unavailable");
		});
		req.pipe(upstream);
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

/**
 * Open a tunnel for one drop. Resolves undefined (silently) when cloudflared
 * isn't installed or doesn't report a URL in time — the caller falls back to
 * the plain local path.
 */
export async function openDropTunnel(webuiPort: number, token: string, timeoutMs = 20_000): Promise<DropTunnel | undefined> {
	const configuredHost = process.env.IRIS_WEBUI_HOST ?? "127.0.0.1";
	const webuiHost = configuredHost === "0.0.0.0" || configuredHost === "::" ? "127.0.0.1" : configuredHost;
	let proxy: Server;
	try {
		proxy = await startDropProxy(webuiHost, webuiPort, token);
	} catch (err) {
		log.logWarning("[secret-drop] tunnel proxy failed to start", err instanceof Error ? err.message : String(err));
		return undefined;
	}
	const proxyPort = (proxy.address() as AddressInfo).port;
	const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${proxyPort}`], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		child.kill();
		proxy.close();
	};

	return new Promise((resolve) => {
		let settled = false;
		const settle = (tunnel: DropTunnel | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!tunnel) close();
			resolve(tunnel);
		};
		const timer = setTimeout(() => settle(undefined), timeoutMs);
		const onOutput = (chunk: Buffer) => {
			const match = URL_RE.exec(chunk.toString());
			if (match) settle({ url: match[0], close });
		};
		child.stdout?.on("data", onOutput);
		child.stderr?.on("data", onOutput);
		// ENOENT (not installed) lands here — skip silently.
		child.on("error", () => settle(undefined));
		child.on("exit", () => {
			settle(undefined);
			close();
		});
	});
}
