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

// Bodies are buffered whole (fetch() needs a complete Buffer, not a stream,
// to set Content-Length correctly for most upstreams) — cap it so a caller
// with a valid broker token can't pressure broker memory with an oversized
// request.
const MAX_GATEWAY_BODY_BYTES = 10 * 1024 * 1024;

/** Returns undefined if the body exceeds `limit` bytes. */
async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		total += (chunk as Buffer).length;
		if (total > limit) return undefined;
		chunks.push(chunk as Buffer);
	}
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

	// Keyed by lowercase header name so an injected header (e.g. "X-Api-Key")
	// always replaces — rather than duplicates alongside — a differently-cased
	// caller-supplied header of the same name; HTTP header names are
	// case-insensitive but a plain object isn't, and fetch() would otherwise
	// send both to the upstream.
	const headers = new Map<string, { name: string; value: string }>();
	for (const [name, headerValue] of Object.entries(req.headers)) {
		const lower = name.toLowerCase();
		if (STRIPPED_REQUEST_HEADERS.has(lower)) continue;
		if (typeof headerValue === "string") headers.set(lower, { name, value: headerValue });
	}
	for (const [name, template] of Object.entries(service.headers)) {
		headers.set(name.toLowerCase(), { name, value: template.replace("{value}", value) });
	}
	const outgoingHeaders = Object.fromEntries([...headers.values()].map(({ name, value }) => [name, value]));

	const upstreamUrl = service.upstream.replace(/\/$/, "") + subPath;
	const method = req.method ?? "GET";
	let body: Buffer | undefined;
	if (method !== "GET" && method !== "HEAD") {
		body = await readRawBody(req, MAX_GATEWAY_BODY_BYTES);
		if (body === undefined) {
			res.writeHead(413, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: `request body exceeds ${MAX_GATEWAY_BODY_BYTES} bytes` }));
			return;
		}
	}

	let upstream: Response;
	try {
		upstream = await fetch(upstreamUrl, { method, headers: outgoingHeaders, body });
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
