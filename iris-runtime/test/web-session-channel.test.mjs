// WebTransport + SESSION- channels (IRIS-180).
//
// injectSessionMessage mints `SESSION-<id>` for every turn driven through the
// session REST API, so WebTransport must serve those channels the same way it
// serves its own `WEBUI-<id>` ones: WS subscription, uploads, file serving.
// Namespaces this transport does not own stay rejected.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { WebTransport } from "../dist/transports/web/web.js";

const closers = [];
after(() => {
	for (const close of closers) close();
});

function settle(ms = 30) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWorkingDir() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-websession-test-"));
	writeFileSync(join(workingDir, "agents.json"), JSON.stringify({}));
	return workingDir;
}

function makeCommands() {
	const calls = [];
	return {
		calls,
		stop: async (channelId) => { calls.push(["stop", channelId]); },
		compact: async (channelId) => { calls.push(["compact", channelId]); },
		reset: async (channelId) => { calls.push(["reset", channelId]); },
	};
}

function collectFrames(ws) {
	const frames = [];
	ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
	return frames;
}

test("web transport: ?thread=SESSION-<id> subscribes to the API-driven session channel", async () => {
	const port = 19412;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {}, commands: makeCommands() });
	transport.start();
	closers.push(() => transport.stop());

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=SESSION-abc123`);
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	// Broadcast against the channel id injectSessionMessage mints — no WEBUI- wrapping.
	const id = await transport.postMessage("SESSION-abc123", "from the api session");
	await transport.updateMessage("SESSION-abc123", id, "from the api session (edited)");
	await settle(50);

	assert.deepEqual(
		frames.map((f) => [f.type, f.text]),
		[["final", "from the api session"], ["update", "from the api session (edited)"]],
	);
	ws.close();
});

test("web transport: a bare thread id still gets the WEBUI- prefix", async () => {
	const port = 19415;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {}, commands: makeCommands() });
	transport.start();
	closers.push(() => transport.stop());

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=plain`);
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	await transport.postMessage("WEBUI-plain", "hi");
	await settle(50);

	assert.deepEqual(frames.map((f) => f.text), ["hi"]);
	ws.close();
});

test("web transport: /upload and /files round-trip a SESSION- channel", async () => {
	const port = 19413;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {}, commands: makeCommands() });
	transport.start();
	closers.push(() => transport.stop());

	const uploadRes = await fetch(`http://127.0.0.1:${port}/upload?channel=SESSION-s7`, {
		method: "POST",
		headers: { "X-Filename": "note.txt" },
		body: "session file",
	});
	assert.equal(uploadRes.status, 200);
	const { local } = await uploadRes.json();
	assert.match(local, /^SESSION-s7[/\\]attachments[/\\]\d+_note\.txt$/);

	const filename = local.split(/[/\\]/).pop();
	const downloadRes = await fetch(`http://127.0.0.1:${port}/files/SESSION-s7/${filename}`);
	assert.equal(downloadRes.status, 200);
	assert.equal(await downloadRes.text(), "session file");
});

test("web transport: virtual namespaces this transport doesn't own stay rejected", async () => {
	const port = 19416;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {}, commands: makeCommands() });
	transport.start();
	closers.push(() => transport.stop());

	for (const channel of ["BRIDGE-x", "ESCALATE-x", "SELFHEAL-x", "slack-general", "SESSION-"]) {
		const res = await fetch(`http://127.0.0.1:${port}/upload?channel=${encodeURIComponent(channel)}`, {
			method: "POST",
			headers: { "X-Filename": "note.txt" },
			body: "nope",
		});
		assert.equal(res.status, 400, `expected channel=${channel} to be rejected`);
		const download = await fetch(`http://127.0.0.1:${port}/files/${encodeURIComponent(channel)}/note.txt`);
		assert.equal(download.status, 400, `expected /files/${channel} to be rejected`);
	}
});

test("web transport: a traversal-bearing SESSION- channel is still rejected", async () => {
	const port = 19417;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {}, commands: makeCommands() });
	transport.start();
	closers.push(() => transport.stop());

	const res = await fetch(`http://127.0.0.1:${port}/upload?channel=${encodeURIComponent("SESSION-../../etc")}`, {
		method: "POST",
		headers: { "X-Filename": "passwd" },
		body: "nope",
	});
	assert.equal(res.status, 400);

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=${encodeURIComponent("SESSION-../../etc")}`);
	const rejected = await new Promise((resolve) => {
		ws.on("open", () => resolve(false));
		ws.on("unexpected-response", (_req, r) => resolve(r.statusCode === 400));
		ws.on("error", () => resolve(true));
	});
	assert.equal(rejected, true);
});

test("web transport: commands on a SESSION- socket target the session channel", async () => {
	const port = 19414;
	const workingDir = makeWorkingDir();
	const commands = makeCommands();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {}, commands });
	transport.start();
	closers.push(() => transport.stop());

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=SESSION-s9`);
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "command", action: "stop" }));
	await settle(50);

	assert.deepEqual(commands.calls, [["stop", "SESSION-s9"]]);
	ws.close();
});

test("web transport: the WS auth gate still applies to SESSION- threads", async () => {
	process.env.IRIS_WEBUI_PASSWORD = "secret123";
	const port = 19418;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {}, commands: makeCommands() });
	transport.start();
	closers.push(() => transport.stop());

	const unauthed = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=SESSION-gate`);
	const failed = await new Promise((resolve) => {
		unauthed.on("open", () => resolve(false));
		unauthed.on("error", () => resolve(true));
		unauthed.on("unexpected-response", (_req, res) => resolve(res.statusCode === 401));
	});
	assert.equal(failed, true);

	const uploadRes = await fetch(`http://127.0.0.1:${port}/upload?channel=SESSION-gate`, {
		method: "POST",
		headers: { "X-Filename": "note.txt" },
		body: "nope",
	});
	assert.equal(uploadRes.status, 401);

	delete process.env.IRIS_WEBUI_PASSWORD;
});
