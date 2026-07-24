// parseAgentMention() (engine/bridge.ts) — the leading `@name` detector that
// lets Slack/Telegram bypass Iris's own LLM turn for an explicit sub-agent
// mention, mirroring how the Web UI transport already does it via `?agent=`
// (see web-transport.test.mjs). Also covers the Slack transport wiring
// (slack.ts's app_mention/message handlers) via the existing makeBot harness.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentMention } from "../dist/engine/bridge.js";
import { makeBot, settle } from "./helpers.mjs";

const registry = {
	cricket: { bridge_url: "http://127.0.0.1:19501", description: "Cricket scores" },
	newsletter: { bridge_url: "http://127.0.0.1:19502", description: "Newsletter" },
};

// ============================================================================
// parseAgentMention()
// ============================================================================

test("parseAgentMention: leading @name matches and splits off the query", () => {
	const result = parseAgentMention("@cricket what's the score?", registry);
	assert.deepEqual(result, {
		name: "cricket",
		entry: registry.cricket,
		query: "what's the score?",
	});
});

test("parseAgentMention: matches case-insensitively but returns the registry's own casing", () => {
	const result = parseAgentMention("@Cricket score?", registry);
	assert.equal(result.name, "cricket");
	assert.equal(result.query, "score?");
});

test("parseAgentMention: optional colon/comma separator after the name is consumed", () => {
	assert.equal(parseAgentMention("@cricket: score?", registry).query, "score?");
	assert.equal(parseAgentMention("@cricket, score?", registry).query, "score?");
});

test("parseAgentMention: bare mention with no trailing text yields an empty query", () => {
	const result = parseAgentMention("@cricket", registry);
	assert.equal(result.name, "cricket");
	assert.equal(result.query, "");
});

test("parseAgentMention: unknown agent name returns null", () => {
	assert.equal(parseAgentMention("@ghost do something", registry), null);
});

test("parseAgentMention: a mid-message @name is not treated as a mention", () => {
	// Ordinary text that happens to mention someone by @handle mid-sentence
	// must fall through unchanged — only a leading mention is deterministic.
	assert.equal(parseAgentMention("ask @cricket about the score", registry), null);
});

test("parseAgentMention: leading/trailing whitespace around the mention is tolerated", () => {
	const result = parseAgentMention("   @cricket   what's up?  ", registry);
	assert.equal(result.name, "cricket");
	assert.equal(result.query, "what's up?");
});

test("parseAgentMention: empty registry never matches", () => {
	assert.equal(parseAgentMention("@cricket hi", {}), null);
});

// ============================================================================
// Slack transport wiring (app_mention / message handlers)
// ============================================================================

function withAgentsJson(workingDir, agents) {
	writeFileSync(join(workingDir, "agents.json"), JSON.stringify(agents));
}

function stubBridge(port, respond) {
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => respond(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"), res));
	});
	return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

test("slack app_mention: leading @agent bypasses dispatch and posts the bridge reply", async () => {
	const port = 19511;
	const server = await stubBridge(port, (body, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: `reply to: ${body.text}` }));
	});
	try {
		const { calls, mention, workingDir } = makeBot({});
		withAgentsJson(workingDir, { cricket: { bridge_url: `http://127.0.0.1:${port}`, description: "test" } });

		mention({ text: "<@UBOT> @cricket what's the score?", channel: "C1", user: "U1", ts: "1.1" });
		await settle(100);

		assert.equal(calls.events.length, 0, "Iris's own dispatch must be skipped entirely");
		assert.equal(calls.posted.length, 1);
		assert.equal(calls.posted[0].channel, "C1");
		assert.equal(calls.posted[0].text, "reply to: what's the score?");
	} finally {
		server.close();
	}
});

test("slack app_mention: reply goes to the thread when the mention was posted in one", async () => {
	const port = 19512;
	const server = await stubBridge(port, (_body, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: "threaded reply" }));
	});
	try {
		const { calls, mention, workingDir } = makeBot({});
		withAgentsJson(workingDir, { cricket: { bridge_url: `http://127.0.0.1:${port}`, description: "test" } });

		mention({ text: "<@UBOT> @cricket score?", channel: "C1", user: "U1", ts: "1.2", thread_ts: "1.0" });
		await settle(100);

		assert.equal(calls.posted.length, 0, "must reply in-thread, not as a top-level post");
		assert.equal(calls.threads.length, 1);
		assert.deepEqual(calls.threads[0], { channel: "C1", threadTs: "1.0", text: "threaded reply" });
	} finally {
		server.close();
	}
});

test("slack app_mention: unmatched @name falls through to normal chat dispatch", async () => {
	const { calls, mention, workingDir } = makeBot({});
	withAgentsJson(workingDir, { cricket: { bridge_url: "http://127.0.0.1:19599", description: "test" } });

	mention({ text: "<@UBOT> @someone-else please help", channel: "C1", user: "U1", ts: "1.3" });
	await settle(50);

	assert.equal(calls.posted.length, 0);
	assert.equal(calls.events.length, 1, "no known-agent match — Iris handles it normally");
});

test("slack app_mention: a bridge error posts a visible notice instead of hanging or falling through", async () => {
	const { calls, mention, workingDir } = makeBot({});
	// No stub server listening on this port — the bridge call must fail fast.
	withAgentsJson(workingDir, { cricket: { bridge_url: "http://127.0.0.1:19598", description: "test" } });

	mention({ text: "<@UBOT> @cricket score?", channel: "C1", user: "U1", ts: "1.4" });
	await settle(200);

	assert.equal(calls.events.length, 0, "still bypasses Iris's dispatch — the mention matched");
	assert.equal(calls.posted.length, 1);
	assert.match(calls.posted[0].text, /Couldn't reach @cricket/);
});

test("slack message (DM): leading @agent bypasses dispatch here too", async () => {
	const port = 19513;
	const server = await stubBridge(port, (body, res) => {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text: `dm reply: ${body.text}` }));
	});
	try {
		const { calls, message, workingDir } = makeBot({});
		withAgentsJson(workingDir, { newsletter: { bridge_url: `http://127.0.0.1:${port}`, description: "test" } });

		message({ text: "@newsletter what's new?", channel: "D1", user: "U1", ts: "2.1", channel_type: "im" });
		await settle(100);

		assert.equal(calls.events.length, 0);
		assert.equal(calls.posted.length, 1);
		assert.equal(calls.posted[0].text, "dm reply: what's new?");
	} finally {
		server.close();
	}
});
