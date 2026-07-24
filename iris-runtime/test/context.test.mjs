// Regression coverage for #109: /reset (and its /clear alias) truncate
// context.jsonl but deliberately leave log.jsonl alone (it's the channel's
// permanent record). Without a watermark, the next run's
// syncLogToSessionManager call sees an empty session and replays the whole
// pre-reset log.jsonl history straight back into the freshly-cleared
// context, silently undoing the reset. These tests pin the watermark
// plumbing that fixes that.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { readResetWatermark, syncLogToSessionManager, writeResetWatermark } from "../dist/engine/context.js";

/** Minimal stand-in for pi-coding-agent's SessionManager — only the two methods syncLogToSessionManager uses. */
function makeFakeSessionManager(initialEntries = []) {
	const entries = [...initialEntries];
	return {
		getEntries: () => entries,
		appendMessage: (message) => entries.push({ type: "message", message }),
		entries,
	};
}

function writeLog(channelDir, messages) {
	const lines = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
	writeFileSync(join(channelDir, "log.jsonl"), lines);
}

test("readResetWatermark: undefined when no watermark file exists", () => {
	const channelDir = mkdtempSync(join(tmpdir(), "iris-context-test-"));
	assert.equal(readResetWatermark(channelDir), undefined);
});

test("writeResetWatermark/readResetWatermark: round-trips an ISO timestamp", () => {
	const channelDir = mkdtempSync(join(tmpdir(), "iris-context-test-"));
	writeResetWatermark(channelDir);
	const watermark = readResetWatermark(channelDir);
	assert.ok(watermark);
	assert.ok(!Number.isNaN(new Date(watermark).getTime()));
});

test("syncLogToSessionManager: with no watermark, all log.jsonl messages replay (offline-catchup behavior preserved)", () => {
	const channelDir = mkdtempSync(join(tmpdir(), "iris-context-test-"));
	writeLog(channelDir, [
		{ ts: "1", date: "2026-01-01T00:00:00.000Z", user: "U1", userName: "kat", text: "hello", isBot: false },
		{ ts: "2", date: "2026-01-01T00:01:00.000Z", user: "U1", userName: "kat", text: "you there?", isBot: false },
	]);
	const sessionManager = makeFakeSessionManager();

	const synced = syncLogToSessionManager(sessionManager, channelDir);

	assert.equal(synced, 2);
	assert.equal(sessionManager.entries.length, 2);
});

test("syncLogToSessionManager: a reset watermark stops pre-reset log.jsonl history from replaying into the cleared session (#109)", () => {
	const channelDir = mkdtempSync(join(tmpdir(), "iris-context-test-"));
	// Pre-reset conversation, permanently recorded in log.jsonl.
	writeLog(channelDir, [
		{ ts: "1", date: "2026-01-01T00:00:00.000Z", user: "U1", userName: "kat", text: "secret plan A", isBot: false },
		{ ts: "2", date: "2026-01-01T00:01:00.000Z", user: "U1", userName: "kat", text: "secret plan B", isBot: false },
	]);

	// User resets — context.jsonl is truncated (simulated: fresh empty session) and a watermark is written.
	const sessionManager = makeFakeSessionManager();
	writeResetWatermark(channelDir);
	const watermark = readResetWatermark(channelDir);

	// A new message arrives after the reset and gets logged.
	const log = readFileSync(join(channelDir, "log.jsonl"), "utf-8");
	writeFileSync(
		join(channelDir, "log.jsonl"),
		log + JSON.stringify({ ts: "3", date: new Date(Date.now() + 1000).toISOString(), user: "U1", userName: "kat", text: "fresh start", isBot: false }) + "\n",
	);

	const synced = syncLogToSessionManager(sessionManager, channelDir, undefined, watermark);

	// Only the post-reset message should have replayed — not the two pre-reset ones.
	assert.equal(synced, 1);
	assert.equal(sessionManager.entries.length, 1);
	const text = sessionManager.entries[0].message.content[0].text;
	assert.match(text, /fresh start/);
	assert.doesNotMatch(text, /secret plan/);
});

// ============================================================================
// SessionManager in-memory staleness (the deeper half of #109): channel
// runners are cached one-per-channel for the process lifetime (getOrCreateRunner
// in agent.ts), so the SessionManager instance reset() operates on is the same
// long-lived object every message in that channel reuses. SessionManager keeps
// its entries purely in memory (getEntries()/buildSessionContext() never touch
// disk) — a bare fs.writeFileSync() truncating context.jsonl out from under it
// doesn't clear that in-memory state at all, so agent.ts's reset() used to be a
// no-op for the live process: the very next message would rebuild
// agent.state.messages from the untouched entries and restore the full
// pre-reset conversation immediately, no restart required. The fix calls
// sessionManager.setSessionFile() after truncating, which forces a reload from
// the (now-empty) file and re-establishes a fresh session header.
// ============================================================================

test("SessionManager: a bare file truncation does NOT clear a live instance's in-memory entries", () => {
	const channelDir = mkdtempSync(join(tmpdir(), "iris-context-test-"));
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "old message" }], timestamp: Date.now() });

	writeFileSync(contextFile, ""); // what reset() used to do, alone

	assert.equal(sessionManager.getEntries().length, 1); // still there — this was the bug
	assert.equal(sessionManager.buildSessionContext().messages.length, 1);
});

test("SessionManager: setSessionFile() after truncation reloads and clears in-memory entries (the fix)", () => {
	const channelDir = mkdtempSync(join(tmpdir(), "iris-context-test-"));
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "old message" }], timestamp: Date.now() });

	writeFileSync(contextFile, "");
	sessionManager.setSessionFile(contextFile); // what reset() does now

	assert.equal(sessionManager.getEntries().length, 0);
	assert.equal(sessionManager.buildSessionContext().messages.length, 0);

	// And the file itself stays well-formed for a subsequent append (a fresh session header,
	// not orphaned entries pointing at a parent that no longer exists in the file). Persistence
	// to disk is deferred until an assistant message appears, so append one too.
	sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "genuinely new" }], timestamp: Date.now() });
	sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "reply" }], timestamp: Date.now() });
	assert.equal(sessionManager.getEntries().length, 2);
	const fileLines = readFileSync(contextFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(fileLines[0].type, "session");
	assert.ok(fileLines.some((l) => l.type === "message" && JSON.stringify(l.message).includes("genuinely new")));
	assert.ok(fileLines.some((l) => l.type === "message" && JSON.stringify(l.message).includes("reply")));
});
