/**
 * Wraps tools listed by an MCP server as Iris AgentTools.
 *
 * Names follow mcp__<server>__<tool> so provenance is visible in tool events
 * and collisions with built-in tools are impossible. Schemas are passed
 * through as plain JSON Schema — pi validates arguments with AJV, which
 * accepts them directly, but throws at call time on schemas it cannot
 * compile, so we pre-compile here and drop broken tools instead of breaking
 * the whole server.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import AjvModule from "ajv";
import { createHash } from "crypto";
import { truncateTail } from "../tools/truncate.js";
import type { McpServerConfig } from "./config.js";

// ajv ships CJS with a default-exported class; under Node16 ESM interop the
// constructor may sit on .default (same dance as pi-ai's validation.js).
type AjvLike = new (opts: object) => { compile(schema: unknown): unknown };
const Ajv = ((AjvModule as unknown as { default?: AjvLike }).default ?? AjvModule) as AjvLike;
const schemaChecker = new Ajv({ strict: false });

/** Maximum tool name length accepted by LLM providers (Anthropic: 128). */
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 1024;

/** Live per-server connection state the wrapped tools read at call time. */
export interface McpToolTarget {
	status: string;
	error?: string;
	client?: Client;
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

function sanitizeNamePart(part: string): string {
	return part.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpToolName(serverName: string, toolName: string): string {
	const name = `mcp__${sanitizeNamePart(serverName)}__${sanitizeNamePart(toolName)}`;
	if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
	const hash = createHash("sha256").update(name).digest("hex").substring(0, 4);
	return `${name.substring(0, MAX_TOOL_NAME_LENGTH - 5)}_${hash}`;
}

/** Match a tool name against an allowedTools entry (exact, or trailing-* prefix wildcard). */
function matchesFilter(toolName: string, pattern: string): boolean {
	if (pattern.endsWith("*")) {
		return toolName.startsWith(pattern.slice(0, -1));
	}
	return toolName === pattern;
}

export function isToolAllowed(toolName: string, allowedTools: string[] | undefined): boolean {
	if (!allowedTools) return true;
	return allowedTools.some((pattern) => matchesFilter(toolName, pattern));
}

interface McpContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	resource?: { uri?: string; mimeType?: string; text?: string };
}

/** Map an MCP CallToolResult content array to pi tool-result content. */
export function mapMcpContent(blocks: McpContentBlock[] | undefined): (TextContent | ImageContent)[] {
	const content: (TextContent | ImageContent)[] = [];
	const textParts: string[] = [];

	for (const block of blocks ?? []) {
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			content.push({ type: "image", data: block.data, mimeType: block.mimeType });
		} else if (block.type === "resource" && block.resource) {
			if (typeof block.resource.text === "string") {
				textParts.push(block.resource.text);
			} else {
				textParts.push(`[resource: ${block.resource.uri ?? "unknown"} (${block.resource.mimeType ?? "unknown type"})]`);
			}
		} else if (block.type === "resource_link") {
			textParts.push(`[resource link: ${block.uri ?? "unknown"}]`);
		} else {
			textParts.push(`[unsupported content type: ${block.type}]`);
		}
	}

	if (textParts.length > 0) {
		content.unshift({ type: "text", text: truncateTail(textParts.join("\n")).content });
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "(empty result)" });
	}
	return content;
}

function extractText(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

export interface WrapResult {
	tools: AgentTool<any>[];
	dropped: { name: string; reason: string }[];
}

/**
 * Wrap the tools of one MCP server. `target` is the manager's live server
 * state — execute() reads it at call time so a reconnected client is picked
 * up and a dead server produces a clear error instead of a hung call.
 */
export function wrapMcpTools(config: McpServerConfig, target: McpToolTarget, mcpTools: McpToolInfo[]): WrapResult {
	const tools: AgentTool<any>[] = [];
	const dropped: { name: string; reason: string }[] = [];

	for (const mcpTool of mcpTools) {
		if (!isToolAllowed(mcpTool.name, config.allowedTools)) continue;

		const parameters = (mcpTool.inputSchema as object | undefined) ?? { type: "object", properties: {} };
		try {
			// pi validates arguments by compiling this schema with AJV at call
			// time — a schema AJV rejects would fail every call, so drop it now.
			schemaChecker.compile(structuredClone(parameters));
		} catch (e) {
			dropped.push({ name: mcpTool.name, reason: `schema does not compile: ${(e as Error).message}` });
			continue;
		}

		let description = `[MCP:${config.name}] ${mcpTool.description ?? ""}`.trim();
		if (description.length > MAX_DESCRIPTION_LENGTH) {
			description = `${description.substring(0, MAX_DESCRIPTION_LENGTH - 3)}...`;
		}

		tools.push({
			name: mcpToolName(config.name, mcpTool.name),
			label: `${config.name}:${mcpTool.name}`,
			description,
			parameters: parameters as any,
			execute: async (_toolCallId: string, args: unknown, signal?: AbortSignal) => {
				if (target.status !== "connected" || !target.client) {
					throw new Error(`MCP server '${config.name}' is not connected${target.error ? `: ${target.error}` : ""}`);
				}
				const result = (await target.client.callTool(
					{ name: mcpTool.name, arguments: (args ?? {}) as Record<string, unknown> },
					undefined,
					{ timeout: config.timeoutMs, signal },
				)) as { content?: McpContentBlock[]; isError?: boolean };

				const content = mapMcpContent(result.content);
				if (result.isError) {
					throw new Error(extractText(content) || `MCP tool ${mcpTool.name} returned an error`);
				}
				return { content, details: { server: config.name, tool: mcpTool.name } };
			},
		});
	}

	return { tools, dropped };
}
