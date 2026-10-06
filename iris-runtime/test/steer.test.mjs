// Mid-run message steering (issue #272): a user message that arrives while a
// turn is in flight is folded into that turn — delivered after the in-flight
// tool batch, all waiting messages together — instead of queueing as a run of
// its own. Covers the transport routing, the engine's gating, and the
// pi-agent-core queue contract the runner relies on.
//
// Requires `npm run build` first (tests import ../dist/*.js).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createEngine } from "../dist/engine/index.js";
import { fillQueue, makeBot, settle } from "./helpers.mjs";

// ============================================================================
// Slack routing
// ============================================================================

test("slack: a mention steers into the running turn instead of queueing a run", async () => {
	const { calls, mention } = makeBot({ steer: () => true });
	mention({ text: "<@UBOT> also check staging", channel: "C1", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(calls.steered.length, 1);
	assert.equal(calls.steered[0].event.text, "also check staging");
	assert.equal(calls.events.length, 0);
});

test("slack: a DM steers into the running turn", async () => {
	const { calls, message } = makeBot({ steer: () => true });
	message({ text: "and the logs", channel: "D1", user: "U1", ts: "1000.0001", channel_type: "im" });
	await settle();
	assert.equal(calls.steered.length, 1);
	assert.equal(calls.events.length, 0);
});

test("slack: nothing to steer into falls back to queueing a run", async () => {
	const { calls, mention } = makeBot({ steer: () => false });
	mention({ text: "<@UBOT> hello", channel: "C1", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(calls.steered.length, 0);
	assert.equal(calls.events.length, 1);
});

test("slack: never steers past messages already waiting in the queue", async () => {
	const made = makeBot({ steer: () => true });
	// One in-flight run plus a waiting one — the new message must queue behind it.
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const queue = made.bot.getQueue("C1");
	queue.enqueue(() => gate);
	queue.enqueue(() => gate);
	made.mention({ text: "<@UBOT> third", channel: "C1", user: "U1", ts: "1000.0003" });
	await settle();
	assert.equal(made.calls.steered.length, 0);
	release();
	await settle();
	assert.equal(made.calls.events.length, 1);
	assert.equal(made.calls.events[0].event.text, "third");
});

test("slack: a full queue still posts the overflow notice when steering declines", async () => {
	const made = makeBot({ steer: () => false });
	const release = fillQueue(made.bot, "C1");
	made.mention({ text: "<@UBOT> one more", channel: "C1", user: "U1", ts: "1000.0001" });
	await settle();
	assert.equal(made.calls.posted.length, 1);
	assert.match(made.calls.posted[0].text, /Too many messages queued/);
	release();
});

// ============================================================================
// Engine gating
// ============================================================================

async function makeEngine() {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-steer-test-"));
	const engine = await createEngine({ workingDir, sandbox: {}, provider: "test", model: "test" });
	const steered = [];
	const seed = (channelId, overrides = {}) => engine.channelStates.set(channelId, {
		running: true,
		stopRequested: false,
		store: {},
		runner: { steer: (message) => { steered.push(message); return true; } },
		...overrides,
	});
	return { engine, steered, seed };
}

test("engine.steer: hands a running channel's message to its runner", async () => {
	const { engine, steered, seed } = await makeEngine();
	seed("C1");
	const event = { channel: "C1", user: "U1", text: "more", ts: "1.1", attachments: [{ local: "C1/attachments/a.png" }] };
	assert.equal(engine.steer(event, "alice"), true);
	assert.deepEqual(steered, [{ text: "more", userName: "alice", attachments: [{ local: "C1/attachments/a.png" }] }]);
});

test("engine.steer: declines when the channel is idle, unknown, or stopping", async () => {
	const { engine, steered, seed } = await makeEngine();
	seed("CIDLE", { running: false });
	seed("CSTOP", { stopRequested: true });
	assert.equal(engine.steer({ channel: "CIDLE", user: "U1", text: "x", ts: "1" }), false);
	assert.equal(engine.steer({ channel: "CNONE", user: "U1", text: "x", ts: "1" }), false);
	assert.equal(engine.steer({ channel: "CSTOP", user: "U1", text: "x", ts: "1" }), false);
	assert.equal(steered.length, 0);
});

test("engine.steer: IRIS_STEER_MESSAGES=false turns steering off", async () => {
	const { engine, steered, seed } = await makeEngine();
	seed("C1");
	process.env.IRIS_STEER_MESSAGES = "false";
	try {
		assert.equal(engine.steer({ channel: "C1", user: "U1", text: "x", ts: "1" }), false);
	} finally {
		delete process.env.IRIS_STEER_MESSAGES;
	}
	assert.equal(steered.length, 0);
});

test("engine.steer: passes through the runner's refusal (no prompt in flight)", async () => {
	const { engine, seed } = await makeEngine();
	seed("C1", { runner: { steer: () => false } });
	assert.equal(engine.steer({ channel: "C1", user: "U1", text: "x", ts: "1" }), false);
});

// ============================================================================
// pi-agent-core contract the runner relies on
// ============================================================================

function fakeUsage() {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistantTurn(content, stopReason) {
	return { role: "assistant", api: "messages", provider: "fake", model: "fake-model", usage: fakeUsage(), stopReason, timestamp: Date.now(), content };
}

test("pi contract: steeringMode \"all\" delivers every message steered during a tool call in the next LLM call", async () => {
	const contexts = [];
	const turns = [
		assistantTurn([{ type: "toolCall", id: "tc1", name: "slow", arguments: {} }], "toolUse"),
		assistantTurn([{ type: "text", text: "done, covered both" }], "stop"),
	];
	const streamFn = async (_model, context) => {
		contexts.push(context.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: m.content?.find?.((c) => c.type === "text")?.text })));
		const finalMessage = turns.shift();
		return {
			[Symbol.asyncIterator]() {
				let done = false;
				return { async next() { if (done) return { done: true, value: undefined }; done = true; return { done: false, value: { type: "done" } }; } };
			},
			result: async () => finalMessage,
		};
	};
	let agent;
	const slowTool = {
		name: "slow",
		label: "slow",
		description: "steers two messages in while it runs",
		parameters: { type: "object", properties: {} },
		execute: async () => {
			agent.steer({ role: "user", content: [{ type: "text", text: "second" }], timestamp: Date.now() });
			agent.steer({ role: "user", content: [{ type: "text", text: "third" }], timestamp: Date.now() });
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	};
	agent = new Agent({
		initialState: { systemPrompt: "", model: { id: "fake-model", provider: "fake", api: "messages", input: ["text"] }, thinkingLevel: "off", tools: [slowTool] },
		streamFn,
		steeringMode: "all",
	});
	await agent.prompt("first");
	assert.equal(contexts.length, 2, "both steered messages land in a single follow-up LLM call");
	assert.deepEqual(contexts[1].map((m) => m.role), ["user", "assistant", "toolResult", "user", "user"]);
	assert.deepEqual(contexts[1].slice(-2).map((m) => m.text), ["second", "third"]);
	assert.equal(agent.hasQueuedMessages(), false);
});
