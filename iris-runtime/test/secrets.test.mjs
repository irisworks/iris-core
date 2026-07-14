// GET /secrets/:name — agent-scoped secret resolution (IRIS-111).
// Drives the real compiled startApiServer against the env backend; no broker
// involved (IRIS_SECRET_BROKER_URL unset in this suite).

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../dist/api.js";

const PORT = 18337;
const BASE = `http://127.0.0.1:${PORT}`;

// Every server opened during this file's tests, closed once in `after` below —
// startApiServer never returns on its own, so nothing else stops the event
// loop from staying alive on open listeners.
const servers = [];

function startServer(port, workingDir) {
	const server = startApiServer(port, workingDir, new Map(), () => []);
	servers.push(server);
	return server;
}

function makeWorkingDir(agents = {}) {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-secrets-test-"));
	writeFileSync(join(workingDir, "agents.json"), JSON.stringify(agents));
	return workingDir;
}

after(() => {
	for (const server of servers) server.close();
});

test("secrets: env backend resolves a caller-less request as unrestricted iris", async () => {
	process.env.IRIS_API_TOKEN = "";
	process.env.TEST_SECRET_ONE = "hello-world";
	const workingDir = makeWorkingDir();
	startServer(PORT, workingDir);

	const res = await fetch(`${BASE}/secrets/TEST-SECRET-ONE`);
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.value, "hello-world");
});

test("secrets: unknown secret returns 404", async () => {
	const res = await fetch(`${BASE}/secrets/TOTALLY-UNKNOWN-SECRET`);
	assert.equal(res.status, 404);
});

test("secrets: sub-agent without an allow-list entry is denied", async () => {
	const res = await fetch(`${BASE}/secrets/TEST-SECRET-ONE`, {
		headers: { "X-Iris-Caller": "unlisted-agent" },
	});
	assert.equal(res.status, 403);
});

test("secrets: sub-agent allow-listed for the exact name is granted", async () => {
	const workingDir = makeWorkingDir({
		"listed-agent": { bridge_url: "http://127.0.0.1:4999", secrets: ["TEST-SECRET-ONE"] },
	});
	startServer(PORT + 1, workingDir);

	const res = await fetch(`http://127.0.0.1:${PORT + 1}/secrets/TEST-SECRET-ONE`, {
		headers: { "X-Iris-Caller": "listed-agent" },
	});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.value, "hello-world");
});

test("secrets: sub-agent allow-listed for a different name is still denied", async () => {
	const workingDir = makeWorkingDir({
		"listed-agent": { bridge_url: "http://127.0.0.1:4999", secrets: ["SOME-OTHER-SECRET"] },
	});
	startServer(PORT + 2, workingDir);

	const res = await fetch(`http://127.0.0.1:${PORT + 2}/secrets/TEST-SECRET-ONE`, {
		headers: { "X-Iris-Caller": "listed-agent" },
	});
	assert.equal(res.status, 403);
});

test("secrets: requires bearer auth when IRIS_API_TOKEN is set", async () => {
	process.env.IRIS_API_TOKEN = "test-token-123";
	const workingDir = makeWorkingDir();
	startServer(PORT + 3, workingDir);
	const base = `http://127.0.0.1:${PORT + 3}`;

	const unauthed = await fetch(`${base}/secrets/TEST-SECRET-ONE`);
	assert.equal(unauthed.status, 401);

	const authed = await fetch(`${base}/secrets/TEST-SECRET-ONE`, {
		headers: { Authorization: "Bearer test-token-123" },
	});
	assert.equal(authed.status, 200);

	// /health never requires auth
	const health = await fetch(`${base}/health`);
	assert.equal(health.status, 200);

	delete process.env.IRIS_API_TOKEN;
});
