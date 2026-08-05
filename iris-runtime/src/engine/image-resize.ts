/**
 * Downscale images before they reach the model.
 *
 * Neither agent.ts's inbound-attachment path nor the read tool ever checked
 * image size — a phone photo (often 3-5MB) base64-inflates by ~33% and can
 * exceed a provider's per-image payload limit (Anthropic's is ~5MB) outright,
 * failing the whole turn on nothing more than "the user sent a normal
 * photo". Uses Photon (Rust/WASM, @silvia-odwyer/photon-node) — the same
 * library pi-coding-agent's own read tool uses upstream for this, not
 * exposed through its public API, so reimplemented directly rather than
 * deep-imported.
 */
import { PhotonImage, resize, SamplingFilter } from "@silvia-odwyer/photon-node";
import * as log from "./log.js";

/** Longest edge a resized image is capped to, matching pi-coding-agent's own default. */
const MAX_DIMENSION = 2000;
/** Base64-encoded size ceiling — headroom below Anthropic's ~5MB/image request limit. */
const MAX_ENCODED_BYTES = 4.5 * 1024 * 1024;
const JPEG_QUALITIES = [80, 60, 40];
const MIN_DIMENSION = 16;

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	wasResized: boolean;
	width: number;
	height: number;
}

function encodeCandidate(bytes: Uint8Array, mimeType: string): { data: string; mimeType: string; size: number } {
	const data = Buffer.from(bytes).toString("base64");
	return { data, mimeType, size: Buffer.byteLength(data, "utf-8") };
}

/**
 * Downscale an image so it fits within MAX_DIMENSION and MAX_ENCODED_BYTES.
 * Returns the input unchanged (`wasResized: false`) if it's already within
 * both limits — the common case, so this stays cheap for normal-sized
 * attachments. Returns undefined if the image can't be decoded at all, or
 * can't be brought under the size limit even at MIN_DIMENSION (not observed
 * in practice); callers should fall back to sending the original as-is
 * rather than treating this as a hard error.
 */
export function resizeImageIfNeeded(data: string, mimeType: string): ResizedImage | undefined {
	const inputEncodedSize = Buffer.byteLength(data, "utf-8");
	let image: PhotonImage;
	try {
		image = PhotonImage.new_from_byteslice(new Uint8Array(Buffer.from(data, "base64")));
	} catch (err) {
		log.logWarning("Failed to decode image for resize check", err instanceof Error ? err.message : String(err));
		return undefined;
	}

	try {
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();

		if (originalWidth <= MAX_DIMENSION && originalHeight <= MAX_DIMENSION && inputEncodedSize <= MAX_ENCODED_BYTES) {
			return { data, mimeType, wasResized: false, width: originalWidth, height: originalHeight };
		}

		let targetWidth = originalWidth;
		let targetHeight = originalHeight;
		if (targetWidth > MAX_DIMENSION || targetHeight > MAX_DIMENSION) {
			const scale = MAX_DIMENSION / Math.max(targetWidth, targetHeight);
			targetWidth = Math.max(MIN_DIMENSION, Math.round(targetWidth * scale));
			targetHeight = Math.max(MIN_DIMENSION, Math.round(targetHeight * scale));
		}

		// Progressively shrink until the encoded size clears the ceiling, or we hit the floor.
		for (let attempt = 0; attempt < 8; attempt++) {
			const resized = resize(image, targetWidth, targetHeight, SamplingFilter.Lanczos3);
			try {
				const candidates = [
					encodeCandidate(resized.get_bytes(), "image/png"),
					...JPEG_QUALITIES.map((q) => encodeCandidate(resized.get_bytes_jpeg(q), "image/jpeg")),
				];
				const smallest = candidates.reduce((a, b) => (b.size < a.size ? b : a));
				const atFloor = targetWidth <= MIN_DIMENSION && targetHeight <= MIN_DIMENSION;
				if (smallest.size <= MAX_ENCODED_BYTES || atFloor) {
					return {
						data: smallest.data,
						mimeType: smallest.mimeType,
						wasResized: true,
						width: targetWidth,
						height: targetHeight,
					};
				}
			} finally {
				resized.free();
			}
			targetWidth = Math.max(MIN_DIMENSION, Math.round(targetWidth * 0.7));
			targetHeight = Math.max(MIN_DIMENSION, Math.round(targetHeight * 0.7));
		}
		return undefined;
	} finally {
		image.free();
	}
}
