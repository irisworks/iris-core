// ============================================================================
// Injection gateway — forwards /proxy/<service>/<path> to the service's
// upstream with the stored secret injected into the configured header(s).
// The caller never holds the credential; for `proxyOnly` secrets this is the
// only way the value can be exercised at all.
// ============================================================================

import type { IncomingMessage, ServerResponse } from "http";
import { Readable } from "stream";
import * as log from "../engine/log.js";
import type { SecretStore } from "../engine/secret-store.js";
import type { GatewayService } from "./services.js";

// Hop-by-hop headers (RFC 9110 §7.6.1) plus everything that must never reach
// the upstream: the caller's broker auth, and host/length fields fetch()
// recomputes itself.
const STRIPPED_REQUEST_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"authorization",
	"host",
	"content-length",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
	"connection",
	"keep-alive",
	"transfer-encoding",
	"content-encoding",
	"content-length",
]);

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

export async function forwardToService(
	req: IncomingMessage,
	res: ServerResponse,
	service: GatewayService,
	serviceName: string,
	subPath: string,
	store: SecretStore,
): Promise<void> {
	const value = store.get(service.secret);
	if (value === undefined) {
		res.writeHead(502, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `secret '${service.secret}' for service '${serviceName}' is not in the store` }));
		return;
	}

	const headers: Record<string, string> = {};
	for (const [name, headerValue] of Object.entries(req.headers)) {
		if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
		if (typeof headerValue === "string") headers[name] = headerValue;
	}
	for (const [name, template] of Object.entries(service.headers)) {
		headers[name] = template.replace("{value}", value);
	}

	const upstreamUrl = service.upstream.replace(/\/$/, "") + subPath;
	const method = req.method ?? "GET";
	const body = method === "GET" || method === "HEAD" ? undefined : await readRawBody(req);

	let upstream: Response;
	try {
		upstream = await fetch(upstreamUrl, { method, headers, body });
	} catch (err) {
		log.logWarning(`[broker] upstream fetch failed for ${serviceName}`, err instanceof Error ? err.message : String(err));
		res.writeHead(502, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "upstream request failed" }));
		return;
	}

	const responseHeaders: Record<string, string> = {};
	upstream.headers.forEach((headerValue, name) => {
		if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) return;
		responseHeaders[name] = headerValue;
	});
	res.writeHead(upstream.status, responseHeaders);
	if (upstream.body) {
		// Streamed through so SSE responses (e.g. LLM APIs) work unbuffered.
		Readable.fromWeb(upstream.body as import("stream/web").ReadableStream).pipe(res);
	} else {
		res.end();
	}
}
