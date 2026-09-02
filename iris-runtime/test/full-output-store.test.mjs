// full-output-store.ts — id-keyed persistence for truncated tool output (#159).
//
// Requires `npm run build` first (tests import ../dist/*.js).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { persistFullOutput, readFullOutput } from "../dist/engine/tools/full-output-store.js";

function makeChannelDir() {
	return mkdtempSync(join(tmpdir(), "iris-full-output-store-test-"));
}

test("full-output-store: persists content and reads it back by id", () => {
	const channelDir = makeChannelDir();
	try {
		const id = persistFullOutput(channelDir, "hello full output");
		assert.match(id, /^[0-9a-f]{16}$/);
		assert.equal(readFullOutput(channelDir, id), "hello full output");
		assert.ok(existsSync(join(channelDir, "tool-output", `${id}.txt`)));
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("full-output-store: unknown id returns undefined", () => {
	const channelDir = makeChannelDir();
	try {
		assert.equal(readFullOutput(channelDir, "0123456789abcdef"), undefined);
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("full-output-store: malformed id is rejected without touching the filesystem", () => {
	const channelDir = makeChannelDir();
	try {
		assert.equal(readFullOutput(channelDir, "../../etc/passwd"), undefined);
		assert.equal(readFullOutput(channelDir, "not-hex"), undefined);
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("full-output-store: falls back to the OS temp dir when no channelDir is given", () => {
	const id = persistFullOutput(undefined, "headless caller content");
	assert.equal(readFullOutput(undefined, id), "headless caller content");
	rmSync(join(tmpdir(), "tool-output", `${id}.txt`), { force: true });
});

test("full-output-store: persisting identical content twice reuses the same id/file (dedup)", () => {
	const channelDir = makeChannelDir();
	try {
		const id1 = persistFullOutput(channelDir, "same content");
		const id2 = persistFullOutput(channelDir, "same content");
		assert.equal(id1, id2);
		assert.equal(readFullOutput(channelDir, id1), "same content");
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("full-output-store: re-persisting identical content refreshes its retention (touches mtime)", () => {
	const channelDir = makeChannelDir();
	try {
		const id = persistFullOutput(channelDir, "kept alive");
		const path = join(channelDir, "tool-output", `${id}.txt`);
		const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
		utimesSync(path, oldTime, oldTime);

		persistFullOutput(channelDir, "kept alive");

		assert.ok(statSync(path).mtimeMs > Date.now() - 60_000);
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("full-output-store: sweeps entries older than the retention window on next write", () => {
	const channelDir = makeChannelDir();
	try {
		// Plant the stale entry directly rather than via persistFullOutput: the
		// sweep is throttled to once per store dir per interval, so a prior
		// persistFullOutput call against this same (fresh, never-swept) dir would
		// consume that dir's "next write" sweep before the entry aged out.
		const dir = join(channelDir, "tool-output");
		mkdirSync(dir, { recursive: true });
		const stalePath = join(dir, "aaaaaaaaaaaaaaaa.txt");
		writeFileSync(stalePath, "stale");
		const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
		utimesSync(stalePath, oldTime, oldTime);

		process.env.IRIS_FULL_OUTPUT_RETENTION_MS = String(24 * 60 * 60 * 1000);
		try {
			persistFullOutput(channelDir, "fresh");
		} finally {
			delete process.env.IRIS_FULL_OUTPUT_RETENTION_MS;
		}

		assert.equal(existsSync(stalePath), false);
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});
