import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { readFullOutput } from "./full-output-store.js";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.js";

const readFullSchema = Type.Object({
	label: Type.String({ description: "Brief description of why you're retrieving this output (shown to user)" }),
	id: Type.String({ description: "The id from a 'Full output saved' notice on a previous truncated tool result" }),
	offset: Type.Optional(
		Type.Number({
			description:
				"Byte offset to resume from, as given by this tool's own 'Use offset=N (byte offset) to continue' notice. Not the line-number offset from read's truncation notices.",
		}),
	),
});

export interface ReadFullToolOptions {
	channelDir?: string;
}

/**
 * Slice `maxBytes` worth of UTF-8 bytes starting at `startByte`, without
 * splitting a multi-byte character. Paginating by byte offset (rather than
 * by line, as read/bash truncation do) is the only option here: saved
 * content is frequently a single-line JSON blob with no newlines at all, so
 * line-oriented paging would return nothing past the first chunk.
 */
function sliceUtf8Bytes(content: string, startByte: number, maxBytes: number): { text: string; endByte: number } {
	const buf = Buffer.from(content, "utf-8");
	let end = Math.min(startByte + maxBytes, buf.length);
	while (end < buf.length && end > startByte && (buf[end] & 0xc0) === 0x80) end--;
	return { text: buf.subarray(startByte, end).toString("utf-8"), endByte: end };
}

export function createReadFullTool(options: ReadFullToolOptions): AgentTool<typeof readFullSchema> {
	return {
		name: "read_full",
		label: "read_full",
		description: `Retrieve the full, untruncated content previously saved for a truncated tool output. Pass the id shown in that output's 'Full output saved' notice. Output is paged in chunks of up to ${DEFAULT_MAX_BYTES / 1024}KB - use offset to continue past a chunk.`,
		parameters: readFullSchema,
		execute: async (_toolCallId: string, { id, offset }: { label: string; id: string; offset?: number }) => {
			const content = readFullOutput(options.channelDir, id);
			if (content === undefined) {
				throw new Error(`No saved output found for id "${id}" (it may have expired or never existed).`);
			}

			const totalBytes = Buffer.byteLength(content, "utf-8");
			const startByte = offset ? Math.max(0, offset) : 0;
			if (startByte >= totalBytes && totalBytes > 0) {
				throw new Error(`Offset ${offset} is beyond end of saved output (${formatSize(totalBytes)} total)`);
			}

			const { text, endByte } = sliceUtf8Bytes(content, startByte, DEFAULT_MAX_BYTES);
			let outputText = text;
			if (endByte < totalBytes) {
				outputText += `\n\n[Showing ${formatSize(endByte - startByte)} of ${formatSize(totalBytes)} (${DEFAULT_MAX_BYTES / 1024}KB chunk limit). Use offset=${endByte} (byte offset) to continue]`;
			}

			return { content: [{ type: "text" as const, text: outputText }], details: undefined };
		},
	};
}
