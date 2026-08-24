// Durable bridge job logs (issue #137). The open HTTP connection used to be the
// only job handle: if it dropped mid-run, or the sub-agent restarted
// mid-request, the reply was lost even though the work finished. Every
// status/final/error event is now appended to
// `{workingDir}/bridge-jobs/{requestId}.jsonl` with a monotonic `seq`, served
// back by `GET /bridge/jobs/{requestId}?since={seq}` — and callAgentBridge()
// recovers from a broken stream by polling that log instead of failing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	startBridgeServer,
	resolveBridgeRequest,
	publishBridgeStatus,
	failBridgeRequest,
	sweepBridgeJobLogs,
	callAgentBridge,
} from "../dist/engine/bridge.js";

const NDJSON = "application/x-ndjson";

function tempWorkspace() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-bridge-jobs-test-"));
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
			server.closeAllConnections?.();
			for (const [k, v] of Object.entries(saved)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		},
	};
}

/**
 * POST /bridge asking for the stream. Returns the `accepted` line plus a
 * pull-based line reader. `finish()` must always be called: it aborts the
 * request and gives the reader a bounded moment to settle — aborting a fetch
 * whose body just finished delivering doesn't reliably settle a pending read,
 * so nothing here may block on the stream indefinitely.
 */
async function openStream(port, requestId) {
	const controller = new AbortController();
	const response = await fetch(`http://127.0.0.1:${port}/bridge`, {
		method: "POST",
		signal: controller.signal,
		headers: { "Content-Type": "application/json", Accept: NDJSON },
		body: JSON.stringify({ text: "do the thing", user: "test", requestId }),
	});

	const queue = [];
	let closed = false;
	let readError;
	let wake;
	(async () => {
		try {
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body) {
				buffer += decoder.decode(chunk, { stream: true });
				const parts = buffer.split("\n");
				buffer = parts.pop() ?? "";
				for (const part of parts) {
					if (!part.trim()) continue;
					queue.push(JSON.parse(part));
					if (wake) { const w = wake; wake = undefined; w(); }
				}
			}
		} catch (err) {
			readError = err;
		}
		closed = true;
		if (wake) { const w = wake; wake = undefined; w(); }
	})();

	async function nextLine() {
		while (!queue.length && !closed) {
			await new Promise((r) => { wake = r; });
		}
		if (!queue.length && readError) throw readError;
		return queue.length ? { value: queue.shift(), done: false } : { done: true };
	}

	async function openLine(label) {
		const line = await nextLine();
		assert.ok(line.value, `${label}: expected a line${readError ? ` (reader error: ${readError.message})` : ""}`);
		return line.value;
	}

	const accepted = await openLine("accepted");
	assert.equal(accepted.type, "accepted");

	async function finish() {
		// Give the server a moment to end the stream (it closes up right after
		// writing the terminal event). If it's still open we're mid-run — drop
		// the socket for real, like a caller hanging up. Aborting an already-
		// finished fetch surfaces an unhandled rejection, hence the branch.
		const state = await Promise.race([
			nextLine().then(() => "ended"),
			new Promise((r) => setTimeout(() => r("open"), 250)),
		]);
		if (state === "open") {
			controller.abort();
			await Promise.race([nextLine(), new Promise((r) => setTimeout(r, 250))]);
		}
		readError = undefined;
	}

	return { nextLine: openLine, finish };
}

/** Read the durable job log for a requestId as parsed lines. */
function readJobLog(workingDir, requestId) {
	const raw = readFileSync(join(workingDir, "bridge-jobs", `${requestId}.jsonl`), "utf-8");
	return raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

async function getJob(port, requestId, since) {
	const suffix = since === undefined ? "" : `?since=${since}`;
	const res = await fetch(`http://127.0.0.1:${port}/bridge/jobs/${encodeURIComponent(requestId)}${suffix}`);
	return { status: res.status, body: await res.json().catch(() => null) };
}

// ============================================================================
// Server side: persistence + GET /bridge/jobs
// ============================================================================

test("job log: status/final events persist with monotonic seq matching the wire", { timeout: 10_000 }, async () => {
	const port = 19701;
	const bridge = withBridgeServer(port, { IRIS_BRIDGE_HEARTBEAT_MS: 0 });
	try {
		const { nextLine, finish } = await openStream(port, "persist-1");

		publishBridgeStatus("persist-1", "step one");
		publishBridgeStatus("persist-1", "step two");
		const s1 = await nextLine();
		const s2 = await nextLine();
		assert.equal(s1.type, "status");
		assert.equal(s2.seq, s1.seq + 1);

		resolveBridgeRequest("persist-1", "the answer");
		const fin = await nextLine();
		assert.equal(fin.type, "final");
		assert.equal(fin.seq, s2.seq + 1);

		const logged = readJobLog(bridge.workingDir, "persist-1");
		assert.deepEqual(logged.map((l) => l.seq), [s1.seq, s2.seq, fin.seq]);
		assert.equal(logged[2].type, "final");
		assert.equal(logged[2].text, "the answer");

		await finish();
	} finally {
		bridge.close();
	}
});

test("GET /bridge/jobs/:id returns events after since plus a done flag", { timeout: 10_000 }, async () => {
	const port = 19702;
	const bridge = withBridgeServer(port);
	try {
		const { finish } = await openStream(port, "poll-1");

		publishBridgeStatus("poll-1", "step one");
		publishBridgeStatus("poll-1", "step two");

		let polled = await getJob(port, "poll-1", 1);
		assert.equal(polled.status, 200);
		assert.deepEqual(polled.body.events.map((e) => e.text), ["step two"]);
		assert.equal(polled.body.done, false);

		resolveBridgeRequest("poll-1", "done replying");
		polled = await getJob(port, "poll-1", 0);
		assert.equal(polled.body.done, true);
		assert.equal(polled.body.events.at(-1).type, "final");

		// since past everything ⇒ empty events, but still done.
		polled = await getJob(port, "poll-1", 99);
		assert.deepEqual(polled.body.events, []);
		assert.equal(polled.body.done, true);

		await finish();
	} finally {
		bridge.close();
	}
});

test("GET /bridge/jobs/:id 404s an unknown job and tolerates a bad since", { timeout: 10_000 }, async () => {
	const port = 19703;
	const bridge = withBridgeServer(port);
	try {
		const missing = await getJob(port, "no-such-job");
		assert.equal(missing.status, 404);

		const { finish } = await openStream(port, "bad-since");
		publishBridgeStatus("bad-since", "step one");
		const polled = await getJob(port, "bad-since", "not-a-number");
		assert.equal(polled.status, 200);
		// An unparseable since is treated as 0: everything comes back.
		assert.equal(polled.body.events.length, 1);
		resolveBridgeRequest("bad-since", "ok");

		await finish();
	} finally {
		bridge.close();
	}
});

test("job log survives a caller disconnect: no terminal error, reply recoverable", { timeout: 10_000 }, async () => {
	const port = 19704;
	const bridge = withBridgeServer(port);
	try {
		const { finish } = await openStream(port, "survive-1");
		finish(); // the caller's connection drops mid-run

		// The run keeps going and finishes — nobody is connected any more.
		publishBridgeStatus("survive-1", "kept working");
		assert.ok(resolveBridgeRequest("survive-1", "late answer"));

		const logged = readJobLog(bridge.workingDir, "survive-1");
		assert.ok(!logged.some((l) => l.type === "error"), "a disconnect is not a job failure");
		assert.equal(logged.at(-1).type, "final");
		assert.equal(logged.at(-1).text, "late answer");

		const polled = await getJob(port, "survive-1", 0);
		assert.equal(polled.body.done, true);
		assert.equal(polled.body.events.at(-1).text, "late answer");
	} finally {
		bridge.close();
	}
});

test("job log: a genuine failure lands as a terminal error event", { timeout: 10_000 }, async () => {
	const port = 19705;
	const bridge = withBridgeServer(port);
	try {
		const { finish } = await openStream(port, "fail-1");
		failBridgeRequest("fail-1", "no progress for 180s", "idle_timeout");

		const logged = readJobLog(bridge.workingDir, "fail-1");
		assert.equal(logged.at(-1).type, "error");
		assert.equal(logged.at(-1).code, "idle_timeout");

		const polled = await getJob(port, "fail-1", 0);
		assert.equal(polled.body.done, true);
		assert.equal(polled.body.events.at(-1).type, "error");

		await finish();
	} finally {
		bridge.close();
	}
});

test("job log: a reused conversation key starts a fresh log", { timeout: 10_000 }, async () => {
	const port = 19706;
	const bridge = withBridgeServer(port);
	try {
		const first = await openStream(port, "reuse-key");
		resolveBridgeRequest("reuse-key", "first run's answer");
		await first.finish();
		assert.ok(readJobLog(bridge.workingDir, "reuse-key").length > 0);

		// Second mention reuses the key — its job log starts empty, not mixed.
		const second = await openStream(port, "reuse-key");
		assert.deepEqual(readJobLog(bridge.workingDir, "reuse-key"), []);

		publishBridgeStatus("reuse-key", "fresh run");
		const polled = await getJob(port, "reuse-key", 0);
		assert.deepEqual(polled.body.events.map((e) => e.text), ["fresh run"]);
		resolveBridgeRequest("reuse-key", "second answer");

		await second.finish();
	} finally {
		bridge.close();
	}
});

test("GET /bridge/jobs/:id answers 400 (not a crash) on malformed percent-encoding", { timeout: 10_000 }, async () => {
	const port = 19709;
	const bridge = withBridgeServer(port);
	try {
		// decodeURIComponent throws on `%zz`; escaping the async handler would be
		// an unhandled rejection that kills the sub-agent process.
		const res = await fetch(`http://127.0.0.1:${port}/bridge/jobs/%zz`);
		assert.equal(res.status, 400);
	} finally {
		bridge.close();
	}
});

test("job log: sweep removes logs older than the retention window; 0 disables", { timeout: 10_000 }, async () => {
	const port = 19707;
	const bridge = withBridgeServer(port);
	try {
		const jobsDir = join(bridge.workingDir, "bridge-jobs");
		const oldFile = join(jobsDir, "old.jsonl");
		const freshFile = join(jobsDir, "fresh.jsonl");
		writeFileSync(oldFile, "{}\n");
		writeFileSync(freshFile, "{}\n");
		const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
		utimesSync(oldFile, longAgo, longAgo);

		assert.equal(sweepBridgeJobLogs(24 * 60 * 60 * 1000), 1);
		assert.equal(sweepBridgeJobLogs(24 * 60 * 60 * 1000), 0); // idempotent
		assert.doesNotThrow(() => readFileSync(freshFile));

		assert.equal(sweepBridgeJobLogs(0), 0); // retention disabled sweeps nothing
	} finally {
		bridge.close();
	}
});

// ============================================================================
// Client side: callAgentBridge recovers a broken stream from the job log
// ============================================================================

/**
 * Simulates the connection dropping mid-run: the first streaming POST gets its
 * body replaced by one that forwards a single chunk (the accepted line) and
 * then dies, exactly like a dropped socket. Everything else — including the
 * client's recovery polls of GET /bridge/jobs/… — passes through untouched.
 */
function dropFirstStreamBody() {
	const realFetch = globalThis.fetch;
	let wrapped = false;
	globalThis.fetch = async (url, opts = {}) => {
		const res = await realFetch(url, opts);
		if (!wrapped && String(url).endsWith("/bridge") &&
				(res.headers.get("content-type") ?? "").includes("ndjson")) {
			wrapped = true;
			const reader = res.body.getReader();
			let dropped = false;
			const body = new ReadableStream({
				async pull(controller) {
					if (dropped) return;
					const { done, value } = await reader.read();
					if (done) { controller.close(); return; }
					controller.enqueue(value);
					dropped = true;
					controller.error(new Error("connection dropped mid-run"));
				},
			});
			return new Response(body, { status: res.status, headers: res.headers });
		}
		return res;
	};
	return () => { globalThis.fetch = realFetch; };
}

test("callAgentBridge recovers the reply after the connection drops mid-run", { timeout: 20_000 }, async () => {
	const bridgePort = 19708;
	const bridge = withBridgeServer(bridgePort, {
		IRIS_BRIDGE_JOB_POLL_MS: 100,
		IRIS_BRIDGE_IDLE_TIMEOUT_MS: 10_000,
	});
	const restoreFetch = dropFirstStreamBody();
	try {
		const pending = callAgentBridge(`http://127.0.0.1:${bridgePort}`, "slow task", "test", {
			conversationKey: "recover-me",
		});

		// Let the stream break, then finish the work as if nothing happened.
		await new Promise((r) => setTimeout(r, 100));
		publishBridgeStatus("recover-me", "still working");
		resolveBridgeRequest("recover-me", "recovered against the odds");

		assert.equal(await pending, "recovered against the odds");
	} finally {
		restoreFetch();
		bridge.close();
	}
});

test("callAgentBridge still fails when there is no job log to recover from (old sub-agent)", { timeout: 20_000 }, async () => {
	const port = 19710;
	// An old-runtime stand-in: streams an accepted line, then the connection
	// dies; it implements no GET /bridge/jobs endpoint at all.
	const fakeAgent = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/bridge") {
			res.writeHead(200, { "Content-Type": NDJSON });
			res.write(`${JSON.stringify({ type: "accepted", requestId: "legacy", protocol: 1 })}\n`);
			setTimeout(() => res.destroy(), 20);
			return;
		}
		res.writeHead(404).end();
	});
	fakeAgent.listen(port, "127.0.0.1");
	try {
		await assert.rejects(
			callAgentBridge(`http://127.0.0.1:${port}`, "hi", "test"),
			/Bridge stream ended without a final reply|terminated|aborted/i,
		);
	} finally {
		fakeAgent.close();
		fakeAgent.closeAllConnections?.();
	}
});
