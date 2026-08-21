import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { resizeImageIfNeededAsync } from "../image-resize.js";
import { detectImageMimeType, MIME_SNIFF_BYTES } from "../mime.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

/**
 * Sniff whether a file is a supported image format from its magic bytes, not
 * its filename — a mislabeled or extensionless attachment (e.g. a Telegram
 * document with no name) would otherwise never be recognized. Reads only the
 * small header window sniffing needs, via the same executor as everything
 * else in this tool (the path may be inside a sandboxed container/VM, not
 * the host filesystem, so this can't just open() the file directly).
 * Returns undefined (not an error) if `path` doesn't exist — the caller's
 * existing text-read path below will surface that as its normal "no such
 * file" error instead.
 */
async function sniffImageMimeType(
	executor: Executor,
	path: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const head = await execBase64(executor, `head -c ${MIME_SNIFF_BYTES} ${shellEscape(path)}`, signal);
		return await detectImageMimeType(head);
	} catch {
		return undefined;
	}
}

/** Run a shell command whose stdout is base64, and decode it to a Buffer. Throws (with stderr) on failure. */
async function execBase64(executor: Executor, cmd: string, signal?: AbortSignal): Promise<Buffer> {
	const result = await executor.exec(`${cmd} | base64`, { signal });
	if (result.code !== 0) throw new Error(result.stderr || `Command failed: ${cmd}`);
	return Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
}

const readSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're reading and why (shown to user)" }),
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

interface ReadToolDetails {
	truncation?: TruncationResult;
}

export interface ReadToolOptions {
	/** Whether the active model's provider accepts image input. */
	supportsImageInput: boolean;
}

export function createReadTool(executor: Executor, options: ReadToolOptions): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp)${options.supportsImageInput ? "" : " — NOTE: the active model does not accept image input, so images will be reported as unreadable"}. Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const mimeType = await sniffImageMimeType(executor, path, signal);

			if (mimeType) {
				if (!options.supportsImageInput) {
					// Don't return an ImageContent block — pi-ai's provider layer filters
					// it out based on model.input before the request goes out, and the
					// model would otherwise see this as a successful read and confabulate
					// the image's contents.
					return {
						content: [
							{
								type: "text",
								text: `[${path}] is a ${mimeType} image, but the active model does not accept image input. Its contents cannot be read this way.`,
							},
						],
						details: undefined,
					};
				}

				// Read as image (binary) - use base64
				let imageData: Buffer;
				try {
					imageData = await execBase64(executor, `cat ${shellEscape(path)}`, signal);
				} catch (error) {
					throw new Error(error instanceof Error ? error.message : `Failed to read file: ${path}`);
				}

				// Downscale oversized images before they reach the model — same reasoning
				// as agent.ts's inbound-attachment path. Undefined means it couldn't be
				// decoded/shrunk under the ceiling; send the original and let the provider
				// decide rather than failing the read.
				const base64 = imageData.toString("base64");
				const resized = await resizeImageIfNeededAsync(base64, mimeType, signal);

				return {
					content: [
						{ type: "text", text: `Read image file [${resized?.mimeType ?? mimeType}]` },
						{ type: "image", data: resized?.data ?? base64, mimeType: resized?.mimeType ?? mimeType },
					],
					details: undefined,
				};
			}

			// Get total line count first
			const countResult = await executor.exec(`wc -l < ${shellEscape(path)}`, { signal });
			if (countResult.code !== 0) {
				throw new Error(countResult.stderr || `Failed to read file: ${path}`);
			}
			const totalFileLines = Number.parseInt(countResult.stdout.trim(), 10) + 1; // wc -l counts newlines, not lines

			// Apply offset if specified (1-indexed)
			const startLine = offset ? Math.max(1, offset) : 1;
			const startLineDisplay = startLine;

			// Check if offset is out of bounds
			if (startLine > totalFileLines) {
				throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
			}

			// Read content with offset
			let cmd: string;
			if (startLine === 1) {
				cmd = `cat ${shellEscape(path)}`;
			} else {
				cmd = `tail -n +${startLine} ${shellEscape(path)}`;
			}

			const result = await executor.exec(cmd, { signal });
			if (result.code !== 0) {
				throw new Error(result.stderr || `Failed to read file: ${path}`);
			}

			let selectedContent = result.stdout;
			let userLimitedLines: number | undefined;

			// Apply user limit if specified
			if (limit !== undefined) {
				const lines = selectedContent.split("\n");
				const endLine = Math.min(limit, lines.length);
				selectedContent = lines.slice(0, endLine).join("\n");
				userLimitedLines = endLine;
			}

			// Apply truncation (respects both line and byte limits)
			const truncation = truncateHead(selectedContent);

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				// First line at offset exceeds 50KB - tell model to use bash
				const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				// Truncation occurred - build actionable notice
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;

				outputText = truncation.content;

				if (truncation.truncatedBy === "lines") {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
				} else {
					outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
				}
				details = { truncation };
			} else if (userLimitedLines !== undefined) {
				// User specified limit, check if there's more content
				const linesFromStart = startLine - 1 + userLimitedLines;
				if (linesFromStart < totalFileLines) {
					const remaining = totalFileLines - linesFromStart;
					const nextOffset = startLine + userLimitedLines;

					outputText = truncation.content;
					outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
				} else {
					outputText = truncation.content;
				}
			} else {
				// No truncation, no user limit exceeded
				outputText = truncation.content;
			}

			return {
				content: [{ type: "text", text: outputText }],
				details,
			};
		},
	};
}

function shellEscape(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
