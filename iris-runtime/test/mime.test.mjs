// mime.ts — image detection by magic bytes, not filename. Both agent.ts's
// inbound-attachment path and the read tool used to trust the extension,
// which breaks for a mislabeled or extensionless attachment (e.g. a
// Telegram document with no filename downloads as a bare "file"). These
// pin the byte-sniffing replacement against a real image and real text.

import assert from "node:assert/strict";
import { test } from "node:test";
import { detectImageMimeType, detectPdf } from "../dist/engine/mime.js";

// A real 1x1 transparent PNG (not a hand-rolled magic-byte fixture — file-type
// validates more than just the leading signature for some formats).
const ONE_PIXEL_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

test("detectImageMimeType: recognizes a real PNG regardless of filename", async () => {
	const buffer = Buffer.from(ONE_PIXEL_PNG_BASE64, "base64");
	assert.equal(await detectImageMimeType(buffer), "image/png");
});

test("detectImageMimeType: plain text is not an image", async () => {
	const buffer = Buffer.from("just some ordinary text content, not an image", "utf-8");
	assert.equal(await detectImageMimeType(buffer), undefined);
});

test("detectImageMimeType: empty buffer is not an image", async () => {
	assert.equal(await detectImageMimeType(Buffer.alloc(0)), undefined);
});

test("detectPdf: recognizes a PDF by its %PDF magic bytes", async () => {
	const buffer = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary");
	assert.equal(await detectPdf(buffer), true);
});

test("detectPdf: plain text is not a PDF", async () => {
	const buffer = Buffer.from("just some ordinary text content, not a PDF", "utf-8");
	assert.equal(await detectPdf(buffer), false);
});

test("detectPdf: empty buffer is not a PDF", async () => {
	assert.equal(await detectPdf(Buffer.alloc(0)), false);
});
