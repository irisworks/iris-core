// BridgeTransport — headless transport for bridge-only sub-agents. Covers
// the fix for a real production bug: replaceMessage() (how the engine
// delivers a run's final answer) was a no-op here, so a bridge-only
// sub-agent's HTTP caller never got its response and timed out after 60s
// even though the agent had generated the reply successfully. postMessage()
// must resolve the same pending request for any code path that posts
// directly instead of going through replaceMessage.

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeTransport } from "../dist/transports/bridge/bridge-transport.js";
import { startBridgeServer } from "../dist/engine/bridge.js";

function makeTransport(workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-transport-test-"))) {
	return new BridgeTransport({
		promptProfile: { fragments: [] },
		workingDir,
		dispatch: () => {},
	});
}

test("BridgeTransport.replaceMessage resolves the pending /bridge HTTP request", async () => {
	const port = 19601;
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-transport-test-"));
	mkdirSync(join(workingDir, "events"));
	const server = startBridgeServer(port, workingDir);
	try {
		const responsePromise = fetch(`http://127.0.0.1:${port}/bridge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello", user: "test", requestId: "abc123" }),
		}).then((r) => r.json());

		// Give the server a moment to register the pending request before we
		// simulate the engine delivering the final answer.
		await new Promise((r) => setTimeout(r, 50));

		const transport = makeTransport();
		const ctx = transport.createContext({ channel: "BRIDGE-abc123", user: "test", text: "hello", ts: "1" }, {});
		await ctx.replaceMessage("hi back");

		const result = await responsePromise;
		assert.equal(result.text, "hi back");
	} finally {
		server.close();
	}
});

test("BridgeTransport.postMessage resolves the pending /bridge HTTP request too", async () => {
	const port = 19602;
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-transport-test-"));
	mkdirSync(join(workingDir, "events"));
	const server = startBridgeServer(port, workingDir);
	try {
		const responsePromise = fetch(`http://127.0.0.1:${port}/bridge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello", user: "test", requestId: "def456" }),
		}).then((r) => r.json());

		await new Promise((r) => setTimeout(r, 50));

		const transport = makeTransport();
		await transport.postMessage("BRIDGE-def456", "hi from postMessage");

		const result = await responsePromise;
		assert.equal(result.text, "hi from postMessage");
	} finally {
		server.close();
	}
});

test("BridgeTransport.replaceMessage on a non-BRIDGE channel is a no-op (SESSION-* accumulates instead)", async () => {
	const transport = makeTransport();
	const ctx = transport.createContext({ channel: "SESSION-xyz", user: "test", text: "hello", ts: "1" }, {});
	// Must not throw even though there's no pending bridge request for this channel.
	await assert.doesNotReject(() => ctx.replaceMessage("some text"));
});

// #217: SESSION- turns driven through the API must reach log.jsonl even on a
// bridge-only install (no Slack/Telegram transport to do the logging).
test("BridgeTransport.injectSessionMessage logs the user message to the session's log.jsonl", async () => {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-transport-test-"));
	const transport = makeTransport(workingDir);
	const { resolveSessionRequest } = await import("../dist/engine/sessions.js");

	const responsePromise = transport.injectSessionMessage("loguser", "tester", "hello session");
	// Let injectSessionMessage reach its awaited registerSessionRequest() first.
	await new Promise((resolve) => setTimeout(resolve, 20));
	// Simulate the engine resolving the run (dispatch is a stub here).
	assert.ok(resolveSessionRequest("loguser", "fake reply"));
	await responsePromise;

	const logPath = join(workingDir, "SESSION-loguser", "log.jsonl");
	assert.ok(existsSync(logPath), "expected SESSION-loguser/log.jsonl to exist");
	const entry = JSON.parse(readFileSync(logPath, "utf-8").trim());
	assert.equal(entry.user, "tester");
	assert.equal(entry.text, "hello session");
	assert.equal(entry.isBot, false);
	assert.ok(entry.date);
	assert.ok(entry.ts);
});

test("BridgeTransport.replaceMessage on a SESSION- channel logs one bot reply", async () => {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-transport-test-"));
	const transport = makeTransport(workingDir);
	const ctx = transport.createContext({ channel: "SESSION-botlog", user: "test", text: "hi", ts: "1" }, {});

	await ctx.respond("_→ running bash_", false); // progress marker — never logged
	await ctx.respond("streaming partial", true); // superseded by the final text
	await ctx.replaceMessage("final answer");

	const lines = readFileSync(join(workingDir, "SESSION-botlog", "log.jsonl"), "utf-8").trim().split("\n");
	assert.equal(lines.length, 1, "exactly one bot entry per turn");
	const entry = JSON.parse(lines[0]);
	assert.equal(entry.isBot, true);
	assert.equal(entry.user, "bot");
	assert.equal(entry.text, "final answer");
});

test("BridgeTransport.replaceMessage leaves BRIDGE- channels unlogged", async () => {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-transport-test-"));
	const transport = makeTransport(workingDir);
	const ctx = transport.createContext({ channel: "BRIDGE-nolog", user: "test", text: "hi", ts: "1" }, {});
	await ctx.replaceMessage("sub-agent reply");
	assert.ok(!existsSync(join(workingDir, "BRIDGE-nolog")), "BRIDGE- round-trips stay ephemeral");
});
