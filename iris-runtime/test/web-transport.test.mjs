// WebTransport (IRIS-112) — the message lifecycle over WebSocket, the
// shared-secret auth gate, and bridge-based sub-agent routing.
// Drives the real compiled WebTransport; the "engine" side is a fake
// dispatch that exercises the returned MessageContext directly, the same
// way engine.handleEvent would, without needing a real agent run.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { WebTransport } from "../dist/transport/web.js";

const closers = [];
after(() => {
	for (const close of closers) close();
});

function settle(ms = 30) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWorkingDir(agents = {}) {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-webtransport-test-"));
	writeFileSync(join(workingDir, "agents.json"), JSON.stringify(agents));
	return workingDir;
}

/** Collects every frame the socket receives, parsed from JSON. */
function collectFrames(ws) {
	const frames = [];
	ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
	return frames;
}

async function login(port, password) {
	const res = await fetch(`http://127.0.0.1:${port}/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	const setCookie = res.headers.get("set-cookie");
	const cookie = setCookie ? setCookie.split(";")[0] : undefined;
	return { res, cookie };
}

test("web transport: full message lifecycle (thinking -> tool -> final)", async () => {
	const port = 19401;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({
		port,
		workingDir,
		dispatch: (event, t) => {
			// Simulate what engine.handleEvent does with the returned context.
			const ctx = t.createContext(event, {});
			void (async () => {
				await ctx.setTyping(true);
				ctx.onToolEvent?.({ id: "t1", toolName: "bash", label: "ls", phase: "start" });
				ctx.onToolEvent?.({ id: "t1", toolName: "bash", result: "file.txt", phase: "end", durationMs: 12 });
				await ctx.replaceMessage("done: " + event.text);
			})();
		},
	});
	transport.start();
	closers.push(() => transport.stop());

	const { res: loginRes, cookie } = await login(port, "");
	assert.equal(loginRes.status, 200);

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=t1`, { headers: { Cookie: cookie } });
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	ws.send(JSON.stringify({ type: "message", text: "hello" }));
	await settle(100);

	const types = frames.map((f) => f.type);
	assert.deepEqual(types, ["thinking", "tool", "tool", "final"]);
	assert.equal(frames[1].phase, "start");
	assert.equal(frames[2].phase, "end");
	assert.equal(frames[3].text, "done: hello");

	ws.close();
});

test("web transport: postMessage/updateMessage broadcast to the channel's connections", async () => {
	const port = 19402;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {} });
	transport.start();
	closers.push(() => transport.stop());

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=abc`);
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	const id = await transport.postMessage("WEBUI-abc", "hello there");
	await transport.updateMessage("WEBUI-abc", id, "hello there (edited)");
	await settle(50);

	assert.deepEqual(
		frames.map((f) => [f.type, f.text]),
		[["final", "hello there"], ["update", "hello there (edited)"]],
	);
	ws.close();
});

test("web transport: WS upgrade is rejected without a valid cookie when a password is set", async () => {
	process.env.IRIS_WEBUI_PASSWORD = "secret123";
	const port = 19403;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {} });
	transport.start();
	closers.push(() => transport.stop());

	const unauthed = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=x`);
	const failed = await new Promise((resolve) => {
		unauthed.on("open", () => resolve(false));
		unauthed.on("error", () => resolve(true));
		unauthed.on("unexpected-response", (_req, res) => resolve(res.statusCode === 401));
	});
	assert.equal(failed, true);

	const wrongLogin = await login(port, "nope");
	assert.equal(wrongLogin.res.status, 401);

	const { res: rightLogin, cookie } = await login(port, "secret123");
	assert.equal(rightLogin.status, 200);

	const authed = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=x`, { headers: { Cookie: cookie } });
	const opened = await new Promise((resolve) => {
		authed.on("open", () => resolve(true));
		authed.on("unexpected-response", () => resolve(false));
	});
	assert.equal(opened, true);
	authed.close();

	delete process.env.IRIS_WEBUI_PASSWORD;
});

test("web transport: ?agent= routes through the HTTP bridge, not the local engine", async () => {
	// Stub bridge server standing in for a sub-agent's /bridge endpoint.
	const bridgePort = 19499;
	const bridgeServer = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ text: "reply from sub-agent" }));
		});
	});
	await new Promise((resolve) => bridgeServer.listen(bridgePort, "127.0.0.1", resolve));
	closers.push(() => bridgeServer.close());

	const port = 19404;
	const workingDir = makeWorkingDir({
		newsletter: { bridge_url: `http://127.0.0.1:${bridgePort}`, description: "test agent" },
	});
	let localDispatchCalled = false;
	const transport = new WebTransport({
		port,
		workingDir,
		dispatch: () => {
			localDispatchCalled = true;
		},
	});
	transport.start();
	closers.push(() => transport.stop());

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=t2&agent=newsletter`);
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	ws.send(JSON.stringify({ type: "message", text: "what's new?" }));
	await settle(150);

	assert.equal(localDispatchCalled, false);
	assert.deepEqual(
		frames.map((f) => f.type),
		["thinking", "final"],
	);
	assert.equal(frames[1].text, "reply from sub-agent");

	ws.close();
});

test("web transport: ?agent= for an unregistered agent returns an error frame", async () => {
	const port = 19405;
	const workingDir = makeWorkingDir();
	const transport = new WebTransport({ port, workingDir, dispatch: () => {} });
	transport.start();
	closers.push(() => transport.stop());

	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?thread=t3&agent=ghost`);
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	ws.send(JSON.stringify({ type: "message", text: "hi" }));
	await settle(50);

	assert.equal(frames.length, 1);
	assert.equal(frames[0].type, "error");
	assert.match(frames[0].message, /Unknown agent/);

	ws.close();
});
