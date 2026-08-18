// image-resize.ts — downscales oversized images before they reach the model.
// Neither agent.ts's inbound-attachment path nor the read tool checked image
// size before this; an unresized phone photo can exceed a provider's
// per-image payload limit outright and fail the whole turn.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { resizeImageIfNeeded, resizeImageIfNeededAsync } from "../dist/engine/image-resize.js";

function makeSolidPngBase64(width, height) {
	const rawPixels = new Uint8Array(width * height * 4).fill(128);
	const image = new PhotonImage(rawPixels, width, height);
	try {
		return Buffer.from(image.get_bytes()).toString("base64");
	} finally {
		image.free();
	}
}

test("resizeImageIfNeeded: a small image within limits is returned unchanged", () => {
	const small = makeSolidPngBase64(4, 4);
	const result = resizeImageIfNeeded(small, "image/png");
	assert.ok(result);
	assert.equal(result.wasResized, false);
	assert.equal(result.width, 4);
	assert.equal(result.height, 4);
	assert.equal(result.data, small);
});

test("resizeImageIfNeeded: an oversized image is downscaled under the dimension cap", () => {
	const oversized = makeSolidPngBase64(2500, 2500);
	const result = resizeImageIfNeeded(oversized, "image/png");
	assert.ok(result);
	assert.equal(result.wasResized, true);
	assert.ok(result.width <= 2000, `expected width <= 2000, got ${result.width}`);
	assert.ok(result.height <= 2000, `expected height <= 2000, got ${result.height}`);
	// Resized bytes should actually be smaller than the original oversized encoding.
	assert.ok(Buffer.byteLength(result.data, "base64") < Buffer.byteLength(oversized, "base64"));
});

test("resizeImageIfNeeded: garbage input returns undefined instead of throwing", () => {
	const result = resizeImageIfNeeded(Buffer.from("not an image").toString("base64"), "image/png");
	assert.equal(result, undefined);
});

test("resizeImageIfNeeded: an animated GIF/WebP that would need resizing is left unresized instead of flattened", () => {
	// Photon has no multi-frame API — resizing would silently collapse an
	// animation to its first frame. Build a real (decodable) oversized PNG and
	// tag along the ASCII marker isAnimated() looks for; Photon sniffs the
	// actual format from the byte header, not the mimeType we pass, so this
	// still decodes fine while exercising the animated-skip branch.
	const oversizedPng = Buffer.from(makeSolidPngBase64(2500, 2500), "base64");
	const withGifMarker = Buffer.concat([oversizedPng, Buffer.from("NETSCAPE2.0")]).toString("base64");
	const withWebpMarker = Buffer.concat([oversizedPng, Buffer.from("ANIM")]).toString("base64");

	assert.equal(resizeImageIfNeeded(withGifMarker, "image/gif"), undefined);
	assert.equal(resizeImageIfNeeded(withWebpMarker, "image/webp"), undefined);

	// The same oversized bytes without an animation-format mimeType still resize normally.
	const normal = resizeImageIfNeeded(withGifMarker, "image/png");
	assert.ok(normal);
	assert.equal(normal.wasResized, true);
});

test("resizeImageIfNeededAsync: resizes on a worker thread without blocking the event loop", async () => {
	const oversized = makeSolidPngBase64(2500, 2500);

	let timerFired = false;
	setTimeout(() => {
		timerFired = true;
	}, 5);

	const result = await resizeImageIfNeededAsync(oversized, "image/png");
	assert.ok(result);
	assert.equal(result.wasResized, true);
	assert.ok(result.width <= 2000);
	// The 5ms timer above should have had ample opportunity to fire while the
	// worker thread (not the main thread) was doing the resize/encode work.
	assert.equal(timerFired, true, "event loop appears to have been blocked during resize");
});

test("resizeImageIfNeededAsync: an aborted signal resolves to undefined instead of waiting for the resize", async () => {
	const oversized = makeSolidPngBase64(2500, 2500);
	const controller = new AbortController();
	const promise = resizeImageIfNeededAsync(oversized, "image/png", controller.signal);
	controller.abort();
	const result = await promise;
	assert.equal(result, undefined);
});

test("resizeImageIfNeededAsync: an image already within limits still resolves normally", async () => {
	const small = makeSolidPngBase64(4, 4);
	const result = await resizeImageIfNeededAsync(small, "image/png");
	assert.ok(result);
	assert.equal(result.wasResized, false);
});
