// The NDJSON bridge protocol (issue #128). A sub-agent's reply used to be a
// single blocking JSON response bounded by a hard 60s timeout, which dropped the
// reply of any longer run and carried no progress. `Accept: application/x-ndjson`
// now gets a chunked stream: headers and an `accepted` line immediately, `status`
// lines as the agent works, heartbeats while it's quiet, and exactly one terminal
// `final` or `error` line. Requests without that header keep the old single-JSON
// response byte-for-byte, which is what Iris's own `curl … | jq -r '.text'`
// recipe and any older sub-agent depend on.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	startBridgeServer,
	resolveBridgeRequest,
	publishBridgeStatus,
	failBridgeRequest,
	hasPendingBridgeRequest,
	callAgentBridge,
	throttleStatus,
} from "../dist/engine/bridge.js";

const NDJSON = "application/x-ndjson";

function tempWorkspace() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-stream-test-"));
	mkdirSync(join(workingDir, "events"), { recursive: true });
	return workingDir;
}

/**
 * Start a real bridge server with the given timer env applied for its lifetime.
 * The env vars are read inside startBridgeServer, so they must be set first.
 */
function withBridgeServer(port, env = {}) {
	const saved = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = String(v);
	}
	const workingDir = tempWorkspace();
	const server = startBridgeServer(port, workingDir);
	return {
		workingDir,
		close: () => {
			server.close();
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		},
	};
}

/** POST /bridge asking for the stream, and read it line by line. */
async function openStream(port, requestId, { signal } = {}) {
	const response = await fetch(`http://127.0.0.1:${port}/bridge`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: NDJSON },
		body: JSON.stringify({ text: "do the thing", user: "test", requestId }),
		signal,
	});
	const lines = (async function* () {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of response.body) {
			buffer += decoder.decode(chunk, { stream: true });
			const parts = buffer.split("\n");
			buffer = parts.pop() ?? "";
			for (const part of parts) if (part.trim()) yield JSON.parse(part);
		}
	})();
	return { response, lines };
}

/** Collect every line of a stream into an array. */
async function drain(lines) {
	const out = [];
	for await (const line of lines) out.push(line);
	return out;
}

// ============================================================================
// Streaming shape
// ============================================================================

test("stream: headers and the accepted line arrive before the agent has replied", async () => {
	const port = 19631;
	const bridge = withBridgeServer(port);
	try {
		const started = Date.now();
		const { response, lines } = await openStream(port, "s-accept");
		const elapsed = Date.now() - started;

		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
		assert.ok(elapsed < 500, `time to headers should not scale with the run, took ${elapsed}ms`);

		const first = (await lines.next()).value;
		assert.equal(first.type, "accepted");
		assert.equal(first.requestId, "s-accept");
		assert.equal(first.protocol, 1);

		resolveBridgeRequest("s-accept", "done");
		await drain(lines);
	} finally {
		bridge.close();
	}
});

test("stream: status lines arrive in order, then exactly one final line closes it", async () => {
	const port = 19632;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 0 });
	try {
		const { lines } = await openStream(port, "s-status");
		const collected = drain(lines);

		await new Promise((r) => setTimeout(r, 30));
		publishBridgeStatus("s-status", "running bash");
		publishBridgeStatus("s-status", "reading file");
		publishBridgeStatus("s-status", "writing file");
		resolveBridgeRequest("s-status", "the answer");

		const all = await collected;
		assert.deepEqual(all.map((l) => l.type), ["accepted", "status", "status", "status", "final"]);
		assert.deepEqual(all.filter((l) => l.type === "status").map((l) => l.text),
			["running bash", "reading file", "writing file"]);
		assert.equal(all.at(-1).text, "the answer");
	} finally {
		bridge.close();
	}
});

test("stream: a status line containing newlines and braces stays exactly one line", async () => {
	const port = 19633;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 0 });
	try {
		const { lines } = await openStream(port, "s-escape");
		const collected = drain(lines);

		await new Promise((r) => setTimeout(r, 30));
		publishBridgeStatus("s-escape", 'running {"a": 1}\nsecond line\n');
		resolveBridgeRequest("s-escape", "ok");

		const all = await collected;
		const statuses = all.filter((l) => l.type === "status");
		assert.equal(statuses.length, 1, "must not split into two lines");
		assert.equal(statuses[0].text, 'running {"a": 1}\nsecond line\n');
	} finally {
		bridge.close();
	}
});

test("stream: a long status line is truncated rather than streamed whole", async () => {
	const port = 19634;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 0 });
	try {
		const { lines } = await openStream(port, "s-trunc");
		const collected = drain(lines);

		await new Promise((r) => setTimeout(r, 30));
		publishBridgeStatus("s-trunc", "x".repeat(1000));
		resolveBridgeRequest("s-trunc", "ok");

		const all = await collected;
		assert.equal(all.find((l) => l.type === "status").text.length, 200);
	} finally {
		bridge.close();
	}
});

test("stream: heartbeats keep flowing while the agent is quiet, without extending its idle deadline", async () => {
	const port = 19635;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 40, IRIS_BRIDGE_IDLE_TIMEOUT_MS: 300 });
	try {
		const { lines } = await openStream(port, "s-heart");
		const all = await drain(lines);

		const heartbeats = all.filter((l) => l.type === "heartbeat");
		assert.ok(heartbeats.length >= 2, `expected repeated heartbeats, got ${heartbeats.length}`);
		// Heartbeats must not be mistaken for agent progress: the idle deadline
		// still fires, or a wedged agent would hold the request forever.
		assert.equal(all.at(-1).type, "error");
		assert.equal(all.at(-1).code, "idle_timeout");
	} finally {
		bridge.close();
	}
});

test("stream: agent progress does reset the idle deadline", async () => {
	const port = 19636;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 0, IRIS_BRIDGE_IDLE_TIMEOUT_MS: 200 });
	try {
		const { lines } = await openStream(port, "s-idle-reset");
		const collected = drain(lines);

		// Six statuses at 100ms each: comfortably past the 200ms idle deadline.
		for (let i = 0; i < 6; i++) {
			await new Promise((r) => setTimeout(r, 100));
			assert.ok(hasPendingBridgeRequest("s-idle-reset"), `request died after ${i} statuses`);
			publishBridgeStatus("s-idle-reset", `step ${i}`);
		}
		resolveBridgeRequest("s-idle-reset", "survived");

		const all = await collected;
		assert.equal(all.at(-1).type, "final");
		assert.equal(all.at(-1).text, "survived");
	} finally {
		bridge.close();
	}
});

test("stream: the hard cap fires even while the agent is making progress", async () => {
	const port = 19637;
	const bridge = withBridgeServer(port, {
		IRIS_BRIDGE_HEARTBEAT_MS: 0,
		IRIS_BRIDGE_IDLE_TIMEOUT_MS: 5_000,
		IRIS_BRIDGE_MAX_MS: 250,
	});
	try {
		const { lines } = await openStream(port, "s-max");
		const collected = drain(lines);
		const ticker = setInterval(() => publishBridgeStatus("s-max", "still working"), 50);

		const all = await collected;
		clearInterval(ticker);
		assert.equal(all.at(-1).type, "error");
		assert.equal(all.at(-1).code, "max_duration");
	} finally {
		bridge.close();
	}
});

test("stream: re-POSTing a requestId already in flight supersedes the older one", async () => {
	const port = 19638;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 0 });
	try {
		const first = await openStream(port, "s-dup");
		const firstLines = drain(first.lines);
		await new Promise((r) => setTimeout(r, 30));

		const second = await openStream(port, "s-dup");
		const secondLines = drain(second.lines);
		await new Promise((r) => setTimeout(r, 30));
		resolveBridgeRequest("s-dup", "answered the newer one");

		const firstAll = await firstLines;
		assert.equal(firstAll.at(-1).type, "error");
		assert.equal(firstAll.at(-1).code, "superseded");

		const secondAll = await secondLines;
		assert.equal(secondAll.at(-1).type, "final");
		assert.equal(secondAll.at(-1).text, "answered the newer one");
	} finally {
		bridge.close();
	}
});

test("stream: a caller that hangs up drops its pending request instead of leaking timers", async () => {
	const port = 19639;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 0 });
	try {
		const controller = new AbortController();
		const { lines } = await openStream(port, "s-gone", { signal: controller.signal });
		await lines.next();
		assert.ok(hasPendingBridgeRequest("s-gone"));

		controller.abort();
		await new Promise((r) => setTimeout(r, 100));

		assert.ok(!hasPendingBridgeRequest("s-gone"), "disconnect must unregister the request");
		// A late reply is a no-op rather than a crash.
		assert.equal(resolveBridgeRequest("s-gone", "too late"), false);
	} finally {
		bridge.close();
	}
});

// ============================================================================
// Legacy (single-JSON) compatibility
// ============================================================================

test("legacy: without the Accept header the response is the original single JSON body", async () => {
	const port = 19640;
	const bridge = withBridgeServer(port);
	try {
		const promise = fetch(`http://127.0.0.1:${port}/bridge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hi", user: "test", requestId: "l-plain" }),
		});
		await new Promise((r) => setTimeout(r, 50));
		resolveBridgeRequest("l-plain", "plain reply");

		const response = await promise;
		assert.match(response.headers.get("content-type"), /application\/json/);
		assert.deepEqual(await response.json(), { text: "plain reply", requestId: "l-plain" });
	} finally {
		bridge.close();
	}
});

test("legacy: a failure is still a 504 with the original opaque body", async () => {
	const port = 19641;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_IDLE_TIMEOUT_MS: 150 });
	try {
		const response = await fetch(`http://127.0.0.1:${port}/bridge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hi", user: "test", requestId: "l-fail" }),
		});
		assert.equal(response.status, 504);
		assert.deepEqual(await response.json(), { error: "Bridge request failed." });
	} finally {
		bridge.close();
	}
});

test("legacy: a status published for a non-streaming caller keeps it alive without leaking progress", async () => {
	const port = 19642;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_IDLE_TIMEOUT_MS: 200 });
	try {
		const promise = fetch(`http://127.0.0.1:${port}/bridge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hi", user: "test", requestId: "l-alive" }),
		});
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setTimeout(r, 100));
			publishBridgeStatus("l-alive", `step ${i}`);
		}
		resolveBridgeRequest("l-alive", "took a while");

		const response = await promise;
		assert.equal(response.status, 200, "progress must hold the idle deadline off");
		assert.deepEqual(await response.json(), { text: "took a while", requestId: "l-alive" });
	} finally {
		bridge.close();
	}
});

// ============================================================================
// callAgentBridge() as a stream client
// ============================================================================

/** A stub sub-agent that writes whatever NDJSON lines it's given. */
function stubStreamServer(port, lines, { contentType = NDJSON } = {}) {
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", async () => {
			res.writeHead(200, { "Content-Type": contentType });
			for (const line of lines) {
				if (typeof line === "number") {
					await new Promise((r) => setTimeout(r, line));
					continue;
				}
				res.write(typeof line === "string" ? line : `${JSON.stringify(line)}\n`);
			}
			res.end();
		});
	});
	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

test("client: forwards status lines via onStatus and returns the final text", async () => {
	const port = 19651;
	const server = await stubStreamServer(port, [
		{ type: "accepted", requestId: "x", protocol: 1 },
		{ type: "status", text: "running bash" },
		{ type: "heartbeat" },
		{ type: "status", text: "reading file" },
		{ type: "final", text: "the answer", requestId: "x" },
	]);
	try {
		const seen = [];
		const reply = await callAgentBridge(`http://127.0.0.1:${port}`, "hi", "u1", {
			conversationKey: "k1",
			onStatus: (s) => seen.push(s),
		});
		assert.equal(reply, "the answer");
		assert.deepEqual(seen, ["running bash", "reading file"]);
	} finally {
		server.close();
	}
});

test("client: an error line becomes a thrown error carrying its code", async () => {
	const port = 19652;
	const server = await stubStreamServer(port, [
		{ type: "accepted", requestId: "x", protocol: 1 },
		{ type: "error", error: "no progress for 180s", code: "idle_timeout", requestId: "x" },
	]);
	try {
		await assert.rejects(
			() => callAgentBridge(`http://127.0.0.1:${port}`, "hi", "u1", { conversationKey: "k" }),
			/idle_timeout.*no progress/,
		);
	} finally {
		server.close();
	}
});

test("client: a stream that ends with no final line throws instead of reporting no response", async () => {
	const port = 19653;
	const server = await stubStreamServer(port, [
		{ type: "accepted", requestId: "x", protocol: 1 },
		{ type: "status", text: "working" },
	]);
	try {
		await assert.rejects(
			() => callAgentBridge(`http://127.0.0.1:${port}`, "hi", "u1", { conversationKey: "k" }),
			/ended without a final reply/,
		);
	} finally {
		server.close();
	}
});

test("client: unknown line types and one unparseable line don't sink a healthy reply", async () => {
	const port = 19654;
	const server = await stubStreamServer(port, [
		{ type: "accepted", requestId: "x", protocol: 1 },
		{ type: "something-from-the-future", detail: "ignore me" },
		"{ not json at all\n",
		{ type: "final", text: "still fine", requestId: "x" },
	]);
	try {
		const reply = await callAgentBridge(`http://127.0.0.1:${port}`, "hi", "u1", { conversationKey: "k" });
		assert.equal(reply, "still fine");
	} finally {
		server.close();
	}
});

test("client: a sub-agent on an older runtime answers with plain JSON and still works", async () => {
	const port = 19655;
	// Ignores the Accept header entirely, exactly like the pre-#128 server.
	const server = await stubStreamServer(port, [JSON.stringify({ text: "old style" })], {
		contentType: "application/json",
	});
	try {
		const reply = await callAgentBridge(`http://127.0.0.1:${port}`, "hi", "u1", { conversationKey: "k" });
		assert.equal(reply, "old style");
	} finally {
		server.close();
	}
});

test("client: the historic (url, text, user, timeoutMs, conversationKey) signature still works", async () => {
	const port = 19656;
	const seen = [];
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")).requestId);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ text: "positional ok" }));
		});
	});
	await new Promise((r) => server.listen(port, "127.0.0.1", r));
	try {
		const reply = await callAgentBridge(`http://127.0.0.1:${port}`, "hi", "u1", 30_000, "slack-C1-1.0");
		assert.equal(reply, "positional ok");
		assert.equal(seen[0], "slack-C1-1-0", "the 5th positional argument is still the conversation key (dots sanitized)");
	} finally {
		server.close();
	}
});

test("client: stream:false opts out of the streaming request entirely", async () => {
	const port = 19657;
	let sawAccept;
	const server = createServer((req, res) => {
		sawAccept = req.headers.accept;
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ text: "no stream" }));
		});
	});
	await new Promise((r) => server.listen(port, "127.0.0.1", r));
	try {
		const reply = await callAgentBridge(`http://127.0.0.1:${port}`, "hi", "u1", { stream: false });
		assert.equal(reply, "no stream");
		assert.ok(!(sawAccept ?? "").includes(NDJSON));
	} finally {
		server.close();
	}
});

// ============================================================================
// End-to-end: a run that outlives the old 60s ceiling
// ============================================================================

test("end-to-end: a reply that arrives long after the old 60s cap still reaches the caller", async () => {
	const port = 19661;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 100, IRIS_BRIDGE_IDLE_TIMEOUT_MS: 5_000 });
	try {
		const statuses = [];
		const replyPromise = callAgentBridge(`http://127.0.0.1:${port}`, "slow task", "test", {
			conversationKey: "e2e-slow",
			onStatus: (s) => statuses.push(s),
		});
		await new Promise((r) => setTimeout(r, 100));
		for (let i = 0; i < 3; i++) {
			await new Promise((r) => setTimeout(r, 300));
			publishBridgeStatus("e2e-slow", `step ${i}`);
		}
		resolveBridgeRequest("e2e-slow", "finished eventually");

		assert.equal(await replyPromise, "finished eventually");
		assert.deepEqual(statuses, ["step 0", "step 1", "step 2"]);
	} finally {
		bridge.close();
	}
});

// The real proof of the headline fix, and the reason streaming was needed at all:
// Node's fetch caps time-to-headers at ~300s, so the old blocking shape could not
// be made to work past that no matter how the timeouts were configured. Slow by
// construction (~5.5 min), so it's opt-in.
test("end-to-end: streaming survives past undici's ~300s headers timeout, blocking does not", {
	skip: process.env.IRIS_SLOW_TESTS ? false : "set IRIS_SLOW_TESTS=1 to run (~5.5 min)",
}, async () => {
	const port = 19662;
	const bridge = withBridgeServer(port, {
		IRIS_BRIDGE_HEARTBEAT_MS: 10_000,
		IRIS_BRIDGE_IDLE_TIMEOUT_MS: 400_000,
		IRIS_BRIDGE_MAX_MS: 400_000,
		IRIS_BRIDGE_LEGACY_TIMEOUT_MS: 400_000,
	});
	const REPLY_AFTER_MS = 330_000;
	try {
		const streamed = callAgentBridge(`http://127.0.0.1:${port}`, "very slow", "test", {
			conversationKey: "slow-stream",
			timeoutMs: 400_000,
		});
		const blocking = callAgentBridge(`http://127.0.0.1:${port}`, "very slow", "test", {
			conversationKey: "slow-blocking",
			timeoutMs: 400_000,
			stream: false,
		}).then(() => "resolved", (err) => `rejected: ${err.message}`);

		await new Promise((r) => setTimeout(r, REPLY_AFTER_MS));
		resolveBridgeRequest("slow-stream", "streamed reply");
		resolveBridgeRequest("slow-blocking", "blocking reply");

		assert.equal(await streamed, "streamed reply", "streaming must survive past 300s");
		assert.match(await blocking, /^rejected/, "the blocking shape is expected to die at ~300s");
	} finally {
		bridge.close();
	}
});

// ============================================================================
// throttleStatus()
// ============================================================================

test("throttleStatus: emits the first line immediately and coalesces a burst into one trailing update", async () => {
	const seen = [];
	const push = throttleStatus((t) => seen.push(t), 60);
	push("one");
	push("two");
	push("three");
	assert.deepEqual(seen, ["one"], "the burst must not become three chat edits");
	await new Promise((r) => setTimeout(r, 120));
	assert.deepEqual(seen, ["one", "three"], "only the newest line of the burst is sent");
});

test("throttleStatus: drops a repeat of the text already showing", async () => {
	const seen = [];
	const push = throttleStatus((t) => seen.push(t), 20);
	push("same");
	await new Promise((r) => setTimeout(r, 40));
	push("same");
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(seen, ["same"]);
});

// ============================================================================
// Engine wiring: setStatus on a BRIDGE- channel reaches the waiting caller
// ============================================================================

test("engine: ctx.setStatus on a BRIDGE- channel is forwarded to the pending request", async () => {
	const { createEngine } = await import("../dist/engine/index.js");
	const port = 19671;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 0 });
	try {
		const { lines } = await openStream(port, "eng-status");
		const collected = drain(lines);
		await new Promise((r) => setTimeout(r, 30));

		const engine = createEngine({ workingDir: bridge.workingDir, sandbox: {}, provider: "t", model: "t" });
		const transport = {
			stopCommandHint: "stop",
			postMessage: async () => "1",
			updateMessage: async () => {},
			createContext: () => ({
				transportId: "bridge",
				message: { text: "x", rawText: "x", user: "u", channel: "BRIDGE-eng-status", ts: "1", attachments: [] },
				channels: [], users: [],
				respond: async () => {},
				replaceMessage: async () => {},
				respondInThread: async () => {},
				setTyping: async () => {},
				uploadFile: async () => {},
				setWorking: async () => {},
				deleteMessage: async () => {},
				getAccumulatedText: () => "",
			}),
		};
		engine.channelStates.set("BRIDGE-eng-status", {
			running: false,
			stopRequested: false,
			store: {},
			runner: {
				run: async (ctx) => {
					// agent.ts fires exactly this per tool call, markers included.
					await ctx.setStatus("_→ running bash..._");
					resolveBridgeRequest("eng-status", "done");
					return { stopReason: "end" };
				},
			},
		});
		await engine.handleEvent(
			{ channel: "BRIDGE-eng-status", user: "u", text: "x", ts: "1", attachments: [] },
			transport,
		);

		const all = await collected;
		const status = all.find((l) => l.type === "status");
		assert.ok(status, "setStatus must reach the stream");
		assert.equal(status.text, "→ running bash...", "the _italic_ markers are stripped on the way out");
	} finally {
		bridge.close();
	}
});

test("failBridgeRequest: an unknown requestId is a no-op, not a throw", () => {
	assert.equal(failBridgeRequest("nobody-home", "whatever"), false);
});
