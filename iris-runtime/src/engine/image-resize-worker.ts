/**
 * Worker-thread entry point for `resizeImageIfNeeded`.
 *
 * Decoding, resizing, and re-encoding a large image through Photon's WASM
 * bindings is synchronous CPU work that can take multiple seconds. Running
 * it on the main thread (as `resizeImageIfNeeded` does directly) blocks
 * every other Slack/Telegram event this process is handling for that whole
 * duration. `resizeImageIfNeededAsync` in `image-resize.ts` spawns this
 * worker to do that same work off the main thread instead.
 */
import { parentPort } from "node:worker_threads";
import { resizeImageIfNeeded, type ResizedImage } from "./image-resize.js";

if (!parentPort) {
	throw new Error("image-resize-worker.js must be run as a worker_threads Worker");
}

interface WorkerRequest {
	data: string;
	mimeType: string;
}

interface WorkerResponse {
	ok: boolean;
	result?: ResizedImage;
	error?: string;
}

parentPort.on("message", (msg: WorkerRequest) => {
	try {
		const result = resizeImageIfNeeded(msg.data, msg.mimeType);
		const response: WorkerResponse = { ok: true, result };
		parentPort?.postMessage(response);
	} catch (err) {
		const response: WorkerResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
		parentPort?.postMessage(response);
	}
});
