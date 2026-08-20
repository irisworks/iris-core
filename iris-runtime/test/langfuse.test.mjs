// Langfuse session correlation (#133) — traces must carry the Iris session id
// so Pupil (IRIS-97) can read them back via /api/public/sessions/:sessionId.
// Drives the real compiled client against a stub OTel ingestion server.
// Transport: OTLP/HTTP JSON → POST /api/public/otel/v1/traces (IRIS-171).

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer } from "node:http";
import {
	LangfuseClient,
	langfuseConfigFromEnv,
	langfuseSessionId,
	getLangfuseClient,
	setLangfuseClient,
} from "../dist/engine/langfuse.js";

const servers = [];

after(() => {
	for (const server of servers) server.close();
	setLangfuseClient(undefined);
});

// -- OTLP helpers ------------------------------------------------------------

/** Extract all spans from the first resourceSpans entry. */
function getSpans(payload) {
	return payload?.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [];
}

/** Get the string/int/double/array value of a named attribute on a span. */
function getAttr(span, key) {
	const a = span.attributes?.find((a) => a.key === key);
	if (!a) return undefined;
	const v = a.value;
	if ("stringValue" in v) return v.stringValue;
	if ("intValue" in v) return parseInt(v.intValue, 10);
	if ("doubleValue" in v) return v.doubleValue;
	if ("arrayValue" in v) return v.arrayValue.values.map((v) => v.stringValue ?? v.intValue);
	return undefined;
}

/** JSON.parse a string attribute (input/output/usage_details are JSON strings). */
function jsonAttr(span, key) {
	const s = getAttr(span, key);
	return s !== undefined ? JSON.parse(s) : undefined;
}

function rootSpan(spans) {
	return spans.find((s) => !s.parentSpanId);
}

function childSpanNamed(spans, name) {
	return spans.find((s) => s.parentSpanId && s.name === name);
}

function childSpanOfType(spans, type) {
	return spans.find((s) => s.parentSpanId && getAttr(s, "langfuse.observation.type") === type);
}

// -- Stub server -------------------------------------------------------------

/** Stub OTel ingestion endpoint; records every OTLP payload it receives. */
async function stubLangfuse({ status = 200 } = {}) {
	const payloads = [];
	const headers = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			headers.push({ url: req.url, authorization: req.headers.authorization });
			try {
				payloads.push(JSON.parse(body));
			} catch {
				payloads.push(null);
			}
			res.writeHead(status, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	servers.push(server);
	const baseUrl = await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
	});
	return { baseUrl, payloads, headers };
}

function client(baseUrl, overrides = {}) {
	return new LangfuseClient({
		baseUrl,
		publicKey: "pk-test",
		secretKey: "sk-test",
		environment: "test",
		release: "1.2.3",
		timeoutMs: 2000,
		captureIo: true,
		...overrides,
	});
}

const usage = {
	input: 100,
	output: 20,
	cacheRead: 40,
	cacheWrite: 10,
	cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
};

// -- Tests -------------------------------------------------------------------

test("session id strips the SESSION- channel prefix", () => {
	assert.equal(langfuseSessionId("SESSION-abc-123"), "abc-123");
	assert.equal(langfuseSessionId("C0123SLACK"), "C0123SLACK");
});

test("config is undefined without keys and disabled explicitly", () => {
	assert.equal(langfuseConfigFromEnv({}), undefined);
	assert.equal(langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk" }), undefined);
	assert.equal(
		langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_ENABLED: "false" }),
		undefined,
	);
});

test("config reads LANGFUSE_HOST, falls back to LANGFUSE_BASE_URL, trims trailing slash", () => {
	assert.equal(
		langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_HOST: "http://lf.local/" })
			.baseUrl,
		"http://lf.local",
	);
	assert.equal(
		langfuseConfigFromEnv({
			LANGFUSE_PUBLIC_KEY: "pk",
			LANGFUSE_SECRET_KEY: "sk",
			LANGFUSE_BASE_URL: "http://alias.local",
		}).baseUrl,
		"http://alias.local",
	);
	// Default host when only keys are set.
	assert.equal(
		langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }).baseUrl,
		"https://cloud.langfuse.com",
	);
});

test("a flushed run trace carries sessionId, usage/cost, and tool observations via OTel", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({
		sessionId: "session-1",
		channelId: "SESSION-session-1",
		userId: "api",
		input: "book me a flight",
		model: "claude-opus-4-6",
		provider: "anthropic",
		transportId: "slack",
	});
	const start = new Date("2026-07-30T10:00:00.000Z");
	const end = new Date("2026-07-30T10:00:02.000Z");
	trace.recordTool({ name: "bash", startTime: start, endTime: end, input: { cmd: "ls" }, output: "ok" });
	trace.recordGeneration({ startTime: start, endTime: end, output: "done", usage });
	trace.end({ output: "done", stopReason: "stop", usage });
	await trace.flush();

	assert.equal(stub.payloads.length, 1);
	assert.equal(stub.headers[0].url, "/api/public/otel/v1/traces");
	assert.equal(stub.headers[0].authorization, `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);

	const spans = getSpans(stub.payloads[0]);
	const root = rootSpan(spans);
	assert.ok(root, "root span must exist");
	assert.equal(root.traceId, trace.traceId.replace(/-/g, ""));
	assert.equal(getAttr(root, "langfuse.session.id"), "session-1");
	assert.equal(getAttr(root, "langfuse.user.id"), "api");
	assert.equal(getAttr(root, "langfuse.environment"), "test");
	assert.equal(getAttr(root, "langfuse.release"), "1.2.3");
	assert.deepEqual(getAttr(root, "langfuse.trace.tags"), ["iris", "transport:slack"]);
	assert.equal(getAttr(root, "langfuse.trace.metadata.channelId"), "SESSION-session-1");
	assert.equal(getAttr(root, "langfuse.trace.metadata.sessionId"), "session-1");
	assert.equal(getAttr(root, "langfuse.trace.metadata.totalCostUsd"), "0.0033");
	assert.equal(jsonAttr(root, "langfuse.trace.output"), "done");

	const gen = childSpanOfType(spans, "generation");
	assert.ok(gen, "generation child span must exist");
	assert.equal(gen.parentSpanId, root.spanId);
	assert.equal(getAttr(gen, "langfuse.observation.model.name"), "claude-opus-4-6");
	const usageDetails = jsonAttr(gen, "langfuse.observation.usage_details");
	assert.equal(usageDetails.input, 100);
	assert.equal(usageDetails.output, 20);
	assert.equal(usageDetails.total, 170);
	const costDetails = jsonAttr(gen, "langfuse.observation.cost_details");
	assert.equal(costDetails.total, 0.0033);

	const tool = childSpanNamed(spans, "bash");
	assert.ok(tool, "tool child span must exist");
	assert.equal(tool.parentSpanId, root.spanId);
	assert.equal(getAttr(tool, "langfuse.observation.type"), "span");
	assert.equal(getAttr(tool, "langfuse.observation.level"), "DEFAULT");
	assert.equal(tool.startTimeUnixNano, String(BigInt(start.getTime()) * 1_000_000n));
});

test("LANGFUSE_CAPTURE_IO=false drops payloads but keeps usage and cost", async () => {
	assert.equal(
		langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }).captureIo,
		true,
	);
	assert.equal(
		langfuseConfigFromEnv({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_CAPTURE_IO: "false" })
			.captureIo,
		false,
	);

	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl, { captureIo: false }).startTrace({
		sessionId: "s",
		channelId: "SESSION-s",
		input: "secret question",
	});
	const now = new Date();
	trace.recordTool({ name: "bash", startTime: now, endTime: now, input: { cmd: "cat /iris/.env" }, output: "TOKEN=..." });
	trace.recordGeneration({ startTime: now, endTime: now, output: "secret answer", usage });
	trace.end({ output: "secret answer", usage });
	await trace.flush();

	const spans = getSpans(stub.payloads[0]);
	const wire = JSON.stringify(spans);
	assert.ok(!wire.includes("secret"), "no payload text should reach the wire");

	// IO attributes must be absent on all spans.
	for (const span of spans) {
		assert.equal(getAttr(span, "langfuse.observation.input"), undefined, `${span.name} should carry no input`);
		assert.equal(getAttr(span, "langfuse.observation.output"), undefined, `${span.name} should carry no output`);
		assert.equal(getAttr(span, "langfuse.trace.input"), undefined, "root span should carry no trace input");
		assert.equal(getAttr(span, "langfuse.trace.output"), undefined, "root span should carry no trace output");
	}

	// Telemetry survives.
	const gen = childSpanOfType(spans, "generation");
	assert.equal(jsonAttr(gen, "langfuse.observation.usage_details").input, 100);
	assert.equal(jsonAttr(gen, "langfuse.observation.cost_details").total, 0.0033);

	const tool = childSpanNamed(spans, "bash");
	assert.equal(tool.name, "bash");

	const root = rootSpan(spans);
	assert.equal(getAttr(root, "langfuse.trace.metadata.totalCostUsd"), "0.0033");
});

test("failing tool calls are flagged ERROR", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	trace.recordTool({ name: "bash", startTime: now, endTime: now, output: "boom", isError: true });
	await trace.flush();
	const tool = childSpanNamed(getSpans(stub.payloads[0]), "bash");
	assert.equal(getAttr(tool, "langfuse.observation.level"), "ERROR");
});

test("oversized payloads are truncated", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	trace.recordTool({ name: "bash", startTime: now, endTime: now, output: "x".repeat(50_000) });
	await trace.flush();
	const tool = childSpanNamed(getSpans(stub.payloads[0]), "bash");
	// output is a JSON string — parse it to get the clipped string.
	const output = jsonAttr(tool, "langfuse.observation.output");
	assert.ok(output.length < 21_000, "tool output should be clipped");
	assert.ok(output.endsWith("(truncated)"));
});

test("oversized structured payloads are truncated too", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	// Tool args arrive as objects — a fat member must not slip past the cap.
	trace.recordTool({ name: "write", startTime: now, endTime: now, input: { path: "/x", content: "y".repeat(50_000) } });
	await trace.flush();
	const tool = childSpanNamed(getSpans(stub.payloads[0]), "write");
	// Oversized object degrades to a clipped string, then JSON-encoded.
	const input = jsonAttr(tool, "langfuse.observation.input");
	assert.equal(typeof input, "string", "oversized args degrade to a clipped string");
	assert.ok(input.length < 21_000);
	assert.ok(input.endsWith("(truncated)"));
});

test("small structured payloads pass through unchanged", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	trace.recordTool({ name: "bash", startTime: now, endTime: now, input: { cmd: "ls", n: 1, ok: true } });
	await trace.flush();
	const tool = childSpanNamed(getSpans(stub.payloads[0]), "bash");
	assert.deepEqual(jsonAttr(tool, "langfuse.observation.input"), { cmd: "ls", n: 1, ok: true });
});

test("circular payloads neither throw nor sink the event", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	const circular = { name: "loop" };
	circular.self = circular;
	trace.recordTool({ name: "bash", startTime: now, endTime: now, input: circular });
	await trace.flush();
	const tool = childSpanNamed(getSpans(stub.payloads[0]), "bash");
	assert.equal(jsonAttr(tool, "langfuse.observation.input"), "[unserializable]");
});

test("flush resolves without throwing when Langfuse errors or is unreachable", async () => {
	const failing = await stubLangfuse({ status: 500 });
	const errored = client(failing.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	errored.end({ output: "x" });
	await errored.flush(); // must not reject

	const dead = client("http://127.0.0.1:1"); // nothing listening
	const unreachable = dead.startTrace({ sessionId: "s", channelId: "SESSION-s" });
	unreachable.end({ output: "x" });
	await unreachable.flush(); // must not reject
});

test("an oversized batch is split across requests instead of dropped", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	// ~20 KB of clipped output each — enough of them to blow past one request.
	for (let i = 0; i < 200; i++) {
		trace.recordTool({ name: `bash-${i}`, startTime: now, endTime: now, output: "x".repeat(30_000) });
	}
	trace.end({ output: "done" });
	await trace.flush();

	assert.ok(stub.payloads.length > 1, `expected multiple requests, got ${stub.payloads.length}`);
	const allSpans = stub.payloads.flatMap((p) => getSpans(p));
	const toolSpans = allSpans.filter((s) => s.parentSpanId);
	assert.equal(toolSpans.length, 200, "no observation may be dropped");
	assert.ok(!rootSpan(getSpans(stub.payloads[0])).parentSpanId, "root span lands in the first request");
	for (const payload of stub.payloads) {
		assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 3_000_000, "each request stays under the size cap");
	}
});

test("flush ships only new events on a second call", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	trace.recordTool({ name: "read", startTime: now, endTime: now });
	await trace.flush();
	await trace.flush();
	assert.equal(stub.payloads.length, 2);
	// Second flush re-sends root span only — child spans are not duplicated.
	const secondSpans = getSpans(stub.payloads[1]);
	assert.equal(secondSpans.length, 1);
	assert.ok(!secondSpans[0].parentSpanId, "second flush contains only the root span");
});

test("getLangfuseClient is a no-op without env configuration", () => {
	const saved = { pk: process.env.LANGFUSE_PUBLIC_KEY, sk: process.env.LANGFUSE_SECRET_KEY };
	delete process.env.LANGFUSE_PUBLIC_KEY;
	delete process.env.LANGFUSE_SECRET_KEY;
	setLangfuseClient(undefined);
	try {
		assert.equal(getLangfuseClient(), undefined);
	} finally {
		if (saved.pk) process.env.LANGFUSE_PUBLIC_KEY = saved.pk;
		if (saved.sk) process.env.LANGFUSE_SECRET_KEY = saved.sk;
		setLangfuseClient(undefined);
	}
});
