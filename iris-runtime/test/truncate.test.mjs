// truncate.ts — head/tail truncation with independent line and byte limits.
// Covers formatSize's B/KB/MB output and the documented edge cases for
// truncateHead / truncateTail, including multi-byte UTF-8 boundary safety
// for the private truncateStringToBytesFromEnd helper (exercised indirectly
// via truncateTail's lastLinePartial path, the only caller).
//
// Requires `npm run build` first (tests import ../dist/*.js).

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatSize,
	truncateHead,
	truncateTail,
	compressJsonStructure,
	truncateForToolOutput,
	DEFAULT_MAX_LINES,
	DEFAULT_MAX_BYTES,
} from "../dist/engine/tools/truncate.js";

/** UTF-8 byte length — matches the source's Buffer.byteLength approach. */
function bytes(s) {
	return Buffer.byteLength(s, "utf-8");
}

/** Round-trip a string through a UTF-8 buffer to detect partial multi-byte sequences. */
function isCompleteUtf8(s) {
	return Buffer.from(s, "utf-8").toString("utf-8") === s;
}

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

test("truncate: DEFAULT_MAX_LINES is 2000", () => {
	assert.equal(DEFAULT_MAX_LINES, 2000);
});

test("truncate: DEFAULT_MAX_BYTES is 50KB (50*1024)", () => {
	assert.equal(DEFAULT_MAX_BYTES, 50 * 1024);
	assert.equal(DEFAULT_MAX_BYTES, 51200);
});

// ---------------------------------------------------------------------------
// formatSize — B/KB/MB output
// ---------------------------------------------------------------------------

test("formatSize: 0 bytes returns 0B", () => {
	assert.equal(formatSize(0), "0B");
});

test("formatSize: 1 byte returns 1B", () => {
	assert.equal(formatSize(1), "1B");
});

test("formatSize: 1023 bytes returns 1023B", () => {
	assert.equal(formatSize(1023), "1023B");
});

test("formatSize: 1024 bytes returns 1.0KB", () => {
	assert.equal(formatSize(1024), "1.0KB");
});

test("formatSize: 1536 bytes returns 1.5KB", () => {
	assert.equal(formatSize(1536), "1.5KB");
});

test("formatSize: 1MB (1024*1024) returns 1.0MB", () => {
	assert.equal(formatSize(1024 * 1024), "1.0MB");
});

test("formatSize: 1.5MB returns 1.5MB", () => {
	assert.equal(formatSize(1024 * 1024 * 1.5), "1.5MB");
});

test("formatSize: boundary 1023 -> B, 1024 -> KB", () => {
	assert.equal(formatSize(1023), "1023B");
	assert.equal(formatSize(1024), "1.0KB");
});

test("formatSize: boundary 1024*1024-1 -> KB, 1024*1024 -> MB", () => {
	// 1048575 < 1024*1024 so it stays in the KB branch; 1048575/1024 = 1023.999...
	// which toFixed(1) rounds up to "1024.0" — a KB value just under 1MB.
	assert.equal(formatSize(1024 * 1024 - 1), "1024.0KB");
	assert.equal(formatSize(1024 * 1024), "1.0MB");
});

// ---------------------------------------------------------------------------
// truncateHead — no truncation
// ---------------------------------------------------------------------------

test("truncateHead: content under both limits is unchanged", () => {
	const content = "line1\nline2\nline3";
	const result = truncateHead(content, { maxLines: 10, maxBytes: 1000 });
	assert.equal(result.truncated, false);
	assert.equal(result.truncatedBy, null);
	assert.equal(result.content, content);
	assert.equal(result.firstLineExceedsLimit, false);
	assert.equal(result.lastLinePartial, false);
	assert.equal(result.totalLines, 3);
	assert.equal(result.totalBytes, bytes(content));
	assert.equal(result.outputLines, 3);
	assert.equal(result.outputBytes, bytes(content));
});

test("truncateHead: empty content under limits returns unchanged", () => {
	const result = truncateHead("", { maxLines: 10, maxBytes: 1000 });
	assert.equal(result.truncated, false);
	assert.equal(result.content, "");
	assert.equal(result.totalLines, 1); // "".split("\n") === [""]
	assert.equal(result.totalBytes, 0);
	assert.equal(result.outputBytes, 0);
});

// ---------------------------------------------------------------------------
// truncateHead — line limit
// ---------------------------------------------------------------------------

test("truncateHead: line limit keeps first maxLines lines", () => {
	const content = "l1\nl2\nl3\nl4\nl5";
	const result = truncateHead(content, { maxLines: 2, maxBytes: 1000 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "lines");
	assert.equal(result.content, "l1\nl2");
	assert.equal(result.outputLines, 2);
	assert.equal(result.outputBytes, bytes("l1\nl2"));
	assert.equal(result.totalLines, 5);
	assert.equal(result.totalBytes, bytes(content));
	assert.equal(result.firstLineExceedsLimit, false);
});

test("truncateHead: line count exactly equal to maxLines is not truncated", () => {
	const content = "a\nb\nc";
	const result = truncateHead(content, { maxLines: 3, maxBytes: 1000 });
	assert.equal(result.truncated, false);
	assert.equal(result.content, content);
});

test("truncateHead: line and byte limits hit together resolves to 'lines'", () => {
	// maxLines=1 stops the loop after the first line; outputBytes (2) <= maxBytes (4),
	// so the post-loop check sets truncatedBy back to "lines".
	const content = "ab\ncd";
	const result = truncateHead(content, { maxLines: 1, maxBytes: 4 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "lines");
	assert.equal(result.content, "ab");
	assert.equal(result.outputLines, 1);
});

// ---------------------------------------------------------------------------
// truncateHead — byte limit
// ---------------------------------------------------------------------------

test("truncateHead: byte limit keeps complete lines that fit", () => {
	const content = "aaaa\nbbbb\ncccc";
	const result = truncateHead(content, { maxLines: 10, maxBytes: 5 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.content, "aaaa");
	assert.equal(result.outputLines, 1);
	assert.equal(result.outputBytes, 4);
	assert.equal(result.totalBytes, bytes(content));
	assert.equal(result.totalLines, 3);
	assert.equal(result.firstLineExceedsLimit, false);
});

test("truncateHead: byte limit never returns partial lines", () => {
	// maxBytes=6 fits line1 (4 bytes) but not line1+newline+line2 (4+1+4=9).
	const content = "aaaa\nbbbb\ncccc";
	const result = truncateHead(content, { maxLines: 10, maxBytes: 6 });
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.content, "aaaa");
	assert.equal(result.outputLines, 1);
	// Output is always a whole number of complete lines.
	assert.equal(result.content.split("\n").length, result.outputLines);
});

// ---------------------------------------------------------------------------
// truncateHead — first line exceeds byte limit
// ---------------------------------------------------------------------------

test("truncateHead: first line exceeding byte limit returns empty content", () => {
	const content = "aaaaaaaaaa"; // 10 bytes, single line
	const result = truncateHead(content, { maxLines: 10, maxBytes: 3 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.firstLineExceedsLimit, true);
	assert.equal(result.content, "");
	assert.equal(result.outputLines, 0);
	assert.equal(result.outputBytes, 0);
	assert.equal(result.totalBytes, bytes(content));
	assert.equal(result.totalLines, 1);
});

test("truncateHead: first line exactly at byte limit is not 'exceeds' and is included", () => {
	// firstLineBytes === maxBytes is NOT > maxBytes, so firstLineExceedsLimit is false
	// and the first line is kept; the second line triggers byte truncation.
	const content = "aaa\nb";
	const result = truncateHead(content, { maxLines: 10, maxBytes: 3 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.firstLineExceedsLimit, false);
	assert.equal(result.content, "aaa");
	assert.equal(result.outputLines, 1);
	assert.equal(result.outputBytes, 3);
});

// ---------------------------------------------------------------------------
// truncateHead — multi-byte UTF-8
// ---------------------------------------------------------------------------

test("truncateHead: multi-byte content respects character boundaries", () => {
	// "é" is 2 bytes; lines ["é","é","é"] total 2+1+2+1+2 = 8 bytes.
	const content = "é\né\né";
	const result = truncateHead(content, { maxLines: 10, maxBytes: 4 });
	assert.equal(result.truncatedBy, "bytes");
	// Only the first line fits: 2 bytes; adding the 2nd would be 2+1+2=5 > 4.
	assert.equal(result.content, "é");
	assert.equal(result.outputLines, 1);
	assert.equal(result.outputBytes, 2);
	assert.ok(isCompleteUtf8(result.content), "output must contain only complete UTF-8 chars");
});

test("truncateHead: multi-byte first line exceeding byte limit triggers firstLineExceedsLimit", () => {
	// "€" is 3 bytes; a single line of 4 € = 12 bytes > maxBytes=5.
	const content = "€€€€";
	const result = truncateHead(content, { maxLines: 10, maxBytes: 5 });
	assert.equal(result.firstLineExceedsLimit, true);
	assert.equal(result.content, "");
	assert.equal(result.outputBytes, 0);
});

test("truncateHead: totalLines/totalBytes reflect original, outputLines/outputBytes reflect truncated", () => {
	const content = "alpha\nbeta\ngamma\ndelta";
	const result = truncateHead(content, { maxLines: 2, maxBytes: 1000 });
	assert.equal(result.totalLines, 4);
	assert.equal(result.totalBytes, bytes(content));
	assert.equal(result.outputLines, 2);
	assert.equal(result.outputBytes, bytes(result.content));
	assert.notEqual(result.outputBytes, result.totalBytes);
});

// ---------------------------------------------------------------------------
// truncateTail — no truncation
// ---------------------------------------------------------------------------

test("truncateTail: content under both limits is unchanged", () => {
	const content = "line1\nline2\nline3";
	const result = truncateTail(content, { maxLines: 10, maxBytes: 1000 });
	assert.equal(result.truncated, false);
	assert.equal(result.truncatedBy, null);
	assert.equal(result.content, content);
	assert.equal(result.lastLinePartial, false);
	assert.equal(result.firstLineExceedsLimit, false);
	assert.equal(result.totalLines, 3);
	assert.equal(result.totalBytes, bytes(content));
	assert.equal(result.outputLines, 3);
	assert.equal(result.outputBytes, bytes(content));
});

// ---------------------------------------------------------------------------
// truncateTail — line limit
// ---------------------------------------------------------------------------

test("truncateTail: line limit keeps LAST maxLines lines", () => {
	const content = "l1\nl2\nl3\nl4\nl5";
	const result = truncateTail(content, { maxLines: 2, maxBytes: 1000 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "lines");
	assert.equal(result.content, "l4\nl5");
	assert.equal(result.outputLines, 2);
	assert.equal(result.outputBytes, bytes("l4\nl5"));
	assert.equal(result.totalLines, 5);
	assert.equal(result.totalBytes, bytes(content));
});

// ---------------------------------------------------------------------------
// truncateTail — byte limit
// ---------------------------------------------------------------------------

test("truncateTail: byte limit keeps last complete lines that fit", () => {
	const content = "aaaa\nbbbb\ncccc";
	const result = truncateTail(content, { maxLines: 10, maxBytes: 5 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.content, "cccc");
	assert.equal(result.outputLines, 1);
	assert.equal(result.outputBytes, 4);
	assert.equal(result.lastLinePartial, false);
});

test("truncateTail: byte limit keeps multiple trailing lines when they fit", () => {
	// lines ["aa","bb","cc","dd"]; maxBytes=6 fits "cc\ndd" (2+1+2=5) but not "bb\ncc\ndd" (8).
	const content = "aa\nbb\ncc\ndd";
	const result = truncateTail(content, { maxLines: 10, maxBytes: 6 });
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.content, "cc\ndd");
	assert.equal(result.outputLines, 2);
	assert.equal(result.outputBytes, bytes("cc\ndd"));
	assert.equal(result.lastLinePartial, false);
});

test("truncateTail: last line exactly at byte limit is kept whole (not partial)", () => {
	// lineBytes === maxBytes is NOT > maxBytes, so the last line is included and
	// lastLinePartial stays false; the earlier line then triggers byte truncation.
	const content = "aaa\nbbb";
	const result = truncateTail(content, { maxLines: 10, maxBytes: 3 });
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.content, "bbb");
	assert.equal(result.outputLines, 1);
	assert.equal(result.outputBytes, 3);
	assert.equal(result.lastLinePartial, false);
});

// ---------------------------------------------------------------------------
// truncateTail — last line exceeds byte limit (truncateStringToBytesFromEnd)
// ---------------------------------------------------------------------------

test("truncateTail: single line exceeding maxBytes returns partial from end with lastLinePartial=true", () => {
	const content = "aaaaaaaaaa"; // 10 bytes, single line
	const result = truncateTail(content, { maxLines: 10, maxBytes: 3 });
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.lastLinePartial, true);
	// Last 3 bytes of "aaaaaaaaaa".
	assert.equal(result.content, "aaa");
	assert.equal(result.outputBytes, 3);
	assert.equal(result.outputLines, 1);
	assert.equal(result.totalBytes, 10);
	assert.equal(result.totalLines, 1);
});

test("truncateTail: lastLinePartial content is a suffix of the original last line", () => {
	const content = "abcdefghij"; // 10 bytes
	const result = truncateTail(content, { maxLines: 10, maxBytes: 4 });
	assert.equal(result.lastLinePartial, true);
	assert.equal(result.content, "ghij"); // last 4 bytes
	assert.ok(content.endsWith(result.content));
});

// ---------------------------------------------------------------------------
// truncateTail — multi-byte UTF-8 boundary safety
// ---------------------------------------------------------------------------

test("truncateTail: lastLinePartial respects 2-byte UTF-8 boundaries (é)", () => {
	// "é" is 2 bytes; 5 é = 10 bytes. maxBytes=3 lands mid-character (start=7, the 2nd
	// byte of the 4th é), so it advances to byte 8 (start of the 5th é) and returns
	// the last complete é (2 bytes, not 3).
	const content = "ééééé";
	const result = truncateTail(content, { maxLines: 10, maxBytes: 3 });
	assert.equal(result.lastLinePartial, true);
	assert.equal(result.content, "é");
	assert.equal(result.outputBytes, 2);
	assert.ok(isCompleteUtf8(result.content));
	assert.ok(content.endsWith(result.content));
});

test("truncateTail: lastLinePartial respects 3-byte UTF-8 boundaries (€)", () => {
	// "€" is 3 bytes; 4 € = 12 bytes. maxBytes=5: start=7 (mid 3rd €), advances to
	// byte 9 (start of 4th €), slice(9) = last € (3 bytes).
	const content = "€€€€";
	const result = truncateTail(content, { maxLines: 10, maxBytes: 5 });
	assert.equal(result.lastLinePartial, true);
	assert.equal(result.content, "€");
	assert.equal(result.outputBytes, 3);
	assert.ok(isCompleteUtf8(result.content));
	assert.ok(content.endsWith(result.content));
});

test("truncateTail: lastLinePartial respects 4-byte UTF-8 boundaries (𝕏)", () => {
	// "𝕏" (U+1D54F) is 4 bytes; 3 𝕏 = 12 bytes. maxBytes=5: start=7 (4th byte of 2nd 𝕏),
	// advances to byte 8 (start of 3rd 𝕏), slice(8) = last 𝕏 (4 bytes).
	const content = "𝕏𝕏𝕏";
	const result = truncateTail(content, { maxLines: 10, maxBytes: 5 });
	assert.equal(result.lastLinePartial, true);
	assert.equal(result.content, "𝕏");
	assert.equal(result.outputBytes, 4);
	assert.ok(isCompleteUtf8(result.content));
	assert.ok(content.endsWith(result.content));
});

test("truncateTail: lastLinePartial takes multiple complete chars when they fit", () => {
	// 20 € = 60 bytes. maxBytes=10: start=50 (mid-€), advances to byte 51 (start of 18th €),
	// slice(51) = last 3 € (9 bytes). 10 bytes would split a €, so 9 is the largest whole fit.
	const content = "€".repeat(20);
	const result = truncateTail(content, { maxLines: 10, maxBytes: 10 });
	assert.equal(result.lastLinePartial, true);
	assert.equal(result.content, "€".repeat(3));
	assert.equal(result.outputBytes, 9);
	assert.ok(result.outputBytes <= 10);
	assert.ok(isCompleteUtf8(result.content));
	assert.ok(content.endsWith(result.content));
});

test("truncateTail: multi-byte content with a line that fits keeps complete lines (no partial)", () => {
	// lines ["é","é","é"]; maxBytes=4: last line "é" (2 bytes) fits, the 2nd would make 2+1+2=5 > 4.
	const content = "é\né\né";
	const result = truncateTail(content, { maxLines: 10, maxBytes: 4 });
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.content, "é");
	assert.equal(result.outputLines, 1);
	assert.equal(result.outputBytes, 2);
	assert.equal(result.lastLinePartial, false);
	assert.ok(isCompleteUtf8(result.content));
});

test("truncateTail: totalLines/totalBytes reflect original, outputLines/outputBytes reflect truncated", () => {
	const content = "alpha\nbeta\ngamma\ndelta";
	const result = truncateTail(content, { maxLines: 2, maxBytes: 1000 });
	assert.equal(result.totalLines, 4);
	assert.equal(result.totalBytes, bytes(content));
	assert.equal(result.outputLines, 2);
	assert.equal(result.outputBytes, bytes(result.content));
	assert.notEqual(result.outputBytes, result.totalBytes);
});

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

test("truncateHead/truncateTail: content under default limits is unchanged", () => {
	const content = "x".repeat(100);
	const head = truncateHead(content);
	const tail = truncateTail(content);
	assert.equal(head.truncated, false);
	assert.equal(tail.truncated, false);
	assert.equal(head.content, content);
	assert.equal(tail.content, content);
});

test("truncateHead: content exceeding default byte limit is truncated by bytes", () => {
	// Single line under the default line limit but over the default byte limit.
	const content = "x".repeat(DEFAULT_MAX_BYTES + 1);
	const result = truncateHead(content);
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.firstLineExceedsLimit, true);
	assert.equal(result.content, "");
});

test("truncateTail: content exceeding default byte limit returns partial from end", () => {
	const content = "x".repeat(DEFAULT_MAX_BYTES + 10);
	const result = truncateTail(content);
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "bytes");
	assert.equal(result.lastLinePartial, true);
	assert.equal(result.outputBytes, DEFAULT_MAX_BYTES);
	assert.ok(content.endsWith(result.content));
});

// ---------------------------------------------------------------------------
// compressJsonStructure
// ---------------------------------------------------------------------------

test("compressJsonStructure: returns null when content is within limits (no compression needed)", () => {
	const content = JSON.stringify({ a: 1, b: [1, 2, 3] });
	assert.equal(compressJsonStructure(content, { maxLines: 100, maxBytes: 10_000 }), null);
});

test("compressJsonStructure: returns null for non-JSON content that exceeds limits", () => {
	const content = "not json at all\n".repeat(1000);
	assert.equal(compressJsonStructure(content, { maxLines: 10, maxBytes: 100 }), null);
});

test("compressJsonStructure: returns null for JSON primitives (bare string/number)", () => {
	assert.equal(compressJsonStructure(JSON.stringify("x".repeat(1000)), { maxLines: 10, maxBytes: 100 }), null);
	assert.equal(compressJsonStructure("12345", { maxLines: 10, maxBytes: 3 }), null);
});

test("compressJsonStructure: returns null for malformed JSON-looking content", () => {
	const content = `{"unterminated": ${"x".repeat(200)}`;
	assert.equal(compressJsonStructure(content, { maxLines: 10, maxBytes: 100 }), null);
});

test("compressJsonStructure: large array is summarized with length and a few sample items", () => {
	const items = Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `item-${i}` }));
	const content = JSON.stringify(items);
	const result = compressJsonStructure(content, { maxLines: 10, maxBytes: 2000 });
	assert.ok(result);
	assert.equal(result.truncated, true);
	assert.equal(result.truncatedBy, "structure");
	assert.equal(result.totalBytes, Buffer.byteLength(content, "utf-8"));

	const parsed = JSON.parse(result.content);
	assert.equal(parsed._arrayLength, 1000);
	assert.equal(parsed._sampleItems.length, 3);
	assert.deepEqual(parsed._sampleItems[0], { id: 0, name: "item-0" });
	assert.match(parsed._note, /3 of 1000/);
});

test("compressJsonStructure: small array (<= sample size) is kept in full, no _note", () => {
	const items = [{ id: 1 }, { id: 2 }];
	// Force the "exceeds limits" gate even though the array itself is tiny -
	// the oversized (and thus string-truncated) padding pushes it over.
	const content = JSON.stringify({ items, padding: "x".repeat(1000) });
	const result = compressJsonStructure(content, { maxLines: 10, maxBytes: 500 });
	assert.ok(result);
	const parsed = JSON.parse(result.content);
	assert.deepEqual(parsed.items, items);
});

test("compressJsonStructure: object with many keys samples a subset and notes the total", () => {
	const obj = {};
	for (let i = 0; i < 200; i++) obj[`key${i}`] = i;
	const content = JSON.stringify(obj);
	const result = compressJsonStructure(content, { maxLines: 10, maxBytes: 1000 });
	assert.ok(result);
	const parsed = JSON.parse(result.content);
	assert.equal(Object.keys(parsed).filter((k) => k !== "_note").length, 50);
	assert.match(parsed._note, /50 of 200/);
});

test("compressJsonStructure: long strings are truncated with a char-count suffix", () => {
	const content = JSON.stringify({ text: "a".repeat(1000), padding: "b".repeat(1000) });
	const result = compressJsonStructure(content, { maxLines: 10, maxBytes: 1000 });
	assert.ok(result);
	const parsed = JSON.parse(result.content);
	assert.match(parsed.text, /^a+… \(1000 chars total\)$/);
});

test("compressJsonStructure: deeply nested structures are capped by depth", () => {
	let nested = { value: "leaf" };
	for (let i = 0; i < 20; i++) nested = { child: nested, padding: "x".repeat(500) };
	const content = JSON.stringify(nested);
	const result = compressJsonStructure(content, { maxLines: 10, maxBytes: 2000 });
	assert.ok(result);
	// Must not throw and must produce valid, bounded JSON with the deep tail collapsed.
	const parsed = JSON.parse(result.content);
	assert.ok(parsed);
	assert.match(result.content, /Object\(\d+ keys\)/);
});

test("compressJsonStructure: pathological shape falls back to a hard byte-capped summary", () => {
	// Many wide top-level keys, each holding a long string - even sampled down
	// to 50 keys, the summary could still exceed a tiny byte budget.
	const obj = {};
	for (let i = 0; i < 50; i++) obj[`key${i}`] = "x".repeat(1000);
	const content = JSON.stringify(obj);
	const result = compressJsonStructure(content, { maxLines: 10, maxBytes: 50 });
	assert.ok(result);
	assert.equal(result.truncatedBy, "structure");
	assert.ok(result.outputBytes <= 50);
});

test("compressJsonStructure: whitespace-wrapped JSON is still detected", () => {
	const items = Array.from({ length: 1000 }, (_, i) => i);
	const content = `\n\n  ${JSON.stringify(items)}  \n`;
	const result = compressJsonStructure(content, { maxLines: 10, maxBytes: 100 });
	assert.ok(result);
	assert.equal(result.truncatedBy, "structure");
});

test("compressJsonStructure: empty content returns null", () => {
	assert.equal(compressJsonStructure("", { maxLines: 1, maxBytes: 1 }), null);
});

test("compressJsonStructure: a real key named _note is preserved, not clobbered by the synthetic note", () => {
	const obj = { _note: "REAL DATA - do not lose me", padding: "x".repeat(3000) };
	for (let i = 0; i < 60; i++) obj[`key${i}`] = i;
	const content = JSON.stringify(obj);
	const result = compressJsonStructure(content, { maxLines: 5, maxBytes: 1500 });
	assert.ok(result);
	const parsed = JSON.parse(result.content);
	assert.equal(parsed._note, "REAL DATA - do not lose me");
	assert.match(parsed._note2, /50 of 62/);
});

test("compressJsonStructure: payload over the hard parse ceiling falls back to truncation (returns null)", () => {
	// Larger than JSON_PARSE_MAX_BYTES (10MB) but valid JSON - must not be
	// parsed synchronously; the caller falls back to cheap byte truncation.
	const content = JSON.stringify({ blob: "x".repeat(11 * 1024 * 1024) });
	assert.equal(compressJsonStructure(content, { maxLines: 10, maxBytes: 1000 }), null);
});

test("compressJsonStructure: long strings are cut on code-point boundaries (no lone surrogates)", () => {
	const emoji = "😀".repeat(300); // each emoji is a surrogate pair (2 code units)
	const content = JSON.stringify({ text: emoji });
	const result = compressJsonStructure(content, { maxLines: 10, maxBytes: 1000 });
	assert.ok(result);
	const parsed = JSON.parse(result.content);
	assert.ok(!/[\uD800-\uDBFF](?:$|[^\uDC00-\uDFFF])/.test(parsed.text), "no unpaired high surrogate");
	assert.match(parsed.text, /\(600 chars total\)$/);
});

// ---------------------------------------------------------------------------
// truncateForToolOutput
// ---------------------------------------------------------------------------

test("truncateForToolOutput: content under limits is unchanged and shouldPersistFull is false", () => {
	const content = "line1\nline2";
	const result = truncateForToolOutput(content, { direction: "head", maxLines: 10, maxBytes: 1000 });
	assert.equal(result.truncated, false);
	assert.equal(result.shouldPersistFull, false);
	assert.equal(result.content, content);
});

test("truncateForToolOutput: JSON over limits prefers structural summary regardless of direction", () => {
	const items = Array.from({ length: 1000 }, (_, i) => i);
	const content = JSON.stringify(items);
	const head = truncateForToolOutput(content, { direction: "head", maxLines: 10, maxBytes: 100 });
	const tail = truncateForToolOutput(content, { direction: "tail", maxLines: 10, maxBytes: 100 });
	assert.equal(head.truncatedBy, "structure");
	assert.equal(tail.truncatedBy, "structure");
	assert.equal(head.shouldPersistFull, true);
	assert.equal(tail.shouldPersistFull, true);
});

test("truncateForToolOutput: non-JSON content falls back to truncateHead/truncateTail per direction", () => {
	const content = "l1\nl2\nl3\nl4\nl5";
	const head = truncateForToolOutput(content, { direction: "head", maxLines: 2, maxBytes: 1000 });
	const tail = truncateForToolOutput(content, { direction: "tail", maxLines: 2, maxBytes: 1000 });
	assert.equal(head.content, "l1\nl2");
	assert.equal(tail.content, "l4\nl5");
	assert.equal(head.shouldPersistFull, true);
	assert.equal(tail.shouldPersistFull, true);
});

test("truncateForToolOutput: jsonCompression:false skips structural summary even for JSON content", () => {
	const items = Array.from({ length: 1000 }, (_, i) => i);
	const content = JSON.stringify(items);
	const result = truncateForToolOutput(content, { direction: "head", jsonCompression: false, maxLines: 10, maxBytes: 100 });
	assert.notEqual(result.truncatedBy, "structure");
});
