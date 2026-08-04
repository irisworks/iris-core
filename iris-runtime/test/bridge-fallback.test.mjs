// Bridge reply-loss backstop (issue #128). Before this, a sub-agent run could
// finish — or throw — without ever reaching postMessage/replaceMessage, and the
// blocked HTTP caller waited out the full bridge timeout and got a 504 with no
// reply, even though the agent had done the work. Two paths are covered here:
//
//   1. engine.handleEvent() resolves any still-pending BRIDGE- request after the
//      run, on both the success and the throw path.
//   2. BridgeTransport's accumulator — the fallback's reply source — keeps
//      agent.ts's `_→ tool label_` progress markers (respond(..., false)) out,
//      so the caller gets the answer rather than `_→ running bash_\n<answer>`.
//
// The real BridgeTransport is used rather than a stub context precisely so the
// marker filtering is exercised end to end.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridgeServer, hasPendingBridgeRequest, resolveBridgeRequest } from "../dist/engine/bridge.js";
import { createEngine } from "../dist/engine/index.js";
import { BridgeTransport } from "../dist/transports/bridge/bridge-transport.js";

function tempWorkspace() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-fallback-test-"));
	mkdirSync(join(workingDir, "events"), { recursive: true });
	return workingDir;
}

/**
 * The engine plus a real BridgeTransport, with the channel state pre-seeded so
 * `run` stands in for the agent runner. A run that only calls respond() — never
 * replaceMessage/postMessage — is exactly the shape that used to lose its reply.
 */
function makeEngineHarness(workingDir, run) {
	const engine = createEngine({ workingDir, sandbox: {}, provider: "test", model: "test" });
	const transport = new BridgeTransport({ promptProfile: { fragments: [] }, dispatch: () => {} });
	const seed = (channelId) => engine.channelStates.set(channelId, {
		running: false,
		stopRequested: false,
		store: {},
		runner: { run },
	});
	return { engine, transport, seed };
}

/**
 * POST /bridge and leave it in flight; returns once the server has registered
 * the pending request. Wrapped in an object deliberately — returning the promise
 * bare from an async function would chain it and wait out the whole request.
 */
async function inFlightRequest(port, requestId) {
	const promise = fetch(`http://127.0.0.1:${port}/bridge`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: "do the thing", user: "test", requestId }),
	}).then((r) => r.json());
	await new Promise((r) => setTimeout(r, 50));
	return { promise };
}

/** Run `body` against a bridge server + workspace, cleaning both up after. */
async function withBridge(port, body) {
	const workingDir = tempWorkspace();
	const server = startBridgeServer(port, workingDir);
	try {
		return await body(workingDir);
	} finally {
		server.close();
		rmSync(workingDir, { recursive: true, force: true });
	}
}

// ============================================================================
// engine.handleEvent() post-run fallback
// ============================================================================

test("engine: a run that never posts still resolves the pending bridge request from its output", async () => {
	await withBridge(19621, async (workingDir) => {
		const { promise: responsePromise } = await inFlightRequest(19621, "fallback1");
		assert.ok(hasPendingBridgeRequest("fallback1"), "request should be pending before the run");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async (ctx) => {
			await ctx.respond("_→ running bash_", false);
			await ctx.respond("the answer");
			return { stopReason: "end" };
		});
		seed("BRIDGE-fallback1");
		await engine.handleEvent({ channel: "BRIDGE-fallback1", user: "test", text: "do the thing", ts: "1", attachments: [] }, transport);

		const result = await responsePromise;
		assert.equal(result.text, "the answer", "progress markers excluded, real reply delivered");
		assert.ok(!hasPendingBridgeRequest("fallback1"));
	});
});

test("engine: a run that throws resolves the bridge request with the error, instead of hanging", async () => {
	await withBridge(19622, async (workingDir) => {
		const { promise: responsePromise } = await inFlightRequest(19622, "fallback2");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async () => {
			throw new Error("model exploded");
		});
		seed("BRIDGE-fallback2");
		await engine.handleEvent({ channel: "BRIDGE-fallback2", user: "test", text: "do the thing", ts: "1", attachments: [] }, transport);

		assert.match((await responsePromise).text, /run failed: model exploded/);
	});
});

test("engine: a silent run resolves with a placeholder rather than an empty reply", async () => {
	await withBridge(19623, async (workingDir) => {
		const { promise: responsePromise } = await inFlightRequest(19623, "fallback3");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async (ctx) => {
			await ctx.respond("_→ running bash_", false);
			return { stopReason: "end" };
		});
		seed("BRIDGE-fallback3");
		await engine.handleEvent({ channel: "BRIDGE-fallback3", user: "test", text: "x", ts: "1", attachments: [] }, transport);

		assert.equal((await responsePromise).text, "(no response)");
	});
});

test("engine: the fallback does not overwrite a reply the transport already delivered", async () => {
	await withBridge(19624, async (workingDir) => {
		const { promise: responsePromise } = await inFlightRequest(19624, "fallback4");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async (ctx) => {
			await ctx.respond("_→ running bash_", false);
			// Stand in for the transport's replaceMessage on the final answer.
			resolveBridgeRequest("fallback4", "the real reply");
			await ctx.respond("trailing chatter");
			return { stopReason: "end" };
		});
		seed("BRIDGE-fallback4");
		await engine.handleEvent({ channel: "BRIDGE-fallback4", user: "test", text: "x", ts: "1", attachments: [] }, transport);

		assert.equal((await responsePromise).text, "the real reply");
	});
});

// ============================================================================
// The accumulator must not treat emphasis in the answer as a progress marker.
// A line-shape heuristic (`/^_.*_$/`) silently ate whole answers like
// "_Moby Dick_ was written by _Melville_"; respond()'s shouldLog flag is the
// signal agent.ts actually emits.
// ============================================================================

test("engine: an answer whose every line is wrapped in emphasis survives the fallback", async () => {
	await withBridge(19625, async (workingDir) => {
		const { promise: responsePromise } = await inFlightRequest(19625, "fallback5");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async (ctx) => {
			await ctx.respond("_→ running bash_", false);
			await ctx.respond("_Moby Dick_ was written by _Melville_");
			return { stopReason: "end" };
		});
		seed("BRIDGE-fallback5");
		await engine.handleEvent({ channel: "BRIDGE-fallback5", user: "test", text: "x", ts: "1", attachments: [] }, transport);

		assert.equal((await responsePromise).text, "_Moby Dick_ was written by _Melville_");
	});
});

test("engine: tool errors and compaction notices are excluded, the answer is not", async () => {
	await withBridge(19626, async (workingDir) => {
		const { promise: responsePromise } = await inFlightRequest(19626, "fallback6");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async (ctx) => {
			await ctx.respond("_→ reading file_", false);
			await ctx.respond("_Error: exit code 1_", false);
			await ctx.respond("_Compacting context..._", false);
			await ctx.respond("240/6");
			return { stopReason: "end" };
		});
		seed("BRIDGE-fallback6");
		await engine.handleEvent({ channel: "BRIDGE-fallback6", user: "test", text: "x", ts: "1", attachments: [] }, transport);

		assert.equal((await responsePromise).text, "240/6");
	});
});
