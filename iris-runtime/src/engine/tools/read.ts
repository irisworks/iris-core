import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Executor } from "../sandbox.js";
import { resizeImageIfNeededAsync } from "../image-resize.js";
import { detectImageMimeType, detectMimeType, MIME_SNIFF_BYTES } from "../mime.js";
import { loadReadHandlerRegistry, renderHandlerCommand } from "../read-handlers.js";
import { persistFullOutput } from "./full-output-store.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateForToolOutput, type TruncationResult } from "./truncate.js";

/**
 * Sniff a file's type from its magic bytes, not its filename — a mislabeled
 * or extensionless attachment (e.g. a Telegram document with no name) would
 * otherwise never be recognized. Reads only the small header window sniffing
 * needs, via the same executor as everything else in this tool (the path may
 * be inside a sandboxed container/VM, not the host filesystem, so this can't
 * just open() the file directly). Returns all-undefined (not an error) if
 * `path` doesn't exist — the caller's existing text-read path below will
 * surface that as its normal "no such file" error instead.
 */
async function sniffFileType(
	executor: Executor,
	path: string,
	signal?: AbortSignal,
): Promise<{ imageMimeType: string | undefined; mimeType: string | undefined }> {
	try {
		const head = await execBase64(executor, `head -c ${MIME_SNIFF_BYTES} ${shellEscape(path)}`, signal);
		const imageMimeType = await detectImageMimeType(head);
		const mimeType = imageMimeType ?? (await detectMimeType(head));
		return { imageMimeType, mimeType };
	} catch {
		return { imageMimeType: undefined, mimeType: undefined };
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
	/** Host workspace root — read-handlers are discovered from `<workspaceDir>/read-handlers/`. */
	workspaceDir: string;
	/** Channel dir to persist full output under when a JSON structural summary
	 * discards raw content that offset/limit paging can't get back (#159). */
	channelDir?: string;
}

export function createReadTool(executor: Executor, options: ReadToolOptions): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files, images (jpg, png, gif, webp)${options.supportsImageInput ? "" : " — NOTE: the active model does not accept image input, so images will be reported as unreadable"}, and any format with an installed read-handler (PDF text layer out of the box — scanned/image-only PDFs read back empty). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
		parameters: readSchema,
		execute: async (
			_toolCallId: string,
			{ path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
		): Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }> => {
			const { imageMimeType, mimeType } = await sniffFileType(executor, path, signal);

			// Re-scanned per read, not cached at tool construction, so a handler
			// dropped into read-handlers/ (core-shipped or overlay) hot-reloads
			// the same way skills do — no restart needed. A handler only occupies an
			// image mimeType slot here if it opted in via overridesBuiltinImageHandling
			// (see read-handlers.ts) — otherwise the built-in image path below always wins.
			const handler = mimeType ? loadReadHandlerRegistry(options.workspaceDir).get(mimeType) : undefined;
			if (handler) {
				const result = await executor.exec(renderHandlerCommand(handler, path), {
					signal,
					timeout: handler.timeoutSeconds,
				});
				if (result.code !== 0) {
					throw new Error(result.stderr || `read-handler "${handler.name}" failed on: ${path}`);
				}
				// Apply the same offset/limit paging the plain-text path below supports,
				// so handler output isn't a dead end for offset/limit despite the tool
				// description promising it for large files.
				const handlerLines = result.stdout.split("\n");
				const totalHandlerLines = handlerLines.length;
				const handlerStartLine = offset ? Math.max(1, offset) : 1;
				if (handlerStartLine > totalHandlerLines) {
					throw new Error(`Offset ${offset} is beyond end of read-handler output (${totalHandlerLines} lines total)`);
				}
				let handlerSelectedLines = handlerLines.slice(handlerStartLine - 1);
				let handlerUserLimitedLines: number | undefined;
				if (limit !== undefined) {
					handlerUserLimitedLines = Math.min(limit, handlerSelectedLines.length);
					handlerSelectedLines = handlerSelectedLines.slice(0, handlerUserLimitedLines);
				}
				const handlerSelectedContent = handlerSelectedLines.join("\n");

				// Handler output is model context just like ordinary text reads. Keep
				// the same limits here: a text-heavy PDF must not bypass the 50KB /
				// 2,000-line guard merely because it was extracted by pdftotext.
				// jsonCompression is off here (unlike the plain-text path below) since
				// handler output isn't expected to be raw JSON - revisit if a handler
				// that emits JSON is added (see issue #221).
				const truncation = truncateForToolOutput(handlerSelectedContent, { direction: "head", jsonCompression: false });
				let outputText = truncation.content;
				if (truncation.firstLineExceedsLimit) {
					outputText = `[Read-handler "${handler.name}" output starts with a ${formatSize(Buffer.byteLength(handlerSelectedContent.split("\n")[0], "utf-8"))} line, exceeding the ${formatSize(DEFAULT_MAX_BYTES)} limit.]`;
				} else if (truncation.truncated) {
					const endLineDisplay = handlerStartLine + truncation.outputLines - 1;
					outputText += `\n\n[Read-handler "${handler.name}" output showing lines ${handlerStartLine}-${endLineDisplay} of ${totalHandlerLines}. Use offset=${endLineDisplay + 1} to continue]`;
				} else if (handlerUserLimitedLines !== undefined) {
					const linesFromStart = handlerStartLine - 1 + handlerUserLimitedLines;
					if (linesFromStart < totalHandlerLines) {
						outputText += `\n\n[${totalHandlerLines - linesFromStart} more lines in read-handler "${handler.name}" output. Use offset=${handlerStartLine + handlerUserLimitedLines} to continue]`;
					}
				}
				return {
					content: [{ type: "text", text: outputText }],
					details: truncation.truncated ? { truncation } : undefined,
				};
			}

			if (imageMimeType) {
				if (!options.supportsImageInput) {
					// Don't return an ImageContent block — pi-ai's provider layer filters
					// it out based on model.input before the request goes out, and the
					// model would otherwise see this as a successful read and confabulate
					// the image's contents.
					return {
						content: [
							{
								type: "text",
								text: `[${path}] is a ${imageMimeType} image, but the active model does not accept image input. Its contents cannot be read this way.`,
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
				const resized = await resizeImageIfNeededAsync(base64, imageMimeType, signal);

				return {
					content: [
						{ type: "text", text: `Read image file [${resized?.mimeType ?? imageMimeType}]` },
						{ type: "image", data: resized?.data ?? base64, mimeType: resized?.mimeType ?? imageMimeType },
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

			// For large JSON files, prefer a schema-aware structural summary over
			// blind head truncation so the model still sees keys/shape and sample
			// values instead of an arbitrarily cut-off blob. Falls back to normal
			// line/byte truncation when the content isn't (fully) valid JSON - e.g.
			// an offset/limit slice of a file that cuts JSON mid-structure.
			const truncation = truncateForToolOutput(selectedContent, { direction: "head" });

			let outputText: string;
			let details: ReadToolDetails | undefined;

			if (truncation.firstLineExceedsLimit) {
				// First line at offset exceeds 50KB - tell model to use bash
				const firstLineSize = formatSize(Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncatedBy === "structure") {
				const fullOutputId = persistFullOutput(options.channelDir, selectedContent);
				outputText = `${truncation.content}\n\n[File is JSON (${formatSize(truncation.totalBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit): showing structural summary (keys/shape and sample values) instead of raw content. Full output saved, use read_full("${fullOutputId}") to see the rest, or bash/jq to query specific values.]`;
				const summarizedEnd = startLineDisplay + truncation.totalLines - 1;
				if (summarizedEnd < totalFileLines) {
					outputText += ` Use read's offset=${summarizedEnd + 1} (line number, not read_full's byte offset) to continue past the summarized section.`;
				}
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
