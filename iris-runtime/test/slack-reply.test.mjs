// Reply-delivery regression suite (issue #61): Slack enforces its message
// limits against the HTML-escaped text it stores (& < > become entities), so
// formatting-heavy replies used to fail with msg_too_long and the failure was
// log-only — the user was left staring at the "Thinking..." placeholder.
// These tests drive the compiled createSlackContext against a stub transport
// and verify: escape-aware chunk budgeting, the msg_too_long re-split retry,
// and the file-attachment fallback that replaces silent failure.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackContext, slackEscapedLength, splitIntoChunks } from "../dist/slack.js";

const msgTooLong = () =>
	Object.assign(new Error("An API error occurred: msg_too_long"), {
		code: "slack_webapi_platform_error",
		data: { ok: false, error: "msg_too_long" },
	});

/**
 * Stub transport for createSlackContext. `rejectOver` simulates Slack's
 * server-side rejection: any message whose escaped length exceeds it throws
 * msg_too_long (finalize/post/thread alike).
 */
function makeStubContext({ rejectOver = Infinity } = {}) {
	const calls = { finalized: [], posted: [], threads: [], deleted: [], uploads: [] };
	let nextTs = 100;
	const guard = (text) => {
		if (slackEscapedLength(text) > rejectOver) throw msgTooLong();
	};
	const slack = {
		transportId: "slack",
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllChannels: () => [],
		getAllUsers: () => [],
		logBotResponse: () => {},
		postMessage: async (channel, text) => {
			guard(text);
			calls.posted.push({ channel, text });
			return String(++nextTs);
		},
		finalizeMessage: async (channel, ts, text) => {
			guard(text);
			calls.finalized.push({ channel, ts, text });
		},
		postInThread: async (channel, threadTs, text) => {
			guard(text);
			calls.threads.push({ channel, threadTs, text });
			return String(++nextTs);
		},
		deleteMessage: async (channel, ts) => {
			calls.deleted.push({ channel, ts });
		},
		uploadTextFile: async (channel, content, fileName, threadTs) => {
			calls.uploads.push({ channel, content, fileName, threadTs });
		},
	};
	const event = { type: "dm", channel: "D123", ts: "1.1", user: "U1", text: "hi", attachments: [] };
	const ctx = createSlackContext(event, slack, { store: null });
	return { ctx, calls };
}

const squash = (s) => s.replace(/\s+/g, "");

// ============================================================================
// Escaped-length budgeting
// ============================================================================

test("slackEscapedLength counts & < > as their HTML entities", () => {
	assert.equal(slackEscapedLength("abc"), 3);
	assert.equal(slackEscapedLength("<>&"), 4 + 4 + 5);
	assert.equal(slackEscapedLength("if (a < b && b > c)"), 19 + 3 + 4 + 4 + 3);
});

test("splitIntoChunks: plain text under the limit stays one chunk", () => {
	const text = "line\n".repeat(700).trim(); // 3499 chars, no escapables
	assert.deepEqual(splitIntoChunks(text, 4000), [text]);
});

test("splitIntoChunks: text under 4000 raw chars but over it escaped is split (#61)", () => {
	// ~3900 raw chars, dense with < > & — the shape that used to slip through
	// as a single chunk and get rejected by Slack with msg_too_long.
	const line = "if (foo < bar && bar > baz) { <tag> &amp </tag> }"; // 50 raw chars
	const text = Array(78).fill(line).join("\n"); // 3977 raw chars
	assert.ok(text.length < 4000, "raw length must be under the split point");
	assert.ok(slackEscapedLength(text) > 4000, "escaped length must exceed it");

	const chunks = splitIntoChunks(text, 4000);
	assert.ok(chunks.length > 1, "must split into multiple chunks");
	for (const chunk of chunks) {
		assert.ok(slackEscapedLength(chunk) <= 4000, "every chunk must fit the escaped budget");
	}
	assert.equal(squash(chunks.join("")), squash(text), "no content lost");
});

// ============================================================================
// replaceMessage delivery
// ============================================================================

test("replaceMessage: long reply replaces the placeholder and threads the rest", async () => {
	const { ctx, calls } = makeStubContext();
	await ctx.setTyping(true);
	const text = Array(120).fill("x".repeat(80)).join("\n"); // ~9700 chars
	await ctx.replaceMessage(text);

	assert.equal(calls.posted.length, 1, "one placeholder post");
	assert.match(calls.posted[0].text, /Thinking/);
	assert.equal(calls.finalized.length, 1, "placeholder replaced exactly once");
	assert.ok(calls.threads.length >= 1, "overflow goes to the thread");
	assert.equal(squash([calls.finalized[0].text, ...calls.threads.map((c) => c.text)].join("")), squash(text));
});

test("replaceMessage: msg_too_long triggers re-split at half size, nothing lost or duplicated", async () => {
	// Server rejects anything over 2500 escaped chars; first pass chunks at
	// 4000 fail, the retry at 2000 must deliver everything.
	const { ctx, calls } = makeStubContext({ rejectOver: 2500 });
	await ctx.setTyping(true);
	const text = Array(75).fill("y".repeat(80)).join("\n"); // ~6000 chars
	await ctx.replaceMessage(text);

	assert.equal(calls.finalized.length, 1, "placeholder replaced exactly once (failed attempts don't record)");
	assert.ok(slackEscapedLength(calls.finalized[0].text) <= 2500);
	for (const t of calls.threads) assert.ok(slackEscapedLength(t.text) <= 2500);
	assert.equal(squash([calls.finalized[0].text, ...calls.threads.map((c) => c.text)].join("")), squash(text));
	assert.equal(calls.uploads.length, 0, "no file fallback needed");
});

test("replaceMessage: thread chunks posted before a msg_too_long are deleted, not duplicated", async () => {
	// The second thread post fails once with msg_too_long: the retry must first
	// delete the thread chunk that already went out, then re-deliver everything.
	const calls2 = { finalized: [], posted: [], threads: [], deleted: [], uploads: [] };
	let nextTs = 200;
	let failNextThreadPost = true;
	const slack2 = {
		transportId: "slack",
		getUser: () => undefined,
		getChannel: () => undefined,
		getAllChannels: () => [],
		getAllUsers: () => [],
		logBotResponse: () => {},
		postMessage: async (channel, text) => {
			calls2.posted.push({ channel, text });
			return String(++nextTs);
		},
		finalizeMessage: async (channel, ts, text) => {
			calls2.finalized.push({ channel, ts, text });
		},
		postInThread: async (channel, threadTs, text) => {
			if (failNextThreadPost && calls2.threads.length === 1) {
				failNextThreadPost = false;
				throw msgTooLong();
			}
			calls2.threads.push({ channel, threadTs, text });
			return String(++nextTs);
		},
		deleteMessage: async (channel, ts) => {
			calls2.deleted.push({ channel, ts });
		},
		uploadTextFile: async () => {},
	};
	const event = { type: "dm", channel: "D123", ts: "1.1", user: "U1", text: "hi", attachments: [] };
	const ctx2 = createSlackContext(event, slack2, { store: null });
	await ctx2.setTyping(true);
	const text = Array(150).fill("z".repeat(80)).join("\n"); // ~12150 chars → 4 chunks at 4000
	await ctx2.replaceMessage(text);

	assert.equal(calls2.deleted.length, 1, "the thread chunk posted before the failure is removed");
	// Final content: last finalize + thread posts made after the deleted one
	const finalText = calls2.finalized[calls2.finalized.length - 1].text;
	const survivingThreadTexts = calls2.threads.slice(1).map((c) => c.text); // first was deleted
	assert.equal(squash([finalText, ...survivingThreadTexts].join("")), squash(text), "retry delivers the full reply");
});

test("replaceMessage: persistent msg_too_long falls back to file upload + visible notice", async () => {
	// Everything over 200 escaped chars is rejected — even the MIN_SPLIT_CHARS
	// retry fails, so the reply must arrive as a file and the placeholder must
	// be replaced with an explanation (never left on "Thinking...").
	const { ctx, calls } = makeStubContext({ rejectOver: 200 });
	await ctx.setTyping(true);
	const text = Array(60).fill("w".repeat(80)).join("\n"); // ~4860 chars
	await ctx.replaceMessage(text);

	assert.equal(calls.uploads.length, 1, "reply attached as a file");
	assert.equal(calls.uploads[0].content, text, "full reply content in the file");
	assert.equal(calls.uploads[0].fileName, "iris-reply.md");
	assert.equal(calls.finalized.length, 1, "placeholder replaced with the notice");
	assert.match(calls.finalized[0].text, /attached it as a file/);
	assert.match(calls.finalized[0].text, /msg_too_long/);
});
