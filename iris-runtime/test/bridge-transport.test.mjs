// BridgeTransport — headless transport for bridge-only sub-agents. Covers
// the fix for a real production bug: replaceMessage() (how the engine
// delivers a run's final answer) was a no-op here, so a bridge-only
// sub-agent's HTTP caller never got its response and timed out after 60s
// even though the agent had generated the reply successfully. postMessage()
// must resolve the same pending request for any code path that posts
// directly instead of going through replaceMessage.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeTransport } from "../dist/transports/bridge/bridge-transport.js";
import { startBridgeServer } from "../dist/engine/bridge.js";

function makeTransport() {
	return new BridgeTransport({
		promptProfile: { fragments: [] },
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
