// GET /secrets/:name — agent-scoped secret resolution (IRIS-111), caller
// identity derived from the authenticating token rather than the
// self-reported X-Iris-Caller header (IRIS-120).
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

test("secrets: no IRIS_API_TOKEN configured resolves every request as unrestricted iris", async () => {
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

test("secrets: requires bearer auth when IRIS_API_TOKEN is set", async () => {
	process.env.IRIS_API_TOKEN = "test-token-123";
	const workingDir = makeWorkingDir();
	startServer(PORT + 1, workingDir);
	const base = `http://127.0.0.1:${PORT + 1}`;

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

test("secrets: caller is derived from the agent's own token, not X-Iris-Caller", async () => {
	process.env.IRIS_API_TOKEN = "shared-iris-token";
	const workingDir = makeWorkingDir({
		"listed-agent": {
			bridge_url: "http://127.0.0.1:4999",
			secrets: ["TEST-SECRET-ONE"],
			token: "listed-agent-token",
		},
	});
	startServer(PORT + 2, workingDir);
	const base = `http://127.0.0.1:${PORT + 2}`;

	// Authenticating with the agent's own token grants what it's allow-listed for.
	const granted = await fetch(`${base}/secrets/TEST-SECRET-ONE`, {
		headers: { Authorization: "Bearer listed-agent-token" },
	});
	assert.equal(granted.status, 200);

	// Same token, a name it isn't allow-listed for.
	const denied = await fetch(`${base}/secrets/SOME-OTHER-SECRET`, {
		headers: { Authorization: "Bearer listed-agent-token" },
	});
	assert.equal(denied.status, 403);

	delete process.env.IRIS_API_TOKEN;
});

test("secrets: X-Iris-Caller can no longer be used to impersonate another caller", async () => {
	process.env.IRIS_API_TOKEN = "shared-iris-token";
	const workingDir = makeWorkingDir({
		"listed-agent": {
			bridge_url: "http://127.0.0.1:4999",
			secrets: ["TEST-SECRET-ONE"],
			token: "listed-agent-token",
		},
	});
	startServer(PORT + 3, workingDir);
	const base = `http://127.0.0.1:${PORT + 3}`;

	// Holder of the shared IRIS_API_TOKEN claims X-Iris-Caller: iris (the old
	// bypass) — must still resolve from the token (unrestricted "iris" is
	// correct here anyway, but the header must not be what grants it).
	const spoofed = await fetch(`${base}/secrets/UNLISTED-SECRET`, {
		headers: {
			Authorization: "Bearer shared-iris-token",
			"X-Iris-Caller": "listed-agent",
		},
	});
	// "iris" (from the token) is unrestricted, so this 404s (secret doesn't
	// exist) rather than 403 (which the header alone would have produced
	// under the old caller resolution).
	assert.equal(spoofed.status, 404);

	// An unrecognized token cannot claim to be any caller via the header.
	const unauthorized = await fetch(`${base}/secrets/TEST-SECRET-ONE`, {
		headers: {
			Authorization: "Bearer not-a-real-token",
			"X-Iris-Caller": "listed-agent",
		},
	});
	assert.equal(unauthorized.status, 401);

	delete process.env.IRIS_API_TOKEN;
});

test("secrets: agent entry without its own token falls back to the shared token as unrestricted iris", async () => {
	process.env.IRIS_API_TOKEN = "shared-iris-token";
	const workingDir = makeWorkingDir({
		"no-token-agent": { bridge_url: "http://127.0.0.1:4999", secrets: ["SOME-OTHER-SECRET"] },
	});
	startServer(PORT + 4, workingDir);
	const base = `http://127.0.0.1:${PORT + 4}`;

	const res = await fetch(`${base}/secrets/TEST-SECRET-ONE`, {
		headers: { Authorization: "Bearer shared-iris-token" },
	});
	assert.equal(res.status, 200);

	delete process.env.IRIS_API_TOKEN;
});
