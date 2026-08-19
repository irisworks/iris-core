// Channel observers (IRIS-180) — the mirror that makes a SESSION- WebSocket
// actually receive a turn.
//
// The thing under test is specifically the cross-transport hop: a SESSION-<id>
// turn runs on whichever transport the session API picked (Slack/Telegram/
// Bridge — never WebTransport, since api.ts uses getTransports()[0] and Bridge
// is always registered first). Subscribing a socket is therefore not enough on
// its own; without the mirror the socket stays silent for the whole run. These
// tests drive a deliberately foreign (non-web) context, the way the engine
// does, rather than calling WebTransport.postMessage directly.

import assert from "node:assert/strict";
import { test, after, beforeEach } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { WebTransport } from "../dist/transports/web/web.js";
import {
	isChannelObserved,
	mirrorContextToObservers,
	publishChannelEvent,
	registerChannelObserver,
	unregisterChannelObserver,
	clearChannelObservers,
} from "../dist/engine/channel-observers.js";

const closers = [];
after(() => {
	for (const close of closers) close();
});

function settle(ms = 60) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeWorkingDir() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-observers-test-"));
	writeFileSync(join(workingDir, "agents.json"), JSON.stringify({}));
	return workingDir;
}

function makeCommands() {
	return { stop: async () => {}, compact: async () => {}, reset: async () => {} };
}

function collectFrames(ws) {
	const frames = [];
	ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
	return frames;
}

/**
 * Stands in for the context a Slack/Bridge transport hands the engine for a
 * SESSION- turn: it records what it was asked to do and, like those
 * transports, implements no onToolEvent at all.
 */
function makeForeignContext() {
	const calls = [];
	return {
		calls,
		ctx: {
			transportId: "bridge",
			message: { text: "", rawText: "", user: "u", channel: "SESSION-x", ts: "1", attachments: [] },
			channels: [],
			users: [],
			respond: async (text) => { calls.push(["respond", text]); },
			replaceMessage: async (text) => { calls.push(["replaceMessage", text]); },
			respondInThread: async () => {},
			setTyping: async (v) => { calls.push(["setTyping", v]); },
			uploadFile: async (p, t) => { calls.push(["uploadFile", p, t]); },
			setWorking: async () => {},
			deleteMessage: async () => {},
			getAccumulatedText: () => "",
		},
	};
}

function startTransport(port) {
	const transport = new WebTransport({ port, workingDir: makeWorkingDir(), dispatch: () => {}, commands: makeCommands() });
	transport.start();
	closers.push(() => transport.stop());
	return transport;
}

beforeEach(() => clearChannelObservers());

test("a SESSION- socket makes the channel observed; an unwatched one does not", async () => {
	const transport = startTransport(19420);

	assert.equal(isChannelObserved("SESSION-live"), false, "no socket yet");

	const ws = new WebSocket("ws://127.0.0.1:19420/ws?thread=SESSION-live");
	await new Promise((resolve) => ws.on("open", resolve));

	assert.equal(isChannelObserved("SESSION-live"), true);
	assert.equal(isChannelObserved("SESSION-other"), false);
	// A WEBUI- channel is served by the transport's own context, so it must NOT
	// be reported as observed — mirroring it would double every frame.
	assert.equal(isChannelObserved("WEBUI-live"), false);

	ws.close();
	await settle();
	assert.equal(isChannelObserved("SESSION-live"), false, "unsubscribed on close");
	transport.stop();
});

test("a turn on a foreign (non-web) context streams to the SESSION- socket", async () => {
	startTransport(19421);

	const ws = new WebSocket("ws://127.0.0.1:19421/ws?thread=SESSION-x");
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	// Exactly what engine/index.ts does for an observed channel.
	const { calls, ctx } = makeForeignContext();
	const wrapped = mirrorContextToObservers("SESSION-x", ctx);

	await wrapped.setTyping(true);
	wrapped.onToolEvent({ id: "t1", toolName: "bash", label: "ls", phase: "start" });
	wrapped.onToolEvent({ id: "t1", toolName: "bash", result: "file.txt", phase: "end", durationMs: 12 });
	await wrapped.replaceMessage("the answer");
	await settle();

	assert.deepEqual(frames.map((f) => f.type), ["thinking", "tool", "tool", "final"]);
	assert.equal(frames[1].phase, "start");
	assert.equal(frames[3].text, "the answer");
	// thinking and final address the same bubble.
	assert.equal(frames[0].id, frames[3].id);

	// The underlying transport still did its own job — the mirror observes, it
	// does not replace.
	assert.deepEqual(calls, [["setTyping", true], ["replaceMessage", "the answer"]]);

	ws.close();
});

test("consecutive observed turns open separate bubbles", async () => {
	startTransport(19422);

	const ws = new WebSocket("ws://127.0.0.1:19422/ws?thread=SESSION-two");
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	const { ctx } = makeForeignContext();
	const wrapped = mirrorContextToObservers("SESSION-two", ctx);

	await wrapped.setTyping(true);
	await wrapped.replaceMessage("first");
	await wrapped.setTyping(true);
	await wrapped.replaceMessage("second");
	await settle();

	const finals = frames.filter((f) => f.type === "final");
	assert.deepEqual(finals.map((f) => f.text), ["first", "second"]);
	assert.notEqual(finals[0].id, finals[1].id, "second turn must not overwrite the first answer");

	ws.close();
});

test("status and file events mirror as status/file frames", async () => {
	startTransport(19423);

	const ws = new WebSocket("ws://127.0.0.1:19423/ws?thread=SESSION-f");
	const frames = collectFrames(ws);
	await new Promise((resolve) => ws.on("open", resolve));

	const { ctx } = makeForeignContext();
	const wrapped = mirrorContextToObservers("SESSION-f", ctx);

	// Underlying bridge-style ctx has no setStatus; the mirror still emits.
	await wrapped.setStatus("_running bash..._");
	await wrapped.uploadFile("/tmp/report.pdf", "Report");
	await settle();

	const status = frames.find((f) => f.type === "status");
	assert.equal(status.text, "running bash...", "underscores trimmed");

	const file = frames.find((f) => f.type === "file");
	assert.equal(file.url, "/files/SESSION-f/report.pdf");
	assert.equal(file.title, "Report");

	ws.close();
});

test("publishing to an unwatched channel is a no-op, and a throwing observer can't fail the run", async () => {
	// No sockets anywhere — must not throw.
	publishChannelEvent("SESSION-nobody", { kind: "final", text: "into the void" });

	const exploding = {
		watching: () => true,
		emit: () => { throw new Error("watcher blew up"); },
	};
	registerChannelObserver(exploding);
	publishChannelEvent("SESSION-boom", { kind: "final", text: "still fine" });
	unregisterChannelObserver(exploding);
});

test("a stopped transport stops observing", async () => {
	const transport = startTransport(19424);

	const ws = new WebSocket("ws://127.0.0.1:19424/ws?thread=SESSION-stop");
	await new Promise((resolve) => ws.on("open", resolve));
	assert.equal(isChannelObserved("SESSION-stop"), true);

	transport.stop();
	assert.equal(isChannelObserved("SESSION-stop"), false);
	ws.close();
});
