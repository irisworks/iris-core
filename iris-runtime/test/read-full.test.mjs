// read-full.ts — the read_full(id) tool that retrieves persisted full output (#159).
//
// Requires `npm run build` first (tests import ../dist/*.js).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { persistFullOutput } from "../dist/engine/tools/full-output-store.js";
import { createReadFullTool } from "../dist/engine/tools/read-full.js";

function makeChannelDir() {
	return mkdtempSync(join(tmpdir(), "iris-read-full-test-"));
}

test("read_full: returns the full content for a saved id", async () => {
	const channelDir = makeChannelDir();
	try {
		const id = persistFullOutput(channelDir, "line1\nline2\nline3");
		const tool = createReadFullTool({ channelDir });
		const result = await tool.execute("call-1", { label: "x", id });
		assert.equal(result.content[0].text, "line1\nline2\nline3");
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("read_full: throws a clear error for an unknown id", async () => {
	const channelDir = makeChannelDir();
	try {
		const tool = createReadFullTool({ channelDir });
		await assert.rejects(() => tool.execute("call-1", { label: "x", id: "0123456789abcdef" }), /No saved output found/);
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("read_full: paginates large saved output by byte offset, and the chunks concatenate back to the original", async () => {
	const channelDir = makeChannelDir();
	try {
		const content = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
		const id = persistFullOutput(channelDir, content);
		const tool = createReadFullTool({ channelDir });

		let offset;
		let reassembled = "";
		do {
			const result = await tool.execute("call-1", { label: "x", id, offset });
			const [chunk, notice] = result.content[0].text.split("\n\n[");
			reassembled += chunk;
			const match = notice?.match(/offset=(\d+)/);
			offset = match ? Number(match[1]) : undefined;
		} while (offset !== undefined);

		assert.equal(reassembled, content);
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("read_full: single-line content with no newlines (e.g. compact JSON) still paginates correctly", async () => {
	const channelDir = makeChannelDir();
	try {
		const items = Array.from({ length: 5000 }, (_, i) => ({ id: i, value: `item-${i}` }));
		const rawJson = JSON.stringify(items);
		const id = persistFullOutput(channelDir, rawJson);
		const tool = createReadFullTool({ channelDir });

		const first = await tool.execute("call-1", { label: "x", id });
		assert.ok(first.content[0].text.startsWith('[{"id":0,'), "must be raw JSON content, not a structural summary");
		assert.ok(!first.content[0].text.includes("_arrayLength"));
		assert.match(first.content[0].text, /Use offset=\d+ to continue/);
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("read_full: offset beyond the end throws", async () => {
	const channelDir = makeChannelDir();
	try {
		const id = persistFullOutput(channelDir, "only one line");
		const tool = createReadFullTool({ channelDir });
		await assert.rejects(() => tool.execute("call-1", { label: "x", id, offset: 100 }), /beyond end of saved output/);
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});
