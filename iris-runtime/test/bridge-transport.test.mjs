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

// Issue #138: two enqueueEvent() calls on the same channel used to dispatch
// straight into the engine with no queue, so both runs executed concurrently
// against one ChannelState/context.jsonl. The per-channel queue must instead
// run them one at a time, in order.
test("BridgeTransport.enqueueEvent serializes concurrent requests on the same channel", async () => {
	const active = new Set();
	let maxConcurrent = 0;
	const order = [];
	const transport = new BridgeTransport({
		promptProfile: { fragments: [] },
		dispatch: async (event) => {
			active.add(event.text);
			maxConcurrent = Math.max(maxConcurrent, active.size);
			// Resolve out of enqueue order to prove the queue — not incidental
			// ordering — is what serializes the runs.
			await new Promise((r) => setTimeout(r, event.text === "first" ? 30 : 5));
			active.delete(event.text);
			order.push(event.text);
		},
	});

	transport.enqueueEvent({ channel: "BRIDGE-same", user: "test", text: "first", ts: "1" });
	transport.enqueueEvent({ channel: "BRIDGE-same", user: "test", text: "second", ts: "2" });

	await new Promise((r) => setTimeout(r, 100));

	assert.equal(maxConcurrent, 1, "two events on one channel must never run concurrently");
	assert.deepEqual(order, ["first", "second"]);
});

test("BridgeTransport.enqueueEvent runs different channels concurrently", async () => {
	const active = new Set();
	let maxConcurrent = 0;
	const transport = new BridgeTransport({
		promptProfile: { fragments: [] },
		dispatch: async (event) => {
			active.add(event.channel);
			maxConcurrent = Math.max(maxConcurrent, active.size);
			await new Promise((r) => setTimeout(r, 20));
			active.delete(event.channel);
		},
	});

	transport.enqueueEvent({ channel: "BRIDGE-a", user: "test", text: "x", ts: "1" });
	transport.enqueueEvent({ channel: "BRIDGE-b", user: "test", text: "y", ts: "2" });

	await new Promise((r) => setTimeout(r, 60));

	assert.equal(maxConcurrent, 2, "unrelated channels must not block each other");
});

// injectSessionMessage shares the SESSION-{id} channel queue with enqueueEvent,
// so it must honor the same 5-message cap. Checked *before* registerSessionRequest:
// a full queue must reject immediately (the API handler turns that into a 504)
// rather than register a promise that hangs until its 90s timeout.
test("BridgeTransport.injectSessionMessage rejects when the channel queue is full", async () => {
	let release;
	const gate = new Promise((r) => (release = r));
	const transport = new BridgeTransport({
		promptProfile: { fragments: [] },
		dispatch: () => gate, // never resolves until `release` — keeps 1 run active + N queued
	});

	// First event starts processing (shifted out of the queue), the next five fill
	// the queue to the cap; the seventh enqueueEvent is the overflow sentinel.
	for (let i = 0; i < 6; i++) {
		assert.equal(
			transport.enqueueEvent({ channel: "SESSION-full", user: "test", text: String(i), ts: String(i) }),
			true,
			`enqueue ${i} should be accepted`,
		);
	}
	assert.equal(transport.enqueueEvent({ channel: "SESSION-full", user: "test", text: "overflow", ts: "6" }), false);

	await assert.rejects(() => transport.injectSessionMessage("full", "test", "hello"), /queue full/);
	release();
});
