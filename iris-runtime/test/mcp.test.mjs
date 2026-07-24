// MCP server support: config loading (fail-safe, ${VAR} expansion), tool
// wrapping (naming, filtering, content mapping, schema pre-compilation), and
// the McpManager lifecycle against a real stdio server
// (test/fixtures/mcp-echo-server.mjs).
// Drives the compiled dist/ output — run `npm run build` first.

import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpConfig, mcpToolName, isToolAllowed, mapMcpContent, wrapMcpTools, McpManager } from "../dist/engine/mcp/index.js";

const FIXTURE_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-echo-server.mjs");

function makeWorkspace(config) {
	const workingDir = mkdtempSync(join(tmpdir(), "iris-mcp-test-"));
	mkdirSync(join(workingDir, "meta"), { recursive: true });
	if (config !== undefined) {
		writeFileSync(join(workingDir, "meta", "mcp.json"), typeof config === "string" ? config : JSON.stringify(config));
	}
	return workingDir;
}

// Managers opened by tests, shut down once at the end so stdio children die.
const managers = [];
after(async () => {
	for (const m of managers) await m.shutdown();
});

// ── config loading ──────────────────────────────────────────────────────────

test("config: absent file → zero servers, empty hash, no errors", () => {
	const config = loadMcpConfig(makeWorkspace(undefined));
	assert.deepEqual(config, { servers: [], invalid: [], errors: [], hash: "" });
});

test("config: malformed JSON → file-level error, never throws", () => {
	const config = loadMcpConfig(makeWorkspace("{not json"));
	assert.equal(config.servers.length, 0);
	assert.equal(config.errors.length, 1);
	assert.match(config.errors[0], /malformed JSON/);
	assert.notEqual(config.hash, "");
});

test("config: invalid entries are isolated per server", () => {
	const config = loadMcpConfig(
		makeWorkspace({
			servers: {
				good: { transport: "stdio", command: "echo" },
				badTransport: { transport: "websocket", command: "echo" },
				noCommand: { transport: "stdio" },
				noUrl: { transport: "http" },
			},
		}),
	);
	assert.deepEqual(config.servers.map((s) => s.name), ["good"]);
	assert.deepEqual(config.invalid.map((s) => s.name).sort(), ["badTransport", "noCommand", "noUrl"]);
});

test("config: defaults applied", () => {
	const config = loadMcpConfig(makeWorkspace({ servers: { s: { transport: "stdio", command: "echo" } } }));
	const server = config.servers[0];
	assert.equal(server.enabled, true);
	assert.equal(server.timeoutMs, 30000);
	assert.equal(server.connectTimeoutMs, 10000);
	assert.deepEqual(server.args, []);
});

test("config: ${VAR} expansion from process.env; unset var fails only that server", () => {
	process.env.IRIS_MCP_TEST_TOKEN = "sekret";
	try {
		const config = loadMcpConfig(
			makeWorkspace({
				servers: {
					withToken: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${IRIS_MCP_TEST_TOKEN}" } },
					missingVar: { transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${IRIS_MCP_TEST_UNSET_VAR}" } },
				},
			}),
		);
		assert.equal(config.servers.length, 1);
		assert.equal(config.servers[0].headers.Authorization, "Bearer sekret");
		assert.equal(config.invalid.length, 1);
		assert.equal(config.invalid[0].name, "missingVar");
		assert.match(config.invalid[0].error, /IRIS_MCP_TEST_UNSET_VAR not set/);
	} finally {
		delete process.env.IRIS_MCP_TEST_TOKEN;
	}
});

// ── tool wrapping ───────────────────────────────────────────────────────────

test("tool names: sanitized, prefixed, capped at 128 chars with stable hash suffix", () => {
	assert.equal(mcpToolName("linear", "list_issues"), "mcp__linear__list_issues");
	assert.equal(mcpToolName("my server!", "do.thing"), "mcp__my_server___do_thing");
	const long = mcpToolName("server", "x".repeat(200));
	assert.equal(long.length, 128);
	assert.equal(long, mcpToolName("server", "x".repeat(200)));
});

test("allowedTools: exact match and trailing-* prefix wildcard", () => {
	assert.equal(isToolAllowed("echo", undefined), true);
	assert.equal(isToolAllowed("echo", ["echo"]), true);
	assert.equal(isToolAllowed("echo", ["get*"]), false);
	assert.equal(isToolAllowed("get_issue", ["get*"]), true);
});

test("content mapping: text, image, resource, resource_link, empty", () => {
	const mapped = mapMcpContent([
		{ type: "text", text: "hello" },
		{ type: "image", data: "aGk=", mimeType: "image/png" },
		{ type: "resource", resource: { uri: "file:///x", text: "embedded" } },
		{ type: "resource_link", uri: "https://example.com/r" },
	]);
	assert.equal(mapped[0].type, "text");
	assert.match(mapped[0].text, /hello/);
	assert.match(mapped[0].text, /embedded/);
	assert.match(mapped[0].text, /resource link: https:\/\/example.com\/r/);
	assert.deepEqual(mapped[1], { type: "image", data: "aGk=", mimeType: "image/png" });

	assert.deepEqual(mapMcpContent([]), [{ type: "text", text: "(empty result)" }]);
	assert.deepEqual(mapMcpContent(undefined), [{ type: "text", text: "(empty result)" }]);
});

const stubConfig = { name: "stub", transport: "stdio", enabled: true, timeoutMs: 1000, connectTimeoutMs: 1000 };

test("wrapMcpTools: drops tools whose schema AJV cannot compile, keeps the rest", () => {
	const { tools, dropped } = wrapMcpTools(stubConfig, { status: "connected" }, [
		{ name: "ok", description: "fine", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
		{ name: "broken", inputSchema: { type: "object", properties: { a: { type: "not-a-type" } } } },
	]);
	assert.deepEqual(tools.map((t) => t.name), ["mcp__stub__ok"]);
	assert.equal(dropped.length, 1);
	assert.equal(dropped[0].name, "broken");
});

test("wrapMcpTools: execute throws clearly when server is not connected", async () => {
	const target = { status: "failed", error: "kaboom" };
	const { tools } = wrapMcpTools(stubConfig, target, [{ name: "t", inputSchema: { type: "object" } }]);
	await assert.rejects(() => tools[0].execute("id", {}), /not connected: kaboom/);
});

test("wrapMcpTools: isError result becomes a thrown error", async () => {
	const target = {
		status: "connected",
		client: { callTool: async () => ({ content: [{ type: "text", text: "server exploded" }], isError: true }) },
	};
	const { tools } = wrapMcpTools(stubConfig, target, [{ name: "t", inputSchema: { type: "object" } }]);
	await assert.rejects(() => tools[0].execute("id", {}), /server exploded/);
});

// ── manager lifecycle against a real stdio server ───────────────────────────

function echoServerEntry(extra = {}) {
	return { transport: "stdio", command: process.execPath, args: [FIXTURE_SERVER], ...extra };
}

test("manager: connects a stdio server, wraps tools, round-trips a call", async () => {
	const workingDir = makeWorkspace({ servers: { echo: echoServerEntry() } });
	const manager = new McpManager(workingDir);
	managers.push(manager);

	await manager.refresh();
	const status = manager.getStatus();
	assert.equal(status.servers.length, 1);
	assert.equal(status.servers[0].status, "connected");
	assert.deepEqual(status.servers[0].toolNames.sort(), ["mcp__echo__echo", "mcp__echo__fail"]);

	const echo = manager.getTools().find((t) => t.name === "mcp__echo__echo");
	const result = await echo.execute("call-1", { message: "hi" });
	assert.equal(result.content[0].text, "echo: hi");
	assert.deepEqual(result.details, { server: "echo", tool: "echo" });

	const fail = manager.getTools().find((t) => t.name === "mcp__echo__fail");
	await assert.rejects(() => fail.execute("call-2", {}), /boom/);
});

test("manager: refresh is a no-op while mcp.json is unchanged, reconciles on change", async () => {
	const workingDir = makeWorkspace({ servers: { echo: echoServerEntry() } });
	const manager = new McpManager(workingDir);
	managers.push(manager);

	await manager.refresh();
	const toolsBefore = manager.getTools();
	await manager.refresh();
	// Same object references = no reconnect/re-wrap happened
	assert.equal(manager.getTools()[0], toolsBefore[0]);

	writeFileSync(
		join(workingDir, "meta", "mcp.json"),
		JSON.stringify({ servers: { echo: echoServerEntry({ allowedTools: ["echo"] }) } }),
	);
	await manager.refresh();
	assert.deepEqual(manager.getTools().map((t) => t.name), ["mcp__echo__echo"]);
});

test("manager: bad command and invalid entry fail in isolation; refresh never throws", async () => {
	const workingDir = makeWorkspace({
		servers: {
			echo: echoServerEntry(),
			broken: { transport: "stdio", command: "/nonexistent-cmd-iris-mcp-test", connectTimeoutMs: 3000 },
			invalid: { transport: "http" },
		},
	});
	const manager = new McpManager(workingDir);
	managers.push(manager);

	await manager.refresh();
	const byName = Object.fromEntries(manager.getStatus().servers.map((s) => [s.name, s]));
	assert.equal(byName.echo.status, "connected");
	assert.equal(byName.broken.status, "failed");
	assert.equal(byName.invalid.status, "failed");
	assert.match(byName.invalid.error, /requires a url/);
	// Only the healthy server contributes tools
	assert.deepEqual(manager.getTools().map((t) => t.name).sort(), ["mcp__echo__echo", "mcp__echo__fail"]);
});

test("manager: disabled server is listed but not connected; shutdown clears everything", async () => {
	const workingDir = makeWorkspace({ servers: { echo: echoServerEntry({ enabled: false }) } });
	const manager = new McpManager(workingDir);
	managers.push(manager);

	await manager.refresh();
	assert.equal(manager.getStatus().servers[0].status, "disabled");
	assert.equal(manager.getTools().length, 0);

	await manager.shutdown();
	assert.equal(manager.getStatus().servers.length, 0);
});
