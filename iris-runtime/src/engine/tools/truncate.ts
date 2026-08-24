/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 *
 * For JSON output, `compressJsonStructure` offers a schema-aware alternative
 * to blind head/tail truncation: instead of chopping raw bytes, it emits a
 * compact structural summary (keys/shape plus a handful of sample values) so
 * the model still sees the shape of the data. Callers should try it first and
 * fall back to `truncateHead`/`truncateTail` when it returns null.
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", "structure" (JSON structural summary), or null if not truncated */
	truncatedBy: "lines" | "bytes" | "structure" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
		};
	}

	// Check if first line alone exceeds byte limit
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
		};
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if no truncation needed
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
		};
	}

	// Work backwards from the end
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
	};
}

const JSON_SAMPLE_ITEMS = 3;
const JSON_SAMPLE_KEYS = 50;
const JSON_MAX_STRING_LENGTH = 200;
const JSON_MAX_DEPTH = 6;
// Hard ceiling on payload size before we attempt a synchronous JSON.parse.
// Anything larger falls back to cheap byte truncation instead of potentially
// blocking the event loop parsing a pathological payload.
const JSON_PARSE_MAX_BYTES = 10 * 1024 * 1024;

/** Cut a string to at most `max` code points without splitting surrogate pairs. */
function sliceCodePoints(value: string, max: number): string {
	let out = "";
	for (const char of value) {
		if (out.length + char.length > max) break;
		out += char;
	}
	return out;
}

/**
 * Recursively reduce a parsed JSON value to a compact structural summary:
 * arrays keep only a handful of sample elements (plus their true length),
 * objects with very many keys keep only a handful of sample keys, long
 * strings are cut short, and depth is capped. This preserves the shape and
 * representative data of the JSON without reproducing all of it.
 */
function summarizeJsonValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") {
		return value.length > JSON_MAX_STRING_LENGTH
			? `${sliceCodePoints(value, JSON_MAX_STRING_LENGTH)}… (${value.length} chars total)`
			: value;
	}

	if (value === null || typeof value !== "object") {
		return value;
	}

	if (depth >= JSON_MAX_DEPTH) {
		return Array.isArray(value) ? `[Array(${value.length})]` : `{Object(${Object.keys(value).length} keys)}`;
	}

	if (Array.isArray(value)) {
		const sample = value.slice(0, JSON_SAMPLE_ITEMS).map((item) => summarizeJsonValue(item, depth + 1));
		if (value.length <= JSON_SAMPLE_ITEMS) {
			return sample;
		}
		return {
			_arrayLength: value.length,
			_sampleItems: sample,
			_note: `showing ${sample.length} of ${value.length} items`,
		};
	}

	const entries = Object.entries(value as Record<string, unknown>);
	const sampleEntries = entries.slice(0, JSON_SAMPLE_KEYS);
	const result: Record<string, unknown> = {};
	for (const [key, val] of sampleEntries) {
		result[key] = summarizeJsonValue(val, depth + 1);
	}
	if (entries.length > JSON_SAMPLE_KEYS) {
		// Avoid clobbering a real key from the source object that happens to be
		// named "_note" (or "_note2", ...) - keep incrementing until we find a
		// name that isn't already one of the sampled keys.
		let noteKey = "_note";
		for (let i = 2; noteKey in result; i++) {
			noteKey = `_note${i}`;
		}
		result[noteKey] = `showing ${sampleEntries.length} of ${entries.length} keys`;
	}
	return result;
}

/**
 * If `content` is a JSON object/array that exceeds the line/byte limits,
 * produce a compact structural summary instead of chopping raw bytes -
 * preserving keys/shape plus a handful of sample values so the model still
 * sees representative data. Returns null when content isn't within limits
 * that warrant compression, isn't JSON, or doesn't parse as an object/array
 * (compressing a bare string/number would lose information for no benefit).
 */
export function compressJsonStructure(content: string, options: TruncationOptions = {}): TruncationResult | null {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const totalLines = content.split("\n").length;

	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return null;
	}

	// Don't attempt to parse pathologically large payloads - a synchronous
	// JSON.parse of hundreds of MB would block the event loop. Cheap byte
	// truncation is the right fallback at that scale.
	if (totalBytes > JSON_PARSE_MAX_BYTES) {
		return null;
	}

	const trimmed = content.trim();
	if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") {
		return null;
	}

	const summary = summarizeJsonValue(parsed, 0);
	let summaryText = JSON.stringify(summary, null, 2);

	// Safety net: pathological shapes (e.g. many wide top-level keys) could
	// still exceed the byte limit even after sampling. Fall back to a hard
	// byte truncation of the summary itself so output is always bounded.
	if (Buffer.byteLength(summaryText, "utf-8") > maxBytes) {
		summaryText = truncateHead(summaryText, { maxLines: Number.POSITIVE_INFINITY, maxBytes }).content;
	}

	const outputBytes = Buffer.byteLength(summaryText, "utf-8");

	return {
		content: summaryText,
		truncated: true,
		truncatedBy: "structure",
		totalLines,
		totalBytes,
		outputLines: summaryText.split("\n").length,
		outputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
	};
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// Start from the end, skip maxBytes back
	let start = buf.length - maxBytes;

	// Find a valid UTF-8 boundary (start of a character)
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}
