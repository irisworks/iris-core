#!/usr/bin/env node
// ============================================================================
// iris-broker — standalone credential broker daemon for proxy secrets mode.
//
// Runs as its own systemd unit (iris-broker.service) under a dedicated user
// (iris-broker) that exclusively owns the key and store files, so the agent —
// which shares a uid with the runtime under --sandbox=host — can never read
// the key material, only talk to this API.
//
// Auth: Bearer IRIS_SECRET_BROKER_TOKEN on everything except GET /health.
// Routes:
//   GET    /health          — liveness, unauthenticated
//   GET    /secrets         — list names + metadata (never values)
//   GET    /secret/:name    — plaintext read; ALWAYS 403 for proxyOnly secrets,
//                             no matter which token is presented (this is the
//                             hard guarantee the injection gateway exists for).
//                             Path shape matches createBrokerSecretProvider.
//   GET    /meta/:name      — metadata for one secret (runtime policy checks)
//   PUT    /secret/:name    — body {value, proxyOnly?, agentReadable?, source?}
//   DELETE /secret/:name
//   ANY    /proxy/:service/* — injection gateway (see gateway.ts)
// ============================================================================

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import * as log from "../engine/log.js";
import { secretMatches, readBody } from "../engine/api.js";
import { SECRET_NAME_RE, SecretStore, type SecretSource } from "../engine/secret-store.js";
import { loadServices } from "./services.js";
import { forwardToService } from "./gateway.js";

const port = parseInt(process.env.IRIS_BROKER_PORT ?? "9099", 10);
const host = process.env.IRIS_BROKER_HOST ?? "127.0.0.1";
const token = process.env.IRIS_SECRET_BROKER_TOKEN ?? "";

if (!token) {
	console.error("iris-broker: IRIS_SECRET_BROKER_TOKEN is not set — refusing to start unauthenticated");
	process.exit(1);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function authed(req: IncomingMessage): boolean {
	const header = req.headers.authorization ?? "";
	// Avoid a regex with adjacent overlapping quantifiers (\s+ and (.+) both
	// match spaces) — CodeQL flags that shape as polynomial-time on crafted
	// input. Bounded prefix match + slice is equivalent and linear.
	const prefix = /^Bearer\s+/i.exec(header);
	if (!prefix) return false;
	const presented = header.slice(prefix[0].length);
	return presented.length > 0 && secretMatches(presented, token);
}

const server = createServer(async (req, res) => {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";
	const pathOnly = url.split("?")[0];
	const parts = pathOnly.replace(/^\//, "").split("/").map((p) => decodeURIComponent(p));

	try {
		if (method === "GET" && pathOnly === "/health") {
			json(res, 200, { ok: true });
			return;
		}

		if (!authed(req)) {
			json(res, 401, { error: "unauthorized" });
			return;
		}

		const store = SecretStore.open();
		if (!store) {
			json(res, 503, { error: "secret store not configured (key file missing)" });
			return;
		}

		// ── GET /secrets — names + metadata only ─────────────────────────────
		if (method === "GET" && pathOnly === "/secrets") {
			json(res, 200, { secrets: store.list() });
			return;
		}

		// ── GET /meta/:name ──────────────────────────────────────────────────
		if (method === "GET" && parts[0] === "meta" && parts.length === 2 && parts[1]) {
			const meta = store.meta(parts[1]);
			if (!meta) {
				json(res, 404, { error: "secret not found" });
				return;
			}
			json(res, 200, meta);
			return;
		}

		// ── /secret/:name — read / write / delete ────────────────────────────
		if (parts[0] === "secret" && parts.length === 2 && parts[1]) {
			const name = parts[1];

			if (method === "GET") {
				const meta = store.meta(name);
				if (!meta) {
					json(res, 404, { error: "secret not found" });
					return;
				}
				if (meta.proxyOnly) {
					log.logWarning(`[broker] plaintext read of proxy-only secret '${name}' refused`);
					json(res, 403, { error: `secret '${name}' is proxy-only — use the /proxy gateway` });
					return;
				}
				const value = store.get(name);
				if (value === undefined) {
					json(res, 404, { error: "secret not found" });
					return;
				}
				json(res, 200, { value });
				return;
			}

			if (method === "PUT") {
				if (!SECRET_NAME_RE.test(name)) {
					json(res, 400, { error: "invalid secret name" });
					return;
				}
				let body: { value?: string; proxyOnly?: boolean; agentReadable?: boolean; source?: SecretSource };
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
				store.set(name, body.value, {
					source: body.source ?? "api",
					proxyOnly: body.proxyOnly,
					agentReadable: body.agentReadable,
				});
				log.logInfo(`[broker] secret '${name}' stored (source=${body.source ?? "api"})`);
				json(res, 200, { ok: true, name });
				return;
			}

			if (method === "DELETE") {
				if (!store.delete(name)) {
					json(res, 404, { error: "secret not found" });
					return;
				}
				log.logInfo(`[broker] secret '${name}' deleted`);
				json(res, 200, { ok: true });
				return;
			}
		}

		// ── ANY /proxy/:service/* — injection gateway ────────────────────────
		if (parts[0] === "proxy" && parts.length >= 2 && parts[1]) {
			const services = loadServices();
			const service = services[parts[1]];
			if (!service) {
				json(res, 404, { error: `unknown gateway service '${parts[1]}'` });
				return;
			}
			// Sub-path keeps the raw (still-encoded) tail plus the query string.
			const rawPrefixLength = "/proxy/".length + encodeURIComponent(parts[1]).length;
			const subPath = url.slice(rawPrefixLength) || "/";
			await forwardToService(req, res, service, parts[1], subPath, store);
			return;
		}

		json(res, 404, { error: "not found" });
	} catch (err) {
		log.logWarning("[broker] request failed", err instanceof Error ? err.message : String(err));
		json(res, 500, { error: "internal error" });
	}
});

server.listen(port, host, () => {
	log.logInfo(`[broker] iris-broker listening on ${host}:${port}`);
});
