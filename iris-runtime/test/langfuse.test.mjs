// Langfuse session correlation (#133) — traces must carry the Iris session id
// so Pupil (IRIS-97) can read them back via /api/public/sessions/:sessionId.
// Drives the real compiled client against a stub ingestion server.

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

/** Stub ingestion endpoint; records every batch it receives. */
async function stubLangfuse({ status = 207 } = {}) {
	const batches = [];
	const headers = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			headers.push({ url: req.url, authorization: req.headers.authorization });
			try {
				batches.push(JSON.parse(body).batch);
			} catch {
				batches.push(null);
			}
			res.writeHead(status, { "content-type": "application/json" });
			res.end("{}");
		});
	});
	servers.push(server);
	const baseUrl = await new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
	});
	return { baseUrl, batches, headers };
}

function client(baseUrl) {
	return new LangfuseClient({
		baseUrl,
		publicKey: "pk-test",
		secretKey: "sk-test",
		environment: "test",
		release: "1.2.3",
		timeoutMs: 2000,
	});
}

const usage = {
	input: 100,
	output: 20,
	cacheRead: 40,
	cacheWrite: 10,
	cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
};

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

test("a flushed run trace carries sessionId, usage/cost, and TOOL observations", async () => {
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

	assert.equal(stub.batches.length, 1);
	assert.equal(stub.headers[0].url, "/api/public/ingestion");
	assert.equal(stub.headers[0].authorization, `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);

	const batch = stub.batches[0];
	const traceEvent = batch.find((e) => e.type === "trace-create");
	assert.equal(traceEvent.body.sessionId, "session-1");
	assert.equal(traceEvent.body.id, trace.traceId);
	assert.equal(traceEvent.body.userId, "api");
	assert.equal(traceEvent.body.output, "done");
	assert.equal(traceEvent.body.environment, "test");
	assert.equal(traceEvent.body.release, "1.2.3");
	assert.deepEqual(traceEvent.body.tags, ["iris", "transport:slack"]);
	assert.equal(traceEvent.body.metadata.channelId, "SESSION-session-1");
	assert.equal(traceEvent.body.metadata.sessionId, "session-1");
	assert.equal(traceEvent.body.metadata.totalCostUsd, 0.0033);

	const generation = batch.find((e) => e.type === "generation-create");
	assert.equal(generation.body.traceId, trace.traceId);
	assert.equal(generation.body.model, "claude-opus-4-6");
	assert.equal(generation.body.usageDetails.input, 100);
	assert.equal(generation.body.usageDetails.output, 20);
	assert.equal(generation.body.usageDetails.total, 170);
	assert.equal(generation.body.costDetails.total, 0.0033);

	const tool = batch.find((e) => e.type === "observation-create");
	assert.equal(tool.body.type, "TOOL");
	assert.equal(tool.body.name, "bash");
	assert.equal(tool.body.traceId, trace.traceId);
	assert.equal(tool.body.startTime, start.toISOString());
	assert.equal(tool.body.level, "DEFAULT");
});

test("failing tool calls are flagged ERROR", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	trace.recordTool({ name: "bash", startTime: now, endTime: now, output: "boom", isError: true });
	await trace.flush();
	const tool = stub.batches[0].find((e) => e.type === "observation-create");
	assert.equal(tool.body.level, "ERROR");
});

test("oversized payloads are truncated", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	trace.recordTool({ name: "bash", startTime: now, endTime: now, output: "x".repeat(50_000) });
	await trace.flush();
	const tool = stub.batches[0].find((e) => e.type === "observation-create");
	assert.ok(tool.body.output.length < 21_000, "tool output should be clipped");
	assert.ok(tool.body.output.endsWith("(truncated)"));
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

test("flush ships only new events on a second call", async () => {
	const stub = await stubLangfuse();
	const trace = client(stub.baseUrl).startTrace({ sessionId: "s", channelId: "SESSION-s" });
	const now = new Date();
	trace.recordTool({ name: "read", startTime: now, endTime: now });
	await trace.flush();
	await trace.flush();
	assert.equal(stub.batches.length, 2);
	// Second flush re-upserts the trace only — observations aren't duplicated.
	assert.deepEqual(
		stub.batches[1].map((e) => e.type),
		["trace-create"],
	);
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
