// Tests for the `task` tool (#253): the flag-off regression (task absent,
// other tools unchanged) and the isolation guarantee the whole design
// depends on — an inner task run's tool-call events must never reach the
// outer channel's ctx.respond/ctx.onToolEvent/runState.trace.recordTool
// surfaces, only local logs (log.logToolStart/Success/Error).
//
// Requires `npm run build` first (tests import ../dist/*.js).

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createIrisTools, createTaskToolsGetter } from "../dist/engine/tools/index.js";
import { runIsolatedTask } from "../dist/engine/tools/task.js";

function fakeExecutor() {
	return {
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		getWorkspacePath: (hostPath) => hostPath,
	};
}

function fakeTaskOptions(overrides = {}) {
	return {
		model: { provider: "fake", id: "fake-model", input: ["text"], contextWindow: 200000 },
		getApiKey: async () => "fake-key",
		convertToLlm: (messages) => messages,
		buildSystemPrompt: () => "fake system prompt",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Flag-off regression (issue #253 acceptance criteria)
// ---------------------------------------------------------------------------

test("createIrisTools: task tool absent when IRIS_TASKS_ENABLED is unset", () => {
	delete process.env.IRIS_TASKS_ENABLED;
	const tools = createIrisTools(fakeExecutor(), { supportsImageInput: false, workspaceDir: "/tmp" });
	assert.deepEqual(
		tools.map((t) => t.name),
		["read", "bash", "edit", "write", "attach", "read_full"],
	);
});

test("createIrisTools: task tool absent when IRIS_TASKS_ENABLED is unset even if task options are supplied", () => {
	delete process.env.IRIS_TASKS_ENABLED;
	const tools = createIrisTools(fakeExecutor(), {
		supportsImageInput: false,
		workspaceDir: "/tmp",
		task: fakeTaskOptions(),
	});
	assert.ok(!tools.some((t) => t.name === "task"));
	assert.deepEqual(
		tools.map((t) => t.name),
		["read", "bash", "edit", "write", "attach", "read_full"],
	);
});

test("createIrisTools: task tool absent when IRIS_TASKS_ENABLED=false", () => {
	process.env.IRIS_TASKS_ENABLED = "false";
	try {
		const tools = createIrisTools(fakeExecutor(), {
			supportsImageInput: false,
			workspaceDir: "/tmp",
			task: fakeTaskOptions(),
		});
		assert.ok(!tools.some((t) => t.name === "task"));
	} finally {
		delete process.env.IRIS_TASKS_ENABLED;
	}
});

test("createIrisTools: task tool present when IRIS_TASKS_ENABLED=true and task options supplied", () => {
	process.env.IRIS_TASKS_ENABLED = "true";
	try {
		const tools = createIrisTools(fakeExecutor(), {
			supportsImageInput: false,
			workspaceDir: "/tmp",
			task: fakeTaskOptions(),
		});
		assert.deepEqual(
			tools.map((t) => t.name),
			["read", "bash", "edit", "write", "attach", "read_full", "task"],
		);
	} finally {
		delete process.env.IRIS_TASKS_ENABLED;
	}
});

test("createIrisTools: task tool absent (and other tools unchanged) with no task option, flag true", () => {
	process.env.IRIS_TASKS_ENABLED = "true";
	try {
		const tools = createIrisTools(fakeExecutor(), { supportsImageInput: false, workspaceDir: "/tmp" });
		assert.deepEqual(
			tools.map((t) => t.name),
			["read", "bash", "edit", "write", "attach", "read_full"],
		);
	} finally {
		delete process.env.IRIS_TASKS_ENABLED;
	}
});

// ---------------------------------------------------------------------------
// Isolation guarantee
// ---------------------------------------------------------------------------

/** Minimal fake usage block satisfying pi-ai's Usage shape. */
function fakeUsage() {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** A streamFn (pi-agent-core's LLM call seam) that plays back a fixed script
 * of assistant turns: first a tool call, then a final text-only stop. Lets us
 * drive the inner Agent's full tool-execution lifecycle deterministically,
 * with no network/model involved. */
function scriptedStreamFn(turns) {
	let i = 0;
	return async () => {
		const finalMessage = turns[i++];
		if (!finalMessage) throw new Error("scriptedStreamFn: ran out of scripted turns");
		return {
			[Symbol.asyncIterator]() {
				let done = false;
				return {
					async next() {
						if (done) return { done: true, value: undefined };
						done = true;
						return { done: false, value: { type: "done" } };
					},
				};
			},
			result: async () => finalMessage,
		};
	};
}

function toolCallTurn(toolName, args) {
	return {
		role: "assistant",
		api: "messages",
		provider: "fake",
		model: "fake-model",
		usage: fakeUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
		content: [{ type: "toolCall", id: "tc1", name: toolName, arguments: args }],
	};
}

function finalTextTurn(text) {
	return {
		role: "assistant",
		api: "messages",
		provider: "fake",
		model: "fake-model",
		usage: fakeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		content: [{ type: "text", text }],
	};
}

test("runIsolatedTask: inner tool events never reach outer respond/onToolEvent/recordTool — only local logs and the final text return", async () => {
	// Everything an outer channel session (agent.ts's session.subscribe) would
	// normally be wired to. runIsolatedTask's signature never even accepts
	// these — isolation is structural — but we assert none of them are ever
	// invoked by anything reachable from a task run, including indirectly.
	const outerSpies = {
		respondCalls: [],
		onToolEventCalls: [],
		recordToolCalls: [],
	};
	const ctx = {
		respond: (text) => outerSpies.respondCalls.push(text),
		onToolEvent: (event) => outerSpies.onToolEventCalls.push(event),
	};
	const runStateTrace = {
		recordTool: (entry) => outerSpies.recordToolCalls.push(entry),
	};

	let fakeToolCalls = 0;
	const fakeTool = {
		name: "fake-bash",
		label: "fake-bash",
		description: "records a call and returns canned output",
		parameters: { type: "object", properties: { label: { type: "string" }, command: { type: "string" } } },
		execute: async () => {
			fakeToolCalls++;
			// A tool implementation has no reference to ctx/runState at all in
			// this test — there is nothing here it COULD call outer surfaces
			// with, which is exactly the isolation property under test.
			return { content: [{ type: "text", text: "fake output" }], details: undefined };
		},
	};

	const streamFn = scriptedStreamFn([
		toolCallTurn("fake-bash", { label: "do the thing", command: "echo hi" }),
		finalTextTurn("Task complete: did the thing."),
	]);

	const result = await runIsolatedTask(
		fakeTaskOptions({ getTools: () => [fakeTool], streamFn, maxMs: 5000 }),
		"do the thing",
		"do the thing",
	);

	assert.equal(result, "Task complete: did the thing.");
	assert.equal(fakeToolCalls, 1, "the inner tool should have executed exactly once");

	// The isolation guarantee: nothing from the inner run reached the outer
	// channel surfaces, because runIsolatedTask never received references to
	// them and its own subscription only calls log.logToolStart/Success/Error.
	assert.deepEqual(outerSpies.respondCalls, []);
	assert.deepEqual(outerSpies.onToolEventCalls, []);
	assert.deepEqual(outerSpies.recordToolCalls, []);
	// Sanity: ctx/runStateTrace were never even referenced by runIsolatedTask —
	// confirm they're still untouched fresh objects.
	assert.equal(typeof ctx.respond, "function");
	assert.equal(typeof runStateTrace.recordTool, "function");
});

test("runIsolatedTask: a thrown error inside the inner run surfaces as 'task failed: ...'", async () => {
	const throwingStreamFn = async () => {
		throw new Error("boom");
	};
	await assert.rejects(
		() => runIsolatedTask(fakeTaskOptions({ getTools: () => [], streamFn: throwingStreamFn }), "do it", "do it"),
		(err) => {
			assert.match(err.message, /^task failed: /);
			return true;
		},
	);
});

test("runIsolatedTask: exceeding maxMs aborts and surfaces as a timeout tool error", async () => {
	// A streamFn that never resolves — the inner run should be aborted by the
	// maxMs ceiling rather than hang forever.
	const hangingStreamFn = () => new Promise(() => {});
	await assert.rejects(
		() => runIsolatedTask(fakeTaskOptions({ getTools: () => [], streamFn: hangingStreamFn, maxMs: 50 }), "do it", "do it"),
		(err) => {
			assert.match(err.message, /^task failed: exceeded 50ms limit$/);
			return true;
		},
	);
});

test("runIsolatedTask: an external AbortSignal cancels the inner run immediately, without waiting for maxMs", async () => {
	// Before the fix, a caller's AbortSignal (the outer channel's stop command,
	// forwarded through the `task` tool's execute(signal)) had no path into
	// runIsolatedTask at all — only the maxMs timer could ever end a run early.
	// This streamFn mirrors how a real one (pi-agent-core passes {..., signal}
	// as its 3rd arg) reacts to abort: it never produces a response on its own,
	// only rejects once the run's AbortSignal fires — exactly what should
	// happen when runIsolatedTask forwards our caller-supplied signal into
	// innerAgent.abort().
	const hangingButAbortableStreamFn = (_model, _context, options) => ({
		[Symbol.asyncIterator]() {
			return {
				next: () =>
					new Promise((_resolve, reject) => {
						if (options.signal?.aborted) {
							reject(new Error("stream aborted"));
							return;
						}
						options.signal?.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
					}),
			};
		},
		result: async () => {
			throw new Error("result() should not be reached — the iterator should reject first");
		},
	});
	const controller = new AbortController();
	const start = Date.now();
	const rejection = assert.rejects(
		() =>
			runIsolatedTask(
				fakeTaskOptions({ getTools: () => [], streamFn: hangingButAbortableStreamFn, maxMs: 60000 }),
				"do it",
				"do it",
				controller.signal,
			),
		(err) => {
			assert.match(err.message, /^task failed: /);
			return true;
		},
	);
	// Give runIsolatedTask a moment to actually start the inner prompt() call
	// and reach the streamFn's next() before we abort — aborting too early
	// (before the fake's own listener is attached) would only prove the race
	// went our way, not that the signal is forwarded correctly.
	await new Promise((resolve) => setTimeout(resolve, 20));
	controller.abort();
	await rejection;
	assert.ok(Date.now() - start < 5000, "abort should end the run well before the 60s maxMs ceiling");
});

test("createIrisTools: the task tool sees currently-connected MCP tools, not a permanent pre-MCP snapshot", async () => {
	// Before the fix, `task`'s tool array was captured once at createIrisTools()
	// time — before agent.ts's per-turn `agent.state.tools = [...tools,
	// ...mcpManager.getTools()]` merge ever runs — so an MCP tool configured
	// for the channel was invisible inside every task, silently. getMcpTools
	// is called fresh on every task invocation so it always reflects whatever
	// the outer agent currently has connected.
	process.env.IRIS_TASKS_ENABLED = "true";
	try {
		let mcpToolCalls = 0;
		const mcpTool = {
			name: "mcp-search",
			label: "mcp-search",
			description: "a tool that only exists because an MCP server is connected",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				mcpToolCalls++;
				return { content: [{ type: "text", text: "mcp result" }], details: undefined };
			},
		};
		const streamFn = scriptedStreamFn([toolCallTurn("mcp-search", {}), finalTextTurn("Found it via MCP.")]);
		const tools = createIrisTools(fakeExecutor(), {
			supportsImageInput: false,
			workspaceDir: "/tmp",
			task: fakeTaskOptions({ streamFn, getMcpTools: () => [mcpTool] }),
		});
		const taskTool = tools.find((t) => t.name === "task");
		const result = await taskTool.execute("tc1", { label: "search", prompt: "find it" });
		assert.equal(mcpToolCalls, 1, "the MCP tool should have been callable, and called, from inside the task");
		assert.equal(result.content[0].text, "Found it via MCP.");
	} finally {
		delete process.env.IRIS_TASKS_ENABLED;
	}
});

test("runIsolatedTask: a call past IRIS_TASK_MAX_CONCURRENT fails immediately instead of queuing or running unbounded", async () => {
	// Before this, nothing capped how many `task` calls could be in flight at
	// once — a single turn firing off several investigative tasks (pi-agent-core
	// can execute a turn's tool calls in parallel) had no circuit breaker, each
	// one a full second Agent with its own LLM calls and up-to-5-minute ceiling.
	const originalMax = process.env.IRIS_TASK_MAX_CONCURRENT;
	process.env.IRIS_TASK_MAX_CONCURRENT = "1";
	try {
		let releaseTaskA;
		const gate = new Promise((resolve) => {
			releaseTaskA = resolve;
		});
		const gatedStreamFn = async (...args) => {
			await gate;
			return scriptedStreamFn([finalTextTurn("A done")])(...args);
		};

		const taskA = runIsolatedTask(fakeTaskOptions({ getTools: () => [], streamFn: gatedStreamFn }), "do a", "task a");

		// Give task A a moment to actually start (and increment the in-flight
		// counter) before task B is attempted, so this isn't racing task A's own
		// startup.
		await new Promise((resolve) => setTimeout(resolve, 20));

		await assert.rejects(
			() =>
				runIsolatedTask(
					fakeTaskOptions({ getTools: () => [], streamFn: scriptedStreamFn([finalTextTurn("B done")]) }),
					"do b",
					"task b",
				),
			(err) => {
				assert.match(err.message, /^task failed: 1 tasks are already running \(max 1\)/);
				return true;
			},
		);

		releaseTaskA();
		assert.equal(await taskA, "A done");

		// Task A finished and released its slot — a new call should succeed again.
		const resultC = await runIsolatedTask(
			fakeTaskOptions({ getTools: () => [], streamFn: scriptedStreamFn([finalTextTurn("C done")]) }),
			"do c",
			"task c",
		);
		assert.equal(resultC, "C done");
	} finally {
		if (originalMax === undefined) {
			delete process.env.IRIS_TASK_MAX_CONCURRENT;
		} else {
			process.env.IRIS_TASK_MAX_CONCURRENT = originalMax;
		}
	}
});

test("task-mode bash: a confirm-gated command is refused without touching the channel's confirmation state", async () => {
	// A task has no live turn a human can answer, so a destructive command
	// inside one must not leave a pending grant on the real channel (which a
	// later unrelated "ok" would silently approve) nor consume a grant the
	// human gave the outer turn.
	const channelDir = mkdtempSync(join(tmpdir(), "iris-task-bash-"));
	const channelId = "tg-task-confirm";
	const command = "terraform destroy";
	const calls = [];
	const executor = {
		exec: async (cmd) => {
			calls.push(cmd);
			return { stdout: "", stderr: "", code: 0 };
		},
		getWorkspacePath: (p) => p,
	};
	const appendHumanYes = () =>
		appendFileSync(
			join(channelDir, "log.jsonl"),
			`${JSON.stringify({ date: new Date().toISOString(), user: "U1", text: "ok", isBot: false })}\n`,
		);
	try {
		const options = { supportsImageInput: false, workspaceDir: channelDir, channelId, channelDir };
		const taskBash = createTaskToolsGetter(executor, options)().find((t) => t.name === "bash");
		const outerBash = createIrisTools(executor, options).find((t) => t.name === "bash");

		// 1. Refused inside the task, and no pending request is recorded: a later
		// human "ok" must not pre-authorize it for the outer agent.
		await assert.rejects(
			() => taskBash.execute("c1", { label: "t", command }),
			/cannot be confirmed from inside a task/,
		);
		appendHumanYes();
		await assert.rejects(() => outerBash.execute("c2", { label: "t", command }), /Ask the user/);

		// 2. A grant the human gave the outer turn is not consumed by a task.
		appendHumanYes();
		await assert.rejects(
			() => taskBash.execute("c3", { label: "t", command }),
			/cannot be confirmed from inside a task/,
		);
		await outerBash.execute("c4", { label: "t", command });
		assert.deepEqual(calls, [command], "only the outer, human-confirmed run executes");
	} finally {
		rmSync(channelDir, { recursive: true, force: true });
	}
});

test("createTaskToolsGetter: task-less tool array plus live MCP tools (shared by the task tool and --as-task events)", () => {
	process.env.IRIS_TASKS_ENABLED = "true";
	try {
		let mcpTools = [];
		const getTools = createTaskToolsGetter(fakeExecutor(), {
			supportsImageInput: false,
			workspaceDir: "/tmp",
			task: fakeTaskOptions({ streamFn: scriptedStreamFn([]), getMcpTools: () => mcpTools }),
		});
		assert.deepEqual(getTools().map((t) => t.name), ["read", "bash", "edit", "write", "attach", "read_full"]);
		mcpTools = [{ name: "mcp-search" }];
		assert.deepEqual(getTools().map((t) => t.name).at(-1), "mcp-search");
	} finally {
		delete process.env.IRIS_TASKS_ENABLED;
	}
});
