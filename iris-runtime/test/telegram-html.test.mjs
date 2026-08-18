// toTelegramHtml — issue #178: unescaped `<`/`>`/`&` in arbitrary text (e.g.
// bridge/agent output like `<server-ip>`) was passed straight through to
// Telegram's parse_mode: "HTML", which either drops the character run or
// fails the send outright. The fix escapes the whole message up front and
// only layers markup around already-escaped text.

import assert from "node:assert/strict";
import { test } from "node:test";
import { toTelegramHtml } from "../dist/transports/telegram/telegram.js";

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
	const out = toTelegramHtml('[x](https://example.com/"><script>alert(1)</script>)');
	assert.ok(!out.includes("<script>"), `expected no live <script> tag, got: ${out}`);
});
