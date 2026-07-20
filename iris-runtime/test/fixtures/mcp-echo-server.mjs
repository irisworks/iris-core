// Minimal stdio MCP server for the mcp.test.mjs integration tests.
// Lives in test/fixtures (not a temp dir) so ESM resolution finds
// @modelcontextprotocol/sdk via the repo's node_modules.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "iris-test-server", version: "1.0.0" });

server.tool("echo", { message: z.string() }, async ({ message }) => ({
	content: [{ type: "text", text: `echo: ${message}` }],
}));

server.tool("fail", {}, async () => ({
	content: [{ type: "text", text: "boom" }],
	isError: true,
}));

await server.connect(new StdioServerTransport());
