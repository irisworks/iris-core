// Regression suite for the attach tool's upload routing.
//
// The upload function used to be a module-level singleton that every run
// overwrote at start, so when two channels' runs overlapped, a slow run's
// `attach` uploaded through whichever channel started last (a.txt landing in
// the other chat). Each runner now owns its attach tool and its upload
// function; these tests pin that isolation without a model or a transport.
//
// Requires `npm run build` first (tests import ../dist/*.js).

import assert from "node:assert/strict";
import { test } from "node:test";
import { createAttachTool } from "../dist/engine/tools/attach.js";

/** A runner-like holder: its own attach tool plus a settable upload function. */
function makeRunner(uploads) {
	let upload = null;
	const tool = createAttachTool(() => upload);
	return {
		tool,
		configure(name) {
			upload = async (filePath, title) => {
				uploads.push({ runner: name, filePath, title });
			};
		},
	};
}

const attach = (runner, path) => runner.tool.execute("call-1", { label: "x", path });

test("attach: a run overlapped by another channel's run uploads via its own channel", async () => {
	const uploads = [];
	const a = makeRunner(uploads);
	const b = makeRunner(uploads);

	a.configure("A"); // A's turn starts (and is slow)
	b.configure("B"); // B's turn starts while A is still running

	await attach(a, "/workspace/a.txt"); // A finally reaches attach
	await attach(b, "/workspace/b.txt");

	assert.deepEqual(
		uploads.map((u) => [u.runner, u.title]),
		[
			["A", "a.txt"],
			["B", "b.txt"],
		],
	);
});

test("attach: a runner that was never configured does not borrow another runner's upload", async () => {
	const uploads = [];
	const a = makeRunner(uploads);
	const b = makeRunner(uploads);

	b.configure("B");

	await assert.rejects(attach(a, "/workspace/a.txt"), /Upload function not configured/);
	assert.equal(uploads.length, 0);
});

test("attach: reconfiguring a runner on its next turn replaces only its own upload function", async () => {
	const uploads = [];
	const a = makeRunner(uploads);
	const b = makeRunner(uploads);

	a.configure("A1");
	b.configure("B");
	a.configure("A2");

	await attach(a, "/workspace/a.txt");
	await attach(b, "/workspace/b.txt");

	assert.deepEqual(
		uploads.map((u) => u.runner),
		["A2", "B"],
	);
});

test("attach: an aborted call never uploads", async () => {
	const uploads = [];
	const a = makeRunner(uploads);
	a.configure("A");
	const ctrl = new AbortController();
	ctrl.abort();

	await assert.rejects(
		a.tool.execute("call-1", { label: "x", path: "/workspace/a.txt" }, ctrl.signal),
		/Operation aborted/,
	);
	assert.equal(uploads.length, 0);
});
