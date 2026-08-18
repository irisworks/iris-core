// toTelegramHtml — issue #178: unescaped `<`/`>`/`&` in arbitrary text (e.g.
// bridge/agent output like `<server-ip>`) was passed straight through to
// Telegram's parse_mode: "HTML", which either drops the character run or
// fails the send outright. The fix escapes the whole message up front and
// only layers markup around already-escaped text.

import assert from "node:assert/strict";
import { test } from "node:test";
import { toTelegramHtml, toTelegramHtmlChunks } from "../dist/transports/telegram/telegram.js";

test("toTelegramHtml: escapes bare angle brackets in plain text", () => {
	assert.equal(toTelegramHtml("connect to <server-ip> now"), "connect to &lt;server-ip&gt; now");
});

test("toTelegramHtml: escapes ampersands in plain text", () => {
	assert.equal(toTelegramHtml("cats & dogs"), "cats &amp; dogs");
});

test("toTelegramHtml: escapes angle brackets inside fenced code blocks", () => {
	assert.equal(toTelegramHtml("```\n<html>&</html>\n```"), "<pre><code>&lt;html&gt;&amp;&lt;/html&gt;</code></pre>");
});

test("toTelegramHtml: escapes angle brackets inside inline code", () => {
	assert.equal(toTelegramHtml("run `<cmd>`"), "run <code>&lt;cmd&gt;</code>");
});

test("toTelegramHtml: bold and italic still render as markup, not escaped", () => {
	assert.equal(toTelegramHtml("**bold** and _italic_"), "<b>bold</b> and <i>italic</i>");
});

test("toTelegramHtml: bold/italic markers survive alongside escaped angle brackets", () => {
	assert.equal(toTelegramHtml("**<tag>**"), "<b>&lt;tag&gt;</b>");
});

test("toTelegramHtml: http(s) links still become anchors with escaped label", () => {
	assert.equal(
		toTelegramHtml("[<click>](https://example.com)"),
		'<a href="https://example.com">&lt;click&gt;</a>',
	);
});

test("toTelegramHtml: non-http link syntax is dropped, label still escaped", () => {
	assert.equal(toTelegramHtml("[<file>](./local.txt)"), "&lt;file&gt;");
});

test("toTelegramHtml: quotes in a URL don't break out of the href attribute", () => {
	assert.equal(
		toTelegramHtml('[x](https://example.com/"><script>alert(1)</script>)'),
		'<a href="https://example.com/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">x</a>',
	);
});

test("toTelegramHtml: inline code inside a fenced block doesn't nest a second <code>", () => {
	// Nested <code> is rejected by Telegram's HTML parser outright, which left the
	// reply stuck on its "thinking" placeholder.
	assert.equal(toTelegramHtml("```\nrun `date` now\n```"), "<pre><code>run `date` now</code></pre>");
});

test("toTelegramHtml: underscores and asterisks in code are not emphasis", () => {
	assert.equal(toTelegramHtml("```c\nint **pp; char *_x_;\n```"), "<pre><code>int **pp; char *_x_;</code></pre>");
	assert.equal(toTelegramHtml("`a_b_c` and _real_"), "<code>a_b_c</code> and <i>real</i>");
});

test("toTelegramHtml: link syntax inside code stays literal", () => {
	assert.equal(toTelegramHtml("```\n[docs](https://e.com/d)\n```"), "<pre><code>[docs](https://e.com/d)</code></pre>");
});

test("toTelegramHtml: emphasis and links still work outside code spans", () => {
	assert.equal(
		toTelegramHtml("`x` **b** [d](https://e.com) `y`"),
		'<code>x</code> <b>b</b> <a href="https://e.com">d</a> <code>y</code>',
	);
});

test("toTelegramHtml: the code-span sentinel can't be forged from message text", () => {
	assert.equal(toTelegramHtml("@@ICODE0@@ plain"), " plain");
});

// --- chunking -------------------------------------------------------------

const balanced = (html) => {
	const stack = [];
	for (const m of html.matchAll(/<(\/?)([a-z]+)[^>]*>/g)) {
		if (m[1]) assert.equal(stack.pop(), m[2], `unbalanced close </${m[2]}> in: ${html}`);
		else stack.push(m[2]);
	}
	assert.deepEqual(stack, [], `unclosed tags in: ${html}`);
	// No cut landed inside an entity.
	assert.ok(!/&(?![a-zA-Z]+;|#\d+;)/.test(html), `truncated entity in: ${html}`);
	assert.ok(!/&[a-zA-Z]*$/.test(html), `truncated entity at end of: ${html}`);
};

test("toTelegramHtmlChunks: single message stays a single chunk", () => {
	assert.deepEqual(toTelegramHtmlChunks("cats & dogs"), ["cats &amp; dogs"]);
});

test("toTelegramHtmlChunks: chunks are measured after escaping, not before", () => {
	// 40 source chars, 120 once escaped: the old html.slice()/splitIntoChunks path
	// measured the source-ish length and overshot the Telegram limit.
	const text = "&".repeat(40);
	const chunks = toTelegramHtmlChunks(text, 60);
	for (const c of chunks) assert.ok(c.length <= 60, `chunk over limit: ${c.length}`);
	assert.equal(chunks.join("").replace(/&amp;/g, "&"), text);
});

test("toTelegramHtmlChunks: never cuts inside an entity or a tag pair", () => {
	const line = "**bold & <angle> text** with more words here\n";
	const chunks = toTelegramHtmlChunks(line.repeat(20), 200);
	assert.ok(chunks.length > 1, "expected a split");
	for (const c of chunks) {
		assert.ok(c.length <= 200, `chunk over limit: ${c.length}`);
		balanced(c);
	}
});

test("toTelegramHtmlChunks: a long prose paragraph with no newline still splits cleanly", () => {
	const chunks = toTelegramHtmlChunks("a & b ".repeat(200), 150);
	assert.ok(chunks.length > 1, "expected a split");
	for (const c of chunks) {
		assert.ok(c.length <= 150, `chunk over limit: ${c.length}`);
		balanced(c);
	}
});

test("toTelegramHtmlChunks: an oversized code block is re-fenced across chunks", () => {
	const chunks = toTelegramHtmlChunks("```js\n" + "let x = 1;\n".repeat(60) + "```", 300);
	assert.ok(chunks.length > 1, "expected a split");
	for (const c of chunks) {
		assert.ok(c.length <= 300, `chunk over limit: ${c.length}`);
		assert.ok(c.startsWith("<pre><code>"), `chunk lost its fence: ${c}`);
		balanced(c);
	}
});

test("toTelegramHtmlChunks: maxChunks stops after the requested number", () => {
	const chunks = toTelegramHtmlChunks("line of text here\n".repeat(50), 200, 1);
	assert.equal(chunks.length, 1);
	assert.ok(chunks[0].length <= 200);
});
