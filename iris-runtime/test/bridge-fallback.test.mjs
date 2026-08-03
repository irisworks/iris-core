// Bridge reply-loss backstops (issue #128). Before this, a sub-agent run could
// finish — or throw — without ever reaching postMessage/replaceMessage, and the
// blocked HTTP caller waited out the full bridge timeout and got a 504 with no
// reply, even though the agent had done the work. Three paths are covered here:
//
//   1. stripBridgeStatusLines() — the accumulated text of a bridge run is
//      polluted with agent.ts's `_→ tool label_` markers, so the fallback can't
//      use it raw.
//   2. engine.handleEvent() resolves any still-pending BRIDGE- request after the
//      run, on both the success and the throw path.
//   3. EventsWatcher fails a pending bridge request whose event file it drops as
//      stale, instead of deleting it silently (the accept-before-watch race).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridgeServer, stripBridgeStatusLines, hasPendingBridgeRequest } from "../dist/engine/bridge.js";
import { createEngine } from "../dist/engine/index.js";
import { createEventsWatcher } from "../dist/engine/events.js";

function tempWorkspace() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-fallback-test-"));
	mkdirSync(join(workingDir, "events"), { recursive: true });
	return workingDir;
}

/**
 * A minimal EngineTransport whose context accumulates respond() text and never
 * calls replaceMessage/postMessage — i.e. exactly the run shape that used to
 * lose its reply. `run` is the stub AgentRunner body.
 */
function makeEngineHarness(workingDir, run) {
	const engine = createEngine({
		workingDir,
		sandbox: {},
		provider: "test",
		model: "test",
	});
	const transport = {
		stopCommandHint: "say `stop` first",
		postMessage: async () => "1",
		updateMessage: async () => {},
		createContext: (event) => {
			let accumulated = "";
			return {
				transportId: "bridge",
				message: { text: event.text, rawText: event.text, user: event.user, channel: event.channel, ts: event.ts, attachments: [] },
				channels: [],
				users: [],
				respond: async (text) => { accumulated = accumulated ? `${accumulated}\n${text}` : text; },
				replaceMessage: async () => {},
				respondInThread: async () => {},
				setTyping: async () => {},
				uploadFile: async () => {},
				setWorking: async () => {},
				deleteMessage: async () => {},
				getAccumulatedText: () => accumulated,
			};
		},
	};
	// Pre-seed the channel state so the engine doesn't build a real agent runner.
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

// ============================================================================
// stripBridgeStatusLines()
// ============================================================================

test("stripBridgeStatusLines: drops agent.ts's _→ label_ progress markers, keeps the answer", () => {
	const accumulated = "_→ running bash_\n_→ reading file_\nThe score is 240/6.";
	assert.equal(stripBridgeStatusLines(accumulated), "The score is 240/6.");
});

test("stripBridgeStatusLines: keeps inline italics and only strips whole marker lines", () => {
	assert.equal(stripBridgeStatusLines("the _score_ is 240/6"), "the _score_ is 240/6");
});

test("stripBridgeStatusLines: an all-markers run strips to empty, so the caller can substitute", () => {
	assert.equal(stripBridgeStatusLines("_→ running bash_\n_Compacting…_"), "");
});

// ============================================================================
// engine.handleEvent() post-run fallback
// ============================================================================

test("engine: a run that never posts still resolves the pending bridge request from its output", async () => {
	const port = 19621;
	const workingDir = tempWorkspace();
	const server = startBridgeServer(port, workingDir);
	try {
		const { promise: responsePromise } = await inFlightRequest(port, "fallback1");
		assert.ok(hasPendingBridgeRequest("fallback1"), "request should be pending before the run");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async (ctx) => {
			await ctx.respond("_→ running bash_");
			await ctx.respond("the answer");
			return { stopReason: "end" };
		});
		seed("BRIDGE-fallback1");
		await engine.handleEvent({ channel: "BRIDGE-fallback1", user: "test", text: "do the thing", ts: "1", attachments: [] }, transport);

		const result = await responsePromise;
		assert.equal(result.text, "the answer", "status markers stripped, real reply delivered");
		assert.ok(!hasPendingBridgeRequest("fallback1"));
	} finally {
		server.close();
	}
});

test("engine: a run that throws resolves the bridge request with the error, instead of hanging", async () => {
	const port = 19622;
	const workingDir = tempWorkspace();
	const server = startBridgeServer(port, workingDir);
	try {
		const { promise: responsePromise } = await inFlightRequest(port, "fallback2");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async () => {
			throw new Error("model exploded");
		});
		seed("BRIDGE-fallback2");
		await engine.handleEvent({ channel: "BRIDGE-fallback2", user: "test", text: "do the thing", ts: "1", attachments: [] }, transport);

		const result = await responsePromise;
		assert.match(result.text, /run failed: model exploded/);
	} finally {
		server.close();
	}
});

test("engine: a silent run resolves with a placeholder rather than an empty reply", async () => {
	const port = 19623;
	const workingDir = tempWorkspace();
	const server = startBridgeServer(port, workingDir);
	try {
		const { promise: responsePromise } = await inFlightRequest(port, "fallback3");

		const { engine, transport, seed } = makeEngineHarness(workingDir, async (ctx) => {
			await ctx.respond("_→ running bash_");
			return { stopReason: "end" };
		});
		seed("BRIDGE-fallback3");
		await engine.handleEvent({ channel: "BRIDGE-fallback3", user: "test", text: "x", ts: "1", attachments: [] }, transport);

		assert.equal((await responsePromise).text, "(no response)");
	} finally {
		server.close();
	}
});

test("engine: the fallback does not overwrite a reply the transport already delivered", async () => {
	const port = 19624;
	const workingDir = tempWorkspace();
	const server = startBridgeServer(port, workingDir);
	try {
		const { promise: responsePromise } = await inFlightRequest(port, "fallback4");

		const { resolveBridgeRequest } = await import("../dist/engine/bridge.js");
		const { engine, transport, seed } = makeEngineHarness(workingDir, async (ctx) => {
			await ctx.respond("_→ running bash_");
			// Stand in for the transport's replaceMessage on the final answer.
			resolveBridgeRequest("fallback4", "the real reply");
			await ctx.respond("trailing chatter");
			return { stopReason: "end" };
		});
		seed("BRIDGE-fallback4");
		await engine.handleEvent({ channel: "BRIDGE-fallback4", user: "test", text: "x", ts: "1", attachments: [] }, transport);

		assert.equal((await responsePromise).text, "the real reply");
	} finally {
		server.close();
	}
});

// ============================================================================
// EventsWatcher stale-drop handling
// ============================================================================

test("events: an immediate event written just before startup runs instead of being dropped as stale", async () => {
	const workingDir = tempWorkspace();
	const eventsDir = join(workingDir, "events");
	const file = join(eventsDir, "bridge-1-grace.json");
	writeFileSync(file, JSON.stringify({ type: "immediate", channelId: "BRIDGE-grace", user: "iris", text: "hi" }));
	// 5s before now — a restart racing a live request, not a stale replay.
	const fiveSecondsAgo = new Date(Date.now() - 5_000);
	utimesSync(file, fiveSecondsAgo, fiveSecondsAgo);

	const enqueued = [];
	const watcher = createEventsWatcher(workingDir, { enqueueEvent: (e) => { enqueued.push(e); return true; } });
	try {
		watcher.start();
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(enqueued.length, 1, "event within the grace window must execute");
		assert.equal(enqueued[0].channel, "BRIDGE-grace");
	} finally {
		watcher.stop();
	}
});

test("events: a genuinely stale bridge event is deleted AND fails its pending request immediately", async () => {
	const port = 19625;
	const workingDir = tempWorkspace();
	const server = startBridgeServer(port, workingDir);
	const eventsDir = join(workingDir, "events");
	try {
		// A caller blocked on a request whose event file is about to be dropped.
		const responsePromise = fetch(`http://127.0.0.1:${port}/bridge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hi", user: "test", requestId: "stale1" }),
		});
		await new Promise((r) => setTimeout(r, 50));

		// Drop the fresh event file the bridge server just wrote, and stand in a
		// stale one — simulating the same request having been accepted before a
		// restart that reset the watcher's start time.
		for (const f of readdirSync(eventsDir)) unlinkSync(join(eventsDir, f));
		const file = join(eventsDir, "bridge-1-stale1.json");
		writeFileSync(file, JSON.stringify({ type: "immediate", channelId: "BRIDGE-stale1", user: "iris", text: "hi" }));
		const tenMinutesAgo = new Date(Date.now() - 600_000);
		utimesSync(file, tenMinutesAgo, tenMinutesAgo);

		const enqueued = [];
		const watcher = createEventsWatcher(workingDir, { enqueueEvent: (e) => { enqueued.push(e); return true; } });
		try {
			watcher.start();
			await new Promise((r) => setTimeout(r, 150));
			assert.equal(enqueued.length, 0, "a truly stale event must not run");
			assert.ok(!existsSync(file), "stale file is deleted");

			const response = await responsePromise;
			assert.equal(response.status, 504, "caller fails immediately, not after the bridge timeout");
			assert.ok(!hasPendingBridgeRequest("stale1"));
		} finally {
			watcher.stop();
		}
	} finally {
		server.close();
	}
});
