// Session API: stop route + inbound attachments (#185).
//
// Both gaps traced back to POST /sessions/:id/message being the only entry
// point for an API-driven turn: no way to abort one, and no field for a file.
// These drive the real compiled startApiServer with a stub transport, so the
// route wiring (not just the helper) is what's under test.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, validateSessionAttachments } from "../dist/engine/api.js";
import { createSession } from "../dist/engine/sessions.js";

const closers = [];
after(() => {
	for (const close of closers) close();
});

function makeWorkingDir() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-session-api-test-"));
	writeFileSync(join(workingDir, "agents.json"), JSON.stringify({}));
	return workingDir;
}

/** Minimal ApiTransport: records what the API asked it to do. */
function makeTransport() {
	const calls = { injected: [], posted: [] };
	return {
		calls,
		ownsChannel: () => true,
		stopCommandHint: "stop",
		injectSessionMessage: async (sessionId, user, text, attachments) => {
			calls.injected.push({ sessionId, user, text, attachments });
			return "stub reply";
		},
		postMessage: async (channel, text) => {
			calls.posted.push([channel, text]);
			return "1";
		},
		updateMessage: async () => {},
		createContext: () => ({}),
		resetSessionContext: () => {},
	};
}

function startServer(port, workingDir, { transport, commands, channelStates } = {}) {
	const server = startApiServer(
		port,
		workingDir,
		channelStates ?? new Map(),
		() => (transport ? [transport] : []),
		commands,
	);
	closers.push(() => server.close());
	return `http://127.0.0.1:${port}`;
}

function seedSession(workingDir) {
	return createSession(workingDir, { originChannel: "C1", originThreadTs: "1.0" }).sessionId;
}

// ============================================================================
// POST /sessions/:id/stop
// ============================================================================

test("session stop: aborts the turn through the injected engine command", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const transport = makeTransport();
	const stopped = [];
	const channelStates = new Map([[`SESSION-${sessionId}`, { running: true }]]);
	const base = startServer(19531, workingDir, {
		transport,
		channelStates,
		commands: { stop: async (channelId) => stopped.push(channelId) },
	});

	const res = await fetch(`${base}/sessions/${sessionId}/stop`, { method: "POST" });
	assert.equal(res.status, 200);
	assert.deepEqual(await res.json(), { status: "ok", wasRunning: true });
	// The engine action is addressed to the SESSION- channel the run is on —
	// the same channel id injectSessionMessage mints.
	assert.deepEqual(stopped, [`SESSION-${sessionId}`]);
});

test("session stop: reports wasRunning=false when nothing is in flight", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const base = startServer(19532, workingDir, {
		transport: makeTransport(),
		commands: { stop: async () => {} },
	});

	const res = await fetch(`${base}/sessions/${sessionId}/stop`, { method: "POST" });
	assert.equal(res.status, 200);
	assert.equal((await res.json()).wasRunning, false);
});

test("session stop: unknown session is a 404, not a stop against a phantom channel", async () => {
	const workingDir = makeWorkingDir();
	const stopped = [];
	const base = startServer(19533, workingDir, {
		transport: makeTransport(),
		commands: { stop: async (channelId) => stopped.push(channelId) },
	});

	const res = await fetch(`${base}/sessions/does-not-exist/stop`, { method: "POST" });
	assert.equal(res.status, 404);
	assert.deepEqual(stopped, []);
});

test("session stop: a failing status post still reports the abort", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const base = startServer(19543, workingDir, {
		transport: makeTransport(),
		// Telegram's postMessage throws on a SESSION- channel id; handleStop has
		// already aborted the run by then, so the caller must not see a 500.
		commands: { stop: async () => { throw new Error("chat_id NaN"); } },
	});

	const res = await fetch(`${base}/sessions/${sessionId}/stop`, { method: "POST" });
	assert.equal(res.status, 200);
});

test("session stop: 503 when the engine command was never wired", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const base = startServer(19534, workingDir, { transport: makeTransport() });

	const res = await fetch(`${base}/sessions/${sessionId}/stop`, { method: "POST" });
	assert.equal(res.status, 503);
});

// ============================================================================
// POST /sessions/:id/attachments
// ============================================================================

test("session attachments: uploads bytes into the session dir and returns a usable local handle", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const base = startServer(19535, workingDir, { transport: makeTransport() });

	const res = await fetch(`${base}/sessions/${sessionId}/attachments`, {
		method: "POST",
		headers: { "X-Filename": "report.pdf" },
		body: "pdf-bytes",
	});
	assert.equal(res.status, 200);
	const { local } = await res.json();

	// `local` is workspace-relative (what agent.ts joins onto the workspace root)
	// and scoped to this session's own attachments dir.
	assert.match(local, new RegExp(`^SESSION-${sessionId}/attachments/\\d+_report\\.pdf$`));
	assert.equal(readFileSync(join(workingDir, local), "utf-8"), "pdf-bytes");
});

test("session attachments: rejects a missing or path-bearing X-Filename", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const base = startServer(19536, workingDir, { transport: makeTransport() });

	const noName = await fetch(`${base}/sessions/${sessionId}/attachments`, { method: "POST", body: "x" });
	assert.equal(noName.status, 400);

	for (const filename of ["../escape.txt", "sub/dir.txt"]) {
		const res = await fetch(`${base}/sessions/${sessionId}/attachments`, {
			method: "POST",
			headers: { "X-Filename": filename },
			body: "x",
		});
		assert.equal(res.status, 400, `expected 400 for ${filename}`);
	}
});

test("session attachments: unknown session is a 404 before anything is written", async () => {
	const workingDir = makeWorkingDir();
	const base = startServer(19537, workingDir, { transport: makeTransport() });

	const res = await fetch(`${base}/sessions/nope/attachments`, {
		method: "POST",
		headers: { "X-Filename": "a.txt" },
		body: "x",
	});
	assert.equal(res.status, 404);
});

// ============================================================================
// POST /sessions/:id/message — attachments field
// ============================================================================

test("session message: threads an uploaded attachment through to the transport", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const transport = makeTransport();
	const base = startServer(19538, workingDir, { transport });

	// The round trip a caller actually performs: upload, then send.
	const upload = await fetch(`${base}/sessions/${sessionId}/attachments`, {
		method: "POST",
		headers: { "X-Filename": "shot.png" },
		body: "png-bytes",
	});
	const { local } = await upload.json();

	const res = await fetch(`${base}/sessions/${sessionId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: "what is this", attachments: [{ local }] }),
	});
	assert.equal(res.status, 200);
	assert.equal((await res.json()).text, "stub reply");
	assert.deepEqual(transport.calls.injected[0].attachments, [{ local }]);
});

test("session message: no attachments field still injects an empty list", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const transport = makeTransport();
	const base = startServer(19539, workingDir, { transport });

	const res = await fetch(`${base}/sessions/${sessionId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: "hello" }),
	});
	assert.equal(res.status, 200);
	assert.deepEqual(transport.calls.injected[0].attachments, []);
});

test("session message: an attachment outside this session's dir is refused", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const otherId = seedSession(workingDir);
	const transport = makeTransport();
	const base = startServer(19540, workingDir, { transport });

	// A real file, but belonging to a different session — a caller must not be
	// able to attach another session's files by naming their path.
	const otherDir = join(workingDir, `SESSION-${otherId}`, "attachments");
	mkdirSync(otherDir, { recursive: true });
	writeFileSync(join(otherDir, "secret.txt"), "not yours");

	for (const local of [
		`SESSION-${otherId}/attachments/secret.txt`,
		`SESSION-${sessionId}/attachments/../../SESSION-${otherId}/attachments/secret.txt`,
		"slack/C12345/attachments/anything.txt",
	]) {
		const res = await fetch(`${base}/sessions/${sessionId}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "peek", attachments: [{ local }] }),
		});
		assert.equal(res.status, 400, `expected 400 for ${local}`);
	}
	assert.deepEqual(transport.calls.injected, []);
});

test("session message: a nonexistent attachment path is refused up front", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const transport = makeTransport();
	const base = startServer(19541, workingDir, { transport });

	const res = await fetch(`${base}/sessions/${sessionId}/message`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			text: "read it",
			attachments: [{ local: `SESSION-${sessionId}/attachments/never-uploaded.pdf` }],
		}),
	});
	// agent.ts would otherwise tell the model the file is "still downloading",
	// which is a fiction on the API path — nothing downloads in the background.
	assert.equal(res.status, 400);
	assert.match((await res.json()).error, /does not exist/);
	assert.deepEqual(transport.calls.injected, []);
});

test("session message: a malformed attachments field is a 400, not a crash", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const base = startServer(19542, workingDir, { transport: makeTransport() });

	for (const attachments of ["not-an-array", [{ notLocal: 1 }], [null], [{ local: "" }]]) {
		const res = await fetch(`${base}/sessions/${sessionId}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hi", attachments }),
		});
		assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(attachments)}`);
	}
});

// ============================================================================
// GET /sessions/:id/stream
// ============================================================================

test("session stream: unknown session is a 404", async () => {
	const workingDir = makeWorkingDir();
	const base = startServer(19544, workingDir, { transport: makeTransport() });

	const res = await fetch(`${base}/sessions/does-not-exist/stream`, { method: "GET" });
	assert.equal(res.status, 404);
});

test("session stream: forwards channel-observers events for the session's channel as SSE frames", async () => {
	const { publishChannelEvent, isChannelObserved } = await import("../dist/engine/channel-observers.js");
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const base = startServer(19545, workingDir, { transport: makeTransport() });

	const res = await fetch(`${base}/sessions/${sessionId}/stream`, { method: "GET" });
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "text/event-stream");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	async function readUntil(marker) {
		while (!buffered.includes(marker)) {
			const { value, done } = await reader.read();
			if (done) throw new Error("stream ended before marker");
			buffered += decoder.decode(value, { stream: true });
		}
	}

	// Registration happens synchronously inside the route handler, but the
	// fetch() promise can resolve before the server has flushed the initial
	// ":ok" comment — wait for it so publishChannelEvent below isn't a race.
	await readUntil(":ok");
	assert.ok(isChannelObserved(`SESSION-${sessionId}`));

	publishChannelEvent(`SESSION-${sessionId}`, { kind: "thinking" });
	await readUntil("event: thinking");
	assert.match(buffered, /event: thinking\ndata: \{"kind":"thinking"\}\n\n/);

	// A different channel's events must not leak into this session's stream.
	publishChannelEvent("SESSION-someone-else", { kind: "final", text: "not for you" });
	publishChannelEvent(`SESSION-${sessionId}`, { kind: "final", text: "done" });
	await readUntil("event: final");
	assert.doesNotMatch(buffered, /not for you/);

	await reader.cancel();

	// Cancelling the reader closes the connection asynchronously — poll for the
	// route's `close`-triggered cleanup (unregisterChannelObserver) to land,
	// so a regression there (e.g. dropped/reordered cleanup) fails this test
	// instead of only leaking silently.
	for (let i = 0; i < 50 && isChannelObserved(`SESSION-${sessionId}`); i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.equal(isChannelObserved(`SESSION-${sessionId}`), false);
});

test("session stream: caps concurrent connections per session", async () => {
	const workingDir = makeWorkingDir();
	const sessionId = seedSession(workingDir);
	const base = startServer(19546, workingDir, { transport: makeTransport() });

	async function openStream() {
		const res = await fetch(`${base}/sessions/${sessionId}/stream`, { method: "GET" });
		const reader = res.body.getReader();
		// Wait for the ":ok" preamble so the connection is fully registered
		// before the next one opens — the cap check races an in-flight open
		// otherwise.
		await reader.read();
		return { res, reader };
	}

	const opened = [];
	for (let i = 0; i < 8; i++) opened.push(await openStream());
	for (const { res } of opened) assert.equal(res.status, 200);

	const rejected = await fetch(`${base}/sessions/${sessionId}/stream`, { method: "GET" });
	assert.equal(rejected.status, 429);

	// Closing one frees a slot for the next connection.
	await opened[0].reader.cancel();
	let freed = false;
	for (let i = 0; i < 50 && !freed; i++) {
		const res = await fetch(`${base}/sessions/${sessionId}/stream`, { method: "GET" });
		if (res.status === 200) {
			freed = true;
			await res.body.getReader().cancel();
		} else {
			assert.equal(res.status, 429);
			await new Promise((r) => setTimeout(r, 20));
		}
	}
	assert.ok(freed, "expected a slot to free up after closing a connection");

	await Promise.all(opened.slice(1).map(({ reader }) => reader.cancel()));
});

// ============================================================================
// validateSessionAttachments — the guard, unit level
// ============================================================================

test("validateSessionAttachments: undefined is an empty list, not an error", () => {
	const workingDir = makeWorkingDir();
	assert.deepEqual(validateSessionAttachments(workingDir, "abc", undefined), { attachments: [] });
});
