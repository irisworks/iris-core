// Issue #297: POST /sessions/:id/message carries a stable caller identity
// (`userId`, optional `userName`/`role`) through the transport into the turn,
// and the engine layers `<workspace>/users/<userId>/MEMORY.md` +
// `PREFERENCES.md` on top of global and channel memory for that user only.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionIdentity, startApiServer } from "../dist/engine/api.js";
import { buildDynamicContext, getMemory } from "../dist/engine/agent.js";
import { createSession, resolveSessionRequest } from "../dist/engine/sessions.js";
import { BridgeTransport } from "../dist/transports/bridge/bridge-transport.js";

const closers = [];
after(() => {
	for (const close of closers) close();
});

function makeWorkingDir() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-session-identity-test-"));
	writeFileSync(join(workingDir, "agents.json"), JSON.stringify({}));
	return workingDir;
}

function makeApiTransport() {
	const injected = [];
	return {
		injected,
		ownsChannel: () => true,
		stopCommandHint: "stop",
		injectSessionMessage: async (sessionId, user, text, attachments, identity) => {
			injected.push({ sessionId, user, text, attachments, identity });
			return "stub reply";
		},
		postMessage: async () => "1",
		updateMessage: async () => {},
		createContext: () => ({}),
		resetSessionContext: () => {},
	};
}

function startServer(port, workingDir, transport) {
	const server = startApiServer(port, workingDir, new Map(), () => [transport]);
	closers.push(() => server.close());
	return `http://127.0.0.1:${port}`;
}

async function postMessage(base, sessionId, body) {
	return fetch(`${base}/sessions/${sessionId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// ============================================================================
// API contract
// ============================================================================

test("session message: userId/userName/role reach the transport, userName labels the turn", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = createSession(workingDir, { originChannel: "C1", originThreadTs: "1.0" }).sessionId;
	const transport = makeApiTransport();
	const base = startServer(19720, workingDir, transport);

	const res = await postMessage(base, sessionId, {
		text: "remember I like tea",
		userId: "u-42",
		userName: "Ada",
		role: "admin",
	});
	assert.equal(res.status, 200);
	assert.equal(transport.injected[0].user, "Ada");
	assert.deepEqual(transport.injected[0].identity, { userId: "u-42", userName: "Ada", role: "admin" });
});

test("session message: no userId keeps the legacy contract (no identity, `user` label)", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = createSession(workingDir, { originChannel: "C1", originThreadTs: "1.0" }).sessionId;
	const transport = makeApiTransport();
	const base = startServer(19721, workingDir, transport);

	const res = await postMessage(base, sessionId, { text: "hi", user: "kat" });
	assert.equal(res.status, 200);
	assert.equal(transport.injected[0].user, "kat");
	assert.equal(transport.injected[0].identity, undefined);
});

test("session message: an unsafe or malformed identity is a 400 before anything is injected", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = createSession(workingDir, { originChannel: "C1", originThreadTs: "1.0" }).sessionId;
	const transport = makeApiTransport();
	const base = startServer(19722, workingDir, transport);

	for (const extra of [
		{ userId: "../etc" },
		{ userId: ".." },
		{ userId: "a/b" },
		{ userId: "" },
		{ userId: 42 },
		{ userId: "x".repeat(129) },
		{ userId: "u1", role: 7 },
		{ userId: "u1", userName: "  " },
		{ role: "admin" },
	]) {
		const res = await postMessage(base, sessionId, { text: "hi", ...extra });
		assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(extra)}`);
	}
	assert.deepEqual(transport.injected, []);
});

test("parseSessionIdentity: accepts email-style ids as-is (no lossy sanitizing)", () => {
	assert.deepEqual(parseSessionIdentity({ userId: "ada+zara@example.com" }), {
		identity: { userId: "ada+zara@example.com", userName: undefined, role: undefined },
	});
	assert.deepEqual(parseSessionIdentity({}), {});
});

// ============================================================================
// Transport plumbing (Bridge stands in for all four transports)
// ============================================================================

test("BridgeTransport: identity lands in log.jsonl and on the turn's MessageContext", async () => {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-session-identity-test-"));
	let dispatched;
	const transport = new BridgeTransport({
		promptProfile: { fragments: [] },
		workingDir,
		dispatch: (event) => {
			dispatched = event;
		},
	});
	const identity = { userId: "u-42", userName: "Ada", role: "admin" };

	const pending = transport.injectSessionMessage("ident", "Ada", "hello", [], identity);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(resolveSessionRequest("ident", "reply"));
	await pending;

	const entry = JSON.parse(readFileSync(join(workingDir, "SESSION-ident", "log.jsonl"), "utf-8").trim());
	assert.equal(entry.userId, "u-42");
	assert.equal(entry.userName, "Ada");
	assert.equal(entry.role, "admin");

	const ctx = transport.createContext(dispatched, {});
	assert.deepEqual(ctx.message.identity, identity);
	assert.equal(ctx.message.userName, "Ada");
});

// ============================================================================
// Per-user memory layer
// ============================================================================

test("getMemory: layers the current user's MEMORY.md and PREFERENCES.md, and only theirs", () => {
	const workingDir = makeWorkingDir();
	const channelDir = join(workingDir, "SESSION-x");
	mkdirSync(channelDir, { recursive: true });
	writeFileSync(join(workingDir, "MEMORY.md"), "global fact");
	mkdirSync(join(workingDir, "users", "ada"), { recursive: true });
	writeFileSync(join(workingDir, "users", "ada", "MEMORY.md"), "ada likes tea");
	writeFileSync(join(workingDir, "users", "ada", "PREFERENCES.md"), "ada wants terse answers");
	mkdirSync(join(workingDir, "users", "bob"), { recursive: true });
	writeFileSync(join(workingDir, "users", "bob", "MEMORY.md"), "bob likes coffee");

	const ada = getMemory(channelDir, workingDir, "ada");
	assert.match(ada, /global fact/);
	assert.match(ada, /### User Memory \(ada\)\nada likes tea/);
	assert.match(ada, /### User Preferences \(ada\)\nada wants terse answers/);
	assert.doesNotMatch(ada, /bob/);

	const anonymous = getMemory(channelDir, workingDir);
	assert.doesNotMatch(anonymous, /ada|bob/);
});

test("buildDynamicContext: names the current user and their memory paths only when identified", () => {
	const withUser = buildDynamicContext("(mem)", null, "/ws", { userId: "u-42", userName: "Ada", role: "admin" });
	assert.match(withUser, /## Current User\n- id: u-42\n- name: Ada\n- role: admin/);
	assert.match(withUser, /\/ws\/users\/u-42\/MEMORY\.md/);
	assert.match(withUser, /\/ws\/users\/u-42\/PREFERENCES\.md/);

	assert.doesNotMatch(buildDynamicContext("(mem)", null, "/ws"), /Current User/);
});
