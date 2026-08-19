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
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
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
 * Animated GIF/WebP are containers Photon has no multi-frame API for — its
 * resize/encode calls only ever touch the first frame. Detecting animation
 * so the caller can skip resizing (rather than silently collapsing an
 * animation down to one still frame) doesn't need a full parser: animated
 * GIFs carry the Netscape 2.0 looping application extension and animated
 * WebP is a RIFF container with an "ANIM" chunk; neither ever appears in a
 * static image of the same format.
 */
function isAnimated(bytes: Buffer, mimeType: string): boolean {
	if (mimeType === "image/gif") return bytes.includes(Buffer.from("NETSCAPE2.0", "ascii"));
	if (mimeType === "image/webp") return bytes.includes(Buffer.from("ANIM", "ascii"));
	return false;
}

/**
 * Downscale an image so it fits within MAX_DIMENSION and MAX_ENCODED_BYTES.
 * Returns the input unchanged (`wasResized: false`) if it's already within
 * both limits — the common case, so this stays cheap for normal-sized
 * attachments. Returns undefined if the image can't be decoded at all, is an
 * animated GIF/WebP that would need resizing to clear the limits (see
 * isAnimated — resizing would silently drop every frame but the first), or
 * can't be brought under the size limit even at MIN_DIMENSION (not observed
 * in practice); callers should fall back to sending the original as-is
 * rather than treating this as a hard error.
 *
 * This is synchronous, CPU-bound WASM work — decoding, resizing, and
 * re-encoding a large image at several JPEG qualities can take multiple
 * seconds. Callers on the Slack/Telegram message path should use
 * `resizeImageIfNeededAsync` instead, which runs this same logic on a
 * worker thread so it doesn't block the event loop for the whole process.
 */
export function resizeImageIfNeeded(data: string, mimeType: string): ResizedImage | undefined {
	const inputEncodedSize = Buffer.byteLength(data, "utf-8");
	const rawBytes = Buffer.from(data, "base64");
	let image: PhotonImage;
	try {
		image = PhotonImage.new_from_byteslice(new Uint8Array(rawBytes));
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

		if (isAnimated(rawBytes, mimeType)) {
			// Resizing would flatten the animation to its first frame with no
			// indication anything was lost. Sending the oversized original (and
			// risking the provider's payload limit) preserves the content the
			// user actually attached; silently corrupting it does not.
			log.logWarning(
				"Skipping resize of an animated image over the size limit — resizing would drop all but its first frame",
				`${mimeType}, ${inputEncodedSize} bytes encoded, ${originalWidth}x${originalHeight}`,
			);
			return undefined;
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

const WORKER_PATH = fileURLToPath(new URL("./image-resize-worker.js", import.meta.url));

interface WorkerRequest {
	data: string;
	mimeType: string;
}

interface WorkerResponse {
	ok: boolean;
	result?: ResizedImage;
	error?: string;
}

/**
 * Async counterpart to `resizeImageIfNeeded` that runs the decode/resize/
 * encode work on a worker thread instead of the caller's event loop.
 * `resizeImageIfNeeded` is synchronous CPU-bound WASM work that can take
 * multiple seconds for a large or hard-to-compress image; running it inline
 * (as the sync version does) blocks every other Slack/Telegram event this
 * process is handling for that whole duration. Callers on the message
 * handling path (`agent.ts`, `tools/read.ts`) use this instead.
 *
 * Accepts an optional `AbortSignal` — since `resizeImageIfNeeded` can't be
 * interrupted mid-computation from inside the same thread, cancellation is
 * implemented by terminating the worker thread outright.
 */
export function resizeImageIfNeededAsync(
	data: string,
	mimeType: string,
	signal?: AbortSignal,
): Promise<ResizedImage | undefined> {
	return new Promise((resolvePromise) => {
		if (signal?.aborted) {
			resolvePromise(undefined);
			return;
		}

		const worker = new Worker(WORKER_PATH);
		let settled = false;
		const finish = (result: ResizedImage | undefined) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			worker.removeAllListeners();
			void worker.terminate();
			resolvePromise(result);
		};
		const onAbort = () => finish(undefined);

		signal?.addEventListener("abort", onAbort, { once: true });
		worker.once("message", (msg: WorkerResponse) => {
			if (!msg.ok) log.logWarning("Image resize worker failed", msg.error ?? "unknown error");
			finish(msg.ok ? msg.result : undefined);
		});
		worker.once("error", (err) => {
			log.logWarning("Image resize worker crashed", err instanceof Error ? err.message : String(err));
			finish(undefined);
		});
		worker.once("exit", (code) => {
			if (code !== 0) log.logWarning("Image resize worker exited unexpectedly", `code ${code}`);
			finish(undefined);
		});

		const request: WorkerRequest = { data, mimeType };
		worker.postMessage(request);
	});
}
