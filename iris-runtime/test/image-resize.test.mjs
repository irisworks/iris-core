// image-resize.ts — downscales oversized images before they reach the model.
// Neither agent.ts's inbound-attachment path nor the read tool checked image
// size before this; an unresized phone photo can exceed a provider's
// per-image payload limit outright and fail the whole turn.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { resizeImageIfNeeded } from "../dist/engine/image-resize.js";

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
